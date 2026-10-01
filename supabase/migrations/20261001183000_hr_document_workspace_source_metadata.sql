begin;

-- Persist a reviewed source subtype instead of asking each browser to infer
-- whether the historically broad hr_source kind is a form, handbook, guide,
-- job description, or other reference. Unknown future imports fail closed.
alter table private.hr_template_library_items
  add column source_type text not null default 'unclassified',
  add column source_version_id uuid references private.hr_document_versions(id) on delete restrict;

update private.hr_template_library_items item
set source_version_id = document.current_version_id
from private.hr_documents document
where document.id = item.source_document_id
  and item.source_version_id is null;

create index if not exists hr_template_library_source_version_idx
  on private.hr_template_library_items(source_version_id)
  where source_version_id is not null;

create or replace function private.classify_hr_library_source(
  target_code text,
  target_section text,
  target_document_kind text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when target_document_kind = 'training_form' then 'training_form'
    when target_document_kind in ('training_admin', 'training_module') then 'training_reference'
    when target_document_kind = 'document_guide' then 'reference_material'
    when target_document_kind = 'hr_source' and (
      lower(target_code) like 'gs-jd-%'
      or target_code in ('GS-HR-000', 'GS-HR-GUIDE-100', 'GS-HR-GUIDE-110', 'GS-HR-GUIDE-120', 'GS-HR-GUIDE-130',
        'GS-HR-INT-000', 'GS-HR-INT-010', 'GS-HR-INT-100', 'GS-HR-INT-110', 'GS-HR-EXP-000',
        'GS-HR-GUIDE-150', 'GS-HR-GUIDE-160', 'GS-HR-HB-100', 'GS-HR-HB-110', 'GS-HR-HB-120',
        'GS-HR-SRC-001')
      or lower(target_section) like '02_guides/%'
      or lower(target_section) like '03_interview/00_start%'
      or lower(target_section) like '04_exp/00_start%'
      or lower(target_section) like '04_exp/01_handbooks%'
    ) then 'reference_material'
    when target_document_kind = 'hr_source' and (
      lower(target_section) like '01_forms/%'
      or lower(target_section) = 'legacy library'
      or target_code = 'GS-HR-INT-120'
      or lower(target_section) like '03_interview/02_core%'
      or lower(target_section) like '03_interview/03_roles%'
      or lower(target_section) like '03_interview/04_exercises%'
      or lower(target_section) similar to '04_exp/(02|03|04|05|06|07|08|09|10)_%'
    ) then 'controlled_form'
    else 'unclassified'
  end
$$;

revoke all on function private.classify_hr_library_source(text, text, text)
  from public, anon, authenticated, service_role;

update private.hr_template_library_items item
set source_type = private.classify_hr_library_source(item.form_code, item.section, item.document_kind);

-- Older Workers still call the original registration RPC. Derive a reviewed
-- subtype before constraints are checked so that adopted known items remain
-- compatible, while unknown adopted sources still fail closed.
create or replace function private.classify_hr_library_source_on_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_document_id is not null
    and exists (
      select 1
      from private.hr_documents document
      where document.id = new.source_document_id
        and document.employee_id is not null
    )
  then
    raise check_violation using message = 'Employee-file documents cannot be registered as company library sources.';
  end if;
  if new.source_version_id is not null and not exists (
    select 1
    from private.hr_document_versions version
    where version.id = new.source_version_id
      and version.document_id = new.source_document_id
  ) then
    raise check_violation using message = 'The pinned source version does not belong to the company source document.';
  end if;
  if new.source_type is null or new.source_type = 'unclassified' then
    new.source_type := private.classify_hr_library_source(new.form_code, new.section, new.document_kind);
  end if;
  return new;
end
$$;

revoke all on function private.classify_hr_library_source_on_write()
  from public, anon, authenticated, service_role;

drop trigger if exists classify_hr_library_source_on_write on private.hr_template_library_items;
create trigger classify_hr_library_source_on_write
before insert or update of form_code, section, document_kind, source_type, source_document_id, source_version_id
on private.hr_template_library_items
for each row execute function private.classify_hr_library_source_on_write();

do $$
begin
  if exists (
    select 1
    from private.hr_template_library_items item
    join private.hr_documents document on document.id = item.source_document_id
    where document.employee_id is not null
  ) then
    raise check_violation using message = 'A company library item references an employee-file document. Correct the source ownership before applying this migration.';
  end if;
end
$$;

alter table private.hr_template_library_items
  add constraint hr_template_library_source_type
    check (source_type in ('controlled_form', 'reference_material', 'training_form', 'training_reference', 'unclassified')),
  add constraint hr_template_library_source_type_kind
    check (
      source_type = 'unclassified'
      or (document_kind = 'hr_source' and source_type in ('controlled_form', 'reference_material'))
      or (document_kind = 'document_guide' and source_type = 'reference_material')
      or (document_kind = 'training_form' and source_type = 'training_form')
      or (document_kind in ('training_admin', 'training_module') and source_type = 'training_reference')
    ),
  add constraint hr_template_library_adopted_source_classified
    check (lifecycle_status <> 'adopted' or source_type <> 'unclassified');

comment on column private.hr_template_library_items.source_type
  is 'Reviewed source behavior. Unclassified items remain preview-only and cannot be adopted.';

-- Keep registration lifecycle-aware in one database boundary. Draft training
-- sources remain non-assignable and do not receive an effective course version;
-- existing employee assignments remain intact and continue to reference their
-- immutable prior versions. The original public signature delegates here so
-- older Workers remain safe during a rolling release.
create or replace function private.register_hr_system_item(
  target_actor_id uuid,
  target_document_id uuid,
  target_code text,
  target_title text,
  target_category text,
  target_section text,
  target_record_class text,
  target_purpose text,
  target_audience text,
  target_sensitivity text,
  target_source_filename text,
  target_document_kind text,
  target_lifecycle_status text,
  target_guide_code text,
  target_related_modules text[],
  target_source_sha256 text,
  target_page_count integer,
  target_full_text text,
  target_package_metadata jsonb,
  target_request_id text,
  target_source_type text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
  library_id uuid;
  registered_course_id uuid;
  registered_version_id uuid;
  latest_version integer;
  existing_source private.hr_template_library_items%rowtype;
  source_document private.hr_documents%rowtype;
  source_version private.hr_document_versions%rowtype;
  normalized_learning_code text := lower(replace(target_code, '-', '_'));
  learning_status text;
  course_active boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  effective_permissions := private.document_studio_require_actor(target_actor_id);
  if not (effective_permissions && array['hr.documents.manage','hr.learning.manage','training.manage']::text[]) then
    raise insufficient_privilege using message = 'HR document or training management permission is required.';
  end if;
  if target_code !~ '^[A-Z][A-Z0-9-]{1,79}$' then raise check_violation using message = 'The controlled item code is invalid.'; end if;
  if target_document_kind not in ('hr_source','training_admin','training_module','document_guide','training_form') then raise check_violation using message = 'The controlled item kind is invalid.'; end if;
  if target_audience <> 'hr_only' then raise check_violation using message = 'The protected master library is restricted to HR.'; end if;
  if target_sensitivity not in ('standard','restricted','highly_restricted') then raise check_violation using message = 'The item sensitivity is invalid.'; end if;
  if target_lifecycle_status not in ('draft_for_adoption','adopted','retired') then raise check_violation using message = 'The item lifecycle status is invalid.'; end if;
  if target_source_type not in ('controlled_form', 'reference_material', 'training_form', 'training_reference', 'unclassified') then
    raise check_violation using message = 'The reviewed source type is invalid.';
  end if;
  if not (
    target_source_type = 'unclassified'
    or (target_document_kind = 'hr_source' and target_source_type in ('controlled_form', 'reference_material'))
    or (target_document_kind = 'document_guide' and target_source_type = 'reference_material')
    or (target_document_kind = 'training_form' and target_source_type = 'training_form')
    or (target_document_kind in ('training_admin', 'training_module') and target_source_type = 'training_reference')
  ) then
    raise check_violation using message = 'The reviewed source type is not compatible with this document kind.';
  end if;
  if target_lifecycle_status = 'adopted' and target_source_type = 'unclassified' then
    raise check_violation using message = 'Classify this source before adopting it.';
  end if;
  if target_source_sha256 is null or target_source_sha256 !~ '^[a-f0-9]{64}$'
    or target_page_count is null or target_page_count < 1
  then raise check_violation using message = 'The PDF evidence is invalid.'; end if;
  if jsonb_typeof(coalesce(target_package_metadata, '{}'::jsonb)) <> 'object' then raise check_violation using message = 'Package metadata must be an object.'; end if;
  select document.* into source_document
  from private.hr_documents document
  where document.id = target_document_id
    and document.employee_id is null
    and document.archived_at is null
    and document.current_version_id is not null
  for update;
  if source_document.id is null then
    raise no_data_found using message = 'The protected company source document is unavailable.';
  end if;
  perform private.service_require_hr_document_permission(target_actor_id, source_document.vault_code, 'manage');
  select version.* into source_version
  from private.hr_document_versions version
  where version.id = source_document.current_version_id;
  if source_version.id is null or source_version.sha256_checksum is distinct from target_source_sha256 then
    raise check_violation using message = 'The registered checksum does not match the current protected PDF version.';
  end if;
  if private.hr_document_latest_scan_state(source_document.current_version_id) <> 'clean' then
    raise insufficient_privilege using message = 'The source file has not passed security review.';
  end if;
  select existing.* into existing_source
  from private.hr_template_library_items existing
  where existing.form_code = target_code
  for update;
  if existing_source.id is not null then
    if existing_source.lifecycle_status <> 'draft_for_adoption' then
      raise check_violation using message = 'An adopted or retired source cannot be replaced through draft registration. Use the explicit lifecycle workflow.';
    end if;
    if existing_source.document_kind <> target_document_kind then
      raise check_violation using message = 'A registered source cannot change document kind. Register a new controlled code instead.';
    end if;
  end if;

  insert into private.hr_template_library_items(
    form_code, title, category, section, record_class, purpose, audience_scope,
    sensitivity, source_filename, display_order, source_document_id, active,
    document_kind, lifecycle_status, guide_code, related_modules, source_sha256,
    page_count, full_text, package_metadata, source_type, source_version_id
  ) values (
    target_code, btrim(target_title), btrim(target_category), btrim(target_section),
    btrim(target_record_class), btrim(target_purpose), 'hr_only', target_sensitivity,
    btrim(target_source_filename),
    coalesce((select max(item.display_order) + 10 from private.hr_template_library_items item), 10),
    target_document_id, target_lifecycle_status <> 'retired', target_document_kind,
    target_lifecycle_status, nullif(btrim(target_guide_code), ''),
    coalesce(target_related_modules, '{}'::text[]), target_source_sha256,
    target_page_count, coalesce(target_full_text, ''),
    coalesce(target_package_metadata, '{}'::jsonb), target_source_type, source_version.id
  )
  on conflict(form_code) do update set
    title = excluded.title,
    category = excluded.category,
    section = excluded.section,
    record_class = excluded.record_class,
    purpose = excluded.purpose,
    audience_scope = excluded.audience_scope,
    sensitivity = excluded.sensitivity,
    source_filename = excluded.source_filename,
    source_document_id = excluded.source_document_id,
    active = excluded.active,
    document_kind = excluded.document_kind,
    lifecycle_status = excluded.lifecycle_status,
    guide_code = excluded.guide_code,
    related_modules = excluded.related_modules,
    source_sha256 = excluded.source_sha256,
    page_count = excluded.page_count,
    full_text = excluded.full_text,
    package_metadata = excluded.package_metadata,
    source_type = excluded.source_type,
    source_version_id = excluded.source_version_id,
    updated_at = clock_timestamp()
  returning id into library_id;

  if target_document_kind = 'training_module' then
    learning_status := case target_lifecycle_status when 'adopted' then 'active' when 'retired' then 'retired' else 'draft' end;
    course_active := target_lifecycle_status = 'adopted';

    insert into private.hr_learning_items(
      code, title, description, delivery_method, requirement_type, status,
      configuration, created_by, approved_by, approved_at
    ) values (
      normalized_learning_code, btrim(target_title), btrim(target_purpose),
      'document', 'optional', learning_status,
      jsonb_build_object('sourceDocumentId', target_document_id, 'libraryItemId', library_id, 'packageVersion', '2.1'),
      target_actor_id,
      case when target_lifecycle_status = 'adopted' then target_actor_id else null end,
      case when target_lifecycle_status = 'adopted' then clock_timestamp() else null end
    )
    on conflict(code) do update set
      title = excluded.title,
      description = excluded.description,
      delivery_method = 'document',
      status = excluded.status,
      configuration = excluded.configuration,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      updated_at = clock_timestamp();

    insert into public.training_courses(code, title, description, active, created_by)
    values(target_code, btrim(target_title), btrim(target_purpose), course_active, target_actor_id)
    on conflict(code) do update set
      title = excluded.title,
      description = excluded.description,
      active = excluded.active,
      updated_at = clock_timestamp()
    returning id into registered_course_id;

    -- Existing assignments are preserved. A source becomes publishable only
    -- after formal adoption, at which point its immutable version is created.
    if target_lifecycle_status = 'adopted' then
      select version.id into registered_version_id
      from public.training_course_versions version
      where version.course_id = registered_course_id
        and version.content_digest = target_source_sha256
      order by version.version_number desc
      limit 1;

      if registered_version_id is null then
        select coalesce(max(version.version_number), 0) into latest_version
        from public.training_course_versions version
        where version.course_id = registered_course_id;

        insert into public.training_course_versions(
          course_id, version_number, title, description, content_type, content_url,
          instructions, effective_on, default_due_days, completion_rule,
          requires_acknowledgment, content_digest, published_by, source_document_id
        ) values (
          registered_course_id, latest_version + 1, btrim(target_title), btrim(target_purpose),
          'document', '/api/v1/training/documents/' || target_document_id::text,
          'Open the assigned PDF, complete the material, and attest to completion in Action Center.',
          current_date, 14, 'employee_attestation', true, target_source_sha256,
          target_actor_id, target_document_id
        )
        returning id into registered_version_id;
      end if;
    end if;
  end if;

  insert into private.hr_document_access_events(
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  )
  select document.id, document.current_version_id, 'share', target_actor_id,
    nullif(btrim(target_request_id), ''),
    'Registered protected HR System v2.1 library item.',
    jsonb_build_object(
      'libraryItemId', library_id,
      'code', target_code,
      'kind', target_document_kind,
      'lifecycleStatus', target_lifecycle_status,
      'sourceType', target_source_type
    )
  from private.hr_documents document
  where document.id = target_document_id;

  return jsonb_build_object(
    'libraryItemId', library_id,
    'documentId', target_document_id,
    'trainingCourseId', registered_course_id,
    'trainingVersionId', registered_version_id,
    'sourceType', target_source_type
  );
end
$$;

revoke all on function private.register_hr_system_item(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, integer, text, jsonb, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.service_register_hr_system_item(
  target_actor_id uuid, target_document_id uuid, target_code text, target_title text,
  target_category text, target_section text, target_record_class text, target_purpose text,
  target_audience text, target_sensitivity text, target_source_filename text,
  target_document_kind text, target_lifecycle_status text, target_guide_code text,
  target_related_modules text[], target_source_sha256 text, target_page_count integer,
  target_full_text text, target_package_metadata jsonb, target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_lifecycle_status <> 'draft_for_adoption' then
    raise check_violation using message = 'Registration can only create or update a draft source. Use the reviewed adoption workflow to approve it for use.';
  end if;
  return private.register_hr_system_item(
    target_actor_id,
    target_document_id,
    target_code,
    target_title,
    target_category,
    target_section,
    target_record_class,
    target_purpose,
    target_audience,
    target_sensitivity,
    target_source_filename,
    target_document_kind,
    target_lifecycle_status,
    target_guide_code,
    target_related_modules,
    target_source_sha256,
    target_page_count,
    target_full_text,
    target_package_metadata,
    target_request_id,
    private.classify_hr_library_source(target_code, target_section, target_document_kind)
  );
end
$$;

revoke all on function public.service_register_hr_system_item(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, integer, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.service_register_hr_system_item(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, integer, text, jsonb, text)
  to service_role;

create or replace function public.service_register_hr_system_item_v2(
  target_actor_id uuid, target_document_id uuid, target_code text, target_title text,
  target_category text, target_section text, target_record_class text, target_purpose text,
  target_audience text, target_sensitivity text, target_source_filename text,
  target_document_kind text, target_lifecycle_status text, target_guide_code text,
  target_related_modules text[], target_source_sha256 text, target_page_count integer,
  target_full_text text, target_package_metadata jsonb, target_request_id text default null,
  target_source_type text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  resolved_source_type text;
begin
  if target_lifecycle_status <> 'draft_for_adoption' then
    raise check_violation using message = 'Registration can only create or update a draft source. Use the reviewed adoption workflow to approve it for use.';
  end if;
  resolved_source_type := coalesce(
    nullif(btrim(target_source_type), ''),
    private.classify_hr_library_source(target_code, target_section, target_document_kind)
  );

  return private.register_hr_system_item(
    target_actor_id, target_document_id, target_code, target_title, target_category,
    target_section, target_record_class, target_purpose, target_audience,
    target_sensitivity, target_source_filename, target_document_kind,
    target_lifecycle_status, target_guide_code, target_related_modules,
    target_source_sha256, target_page_count, target_full_text,
    target_package_metadata, target_request_id, resolved_source_type
  );
end
$$;

revoke all on function public.service_register_hr_system_item_v2(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, integer, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.service_register_hr_system_item_v2(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, integer, text, jsonb, text, text)
  to service_role;

comment on function public.service_register_hr_system_item_v2(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text[], text, integer, text, jsonb, text, text)
  is 'Registers a protected HR library item with an explicit reviewed source subtype, while deriving known legacy source types when omitted.';

-- Adoption is deliberate and item-by-item. The Worker requires recent MFA,
-- and this boundary independently rechecks the actor's management permission,
-- source classification, company ownership, clean file state, and audit reason.
create or replace function public.service_adopt_hr_library_source(
  target_actor_id uuid,
  target_library_item_id uuid,
  target_expected_updated_at timestamptz,
  target_expected_sha256 text,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
  source_item private.hr_template_library_items%rowtype;
  document_record private.hr_documents%rowtype;
  version_record private.hr_document_versions%rowtype;
  clean_reason text := nullif(btrim(target_reason), '');
  registration_result jsonb;
  adopted_at timestamptz;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  effective_permissions := private.document_studio_require_actor(target_actor_id);
  if not (effective_permissions && array['hr.documents.manage','hr.learning.manage','training.manage']::text[]) then
    raise insufficient_privilege using message = 'HR document or training management permission is required.';
  end if;
  if clean_reason is null or char_length(clean_reason) < 5 or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'Add a concise adoption reason between 5 and 1,000 characters.';
  end if;
  if target_expected_updated_at is null or target_expected_sha256 is null or target_expected_sha256 !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Refresh the source before adopting it.';
  end if;
  if not exists (
    select 1 from private.hr_template_library_release_gate gate where gate.singleton and gate.enabled
  ) or not exists (
    select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled
  ) then
    raise insufficient_privilege using message = 'The protected document library is not released.';
  end if;

  select item.* into source_item
  from private.hr_template_library_items item
  where item.id = target_library_item_id
  for update;

  if source_item.id is null then
    raise no_data_found using message = 'The library source could not be found.';
  end if;
  if source_item.source_document_id is null
    or source_item.source_sha256 is null
    or source_item.page_count is null
  then
    raise check_violation using message = 'The source file evidence is incomplete.';
  end if;

  select document.* into document_record
  from private.hr_documents document
  where document.id = source_item.source_document_id
    and document.employee_id is null
    and document.archived_at is null
    and document.current_version_id is not null
  for update;

  if document_record.id is null then
    raise no_data_found using message = 'The protected company source document is unavailable.';
  end if;
  perform private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'manage');
  select version.* into version_record
  from private.hr_document_versions version
  where version.id = document_record.current_version_id;
  if version_record.id is null
    or source_item.source_version_id is distinct from version_record.id
    or source_item.source_sha256 is distinct from version_record.sha256_checksum
    or target_expected_sha256 is distinct from version_record.sha256_checksum
  then
    raise serialization_failure using message = 'The protected PDF changed after catalog review. Re-register and review the current draft before adopting it.';
  end if;
  if private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean' then
    raise insufficient_privilege using message = 'The source file has not passed security review.';
  end if;
  if source_item.lifecycle_status = 'adopted' then
    return jsonb_build_object(
      'libraryItemId', source_item.id,
      'documentId', source_item.source_document_id,
      'lifecycleStatus', source_item.lifecycle_status,
      'sourceType', source_item.source_type,
      'alreadyAdopted', true
    );
  end if;
  if source_item.updated_at is distinct from target_expected_updated_at
    or source_item.source_sha256 is distinct from target_expected_sha256
  then
    raise serialization_failure using message = 'This source changed after it was reviewed. Refresh and review the latest version before adopting it.';
  end if;
  if source_item.lifecycle_status <> 'draft_for_adoption' then
    raise check_violation using message = 'Only a draft source can be adopted.';
  end if;
  if source_item.source_type = 'unclassified' then
    raise check_violation using message = 'Classify this source before adopting it.';
  end if;

  registration_result := private.register_hr_system_item(
    target_actor_id,
    source_item.source_document_id,
    source_item.form_code,
    source_item.title,
    source_item.category,
    source_item.section,
    source_item.record_class,
    source_item.purpose,
    source_item.audience_scope,
    source_item.sensitivity,
    source_item.source_filename,
    source_item.document_kind,
    'adopted',
    source_item.guide_code,
    source_item.related_modules,
    source_item.source_sha256,
    source_item.page_count,
    source_item.full_text,
    source_item.package_metadata,
    target_request_id,
    source_item.source_type
  );

  adopted_at := clock_timestamp();
  insert into private.hr_document_access_events(
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    document_record.id,
    document_record.current_version_id,
    'reclassify',
    target_actor_id,
    nullif(btrim(target_request_id), ''),
    clean_reason,
    jsonb_build_object(
      'libraryItemId', source_item.id,
      'sourceType', source_item.source_type,
      'lifecycleFrom', 'draft_for_adoption',
      'lifecycleTo', 'adopted',
      'adoptedAt', adopted_at
    )
  );

  return registration_result || jsonb_build_object(
    'lifecycleStatus', 'adopted',
    'alreadyAdopted', false,
    'adoptedAt', adopted_at
  );
end
$$;

revoke all on function public.service_adopt_hr_library_source(uuid, uuid, timestamptz, text, text, text)
  from public, anon, authenticated;
grant execute on function public.service_adopt_hr_library_source(uuid, uuid, timestamptz, text, text, text)
  to service_role;

create or replace function public.service_retire_hr_library_source(
  target_actor_id uuid,
  target_library_item_id uuid,
  target_expected_updated_at timestamptz,
  target_expected_sha256 text,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
  source_item private.hr_template_library_items%rowtype;
  document_record private.hr_documents%rowtype;
  version_record private.hr_document_versions%rowtype;
  clean_reason text := nullif(btrim(target_reason), '');
  retired_at timestamptz;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  effective_permissions := private.document_studio_require_actor(target_actor_id);
  if not (effective_permissions && array['hr.documents.manage','hr.learning.manage','training.manage']::text[]) then
    raise insufficient_privilege using message = 'HR document or training management permission is required.';
  end if;
  if clean_reason is null or char_length(clean_reason) < 5 or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'Add a concise retirement reason between 5 and 1,000 characters.';
  end if;
  if target_expected_updated_at is null or target_expected_sha256 is null or target_expected_sha256 !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Refresh the source before retiring it.';
  end if;
  if not exists (
    select 1 from private.hr_template_library_release_gate gate where gate.singleton and gate.enabled
  ) or not exists (
    select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled
  ) then
    raise insufficient_privilege using message = 'The protected document library is not released.';
  end if;

  select item.* into source_item
  from private.hr_template_library_items item
  where item.id = target_library_item_id
  for update;
  if source_item.id is null then
    raise no_data_found using message = 'The library source could not be found.';
  end if;
  if source_item.source_document_id is null or source_item.source_version_id is null or source_item.source_sha256 is null then
    raise check_violation using message = 'The source file evidence is incomplete.';
  end if;

  select document.* into document_record
  from private.hr_documents document
  where document.id = source_item.source_document_id
    and document.employee_id is null
    and document.archived_at is null
    and document.current_version_id is not null
  for update;
  if document_record.id is null then
    raise no_data_found using message = 'The protected company source document is unavailable.';
  end if;
  perform private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'manage');

  select version.* into version_record
  from private.hr_document_versions version
  where version.id = document_record.current_version_id;
  if version_record.id is null
    or source_item.source_version_id is distinct from version_record.id
    or source_item.source_sha256 is distinct from version_record.sha256_checksum
    or target_expected_sha256 is distinct from version_record.sha256_checksum
  then
    raise serialization_failure using message = 'The protected PDF changed after catalog review. Refresh before retiring it.';
  end if;
  if private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean' then
    raise insufficient_privilege using message = 'The source file has not passed security review.';
  end if;
  if source_item.lifecycle_status = 'retired' then
    return jsonb_build_object(
      'libraryItemId', source_item.id,
      'documentId', source_item.source_document_id,
      'lifecycleStatus', source_item.lifecycle_status,
      'sourceType', source_item.source_type,
      'alreadyRetired', true
    );
  end if;
  if source_item.updated_at is distinct from target_expected_updated_at then
    raise serialization_failure using message = 'This source changed after it was reviewed. Refresh before retiring it.';
  end if;
  if source_item.lifecycle_status <> 'adopted' then
    raise check_violation using message = 'Only an adopted source can be retired.';
  end if;

  retired_at := clock_timestamp();
  update private.hr_template_library_items item
  set lifecycle_status = 'retired',
      active = false,
      updated_at = retired_at
  where item.id = source_item.id;

  if source_item.document_kind = 'training_module' then
    update public.training_courses course
    set active = false,
        updated_at = retired_at
    where course.code = source_item.form_code;

    update private.hr_learning_items learning
    set status = 'retired',
        approved_by = null,
        approved_at = null,
        updated_at = retired_at
    where learning.code = lower(replace(source_item.form_code, '-', '_'));
  end if;

  insert into private.hr_document_access_events(
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    document_record.id,
    version_record.id,
    'reclassify',
    target_actor_id,
    nullif(btrim(target_request_id), ''),
    clean_reason,
    jsonb_build_object(
      'libraryItemId', source_item.id,
      'sourceType', source_item.source_type,
      'lifecycleFrom', 'adopted',
      'lifecycleTo', 'retired',
      'retiredAt', retired_at
    )
  );

  return jsonb_build_object(
    'libraryItemId', source_item.id,
    'documentId', source_item.source_document_id,
    'lifecycleStatus', 'retired',
    'sourceType', source_item.source_type,
    'alreadyRetired', false,
    'retiredAt', retired_at
  );
end
$$;

revoke all on function public.service_retire_hr_library_source(uuid, uuid, timestamptz, text, text, text)
  from public, anon, authenticated;
grant execute on function public.service_retire_hr_library_source(uuid, uuid, timestamptz, text, text, text)
  to service_role;

-- Reconcile modules imported by the former registrar. Published versions and
-- existing employee assignments are immutable and remain available; only the
-- catalog/course eligibility flags and HR learning approval state are aligned.
update public.training_courses course
set active = source_item.lifecycle_status = 'adopted',
    updated_at = clock_timestamp()
from private.hr_template_library_items source_item
where source_item.document_kind = 'training_module'
  and source_item.form_code = course.code
  and course.active is distinct from (source_item.lifecycle_status = 'adopted');

update private.hr_learning_items learning
set status = case source_item.lifecycle_status
      when 'adopted' then 'active'
      when 'retired' then 'retired'
      else 'draft'
    end,
    approved_by = case
      when source_item.lifecycle_status = 'adopted' then coalesce(learning.approved_by, learning.created_by)
      else null
    end,
    approved_at = case
      when source_item.lifecycle_status = 'adopted' then coalesce(learning.approved_at, source_item.updated_at)
      else null
    end,
    updated_at = clock_timestamp()
from private.hr_template_library_items source_item
where source_item.document_kind = 'training_module'
  and learning.code = lower(replace(source_item.form_code, '-', '_'))
  and (
    learning.status is distinct from case source_item.lifecycle_status when 'adopted' then 'active' when 'retired' then 'retired' else 'draft' end
    or (source_item.lifecycle_status = 'adopted' and (learning.approved_by is null or learning.approved_at is null))
    or (source_item.lifecycle_status <> 'adopted' and (learning.approved_by is not null or learning.approved_at is not null))
  );

do $$
declare
  mismatched_courses integer;
  mismatched_learning integer;
begin
  select count(*) into mismatched_courses
  from private.hr_template_library_items source_item
  join public.training_courses course on course.code = source_item.form_code
  where source_item.document_kind = 'training_module'
    and course.active is distinct from (source_item.lifecycle_status = 'adopted');

  select count(*) into mismatched_learning
  from private.hr_template_library_items source_item
  join private.hr_learning_items learning on learning.code = lower(replace(source_item.form_code, '-', '_'))
  where source_item.document_kind = 'training_module'
    and (
      learning.status is distinct from case source_item.lifecycle_status when 'adopted' then 'active' when 'retired' then 'retired' else 'draft' end
      or (source_item.lifecycle_status = 'adopted' and (learning.approved_by is null or learning.approved_at is null))
      or (source_item.lifecycle_status <> 'adopted' and (learning.approved_by is not null or learning.approved_at is not null))
    );

  if mismatched_courses <> 0 or mismatched_learning <> 0 then
    raise check_violation using message = format(
      'Training lifecycle reconciliation failed: %s course rows and %s learning rows remain inconsistent.',
      mismatched_courses,
      mismatched_learning
    );
  end if;
end
$$;

create or replace function private.prevent_unadopted_library_training_activation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active and exists (
    select 1
    from private.hr_template_library_items source_item
    where source_item.document_kind = 'training_module'
      and source_item.form_code = new.code
      and source_item.lifecycle_status <> 'adopted'
  ) then
    raise check_violation using message = 'Adopt the linked training source before activating this course.';
  end if;
  return new;
end
$$;

revoke all on function private.prevent_unadopted_library_training_activation()
  from public, anon, authenticated, service_role;

drop trigger if exists prevent_unadopted_library_training_activation on public.training_courses;
create trigger prevent_unadopted_library_training_activation
before insert or update of active on public.training_courses
for each row execute function private.prevent_unadopted_library_training_activation();

create or replace function private.prevent_unadopted_library_training_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.training_courses course
    join private.hr_template_library_items source_item
      on source_item.form_code = course.code
      and source_item.document_kind = 'training_module'
    where course.id = new.course_id
      and source_item.lifecycle_status <> 'adopted'
  ) then
    raise check_violation using message = 'Adopt the linked training source before publishing a version.';
  end if;
  return new;
end
$$;

revoke all on function private.prevent_unadopted_library_training_version()
  from public, anon, authenticated, service_role;

drop trigger if exists prevent_unadopted_library_training_version on public.training_course_versions;
create trigger prevent_unadopted_library_training_version
before insert on public.training_course_versions
for each row execute function private.prevent_unadopted_library_training_version();

-- Add the source-library identity for only the document records already
-- authorized by the existing workspace function. This keeps the response
-- bounded to the requested page and avoids a second, full-catalog read in the
-- browser.
create index if not exists hr_template_library_source_document_idx
  on private.hr_template_library_items(source_document_id)
  where source_document_id is not null;

-- Library sources are shared dependencies, not ordinary company records. A
-- lifecycle operation must retire or replace the catalog item deliberately
-- before its backing document can be archived.
create or replace function private.prevent_active_hr_library_source_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.archived_at is null
    and new.archived_at is not null
    and exists (
      select 1
      from private.hr_template_library_items item
      where item.source_document_id = old.id
        and item.lifecycle_status in ('adopted', 'retired')
    )
  then
    raise check_violation using message = 'Approved and retired company-library sources must remain available for protected records and assignments. Register a new draft under a new controlled code instead.';
  end if;
  return new;
end
$$;

revoke all on function private.prevent_active_hr_library_source_archive()
  from public, anon, authenticated, service_role;

drop trigger if exists prevent_active_hr_library_source_archive on private.hr_documents;
create trigger prevent_active_hr_library_source_archive
before update of archived_at on private.hr_documents
for each row execute function private.prevent_active_hr_library_source_archive();

create or replace function private.prevent_final_hr_library_source_replacement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.current_version_id is distinct from old.current_version_id and exists (
    select 1
    from private.hr_template_library_items item
    where item.source_document_id = old.id
      and item.lifecycle_status in ('adopted', 'retired')
      and item.source_version_id = old.current_version_id
  ) then
    raise check_violation using message = 'An adopted or retired library source pins this exact PDF. Register a new draft source instead of rewriting its history.';
  end if;
  return new;
end
$$;

revoke all on function private.prevent_final_hr_library_source_replacement()
  from public, anon, authenticated, service_role;

drop trigger if exists prevent_final_hr_library_source_replacement on private.hr_documents;
create trigger prevent_final_hr_library_source_replacement
before update of current_version_id on private.hr_documents
for each row execute function private.prevent_final_hr_library_source_replacement();

create or replace function public.service_get_hr_document_workspace_v3(
  target_actor_id uuid,
  target_search text default null,
  target_employee_id uuid default null,
  target_vault_code text default null,
  target_include_archived boolean default false,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  enriched_documents jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  -- v2 remains the authority for the release gate, active-account check,
  -- effective permissions, vault scope, filters, paging, and employee detail.
  result := public.service_get_hr_document_workspace_v2(
    target_actor_id,
    target_search,
    target_employee_id,
    target_vault_code,
    target_include_archived,
    target_page,
    target_page_size
  );

  select coalesce(
    jsonb_agg(
      listed.document_json || jsonb_build_object(
        'sourceMetadata',
        case
          when source_item.id is null then null
          else jsonb_build_object(
            'code', source_item.form_code,
            'title', source_item.title,
            'section', source_item.section,
            'recordClass', source_item.record_class,
            'purpose', source_item.purpose,
            'sourceFilename', source_item.source_filename,
            'documentKind', source_item.document_kind,
            'lifecycleStatus', source_item.lifecycle_status,
            'sourceType', source_item.source_type
          )
        end
      )
      order by listed.ordinality
    ),
    '[]'::jsonb
  )
  into enriched_documents
  from jsonb_array_elements(coalesce(result -> 'documents', '[]'::jsonb))
    with ordinality as listed(document_json, ordinality)
  left join lateral (
    select
      item.id,
      item.form_code,
      item.title,
      item.section,
      item.record_class,
      item.purpose,
      item.source_filename,
      item.document_kind,
      item.lifecycle_status,
      item.source_type
    from private.hr_template_library_items item
    where item.source_document_id = (listed.document_json ->> 'id')::uuid
    order by item.active desc, item.updated_at desc, item.id
    limit 1
  ) source_item on true;

  return jsonb_set(result, '{documents}', enriched_documents, true);
end
$$;

revoke all on function public.service_get_hr_document_workspace_v3(uuid, text, uuid, text, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_get_hr_document_workspace_v3(uuid, text, uuid, text, boolean, integer, integer)
  to service_role;

comment on function public.service_get_hr_document_workspace_v3(uuid, text, uuid, text, boolean, integer, integer)
  is 'Returns the permission-scoped HR document workspace with source-library metadata embedded only for documents on the requested page.';

-- The paged source library receives the same authoritative subtype without
-- changing its original contract during a rolling Worker/database release.
create or replace function public.service_get_hr_system_library_v2(
  target_actor_id uuid,
  target_search text default null,
  target_category text default null,
  target_kind text default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  enriched_items jsonb;
  effective_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  result := public.service_get_hr_system_library(
    target_actor_id,
    target_search,
    target_category,
    target_kind,
    target_page,
    target_page_size
  );
  effective_permissions := private.document_studio_require_actor(target_actor_id);

  select coalesce(
    jsonb_agg(
      listed.item_json || jsonb_build_object(
        'sourceType', coalesce(source_item.source_type, 'unclassified'),
        'sourceSha256', source_item.source_sha256,
        'updatedAt', source_item.updated_at
      )
      order by listed.ordinality
    ),
    '[]'::jsonb
  )
  into enriched_items
  from jsonb_array_elements(coalesce(result -> 'items', '[]'::jsonb))
    with ordinality as listed(item_json, ordinality)
  left join private.hr_template_library_items source_item
    on source_item.id = (listed.item_json ->> 'id')::uuid;

  result := jsonb_set(result, '{items}', enriched_items, true);
  return jsonb_set(
    result,
    '{permissions,canManage}',
    to_jsonb('hr.documents.manage' = any(effective_permissions)),
    true
  );
end
$$;

revoke all on function public.service_get_hr_system_library_v2(uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_get_hr_system_library_v2(uuid, text, text, text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;

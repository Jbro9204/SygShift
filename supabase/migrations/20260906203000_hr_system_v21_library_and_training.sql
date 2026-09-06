begin;

-- Expand the controlled library from the original form register to the complete
-- v2.1 PDF and training package. Binaries still use the existing quarantine,
-- malware scan, immutable-version, access-grant, and audit pipeline.
alter table private.hr_template_library_items
  drop constraint if exists hr_template_library_code_format;
alter table private.hr_template_library_items
  add constraint hr_template_library_code_format
  check (form_code ~ '^[A-Z][A-Z0-9-]{1,79}$');

alter table private.hr_template_library_items
  add column document_kind text not null default 'hr_source',
  add column section text not null default 'Legacy library',
  add column lifecycle_status text not null default 'adopted',
  add column guide_code text,
  add column related_modules text[] not null default '{}'::text[],
  add column source_sha256 text,
  add column page_count integer,
  add column full_text text not null default '',
  add column package_metadata jsonb not null default '{}'::jsonb;

alter table private.hr_template_library_items
  add constraint hr_template_library_kind check (document_kind in ('hr_source','training_admin','training_module','document_guide','training_form')),
  add constraint hr_template_library_lifecycle check (lifecycle_status in ('draft_for_adoption','adopted','retired')),
  add constraint hr_template_library_sha check (source_sha256 is null or source_sha256 ~ '^[a-f0-9]{64}$'),
  add constraint hr_template_library_pages check (page_count is null or page_count > 0),
  add constraint hr_template_library_metadata check (jsonb_typeof(package_metadata) = 'object');

create index hr_template_library_kind_idx
  on private.hr_template_library_items(document_kind, category, display_order)
  where active;

drop trigger if exists hr_template_library_items_search_vector on private.hr_template_library_items;
create or replace function private.refresh_hr_template_library_search_vector()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_vector := to_tsvector(
    'english'::regconfig,
    coalesce(new.form_code, '') || ' ' || coalesce(new.title, '') || ' ' ||
    coalesce(new.category, '') || ' ' || coalesce(new.section, '') || ' ' ||
    coalesce(new.record_class, '') || ' ' || coalesce(new.purpose, '') || ' ' ||
    coalesce(array_to_string(new.search_aliases, ' '), '') || ' ' ||
    coalesce(array_to_string(new.related_modules, ' '), '') || ' ' || coalesce(new.full_text, '')
  );
  return new;
end
$$;
create trigger hr_template_library_items_search_vector
before insert or update of form_code, title, category, section, record_class, purpose, search_aliases, related_modules, full_text
on private.hr_template_library_items
for each row execute function private.refresh_hr_template_library_search_vector();

alter table public.training_course_versions
  add column source_document_id uuid references private.hr_documents(id) on delete restrict;
create index training_course_versions_source_document_idx
  on public.training_course_versions(source_document_id)
  where source_document_id is not null;

create or replace function public.service_register_hr_system_item(
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
  library_id uuid;
  course_id uuid;
  version_id uuid;
  latest_version integer;
  normalized_learning_code text := lower(replace(target_code, '-', '_'));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  effective_permissions := private.document_studio_require_actor(target_actor_id);
  if not (effective_permissions && array['hr.documents.manage','hr.learning.manage','training.manage']::text[]) then
    raise insufficient_privilege using message = 'HR document or training management permission is required.';
  end if;
  if target_code !~ '^[A-Z][A-Z0-9-]{1,79}$' then raise check_violation using message = 'The controlled item code is invalid.'; end if;
  if target_document_kind not in ('hr_source','training_admin','training_module','document_guide','training_form') then raise check_violation using message = 'The controlled item kind is invalid.'; end if;
  if target_audience <> 'hr_only' then raise check_violation using message = 'The protected master library is restricted to HR.'; end if;
  if target_sensitivity not in ('standard','restricted','highly_restricted') then raise check_violation using message = 'The item sensitivity is invalid.'; end if;
  if target_lifecycle_status not in ('draft_for_adoption','adopted','retired') then raise check_violation using message = 'The item lifecycle status is invalid.'; end if;
  if target_source_sha256 !~ '^[a-f0-9]{64}$' or target_page_count < 1 then raise check_violation using message = 'The PDF evidence is invalid.'; end if;
  if jsonb_typeof(coalesce(target_package_metadata, '{}'::jsonb)) <> 'object' then raise check_violation using message = 'Package metadata must be an object.'; end if;
  if not exists (
    select 1 from private.hr_documents document
    where document.id = target_document_id and document.archived_at is null and document.current_version_id is not null
  ) then raise no_data_found using message = 'The protected source document is unavailable.'; end if;

  insert into private.hr_template_library_items(
    form_code,title,category,section,record_class,purpose,audience_scope,sensitivity,
    source_filename,display_order,source_document_id,active,document_kind,lifecycle_status,
    guide_code,related_modules,source_sha256,page_count,full_text,package_metadata
  ) values (
    target_code,btrim(target_title),btrim(target_category),btrim(target_section),btrim(target_record_class),
    btrim(target_purpose),'hr_only',target_sensitivity,btrim(target_source_filename),
    coalesce((select max(item.display_order) + 10 from private.hr_template_library_items item),10),
    target_document_id,target_lifecycle_status <> 'retired',target_document_kind,target_lifecycle_status,
    nullif(btrim(target_guide_code),''),coalesce(target_related_modules,'{}'::text[]),target_source_sha256,
    target_page_count,coalesce(target_full_text,''),coalesce(target_package_metadata,'{}'::jsonb)
  )
  on conflict(form_code) do update set
    title=excluded.title, category=excluded.category, section=excluded.section, record_class=excluded.record_class,
    purpose=excluded.purpose, audience_scope=excluded.audience_scope, sensitivity=excluded.sensitivity,
    source_filename=excluded.source_filename, source_document_id=excluded.source_document_id,
    active=excluded.active, document_kind=excluded.document_kind, lifecycle_status=excluded.lifecycle_status,
    guide_code=excluded.guide_code, related_modules=excluded.related_modules,
    source_sha256=excluded.source_sha256, page_count=excluded.page_count, full_text=excluded.full_text,
    package_metadata=excluded.package_metadata, updated_at=clock_timestamp()
  returning id into library_id;

  if target_document_kind = 'training_module' then
    insert into private.hr_learning_items(
      code,title,description,delivery_method,requirement_type,status,configuration,created_by,approved_by,approved_at
    ) values (
      normalized_learning_code,btrim(target_title),btrim(target_purpose),'document','optional','active',
      jsonb_build_object('sourceDocumentId',target_document_id,'libraryItemId',library_id,'packageVersion','2.1'),
      target_actor_id,target_actor_id,clock_timestamp()
    )
    on conflict(code) do update set
      title=excluded.title, description=excluded.description, delivery_method='document', status='active',
      configuration=excluded.configuration, updated_at=clock_timestamp();

    insert into public.training_courses(code,title,description,active,created_by)
    values (target_code,btrim(target_title),btrim(target_purpose),true,target_actor_id)
    on conflict(code) do update set title=excluded.title,description=excluded.description,active=true,updated_at=clock_timestamp()
    returning id into course_id;

    select version.id into version_id from public.training_course_versions version
    where version.course_id=course_id and version.content_digest=target_source_sha256
    order by version.version_number desc limit 1;
    if version_id is null then
      select coalesce(max(version.version_number),0) into latest_version
      from public.training_course_versions version where version.course_id=course_id;
      insert into public.training_course_versions(
        course_id,version_number,title,description,content_type,content_url,instructions,effective_on,
        default_due_days,completion_rule,requires_acknowledgment,content_digest,published_by,source_document_id
      ) values (
        course_id,latest_version+1,btrim(target_title),btrim(target_purpose),'document',
        '/api/v1/training/documents/'||target_document_id::text,
        'Open the assigned PDF, complete the material, and attest to completion in Action Center.',
        current_date,14,'employee_attestation',true,target_source_sha256,target_actor_id,target_document_id
      ) returning id into version_id;
    end if;
  end if;

  insert into private.hr_document_access_events(document_id,version_id,action,actor_employee_id,request_id,reason,metadata)
  select document.id,document.current_version_id,'share',target_actor_id,nullif(btrim(target_request_id),''),
    'Registered protected HR System v2.1 library item.',
    jsonb_build_object('libraryItemId',library_id,'code',target_code,'kind',target_document_kind)
  from private.hr_documents document where document.id=target_document_id;

  return jsonb_build_object('libraryItemId',library_id,'documentId',target_document_id,'trainingCourseId',course_id,'trainingVersionId',version_id);
end
$$;

create or replace function public.service_authorize_assigned_training_document(
  target_actor_id uuid,
  target_document_id uuid,
  target_action text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare document_record private.hr_documents%rowtype; version_record private.hr_document_versions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if target_action not in ('preview','download') then raise check_violation using message = 'Unsupported training document action.'; end if;
  if not exists (
    select 1 from public.training_assignments assignment
    join public.training_course_versions version on version.id=assignment.version_id
    where assignment.employee_id=target_actor_id and assignment.status in ('assigned','in_progress','completed')
      and version.source_document_id=target_document_id
  ) and not exists (
    select 1 from private.hr_template_library_items item
    where item.source_document_id=target_document_id
      and private.document_studio_require_actor(target_actor_id) && array['hr.documents.view','hr.documents.manage','hr.learning.view','hr.learning.manage','training.manage']::text[]
  ) then raise insufficient_privilege using message = 'This training material is not assigned to you.'; end if;
  select * into document_record from private.hr_documents document where document.id=target_document_id and document.archived_at is null;
  if document_record.id is null or document_record.current_version_id is null then raise no_data_found using message = 'The training document is unavailable.'; end if;
  if private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean' then raise insufficient_privilege using message = 'The training document has not passed security review.'; end if;
  select * into version_record from private.hr_document_versions version where version.id=document_record.current_version_id;
  insert into private.hr_document_access_events(document_id,version_id,action,actor_employee_id,request_id,reason,metadata)
  values(document_record.id,version_record.id,target_action,target_actor_id,nullif(btrim(target_request_id),''),'Accessed assigned training material.',jsonb_build_object('source','action_center'));
  return jsonb_build_object('action',target_action,'bucket',version_record.storage_bucket,'objectKey',version_record.object_key,'filename',version_record.sanitized_filename,'mimeType',version_record.detected_mime_type);
end
$$;

revoke all on function public.service_register_hr_system_item(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text[],text,integer,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.service_authorize_assigned_training_document(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_register_hr_system_item(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text[],text,integer,text,jsonb,text) to service_role;
grant execute on function public.service_authorize_assigned_training_document(uuid,uuid,text,text) to service_role;

create or replace function public.service_get_hr_system_library(
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
  effective_permissions text[];
  safe_search text:=nullif(btrim(target_search),'');
  safe_category text:=nullif(btrim(target_category),'');
  safe_kind text:=nullif(btrim(target_kind),'');
  safe_page integer:=greatest(coalesce(target_page,1),1);
  safe_page_size integer:=case when target_page_size in (5,10,20) then target_page_size else 10 end;
  total_count integer; total_pages integer; category_count integer; available_count integer;
  categories_result jsonb; items_result jsonb;
begin
  if not exists(select 1 from private.hr_template_library_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message='The HR document library has not been released.';
  end if;
  effective_permissions:=private.document_studio_require_actor(target_actor_id);
  if not (effective_permissions && array['hr.documents.view','hr.documents.manage','hr.learning.view','hr.learning.manage','training.manage']::text[]) then
    raise insufficient_privilege using message='HR document or training access is required.';
  end if;
  if safe_kind is not null and safe_kind not in ('hr_source','training_admin','training_module','document_guide','training_form') then
    raise check_violation using message='The library type filter is invalid.';
  end if;

  with filtered as (
    select item.* from private.hr_template_library_items item
    where item.active and item.audience_scope='hr_only'
      and (safe_category is null or item.category=safe_category)
      and (safe_kind is null or item.document_kind=safe_kind)
      and (safe_search is null or item.search_vector @@ websearch_to_tsquery('english'::regconfig,safe_search)
        or lower(item.form_code||' '||item.title||' '||item.category||' '||item.section||' '||item.purpose)
          like '%'||lower(safe_search)||'%')
  ) select count(*) into total_count from filtered;
  total_pages:=case when total_count=0 then 0 else ceil(total_count::numeric/safe_page_size)::integer end;
  safe_page:=case when total_pages=0 then 1 else least(safe_page,total_pages) end;

  select coalesce(jsonb_agg(jsonb_build_object('name',category,'count',item_count) order by category),'[]'::jsonb)
  into categories_result from (
    select item.category,count(*) item_count from private.hr_template_library_items item
    where item.active and item.audience_scope='hr_only' and (safe_kind is null or item.document_kind=safe_kind)
    group by item.category
  ) grouped;

  with filtered as (
    select item.* from private.hr_template_library_items item
    where item.active and item.audience_scope='hr_only'
      and (safe_category is null or item.category=safe_category)
      and (safe_kind is null or item.document_kind=safe_kind)
      and (safe_search is null or item.search_vector @@ websearch_to_tsquery('english'::regconfig,safe_search)
        or lower(item.form_code||' '||item.title||' '||item.category||' '||item.section||' '||item.purpose)
          like '%'||lower(safe_search)||'%')
    order by item.document_kind,item.category,item.form_code
    offset (safe_page-1)*safe_page_size limit safe_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item.id,'code',item.form_code,'title',item.title,'category',item.category,
    'section',item.section,'recordClass',item.record_class,'purpose',item.purpose,
    'audience',item.audience_scope,'sensitivity',item.sensitivity,'sourceFilename',item.source_filename,
    'sourceDocumentId',item.source_document_id,'documentKind',item.document_kind,
    'lifecycleStatus',item.lifecycle_status,'guideCode',item.guide_code,'relatedModules',item.related_modules,
    'pageCount',item.page_count,
    'availability',case when item.source_document_id is not null
      and exists(select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled)
      and document.current_version_id is not null and private.hr_document_latest_scan_state(document.current_version_id)='clean'
      then 'available' else 'cataloged' end
  ) order by item.document_kind,item.category,item.form_code),'[]'::jsonb)
  into items_result from filtered item
  left join private.hr_documents document on document.id=item.source_document_id and document.archived_at is null;

  select count(distinct item.category) into category_count from private.hr_template_library_items item
  where item.active and item.audience_scope='hr_only' and (safe_kind is null or item.document_kind=safe_kind);
  select count(*) into available_count from private.hr_template_library_items item
  join private.hr_documents document on document.id=item.source_document_id and document.archived_at is null
  where item.active and item.audience_scope='hr_only' and (safe_kind is null or item.document_kind=safe_kind)
    and document.current_version_id is not null and private.hr_document_latest_scan_state(document.current_version_id)='clean';

  return jsonb_build_object(
    'releaseState','released','libraryVersion',(select gate.library_version from private.hr_template_library_release_gate gate where gate.singleton),
    'permissions',jsonb_build_object('canSeeSupervisor',false,'canSeeHr',true),
    'summary',jsonb_build_object('visibleCount',(select count(*) from private.hr_template_library_items item where item.active and item.audience_scope='hr_only' and (safe_kind is null or item.document_kind=safe_kind)),'matchingCount',total_count,'availableCount',available_count,'categoryCount',category_count),
    'categories',categories_result,'items',items_result,
    'pagination',jsonb_build_object('page',safe_page,'pageSize',safe_page_size,'totalCount',total_count,'totalPages',total_pages)
  );
end
$$;
revoke all on function public.service_get_hr_system_library(uuid,text,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.service_get_hr_system_library(uuid,text,text,text,integer,integer) to service_role;

update private.hr_template_library_release_gate
set library_version='2.1',source_reference='Guardianship Security HR System v2.1 with Training',updated_at=clock_timestamp()
where singleton;

notify pgrst, 'reload schema';
commit;

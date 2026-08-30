begin;

-- Stage 4, run 1 installs a private, feature-off document foundation. It does
-- not migrate existing files, expose storage objects, or alter current access.
create temporary table hris_stage4_document_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('hr.documents.view', 'HR & Finance', 'View HR documents', 'Open the approved HR document workspace and view authorized vault summaries.', 'sensitive', true, true, true),
  ('hr.documents.manage', 'HR & Finance', 'Manage HR documents', 'Upload, classify, replace, archive, and restore documents in authorized HR vaults.', 'critical', true, true, true),
  ('hr.documents.financial', 'HR & Finance', 'View financial documents', 'View payroll, tax, benefits, and other financial HR documents.', 'critical', true, true, true),
  ('hr.documents.financial_manage', 'HR & Finance', 'Manage financial documents', 'Manage payroll, tax, benefits, and other financial HR documents.', 'critical', true, true, true),
  ('hr.documents.identity', 'HR & Finance', 'View identity documents', 'View identity, I-9, work authorization, and background-check documents.', 'critical', true, true, true),
  ('hr.documents.identity_manage', 'HR & Finance', 'Manage identity documents', 'Manage identity, I-9, work authorization, and background-check documents.', 'critical', true, true, true),
  ('hr.documents.medical', 'HR & Finance', 'View medical and leave documents', 'View medical, accommodation, and protected-leave documents.', 'critical', true, true, true),
  ('hr.documents.medical_manage', 'HR & Finance', 'Manage medical and leave documents', 'Manage medical, accommodation, and protected-leave documents.', 'critical', true, true, true),
  ('hr.documents.disciplinary', 'HR & Finance', 'View disciplinary documents', 'View investigation, performance, and disciplinary documents.', 'critical', true, true, true),
  ('hr.documents.disciplinary_manage', 'HR & Finance', 'Manage disciplinary documents', 'Manage investigation, performance, and disciplinary documents.', 'critical', true, true, true),
  ('hr.documents.legal_safety', 'HR & Finance', 'View legal and safety documents', 'View legal, safety, workers compensation, separation, and protected case documents.', 'critical', true, true, true),
  ('hr.documents.legal_safety_manage', 'HR & Finance', 'Manage legal and safety documents', 'Manage legal, safety, workers compensation, separation, and protected case documents.', 'critical', true, true, true)
on conflict (code) do nothing;

create table private.hr_document_release_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  enabled_at timestamptz,
  enabled_by uuid references public.employees(id) on delete restrict,
  evidence_reference text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_release_gate_consistent check (
    (not enabled and enabled_at is null and enabled_by is null)
    or (enabled and enabled_at is not null and enabled_by is not null and btrim(coalesce(evidence_reference, '')) <> '')
  )
);

insert into private.hr_document_release_gate (singleton, enabled)
values (true, false);

create table private.hr_document_vaults (
  code text primary key,
  name text not null,
  description text not null,
  classification text not null,
  view_permission text not null references public.permission_catalog(code) on delete restrict,
  manage_permission text not null references public.permission_catalog(code) on delete restrict,
  storage_bucket text not null unique,
  maximum_file_size_bytes bigint not null default 26214400,
  allowed_mime_types text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_vault_code_format check (code ~ '^hr-[a-z-]+$'),
  constraint hr_document_vault_name_present check (btrim(name) <> ''),
  constraint hr_document_vault_description_present check (btrim(description) <> ''),
  constraint hr_document_vault_classification check (classification in ('confidential', 'restricted', 'highly_restricted')),
  constraint hr_document_vault_file_size_positive check (maximum_file_size_bytes > 0),
  constraint hr_document_vault_mime_types_present check (cardinality(allowed_mime_types) > 0)
);

insert into private.hr_document_vaults (
  code, name, description, classification, view_permission, manage_permission, storage_bucket, allowed_mime_types
)
values
  ('hr-general', 'General personnel records', 'General personnel, policy, acknowledgment, training, equipment, and recruiting records.', 'confidential', 'hr.documents.view', 'hr.documents.manage', 'hr-general', array['application/pdf','image/png','image/jpeg','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('hr-financial', 'Payroll, tax, and benefits', 'Payroll, tax, benefits, and other restricted financial HR records.', 'highly_restricted', 'hr.documents.financial', 'hr.documents.financial_manage', 'hr-financial', array['application/pdf','image/png','image/jpeg','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('hr-identity', 'Identity and work authorization', 'I-9, work authorization, identity, and background-check records.', 'highly_restricted', 'hr.documents.identity', 'hr.documents.identity_manage', 'hr-identity', array['application/pdf','image/png','image/jpeg','image/webp']),
  ('hr-medical', 'Medical and protected leave', 'Medical, accommodation, and protected-leave records.', 'highly_restricted', 'hr.documents.medical', 'hr.documents.medical_manage', 'hr-medical', array['application/pdf','image/png','image/jpeg','image/webp']),
  ('hr-disciplinary', 'Investigations and disciplinary', 'Investigation, performance, and disciplinary records.', 'highly_restricted', 'hr.documents.disciplinary', 'hr.documents.disciplinary_manage', 'hr-disciplinary', array['application/pdf','image/png','image/jpeg','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('hr-legal-safety', 'Legal, safety, and separation', 'Legal, safety, workers compensation, protected case, and separation records.', 'highly_restricted', 'hr.documents.legal_safety', 'hr.documents.legal_safety_manage', 'hr-legal-safety', array['application/pdf','image/png','image/jpeg','image/webp','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (code) do nothing;

create table private.hr_document_retention_policies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  retention_months integer,
  disposition_review_required boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_retention_code_format check (code ~ '^[A-Z][A-Z0-9_-]*$'),
  constraint hr_document_retention_name_present check (btrim(name) <> ''),
  constraint hr_document_retention_months_positive check (retention_months is null or retention_months > 0)
);

insert into private.hr_document_retention_policies (code, name, retention_months, disposition_review_required)
values ('MANUAL_REVIEW', 'Manual disposition review', null, true);

create table private.hr_documents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete restrict,
  vault_code text not null references private.hr_document_vaults(code) on delete restrict,
  title text not null,
  category text not null,
  description text,
  access_classification text not null,
  effective_date date,
  expiration_date date,
  required_document_type text,
  employee_visible boolean not null default false,
  manager_visible boolean not null default false,
  source text not null default 'hr_upload',
  related_record_type text,
  related_record_id uuid,
  retention_policy_id uuid not null references private.hr_document_retention_policies(id) on delete restrict,
  disposition_eligible_on date,
  current_version_id uuid,
  archived_at timestamptz,
  archived_by uuid references public.employees(id) on delete restrict,
  archive_reason text,
  restored_at timestamptz,
  restored_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_title_present check (btrim(title) <> '' and char_length(title) <= 180),
  constraint hr_document_category_present check (btrim(category) <> '' and char_length(category) <= 100),
  constraint hr_document_classification check (access_classification in ('confidential', 'restricted', 'highly_restricted')),
  constraint hr_document_dates check (expiration_date is null or effective_date is null or expiration_date >= effective_date),
  constraint hr_document_archive_consistent check (
    (archived_at is null and archived_by is null and archive_reason is null)
    or (archived_at is not null and archived_by is not null and btrim(coalesce(archive_reason, '')) <> '')
  )
);

create table private.hr_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_number integer not null,
  storage_bucket text not null,
  object_key text not null,
  original_filename text not null,
  sanitized_filename text not null,
  extension text not null,
  declared_mime_type text,
  detected_mime_type text,
  size_bytes bigint not null,
  sha256_checksum text not null,
  replacement_reason text,
  uploaded_at timestamptz not null default clock_timestamp(),
  uploaded_by uuid not null references public.employees(id) on delete restrict,
  upload_source text not null default 'hr_workspace',
  idempotency_key uuid not null,
  constraint hr_document_version_number_positive check (version_number > 0),
  constraint hr_document_version_object_key_random check (object_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  constraint hr_document_version_filename_present check (btrim(original_filename) <> '' and btrim(sanitized_filename) <> ''),
  constraint hr_document_version_extension_safe check (extension in ('pdf','png','jpg','jpeg','webp','txt','docx','xlsx')),
  constraint hr_document_version_size_positive check (size_bytes > 0 and size_bytes <= 26214400),
  constraint hr_document_version_sha256 check (sha256_checksum ~ '^[a-f0-9]{64}$'),
  unique (document_id, version_number),
  unique (storage_bucket, object_key),
  unique (idempotency_key)
);

alter table private.hr_documents
  add constraint hr_documents_current_version_fk
  foreign key (current_version_id) references private.hr_document_versions(id) on delete restrict;

create table private.hr_document_scan_events (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  state text not null,
  scanner_name text not null,
  scanner_version text,
  signature_reference text,
  evidence_sha256 text,
  details text,
  scanned_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.employees(id) on delete restrict,
  constraint hr_document_scan_state check (state in ('quarantined', 'scan_pending', 'clean', 'rejected', 'scan_error')),
  constraint hr_document_scanner_present check (btrim(scanner_name) <> ''),
  constraint hr_document_scan_evidence_hash check (evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$')
);

create table private.hr_document_legal_holds (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  reason text not null,
  placed_at timestamptz not null default clock_timestamp(),
  placed_by uuid not null references public.employees(id) on delete restrict,
  released_at timestamptz,
  released_by uuid references public.employees(id) on delete restrict,
  release_reason text,
  constraint hr_document_hold_reason_present check (btrim(reason) <> ''),
  constraint hr_document_hold_release_consistent check (
    (released_at is null and released_by is null and release_reason is null)
    or (released_at is not null and released_by is not null and btrim(coalesce(release_reason, '')) <> '')
  )
);

create unique index hr_document_active_legal_hold_unique
  on private.hr_document_legal_holds(document_id)
  where released_at is null;

create table private.hr_document_access_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid references private.hr_document_versions(id) on delete restrict,
  action text not null,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  request_id text,
  reason text,
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint hr_document_access_action check (action in ('upload','preview','view','download','bulk_download','replace','archive','restore','reclassify','share','sign','acknowledge','retention_change','legal_hold_change','scan_release','scan_reject'))
);

create index hr_documents_employee_vault_index on private.hr_documents(employee_id, vault_code, archived_at);
create index hr_document_versions_document_index on private.hr_document_versions(document_id, version_number desc);
create index hr_document_scan_events_version_index on private.hr_document_scan_events(version_id, scanned_at desc);
create index hr_document_access_events_document_index on private.hr_document_access_events(document_id, occurred_at desc);

create function private.hr_document_prevent_version_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Document versions are immutable. Create a replacement version instead.';
end
$$;

create function private.hr_document_prevent_append_only_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only.', tg_table_name;
end
$$;

create function private.hr_document_prevent_hold_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Legal-hold history cannot be deleted.';
end
$$;

create trigger hr_document_versions_immutable
before update or delete on private.hr_document_versions
for each row execute function private.hr_document_prevent_version_change();

create trigger hr_document_scan_events_append_only
before update or delete on private.hr_document_scan_events
for each row execute function private.hr_document_prevent_append_only_change();

create trigger hr_document_access_events_append_only
before update or delete on private.hr_document_access_events
for each row execute function private.hr_document_prevent_append_only_change();

create trigger hr_document_legal_holds_no_delete
before delete on private.hr_document_legal_holds
for each row execute function private.hr_document_prevent_hold_delete();

create trigger hr_document_release_gate_updated_at
before update on private.hr_document_release_gate
for each row execute function private.set_updated_at();

create trigger hr_document_vaults_updated_at
before update on private.hr_document_vaults
for each row execute function private.set_updated_at();

create trigger hr_document_retention_policies_updated_at
before update on private.hr_document_retention_policies
for each row execute function private.set_updated_at();

create trigger hr_documents_updated_at
before update on private.hr_documents
for each row execute function private.set_updated_at();

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'hr_document_release_gate',
    'hr_document_vaults',
    'hr_document_retention_policies',
    'hr_documents',
    'hr_document_versions',
    'hr_document_scan_events',
    'hr_document_legal_holds',
    'hr_document_access_events'
  ] loop
    execute format('create trigger %I after insert or update or delete on private.%I for each row execute function private.write_audit_event()', relation_name || '_audit', relation_name);
  end loop;
end
$$;

create function private.require_hr_document_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = actor_id
      and employee.status in ('active', 'onboarding', 'leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required.';
  end if;

  -- This foundation intentionally has no document access-minting function.
  -- The later access boundary must additionally prove an AAL2 challenge no more than 15 minutes old.
  -- Trusted-device state alone is not sufficient.

  return actor_id;
end
$$;

create function private.require_hr_document_permission(target_vault text, target_action text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_document_actor();
  required_permission text;
begin

  if target_action not in ('view', 'manage') then
    raise check_violation using message = 'The requested document action is not supported.';
  end if;

  select case when target_action = 'manage' then vault.manage_permission else vault.view_permission end
    into required_permission
  from private.hr_document_vaults vault
  where vault.code = target_vault and vault.active;

  if required_permission is null then
    raise check_violation using message = 'The requested document vault is not available.';
  end if;

  if target_action = 'manage' and not public.has_effective_permission('hr.documents.manage') then
    raise insufficient_privilege using message = 'Document management access is required.';
  end if;

  if target_action = 'view' and not (
    public.has_effective_permission('hr.documents.view')
    or public.has_effective_permission('hr.documents.manage')
  ) then
    raise insufficient_privilege using message = 'Document access is required.';
  end if;

  if required_permission not in ('hr.documents.view', 'hr.documents.manage')
    and not public.has_effective_permission(required_permission) then
    raise insufficient_privilege using message = 'Access to this document vault is required.';
  end if;

  return actor_id;
end
$$;

create function private.hr_document_latest_scan_state(target_version_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select event.state
    from private.hr_document_scan_events event
    where event.version_id = target_version_id
    order by event.scanned_at desc, event.id desc
    limit 1
  ), 'quarantined')
$$;

create function public.get_hr_document_vault_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  result jsonb;
begin
  actor_id := private.require_hr_document_actor();

  if not exists (
    select 1 from private.hr_document_vaults vault
    where vault.active
      and (
        (vault.view_permission in ('hr.documents.view', 'hr.documents.manage') and (
          public.has_effective_permission('hr.documents.view') or public.has_effective_permission('hr.documents.manage')
        ))
        or public.has_effective_permission(vault.view_permission)
        or public.has_effective_permission(vault.manage_permission)
      )
  ) then
    raise insufficient_privilege using message = 'Document access is required.';
  end if;

  perform actor_id;

  select jsonb_build_object(
    'enabled', gate.enabled,
    'securityState', case when gate.enabled then 'released' else 'foundation_only' end,
    'vaults', coalesce(jsonb_agg(jsonb_build_object(
      'code', vault.code,
      'name', vault.name,
      'classification', vault.classification,
      'documentCount', (select count(*) from private.hr_documents document where document.vault_code = vault.code and document.archived_at is null),
      'quarantinedCount', (select count(*) from private.hr_documents document join private.hr_document_versions version on version.id = document.current_version_id where document.vault_code = vault.code and document.archived_at is null and private.hr_document_latest_scan_state(version.id) <> 'clean')
    ) order by vault.name) filter (where vault.code is not null), '[]'::jsonb)
  )
  into result
  from private.hr_document_release_gate gate
  left join private.hr_document_vaults vault on vault.active and (
    (vault.view_permission in ('hr.documents.view', 'hr.documents.manage') and (
      public.has_effective_permission('hr.documents.view') or public.has_effective_permission('hr.documents.manage')
    ))
    or public.has_effective_permission(vault.view_permission)
    or public.has_effective_permission(vault.manage_permission)
  )
  where gate.singleton
  group by gate.enabled;

  return result;
end
$$;

create function private.record_hr_document_scan(
  target_version_id uuid,
  target_state text,
  target_scanner_name text,
  target_scanner_version text default null,
  target_signature_reference text default null,
  target_evidence_sha256 text default null,
  target_details text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_id uuid;
begin
  if target_state not in ('quarantined', 'scan_pending', 'clean', 'rejected', 'scan_error') then
    raise check_violation using message = 'The scan state is not supported.';
  end if;
  if not exists (select 1 from private.hr_document_versions version where version.id = target_version_id) then
    raise foreign_key_violation using message = 'The document version does not exist.';
  end if;
  if target_state = 'clean' and btrim(coalesce(target_evidence_sha256, '')) = '' then
    raise check_violation using message = 'Clean scan results require evidence.';
  end if;

  insert into private.hr_document_scan_events (
    version_id, state, scanner_name, scanner_version, signature_reference, evidence_sha256, details
  ) values (
    target_version_id, target_state, target_scanner_name, target_scanner_version, target_signature_reference, target_evidence_sha256, target_details
  ) returning id into event_id;

  return event_id;
end
$$;

revoke all on
  private.hr_document_release_gate,
  private.hr_document_vaults,
  private.hr_document_retention_policies,
  private.hr_documents,
  private.hr_document_versions,
  private.hr_document_scan_events,
  private.hr_document_legal_holds,
  private.hr_document_access_events
from public, anon, authenticated;

grant select, insert, update on
  private.hr_document_release_gate,
  private.hr_document_vaults,
  private.hr_document_retention_policies,
  private.hr_documents,
  private.hr_document_legal_holds
to service_role;

grant select, insert on
  private.hr_document_versions,
  private.hr_document_scan_events,
  private.hr_document_access_events
to service_role;

revoke all on function private.require_hr_document_actor() from public, anon, authenticated;
revoke all on function private.require_hr_document_permission(text, text) from public, anon, authenticated;
revoke all on function private.hr_document_latest_scan_state(uuid) from public, anon, authenticated;
revoke all on function private.record_hr_document_scan(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.get_hr_document_vault_readiness() from public, anon;
grant execute on function public.get_hr_document_vault_readiness() to authenticated;
grant execute on function private.record_hr_document_scan(uuid, text, text, text, text, text, text) to service_role;

do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  select
    vault.storage_bucket,
    vault.storage_bucket,
    false,
    vault.maximum_file_size_bytes,
    vault.allowed_mime_types
  from private.hr_document_vaults vault
  on conflict (id) do update
  set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = now();
end
$$;

do $$
declare
  baseline record;
begin
  select * into baseline from hris_stage4_document_preservation_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'Stage 4 migration changed protected employee, identity, or access-control records.';
  end if;

  if exists (
    select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled
  ) then
    raise exception 'Stage 4 document release gate must remain disabled.';
  end if;

  if (select count(*) from private.hr_document_vaults) <> 6 then
    raise exception 'Stage 4 must install exactly six separated document vaults.';
  end if;
end
$$;

commit;

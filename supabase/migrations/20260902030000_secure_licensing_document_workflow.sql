begin;

create temporary table licensing_document_release_snapshot on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select md5(coalesce(string_agg(md5(to_jsonb(employee)::text), '' order by employee.id), '')) from public.employees employee) as employee_fingerprint,
  (select count(*) from public.employee_credentials) as credential_count,
  (select md5(coalesce(string_agg(md5(to_jsonb(credential)::text), '' order by credential.id), '')) from public.employee_credentials credential) as credential_fingerprint,
  (select count(*) from public.employee_credential_documents) as credential_document_count,
  (select md5(coalesce(string_agg(md5(jsonb_build_object(
    'id', document.id,
    'credentialId', document.credential_id,
    'storagePath', document.storage_path,
    'originalFilename', document.original_filename,
    'contentType', document.content_type,
    'byteSize', document.byte_size,
    'uploadedBy', document.uploaded_by,
    'uploadedAt', document.uploaded_at,
    'archivedAt', document.archived_at,
    'archivedBy', document.archived_by,
    'archiveReason', document.archive_reason
  )::text), '' order by document.id), '')) from public.employee_credential_documents document) as credential_document_fingerprint,
  (select count(*) from storage.objects where bucket_id = 'credential-documents') as storage_object_count,
  (select md5(coalesce(string_agg(md5(jsonb_build_object('id', object.id, 'name', object.name, 'bucket', object.bucket_id)::text), '' order by object.id), '')) from storage.objects object where object.bucket_id = 'credential-documents') as storage_object_fingerprint,
  (select count(*) from public.employee_access_roles) as employee_access_role_count,
  (select count(*) from public.employee_permission_overrides) as employee_permission_override_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from private.payroll_export_batches) as payroll_export_batch_count;

alter table public.employee_credential_documents
  add column if not exists upload_request_id uuid,
  add column if not exists upload_state text not null default 'stored',
  add column if not exists sha256_checksum text,
  add column if not exists stored_at timestamptz,
  add column if not exists failure_detail text;

update public.employee_credential_documents
set upload_state = 'stored',
    stored_at = coalesce(stored_at, uploaded_at)
where upload_state = 'stored';

alter table public.employee_credential_documents
  alter column upload_state set default 'pending';

alter table public.employee_credential_documents
  drop constraint if exists employee_credential_documents_upload_state_valid,
  drop constraint if exists employee_credential_documents_checksum_valid,
  drop constraint if exists employee_credential_documents_failure_detail_length;

alter table public.employee_credential_documents
  add constraint employee_credential_documents_upload_state_valid
    check (upload_state in ('pending', 'stored', 'failed')),
  add constraint employee_credential_documents_checksum_valid
    check (sha256_checksum is null or sha256_checksum ~ '^[a-f0-9]{64}$'),
  add constraint employee_credential_documents_failure_detail_length
    check (failure_detail is null or char_length(failure_detail) <= 1000);

create unique index if not exists employee_credential_documents_upload_request_uidx
  on public.employee_credential_documents(upload_request_id)
  where upload_request_id is not null;

create index if not exists employee_credential_documents_active_state_idx
  on public.employee_credential_documents(credential_id, upload_state, uploaded_at desc)
  where archived_at is null;

drop policy if exists sygshift_credential_documents_privileged_access on storage.objects;

create or replace function private.require_recent_licensing_document_mfa(
  target_method text,
  target_verified_at timestamptz
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '15 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute'
  then
    raise insufficient_privilege using message = 'Recent MFA verification is required for licensing document access.';
  end if;
end
$$;

create or replace function private.require_service_licensing_document_permission(
  target_actor_id uuid,
  target_action text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_permissions text[];
begin
  if target_actor_id is null or not exists (
    select 1
    from public.employees employee
    where employee.id = target_actor_id
      and employee.status in ('onboarding', 'active', 'leave')
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  actor_permissions := private.employee_effective_permissions(target_actor_id);
  if target_action = 'manage' then
    if not (
      'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ) then
      raise insufficient_privilege using message = 'Licensing document management permission is required.';
    end if;
  elsif not (
    'licensing.view' = any(coalesce(actor_permissions, array[]::text[]))
    or 'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
    or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
  ) then
    raise insufficient_privilege using message = 'Licensing document access is required.';
  end if;
end
$$;

create or replace function public.service_get_licensing_credential_documents(
  target_actor_id uuid,
  target_credential_id uuid,
  target_page integer default 1,
  target_page_size integer default 5,
  target_mfa_method text default null,
  target_mfa_verified_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_permissions text[];
  clean_page integer := greatest(coalesce(target_page, 1), 1);
  clean_page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 5 end;
  total_count integer;
  payload jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.require_service_licensing_document_permission(target_actor_id, 'view');
  perform private.require_recent_licensing_document_mfa(target_mfa_method, target_mfa_verified_at);
  actor_permissions := private.employee_effective_permissions(target_actor_id);

  if not exists (
    select 1 from public.employee_credentials credential
    where credential.id = target_credential_id and credential.archived_at is null
  ) then
    raise no_data_found using message = 'Credential was not found.';
  end if;

  select count(*)::integer into total_count
  from public.employee_credential_documents document
  where document.credential_id = target_credential_id
    and document.archived_at is null
    and document.upload_state = 'stored';

  select jsonb_build_object(
    'credentialId', credential.id,
    'credentialName', credential_type.name,
    'canUpload', (
      'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', document.id,
        'filename', document.original_filename,
        'contentType', document.content_type,
        'byteSize', document.byte_size,
        'uploadedAt', document.uploaded_at
      ) order by document.uploaded_at desc, document.id desc)
      from (
        select document.*
        from public.employee_credential_documents document
        where document.credential_id = credential.id
          and document.archived_at is null
          and document.upload_state = 'stored'
        order by document.uploaded_at desc, document.id desc
        limit clean_page_size
        offset (clean_page - 1) * clean_page_size
      ) document
    ), '[]'::jsonb),
    'pagination', jsonb_build_object(
      'page', clean_page,
      'pageSize', clean_page_size,
      'totalCount', total_count,
      'totalPages', case when total_count = 0 then 0 else ceil(total_count::numeric / clean_page_size)::integer end
    )
  ) into payload
  from public.employee_credentials credential
  left join public.credential_types credential_type on credential_type.id = credential.credential_type_id
  where credential.id = target_credential_id;

  return payload;
end
$$;

create or replace function public.service_prepare_licensing_document_upload(
  target_actor_id uuid,
  target_credential_id uuid,
  target_upload_request_id uuid,
  target_original_filename text,
  target_content_type text,
  target_byte_size bigint,
  target_sha256_checksum text,
  target_extension text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  credential_record public.employee_credentials%rowtype;
  existing_record public.employee_credential_documents%rowtype;
  document_id uuid := gen_random_uuid();
  storage_path text;
  clean_filename text := btrim(coalesce(target_original_filename, ''));
  clean_content_type text := lower(btrim(coalesce(target_content_type, '')));
  clean_checksum text := lower(btrim(coalesce(target_sha256_checksum, '')));
  clean_extension text := lower(btrim(coalesce(target_extension, '')));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.require_service_licensing_document_permission(target_actor_id, 'manage');
  perform private.require_recent_licensing_document_mfa(target_mfa_method, target_mfa_verified_at);

  select credential.* into credential_record
  from public.employee_credentials credential
  where credential.id = target_credential_id and credential.archived_at is null;
  if not found then raise no_data_found using message = 'Credential was not found.'; end if;

  if target_upload_request_id is null then raise check_violation using message = 'A valid upload request is required.'; end if;
  if clean_filename = '' or char_length(clean_filename) > 255 then raise check_violation using message = 'Use a valid file name.'; end if;
  if clean_content_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then raise check_violation using message = 'This licensing document type is not allowed.'; end if;
  if target_byte_size is null or target_byte_size < 1 or target_byte_size > 26214400 then raise check_violation using message = 'Licensing documents must be between 1 byte and 25 MB.'; end if;
  if clean_checksum !~ '^[a-f0-9]{64}$' then raise check_violation using message = 'The licensing document checksum is invalid.'; end if;
  if clean_extension not in ('pdf', 'png', 'jpg', 'jpeg', 'webp') then raise check_violation using message = 'This licensing document file extension is not allowed.'; end if;

  select document.* into existing_record
  from public.employee_credential_documents document
  where document.upload_request_id = target_upload_request_id;
  if found then
    if existing_record.credential_id <> target_credential_id
      or existing_record.original_filename <> clean_filename
      or existing_record.content_type <> clean_content_type
      or existing_record.byte_size <> target_byte_size
      or existing_record.sha256_checksum <> clean_checksum
    then
      raise unique_violation using message = 'This upload request is already associated with a different licensing document.';
    end if;
    return jsonb_build_object(
      'documentId', existing_record.id,
      'bucket', 'credential-documents',
      'objectKey', existing_record.storage_path,
      'state', existing_record.upload_state
    );
  end if;

  storage_path := credential_record.employee_id::text || '/' || credential_record.id::text || '/' || document_id::text || '.' || clean_extension;
  insert into public.employee_credential_documents(
    id, credential_id, storage_path, original_filename, content_type, byte_size, uploaded_by,
    uploaded_at, archived_at, archived_by, archive_reason, upload_request_id, upload_state,
    sha256_checksum, stored_at, failure_detail
  ) values (
    document_id, credential_record.id, storage_path, clean_filename, clean_content_type, target_byte_size,
    target_actor_id, clock_timestamp(), clock_timestamp(), target_actor_id, 'Protected upload pending',
    target_upload_request_id, 'pending', clean_checksum, null, null
  );

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents', 'LICENSING_DOCUMENT_UPLOAD_STARTED', document_id::text,
    jsonb_build_object('credentialId', credential_record.id, 'employeeId', credential_record.employee_id, 'filename', clean_filename, 'byteSize', target_byte_size));

  return jsonb_build_object('documentId', document_id, 'bucket', 'credential-documents', 'objectKey', storage_path, 'state', 'pending');
end
$$;

create or replace function public.service_complete_licensing_document_upload(
  target_actor_id uuid,
  target_document_id uuid,
  target_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.require_service_licensing_document_permission(target_actor_id, 'manage');

  select document.* into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
  for update;
  if not found then raise no_data_found using message = 'Licensing document upload was not found.'; end if;
  if document_record.uploaded_by <> target_actor_id then raise insufficient_privilege using message = 'The upload actor does not match.'; end if;
  if document_record.upload_state = 'stored' then
    return jsonb_build_object('documentId', document_record.id, 'state', 'stored', 'uploadedAt', document_record.stored_at);
  end if;
  if document_record.upload_state <> 'pending' then raise check_violation using message = 'This licensing document upload cannot be completed.'; end if;

  update public.employee_credential_documents document
  set upload_state = 'stored', stored_at = clock_timestamp(), archived_at = null, archived_by = null,
      archive_reason = null, failure_detail = null
  where document.id = document_record.id
  returning * into document_record;

  update public.employee_credentials credential
  set document_path = document_record.storage_path, updated_at = clock_timestamp()
  where credential.id = document_record.credential_id;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents', 'LICENSING_DOCUMENT_UPLOADED', document_record.id::text,
    jsonb_build_object('credentialId', document_record.credential_id, 'filename', document_record.original_filename,
      'contentType', document_record.content_type, 'byteSize', document_record.byte_size, 'requestId', target_request_id));

  return jsonb_build_object('documentId', document_record.id, 'state', 'stored', 'uploadedAt', document_record.stored_at);
end
$$;

create or replace function public.service_fail_licensing_document_upload(
  target_actor_id uuid,
  target_document_id uuid,
  target_failure_detail text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_failure text := left(btrim(coalesce(target_failure_detail, 'Upload failed.')), 1000);
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  update public.employee_credential_documents document
  set upload_state = 'failed', failure_detail = clean_failure, archived_at = coalesce(document.archived_at, clock_timestamp()),
      archived_by = coalesce(document.archived_by, target_actor_id), archive_reason = 'Protected upload failed'
  where document.id = target_document_id
    and document.uploaded_by = target_actor_id
    and document.upload_state = 'pending';

  if found then
    insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
    values(null, target_actor_id, 'public', 'employee_credential_documents', 'LICENSING_DOCUMENT_UPLOAD_FAILED', target_document_id::text,
      jsonb_build_object('failure', clean_failure));
  end if;
end
$$;

create or replace function public.service_authorize_licensing_document_access(
  target_actor_id uuid,
  target_document_id uuid,
  target_action text,
  target_reason text,
  target_request_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record record;
  clean_action text := lower(btrim(coalesce(target_action, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.require_service_licensing_document_permission(target_actor_id, 'view');
  perform private.require_recent_licensing_document_mfa(target_mfa_method, target_mfa_verified_at);
  if clean_action not in ('preview', 'download') then raise check_violation using message = 'Choose Preview or Download.'; end if;
  if char_length(clean_reason) < 8 or char_length(clean_reason) > 500 then raise check_violation using message = 'Enter an access reason between 8 and 500 characters.'; end if;

  select document.*, credential.employee_id
  into document_record
  from public.employee_credential_documents document
  join public.employee_credentials credential on credential.id = document.credential_id
  where document.id = target_document_id
    and document.archived_at is null
    and document.upload_state = 'stored'
    and credential.archived_at is null;
  if not found then raise no_data_found using message = 'Licensing document was not found.'; end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values(null, target_actor_id, 'public', 'employee_credential_documents',
    case when clean_action = 'download' then 'LICENSING_DOCUMENT_DOWNLOADED' else 'LICENSING_DOCUMENT_PREVIEWED' end,
    document_record.id::text,
    jsonb_build_object('credentialId', document_record.credential_id, 'employeeId', document_record.employee_id,
      'reason', clean_reason, 'requestId', target_request_id));

  return jsonb_build_object(
    'bucket', 'credential-documents',
    'objectKey', document_record.storage_path,
    'filename', document_record.original_filename,
    'mimeType', document_record.content_type,
    'action', clean_action
  );
end
$$;

revoke all on function private.require_recent_licensing_document_mfa(text, timestamptz) from public, anon, authenticated;
revoke all on function private.require_service_licensing_document_permission(uuid, text) from public, anon, authenticated;
revoke all on function public.record_licensing_credential_document(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.service_get_licensing_credential_documents(uuid, uuid, integer, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.service_prepare_licensing_document_upload(uuid, uuid, uuid, text, text, bigint, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.service_complete_licensing_document_upload(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_fail_licensing_document_upload(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_authorize_licensing_document_access(uuid, uuid, text, text, uuid, text, timestamptz) from public, anon, authenticated;

grant execute on function public.service_get_licensing_credential_documents(uuid, uuid, integer, integer, text, timestamptz) to service_role;
grant execute on function public.service_prepare_licensing_document_upload(uuid, uuid, uuid, text, text, bigint, text, text, text, timestamptz) to service_role;
grant execute on function public.service_complete_licensing_document_upload(uuid, uuid, uuid) to service_role;
grant execute on function public.service_fail_licensing_document_upload(uuid, uuid, text) to service_role;
grant execute on function public.service_authorize_licensing_document_access(uuid, uuid, text, text, uuid, text, timestamptz) to service_role;

do $$
declare
  snapshot licensing_document_release_snapshot%rowtype;
begin
  select * into snapshot from licensing_document_release_snapshot;
  if snapshot.employee_count <> (select count(*) from public.employees)
    or snapshot.employee_fingerprint <> (select md5(coalesce(string_agg(md5(to_jsonb(employee)::text), '' order by employee.id), '')) from public.employees employee)
    or snapshot.credential_count <> (select count(*) from public.employee_credentials)
    or snapshot.credential_fingerprint <> (select md5(coalesce(string_agg(md5(to_jsonb(credential)::text), '' order by credential.id), '')) from public.employee_credentials credential)
    or snapshot.credential_document_count <> (select count(*) from public.employee_credential_documents)
    or snapshot.credential_document_fingerprint <> (select md5(coalesce(string_agg(md5(jsonb_build_object(
      'id', document.id, 'credentialId', document.credential_id, 'storagePath', document.storage_path,
      'originalFilename', document.original_filename, 'contentType', document.content_type, 'byteSize', document.byte_size,
      'uploadedBy', document.uploaded_by, 'uploadedAt', document.uploaded_at, 'archivedAt', document.archived_at,
      'archivedBy', document.archived_by, 'archiveReason', document.archive_reason
    )::text), '' order by document.id), '')) from public.employee_credential_documents document)
    or snapshot.storage_object_count <> (select count(*) from storage.objects where bucket_id = 'credential-documents')
    or snapshot.storage_object_fingerprint <> (select md5(coalesce(string_agg(md5(jsonb_build_object('id', object.id, 'name', object.name, 'bucket', object.bucket_id)::text), '' order by object.id), '')) from storage.objects object where object.bucket_id = 'credential-documents')
    or snapshot.employee_access_role_count <> (select count(*) from public.employee_access_roles)
    or snapshot.employee_permission_override_count <> (select count(*) from public.employee_permission_overrides)
    or snapshot.shift_count <> (select count(*) from public.shifts)
    or snapshot.time_event_count <> (select count(*) from public.time_events)
    or snapshot.payroll_export_batch_count <> (select count(*) from private.payroll_export_batches)
  then
    raise exception 'Licensing document release preservation check failed.';
  end if;
end
$$;

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.employee_credential_documents
  add column if not exists cleanup_pending_at timestamptz,
  add column if not exists cleanup_last_error text,
  add column if not exists cleanup_attempt_count integer not null default 0,
  add column if not exists cleaned_at timestamptz;

alter table public.employee_credential_documents
  drop constraint if exists employee_credential_documents_cleanup_attempt_count_check;
alter table public.employee_credential_documents
  add constraint employee_credential_documents_cleanup_attempt_count_check
  check (cleanup_attempt_count >= 0);

create index if not exists employee_credential_documents_cleanup_pending_idx
  on public.employee_credential_documents(cleanup_pending_at, id)
  where upload_state = 'failed'
    and cleanup_pending_at is not null
    and cleaned_at is null;

-- A retry of a completion that already committed must remain successful even
-- if the actor's permission or the submission's editable status changed after
-- that commit. The document row is locked before the idempotent state check.
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
  submission public.licensing_submissions%rowtype;
  actor_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select document.*
  into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
  for update;

  if not found then
    raise no_data_found using message = 'Licensing document upload was not found.';
  end if;
  if document_record.uploaded_by <> target_actor_id then
    raise insufficient_privilege using message = 'The upload actor does not match.';
  end if;

  if document_record.upload_state = 'stored' then
    return jsonb_build_object(
      'documentId', document_record.id,
      'state', 'stored',
      'uploadedAt', document_record.stored_at
    );
  end if;
  if document_record.upload_state <> 'pending' then
    raise check_violation using message = 'This licensing document upload cannot be completed.';
  end if;

  if document_record.submission_id is not null then
    select item.*
    into submission
    from public.licensing_submissions item
    where item.id = document_record.submission_id;
    if not found
      or submission.employee_id <> target_actor_id
      or submission.status not in ('draft', 'correction_required')
    then
      raise insufficient_privilege using message = 'The licensing submission is not available for this upload.';
    end if;
  else
    actor_permissions := private.employee_effective_permissions(target_actor_id);
    if not (
      'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ) then
      raise insufficient_privilege using message = 'Licensing document management permission is required.';
    end if;
  end if;

  update public.employee_credential_documents document
  set upload_state = 'stored',
      stored_at = coalesce(document.stored_at, clock_timestamp()),
      archived_at = null,
      archived_by = null,
      archive_reason = null,
      failure_detail = null
  where document.id = document_record.id
  returning * into document_record;

  if document_record.credential_id is not null then
    update public.employee_credentials credential
    set document_path = document_record.storage_path,
        updated_at = clock_timestamp()
    where credential.id = document_record.credential_id;
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    null,
    target_actor_id,
    'public',
    'employee_credential_documents',
    'LICENSING_DOCUMENT_UPLOADED',
    document_record.id::text,
    jsonb_build_object(
      'credentialId', document_record.credential_id,
      'submissionId', document_record.submission_id,
      'filename', document_record.original_filename,
      'contentType', document_record.content_type,
      'byteSize', document_record.byte_size,
      'requestId', target_request_id
    )
  );

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', 'stored',
    'uploadedAt', document_record.stored_at
  );
end
$$;

-- The Worker must obtain this locked decision before deleting an object after
-- a deterministic completion rejection. A concurrent successful completion
-- wins as stored and cleanup is denied; otherwise pending is atomically made
-- terminal before the exact immutable object identity is returned.
create or replace function public.service_reconcile_licensing_document_upload_failure(
  target_actor_id uuid,
  target_document_id uuid,
  target_failure_detail text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
  clean_failure text := left(
    btrim(coalesce(target_failure_detail, 'Protected upload failed.')),
    1000
  );
  failure_recorded boolean := false;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select document.*
  into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
  for update;

  if not found then
    raise no_data_found using message = 'Licensing document upload was not found.';
  end if;
  if document_record.uploaded_by <> target_actor_id then
    raise insufficient_privilege using message = 'The upload actor does not match.';
  end if;

  if document_record.upload_state = 'pending' then
    update public.employee_credential_documents document
    set upload_state = 'failed',
        failure_detail = clean_failure,
        archived_at = coalesce(document.archived_at, clock_timestamp()),
        archived_by = coalesce(document.archived_by, target_actor_id),
        archive_reason = 'Protected upload failed',
        cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
        cleanup_last_error = clean_failure,
        cleaned_at = null
    where document.id = document_record.id
    returning * into document_record;
    failure_recorded := true;
  elsif document_record.upload_state = 'failed'
    and document_record.cleaned_at is null
  then
    update public.employee_credential_documents document
    set cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
        cleanup_last_error = coalesce(document.cleanup_last_error, clean_failure)
    where document.id = document_record.id
    returning * into document_record;
  end if;

  if failure_recorded then
    insert into private.audit_events(
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
    ) values (
      null,
      target_actor_id,
      'public',
      'employee_credential_documents',
      'LICENSING_DOCUMENT_UPLOAD_FAILED',
      document_record.id::text,
      jsonb_build_object('failure', clean_failure)
    );
  end if;

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', document_record.upload_state,
    'cleanupAllowed', document_record.upload_state = 'failed'
      and document_record.cleaned_at is null,
    'bucket', 'credential-documents',
    'objectKey', document_record.storage_path,
    'byteSize', document_record.byte_size,
    'checksum', document_record.sha256_checksum,
    'storedAt', document_record.stored_at
  );
end
$$;

create or replace function public.service_defer_licensing_document_cleanup(
  target_actor_id uuid,
  target_document_id uuid,
  target_object_key text,
  target_byte_size bigint,
  target_checksum text,
  target_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select document.* into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
  for update;
  if not found
    or document_record.uploaded_by <> target_actor_id
    or document_record.storage_path <> target_object_key
    or document_record.byte_size <> target_byte_size
    or document_record.sha256_checksum <> lower(target_checksum)
  then
    raise check_violation using message = 'Licensing document cleanup identity does not match.';
  end if;
  if document_record.upload_state <> 'failed' then
    raise check_violation using message = 'Only failed licensing uploads can be cleaned.';
  end if;

  update public.employee_credential_documents document
  set cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
      cleanup_attempt_count = document.cleanup_attempt_count + 1,
      cleanup_last_error = left(btrim(coalesce(target_error, 'Storage cleanup deferred.')), 1000)
  where document.id = document_record.id
  returning * into document_record;

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', document_record.upload_state,
    'cleanupPending', document_record.cleaned_at is null,
    'cleanupAttemptCount', document_record.cleanup_attempt_count
  );
end
$$;

create or replace function public.service_complete_licensing_document_cleanup(
  target_actor_id uuid,
  target_document_id uuid,
  target_object_key text,
  target_byte_size bigint,
  target_checksum text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select document.* into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
  for update;
  if not found
    or document_record.uploaded_by <> target_actor_id
    or document_record.storage_path <> target_object_key
    or document_record.byte_size <> target_byte_size
    or document_record.sha256_checksum <> lower(target_checksum)
  then
    raise check_violation using message = 'Licensing document cleanup identity does not match.';
  end if;
  if document_record.upload_state <> 'failed' then
    raise check_violation using message = 'Only failed licensing uploads can be cleaned.';
  end if;

  update public.employee_credential_documents document
  set cleanup_pending_at = null,
      cleanup_last_error = null,
      cleaned_at = coalesce(document.cleaned_at, clock_timestamp())
  where document.id = document_record.id
  returning * into document_record;

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', document_record.upload_state,
    'cleanedAt', document_record.cleaned_at
  );
end
$$;

create or replace function public.service_list_licensing_document_cleanup_recovery(
  target_limit integer default 25
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'documentId', document.id,
    'actorId', document.uploaded_by,
    'bucket', 'credential-documents',
    'objectKey', document.storage_path,
    'sizeBytes', document.byte_size,
    'checksum', document.sha256_checksum,
    'state', document.upload_state,
    'cleanupPendingAt', document.cleanup_pending_at,
    'cleanupAttemptCount', document.cleanup_attempt_count
  ) order by document.cleanup_pending_at, document.id), '[]'::jsonb)
  from (
    select failed.*
    from public.employee_credential_documents failed
    where failed.upload_state = 'failed'
      and failed.cleanup_pending_at is not null
      and failed.cleaned_at is null
    order by failed.cleanup_pending_at, failed.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) document
  where (select auth.role()) = 'service_role'
$$;

revoke all on function public.service_complete_licensing_document_upload(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_reconcile_licensing_document_upload_failure(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_defer_licensing_document_cleanup(uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_licensing_document_cleanup(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_list_licensing_document_cleanup_recovery(integer)
  from public, anon, authenticated;

grant execute on function public.service_complete_licensing_document_upload(uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_reconcile_licensing_document_upload_failure(uuid, uuid, text)
  to service_role;
grant execute on function public.service_defer_licensing_document_cleanup(uuid, uuid, text, bigint, text, text)
  to service_role;
grant execute on function public.service_complete_licensing_document_cleanup(uuid, uuid, text, bigint, text)
  to service_role;
grant execute on function public.service_list_licensing_document_cleanup_recovery(integer)
  to service_role;

commit;

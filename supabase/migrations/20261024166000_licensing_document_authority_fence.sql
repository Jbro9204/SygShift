begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Credential uploads are immutable history, while employee_credentials.document_path
-- is the single current pointer used by downstream consumers.  Completing two
-- uploads out of order previously made that pointer "last completer wins".  This
-- partial index and row-locked helper instead give every stored document one
-- deterministic authority order: server-owned upload time, then immutable UUID.
create index if not exists employee_credential_documents_authority_idx
  on public.employee_credential_documents(credential_id, uploaded_at desc, id desc)
  where credential_id is not null
    and upload_state = 'stored'
    and archived_at is null;

create or replace function private.reconcile_licensing_credential_document_authority(
  target_credential_id uuid,
  target_candidate_document_id uuid,
  target_actor_id uuid,
  target_source text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_record public.employee_credentials%rowtype;
  candidate_record public.employee_credential_documents%rowtype;
  authority_record public.employee_credential_documents%rowtype;
  prior_document_path text;
  authority_changed boolean := false;
begin
  if target_credential_id is null or target_candidate_document_id is null then
    raise check_violation using message = 'A complete licensing document authority identity is required.';
  end if;

  -- Every completion for one credential serializes here.  Once this lock is
  -- acquired, the next statement receives a fresh READ COMMITTED snapshot, so
  -- a concurrently committed newer completion participates in winner selection.
  select credential.*
  into credential_record
  from public.employee_credentials credential
  where credential.id = target_credential_id
  for update;

  if not found then
    raise no_data_found using message = 'Credential was not found.';
  end if;

  select document.*
  into candidate_record
  from public.employee_credential_documents document
  where document.id = target_candidate_document_id
    and document.credential_id = credential_record.id
    and document.upload_state = 'stored';

  if not found then
    raise check_violation using message = 'The completed licensing document does not match its credential authority target.';
  end if;

  select document.*
  into authority_record
  from public.employee_credential_documents document
  where document.credential_id = credential_record.id
    and document.upload_state = 'stored'
    and document.archived_at is null
  order by document.uploaded_at desc, document.id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'authorityApplied', false,
      'authoritativeDocumentId', null,
      'authoritativeObjectKey', null
    );
  end if;

  prior_document_path := credential_record.document_path;
  if credential_record.document_path is distinct from authority_record.storage_path then
    update public.employee_credentials credential
    set document_path = authority_record.storage_path,
        updated_at = clock_timestamp()
    where credential.id = credential_record.id
      and credential.document_path is not distinct from prior_document_path;

    if not found then
      raise serialization_failure using message = 'Credential document authority changed concurrently.';
    end if;
    authority_changed := true;

    insert into private.audit_events(
      auth_user_id,
      employee_id,
      request_id,
      schema_name,
      table_name,
      operation,
      row_id,
      old_record,
      new_record
    ) values (
      null,
      target_actor_id,
      nullif(btrim(coalesce(target_request_id, '')), ''),
      'public',
      'employee_credentials',
      'LICENSING_DOCUMENT_AUTHORITY_RECONCILED',
      credential_record.id::text,
      jsonb_build_object('documentPath', prior_document_path),
      jsonb_build_object(
        'documentPath', authority_record.storage_path,
        'authoritativeDocumentId', authority_record.id,
        'candidateDocumentId', candidate_record.id,
        'source', left(btrim(coalesce(target_source, 'licensing_document_completion')), 100)
      )
    );
  end if;

  return jsonb_build_object(
    'authorityApplied', authority_record.id = candidate_record.id,
    'authorityChanged', authority_changed,
    'authoritativeDocumentId', authority_record.id,
    'authoritativeObjectKey', authority_record.storage_path
  );
end
$$;

revoke all on function private.reconcile_licensing_credential_document_authority(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- This pre-protected-upload RPC writes document_path directly and cannot take
-- part in the checksum-verified authority transaction.  No current client uses
-- it; remove its inherited authenticated grant so it cannot bypass the fence.
revoke all on function public.record_licensing_credential_document(uuid, text, text, text, bigint)
  from public, anon, authenticated, service_role;

-- Repair any pointer that was previously rolled back by an out-of-order
-- completion.  The helper records every actual change in the immutable audit
-- stream, and never edits document rows or protected storage objects.
do $licensing_document_authority_backfill$
declare
  winner record;
begin
  for winner in
    select distinct on (document.credential_id)
      document.credential_id,
      document.id
    from public.employee_credential_documents document
    where document.credential_id is not null
      and document.upload_state = 'stored'
      and document.archived_at is null
    order by document.credential_id, document.uploaded_at desc, document.id desc
  loop
    perform private.reconcile_licensing_credential_document_authority(
      winner.credential_id,
      winner.id,
      null,
      'migration_backfill',
      '20261024166000'
    );
  end loop;
end
$licensing_document_authority_backfill$;

-- Interactive completion keeps exact retries successful, but every stored
-- retry also rechecks authority so a lost response can repair a stale pointer
-- without duplicating the upload-completed audit event.
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
  authority_result jsonb := jsonb_build_object(
    'authorityApplied', false,
    'authorityChanged', false,
    'authoritativeDocumentId', null,
    'authoritativeObjectKey', null
  );
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
    if document_record.credential_id is not null then
      authority_result := private.reconcile_licensing_credential_document_authority(
        document_record.credential_id,
        document_record.id,
        target_actor_id,
        'interactive_exact_retry',
        target_request_id::text
      );
    end if;
    return jsonb_build_object(
      'documentId', document_record.id,
      'state', 'stored',
      'uploadedAt', document_record.stored_at
    ) || authority_result;
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
    authority_result := private.reconcile_licensing_credential_document_authority(
      document_record.credential_id,
      document_record.id,
      target_actor_id,
      'interactive_completion',
      target_request_id::text
    );
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
      'requestId', target_request_id,
      'authorityApplied', authority_result -> 'authorityApplied',
      'authoritativeDocumentId', authority_result -> 'authoritativeDocumentId'
    )
  );

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', 'stored',
    'uploadedAt', document_record.stored_at
  ) || authority_result;
end
$$;

-- Scheduled recovery applies the same row-locked winner selection.  Therefore
-- a delayed older recovery can become stored history but cannot roll the
-- credential pointer back from a newer interactive or recovered document.
create or replace function public.service_complete_licensing_document_upload_recovery(
  target_actor_id uuid,
  target_document_id uuid,
  target_object_key text,
  target_byte_size bigint,
  target_checksum text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
  submission public.licensing_submissions%rowtype;
  actor_permissions text[];
  policy_failure text;
  authority_result jsonb := jsonb_build_object(
    'authorityApplied', false,
    'authorityChanged', false,
    'authoritativeDocumentId', null,
    'authoritativeObjectKey', null
  );
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_actor_id is null
    or target_document_id is null
    or nullif(btrim(target_object_key), '') is null
    or target_byte_size is null
    or target_byte_size < 1
    or lower(coalesce(target_checksum, '')) !~ '^[a-f0-9]{64}$'
  then
    raise check_violation using message = 'A complete licensing recovery identity is required.';
  end if;

  select document.* into document_record
  from public.employee_credential_documents document
  where document.id = target_document_id
  for update;

  if not found
    or document_record.uploaded_by is distinct from target_actor_id
    or document_record.storage_path is distinct from target_object_key
    or document_record.byte_size is distinct from target_byte_size
    or document_record.sha256_checksum is distinct from lower(target_checksum)
  then
    raise check_violation using message = 'Licensing recovery identity does not match.';
  end if;
  if document_record.upload_state = 'stored' then
    if document_record.credential_id is not null then
      authority_result := private.reconcile_licensing_credential_document_authority(
        document_record.credential_id,
        document_record.id,
        target_actor_id,
        'scheduled_recovery_exact_retry',
        null
      );
    end if;
    return jsonb_build_object('documentId', document_record.id, 'state', 'stored')
      || authority_result;
  end if;
  if document_record.upload_state <> 'pending' then
    raise check_violation using message = 'Only pending licensing uploads can be recovered.';
  end if;

  if document_record.submission_id is not null then
    select item.* into submission
    from public.licensing_submissions item
    where item.id = document_record.submission_id;
    if not found
      or submission.employee_id <> target_actor_id
      or submission.status not in ('draft', 'correction_required')
    then
      policy_failure := 'The licensing submission is no longer available for this upload.';
    end if;
  else
    actor_permissions := private.employee_effective_permissions(target_actor_id);
    if not (
      'licensing.manage' = any(coalesce(actor_permissions, array[]::text[]))
      or 'directory.edit_credentials' = any(coalesce(actor_permissions, array[]::text[]))
    ) then
      policy_failure := 'The upload actor no longer has Licensing document management permission.';
    end if;
  end if;

  if policy_failure is not null then
    update public.employee_credential_documents document
    set upload_state = 'failed',
        failure_detail = policy_failure,
        archived_at = coalesce(document.archived_at, clock_timestamp()),
        archived_by = coalesce(document.archived_by, target_actor_id),
        archive_reason = 'Protected upload rejected during scheduled recovery',
        cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
        cleanup_last_error = policy_failure,
        cleaned_at = null
    where document.id = document_record.id
    returning * into document_record;

    insert into private.audit_events(
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
    ) values (
      null, target_actor_id, 'public', 'employee_credential_documents',
      'LICENSING_DOCUMENT_UPLOAD_RECOVERY_REJECTED', document_record.id::text,
      jsonb_build_object(
        'failure', policy_failure,
        'credentialId', document_record.credential_id,
        'submissionId', document_record.submission_id,
        'objectKey', document_record.storage_path
      )
    );

    return jsonb_build_object(
      'documentId', document_record.id,
      'state', 'failed',
      'cleanupAllowed', true,
      'bucket', 'credential-documents',
      'objectKey', document_record.storage_path,
      'byteSize', document_record.byte_size,
      'checksum', document_record.sha256_checksum
    );
  end if;

  update public.employee_credential_documents document
  set upload_state = 'stored',
      stored_at = coalesce(document.stored_at, clock_timestamp()),
      archived_at = null,
      archived_by = null,
      archive_reason = null,
      failure_detail = null,
      cleanup_pending_at = null,
      cleanup_last_error = null,
      cleaned_at = null
  where document.id = document_record.id
  returning * into document_record;

  if document_record.credential_id is not null then
    authority_result := private.reconcile_licensing_credential_document_authority(
      document_record.credential_id,
      document_record.id,
      target_actor_id,
      'scheduled_recovery_completion',
      null
    );
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    null, target_actor_id, 'public', 'employee_credential_documents',
    'LICENSING_DOCUMENT_UPLOAD_RECOVERED', document_record.id::text,
    jsonb_build_object(
      'credentialId', document_record.credential_id,
      'submissionId', document_record.submission_id,
      'objectKey', document_record.storage_path,
      'byteSize', document_record.byte_size,
      'checksum', document_record.sha256_checksum,
      'authorityApplied', authority_result -> 'authorityApplied',
      'authoritativeDocumentId', authority_result -> 'authoritativeDocumentId'
    )
  );

  return jsonb_build_object('documentId', document_record.id, 'state', 'stored')
    || authority_result;
end
$$;

revoke all on function public.service_complete_licensing_document_upload(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_complete_licensing_document_upload_recovery(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;

grant execute on function public.service_complete_licensing_document_upload(uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_complete_licensing_document_upload_recovery(uuid, uuid, text, bigint, text)
  to service_role;

notify pgrst, 'reload schema';

commit;

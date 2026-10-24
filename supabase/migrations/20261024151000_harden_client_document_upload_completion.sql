begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A failed database row is not proof that its protected object was removed.
-- Keep cleanup as an explicit durable state so a Worker/storage outage cannot
-- leave an untracked orphan, and so recovery can validate the immutable object
-- identity before every destructive attempt.
alter table public.client_documents
  add column if not exists cleanup_pending_at timestamptz,
  add column if not exists cleanup_last_error text,
  add column if not exists cleanup_attempt_count integer not null default 0,
  add column if not exists cleaned_at timestamptz;

alter table public.client_documents
  drop constraint if exists client_documents_cleanup_attempt_count_check;
alter table public.client_documents
  add constraint client_documents_cleanup_attempt_count_check
  check (cleanup_attempt_count >= 0);

create index if not exists client_documents_cleanup_pending_idx
  on public.client_documents(cleanup_pending_at, id)
  where upload_state = 'failed'
    and cleanup_pending_at is not null
    and cleaned_at is null;

-- An idempotency key identifies the complete upload intent, not merely a file.
-- Serialize preparation for the same key and reject a replay whose actor,
-- client, file evidence, or document metadata differs from the first request.
-- This prevents an ambiguous retry from claiming success while silently
-- returning an older row with different access or retention metadata.
create or replace function public.service_prepare_client_document_upload(
  target_actor_id uuid,
  target_client_id uuid,
  target_upload_request_id uuid,
  target_category text,
  target_title text,
  target_description text,
  target_access_classification text,
  target_portal_state text,
  target_effective_on date,
  target_expires_on date,
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
  existing public.client_documents%rowtype;
  document_id uuid := gen_random_uuid();
  object_path text;
  permissions text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  perform private.require_service_client_permission(target_actor_id, 'clients.documents.manage');
  perform private.require_recent_client_document_mfa(target_mfa_method, target_mfa_verified_at);

  if not exists (
    select 1
    from public.clients client
    where client.id = target_client_id
      and client.archived_at is null
  ) then
    raise no_data_found using message = 'Client File was not found.';
  end if;

  permissions := private.employee_effective_permissions(target_actor_id);
  if target_category in ('proposal', 'contract', 'amendment', 'pricing')
    and not ('clients.contracts.view' = any(coalesce(permissions, array[]::text[])))
  then
    raise insufficient_privilege using message = 'Contract and pricing access is required.';
  end if;

  if target_upload_request_id is null
    or coalesce(target_category, '') not in (
      'proposal', 'contract', 'amendment', 'pricing', 'post_order',
      'insurance', 'correspondence', 'report', 'photo', 'video', 'other'
    )
    or btrim(coalesce(target_title, '')) = ''
    or btrim(coalesce(target_original_filename, '')) = ''
    or coalesce(target_access_classification, '') not in ('confidential', 'restricted', 'highly_restricted')
    or coalesce(target_portal_state, '') not in (
      'internal_only', 'eligible_to_share', 'awaiting_approval',
      'published_to_client', 'withdrawn'
    )
    or coalesce(target_content_type, '') not in (
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    or target_byte_size is null
    or target_byte_size not between 1 and 26214400
    or lower(coalesce(target_sha256_checksum, '')) !~ '^[a-f0-9]{64}$'
    or lower(coalesce(target_extension, '')) not in ('pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'docx', 'xlsx')
  then
    raise check_violation using message = 'Client document metadata is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_upload_request_id::text, 0)
  );

  select document.*
  into existing
  from public.client_documents document
  where document.upload_request_id = target_upload_request_id;

  if found then
    if existing.uploaded_by is distinct from target_actor_id
      or existing.client_id is distinct from target_client_id
      or existing.category is distinct from target_category
      or existing.title is distinct from btrim(target_title)
      or existing.description is distinct from nullif(btrim(target_description), '')
      or existing.access_classification is distinct from target_access_classification
      or existing.portal_state is distinct from target_portal_state
      or existing.effective_on is distinct from target_effective_on
      or existing.expires_on is distinct from target_expires_on
      or existing.original_filename is distinct from btrim(target_original_filename)
      or existing.mime_type is distinct from target_content_type
      or existing.byte_size is distinct from target_byte_size
      or existing.sha256_checksum is distinct from lower(target_sha256_checksum)
      or lower(existing.object_key) not like ('%.' || lower(target_extension))
    then
      raise check_violation using message = 'Upload request ID was already used with different document metadata.';
    end if;

    return jsonb_build_object(
      'documentId', existing.id,
      'bucket', existing.bucket_name,
      'objectKey', existing.object_key,
      'state', existing.upload_state
    );
  end if;

  object_path := target_client_id::text || '/' || document_id::text || '.' || lower(target_extension);
  insert into public.client_documents(
    id,
    client_id,
    category,
    title,
    description,
    access_classification,
    portal_state,
    object_key,
    original_filename,
    mime_type,
    byte_size,
    sha256_checksum,
    upload_request_id,
    effective_on,
    expires_on,
    uploaded_by
  ) values (
    document_id,
    target_client_id,
    target_category,
    btrim(target_title),
    nullif(btrim(target_description), ''),
    target_access_classification,
    target_portal_state,
    object_path,
    btrim(target_original_filename),
    target_content_type,
    target_byte_size,
    lower(target_sha256_checksum),
    target_upload_request_id,
    target_effective_on,
    target_expires_on,
    target_actor_id
  );

  return jsonb_build_object(
    'documentId', document_id,
    'bucket', 'client-documents',
    'objectKey', object_path,
    'state', 'pending'
  );
end
$$;

-- Completion is an idempotent, row-locked state transition. Two Workers may
-- legitimately receive the same idempotency key (for example after a lost
-- response). The second completion must observe the first one's stored row;
-- it must never turn that successful retry into a cleanup candidate.
create or replace function public.service_complete_client_document_upload(
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
  document_record public.client_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select document.*
  into document_record
  from public.client_documents document
  where document.id = target_document_id
  for update;

  if not found then
    raise no_data_found using message = 'Client document upload was not found.';
  end if;
  if document_record.uploaded_by <> target_actor_id then
    raise insufficient_privilege using message = 'The upload actor does not match.';
  end if;

  if document_record.upload_state = 'stored' then
    return jsonb_build_object(
      'documentId', document_record.id,
      'state', 'stored',
      'storedAt', document_record.stored_at
    );
  end if;
  if document_record.upload_state <> 'pending' then
    raise check_violation using message = 'This client document upload cannot be completed.';
  end if;

  -- A committed retry is returned above even if the actor's current role was
  -- changed after the first transaction. Permission is evaluated only for the
  -- pending state transition, never for observing its idempotent result.
  perform private.require_service_client_permission(target_actor_id, 'clients.documents.manage');

  update public.client_documents document
  set upload_state = 'stored',
      stored_at = coalesce(document.stored_at, clock_timestamp()),
      archived_at = null,
      archived_by = null,
      archive_reason = null
  where document.id = document_record.id
  returning * into document_record;

  insert into private.audit_events(
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    null,
    target_actor_id,
    'public',
    'client_documents',
    'CLIENT_DOCUMENT_STORED',
    document_record.id::text,
    jsonb_build_object('requestId', target_request_id)
  );

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', 'stored',
    'storedAt', document_record.stored_at
  );
end
$$;

-- A Worker must receive this row-locked decision before deleting an uploaded
-- object after a deterministic completion rejection. If another request has
-- already committed the row, cleanup is explicitly denied. If this function
-- wins the lock while the row is pending, it makes completion impossible
-- before authorizing cleanup and returns the immutable object identity that
-- the Worker must verify.
create or replace function public.service_reconcile_client_document_upload_failure(
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
  document_record public.client_documents%rowtype;
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
  from public.client_documents document
  where document.id = target_document_id
  for update;

  if not found then
    raise no_data_found using message = 'Client document upload was not found.';
  end if;
  if document_record.uploaded_by <> target_actor_id then
    raise insufficient_privilege using message = 'The upload actor does not match.';
  end if;

  if document_record.upload_state = 'pending' then
    update public.client_documents document
    set upload_state = 'failed',
        archived_at = coalesce(document.archived_at, clock_timestamp()),
        archived_by = coalesce(document.archived_by, target_actor_id),
        archive_reason = clean_failure,
        cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
        cleanup_last_error = clean_failure,
        cleaned_at = null
    where document.id = document_record.id
    returning * into document_record;
    failure_recorded := true;
  elsif document_record.upload_state = 'failed'
    and document_record.cleaned_at is null
  then
    update public.client_documents document
    set cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
        cleanup_last_error = coalesce(document.cleanup_last_error, clean_failure)
    where document.id = document_record.id
    returning * into document_record;
  end if;

  if failure_recorded then
    insert into private.audit_events(
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      null,
      target_actor_id,
      'public',
      'client_documents',
      'CLIENT_DOCUMENT_UPLOAD_FAILED',
      document_record.id::text,
      jsonb_build_object('failure', clean_failure)
    );
  end if;

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', document_record.upload_state,
    'cleanupAllowed', document_record.upload_state = 'failed'
      and document_record.cleaned_at is null,
    'bucket', document_record.bucket_name,
    'objectKey', document_record.object_key,
    'byteSize', document_record.byte_size,
    'checksum', document_record.sha256_checksum,
    'storedAt', document_record.stored_at
  );
end
$$;

create or replace function public.service_defer_client_document_cleanup(
  target_actor_id uuid,
  target_document_id uuid,
  target_bucket text,
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
  document_record public.client_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select document.*
  into document_record
  from public.client_documents document
  where document.id = target_document_id
  for update;

  if not found then
    raise no_data_found using message = 'Client document upload was not found.';
  end if;
  if document_record.uploaded_by <> target_actor_id
    or document_record.bucket_name <> target_bucket
    or document_record.object_key <> target_object_key
    or document_record.byte_size <> target_byte_size
    or document_record.sha256_checksum <> lower(target_checksum)
  then
    raise check_violation using message = 'Client document cleanup identity does not match.';
  end if;
  if document_record.upload_state <> 'failed' then
    raise check_violation using message = 'Only failed client uploads can be cleaned.';
  end if;

  update public.client_documents document
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

create or replace function public.service_complete_client_document_cleanup(
  target_actor_id uuid,
  target_document_id uuid,
  target_bucket text,
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
  document_record public.client_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select document.*
  into document_record
  from public.client_documents document
  where document.id = target_document_id
  for update;

  if not found then
    raise no_data_found using message = 'Client document upload was not found.';
  end if;
  if document_record.uploaded_by <> target_actor_id
    or document_record.bucket_name <> target_bucket
    or document_record.object_key <> target_object_key
    or document_record.byte_size <> target_byte_size
    or document_record.sha256_checksum <> lower(target_checksum)
  then
    raise check_violation using message = 'Client document cleanup identity does not match.';
  end if;
  if document_record.upload_state <> 'failed' then
    raise check_violation using message = 'Only failed client uploads can be cleaned.';
  end if;

  update public.client_documents document
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

-- Recovery only lists stale pending rows. The Worker verifies the exact object
-- identity, byte length, and SHA-256 before calling the row-locked completion
-- transition. A missing object is failed through the same locked reconciliation
-- RPC; mismatches and unavailable storage remain pending for manual review.
create or replace function public.service_list_client_document_upload_recovery(
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
    'bucket', document.bucket_name,
    'objectKey', document.object_key,
    'sizeBytes', document.byte_size,
    'checksum', document.sha256_checksum,
    'state', document.upload_state,
    'createdAt', document.created_at
  ) order by document.created_at, document.id), '[]'::jsonb)
  from (
    select pending.*
    from public.client_documents pending
    where pending.upload_state = 'pending'
      and pending.created_at <= clock_timestamp() - interval '15 minutes'
    order by pending.created_at, pending.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) document
  where (select auth.role()) = 'service_role'
$$;

create or replace function public.service_list_client_document_cleanup_recovery(
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
    'bucket', document.bucket_name,
    'objectKey', document.object_key,
    'sizeBytes', document.byte_size,
    'checksum', document.sha256_checksum,
    'state', document.upload_state,
    'cleanupPendingAt', document.cleanup_pending_at,
    'cleanupAttemptCount', document.cleanup_attempt_count
  ) order by document.cleanup_pending_at, document.id), '[]'::jsonb)
  from (
    select failed.*
    from public.client_documents failed
    where failed.upload_state = 'failed'
      and failed.cleanup_pending_at is not null
      and failed.cleaned_at is null
    order by failed.cleanup_pending_at, failed.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) document
  where (select auth.role()) = 'service_role'
$$;

revoke all on function public.service_complete_client_document_upload(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_reconcile_client_document_upload_failure(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_list_client_document_upload_recovery(integer)
  from public, anon, authenticated;
revoke all on function public.service_defer_client_document_cleanup(uuid, uuid, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_client_document_cleanup(uuid, uuid, text, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_list_client_document_cleanup_recovery(integer)
  from public, anon, authenticated;

grant execute on function public.service_complete_client_document_upload(uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_reconcile_client_document_upload_failure(uuid, uuid, text)
  to service_role;
grant execute on function public.service_list_client_document_upload_recovery(integer)
  to service_role;
grant execute on function public.service_defer_client_document_cleanup(uuid, uuid, text, text, bigint, text, text)
  to service_role;
grant execute on function public.service_complete_client_document_cleanup(uuid, uuid, text, text, bigint, text)
  to service_role;
grant execute on function public.service_list_client_document_cleanup_recovery(integer)
  to service_role;

commit;

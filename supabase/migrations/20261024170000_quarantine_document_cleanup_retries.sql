begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Client and Licensing cleanup retains the original failure timestamp for
-- audit, while available_at controls fair retry scheduling. Quarantine means
-- automatic attempts stopped; it never means the protected object was deleted.
alter table public.client_documents
  add column if not exists cleanup_available_at timestamptz,
  add column if not exists cleanup_quarantined_at timestamptz;
alter table public.employee_credential_documents
  add column if not exists cleanup_available_at timestamptz,
  add column if not exists cleanup_quarantined_at timestamptz;

update public.client_documents document
set cleanup_quarantined_at = coalesce(document.cleanup_quarantined_at, clock_timestamp()),
    cleanup_available_at = null,
    cleanup_last_error = coalesce(document.cleanup_last_error, 'Client document cleanup exceeded the automatic retry limit.')
where document.upload_state = 'failed'
  and document.cleanup_pending_at is not null
  and document.cleaned_at is null
  and document.cleanup_attempt_count >= 20;

update public.employee_credential_documents document
set cleanup_quarantined_at = coalesce(document.cleanup_quarantined_at, clock_timestamp()),
    cleanup_available_at = null,
    cleanup_last_error = coalesce(document.cleanup_last_error, 'Licensing document cleanup exceeded the automatic retry limit.')
where document.upload_state = 'failed'
  and document.cleanup_pending_at is not null
  and document.cleaned_at is null
  and document.cleanup_attempt_count >= 20;

alter table public.client_documents
  drop constraint if exists client_documents_cleanup_attempt_count_check;
alter table public.client_documents
  add constraint client_documents_cleanup_attempt_count_check
  check (cleanup_attempt_count >= 0);
alter table public.employee_credential_documents
  drop constraint if exists employee_credential_documents_cleanup_attempt_count_check;
alter table public.employee_credential_documents
  add constraint employee_credential_documents_cleanup_attempt_count_check
  check (cleanup_attempt_count >= 0);

drop index if exists public.client_documents_cleanup_pending_idx;
create index client_documents_cleanup_pending_idx
  on public.client_documents (coalesce(cleanup_available_at, cleanup_pending_at), id)
  where upload_state = 'failed'
    and cleanup_pending_at is not null
    and cleanup_quarantined_at is null
    and cleaned_at is null
    and cleanup_attempt_count < 20;

drop index if exists public.employee_credential_documents_cleanup_pending_idx;
create index employee_credential_documents_cleanup_pending_idx
  on public.employee_credential_documents (coalesce(cleanup_available_at, cleanup_pending_at), id)
  where upload_state = 'failed'
    and cleanup_pending_at is not null
    and cleanup_quarantined_at is null
    and cleaned_at is null
    and cleanup_attempt_count < 20;

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
  next_attempt integer;
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
  if document_record.cleaned_at is not null then
    return jsonb_build_object(
      'documentId', document_record.id,
      'state', document_record.upload_state,
      'cleanupPending', false,
      'cleanupQuarantined', false,
      'cleanupAttemptCount', document_record.cleanup_attempt_count
    );
  end if;

  next_attempt := case
    when document_record.cleanup_attempt_count >= 20 then document_record.cleanup_attempt_count
    else document_record.cleanup_attempt_count + 1
  end;

  update public.client_documents document
  set cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
      cleanup_attempt_count = next_attempt,
      cleanup_available_at = case
        when next_attempt >= 20 then null
        else clock_timestamp() + make_interval(secs => case
          when next_attempt <= 1 then 30
          when next_attempt = 2 then 60
          when next_attempt = 3 then 120
          when next_attempt = 4 then 240
          when next_attempt = 5 then 480
          when next_attempt = 6 then 960
          when next_attempt = 7 then 1920
          else 3600
        end)
      end,
      cleanup_quarantined_at = case
        when next_attempt >= 20 then coalesce(document.cleanup_quarantined_at, clock_timestamp())
        else null
      end,
      cleanup_last_error = left(btrim(coalesce(target_error, 'Storage cleanup deferred.')), 1000)
  where document.id = document_record.id
  returning * into document_record;

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', document_record.upload_state,
    'cleanupPending', document_record.cleaned_at is null,
    'cleanupQuarantined', document_record.cleanup_quarantined_at is not null,
    'cleanupAttemptCount', document_record.cleanup_attempt_count,
    'cleanupAvailableAt', document_record.cleanup_available_at
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

  select document.* into document_record
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
      cleanup_available_at = null,
      cleanup_quarantined_at = null,
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
    'cleanupAvailableAt', coalesce(document.cleanup_available_at, document.cleanup_pending_at),
    'cleanupAttemptCount', document.cleanup_attempt_count
  ) order by coalesce(document.cleanup_available_at, document.cleanup_pending_at), document.id), '[]'::jsonb)
  from (
    select failed.*
    from public.client_documents failed
    where failed.upload_state = 'failed'
      and failed.cleanup_pending_at is not null
      and failed.cleanup_quarantined_at is null
      and failed.cleanup_attempt_count < 20
      and coalesce(failed.cleanup_available_at, failed.cleanup_pending_at) <= clock_timestamp()
      and failed.cleaned_at is null
    order by coalesce(failed.cleanup_available_at, failed.cleanup_pending_at), failed.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) document
  where (select auth.role()) = 'service_role'
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
  next_attempt integer;
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
  if document_record.cleaned_at is not null then
    return jsonb_build_object(
      'documentId', document_record.id,
      'state', document_record.upload_state,
      'cleanupPending', false,
      'cleanupQuarantined', false,
      'cleanupAttemptCount', document_record.cleanup_attempt_count
    );
  end if;

  next_attempt := case
    when document_record.cleanup_attempt_count >= 20 then document_record.cleanup_attempt_count
    else document_record.cleanup_attempt_count + 1
  end;

  update public.employee_credential_documents document
  set cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
      cleanup_attempt_count = next_attempt,
      cleanup_available_at = case
        when next_attempt >= 20 then null
        else clock_timestamp() + make_interval(secs => case
          when next_attempt <= 1 then 30
          when next_attempt = 2 then 60
          when next_attempt = 3 then 120
          when next_attempt = 4 then 240
          when next_attempt = 5 then 480
          when next_attempt = 6 then 960
          when next_attempt = 7 then 1920
          else 3600
        end)
      end,
      cleanup_quarantined_at = case
        when next_attempt >= 20 then coalesce(document.cleanup_quarantined_at, clock_timestamp())
        else null
      end,
      cleanup_last_error = left(btrim(coalesce(target_error, 'Storage cleanup deferred.')), 1000)
  where document.id = document_record.id
  returning * into document_record;

  return jsonb_build_object(
    'documentId', document_record.id,
    'state', document_record.upload_state,
    'cleanupPending', document_record.cleaned_at is null,
    'cleanupQuarantined', document_record.cleanup_quarantined_at is not null,
    'cleanupAttemptCount', document_record.cleanup_attempt_count,
    'cleanupAvailableAt', document_record.cleanup_available_at
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
      cleanup_available_at = null,
      cleanup_quarantined_at = null,
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
    'cleanupAvailableAt', coalesce(document.cleanup_available_at, document.cleanup_pending_at),
    'cleanupAttemptCount', document.cleanup_attempt_count
  ) order by coalesce(document.cleanup_available_at, document.cleanup_pending_at), document.id), '[]'::jsonb)
  from (
    select failed.*
    from public.employee_credential_documents failed
    where failed.upload_state = 'failed'
      and failed.cleanup_pending_at is not null
      and failed.cleanup_quarantined_at is null
      and failed.cleanup_attempt_count < 20
      and coalesce(failed.cleanup_available_at, failed.cleanup_pending_at) <= clock_timestamp()
      and failed.cleaned_at is null
    order by coalesce(failed.cleanup_available_at, failed.cleanup_pending_at), failed.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) document
  where (select auth.role()) = 'service_role'
$$;

revoke all on function public.service_defer_client_document_cleanup(uuid, uuid, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_client_document_cleanup(uuid, uuid, text, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_list_client_document_cleanup_recovery(integer)
  from public, anon, authenticated;
revoke all on function public.service_defer_licensing_document_cleanup(uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_licensing_document_cleanup(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_list_licensing_document_cleanup_recovery(integer)
  from public, anon, authenticated;

grant execute on function public.service_defer_client_document_cleanup(uuid, uuid, text, text, bigint, text, text)
  to service_role;
grant execute on function public.service_complete_client_document_cleanup(uuid, uuid, text, text, bigint, text)
  to service_role;
grant execute on function public.service_list_client_document_cleanup_recovery(integer)
  to service_role;
grant execute on function public.service_defer_licensing_document_cleanup(uuid, uuid, text, bigint, text, text)
  to service_role;
grant execute on function public.service_complete_licensing_document_cleanup(uuid, uuid, text, bigint, text)
  to service_role;
grant execute on function public.service_list_licensing_document_cleanup_recovery(integer)
  to service_role;

comment on column public.client_documents.cleanup_quarantined_at is
  'When automatic cleanup retries stopped without claiming the client object was deleted.';
comment on column public.employee_credential_documents.cleanup_quarantined_at is
  'When automatic cleanup retries stopped without claiming the licensing object was deleted.';

commit;

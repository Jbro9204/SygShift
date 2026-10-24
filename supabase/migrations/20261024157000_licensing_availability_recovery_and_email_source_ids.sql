begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists employee_credential_documents_pending_recovery_idx
  on public.employee_credential_documents(uploaded_at, id)
  where upload_state = 'pending';

create or replace function public.service_list_licensing_document_availability_recovery(
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
    'checksum', document.sha256_checksum
  ) order by document.uploaded_at, document.id), '[]'::jsonb)
  from (
    select pending.*
    from public.employee_credential_documents pending
    where pending.upload_state = 'pending'
      and pending.uploaded_at <= clock_timestamp() - interval '2 minutes'
    order by pending.uploaded_at, pending.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) document
  where (select auth.role()) = 'service_role'
$$;

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
    return jsonb_build_object('documentId', document_record.id, 'state', 'stored');
  end if;
  if document_record.upload_state <> 'pending' then
    raise check_violation using message = 'Only pending licensing uploads can be recovered.';
  end if;

  -- Scheduled recovery is a delayed completion of the original upload, not a
  -- privileged bypass. Re-evaluate the same ownership/status/permission rules
  -- used by the interactive completion boundary while the document is locked.
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
    update public.employee_credentials credential
    set document_path = document_record.storage_path,
        updated_at = clock_timestamp()
    where credential.id = document_record.credential_id;
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
      'checksum', document_record.sha256_checksum
    )
  );

  return jsonb_build_object('documentId', document_record.id, 'state', 'stored');
end
$$;

create or replace function public.service_fail_licensing_document_upload_recovery(
  target_actor_id uuid,
  target_document_id uuid,
  target_object_key text,
  target_byte_size bigint,
  target_checksum text,
  target_failure_detail text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  document_record public.employee_credential_documents%rowtype;
  clean_failure text := left(btrim(coalesce(target_failure_detail, 'Protected storage verification failed.')), 1000);
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
    raise check_violation using message = 'A stored licensing document cannot be failed by recovery.';
  end if;
  if document_record.upload_state not in ('pending', 'failed') then
    raise check_violation using message = 'This licensing upload cannot be failed by recovery.';
  end if;

  update public.employee_credential_documents document
  set upload_state = 'failed',
      failure_detail = clean_failure,
      archived_at = coalesce(document.archived_at, clock_timestamp()),
      archived_by = coalesce(document.archived_by, target_actor_id),
      archive_reason = 'Protected upload failed scheduled verification',
      cleanup_pending_at = coalesce(document.cleanup_pending_at, clock_timestamp()),
      cleanup_last_error = clean_failure,
      cleaned_at = null
  where document.id = document_record.id
  returning * into document_record;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    null, target_actor_id, 'public', 'employee_credential_documents',
    'LICENSING_DOCUMENT_UPLOAD_RECOVERY_FAILED', document_record.id::text,
    jsonb_build_object('failure', clean_failure, 'objectKey', document_record.storage_path)
  );

  return jsonb_build_object('documentId', document_record.id, 'state', 'failed');
end
$$;

-- Return the immutable claim-row identity so email dispatch fencing is tied to
-- the recovery claim, never the transport request that happened to carry it.
create or replace function public.service_get_password_reset_claim_source(target_request_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_id uuid;
  current_request private.employee_self_service_password_reset_requests%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select request.* into current_request
  from private.employee_self_service_password_reset_requests request
  where request.request_id = nullif(btrim(target_request_id), '')
  order by request.requested_at desc, request.id desc
  limit 1;
  if not found or current_request.outcome <> 'claimed' then
    return null;
  end if;

  -- Follow the full retry chain, not only the current row's direct five-minute
  -- lookback. Otherwise A -> B -> C could fence B to A while C incorrectly
  -- starts a second delivery operation once A leaves C's direct window.
  with recursive claim_chain(id, requested_at) as (
    select current_request.id, current_request.requested_at
    union
    select request.id, request.requested_at
    from private.employee_self_service_password_reset_requests request
    join claim_chain later
      on request.requested_at between later.requested_at - interval '5 minutes'
        and later.requested_at
     and (request.requested_at, request.id) < (later.requested_at, later.id)
    where request.outcome = 'claimed'
      and request.employee_id = current_request.employee_id
      and request.username_hash = current_request.username_hash
      and request.request_fingerprint_hash = current_request.request_fingerprint_hash
  )
  select claim_chain.id into source_id
  from claim_chain
  order by claim_chain.requested_at, claim_chain.id
  limit 1;
  return source_id;
end
$$;

create or replace function public.service_get_username_recovery_claim_source(target_request_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_id uuid;
  current_request private.employee_self_service_username_requests%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select request.* into current_request
  from private.employee_self_service_username_requests request
  where request.request_id = nullif(btrim(target_request_id), '')
  order by request.requested_at desc, request.id desc
  limit 1;
  if not found or current_request.outcome <> 'claimed' then
    return null;
  end if;

  with recursive claim_chain(id, requested_at) as (
    select current_request.id, current_request.requested_at
    union
    select request.id, request.requested_at
    from private.employee_self_service_username_requests request
    join claim_chain later
      on request.requested_at between later.requested_at - interval '5 minutes'
        and later.requested_at
     and (request.requested_at, request.id) < (later.requested_at, later.id)
    where request.outcome = 'claimed'
      and request.employee_id = current_request.employee_id
      and request.email_hash = current_request.email_hash
      and request.request_fingerprint_hash = current_request.request_fingerprint_hash
  )
  select claim_chain.id into source_id
  from claim_chain
  order by claim_chain.requested_at, claim_chain.id
  limit 1;
  return source_id;
end
$$;

-- A verification request is a recoverable domain operation, not an HTTP
-- request. The Worker derives the raw link token from protected key material
-- and this immutable operation binding; Postgres stores only its SHA-256
-- fingerprint. A response-lost retry can therefore reconstruct the same link
-- without persisting plaintext token material or replacing the live token.
alter table private.employee_email_verifications
  add column operation_id uuid,
  add column purpose text,
  add column superseded_at timestamptz;

update private.employee_email_verifications
set operation_id = id,
    purpose = 'personal_email_verification'
where operation_id is null or purpose is null;

-- Older implementations normally retained only one pending row, but repair
-- any historical overlap before enforcing a single authoritative operation.
with ranked_pending as (
  select verification.id,
         row_number() over (
           partition by verification.employee_id
           order by verification.created_at desc, verification.id desc
         ) as authority_rank
  from private.employee_email_verifications verification
  where verification.verified_at is null
    and verification.superseded_at is null
)
update private.employee_email_verifications verification
set superseded_at = clock_timestamp()
from ranked_pending
where ranked_pending.id = verification.id
  and ranked_pending.authority_rank > 1;

alter table private.employee_email_verifications
  alter column operation_id set not null,
  alter column purpose set not null,
  add constraint employee_email_verifications_purpose
    check (purpose = 'personal_email_verification');

create unique index employee_email_verifications_operation_idx
  on private.employee_email_verifications(operation_id);

create unique index employee_email_verifications_current_employee_idx
  on private.employee_email_verifications(employee_id)
  where verified_at is null and superseded_at is null;

create index employee_email_verifications_employee_history_idx
  on private.employee_email_verifications(employee_id, created_at desc);

create or replace function private.protect_employee_email_verification_binding()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'Email verification operation history cannot be deleted.';
  end if;
  if new.operation_id is distinct from old.operation_id
    or new.employee_id is distinct from old.employee_id
    or new.requested_email is distinct from old.requested_email
    or new.purpose is distinct from old.purpose
    or new.token_hash is distinct from old.token_hash
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
  then
    raise check_violation using message = 'Email verification operation bindings are immutable.';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise check_violation using message = 'Superseded email verification operations cannot become current again.';
  end if;
  if old.superseded_at is null
    and new.superseded_at is not null
    and new.superseded_at < old.created_at
  then
    raise check_violation using message = 'Email verification supersession time is invalid.';
  end if;
  return new;
end
$$;

create trigger employee_email_verification_binding_immutable
before update or delete on private.employee_email_verifications
for each row execute function private.protect_employee_email_verification_binding();

revoke all on function private.protect_employee_email_verification_binding()
  from public, anon, authenticated, service_role;

-- Retire the response-loss-vulnerable overload during mixed-version cutover.
-- A stale Worker fails closed at RPC lookup instead of inserting a row that
-- lacks a durable operation identity.
drop function if exists public.service_create_email_verification(uuid, text, text, timestamptz);
drop function if exists public.service_create_email_verification_operation(uuid, text, text, timestamptz);

create or replace function public.service_confirm_email_verification(
  target_token_hash text,
  target_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed_at timestamptz;
  verification private.employee_email_verifications%rowtype;
begin
  if current_user <> 'service_role' and (select auth.role()) <> 'service_role' then
    raise insufficient_privilege;
  end if;

  select * into verification
  from private.employee_email_verifications item
  where item.token_hash = target_token_hash
    and item.superseded_at is null
  for update;

  if verification.id is null then
    raise exception using message = 'This verification link is invalid or has expired.';
  end if;
  if verification.employee_id <> target_employee_id then
    raise insufficient_privilege using message = 'Sign in to the account that requested this email change.';
  end if;
  if verification.verified_at is not null then
    return jsonb_build_object(
      'employeeId', verification.employee_id,
      'email', verification.requested_email,
      'replayed', true,
      'verifiedAt', verification.verified_at
    );
  end if;
  if verification.expires_at <= now() then
    raise exception using message = 'This verification link is invalid or has expired.';
  end if;

  completed_at := clock_timestamp();

  insert into private.employee_contacts (
    employee_id, personal_email, personal_email_verified_at
  ) values (
    verification.employee_id, verification.requested_email, completed_at
  )
  on conflict (employee_id) do update
  set personal_email = excluded.personal_email,
      personal_email_verified_at = excluded.personal_email_verified_at,
      updated_at = clock_timestamp();

  update private.employee_email_verifications
  set verified_at = completed_at
  where id = verification.id;

  insert into private.audit_events (
    employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    verification.employee_id, 'private', 'employee_contacts', 'personal_email_verified',
    verification.employee_id::text,
    jsonb_build_object('verified', false),
    jsonb_build_object('emailChanged', true, 'verified', true)
  );

  return jsonb_build_object(
    'employeeId', verification.employee_id,
    'email', verification.requested_email,
    'replayed', false,
    'verifiedAt', completed_at
  );
end
$$;

create or replace function public.service_create_email_verification_operation(
  target_operation_id uuid,
  target_employee_id uuid,
  target_email text,
  target_purpose text,
  target_token_hash text,
  target_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_email text := lower(btrim(coalesce(target_email, '')));
  clean_purpose text := btrim(coalesce(target_purpose, ''));
  operation_record private.employee_email_verifications%rowtype;
  replayed boolean := false;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_operation_id is null or target_employee_id is null then
    raise check_violation using message = 'Verification operation and employee identities are required.';
  end if;
  if clean_email = '' or length(clean_email) > 254 or position('@' in clean_email) <= 1 then
    raise check_violation using message = 'A valid verification recipient is required.';
  end if;
  if clean_purpose <> 'personal_email_verification' then
    raise check_violation using message = 'Unsupported email verification purpose.';
  end if;
  if coalesce(target_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'A valid verification token fingerprint is required.';
  end if;
  if target_expires_at is null or target_expires_at <= clock_timestamp() then
    raise check_violation using message = 'A future verification expiration is required.';
  end if;

  -- The operation lock makes UUID reuse with different binding fail
  -- deterministically even when two employees submit the same UUID at once.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'employee-email-verification-operation:' || target_operation_id::text,
      0
    )
  );
  -- The employee lock serializes the cooldown, replacement, and insert across
  -- distinct operation ids. Locks are always acquired operation then employee.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'employee-email-verification:' || target_employee_id::text,
      0
    )
  );

  select verification.* into operation_record
  from private.employee_email_verifications verification
  where verification.operation_id = target_operation_id
  for update;

  if found then
    if operation_record.employee_id is distinct from target_employee_id
      or operation_record.requested_email is distinct from clean_email
      or operation_record.purpose is distinct from clean_purpose
      or operation_record.token_hash is distinct from target_token_hash
    then
      raise check_violation using message = 'Verification operation does not match its original binding.';
    end if;
    if operation_record.superseded_at is not null then
      raise check_violation using message = 'Verification operation was superseded by a newer request.';
    end if;
    if operation_record.verified_at is not null then
      raise check_violation using message = 'Verification operation is already complete.';
    end if;
    if operation_record.expires_at <= clock_timestamp() then
      raise check_violation using message = 'Verification operation has expired.';
    end if;
    replayed := true;
  else
  if exists (
    select 1 from private.employee_email_verifications verification
    where verification.employee_id = target_employee_id
      and verification.verified_at is null
      and verification.superseded_at is null
      and verification.created_at > clock_timestamp() - interval '1 minute'
  ) then
    raise check_violation using message = 'A verification email was sent recently. Wait one minute and try again.';
  end if;

  -- Retain the old operation as an immutable tombstone. A delayed replay of
  -- its UUID can never become current again or invalidate the newer token.
  update private.employee_email_verifications
  set superseded_at = clock_timestamp()
  where employee_id = target_employee_id
    and verified_at is null
    and superseded_at is null;

  insert into private.employee_email_verifications(
      operation_id, employee_id, requested_email, purpose, token_hash, expires_at
  ) values (
      target_operation_id, target_employee_id, clean_email, clean_purpose,
      target_token_hash, target_expires_at
    ) returning * into operation_record;
  end if;

  return jsonb_build_object(
    'employeeId', operation_record.employee_id,
    'expiresAt', operation_record.expires_at,
    'operationId', operation_record.operation_id,
    'purpose', operation_record.purpose,
    'replayed', replayed,
    'requestedEmail', operation_record.requested_email,
    'verificationId', operation_record.id
  );
end
$$;

revoke all on function public.service_list_licensing_document_availability_recovery(integer)
  from public, anon, authenticated;
revoke all on function public.service_complete_licensing_document_upload_recovery(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_fail_licensing_document_upload_recovery(uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_get_password_reset_claim_source(text)
  from public, anon, authenticated;
revoke all on function public.service_get_username_recovery_claim_source(text)
  from public, anon, authenticated;
revoke all on function public.service_create_email_verification_operation(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.service_confirm_email_verification(text, uuid)
  from public, anon, authenticated;

grant execute on function public.service_list_licensing_document_availability_recovery(integer) to service_role;
grant execute on function public.service_complete_licensing_document_upload_recovery(uuid, uuid, text, bigint, text) to service_role;
grant execute on function public.service_fail_licensing_document_upload_recovery(uuid, uuid, text, bigint, text, text) to service_role;
grant execute on function public.service_get_password_reset_claim_source(text) to service_role;
grant execute on function public.service_get_username_recovery_claim_source(text) to service_role;
grant execute on function public.service_create_email_verification_operation(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.service_confirm_email_verification(text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;

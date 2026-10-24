begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A document version is not authoritative until its protected object has been
-- verified and the upload completion transaction commits. Preserve the
-- predecessor on the durable operation so failed or overlapping replacements
-- cannot hide the last known-good document.
alter table private.hr_document_upload_operations
  add column if not exists prior_current_version_id uuid
    references private.hr_document_versions(id) on delete restrict,
  add column if not exists authority_intent_bound boolean not null default false,
  add column if not exists authority_superseded boolean not null default false;

-- Recover the predecessor for operations created before this migration only
-- when the candidate still owns the current pointer. A candidate that has
-- already lost that pointer is superseded, not a replacement of the winner.
with recovered as (
  select
    operation.id,
    case
      when document.current_version_id is not distinct from operation.version_id then (
        select candidate.id
        from private.hr_document_versions candidate
        where candidate.document_id = operation.document_id
          and candidate.version_number < operation_version.version_number
          and (
            exists (
              select 1
              from private.hr_document_access_events access_event
              where access_event.version_id = candidate.id
                and access_event.action = 'upload_available'
            )
            or exists (
              select 1
              from private.signature_audit_certificates certificate
              where certificate.final_document_version_id = candidate.id
            )
            or (
              select scan.state
              from private.hr_document_scan_events scan
              where scan.version_id = candidate.id
              order by scan.scanned_at desc, scan.id desc
              limit 1
            ) = 'clean'
          )
        order by candidate.version_number desc, candidate.id desc
        limit 1
      )
      else null
    end as prior_current_version_id,
    document.current_version_id as observed_current_version_id
  from private.hr_document_upload_operations operation
  join private.hr_document_versions operation_version
    on operation_version.id = operation.version_id
   and operation_version.document_id = operation.document_id
  join private.hr_documents document
    on document.id = operation.document_id
)
update private.hr_document_upload_operations operation
set prior_current_version_id = recovered.prior_current_version_id,
    authority_intent_bound = true,
    authority_superseded = recovered.observed_current_version_id is distinct from operation.version_id,
    state = case
      when recovered.observed_current_version_id is distinct from operation.version_id
        and operation.state not in ('clean', 'rejected', 'cancelled')
        then 'rejected'
      else operation.state
    end,
    failure_code = case
      when recovered.observed_current_version_id is distinct from operation.version_id
        and operation.state not in ('clean', 'rejected', 'cancelled')
        then 'authority_superseded'
      else operation.failure_code
    end,
    failure_detail = case
      when recovered.observed_current_version_id is distinct from operation.version_id
        and operation.state not in ('clean', 'rejected', 'cancelled')
        then 'A newer verified document version already owns the authority slot.'
      else operation.failure_detail
    end
from recovered
where operation.id = recovered.id;

-- Historical candidates that no longer own the current pointer are permanently
-- superseded. They must never reinterpret the newer current version as their
-- predecessor and later CAS-downgrade the document.
do $$
begin
  if exists (
    select 1
    from private.hr_document_upload_operations operation
    join private.hr_documents document on document.id = operation.document_id
    where operation.authority_intent_bound
      and document.current_version_id is distinct from operation.version_id
      and not operation.authority_superseded
  ) then
    raise exception 'Historical HR upload authority could not be fenced from a newer current version.';
  end if;
  if exists (
    select 1
    from private.hr_document_upload_operations operation
    where operation.authority_superseded
      and operation.state not in ('clean', 'rejected', 'cancelled')
  ) then
    raise exception 'A superseded HR upload remained eligible for automatic recovery.';
  end if;
end
$$;

-- A pre-cutover failed/incomplete upload may already have displaced the prior
-- current version. Restore only the exact candidate pointer; never overwrite a
-- later version that won a separate transaction.
update private.hr_documents document
set current_version_id = operation.prior_current_version_id,
    updated_at = clock_timestamp()
from private.hr_document_upload_operations operation
where document.id = operation.document_id
  and document.current_version_id = operation.version_id
  and operation.state <> 'clean'
  and private.hr_document_latest_availability_state(operation.version_id) is distinct from 'clean'
  and operation.authority_intent_bound;

-- Pre-cutover first uploads were exposed as empty shells after their eager
-- candidate pointer was restored to null. Hide those shells behind the normal
-- archive filter until an exact retry verifies the protected object.
update private.hr_documents document
set archived_at = coalesce(document.archived_at, clock_timestamp()),
    archived_by = coalesce(document.archived_by, operation.actor_employee_id),
    archive_reason = coalesce(
      document.archive_reason,
      'Upload pending protected storage verification.'
    ),
    updated_at = clock_timestamp()
from private.hr_document_upload_operations operation
where document.id = operation.document_id
  and document.current_version_id is null
  and operation.prior_current_version_id is null
  and operation.state <> 'clean'
  and private.hr_document_latest_availability_state(operation.version_id) is distinct from 'clean'
  and not operation.authority_superseded
  and operation.authority_intent_bound
  and (
    document.archived_at is null
    or (
      document.archived_by = operation.actor_employee_id
      and document.archive_reason = 'Upload pending protected storage verification.'
    )
  );

create or replace function private.hr_document_upload_transition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean := false;
begin
  if new.actor_employee_id <> old.actor_employee_id
    or new.document_id <> old.document_id
    or new.version_id <> old.version_id
    or new.vault_code <> old.vault_code
    or new.storage_bucket <> old.storage_bucket
    or new.object_key <> old.object_key
    or new.idempotency_key <> old.idempotency_key
    or (
      old.upload_intent is not null
      and new.upload_intent is distinct from old.upload_intent
    )
    or (
      old.authority_intent_bound
      and (
        not new.authority_intent_bound
        or new.prior_current_version_id is distinct from old.prior_current_version_id
        or (
          new.authority_superseded is distinct from old.authority_superseded
          and not (
            not old.authority_superseded
            and new.authority_superseded
            and new.state = 'rejected'
            and new.failure_code = 'authority_superseded'
          )
        )
      )
    )
  then
    raise check_violation using message = 'Document upload identity fields are immutable.';
  end if;

  allowed := case old.state
    when 'initialized' then new.state in ('quarantined', 'stored', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'quarantined' then new.state in ('stored', 'clean', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'stored' then new.state in ('scan_pending', 'clean', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'scan_pending' then new.state in ('clean', 'scan_error', 'storage_error', 'rejected', 'cancelled')
    when 'scan_error' then new.state in ('stored', 'scan_pending', 'clean', 'storage_error', 'rejected', 'cancelled')
    when 'storage_error' then new.state in ('stored', 'clean', 'rejected', 'cancelled')
    else false
  end;

  if new.state <> old.state and not allowed then
    raise check_violation using message = format(
      'Invalid document upload transition: %s to %s.',
      old.state,
      new.state
    );
  end if;
  if new.state = old.state
    and row(new.failure_code, new.failure_detail)
      is distinct from row(old.failure_code, old.failure_detail)
  then
    raise check_violation using message = 'Upload failure details cannot be changed without a state transition.';
  end if;

  new.updated_at := clock_timestamp();
  if new.state = 'quarantined' then
    new.quarantined_at := coalesce(new.quarantined_at, clock_timestamp());
  end if;
  if new.state = 'stored' then
    new.stored_at := coalesce(new.stored_at, clock_timestamp());
  end if;
  if new.state = 'scan_pending' then
    new.scan_requested_at := clock_timestamp();
  end if;
  if new.state in ('clean', 'rejected', 'cancelled') then
    new.completed_at := coalesce(new.completed_at, clock_timestamp());
  end if;
  return new;
end
$$;

-- Retain the fully validated/idempotent implementation from the preceding
-- migration as a private core, then wrap it with the authority fence. Moving
-- the existing function preserves its implementation and avoids maintaining a
-- divergent copy of the metadata validation rules.
alter function public.service_begin_hr_document_upload(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) set schema private;

alter function private.service_begin_hr_document_upload(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) rename to service_begin_hr_document_upload_pre_authority_fence;

revoke all on function private.service_begin_hr_document_upload_pre_authority_fence(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) from public, anon, authenticated, service_role;

create function public.service_begin_hr_document_upload(
  target_actor_id uuid,
  target_employee_id uuid,
  target_document_id uuid,
  target_vault_code text,
  target_title text,
  target_category text,
  target_description text,
  target_access_classification text,
  target_original_filename text,
  target_sanitized_filename text,
  target_extension text,
  target_declared_mime_type text,
  target_detected_mime_type text,
  target_size_bytes bigint,
  target_sha256_checksum text,
  target_idempotency_key uuid,
  target_request_id text default null,
  target_replacement_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  existing_operation_id uuid;
  result_operation_id uuid;
  result_document_id uuid;
  result_version_id uuid;
  predecessor_id uuid;
  operation_already_bound boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  -- Existing operations already carry their original authority intent. The
  -- private core remains responsible for exact request-intent comparison.
  select operation.id
  into existing_operation_id
  from private.hr_document_upload_operations operation
  where operation.idempotency_key = target_idempotency_key
  for update;

  if existing_operation_id is not null then
    return private.service_begin_hr_document_upload_pre_authority_fence(
      target_actor_id,
      target_employee_id,
      target_document_id,
      target_vault_code,
      target_title,
      target_category,
      target_description,
      target_access_classification,
      target_original_filename,
      target_sanitized_filename,
      target_extension,
      target_declared_mime_type,
      target_detected_mime_type,
      target_size_bytes,
      target_sha256_checksum,
      target_idempotency_key,
      target_request_id,
      target_replacement_reason
    );
  end if;

  if target_document_id is not null then
    select document.current_version_id
    into predecessor_id
    from private.hr_documents document
    where document.id = target_document_id
    for update;
    if not found then
      raise no_data_found using message = 'The document was not found.';
    end if;
  end if;

  result := private.service_begin_hr_document_upload_pre_authority_fence(
    target_actor_id,
    target_employee_id,
    target_document_id,
    target_vault_code,
    target_title,
    target_category,
    target_description,
    target_access_classification,
    target_original_filename,
    target_sanitized_filename,
    target_extension,
    target_declared_mime_type,
    target_detected_mime_type,
    target_size_bytes,
    target_sha256_checksum,
    target_idempotency_key,
    target_request_id,
    target_replacement_reason
  );

  result_operation_id := (result ->> 'operationId')::uuid;
  result_document_id := (result ->> 'documentId')::uuid;
  result_version_id := (result ->> 'versionId')::uuid;
  if result_operation_id is null or result_document_id is null or result_version_id is null then
    raise data_exception using message = 'The document upload preparation result is incomplete.';
  end if;

  -- A same-key transaction can have committed while this request waited for
  -- the document lock. The private core has already compared the full request
  -- intent in that case; do not restore its authority decision a second time.
  select operation.authority_intent_bound
  into operation_already_bound
  from private.hr_document_upload_operations operation
  where operation.id = result_operation_id
    and operation.document_id = result_document_id
    and operation.version_id = result_version_id
  for update;
  if not found then
    raise serialization_failure using message = 'The document upload operation disappeared during preparation.';
  end if;
  if operation_already_bound then
    return result;
  end if;

  update private.hr_document_upload_operations operation
  set prior_current_version_id = predecessor_id,
      authority_intent_bound = true,
      authority_superseded = false
  where operation.id = result_operation_id
    and operation.document_id = result_document_id
    and operation.version_id = result_version_id
    and not operation.authority_intent_bound;
  if not found then
    raise serialization_failure using message = 'The document upload authority intent could not be bound.';
  end if;

  -- The legacy core assigned the candidate eagerly. Undo only that exact
  -- pointer while the document row remains locked; no unrelated winner can be
  -- overwritten by this compare-and-set restoration.
  update private.hr_documents document
  set current_version_id = predecessor_id,
      updated_at = clock_timestamp()
  where document.id = result_document_id
    and document.current_version_id = result_version_id;
  if not found then
    raise serialization_failure using message = 'The document upload authority changed during preparation.';
  end if;

  -- A brand-new document has no prior authoritative version. Keep its shell
  -- out of the ordinary workspace until the protected object is verified.
  if predecessor_id is null then
    update private.hr_documents document
    set archived_at = coalesce(document.archived_at, clock_timestamp()),
        archived_by = coalesce(document.archived_by, target_actor_id),
        archive_reason = coalesce(
          document.archive_reason,
          'Upload pending protected storage verification.'
        ),
        updated_at = clock_timestamp()
    where document.id = result_document_id
      and document.current_version_id is null
      and (
        document.archived_at is null
        or (
          document.archived_by = target_actor_id
          and document.archive_reason = 'Upload pending protected storage verification.'
        )
      );
    if not found then
      raise serialization_failure using message = 'The pending document shell could not be hidden safely.';
    end if;
  end if;

  return result;
end
$$;

create or replace function public.service_mark_hr_document_upload_stored(
  target_operation_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.hr_document_upload_operations%rowtype;
  document_record private.hr_documents%rowtype;
  previous_state text;
  approved_size_bytes bigint;
  approved_mime_type text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select operation.* into operation_record
  from private.hr_document_upload_operations operation
  where operation.id = target_operation_id
  for update;
  if not found then
    raise no_data_found using message = 'The upload operation was not found.';
  end if;
  if not operation_record.authority_intent_bound then
    raise check_violation using message = 'The upload authority intent is incomplete.';
  end if;
  if operation_record.state = 'clean' then
    return jsonb_build_object(
      'operationId', operation_record.id,
      'state', 'clean',
      'requestId', operation_record.request_id
    );
  end if;
  if operation_record.state in ('rejected', 'cancelled') then
    raise check_violation using message = 'The upload cannot be made available.';
  end if;
  if operation_record.authority_superseded then
    raise serialization_failure using message = 'A newer document version superseded this upload before completion.';
  end if;
  if operation_record.state not in ('initialized', 'quarantined', 'stored', 'scan_pending', 'scan_error', 'storage_error') then
    raise check_violation using message = 'The upload is not ready for protected storage completion.';
  end if;

  select version.size_bytes, version.detected_mime_type
  into approved_size_bytes, approved_mime_type
  from private.hr_document_versions version
  where version.id = operation_record.version_id
    and version.document_id = operation_record.document_id;
  if not found then
    raise no_data_found using message = 'The approved document version was not found.';
  end if;
  perform private.require_private_storage_object(
    operation_record.storage_bucket,
    operation_record.object_key,
    approved_size_bytes,
    approved_mime_type
  );

  select document.* into document_record
  from private.hr_documents document
  where document.id = operation_record.document_id
  for update;
  if not found then
    raise no_data_found using message = 'The document was not found.';
  end if;
  if operation_record.prior_current_version_id is not null
    and not exists (
      select 1
      from private.hr_document_versions predecessor
      where predecessor.id = operation_record.prior_current_version_id
        and predecessor.document_id = operation_record.document_id
    )
  then
    raise check_violation using message = 'The upload predecessor does not belong to this document.';
  end if;
  if document_record.current_version_id is distinct from operation_record.version_id
    and document_record.current_version_id is distinct from operation_record.prior_current_version_id
  then
    raise serialization_failure using message = 'A newer document version became authoritative before this upload completed.';
  end if;
  if document_record.archived_at is not null
    and not (
      operation_record.prior_current_version_id is null
      and document_record.archived_by = operation_record.actor_employee_id
      and document_record.archive_reason = 'Upload pending protected storage verification.'
    )
  then
    raise serialization_failure using message = 'The document lifecycle changed before this upload completed.';
  end if;

  previous_state := operation_record.state;
  if operation_record.state in ('initialized', 'quarantined', 'scan_error', 'storage_error') then
    update private.hr_document_upload_operations operation
    set state = 'stored',
        stored_at = coalesce(operation.stored_at, clock_timestamp()),
        failure_code = null,
        failure_detail = null
    where operation.id = target_operation_id
    returning * into operation_record;
  end if;

  update private.hr_document_upload_operations operation
  set state = 'clean',
      stored_at = coalesce(operation.stored_at, clock_timestamp()),
      completed_at = coalesce(operation.completed_at, clock_timestamp()),
      request_id = coalesce(nullif(btrim(target_request_id), ''), operation.request_id),
      failure_code = null,
      failure_detail = null
  where operation.id = target_operation_id
  returning * into operation_record;

  if document_record.current_version_id is distinct from operation_record.version_id then
    update private.hr_documents document
    set current_version_id = operation_record.version_id,
        archived_at = case
          when document.archive_reason = 'Upload pending protected storage verification.'
            then null
          else document.archived_at
        end,
        archived_by = case
          when document.archive_reason = 'Upload pending protected storage verification.'
            then null
          else document.archived_by
        end,
        archive_reason = case
          when document.archive_reason = 'Upload pending protected storage verification.'
            then null
          else document.archive_reason
        end,
        updated_at = clock_timestamp()
    where document.id = operation_record.document_id
      and document.current_version_id is not distinct from operation_record.prior_current_version_id
      and (
        document.archived_at is null
        or (
          operation_record.prior_current_version_id is null
          and document.archived_by = operation_record.actor_employee_id
          and document.archive_reason = 'Upload pending protected storage verification.'
        )
      );
    if not found then
      raise serialization_failure using message = 'The document authority changed during upload completion.';
    end if;
  end if;

  -- Only one replacement that was prepared from a given predecessor may win
  -- the authority slot. Terminalize every overlapping loser in this same
  -- transaction so recovery cannot later promote an older candidate. The
  -- transition guard permits only this monotonic false-to-true supersession
  -- together with the terminal rejected state; all other authority identity
  -- fields remain immutable.
  update private.hr_document_upload_operations competing_operation
  set state = 'rejected',
      authority_superseded = true,
      failure_code = 'authority_superseded',
      failure_detail = 'A competing verified document upload became authoritative first.'
  where competing_operation.document_id = operation_record.document_id
    and competing_operation.id <> operation_record.id
    and competing_operation.authority_intent_bound
    and not competing_operation.authority_superseded
    and competing_operation.prior_current_version_id
      is not distinct from operation_record.prior_current_version_id
    and competing_operation.state in (
      'initialized', 'quarantined', 'stored', 'scan_pending',
      'scan_error', 'storage_error'
    );

  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    operation_record.document_id,
    operation_record.version_id,
    'upload_available',
    operation_record.actor_employee_id,
    coalesce(nullif(btrim(target_request_id), ''), operation_record.request_id),
    'Upload completed after protected storage and checksum verification.',
    jsonb_build_object(
      'operationId', operation_record.id,
      'previousState', previous_state,
      'state', 'clean',
      'priorCurrentVersionId', operation_record.prior_current_version_id
    )
  );

  return jsonb_build_object(
    'operationId', operation_record.id,
    'state', 'clean',
    'requestId', operation_record.request_id
  );
end
$$;

create or replace function public.service_fail_hr_document_upload(
  target_operation_id uuid,
  target_state text,
  target_failure_code text,
  target_failure_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.hr_document_upload_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_state not in ('scan_error', 'storage_error', 'rejected', 'cancelled') then
    raise check_violation using message = 'Unsupported upload failure state.';
  end if;
  if btrim(coalesce(target_failure_code, '')) = '' then
    raise check_violation using message = 'A failure code is required.';
  end if;

  select operation.* into operation_record
  from private.hr_document_upload_operations operation
  where operation.id = target_operation_id
  for update;
  if not found then
    raise no_data_found using message = 'The upload operation was not found.';
  end if;
  if operation_record.state in ('clean', 'rejected', 'cancelled') then
    return jsonb_build_object('operationId', operation_record.id, 'state', operation_record.state);
  end if;

  update private.hr_document_upload_operations operation
  set state = target_state,
      failure_code = target_failure_code,
      failure_detail = nullif(left(btrim(coalesce(target_failure_detail, '')), 1000), '')
  where operation.id = target_operation_id
  returning * into operation_record;

  if operation_record.authority_intent_bound then
    update private.hr_documents document
    set current_version_id = operation_record.prior_current_version_id,
        updated_at = clock_timestamp()
    where document.id = operation_record.document_id
      and document.current_version_id = operation_record.version_id;
  end if;

  insert into private.hr_document_access_events (
    document_id, version_id, action, actor_employee_id, request_id, reason, metadata
  ) values (
    operation_record.document_id,
    operation_record.version_id,
    'upload_storage_failure',
    operation_record.actor_employee_id,
    operation_record.request_id,
    'Protected storage verification did not complete.',
    jsonb_build_object(
      'operationId', operation_record.id,
      'state', operation_record.state,
      'failureCode', target_failure_code,
      'priorCurrentVersionId', operation_record.prior_current_version_id
    )
  );
  return jsonb_build_object('operationId', operation_record.id, 'state', operation_record.state);
end
$$;

-- Recovery must include first-write and retryable storage failures now that
-- their exact bytes are intentionally preserved. Superseded or terminal rows
-- are excluded so recovery can never revive an older authority candidate.
create or replace function public.service_list_hr_document_availability_recovery(
  target_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  recovery_candidates jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'operationId', candidate.operation_id,
    'bucket', candidate.storage_bucket,
    'objectKey', candidate.object_key,
    'sizeBytes', candidate.size_bytes,
    'checksum', candidate.sha256_checksum
  ) order by candidate.created_at, candidate.operation_id), '[]'::jsonb)
  into recovery_candidates
  from (
    select
      operation.id as operation_id,
      operation.created_at,
      operation.storage_bucket,
      operation.object_key,
      version.size_bytes,
      version.sha256_checksum
    from private.hr_document_upload_operations operation
    join private.hr_document_versions version
      on version.id = operation.version_id
     and version.document_id = operation.document_id
     and version.storage_bucket = operation.storage_bucket
     and version.object_key = operation.object_key
    where operation.state in (
        'initialized', 'quarantined', 'stored', 'scan_pending',
        'scan_error', 'storage_error'
      )
      and operation.authority_intent_bound
      and not operation.authority_superseded
      and nullif(pg_catalog.btrim(operation.storage_bucket), '') is not null
      and version.object_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'
      and version.size_bytes between 1 and 26214400
      and version.sha256_checksum ~ '^[a-f0-9]{64}$'
    order by operation.created_at, operation.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) candidate;

  return recovery_candidates;
end
$$;

revoke all on function public.service_begin_hr_document_upload(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.service_mark_hr_document_upload_stored(uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_fail_hr_document_upload(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.service_list_hr_document_availability_recovery(integer)
  from public, anon, authenticated;

grant execute on function public.service_begin_hr_document_upload(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text,
  text, text, bigint, text, uuid, text, text
) to service_role;
grant execute on function public.service_mark_hr_document_upload_stored(uuid, text)
  to service_role;
grant execute on function public.service_fail_hr_document_upload(uuid, text, text, text)
  to service_role;
grant execute on function public.service_list_hr_document_availability_recovery(integer)
  to service_role;

comment on column private.hr_document_upload_operations.prior_current_version_id is
  'The authoritative version observed under the document row lock before this upload was prepared.';
comment on column private.hr_document_upload_operations.authority_intent_bound is
  'True only after the immutable predecessor/current-version authority intent has been durably bound.';
comment on column private.hr_document_upload_operations.authority_superseded is
  'True when a historical or overlapping upload no longer owns the document authority slot and may never promote its candidate.';

notify pgrst, 'reload schema';

commit;

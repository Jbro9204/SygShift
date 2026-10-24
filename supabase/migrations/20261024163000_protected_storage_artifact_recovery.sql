begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Every cleanup decision is persisted before storage is touched. Object keys
-- allocated by the v2 profile/signature prepare functions contain a durable
-- operation id, so a later upload can never reactivate an object already
-- authorized for deletion.
create table if not exists private.protected_storage_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  cleanup_kind text not null check (cleanup_kind in (
    'profile_photo',
    'signature_appearance',
    'signature_final_pdf',
    'signature_certificate'
  )),
  storage_bucket text not null check (btrim(storage_bucket) <> ''),
  object_key text not null check (btrim(object_key) <> '' and object_key !~ '(^/|\.\.)'),
  byte_size bigint check (byte_size is null or byte_size > 0),
  sha256_checksum text check (sha256_checksum is null or sha256_checksum ~ '^[a-f0-9]{64}$'),
  employee_id uuid references public.employees(id) on delete restrict,
  recipient_id uuid references private.signature_recipients(id) on delete restrict,
  envelope_id uuid references private.signature_envelopes(id) on delete restrict,
  processing_job_id uuid references private.document_processing_jobs(id) on delete restrict,
  source_operation_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default clock_timestamp(),
  leased_at timestamptz,
  lease_owner text,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (cleanup_kind, source_operation_id, storage_bucket, object_key)
);

alter table private.protected_storage_cleanup_jobs enable row level security;
revoke all on table private.protected_storage_cleanup_jobs from public, anon, authenticated;

create index if not exists protected_storage_cleanup_jobs_recovery_idx
  on private.protected_storage_cleanup_jobs (available_at, created_at, id)
  where status in ('pending', 'processing');

-- Legacy rows remain valid evidence. New operations use operation-scoped keys,
-- so the former content-path uniqueness constraint must not collapse a later
-- A -> B -> A sequence into the historical first A operation.
alter table private.employee_photo_upload_operations
  drop constraint if exists employee_photo_upload_operations_employee_id_photo_path_key;
alter table private.employee_photo_upload_operations
  add column if not exists byte_size bigint,
  add column if not exists mime_type text,
  add column if not exists updated_at timestamptz not null default clock_timestamp();
alter table private.employee_photo_upload_operations
  drop constraint if exists employee_photo_upload_operations_status_check;
alter table private.employee_photo_upload_operations
  add constraint employee_photo_upload_operations_status_check
  check (status in ('prepared', 'completed', 'conflict', 'cleanup_pending'));
alter table private.employee_photo_upload_operations
  drop constraint if exists employee_photo_upload_operations_byte_size_check;
alter table private.employee_photo_upload_operations
  add constraint employee_photo_upload_operations_byte_size_check
  check (byte_size is null or byte_size between 1 and 5242880);
alter table private.employee_photo_upload_operations
  drop constraint if exists employee_photo_upload_operations_mime_type_check;
alter table private.employee_photo_upload_operations
  add constraint employee_photo_upload_operations_mime_type_check
  check (mime_type is null or mime_type in ('image/jpeg', 'image/png'));

create index if not exists employee_photo_upload_operations_prepared_idx
  on private.employee_photo_upload_operations (
    employee_id,
    expected_photo_path,
    photo_checksum,
    byte_size,
    mime_type,
    created_at desc,
    id desc
  )
  where status = 'prepared';

create table if not exists private.signature_appearance_operations (
  id uuid primary key default gen_random_uuid(),
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  recipient_id uuid not null references private.signature_recipients(id) on delete restrict,
  storage_bucket text not null default 'signature-appearances',
  object_key text not null,
  sha256_checksum text not null check (sha256_checksum ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 1048576),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  request_id text,
  status text not null default 'prepared' check (status in ('prepared', 'authoritative', 'cleanup_pending', 'cleaned', 'cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (storage_bucket, object_key)
);

alter table private.signature_appearance_operations enable row level security;
revoke all on table private.signature_appearance_operations from public, anon, authenticated;

create index if not exists signature_appearance_operations_prepared_idx
  on private.signature_appearance_operations (
    actor_employee_id,
    recipient_id,
    sha256_checksum,
    byte_size,
    mime_type,
    created_at desc,
    id desc
  )
  where status = 'prepared';

create or replace function public.service_prepare_employee_photo_upload_v2(
  target_employee_id uuid,
  target_expected_photo_path text,
  target_photo_checksum text,
  target_extension text,
  target_byte_size bigint,
  target_mime_type text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  operation_record private.employee_photo_upload_operations%rowtype;
  operation_id uuid;
  normalized_checksum text := lower(btrim(coalesce(target_photo_checksum, '')));
  normalized_expected_path text := nullif(btrim(coalesce(target_expected_photo_path, '')), '');
  normalized_extension text := lower(btrim(coalesce(target_extension, '')));
  normalized_mime_type text := lower(btrim(coalesce(target_mime_type, '')));
  candidate_path text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_employee_id is null then
    raise check_violation using message = 'The employee identifier is required.';
  end if;
  if normalized_checksum !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The profile photo checksum is invalid.';
  end if;
  if target_byte_size is null or target_byte_size not between 1 and 5242880 then
    raise check_violation using message = 'The profile photo size is invalid.';
  end if;
  if (normalized_extension, normalized_mime_type) not in (('jpg', 'image/jpeg'), ('png', 'image/png')) then
    raise check_violation using message = 'The profile photo type is invalid.';
  end if;

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The employee was not found.';
  end if;

  -- A retry after a lost completion response rediscovers the exact operation
  -- only when that operation is still the authoritative employee photo.
  select operation.*
  into operation_record
  from private.employee_photo_upload_operations operation
  where operation.employee_id = target_employee_id
    and operation.status = 'completed'
    and operation.photo_path = employee_record.photo_path
    and operation.photo_checksum = normalized_checksum
    and operation.byte_size = target_byte_size
    and operation.mime_type = normalized_mime_type
  order by operation.completed_at desc nulls last, operation.created_at desc, operation.id desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'operationId', operation_record.id,
      'state', 'completed',
      'currentPath', employee_record.photo_path,
      'photoPath', operation_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', true
    );
  end if;

  if employee_record.photo_path is distinct from normalized_expected_path then
    return jsonb_build_object(
      'state', 'conflict',
      'currentPath', employee_record.photo_path,
      'previousPath', normalized_expected_path,
      'idempotent', false
    );
  end if;

  -- A retry after process loss before completion reuses the durable prepared
  -- identity. Completed historical operations are deliberately excluded.
  select operation.*
  into operation_record
  from private.employee_photo_upload_operations operation
  where operation.employee_id = target_employee_id
    and operation.status = 'prepared'
    and operation.expected_photo_path is not distinct from normalized_expected_path
    and operation.photo_checksum = normalized_checksum
    and operation.byte_size = target_byte_size
    and operation.mime_type = normalized_mime_type
  order by operation.created_at desc, operation.id desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'operationId', operation_record.id,
      'state', 'prepared',
      'currentPath', employee_record.photo_path,
      'photoPath', operation_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', true
    );
  end if;

  operation_id := gen_random_uuid();
  candidate_path := target_employee_id::text || '/' || operation_id::text || '/' || normalized_checksum || '.' || normalized_extension;
  insert into private.employee_photo_upload_operations (
    id,
    employee_id,
    expected_photo_path,
    photo_path,
    photo_checksum,
    byte_size,
    mime_type,
    request_id,
    status,
    updated_at
  ) values (
    operation_id,
    target_employee_id,
    normalized_expected_path,
    candidate_path,
    normalized_checksum,
    target_byte_size,
    normalized_mime_type,
    nullif(left(btrim(coalesce(target_request_id, '')), 240), ''),
    'prepared',
    clock_timestamp()
  ) returning * into operation_record;

  return jsonb_build_object(
    'operationId', operation_record.id,
    'state', 'prepared',
    'currentPath', employee_record.photo_path,
    'photoPath', operation_record.photo_path,
    'previousPath', operation_record.expected_photo_path,
    'idempotent', false
  );
end
$$;

create or replace function public.service_complete_employee_photo_upload_v2(
  target_operation_id uuid,
  target_employee_id uuid,
  target_photo_path text,
  target_photo_checksum text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  operation_record private.employee_photo_upload_operations%rowtype;
  cleanup_job_id uuid;
  normalized_path text := btrim(coalesce(target_photo_path, ''));
  normalized_checksum text := lower(btrim(coalesce(target_photo_checksum, '')));
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  -- Every profile mutation locks the employee before its operation row. This
  -- consistent order serializes PUT versus DELETE without introducing a
  -- prepare/complete deadlock.
  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The employee was not found.';
  end if;

  select operation.*
  into operation_record
  from private.employee_photo_upload_operations operation
  where operation.id = target_operation_id
    and operation.employee_id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The prepared profile photo upload was not found.';
  end if;
  if operation_record.photo_path <> normalized_path
    or operation_record.photo_checksum <> normalized_checksum
    or operation_record.byte_size is null
    or operation_record.mime_type is null then
    raise check_violation using message = 'The profile photo operation identity changed.';
  end if;

  if operation_record.status = 'completed' and employee_record.photo_path = operation_record.photo_path then
    return jsonb_build_object(
      'operationId', operation_record.id,
      'state', 'completed',
      'currentPath', employee_record.photo_path,
      'photoPath', operation_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', true
    );
  end if;

  if operation_record.status in ('conflict', 'cleanup_pending')
    or employee_record.photo_path is distinct from operation_record.expected_photo_path then
    update private.employee_photo_upload_operations operation
    set status = 'cleanup_pending', completed_at = coalesce(operation.completed_at, clock_timestamp()), updated_at = clock_timestamp()
    where operation.id = operation_record.id;

    insert into private.protected_storage_cleanup_jobs (
      cleanup_kind,
      storage_bucket,
      object_key,
      byte_size,
      sha256_checksum,
      employee_id,
      source_operation_id
    ) values (
      'profile_photo',
      'employee-photos',
      operation_record.photo_path,
      operation_record.byte_size,
      operation_record.photo_checksum,
      target_employee_id,
      operation_record.id
    )
    on conflict (cleanup_kind, source_operation_id, storage_bucket, object_key)
    do update set
      status = case when private.protected_storage_cleanup_jobs.status = 'completed' then 'completed' else 'pending' end,
      available_at = least(private.protected_storage_cleanup_jobs.available_at, clock_timestamp()),
      updated_at = clock_timestamp()
    returning id into cleanup_job_id;

    return jsonb_build_object(
      'operationId', operation_record.id,
      'cleanupJobId', cleanup_job_id,
      'state', 'conflict',
      'currentPath', employee_record.photo_path,
      'photoPath', operation_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', operation_record.status in ('conflict', 'cleanup_pending')
    );
  end if;

  update public.employees employee
  set photo_path = operation_record.photo_path, updated_at = clock_timestamp()
  where employee.id = target_employee_id;

  update private.employee_photo_upload_operations operation
  set status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where operation.id = operation_record.id;

  if operation_record.expected_photo_path is not null
    and operation_record.expected_photo_path <> operation_record.photo_path then
    insert into private.protected_storage_cleanup_jobs (
      cleanup_kind,
      storage_bucket,
      object_key,
      employee_id,
      source_operation_id
    ) values (
      'profile_photo',
      'employee-photos',
      operation_record.expected_photo_path,
      target_employee_id,
      operation_record.id
    )
    on conflict (cleanup_kind, source_operation_id, storage_bucket, object_key)
    do update set
      status = case when private.protected_storage_cleanup_jobs.status = 'completed' then 'completed' else 'pending' end,
      available_at = least(private.protected_storage_cleanup_jobs.available_at, clock_timestamp()),
      updated_at = clock_timestamp()
    returning id into cleanup_job_id;
  end if;

  insert into private.audit_events (
    employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    target_employee_id,
    'public',
    'employees',
    'self_photo_update',
    target_employee_id::text,
    jsonb_build_object('hasPhoto', operation_record.expected_photo_path is not null),
    jsonb_build_object(
      'hasPhoto', true,
      'checksum', operation_record.photo_checksum,
      'operationId', operation_record.id,
      'requestId', coalesce(
        nullif(left(btrim(coalesce(target_request_id, '')), 240), ''),
        operation_record.request_id
      )
    )
  );

  return jsonb_build_object(
    'operationId', operation_record.id,
    'cleanupJobId', cleanup_job_id,
    'state', 'completed',
    'currentPath', operation_record.photo_path,
    'photoPath', operation_record.photo_path,
    'previousPath', operation_record.expected_photo_path,
    'idempotent', false
  );
end
$$;

create or replace function public.service_remove_employee_photo_v2(
  target_employee_id uuid,
  target_expected_photo_path text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  normalized_expected_path text := nullif(btrim(coalesce(target_expected_photo_path, '')), '');
  removal_operation_id uuid := gen_random_uuid();
  cleanup_job_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The employee was not found.';
  end if;

  if employee_record.photo_path is null then
    return jsonb_build_object('state', 'removed', 'previousPath', null, 'cleanupJobId', null, 'idempotent', true);
  end if;
  if employee_record.photo_path is distinct from normalized_expected_path then
    return jsonb_build_object(
      'state', 'conflict',
      'currentPath', employee_record.photo_path,
      'previousPath', normalized_expected_path,
      'idempotent', false
    );
  end if;

  update public.employees employee
  set photo_path = null, updated_at = clock_timestamp()
  where employee.id = target_employee_id;

  insert into private.protected_storage_cleanup_jobs (
    cleanup_kind,
    storage_bucket,
    object_key,
    employee_id,
    source_operation_id
  ) values (
    'profile_photo',
    'employee-photos',
    employee_record.photo_path,
    target_employee_id,
    removal_operation_id
  ) returning id into cleanup_job_id;

  insert into private.audit_events (
    employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    target_employee_id,
    'public',
    'employees',
    'self_photo_remove',
    target_employee_id::text,
    jsonb_build_object('hasPhoto', true),
    jsonb_build_object(
      'hasPhoto', false,
      'requestId', nullif(left(btrim(coalesce(target_request_id, '')), 240), ''),
      'removalOperationId', removal_operation_id
    )
  );

  return jsonb_build_object(
    'state', 'removed',
    'previousPath', employee_record.photo_path,
    'cleanupJobId', cleanup_job_id,
    'idempotent', false
  );
end
$$;

create or replace function public.service_reconcile_stale_employee_photo_uploads_v2(
  target_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  employee_record public.employees%rowtype;
  operation_record private.employee_photo_upload_operations%rowtype;
  reconciled_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  for candidate in
    select operation.id, operation.employee_id
    from private.employee_photo_upload_operations operation
    where operation.status = 'prepared'
      and operation.created_at <= clock_timestamp() - interval '1 hour'
    order by operation.created_at, operation.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  loop
    -- Match prepare/complete/remove lock order. If a late completion wins first,
    -- this observes completed. If reconciliation wins, cleanup_pending fences
    -- that late completion from adopting an object authorized for deletion.
    select employee.* into employee_record
    from public.employees employee
    where employee.id = candidate.employee_id
    for update;
    if not found then continue; end if;

    select operation.* into operation_record
    from private.employee_photo_upload_operations operation
    where operation.id = candidate.id
    for update;
    if not found or operation_record.status <> 'prepared' then continue; end if;

    if employee_record.photo_path = operation_record.photo_path then
      update private.employee_photo_upload_operations operation
      set status = 'completed',
          completed_at = coalesce(operation.completed_at, clock_timestamp()),
          updated_at = clock_timestamp()
      where operation.id = operation_record.id;
    else
      update private.employee_photo_upload_operations operation
      set status = 'cleanup_pending',
          completed_at = coalesce(operation.completed_at, clock_timestamp()),
          updated_at = clock_timestamp()
      where operation.id = operation_record.id;

      insert into private.protected_storage_cleanup_jobs (
        cleanup_kind,
        storage_bucket,
        object_key,
        byte_size,
        sha256_checksum,
        employee_id,
        source_operation_id
      ) values (
        'profile_photo',
        'employee-photos',
        operation_record.photo_path,
        operation_record.byte_size,
        case when operation_record.byte_size is null then null else operation_record.photo_checksum end,
        operation_record.employee_id,
        operation_record.id
      )
      on conflict (cleanup_kind, source_operation_id, storage_bucket, object_key)
      do update set
        status = case when private.protected_storage_cleanup_jobs.status = 'completed' then 'completed' else 'pending' end,
        available_at = least(private.protected_storage_cleanup_jobs.available_at, clock_timestamp()),
        updated_at = clock_timestamp();
    end if;
    reconciled_count := reconciled_count + 1;
  end loop;

  return jsonb_build_object('reconciled', reconciled_count);
end
$$;

create or replace function public.service_prepare_signature_appearance_v2(
  target_actor_id uuid,
  target_recipient_id uuid,
  target_checksum text,
  target_byte_size bigint,
  target_mime_type text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  recipient_record private.signature_recipients%rowtype;
  operation_record private.signature_appearance_operations%rowtype;
  operation_id uuid;
  extension text;
  normalized_checksum text := lower(btrim(coalesce(target_checksum, '')));
  normalized_mime_type text := lower(btrim(coalesce(target_mime_type, '')));
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if normalized_checksum !~ '^[a-f0-9]{64}$'
    or target_byte_size is null
    or target_byte_size not between 1 and 1048576
    or normalized_mime_type not in ('image/jpeg', 'image/png') then
    raise check_violation using message = 'The signature appearance identity is invalid.';
  end if;
  extension := case when normalized_mime_type = 'image/png' then 'png' else 'jpg' end;

  select recipient.*
  into recipient_record
  from private.signature_recipients recipient
  where recipient.id = target_recipient_id
    and recipient.employee_id = target_actor_id
  for update;
  if not found then
    raise no_data_found using message = 'The assigned signature action was not found.';
  end if;
  if recipient_record.status = 'completed' then
    return jsonb_build_object('state', 'completed', 'recipientId', recipient_record.id, 'idempotent', true);
  end if;
  if recipient_record.status not in ('pending', 'delivered', 'viewed', 'in_progress') then
    raise check_violation using message = 'This document action is no longer available.';
  end if;

  select operation.*
  into operation_record
  from private.signature_appearance_operations operation
  where operation.actor_employee_id = target_actor_id
    and operation.recipient_id = target_recipient_id
    and operation.sha256_checksum = normalized_checksum
    and operation.byte_size = target_byte_size
    and operation.mime_type = normalized_mime_type
    and operation.status = 'prepared'
  order by operation.created_at desc, operation.id desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'operationId', operation_record.id,
      'state', operation_record.status,
      'bucket', operation_record.storage_bucket,
      'objectKey', operation_record.object_key,
      'checksum', operation_record.sha256_checksum,
      'byteSize', operation_record.byte_size,
      'mimeType', operation_record.mime_type,
      'idempotent', true
    );
  end if;

  operation_id := gen_random_uuid();
  insert into private.signature_appearance_operations (
    id,
    actor_employee_id,
    recipient_id,
    storage_bucket,
    object_key,
    sha256_checksum,
    byte_size,
    mime_type,
    request_id
  ) values (
    operation_id,
    target_actor_id,
    target_recipient_id,
    'signature-appearances',
    target_actor_id::text || '/' || target_recipient_id::text || '/' || operation_id::text || '/' || normalized_checksum || '.' || extension,
    normalized_checksum,
    target_byte_size,
    normalized_mime_type,
    nullif(left(btrim(coalesce(target_request_id, '')), 240), '')
  ) returning * into operation_record;

  return jsonb_build_object(
    'operationId', operation_record.id,
    'state', operation_record.status,
    'bucket', operation_record.storage_bucket,
    'objectKey', operation_record.object_key,
    'checksum', operation_record.sha256_checksum,
    'byteSize', operation_record.byte_size,
    'mimeType', operation_record.mime_type,
    'idempotent', false
  );
end
$$;

-- Fence a signature action to the durable appearance operation. The
-- recipient and operation locks are held through the existing action RPC, so
-- stale recovery cannot authorize deletion while a late action adopts the
-- same private object.
create or replace function public.service_record_signature_action_v2(
  target_actor_id uuid,
  target_recipient_id uuid,
  target_action text,
  target_field_values jsonb,
  target_consent_version text,
  target_consent_shown_at timestamptz,
  target_signature_method text,
  target_signature_style text,
  target_display_name text,
  target_appearance_bucket text,
  target_appearance_object_key text,
  target_appearance_checksum text,
  target_save_adoption boolean,
  target_reason text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_session_reference_hash text,
  target_appearance_operation_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  action_result jsonb;
  event_record private.signature_events%rowtype;
  operation_record private.signature_appearance_operations%rowtype;
  recipient_record private.signature_recipients%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select recipient.* into recipient_record
  from private.signature_recipients recipient
  where recipient.id = target_recipient_id
    and recipient.employee_id = target_actor_id
  for update;
  if not found then
    raise no_data_found using message = 'The assigned signature action was not found.';
  end if;

  select operation.* into operation_record
  from private.signature_appearance_operations operation
  where operation.id = target_appearance_operation_id
    and operation.actor_employee_id = target_actor_id
    and operation.recipient_id = target_recipient_id
  for update;
  if not found then
    raise no_data_found using message = 'The prepared signature appearance was not found.';
  end if;
  if operation_record.storage_bucket <> target_appearance_bucket
    or operation_record.object_key <> target_appearance_object_key
    or operation_record.sha256_checksum <> lower(btrim(coalesce(target_appearance_checksum, ''))) then
    raise check_violation using message = 'The signature appearance operation identity changed.';
  end if;

  select event.* into event_record
  from private.signature_events event
  where event.recipient_id = target_recipient_id
    and event.appearance_bucket = operation_record.storage_bucket
    and event.appearance_object_key = operation_record.object_key
    and event.appearance_checksum = operation_record.sha256_checksum
  order by event.occurred_at desc, event.id desc
  limit 1;

  if event_record.id is null
    and operation_record.status not in ('prepared', 'authoritative') then
    raise check_violation using message = 'The signature appearance is no longer available for adoption.';
  end if;

  action_result := public.service_record_signature_action(
    target_actor_id,
    target_recipient_id,
    target_action,
    target_field_values,
    target_consent_version,
    target_consent_shown_at,
    target_signature_method,
    target_signature_style,
    target_display_name,
    target_appearance_bucket,
    target_appearance_object_key,
    target_appearance_checksum,
    target_save_adoption,
    target_reason,
    target_mfa_method,
    target_mfa_verified_at,
    target_session_reference_hash,
    target_request_id
  );

  select event.* into event_record
  from private.signature_events event
  where event.recipient_id = target_recipient_id
    and event.appearance_bucket = operation_record.storage_bucket
    and event.appearance_object_key = operation_record.object_key
    and event.appearance_checksum = operation_record.sha256_checksum
  order by event.occurred_at desc, event.id desc
  limit 1;
  if event_record.id is null then
    raise check_violation using message = 'The completed signature action did not adopt its prepared appearance.';
  end if;

  update private.signature_appearance_operations operation
  set status = 'authoritative',
      completed_at = coalesce(operation.completed_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where operation.id = operation_record.id;

  return action_result;
end
$$;

create or replace function public.service_reconcile_signature_appearance_v2(
  target_operation_id uuid,
  target_actor_id uuid,
  target_recipient_id uuid,
  target_abandon boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.signature_appearance_operations%rowtype;
  recipient_record private.signature_recipients%rowtype;
  event_record private.signature_events%rowtype;
  cleanup_job_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  -- Match prepare's recipient-before-operation lock order so recovery cannot
  -- deadlock with a live signing request.
  select recipient.*
  into recipient_record
  from private.signature_recipients recipient
  where recipient.id = target_recipient_id
    and recipient.employee_id = target_actor_id
  for update;
  if not found then
    raise no_data_found using message = 'The assigned signature action was not found.';
  end if;

  select operation.*
  into operation_record
  from private.signature_appearance_operations operation
  where operation.id = target_operation_id
    and operation.actor_employee_id = target_actor_id
    and operation.recipient_id = target_recipient_id
  for update;
  if not found then
    raise no_data_found using message = 'The prepared signature appearance was not found.';
  end if;

  select event.*
  into event_record
  from private.signature_events event
  where event.recipient_id = target_recipient_id
    and event.signature_method is not null
  order by event.occurred_at desc, event.id desc
  limit 1;

  if event_record.id is not null
    and event_record.appearance_bucket = operation_record.storage_bucket
    and event_record.appearance_object_key = operation_record.object_key
    and event_record.appearance_checksum = operation_record.sha256_checksum then
    update private.signature_appearance_operations operation
    set status = 'authoritative', completed_at = coalesce(operation.completed_at, clock_timestamp()), updated_at = clock_timestamp()
    where operation.id = operation_record.id;
    return jsonb_build_object('operationId', operation_record.id, 'state', 'authoritative', 'cleanupJobId', null);
  end if;

  if coalesce(target_abandon, false)
    or recipient_record.status in ('completed', 'declined', 'correction_requested', 'expired', 'voided', 'reassigned') then
    update private.signature_appearance_operations operation
    set status = 'cleanup_pending', completed_at = coalesce(operation.completed_at, clock_timestamp()), updated_at = clock_timestamp()
    where operation.id = operation_record.id;

    insert into private.protected_storage_cleanup_jobs (
      cleanup_kind,
      storage_bucket,
      object_key,
      byte_size,
      sha256_checksum,
      employee_id,
      recipient_id,
      envelope_id,
      source_operation_id,
      available_at
    ) values (
      'signature_appearance',
      operation_record.storage_bucket,
      operation_record.object_key,
      operation_record.byte_size,
      operation_record.sha256_checksum,
      operation_record.actor_employee_id,
      operation_record.recipient_id,
      recipient_record.envelope_id,
      operation_record.id,
      clock_timestamp() + interval '15 minutes'
    )
    on conflict (cleanup_kind, source_operation_id, storage_bucket, object_key)
    do update set
      status = case when private.protected_storage_cleanup_jobs.status = 'completed' then 'completed' else 'pending' end,
      available_at = least(private.protected_storage_cleanup_jobs.available_at, excluded.available_at),
      updated_at = clock_timestamp()
    returning id into cleanup_job_id;
    return jsonb_build_object('operationId', operation_record.id, 'state', 'cleanup_pending', 'cleanupJobId', cleanup_job_id);
  end if;

  return jsonb_build_object('operationId', operation_record.id, 'state', operation_record.status, 'cleanupJobId', null);
end
$$;

create or replace function public.service_reconcile_stale_signature_appearances_v2(
  target_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  reconciled_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  for candidate in
    select operation.id, operation.actor_employee_id, operation.recipient_id
    from private.signature_appearance_operations operation
    where operation.status = 'prepared'
      and operation.created_at <= clock_timestamp() - interval '1 hour'
    order by operation.created_at, operation.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  loop
    perform public.service_reconcile_signature_appearance_v2(
      candidate.id,
      candidate.actor_employee_id,
      candidate.recipient_id,
      true
    );
    reconciled_count := reconciled_count + 1;
  end loop;
  return jsonb_build_object('reconciled', reconciled_count);
end
$$;

create or replace function public.service_schedule_signature_artifact_cleanup_v2(
  target_envelope_id uuid,
  target_job_id uuid,
  target_cleanup_kind text,
  target_bucket text,
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
  envelope_record private.signature_envelopes%rowtype;
  job_record private.document_processing_jobs%rowtype;
  cleanup_job_id uuid;
  object_is_authoritative boolean := false;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_cleanup_kind not in ('signature_final_pdf', 'signature_certificate')
    or btrim(coalesce(target_bucket, '')) = ''
    or btrim(coalesce(target_object_key, '')) = ''
    or target_byte_size is null or target_byte_size <= 0
    or lower(btrim(coalesce(target_checksum, ''))) !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The signature artifact cleanup identity is invalid.';
  end if;

  select envelope.* into envelope_record
  from private.signature_envelopes envelope
  where envelope.id = target_envelope_id
  for update;
  if not found then raise no_data_found using message = 'The signature envelope was not found.'; end if;

  select job.* into job_record
  from private.document_processing_jobs job
  where job.id = target_job_id and job.envelope_id = target_envelope_id
  for update;
  if not found then raise no_data_found using message = 'The signature finalization job was not found.'; end if;

  if target_cleanup_kind = 'signature_final_pdf' then
    object_is_authoritative := exists (
      select 1 from private.hr_document_versions version
      where version.storage_bucket = target_bucket
        and version.object_key = target_object_key
        and version.sha256_checksum = lower(target_checksum)
    );
  else
    object_is_authoritative := exists (
      select 1 from private.signature_audit_certificates certificate
      where certificate.storage_bucket = target_bucket
        and certificate.object_key = target_object_key
        and certificate.checksum = lower(target_checksum)
    );
  end if;
  if object_is_authoritative then
    return jsonb_build_object('state', 'authoritative', 'cleanupJobId', null);
  end if;
  if envelope_record.status <> 'completed'
    and job_record.status not in ('failed', 'dead_letter', 'cancelled') then
    return jsonb_build_object('state', 'deferred', 'cleanupJobId', null);
  end if;

  insert into private.protected_storage_cleanup_jobs (
    cleanup_kind,
    storage_bucket,
    object_key,
    byte_size,
    sha256_checksum,
    envelope_id,
    processing_job_id,
    source_operation_id
  ) values (
    target_cleanup_kind,
    btrim(target_bucket),
    btrim(target_object_key),
    target_byte_size,
    lower(btrim(target_checksum)),
    target_envelope_id,
    target_job_id,
    target_job_id
  )
  on conflict (cleanup_kind, source_operation_id, storage_bucket, object_key)
  do update set
    status = case when private.protected_storage_cleanup_jobs.status = 'completed' then 'completed' else 'pending' end,
    available_at = least(private.protected_storage_cleanup_jobs.available_at, clock_timestamp()),
    updated_at = clock_timestamp()
  returning id into cleanup_job_id;

  return jsonb_build_object('state', 'cleanup_pending', 'cleanupJobId', cleanup_job_id);
end
$$;

create or replace function public.service_fail_signature_finalization_v2(
  target_envelope_id uuid,
  target_job_id uuid,
  target_error_code text,
  target_final_bucket text default null,
  target_final_object_key text default null,
  target_final_size_bytes bigint default null,
  target_final_checksum text default null,
  target_audit_bucket text default null,
  target_audit_object_key text default null,
  target_audit_size_bytes bigint default null,
  target_audit_checksum text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  envelope_record private.signature_envelopes%rowtype;
  job_record private.document_processing_jobs%rowtype;
  next_status text;
begin
  perform private.document_studio_require_service();

  -- Match the envelope-before-job order used by cleanup scheduling and final
  -- commit so a failure transition cannot deadlock a concurrent reconciler.
  select envelope.* into envelope_record
  from private.signature_envelopes envelope
  where envelope.id = target_envelope_id
  for update;
  if not found then
    raise no_data_found using message = 'The signature envelope was not found.';
  end if;

  select job.* into job_record
  from private.document_processing_jobs job
  where job.id = target_job_id
    and job.envelope_id = target_envelope_id
  for update;
  if not found or job_record.status <> 'processing' then
    raise check_violation using message = 'The signature finalization lease is not active.';
  end if;

  next_status := case when job_record.attempt_count >= 5 then 'dead_letter' else 'failed' end;
  update private.document_processing_jobs job
  set status = next_status,
      available_at = case when next_status = 'dead_letter' then job.available_at else clock_timestamp() + make_interval(secs => least(3600, 30 * (2 ^ greatest(0, job.attempt_count - 1))::integer)) end,
      failed_at = clock_timestamp(),
      last_error_code = left(coalesce(nullif(btrim(target_error_code), ''), 'finalization_failed'), 120),
      lease_owner = null,
      leased_at = null
  where job.id = target_job_id;

  if next_status = 'dead_letter' then
    if target_final_object_key is not null then
      perform public.service_schedule_signature_artifact_cleanup_v2(
        target_envelope_id, target_job_id, 'signature_final_pdf', target_final_bucket,
        target_final_object_key, target_final_size_bytes, target_final_checksum
      );
    end if;
    if target_audit_object_key is not null then
      perform public.service_schedule_signature_artifact_cleanup_v2(
        target_envelope_id, target_job_id, 'signature_certificate', target_audit_bucket,
        target_audit_object_key, target_audit_size_bytes, target_audit_checksum
      );
    end if;
  end if;

  return jsonb_build_object(
    'envelopeId', target_envelope_id,
    'status', next_status,
    'attemptCount', job_record.attempt_count
  );
end
$$;

create or replace function public.service_list_protected_storage_cleanup_v2(
  target_limit integer default 25,
  target_lease_owner text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_owner text := nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '');
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if normalized_owner is null then
    raise check_violation using message = 'A cleanup lease owner is required.';
  end if;

  -- Reclaim abandoned leases first.
  update private.protected_storage_cleanup_jobs cleanup
  set status = 'pending', lease_owner = null, leased_at = null, updated_at = clock_timestamp()
  where cleanup.status = 'processing'
    and cleanup.leased_at <= clock_timestamp() - interval '10 minutes';

  -- A reference that became authoritative always wins over cleanup.
  update private.protected_storage_cleanup_jobs cleanup
  set status = 'cancelled', completed_at = clock_timestamp(), lease_owner = null, leased_at = null, updated_at = clock_timestamp()
  where cleanup.status in ('pending', 'processing')
    and (
      (cleanup.cleanup_kind = 'profile_photo' and exists (
        select 1 from public.employees employee
        where employee.id = cleanup.employee_id and employee.photo_path = cleanup.object_key
      ))
      or (cleanup.cleanup_kind = 'signature_appearance' and exists (
        select 1 from private.signature_events event
        where event.recipient_id = cleanup.recipient_id
          and event.appearance_bucket = cleanup.storage_bucket
          and event.appearance_object_key = cleanup.object_key
          and event.appearance_checksum = cleanup.sha256_checksum
      ))
      or (cleanup.cleanup_kind = 'signature_final_pdf' and exists (
        select 1 from private.hr_document_versions version
        where version.storage_bucket = cleanup.storage_bucket
          and version.object_key = cleanup.object_key
          and version.sha256_checksum = cleanup.sha256_checksum
      ))
      or (cleanup.cleanup_kind = 'signature_certificate' and exists (
        select 1 from private.signature_audit_certificates certificate
        where certificate.storage_bucket = cleanup.storage_bucket
          and certificate.object_key = cleanup.object_key
          and certificate.checksum = cleanup.sha256_checksum
      ))
    );

  with candidates as (
    select cleanup.id
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.status = 'pending'
      and cleanup.available_at <= clock_timestamp()
    order by cleanup.available_at, cleanup.created_at, cleanup.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
    for update skip locked
  ), updated as (
    update private.protected_storage_cleanup_jobs cleanup
    set status = 'processing',
        attempt_count = cleanup.attempt_count + 1,
        lease_owner = normalized_owner,
        leased_at = clock_timestamp(),
        updated_at = clock_timestamp()
    from candidates
    where cleanup.id = candidates.id
    returning cleanup.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', updated.id,
    'kind', updated.cleanup_kind,
    'bucket', updated.storage_bucket,
    'objectKey', updated.object_key,
    'sizeBytes', updated.byte_size,
    'checksum', updated.sha256_checksum,
    'leaseOwner', updated.lease_owner,
    'attemptCount', updated.attempt_count
  ) order by updated.available_at, updated.created_at, updated.id), '[]'::jsonb)
  into claimed
  from updated;

  return claimed;
end
$$;

create or replace function public.service_defer_protected_storage_cleanup_v2(
  target_cleanup_id uuid,
  target_lease_owner text,
  target_error text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  update private.protected_storage_cleanup_jobs cleanup
  set status = 'pending',
      available_at = clock_timestamp() + make_interval(secs => least(3600, 30 * (2 ^ greatest(0, cleanup.attempt_count - 1))::integer)),
      lease_owner = null,
      leased_at = null,
      last_error = left(coalesce(nullif(btrim(target_error), ''), 'storage_cleanup_failed'), 500),
      updated_at = clock_timestamp()
  where cleanup.id = target_cleanup_id
    and cleanup.status = 'processing'
    and cleanup.lease_owner = nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '');
  if not found then
    raise check_violation using message = 'The protected-storage cleanup lease is no longer active.';
  end if;
end
$$;

create or replace function public.service_complete_protected_storage_cleanup_v2(
  target_cleanup_id uuid,
  target_lease_owner text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleanup_record private.protected_storage_cleanup_jobs%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select cleanup.* into cleanup_record
  from private.protected_storage_cleanup_jobs cleanup
  where cleanup.id = target_cleanup_id
  for update;
  if not found
    or cleanup_record.status <> 'processing'
    or cleanup_record.lease_owner is distinct from nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '') then
    raise check_violation using message = 'The protected-storage cleanup lease is no longer active.';
  end if;

  update private.protected_storage_cleanup_jobs cleanup
  set status = 'completed',
      completed_at = clock_timestamp(),
      lease_owner = null,
      leased_at = null,
      last_error = null,
      updated_at = clock_timestamp()
  where cleanup.id = cleanup_record.id;

  if cleanup_record.cleanup_kind = 'signature_appearance' then
    update private.signature_appearance_operations operation
    set status = 'cleaned', completed_at = coalesce(operation.completed_at, clock_timestamp()), updated_at = clock_timestamp()
    where operation.id = cleanup_record.source_operation_id
      and operation.status = 'cleanup_pending';
  end if;
end
$$;

-- The old content-address-only API cannot distinguish historical A -> B -> A
-- attempts or serialize removal. Keep the definitions for migration history,
-- but remove every execution path after the v2 Worker is released.
revoke all on function public.service_prepare_employee_photo_upload(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.service_complete_employee_photo_upload(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function public.service_prepare_employee_photo_upload_v2(uuid, text, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_employee_photo_upload_v2(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.service_remove_employee_photo_v2(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_reconcile_stale_employee_photo_uploads_v2(integer)
  from public, anon, authenticated;
revoke all on function public.service_prepare_signature_appearance_v2(uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.service_record_signature_action_v2(uuid, uuid, text, jsonb, text, timestamptz, text, text, text, text, text, text, boolean, text, text, timestamptz, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_reconcile_signature_appearance_v2(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.service_reconcile_stale_signature_appearances_v2(integer)
  from public, anon, authenticated;
revoke all on function public.service_schedule_signature_artifact_cleanup_v2(uuid, uuid, text, text, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_fail_signature_finalization_v2(uuid, uuid, text, text, text, bigint, text, text, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.service_list_protected_storage_cleanup_v2(integer, text)
  from public, anon, authenticated;
revoke all on function public.service_defer_protected_storage_cleanup_v2(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_protected_storage_cleanup_v2(uuid, text)
  from public, anon, authenticated;

grant execute on function public.service_prepare_employee_photo_upload_v2(uuid, text, text, text, bigint, text, text) to service_role;
grant execute on function public.service_complete_employee_photo_upload_v2(uuid, uuid, text, text, text) to service_role;
grant execute on function public.service_remove_employee_photo_v2(uuid, text, text) to service_role;
grant execute on function public.service_reconcile_stale_employee_photo_uploads_v2(integer) to service_role;
grant execute on function public.service_prepare_signature_appearance_v2(uuid, uuid, text, bigint, text, text) to service_role;
grant execute on function public.service_record_signature_action_v2(uuid, uuid, text, jsonb, text, timestamptz, text, text, text, text, text, text, boolean, text, text, timestamptz, text, uuid, text) to service_role;
grant execute on function public.service_reconcile_signature_appearance_v2(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.service_reconcile_stale_signature_appearances_v2(integer) to service_role;
grant execute on function public.service_schedule_signature_artifact_cleanup_v2(uuid, uuid, text, text, text, bigint, text) to service_role;
grant execute on function public.service_fail_signature_finalization_v2(uuid, uuid, text, text, text, bigint, text, text, text, bigint, text) to service_role;
grant execute on function public.service_list_protected_storage_cleanup_v2(integer, text) to service_role;
grant execute on function public.service_defer_protected_storage_cleanup_v2(uuid, text, text) to service_role;
grant execute on function public.service_complete_protected_storage_cleanup_v2(uuid, text) to service_role;

comment on table private.protected_storage_cleanup_jobs is
  'Durable, service-only cleanup work for exact private-storage objects that a row-locked database decision proved non-authoritative.';
comment on function public.service_prepare_employee_photo_upload_v2(uuid, text, text, text, bigint, text, text) is
  'Allocates or rediscovers one operation-scoped profile-photo object identity before storage is written.';
comment on function public.service_remove_employee_photo_v2(uuid, text, text) is
  'Atomically compares and clears the selected profile photo while durably scheduling its exact former object for cleanup.';

commit;

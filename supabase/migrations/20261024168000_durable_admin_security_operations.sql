begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Every new password-reset audit event receives an immutable operation id.
-- Existing append-only history receives unique generated ids through the
-- column default; no historical event is updated or removed.
alter table private.employee_password_reset_events
  add column if not exists operation_id uuid not null default gen_random_uuid();

create unique index if not exists employee_password_reset_events_operation_uidx
  on private.employee_password_reset_events(operation_id);

-- The same operation identity is carried onto the append-only MFA reset event.
alter table private.employee_mfa_reset_events
  add column if not exists operation_id uuid not null default gen_random_uuid();

create unique index if not exists employee_mfa_reset_events_operation_uidx
  on private.employee_mfa_reset_events(operation_id);

create table if not exists private.admin_mfa_reset_operations (
  id uuid primary key,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null,
  reset_by uuid not null references public.employees(id) on delete restrict,
  factor_ids uuid[] not null default array[]::uuid[],
  factor_count integer not null default 0,
  state text not null default 'prepared',
  recovery_codes_revoked integer,
  trusted_devices_revoked integer,
  security_keys_revoked integer,
  security_key_sessions_revoked integer,
  prepared_at timestamptz not null default clock_timestamp(),
  auth_mutation_started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  recovery_attempts integer not null default 0,
  recovery_next_attempt_at timestamptz not null default clock_timestamp(),
  recovery_last_error text,
  recovery_quarantined_at timestamptz,
  constraint admin_mfa_reset_operations_factor_count_check
    check (factor_count = cardinality(factor_ids) and factor_count between 0 and 64),
  constraint admin_mfa_reset_operations_state_check
    check (state in ('prepared', 'deleting', 'completed')),
  constraint admin_mfa_reset_operations_result_check
    check (
      (
        state = 'completed'
        and completed_at is not null
        and auth_mutation_started_at is not null
        and recovery_codes_revoked is not null
        and trusted_devices_revoked is not null
        and security_keys_revoked is not null
        and security_key_sessions_revoked is not null
      )
      or (
        state <> 'completed'
        and completed_at is null
        and recovery_codes_revoked is null
        and trusted_devices_revoked is null
        and security_keys_revoked is null
        and security_key_sessions_revoked is null
      )
    ),
  constraint admin_mfa_reset_operations_counts_nonnegative_check
    check (
      coalesce(recovery_codes_revoked, 0) >= 0
      and coalesce(trusted_devices_revoked, 0) >= 0
      and coalesce(security_keys_revoked, 0) >= 0
      and coalesce(security_key_sessions_revoked, 0) >= 0
    ),
  constraint admin_mfa_reset_operations_recovery_attempts_check
    check (recovery_attempts between 0 and 8),
  constraint admin_mfa_reset_operations_recovery_error_check
    check (recovery_last_error is null or char_length(recovery_last_error) between 1 and 512),
  constraint admin_mfa_reset_operations_recovery_quarantine_check
    check (recovery_quarantined_at is null or recovery_attempts = 8)
);

alter table private.admin_mfa_reset_operations enable row level security;

create index if not exists admin_mfa_reset_operations_recovery_idx
  on private.admin_mfa_reset_operations(recovery_next_attempt_at, id)
  where state = 'deleting' and recovery_quarantined_at is null;

revoke all on table private.admin_mfa_reset_operations
  from public, anon, authenticated, service_role;

create or replace function private.admin_mfa_reset_operation_payload(
  operation private.admin_mfa_reset_operations
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'operationId', operation.id,
    'employeeId', operation.employee_id,
    'authUserId', operation.auth_user_id,
    'actorEmployeeId', operation.reset_by,
    'factorIds', to_jsonb(operation.factor_ids),
    'factorCount', operation.factor_count,
    'state', operation.state,
    'recoveryCodesRevoked', operation.recovery_codes_revoked,
    'trustedDevicesRevoked', operation.trusted_devices_revoked,
    'securityKeysRevoked', operation.security_keys_revoked,
    'securityKeySessionsRevoked', operation.security_key_sessions_revoked,
    'preparedAt', operation.prepared_at,
    'authMutationStartedAt', operation.auth_mutation_started_at,
    'completedAt', operation.completed_at,
    'recoveryAttempts', operation.recovery_attempts,
    'recoveryNextAttemptAt', operation.recovery_next_attempt_at,
    'recoveryLastError', operation.recovery_last_error,
    'recoveryQuarantinedAt', operation.recovery_quarantined_at
  )
$$;

revoke all on function private.admin_mfa_reset_operation_payload(private.admin_mfa_reset_operations)
  from public, anon, authenticated, service_role;

create or replace function private.require_admin_mfa_reset_identity(
  operation private.admin_mfa_reset_operations,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if operation.reset_by is distinct from target_actor_employee_id
    or operation.employee_id is distinct from target_employee_id
    or operation.auth_user_id is distinct from target_auth_user_id
  then
    raise check_violation using message = 'The MFA reset operation identity does not match.';
  end if;
end
$$;

revoke all on function private.require_admin_mfa_reset_identity(private.admin_mfa_reset_operations, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.service_get_admin_mfa_reset_operation(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  operation private.admin_mfa_reset_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_operation_id is null then
    raise check_violation using message = 'A valid MFA reset operation is required.';
  end if;

  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id;
  if not found then return null; end if;

  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

create or replace function public.service_begin_admin_mfa_reset_operation(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_factor_ids jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  expected_auth_user_id uuid;
  operation private.admin_mfa_reset_operations%rowtype;
  clean_factor_ids uuid[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_operation_id is null
    or target_actor_employee_id is null
    or target_employee_id is null
    or target_auth_user_id is null
  then
    raise check_violation using message = 'A complete MFA reset operation identity is required.';
  end if;
  if jsonb_typeof(target_factor_ids) is distinct from 'array'
    or jsonb_array_length(target_factor_ids) > 64
  then
    raise check_violation using message = 'The MFA factor manifest is invalid.';
  end if;

  begin
    select coalesce(array_agg(distinct factor_id order by factor_id), array[]::uuid[])
    into clean_factor_ids
    from (
      select nullif(btrim(value), '')::uuid as factor_id
      from jsonb_array_elements_text(target_factor_ids)
    ) manifest
    where factor_id is not null;
  exception when invalid_text_representation then
    raise check_violation using message = 'The MFA factor manifest is invalid.';
  end;

  if cardinality(clean_factor_ids) <> jsonb_array_length(target_factor_ids) then
    raise check_violation using message = 'The MFA factor manifest must contain unique factor identities.';
  end if;

  if not exists (
    select 1 from public.employees employee
    where employee.id = target_actor_employee_id
      and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The reset operator was not an active employee.';
  end if;

  select account.auth_user_id into expected_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_employee_id;
  if expected_auth_user_id is null or expected_auth_user_id <> target_auth_user_id then
    raise check_violation using message = 'The employee login account did not match the reset request.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-mfa-reset:' || target_operation_id::text, 0)
  );

  insert into private.admin_mfa_reset_operations(
    id, employee_id, auth_user_id, reset_by, factor_ids, factor_count
  ) values (
    target_operation_id,
    target_employee_id,
    target_auth_user_id,
    target_actor_employee_id,
    clean_factor_ids,
    cardinality(clean_factor_ids)
  )
  on conflict (id) do nothing;

  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id
  for update;

  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

create or replace function public.service_mark_admin_mfa_reset_deleting(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_mfa_reset_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id
  for update;
  if not found then raise no_data_found using message = 'MFA reset operation was not found.'; end if;

  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  if operation.state = 'prepared' then
    update private.admin_mfa_reset_operations item
    set state = 'deleting',
        auth_mutation_started_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where item.id = operation.id
    returning * into operation;
  end if;
  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

create or replace function public.service_extend_admin_mfa_reset_manifest(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_factor_ids jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_mfa_reset_operations%rowtype;
  supplied_factor_ids uuid[];
  merged_factor_ids uuid[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if jsonb_typeof(target_factor_ids) is distinct from 'array'
    or jsonb_array_length(target_factor_ids) > 64
  then
    raise check_violation using message = 'The MFA factor manifest is invalid.';
  end if;
  begin
    select coalesce(array_agg(distinct factor_id order by factor_id), array[]::uuid[])
    into supplied_factor_ids
    from (
      select nullif(btrim(value), '')::uuid as factor_id
      from jsonb_array_elements_text(target_factor_ids)
    ) manifest
    where factor_id is not null;
  exception when invalid_text_representation then
    raise check_violation using message = 'The MFA factor manifest is invalid.';
  end;
  if cardinality(supplied_factor_ids) <> jsonb_array_length(target_factor_ids) then
    raise check_violation using message = 'The MFA factor manifest must contain unique factor identities.';
  end if;

  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id
  for update;
  if not found then raise no_data_found using message = 'MFA reset operation was not found.'; end if;
  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  if operation.state = 'completed' then
    return private.admin_mfa_reset_operation_payload(operation);
  end if;
  if operation.state <> 'deleting' then
    raise check_violation using message = 'MFA factor deletion has not started.';
  end if;

  select coalesce(array_agg(distinct factor_id order by factor_id), array[]::uuid[])
  into merged_factor_ids
  from unnest(operation.factor_ids || supplied_factor_ids) factor_id;
  if cardinality(merged_factor_ids) > 64 then
    raise check_violation using message = 'The MFA factor manifest is too large.';
  end if;

  update private.admin_mfa_reset_operations item
  set factor_ids = merged_factor_ids,
      factor_count = cardinality(merged_factor_ids),
      updated_at = clock_timestamp()
  where item.id = operation.id
  returning * into operation;
  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

create or replace function public.service_complete_admin_mfa_reset_operation(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_mfa_reset_operations%rowtype;
  recovery_revoked_count integer := 0;
  trusted_revoked_count integer := 0;
  keys_revoked_count integer := 0;
  sessions_revoked_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id
  for update;
  if not found then raise no_data_found using message = 'MFA reset operation was not found.'; end if;

  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  if operation.state = 'completed' then
    return private.admin_mfa_reset_operation_payload(operation);
  end if;
  if operation.state <> 'deleting' then
    raise check_violation using message = 'MFA factor deletion has not been durably started.';
  end if;

  update private.mfa_recovery_codes code
  set revoked_at = clock_timestamp(), revoked_by = operation.reset_by
  where code.employee_id = operation.employee_id
    and code.used_at is null
    and code.revoked_at is null;
  get diagnostics recovery_revoked_count = row_count;

  update private.trusted_devices trusted_device
  set revoked_at = clock_timestamp(), revoked_by = operation.reset_by
  where trusted_device.employee_id = operation.employee_id
    and trusted_device.revoked_at is null
    and trusted_device.expires_at > now();
  get diagnostics trusted_revoked_count = row_count;

  update private.webauthn_credentials credential
  set revoked_at = clock_timestamp(), revoked_by = operation.reset_by
  where credential.employee_id = operation.employee_id
    and credential.revoked_at is null;
  get diagnostics keys_revoked_count = row_count;

  update private.security_key_sessions security_session
  set revoked_at = clock_timestamp(), revoked_by = operation.reset_by
  where security_session.employee_id = operation.employee_id
    and security_session.revoked_at is null;
  get diagnostics sessions_revoked_count = row_count;

  update private.employee_accounts account
  set mfa_enrolled_at = null
  where account.employee_id = operation.employee_id
    and account.auth_user_id = operation.auth_user_id;
  if not found then
    raise check_violation using message = 'The employee login account changed during the MFA reset.';
  end if;

  insert into private.employee_mfa_reset_events(
    operation_id,
    employee_id,
    auth_user_id,
    factors_removed,
    trusted_devices_revoked,
    reset_by,
    request_id
  ) values (
    operation.id,
    operation.employee_id,
    operation.auth_user_id,
    operation.factor_count,
    trusted_revoked_count,
    operation.reset_by,
    operation.id::text
  );

  update private.admin_mfa_reset_operations item
  set state = 'completed',
      recovery_codes_revoked = recovery_revoked_count,
      trusted_devices_revoked = trusted_revoked_count,
      security_keys_revoked = keys_revoked_count,
      security_key_sessions_revoked = sessions_revoked_count,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where item.id = operation.id
  returning * into operation;

  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

create or replace function public.service_list_admin_mfa_reset_recovery(
  target_limit integer default 10
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    private.admin_mfa_reset_operation_payload(operation)
    order by operation.updated_at, operation.id
  ), '[]'::jsonb)
  from (
    select item.*
    from private.admin_mfa_reset_operations item
    where item.state = 'deleting'
      and item.recovery_quarantined_at is null
      and item.recovery_next_attempt_at <= clock_timestamp()
      and item.updated_at <= clock_timestamp() - interval '1 minute'
    order by item.recovery_next_attempt_at, item.id
    limit greatest(1, least(coalesce(target_limit, 10), 25))
  ) operation
  where (select auth.role()) = 'service_role'
$$;

create or replace function public.service_defer_admin_mfa_reset_recovery(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_mfa_reset_operations%rowtype;
  next_attempt_count integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id
  for update;
  if not found then raise no_data_found using message = 'MFA reset operation was not found.'; end if;
  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  if operation.state = 'completed' then
    return private.admin_mfa_reset_operation_payload(operation);
  end if;
  if operation.state <> 'deleting' then
    raise check_violation using message = 'Only an in-progress MFA reset may be deferred.';
  end if;

  next_attempt_count := least(8, operation.recovery_attempts + 1);
  update private.admin_mfa_reset_operations item
  set recovery_attempts = next_attempt_count,
      recovery_next_attempt_at = clock_timestamp() + pg_catalog.make_interval(
        mins => least(360, 15 * pg_catalog.power(2, least(operation.recovery_attempts, 4))::integer)
      ),
      recovery_last_error = left(
        coalesce(nullif(btrim(target_error), ''), 'Unknown MFA reset recovery failure.'),
        512
      ),
      recovery_quarantined_at = case
        when next_attempt_count = 8 then clock_timestamp()
        else null
      end,
      updated_at = clock_timestamp()
  where item.id = operation.id
  returning * into operation;
  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

create or replace function public.service_resume_admin_mfa_reset_recovery(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_mfa_reset_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select item.* into operation
  from private.admin_mfa_reset_operations item
  where item.id = target_operation_id
  for update;
  if not found then raise no_data_found using message = 'MFA reset operation was not found.'; end if;
  perform private.require_admin_mfa_reset_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id
  );
  if operation.state <> 'deleting' then
    return private.admin_mfa_reset_operation_payload(operation);
  end if;

  update private.admin_mfa_reset_operations item
  set recovery_attempts = 0,
      recovery_next_attempt_at = clock_timestamp(),
      recovery_quarantined_at = null,
      updated_at = clock_timestamp()
  where item.id = operation.id
  returning * into operation;
  return private.admin_mfa_reset_operation_payload(operation);
end
$$;

-- Password-reset delivery is already fenced by its durable email source id.
-- Bind the append-only audit event to that same UUID and return the original
-- result on replay instead of inserting a second event/triggered audit row.
create or replace function public.service_get_employee_password_reset_operation(
  target_operation_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_delivery_email_masked text,
  target_actor_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  event_record private.employee_password_reset_events%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select event.* into event_record
  from private.employee_password_reset_events event
  where event.operation_id = target_operation_id;
  if not found then return null; end if;
  if event_record.employee_id is distinct from target_employee_id
    or event_record.auth_user_id is distinct from target_auth_user_id
    or event_record.delivery_email_masked is distinct from btrim(target_delivery_email_masked)
    or event_record.reset_by is distinct from target_actor_employee_id
  then
    raise check_violation using message = 'The password-reset operation identity does not match.';
  end if;
  return jsonb_build_object(
    'recorded', true,
    'operationId', event_record.operation_id,
    'employeeId', event_record.employee_id,
    'resetBy', event_record.reset_by,
    'deliveryEmailMasked', event_record.delivery_email_masked,
    'requestedAt', event_record.requested_at
  );
end
$$;

create or replace function public.service_record_employee_password_reset(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_delivery_email_masked text,
  target_actor_employee_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  expected_auth_user_id uuid;
  operation_id uuid;
  event_record private.employee_password_reset_events%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if nullif(btrim(target_delivery_email_masked), '') is null then
    raise check_violation using message = 'A masked delivery address is required.';
  end if;
  begin
    operation_id := nullif(btrim(target_request_id), '')::uuid;
  exception when invalid_text_representation then
    raise check_violation using message = 'A valid password-reset operation id is required.';
  end;
  if operation_id is null then
    raise check_violation using message = 'A valid password-reset operation id is required.';
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.id = target_actor_employee_id
      and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The reset operator was not an active employee.';
  end if;

  select account.auth_user_id into expected_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_employee_id;
  if expected_auth_user_id is null or expected_auth_user_id <> target_auth_user_id then
    raise check_violation using message = 'The employee login account did not match the reset request.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-password-reset:' || operation_id::text, 0)
  );

  select event.* into event_record
  from private.employee_password_reset_events event
  where event.operation_id = operation_id;
  if found then
    if event_record.employee_id is distinct from target_employee_id
      or event_record.auth_user_id is distinct from target_auth_user_id
      or event_record.delivery_email_masked is distinct from btrim(target_delivery_email_masked)
      or event_record.reset_by is distinct from target_actor_employee_id
    then
      raise check_violation using message = 'The password-reset operation identity does not match.';
    end if;
  else
    insert into private.employee_password_reset_events(
      operation_id,
      employee_id,
      auth_user_id,
      delivery_email_masked,
      reset_by,
      request_id
    ) values (
      operation_id,
      target_employee_id,
      target_auth_user_id,
      btrim(target_delivery_email_masked),
      target_actor_employee_id,
      operation_id::text
    )
    returning * into event_record;
  end if;

  return jsonb_build_object(
    'recorded', true,
    'operationId', event_record.operation_id,
    'employeeId', event_record.employee_id,
    'resetBy', event_record.reset_by,
    'deliveryEmailMasked', event_record.delivery_email_masked,
    'requestedAt', event_record.requested_at
  );
end
$$;

revoke all on function public.service_get_admin_mfa_reset_operation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_begin_admin_mfa_reset_operation(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.service_mark_admin_mfa_reset_deleting(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_extend_admin_mfa_reset_manifest(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.service_complete_admin_mfa_reset_operation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_list_admin_mfa_reset_recovery(integer)
  from public, anon, authenticated;
revoke all on function public.service_defer_admin_mfa_reset_recovery(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_resume_admin_mfa_reset_recovery(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_get_employee_password_reset_operation(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.service_record_employee_password_reset(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.service_get_admin_mfa_reset_operation(uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_begin_admin_mfa_reset_operation(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
grant execute on function public.service_mark_admin_mfa_reset_deleting(uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_extend_admin_mfa_reset_manifest(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
grant execute on function public.service_complete_admin_mfa_reset_operation(uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_list_admin_mfa_reset_recovery(integer)
  to service_role;
grant execute on function public.service_defer_admin_mfa_reset_recovery(uuid, uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.service_resume_admin_mfa_reset_recovery(uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function public.service_get_employee_password_reset_operation(uuid, uuid, uuid, text, uuid)
  to service_role;
grant execute on function public.service_record_employee_password_reset(uuid, uuid, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Emergency revocation is deliberately separate from employment status. It
-- invalidates every SygShift application token immediately while preserving
-- employee, schedule, punch, payroll, role, and historical records.
alter table private.employee_accounts
  add column if not exists auth_tokens_invalid_before_epoch bigint not null default 0,
  add column if not exists current_emergency_revocation_id uuid;

create table if not exists private.emergency_access_operations (
  operation_request_id uuid primary key,
  action text not null check (action in ('revoke', 'restore')),
  status text not null check (status in ('provider_pending', 'provider_failed', 'completed')),
  target_employee_id uuid not null references public.employees(id) on delete restrict,
  target_auth_user_id uuid not null references auth.users(id) on delete restrict,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  actor_auth_session_id uuid not null,
  revocation_operation_id uuid references private.emergency_access_operations(operation_request_id) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 10 and 1000),
  confirmation_username text not null,
  acknowledged boolean not null check (acknowledged),
  mfa_method text not null check (mfa_method in ('authenticator', 'security_key')),
  mfa_verified_at timestamptz not null,
  provider_attempt_count integer not null default 1 check (provider_attempt_count > 0),
  provider_result jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_result) = 'object'),
  provider_error_code text,
  cleanup_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(cleanup_counts) = 'object'),
  before_state jsonb not null default '{}'::jsonb check (jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null default '{}'::jsonb check (jsonb_typeof(after_state) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint emergency_access_operation_restore_parent check (
    (action = 'revoke' and revocation_operation_id is null)
    or (action = 'restore' and revocation_operation_id is not null)
  ),
  constraint emergency_access_operation_completion check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint emergency_access_provider_error_length check (
    provider_error_code is null or char_length(provider_error_code) <= 160
  )
);

create index if not exists emergency_access_operations_target_created_idx
  on private.emergency_access_operations(target_employee_id, created_at desc);
create index if not exists emergency_access_operations_open_idx
  on private.emergency_access_operations(status, created_at)
  where status <> 'completed';

create table if not exists private.emergency_access_operation_events (
  id bigint generated always as identity primary key,
  operation_request_id uuid not null references private.emergency_access_operations(operation_request_id) on delete restrict,
  event_type text not null,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint emergency_access_event_type_present check (char_length(btrim(event_type)) between 3 and 80)
);

create index if not exists emergency_access_operation_events_operation_idx
  on private.emergency_access_operation_events(operation_request_id, occurred_at, id);

-- A tombstoned auth session remains denied even if an upstream provider takes
-- time to complete its ban or a stale JWT survives in a browser cache.
create table if not exists private.emergency_revoked_auth_sessions (
  auth_session_id uuid primary key,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  revocation_operation_id uuid not null references private.emergency_access_operations(operation_request_id) on delete restrict,
  revoked_by uuid not null references public.employees(id) on delete restrict,
  revoked_at timestamptz not null default clock_timestamp()
);

create index if not exists emergency_revoked_auth_sessions_employee_idx
  on private.emergency_revoked_auth_sessions(employee_id, revoked_at desc);

alter table private.emergency_access_operations enable row level security;
alter table private.emergency_access_operations force row level security;
alter table private.emergency_access_operation_events enable row level security;
alter table private.emergency_access_operation_events force row level security;
alter table private.emergency_revoked_auth_sessions enable row level security;
alter table private.emergency_revoked_auth_sessions force row level security;

revoke all on private.emergency_access_operations from public, anon, authenticated;
revoke all on private.emergency_access_operation_events from public, anon, authenticated;
revoke all on private.emergency_revoked_auth_sessions from public, anon, authenticated;

drop trigger if exists emergency_access_operation_events_append_only
  on private.emergency_access_operation_events;
create trigger emergency_access_operation_events_append_only
before update or delete on private.emergency_access_operation_events
for each row execute function private.prevent_append_only_change();

drop trigger if exists emergency_revoked_auth_sessions_append_only
  on private.emergency_revoked_auth_sessions;
create trigger emergency_revoked_auth_sessions_append_only
before update or delete on private.emergency_revoked_auth_sessions
for each row execute function private.prevent_append_only_change();

-- Standard Supabase JWTs carry session_id and iat. Requiring the matching live
-- session, an unexpired token epoch, and no emergency tombstone turns the
-- database into the final denial boundary instead of trusting browser logout.
create or replace function private.current_employee_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  jwt_session_text text := (select auth.jwt() ->> 'session_id');
  jwt_issued_text text := (select auth.jwt() ->> 'iat');
  jwt_session_id uuid;
  jwt_issued_epoch bigint;
  resolved_employee_id uuid;
begin
  if (select auth.uid()) is null or jwt_session_text is null then
    return null;
  end if;

  begin
    jwt_session_id := jwt_session_text::uuid;
    if jwt_issued_text is not null then
      jwt_issued_epoch := floor(jwt_issued_text::numeric)::bigint;
    end if;
  exception when others then
    return null;
  end;

  select account.employee_id
  into resolved_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  join auth.sessions auth_session
    on auth_session.id = jwt_session_id
   and auth_session.user_id = account.auth_user_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
    and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
    and coalesce(
      jwt_issued_epoch,
      floor(extract(epoch from auth_session.created_at))::bigint
    ) >= account.auth_tokens_invalid_before_epoch
    and not exists (
      select 1
      from private.emergency_revoked_auth_sessions tombstone
      where tombstone.auth_session_id = jwt_session_id
        and tombstone.auth_user_id = account.auth_user_id
    )
  limit 1;

  return resolved_employee_id;
end
$$;

revoke all on function private.current_employee_id() from public, anon, authenticated;
grant execute on function private.current_employee_id() to service_role;

do $emergency_access_marker_fk$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.employee_accounts'::regclass
      and constraint_record.conname = 'employee_accounts_emergency_revocation_fkey'
  ) then
    alter table private.employee_accounts
      add constraint employee_accounts_emergency_revocation_fkey
      foreign key (current_emergency_revocation_id)
      references private.emergency_access_operations(operation_request_id)
      on delete restrict;
  end if;
end
$emergency_access_marker_fk$;

create or replace function private.require_emergency_access_viewer(
  target_actor_id uuid
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
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_actor_id
      and employee.status = 'active'
      and account.activated_at is not null
      and account.disabled_at is null
      and account.current_emergency_revocation_id is null
  ) then
    raise insufficient_privilege using message = 'An active administrator account is required.';
  end if;

  actor_permissions := private.employee_effective_permissions(target_actor_id);
  if not (
    'admin.users.manage' = any(coalesce(actor_permissions, array[]::text[]))
    and 'admin.security.manage' = any(coalesce(actor_permissions, array[]::text[]))
  ) then
    raise insufficient_privilege using message = 'User and security administration permissions are required.';
  end if;
end
$$;

revoke all on function private.require_emergency_access_viewer(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.require_emergency_access_actor(
  target_actor_id uuid,
  target_actor_auth_session_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_auth_user_id uuid;
begin
  perform private.require_emergency_access_viewer(target_actor_id);

  if target_mfa_method not in ('authenticator', 'security_key')
    or target_mfa_verified_at is null
    or target_mfa_verified_at < clock_timestamp() - interval '15 minutes'
    or target_mfa_verified_at > clock_timestamp() + interval '1 minute'
  then
    raise insufficient_privilege using message = 'A security verification from the last 15 minutes is required.';
  end if;

  select account.auth_user_id
  into actor_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_actor_id;

  if target_actor_auth_session_id is null or not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = target_actor_auth_session_id
      and auth_session.user_id = actor_auth_user_id
      and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
      and not exists (
        select 1
        from private.emergency_revoked_auth_sessions tombstone
        where tombstone.auth_session_id = auth_session.id
      )
  ) then
    raise insufficient_privilege using message = 'The authenticated administrator session is no longer active.';
  end if;
end
$$;

revoke all on function private.require_emergency_access_actor(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.emergency_access_state_json(
  target_employee_id_value uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  state_payload jsonb;
  external_shared_session_count integer := 0;
begin
  if to_regclass('public.sygilant_shared_identity_sessions') is not null then
    execute $query$
      select count(*)::integer
      from public.sygilant_shared_identity_sessions shared_session
      where shared_session.employee_id = $1
        and shared_session.revoked_at is null
        and shared_session.status = 'active'
        and shared_session.session_expires_at > clock_timestamp()
    $query$
    into external_shared_session_count
    using target_employee_id_value;
  end if;

  select jsonb_build_object(
    'employeeId', employee.id,
    'username', employee.username,
    'displayName', btrim(concat_ws(' ', coalesce(employee.preferred_name, employee.first_name), employee.last_name)),
    'employeeStatus', employee.status,
    'authUserId', account.auth_user_id,
    'authEmail', auth_user.email,
    'recoveryEmail', private.preferred_delivery_email(
      contact.personal_email,
      contact.company_email
    ),
    'accountState', case
      when account.current_emergency_revocation_id is not null
        and latest_operation.action = 'restore'
        and latest_operation.status = 'provider_pending' then 'restoration_pending'
      when account.current_emergency_revocation_id is not null
        and latest_operation.action = 'restore'
        and latest_operation.status = 'provider_failed' then 'restoration_attention'
      when account.current_emergency_revocation_id is not null
        and revocation_operation.status = 'provider_pending' then 'revocation_pending'
      when account.current_emergency_revocation_id is not null
        and revocation_operation.status = 'provider_failed' then 'revocation_attention'
      when account.current_emergency_revocation_id is not null then 'revoked'
      when account.disabled_at is not null then 'legacy_disabled'
      else 'active'
    end,
    'disabledAt', account.disabled_at,
    'disabledBy', account.disabled_by,
    'disabledReason', account.disabled_reason,
    'emergencyRevocationId', account.current_emergency_revocation_id,
    'authTokensInvalidBeforeEpoch', account.auth_tokens_invalid_before_epoch,
    'authBannedUntil', auth_user.banned_until,
    'authBanned', coalesce(auth_user.banned_until > clock_timestamp(), false),
    'activeSessionCounts', jsonb_build_object(
      'auth', (
        select count(*)::integer
        from auth.sessions auth_session
        where auth_session.user_id = account.auth_user_id
          and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
      ),
      'refreshTokens', (
        select count(*)::integer
        from auth.refresh_tokens refresh_token
        where refresh_token.user_id = account.auth_user_id::text
          and not refresh_token.revoked
      ),
      'trustedDevices', (
        select count(*)::integer
        from private.trusted_devices trusted_device
        where trusted_device.employee_id = employee.id
          and trusted_device.revoked_at is null
          and trusted_device.expires_at > clock_timestamp()
      ),
      'securityKeys', (
        select count(*)::integer
        from private.security_key_sessions security_session
        where security_session.employee_id = employee.id
          and security_session.revoked_at is null
          and security_session.expires_at > clock_timestamp()
      ),
      'sharedIdentity', (
        select count(*)::integer
        from private.shared_identity_sessions shared_session
        where shared_session.employee_id = employee.id
          and shared_session.revoked_at is null
          and shared_session.expires_at > clock_timestamp()
      ),
      'sygilantSharedIdentity', external_shared_session_count,
      'presence', (
        select count(*)::integer
        from private.platform_presence_sessions presence_session
        where presence_session.employee_id = employee.id
          and presence_session.expires_at > clock_timestamp()
      ),
      'push', (
        select count(*)::integer
        from private.employee_push_subscriptions subscription
        where subscription.employee_id = employee.id
          and subscription.enabled
      )
    ),
    'latestOperation', case when latest_operation.operation_request_id is null then null else jsonb_build_object(
      'operationRequestId', latest_operation.operation_request_id,
      'action', latest_operation.action,
      'status', latest_operation.status,
      'reason', latest_operation.reason,
      'actorEmployeeId', latest_operation.actor_employee_id,
      'providerAttemptCount', latest_operation.provider_attempt_count,
      'providerResult', latest_operation.provider_result,
      'providerErrorCode', latest_operation.provider_error_code,
      'cleanupCounts', latest_operation.cleanup_counts,
      'createdAt', latest_operation.created_at,
      'updatedAt', latest_operation.updated_at,
      'completedAt', latest_operation.completed_at
    ) end
  )
  into state_payload
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  join auth.users auth_user on auth_user.id = account.auth_user_id
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join lateral (
    select operation.*
    from private.emergency_access_operations operation
    where operation.target_employee_id = employee.id
    order by operation.created_at desc, operation.operation_request_id desc
    limit 1
  ) latest_operation on true
  left join private.emergency_access_operations revocation_operation
    on revocation_operation.operation_request_id = account.current_emergency_revocation_id
  where employee.id = target_employee_id_value;

  if state_payload is null then
    raise no_data_found using message = 'The employee login account was not found.';
  end if;

  return state_payload;
end
$$;

revoke all on function private.emergency_access_state_json(uuid)
  from public, anon, authenticated;

create or replace function private.emergency_access_operation_payload(
  target_operation_request_id_value uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'operation', jsonb_build_object(
      'operationRequestId', operation.operation_request_id,
      'action', operation.action,
      'status', operation.status,
      'targetEmployeeId', operation.target_employee_id,
      'actorEmployeeId', operation.actor_employee_id,
      'providerAttemptCount', operation.provider_attempt_count,
      'providerResult', operation.provider_result,
      'providerErrorCode', operation.provider_error_code,
      'cleanupCounts', operation.cleanup_counts,
      'createdAt', operation.created_at,
      'updatedAt', operation.updated_at,
      'completedAt', operation.completed_at
    ),
    'providerResult', operation.provider_result,
    'state', private.emergency_access_state_json(operation.target_employee_id)
  )
  from private.emergency_access_operations operation
  where operation.operation_request_id = target_operation_request_id_value
$$;

revoke all on function private.emergency_access_operation_payload(uuid)
  from public, anon, authenticated;

create or replace function private.emergency_access_cleanup(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_operation_request_id uuid,
  target_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  auth_session_tombstones integer := 0;
  trusted_device_count integer := 0;
  security_key_session_count integer := 0;
  shared_identity_count integer := 0;
  sygilant_shared_identity_count integer := 0;
  presence_count integer := 0;
  push_count integer := 0;
  pending_launch_count integer := 0;
  webauthn_challenge_count integer := 0;
begin
  insert into private.emergency_revoked_auth_sessions (
    auth_session_id,
    auth_user_id,
    employee_id,
    revocation_operation_id,
    revoked_by
  )
  select
    auth_session.id,
    target_auth_user_id,
    target_employee_id,
    target_operation_request_id,
    target_actor_id
  from auth.sessions auth_session
  where auth_session.user_id = target_auth_user_id
    and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  on conflict (auth_session_id) do nothing;
  get diagnostics auth_session_tombstones = row_count;

  update private.trusted_devices trusted_device
  set revoked_at = coalesce(trusted_device.revoked_at, clock_timestamp()),
      revoked_by = coalesce(trusted_device.revoked_by, target_actor_id)
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null;
  get diagnostics trusted_device_count = row_count;

  update private.security_key_sessions security_session
  set revoked_at = coalesce(security_session.revoked_at, clock_timestamp()),
      revoked_by = coalesce(security_session.revoked_by, target_actor_id)
  where security_session.employee_id = target_employee_id
    and security_session.revoked_at is null;
  get diagnostics security_key_session_count = row_count;

  update private.shared_identity_sessions shared_session
  set revoked_at = coalesce(shared_session.revoked_at, clock_timestamp())
  where shared_session.employee_id = target_employee_id
    and shared_session.revoked_at is null;
  get diagnostics shared_identity_count = row_count;

  delete from private.platform_presence_sessions presence_session
  where presence_session.employee_id = target_employee_id;
  get diagnostics presence_count = row_count;

  update private.employee_push_subscriptions subscription
  set enabled = false,
      updated_at = clock_timestamp()
  where subscription.employee_id = target_employee_id
    and subscription.enabled;
  get diagnostics push_count = row_count;

  -- Authentication challenges are ephemeral, not enrolled security keys. A
  -- revocation invalidates outstanding challenges without deleting factors.
  delete from private.webauthn_challenges challenge
  where challenge.employee_id = target_employee_id
    and challenge.consumed_at is null;
  get diagnostics webauthn_challenge_count = row_count;

  update private.sygilant_shared_launches launch
  set consumed_at = coalesce(launch.consumed_at, clock_timestamp()),
      consume_context = coalesce(launch.consume_context, '{}'::jsonb) || jsonb_build_object(
        'emergencyRevocationId', target_operation_request_id,
        'retiredBy', target_actor_id,
        'retiredAt', clock_timestamp()
      )
  where launch.employee_id = target_employee_id
    and launch.consumed_at is null;
  get diagnostics pending_launch_count = row_count;

  -- The Sygilant session table shares this database but is owned by the
  -- Sygilant release stream. Update it only when the complete known contract
  -- is present; never create or redefine that cross-application table here.
  if to_regclass('public.sygilant_shared_identity_sessions') is not null
    and exists (
      select 1 from pg_catalog.pg_attribute attribute_record
      where attribute_record.attrelid = 'public.sygilant_shared_identity_sessions'::regclass
        and attribute_record.attname = 'revocation_request_id'
        and not attribute_record.attisdropped
    )
  then
    execute $update_sygilant$
      update public.sygilant_shared_identity_sessions shared_session
      set status = 'revoked',
          revoked_at = coalesce(shared_session.revoked_at, clock_timestamp()),
          revocation_request_id = coalesce(shared_session.revocation_request_id, $1::text),
          updated_at = clock_timestamp()
      where shared_session.employee_id = $2
        and shared_session.revoked_at is null
    $update_sygilant$
    using target_operation_request_id, target_employee_id;
    get diagnostics sygilant_shared_identity_count = row_count;
  end if;

  return jsonb_build_object(
    'authSessionTombstones', auth_session_tombstones,
    'trustedDevicesRevoked', trusted_device_count,
    'securityKeySessionsRevoked', security_key_session_count,
    'sharedIdentitySessionsRevoked', shared_identity_count,
    'sygilantSharedSessionsRevoked', sygilant_shared_identity_count,
    'presenceSessionsRemoved', presence_count,
    'pushSubscriptionsDisabled', push_count,
    'pendingLaunchesRetired', pending_launch_count,
    'webauthnChallengesRemoved', webauthn_challenge_count
  );
end
$$;

revoke all on function private.emergency_access_cleanup(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.service_get_employee_emergency_access_state(
  target_actor_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_emergency_access_viewer(target_actor_id);
  return private.emergency_access_state_json(target_employee_id);
end
$$;

revoke all on function public.service_get_employee_emergency_access_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.service_get_employee_emergency_access_state(uuid, uuid)
  to service_role;

create or replace function private.begin_emergency_access_operation(
  target_action text,
  target_actor_id uuid,
  target_employee_id uuid,
  target_operation_request_id uuid,
  target_reason text,
  target_confirmation_username text,
  target_acknowledged boolean,
  target_actor_auth_session_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_reason text := btrim(coalesce(target_reason, ''));
  clean_confirmation_username text := btrim(coalesce(target_confirmation_username, ''));
  employee_record public.employees%rowtype;
  account_record private.employee_accounts%rowtype;
  existing_operation private.emergency_access_operations%rowtype;
  revocation_operation private.emergency_access_operations%rowtype;
  actor_role public.app_role;
  recovery_email text;
  cleanup_result jsonb;
  before_payload jsonb;
  after_payload jsonb;
  invalid_before_epoch bigint := floor(extract(epoch from clock_timestamp()))::bigint;
begin
  if target_action not in ('revoke', 'restore') then
    raise check_violation using message = 'Choose a supported emergency access action.';
  end if;
  if target_operation_request_id is null then
    raise check_violation using message = 'An operation request identifier is required.';
  end if;
  if char_length(clean_reason) not between 10 and 1000 then
    raise check_violation using message = 'Enter a reason between 10 and 1,000 characters.';
  end if;
  if not coalesce(target_acknowledged, false) then
    raise check_violation using message = 'Confirm that employment and business records will remain unchanged.';
  end if;

  perform private.require_emergency_access_actor(
    target_actor_id,
    target_actor_auth_session_id,
    target_mfa_method,
    target_mfa_verified_at
  );

  if target_actor_id = target_employee_id then
    raise check_violation using message = 'You cannot revoke or restore your own access from this control.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sygshift.emergency-access:' || target_employee_id::text, 0));

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  select account.*
  into account_record
  from private.employee_accounts account
  where account.employee_id = target_employee_id
  for update;
  if not found then
    raise check_violation using message = 'A login account has not been created for this employee yet.';
  end if;

  if clean_confirmation_username is distinct from employee_record.username then
    raise check_violation using message = 'Type the employee username exactly to continue.';
  end if;

  select employee.role
  into actor_role
  from public.employees employee
  where employee.id = target_actor_id;

  if employee_record.role = 'admin' and actor_role <> 'admin' then
    raise insufficient_privilege using message = 'A primary Admin must authorize access changes for another Admin.';
  end if;

  select operation.*
  into existing_operation
  from private.emergency_access_operations operation
  where operation.operation_request_id = target_operation_request_id
  for update;

  if found then
    if existing_operation.action is distinct from target_action
      or existing_operation.actor_employee_id is distinct from target_actor_id
      or existing_operation.target_employee_id is distinct from target_employee_id
      or existing_operation.reason is distinct from clean_reason
      or existing_operation.confirmation_username is distinct from clean_confirmation_username
    then
      raise unique_violation using message = 'This operation request identifier belongs to a different request.';
    end if;

    if existing_operation.status = 'provider_failed' then
      update private.emergency_access_operations operation
      set status = 'provider_pending',
          provider_attempt_count = operation.provider_attempt_count + 1,
          provider_result = operation.provider_result - 'error' - 'errorCode',
          provider_error_code = null,
          updated_at = clock_timestamp()
      where operation.operation_request_id = target_operation_request_id;

      insert into private.emergency_access_operation_events (
        operation_request_id, event_type, actor_employee_id, details
      ) values (
        target_operation_request_id,
        'provider_retry_started',
        target_actor_id,
        jsonb_build_object('priorProviderResultRetained', true)
      );
    end if;

    return private.emergency_access_operation_payload(target_operation_request_id);
  end if;

  if target_action = 'revoke' then
    if account_record.current_emergency_revocation_id is not null then
      raise check_violation using message = 'This account already has an active emergency revocation.';
    end if;

    if account_record.disabled_at is not null then
      raise check_violation using message = 'This account was disabled by an earlier control and cannot be converted into an emergency revocation without a separate access review.';
    end if;

    if employee_record.role = 'admin'
      and private.employee_is_recovery_capable_active_admin(target_employee_id)
    then
      perform pg_advisory_xact_lock(hashtextextended('sygshift.active_admin_recovery', 0));
      if private.active_admin_account_count() <= 1 then
        raise check_violation using message = 'At least one recovery-capable active Admin account must remain.';
      end if;
    end if;
  else
    if account_record.current_emergency_revocation_id is null then
      raise check_violation using message = 'This account does not have an emergency revocation to restore.';
    end if;

    select operation.*
    into revocation_operation
    from private.emergency_access_operations operation
    where operation.operation_request_id = account_record.current_emergency_revocation_id
    for update;

    if not found
      or revocation_operation.action <> 'revoke'
      or revocation_operation.status <> 'completed'
    then
      raise check_violation using message = 'Complete the existing access revocation before starting restoration.';
    end if;

    if employee_record.status <> 'active' then
      raise check_violation using message = 'Only an active employee account can be restored.';
    end if;

    select private.preferred_delivery_email(
      contact.personal_email,
      contact.company_email
    )
    into recovery_email
    from auth.users auth_user
    left join private.employee_contacts contact on contact.employee_id = target_employee_id
    where auth_user.id = account_record.auth_user_id;

    if recovery_email is null then
      raise check_violation using message = 'Add a verified employee delivery email before restoring access.';
    end if;
  end if;

  before_payload := private.emergency_access_state_json(target_employee_id);

  insert into private.emergency_access_operations (
    operation_request_id,
    action,
    status,
    target_employee_id,
    target_auth_user_id,
    actor_employee_id,
    actor_auth_session_id,
    revocation_operation_id,
    reason,
    confirmation_username,
    acknowledged,
    mfa_method,
    mfa_verified_at,
    before_state
  ) values (
    target_operation_request_id,
    target_action,
    'provider_pending',
    target_employee_id,
    account_record.auth_user_id,
    target_actor_id,
    target_actor_auth_session_id,
    case when target_action = 'restore' then account_record.current_emergency_revocation_id else null end,
    clean_reason,
    clean_confirmation_username,
    true,
    target_mfa_method,
    target_mfa_verified_at,
    before_payload
  );

  if target_action = 'revoke' then
    update private.employee_accounts account
    set disabled_at = coalesce(account.disabled_at, clock_timestamp()),
        disabled_by = target_actor_id,
        disabled_reason = 'Emergency access revocation: ' || clean_reason,
        current_emergency_revocation_id = target_operation_request_id,
        auth_tokens_invalid_before_epoch = greatest(
          account.auth_tokens_invalid_before_epoch,
          invalid_before_epoch
        ),
        updated_at = clock_timestamp()
    where account.employee_id = target_employee_id;
  else
    -- Restoration remains fail-closed until provider recovery delivery and
    -- unban both succeed and the finalizer verifies no old Auth session exists.
    update private.employee_accounts account
    set auth_tokens_invalid_before_epoch = greatest(
          account.auth_tokens_invalid_before_epoch,
          invalid_before_epoch
        ),
        updated_at = clock_timestamp()
    where account.employee_id = target_employee_id;
  end if;

  cleanup_result := private.emergency_access_cleanup(
    target_employee_id,
    account_record.auth_user_id,
    target_operation_request_id,
    target_actor_id
  );

  after_payload := private.emergency_access_state_json(target_employee_id);
  update private.emergency_access_operations operation
  set cleanup_counts = cleanup_result,
      after_state = after_payload,
      updated_at = clock_timestamp()
  where operation.operation_request_id = target_operation_request_id;

  insert into private.emergency_access_operation_events (
    operation_request_id, event_type, actor_employee_id, details
  ) values (
    target_operation_request_id,
    target_action || '_database_boundary_applied',
    target_actor_id,
    jsonb_build_object(
      'cleanupCounts', cleanup_result,
      'businessRecordsChanged', false,
      'providerActionPending', true
    )
  );

  insert into private.audit_events (
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
    (select account.auth_user_id from private.employee_accounts account where account.employee_id = target_actor_id),
    target_actor_id,
    target_operation_request_id::text,
    'private',
    'employee_accounts',
    case when target_action = 'revoke' then 'EMERGENCY_ACCESS_REVOKE_STARTED' else 'EMERGENCY_ACCESS_RESTORE_STARTED' end,
    target_employee_id::text,
    before_payload,
    after_payload
  );

  return private.emergency_access_operation_payload(target_operation_request_id);
end
$$;

revoke all on function private.begin_emergency_access_operation(
  text, uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.service_begin_emergency_access_revoke(
  target_actor_id uuid,
  target_employee_id uuid,
  target_operation_request_id uuid,
  target_reason text,
  target_confirmation_username text,
  target_acknowledged boolean,
  target_actor_auth_session_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.begin_emergency_access_operation(
    'revoke',
    target_actor_id,
    target_employee_id,
    target_operation_request_id,
    target_reason,
    target_confirmation_username,
    target_acknowledged,
    target_actor_auth_session_id,
    target_mfa_method,
    target_mfa_verified_at
  )
$$;

create or replace function public.service_begin_emergency_access_restore(
  target_actor_id uuid,
  target_employee_id uuid,
  target_operation_request_id uuid,
  target_reason text,
  target_confirmation_username text,
  target_acknowledged boolean,
  target_actor_auth_session_id uuid,
  target_mfa_method text,
  target_mfa_verified_at timestamptz
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.begin_emergency_access_operation(
    'restore',
    target_actor_id,
    target_employee_id,
    target_operation_request_id,
    target_reason,
    target_confirmation_username,
    target_acknowledged,
    target_actor_auth_session_id,
    target_mfa_method,
    target_mfa_verified_at
  )
$$;

revoke all on function public.service_begin_emergency_access_revoke(
  uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.service_begin_emergency_access_restore(
  uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.service_begin_emergency_access_revoke(
  uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz
) to service_role;
grant execute on function public.service_begin_emergency_access_restore(
  uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz
) to service_role;

-- Provider work is multi-step. Record recovery delivery before unbanning so a
-- crash cannot cause a retry to silently issue and email a second link. This
-- progress checkpoint is not a failure and never enables the account.
create or replace function public.service_record_emergency_access_provider_progress(
  target_actor_id uuid,
  target_operation_request_id uuid,
  target_action text,
  target_provider_progress jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.emergency_access_operations%rowtype;
  progress_value jsonb := coalesce(target_provider_progress, '{}'::jsonb);
  recovery_delivered_at timestamptz;
  recovery_usable_until timestamptz;
  recovery_email_masked text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if jsonb_typeof(progress_value) is distinct from 'object'
    or pg_column_size(progress_value) > 4096
    or progress_value - array[
      'recoveryDelivered',
      'recoveryDeliveredAt',
      'recoveryUsableUntil',
      'recoveryEmailMasked'
    ]::text[] <> '{}'::jsonb
  then
    raise check_violation using message = 'The provider progress payload was invalid.';
  end if;

  select operation.*
  into operation_record
  from private.emergency_access_operations operation
  where operation.operation_request_id = target_operation_request_id
  for update;
  if not found then
    raise no_data_found using message = 'The emergency access operation was not found.';
  end if;
  if operation_record.actor_employee_id is distinct from target_actor_id
    or operation_record.action is distinct from target_action
    or target_action <> 'restore'
  then
    raise insufficient_privilege using message = 'The emergency access operation does not match this progress update.';
  end if;
  if operation_record.status = 'completed' then
    return private.emergency_access_operation_payload(target_operation_request_id);
  end if;

  perform private.require_emergency_access_viewer(target_actor_id);

  begin
    recovery_delivered_at := nullif(progress_value ->> 'recoveryDeliveredAt', '')::timestamptz;
    recovery_usable_until := nullif(progress_value ->> 'recoveryUsableUntil', '')::timestamptz;
  exception when others then
    raise check_violation using message = 'The recovery delivery evidence was invalid.';
  end;
  recovery_email_masked := nullif(btrim(progress_value ->> 'recoveryEmailMasked'), '');

  if progress_value ->> 'recoveryDelivered' is distinct from 'true'
    or recovery_delivered_at is null
    or recovery_delivered_at < clock_timestamp() - interval '15 minutes'
    or recovery_delivered_at > clock_timestamp() + interval '1 minute'
    or recovery_usable_until is null
    or recovery_usable_until <= clock_timestamp()
    or recovery_usable_until > recovery_delivered_at + interval '24 hours'
    or recovery_email_masked is null
    or char_length(recovery_email_masked) > 320
  then
    raise check_violation using message = 'Complete, current recovery delivery evidence is required.';
  end if;

  update private.emergency_access_operations operation
  set status = 'provider_pending',
      provider_result = operation.provider_result || progress_value,
      provider_error_code = null,
      updated_at = clock_timestamp(),
      completed_at = null
  where operation.operation_request_id = target_operation_request_id;

  insert into private.emergency_access_operation_events (
    operation_request_id, event_type, actor_employee_id, details
  ) values (
    target_operation_request_id,
    'restore_recovery_delivery_recorded',
    target_actor_id,
    jsonb_build_object(
      'recoveryDeliveredAt', recovery_delivered_at,
      'recoveryUsableUntil', recovery_usable_until,
      'recoveryEmailMasked', recovery_email_masked,
      'accountRemainsDisabled', true
    )
  );

  return private.emergency_access_operation_payload(target_operation_request_id);
end
$$;

revoke all on function public.service_record_emergency_access_provider_progress(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_record_emergency_access_provider_progress(uuid, uuid, text, jsonb)
  to service_role;

create or replace function public.service_complete_emergency_access_operation(
  target_actor_id uuid,
  target_operation_request_id uuid,
  target_action text,
  target_auth_provider_succeeded boolean,
  target_auth_provider_result jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_record private.emergency_access_operations%rowtype;
  account_record private.employee_accounts%rowtype;
  provider_result_value jsonb := coalesce(target_auth_provider_result, '{}'::jsonb);
  provider_error_code_value text;
  active_auth_session_count integer;
  active_refresh_token_count integer;
  auth_banned_until timestamptz;
  recovery_delivered_at timestamptz;
  recovery_usable_until timestamptz;
  old_state jsonb;
  final_state jsonb;
  invalid_before_epoch bigint := floor(extract(epoch from clock_timestamp()))::bigint;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_operation_request_id is null
    or target_action not in ('revoke', 'restore')
  then
    raise check_violation using message = 'A valid emergency access operation is required.';
  end if;
  if jsonb_typeof(provider_result_value) is distinct from 'object'
    or pg_column_size(provider_result_value) > 16384
  then
    raise check_violation using message = 'The provider result was invalid.';
  end if;

  select operation.*
  into operation_record
  from private.emergency_access_operations operation
  where operation.operation_request_id = target_operation_request_id
  for update;
  if not found then
    raise no_data_found using message = 'The emergency access operation was not found.';
  end if;

  if operation_record.actor_employee_id is distinct from target_actor_id
    or operation_record.action is distinct from target_action
  then
    raise insufficient_privilege using message = 'The emergency access operation does not match this request.';
  end if;

  if operation_record.status = 'completed' then
    return private.emergency_access_operation_payload(target_operation_request_id);
  end if;

  provider_result_value := operation_record.provider_result || provider_result_value;

  perform private.require_emergency_access_viewer(target_actor_id);

  select account.*
  into account_record
  from private.employee_accounts account
  where account.employee_id = operation_record.target_employee_id
  for update;
  if not found or account_record.auth_user_id is distinct from operation_record.target_auth_user_id then
    raise check_violation using message = 'The employee login link changed while the operation was in progress.';
  end if;

  old_state := private.emergency_access_state_json(operation_record.target_employee_id);

  if not coalesce(target_auth_provider_succeeded, false) then
    provider_error_code_value := nullif(left(
      regexp_replace(
        coalesce(
          provider_result_value ->> 'errorCode',
          provider_result_value #>> '{error,code}',
          'provider_action_failed'
        ),
        '[^A-Za-z0-9_.:-]',
        '_',
        'g'
      ),
      160
    ), '');

    update private.emergency_access_operations operation
    set status = 'provider_failed',
        provider_result = operation.provider_result || provider_result_value,
        provider_error_code = coalesce(provider_error_code_value, 'provider_action_failed'),
        updated_at = clock_timestamp(),
        completed_at = null
    where operation.operation_request_id = target_operation_request_id;

    insert into private.emergency_access_operation_events (
      operation_request_id, event_type, actor_employee_id, details
    ) values (
      target_operation_request_id,
      target_action || '_provider_attention_required',
      target_actor_id,
      jsonb_build_object(
        'errorCode', coalesce(provider_error_code_value, 'provider_action_failed'),
        'providerResult', provider_result_value,
        'accountRemainsDisabled', true
      )
    );

    final_state := private.emergency_access_state_json(operation_record.target_employee_id);
    update private.emergency_access_operations operation
    set after_state = final_state
    where operation.operation_request_id = target_operation_request_id;

    return private.emergency_access_operation_payload(target_operation_request_id);
  end if;

  select auth_user.banned_until
  into auth_banned_until
  from auth.users auth_user
  where auth_user.id = operation_record.target_auth_user_id;

  select count(*)::integer
  into active_auth_session_count
  from auth.sessions auth_session
  where auth_session.user_id = operation_record.target_auth_user_id
    and (auth_session.not_after is null or auth_session.not_after > clock_timestamp());

  select count(*)::integer
  into active_refresh_token_count
  from auth.refresh_tokens refresh_token
  where refresh_token.user_id = operation_record.target_auth_user_id::text
    and not refresh_token.revoked;

  if target_action = 'revoke' then
    if provider_result_value ->> 'passwordRotated' is distinct from 'true'
      or provider_result_value ->> 'banned' is distinct from 'true'
      or auth_banned_until is null
      or auth_banned_until <= clock_timestamp()
      or active_auth_session_count <> 0
      or active_refresh_token_count <> 0
    then
      raise check_violation using message = 'The authentication provider did not verify complete access revocation.';
    end if;

    if account_record.current_emergency_revocation_id is distinct from target_operation_request_id
      or account_record.disabled_at is null
    then
      raise check_violation using message = 'The database revocation boundary is no longer intact.';
    end if;
  else
    begin
      recovery_delivered_at := nullif(provider_result_value ->> 'recoveryDeliveredAt', '')::timestamptz;
      recovery_usable_until := nullif(provider_result_value ->> 'recoveryUsableUntil', '')::timestamptz;
    exception when others then
      raise check_violation using message = 'The recovery delivery evidence was invalid.';
    end;

    if provider_result_value ->> 'recoveryDelivered' is distinct from 'true'
      or provider_result_value ->> 'unbanned' is distinct from 'true'
      or recovery_delivered_at is null
      or recovery_delivered_at < clock_timestamp() - interval '15 minutes'
      or recovery_delivered_at > clock_timestamp() + interval '1 minute'
      or recovery_usable_until is null
      or recovery_usable_until <= clock_timestamp()
      or recovery_usable_until > recovery_delivered_at + interval '24 hours'
      or (auth_banned_until is not null and auth_banned_until > clock_timestamp())
      or active_auth_session_count <> 0
      or active_refresh_token_count <> 0
    then
      raise check_violation using message = 'The authentication provider did not verify safe access restoration.';
    end if;

    if account_record.current_emergency_revocation_id is distinct from operation_record.revocation_operation_id
      or account_record.disabled_at is null
    then
      raise check_violation using message = 'Only the matching emergency revocation can be restored.';
    end if;

    if not exists (
      select 1
      from public.employees employee
      where employee.id = operation_record.target_employee_id
        and employee.status = 'active'
    ) then
      raise check_violation using message = 'The employee is no longer active, so login access remains disabled.';
    end if;

    update private.employee_accounts account
    set disabled_at = null,
        disabled_by = null,
        disabled_reason = null,
        current_emergency_revocation_id = null,
        must_change_password = true,
        password_changed_at = null,
        auth_tokens_invalid_before_epoch = greatest(
          account.auth_tokens_invalid_before_epoch,
          invalid_before_epoch
        ),
        updated_at = clock_timestamp()
    where account.employee_id = operation_record.target_employee_id
      and account.current_emergency_revocation_id = operation_record.revocation_operation_id;

    if not found then
      raise check_violation using message = 'The matching emergency revocation could not be restored.';
    end if;
  end if;

  update private.emergency_access_operations operation
  set status = 'completed',
      provider_result = operation.provider_result || provider_result_value,
      provider_error_code = null,
      updated_at = clock_timestamp(),
      completed_at = clock_timestamp()
  where operation.operation_request_id = target_operation_request_id;

  final_state := private.emergency_access_state_json(operation_record.target_employee_id);
  update private.emergency_access_operations operation
  set after_state = final_state
  where operation.operation_request_id = target_operation_request_id;

  insert into private.emergency_access_operation_events (
    operation_request_id, event_type, actor_employee_id, details
  ) values (
    target_operation_request_id,
    target_action || '_completed',
    target_actor_id,
    jsonb_build_object(
      'providerVerified', true,
      'activeAuthSessions', active_auth_session_count,
      'activeRefreshTokens', active_refresh_token_count,
      'businessRecordsChanged', false,
      'accountEnabled', target_action = 'restore'
    )
  );

  insert into private.audit_events (
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
    (select account.auth_user_id from private.employee_accounts account where account.employee_id = target_actor_id),
    target_actor_id,
    target_operation_request_id::text,
    'private',
    'employee_accounts',
    case when target_action = 'revoke' then 'EMERGENCY_ACCESS_REVOKED' else 'EMERGENCY_ACCESS_RESTORED' end,
    operation_record.target_employee_id::text,
    old_state,
    final_state
  );

  return private.emergency_access_operation_payload(target_operation_request_id);
end
$$;

revoke all on function public.service_complete_emergency_access_operation(uuid, uuid, text, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_complete_emergency_access_operation(uuid, uuid, text, boolean, jsonb)
  to service_role;

-- The legacy browser RPC only toggled one database timestamp and could leave
-- live Auth and cross-platform sessions behind. Keep the name as a deliberate
-- hard failure for stale clients, but remove every browser grant.
create or replace function public.admin_set_employee_account_state(
  target_employee_id uuid,
  target_disabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  raise feature_not_supported
    using message = 'Use the protected emergency access revocation and restoration workflow.';
end
$$;

revoke all on function public.admin_set_employee_account_state(uuid, boolean)
  from public, anon, authenticated, service_role;

-- Provisioning may link a new account or refresh setup state for an enabled
-- account. It may never clear either an ordinary disable or an emergency
-- revocation marker as an unintended side effect.
create or replace function public.service_link_employee_auth_account(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_must_change_password boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing_account private.employee_accounts%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_employee_id is null or target_auth_user_id is null then
    raise check_violation using message = 'Employee and auth user identifiers are required.';
  end if;
  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status in ('active', 'onboarding')
  ) then
    raise check_violation using message = 'Only active or onboarding employees can receive login accounts.';
  end if;
  if not exists (select 1 from auth.users auth_user where auth_user.id = target_auth_user_id) then
    raise foreign_key_violation using message = 'The Supabase auth user does not exist.';
  end if;

  select account.*
  into existing_account
  from private.employee_accounts account
  where account.employee_id = target_employee_id
  for update;

  if existing_account.employee_id is not null
    and existing_account.auth_user_id <> target_auth_user_id
  then
    raise unique_violation using message = 'This employee is already linked to a different auth account.';
  end if;
  if existing_account.current_emergency_revocation_id is not null then
    raise check_violation using message = 'Emergency-revoked access must use the protected restoration workflow.';
  end if;
  if existing_account.employee_id is not null and existing_account.disabled_at is not null then
    raise check_violation using message = 'A disabled account cannot be re-enabled through account provisioning.';
  end if;

  insert into private.employee_accounts (
    employee_id,
    auth_user_id,
    invited_at,
    disabled_at,
    must_change_password
  ) values (
    target_employee_id,
    target_auth_user_id,
    clock_timestamp(),
    null,
    target_must_change_password
  )
  on conflict (employee_id) do update set
    must_change_password = target_must_change_password,
    password_changed_at = case
      when target_must_change_password then null
      else employee_accounts.password_changed_at
    end,
    invited_at = coalesce(employee_accounts.invited_at, excluded.invited_at),
    updated_at = clock_timestamp();

  return private.admin_user_record(target_employee_id);
end
$$;

revoke all on function public.service_link_employee_auth_account(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.service_link_employee_auth_account(uuid, uuid, boolean)
  to service_role;

comment on table private.emergency_access_operations is
  'Idempotent fail-closed control plane for complete employee access revocation and source-safe restoration.';
comment on table private.emergency_access_operation_events is
  'Append-only emergency access lifecycle and provider outcome evidence.';
comment on table private.emergency_revoked_auth_sessions is
  'Permanent application-side tombstones that reject JWT session identifiers captured during emergency revocation.';
comment on function public.service_begin_emergency_access_revoke(uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz) is
  'Service-only first phase: validates authority, disables the application account, invalidates tokens, and retires app-owned sessions before Auth provider rotation and ban.';
comment on function public.service_begin_emergency_access_restore(uuid, uuid, uuid, text, text, boolean, uuid, text, timestamptz) is
  'Service-only first phase: keeps access disabled, verifies the exact emergency source, and prepares fresh provider recovery without restoring old sessions.';
comment on function public.service_record_emergency_access_provider_progress(uuid, uuid, text, jsonb) is
  'Service-only crash-safe recovery-delivery checkpoint. It never marks failure and never enables the account.';
comment on function public.service_complete_emergency_access_operation(uuid, uuid, text, boolean, jsonb) is
  'Service-only provider checkpoint/finalizer. Failed provider work remains retryable and fail-closed; restoration enables only after delivery, unban, and zero-session verification.';

notify pgrst, 'reload schema';

commit;

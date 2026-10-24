begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table private.employee_push_subscriptions
  add column if not exists ownership_operation_id uuid;

comment on column private.employee_push_subscriptions.ownership_operation_id is
  'Last browser-origin ownership operation confirmed by the guarded push RPC. Existing subscriptions remain valid with a null legacy value.';

create table private.employee_push_ownership_operations (
  operation_id uuid primary key,
  endpoint text not null check (char_length(endpoint) between 20 and 2048),
  desired_enabled boolean not null,
  expected_owner_operation_id uuid,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null,
  auth_session_id uuid not null,
  subscription_id uuid references private.employee_push_subscriptions(id) on delete set null,
  state_changed boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index employee_push_ownership_operations_endpoint_idx
  on private.employee_push_ownership_operations(endpoint, created_at desc);
alter table private.employee_push_ownership_operations enable row level security;
alter table private.employee_push_ownership_operations force row level security;
revoke all on private.employee_push_ownership_operations from public, anon, authenticated;

create or replace function public.get_my_push_subscription_guarded(
  target_endpoint text,
  target_expected_auth_user_id uuid,
  target_expected_auth_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_auth_user_id uuid := (select auth.uid());
  actor_auth_session_id uuid;
  owner_employee_id uuid;
  owner_auth_user_id uuid;
  owner_auth_session_id uuid;
  owner_operation_id uuid;
  owner_enabled boolean := false;
begin
  begin
    actor_auth_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    raise insufficient_privilege using message = 'The current authentication session is invalid.';
  end;

  if actor_id is null
    or actor_auth_user_id is null
    or actor_auth_session_id is null
    or actor_auth_user_id <> target_expected_auth_user_id
    or actor_auth_session_id <> target_expected_auth_session_id
  then
    raise insufficient_privilege using message = 'The signed-in account changed before device notification status could be checked.';
  end if;

  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = actor_auth_session_id
      and auth_session.user_id = actor_auth_user_id
      and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  ) then
    raise insufficient_privilege using message = 'The authentication session is no longer active.';
  end if;

  if target_endpoint is null or char_length(target_endpoint) not between 20 and 2048 then
    raise check_violation using message = 'The browser push endpoint is invalid.';
  end if;

  select
    subscription.employee_id,
    account.auth_user_id,
    subscription.auth_session_id,
    subscription.ownership_operation_id,
    subscription.enabled
  into
    owner_employee_id,
    owner_auth_user_id,
    owner_auth_session_id,
    owner_operation_id,
    owner_enabled
  from private.employee_push_subscriptions subscription
  left join private.employee_accounts account on account.employee_id = subscription.employee_id
  where subscription.endpoint = target_endpoint;

  return jsonb_build_object(
    'confirmed', true,
    'changed', false,
    'enabled', coalesce(
      owner_enabled
      and owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id,
      false
    ),
    'endpoint', target_endpoint,
    'operationId', null,
    'ownerOperationId', owner_operation_id,
    'actorEmployeeId', actor_id,
    'actorAuthUserId', actor_auth_user_id,
    'actorAuthSessionId', actor_auth_session_id,
    'ownerEmployeeId', case when owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id then owner_employee_id else null end,
    'ownerAuthUserId', case when owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id then owner_auth_user_id else null end,
    'ownerAuthSessionId', case when owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id then owner_auth_session_id else null end
  );
end
$$;

create or replace function public.set_my_push_subscription_guarded(
  target_subscription jsonb,
  target_enabled boolean,
  target_expected_employee_id uuid,
  target_expected_auth_user_id uuid,
  target_expected_auth_session_id uuid,
  target_expected_owner_operation_id uuid,
  target_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_auth_user_id uuid := (select auth.uid());
  actor_auth_session_id uuid;
  endpoint_value text := target_subscription ->> 'endpoint';
  saved_id uuid;
  owner_employee_id uuid;
  owner_auth_user_id uuid;
  owner_auth_session_id uuid;
  owner_operation_id uuid;
  owner_enabled boolean := false;
  operation_changed boolean := false;
  operation_confirmed boolean := false;
  operation_is_replay boolean := false;
  existing_operation private.employee_push_ownership_operations%rowtype;
begin
  begin
    actor_auth_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    raise insufficient_privilege using message = 'The current authentication session is invalid.';
  end;

  if actor_id is null
    or actor_auth_user_id is null
    or actor_auth_session_id is null
    or actor_id <> target_expected_employee_id
    or actor_auth_user_id <> target_expected_auth_user_id
    or actor_auth_session_id <> target_expected_auth_session_id
  then
    raise insufficient_privilege using message = 'The signed-in account changed before device notifications could be updated.';
  end if;

  if target_operation_id is null then
    raise check_violation using message = 'A device notification ownership operation ID is required.';
  end if;

  if target_enabled is null then
    raise check_violation using message = 'A device notification ownership state is required.';
  end if;

  if not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = actor_auth_session_id
      and auth_session.user_id = actor_auth_user_id
      and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  ) then
    raise insufficient_privilege using message = 'The authentication session is no longer active.';
  end if;

  if endpoint_value is null
    or char_length(endpoint_value) not between 20 and 2048
    or endpoint_value !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]]+$'
  then
    raise check_violation using message = 'This browser push service is not supported.';
  end if;

  -- A UUID is an immutable idempotency key, not a last-arrival-wins command.
  -- Serialize UUID reuse first so a concurrent caller cannot rebind it.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_operation_id::text, 1));
  select operation.*
  into existing_operation
  from private.employee_push_ownership_operations operation
  where operation.operation_id = target_operation_id
  for update;

  if found then
    if existing_operation.endpoint <> endpoint_value
      or existing_operation.desired_enabled <> target_enabled
      or existing_operation.expected_owner_operation_id is distinct from target_expected_owner_operation_id
      or existing_operation.employee_id <> actor_id
      or existing_operation.auth_user_id <> actor_auth_user_id
      or existing_operation.auth_session_id <> actor_auth_session_id
    then
      raise check_violation using message = 'This device notification operation ID is already bound to a different request.';
    end if;
    operation_is_replay := true;
  else
    insert into private.employee_push_ownership_operations(
      operation_id,
      endpoint,
      desired_enabled,
      expected_owner_operation_id,
      employee_id,
      auth_user_id,
      auth_session_id
    ) values (
      target_operation_id,
      endpoint_value,
      target_enabled,
      target_expected_owner_operation_id,
      actor_id,
      actor_auth_user_id,
      actor_auth_session_id
    );
  end if;

  -- Endpoint ownership is origin-wide. Serialize even the first subscription
  -- insert, for which no row exists to lock yet, before the compare-and-set.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(endpoint_value, 0));

  select subscription.id, subscription.employee_id, subscription.auth_session_id,
    subscription.ownership_operation_id, subscription.enabled
  into saved_id, owner_employee_id, owner_auth_session_id, owner_operation_id, owner_enabled
  from private.employee_push_subscriptions subscription
  where subscription.endpoint = endpoint_value
  for update;

  if not operation_is_replay
    and owner_operation_id is not distinct from target_expected_owner_operation_id
    and target_enabled
  then
    if (select count(*)
      from private.employee_push_subscriptions subscription
      where subscription.employee_id = actor_id
        and subscription.enabled
        and subscription.endpoint <> endpoint_value) >= 10
    then
      raise check_violation using message = 'The device notification limit has been reached. Contact support.';
    end if;

    operation_changed := saved_id is null
      or owner_employee_id is distinct from actor_id
      or owner_auth_session_id is distinct from actor_auth_session_id
      or owner_enabled is distinct from true
      or (select subscription.p256dh is distinct from (target_subscription -> 'keys' ->> 'p256dh')
          or subscription.auth_key is distinct from (target_subscription -> 'keys' ->> 'auth')
          from private.employee_push_subscriptions subscription where subscription.id = saved_id);

    if saved_id is null then
      insert into private.employee_push_subscriptions(
        employee_id, auth_session_id, endpoint, p256dh, auth_key, enabled, ownership_operation_id
      ) values (
        actor_id,
        actor_auth_session_id,
        endpoint_value,
        target_subscription -> 'keys' ->> 'p256dh',
        target_subscription -> 'keys' ->> 'auth',
        true,
        target_operation_id
      )
      returning id into saved_id;
    else
      update private.employee_push_subscriptions subscription
      set employee_id = actor_id,
        auth_session_id = actor_auth_session_id,
        p256dh = target_subscription -> 'keys' ->> 'p256dh',
        auth_key = target_subscription -> 'keys' ->> 'auth',
        enabled = true,
        ownership_operation_id = target_operation_id,
        updated_at = clock_timestamp()
      where subscription.id = saved_id;
    end if;
    operation_confirmed := true;
  elsif not operation_is_replay
    and owner_operation_id is not distinct from target_expected_owner_operation_id
    and saved_id is not null
    and owner_employee_id = actor_id
    and owner_auth_session_id = actor_auth_session_id
  then
    operation_changed := owner_enabled;
    update private.employee_push_subscriptions subscription
    set enabled = false,
      ownership_operation_id = target_operation_id,
      updated_at = clock_timestamp()
    where subscription.id = saved_id;
    operation_confirmed := true;
  end if;

  select
    subscription.employee_id,
    account.auth_user_id,
    subscription.auth_session_id,
    subscription.ownership_operation_id,
    subscription.enabled
  into
    owner_employee_id,
    owner_auth_user_id,
    owner_auth_session_id,
    owner_operation_id,
    owner_enabled
  from private.employee_push_subscriptions subscription
  left join private.employee_accounts account on account.employee_id = subscription.employee_id
  where subscription.endpoint = endpoint_value;

  if operation_is_replay then
    operation_confirmed := owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id
      and owner_operation_id = target_operation_id
      and owner_enabled = target_enabled;
    operation_changed := case when operation_confirmed then existing_operation.state_changed else false end;
  else
    operation_confirmed := operation_confirmed
      and owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id
      and owner_operation_id = target_operation_id
      and owner_enabled = target_enabled;

    update private.employee_push_ownership_operations operation
    set subscription_id = saved_id,
      state_changed = operation_changed,
      confirmed_at = case when operation_confirmed then clock_timestamp() else null end
    where operation.operation_id = target_operation_id;
  end if;

  if operation_confirmed and not operation_is_replay then
    insert into private.audit_events(
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
    ) values (
      actor_auth_user_id,
      actor_id,
      'private',
      'employee_push_subscriptions',
      'UPDATE',
      saved_id::text,
      jsonb_build_object(
        'enabled', target_enabled,
        'changed', operation_changed,
        'authSessionId', actor_auth_session_id,
        'ownershipOperationId', target_operation_id
      )
    );
  end if;

  return jsonb_build_object(
    'confirmed', operation_confirmed,
    'changed', operation_changed,
    'enabled', coalesce(
      owner_enabled
      and owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id,
      false
    ),
    'endpoint', endpoint_value,
    'operationId', target_operation_id,
    'ownerOperationId', owner_operation_id,
    'actorEmployeeId', actor_id,
    'actorAuthUserId', actor_auth_user_id,
    'actorAuthSessionId', actor_auth_session_id,
    'ownerEmployeeId', case when owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id then owner_employee_id else null end,
    'ownerAuthUserId', case when owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id then owner_auth_user_id else null end,
    'ownerAuthSessionId', case when owner_employee_id = actor_id
      and owner_auth_user_id = actor_auth_user_id
      and owner_auth_session_id = actor_auth_session_id then owner_auth_session_id else null end
  );
end
$$;

revoke all on function public.get_my_push_subscription_guarded(text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_my_push_subscription_guarded(text,uuid,uuid) to authenticated;
grant execute on function public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid) to authenticated;

-- Retire the ambient-identity mutator so cached or stale clients cannot bypass
-- expected employee/session compare-and-set. The legacy status reader remains
-- read-only for rolling-release compatibility.
revoke execute on function public.set_my_push_subscription(jsonb,boolean) from authenticated;

notify pgrst, 'reload schema';

commit;

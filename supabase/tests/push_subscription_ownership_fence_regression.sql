begin;
-- Standalone rollback-only post-migration rehearsal. It must never persist fixtures.
set local statement_timeout = '30s';
set local plpgsql.check_asserts = on;

do $$
declare
  actor_employee_id uuid;
  actor_auth_user_id uuid;
  actor_auth_session_id uuid;
  other_employee_id uuid;
  endpoint_value text := 'https://fcm.googleapis.com/fcm/send/push-ownership-fence-' || gen_random_uuid()::text;
  first_operation_id uuid := gen_random_uuid();
  newer_operation_id uuid := gen_random_uuid();
  delayed_operation_id uuid := gen_random_uuid();
  disable_operation_id uuid := gen_random_uuid();
  foreign_session_id uuid := gen_random_uuid();
  audit_count_before bigint;
  audit_count_after bigint;
  result jsonb;
begin
  assert exists (
    select 1 from information_schema.columns
    where table_schema = 'private'
      and table_name = 'employee_push_subscriptions'
      and column_name = 'ownership_operation_id'
      and data_type = 'uuid'
  ), 'Push subscriptions retain the durable ownership operation evidence';
  assert to_regclass('private.employee_push_ownership_operations') is not null,
    'The private durable push ownership operation ledger exists';
  assert (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'employee_push_ownership_operations'
  ), 'The private operation ledger enforces row-level security';

  assert has_function_privilege(
    'authenticated',
    'public.get_my_push_subscription_guarded(text,uuid,uuid)',
    'EXECUTE'
  ), 'Authenticated sessions can use the guarded push status RPC';
  assert has_function_privilege(
    'authenticated',
    'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ), 'Authenticated sessions can use the guarded push ownership RPC';
  assert not has_function_privilege(
    'anon',
    'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ), 'Anonymous callers cannot mutate push ownership';
  assert not has_function_privilege(
    'authenticated',
    'public.set_my_push_subscription(jsonb,boolean)',
    'EXECUTE'
  ), 'The ambient-identity legacy push mutator is retired';
  assert not has_table_privilege(
    'authenticated',
    'private.employee_push_subscriptions',
    'SELECT'
  ), 'Endpoint and ownership evidence stay private';
  assert not has_table_privilege(
    'authenticated',
    'private.employee_push_ownership_operations',
    'SELECT'
  ), 'Authenticated callers cannot read the private operation ledger';
  assert not has_table_privilege(
    'authenticated',
    'private.employee_push_ownership_operations',
    'INSERT'
  ), 'Authenticated callers cannot insert into the private operation ledger';
  assert not has_table_privilege(
    'authenticated',
    'private.employee_push_ownership_operations',
    'UPDATE'
  ), 'Authenticated callers cannot update the private operation ledger';
  assert not has_table_privilege(
    'authenticated',
    'private.employee_push_ownership_operations',
    'DELETE'
  ), 'Authenticated callers cannot delete from the private operation ledger';
  assert not has_table_privilege(
    'anon',
    'private.employee_push_ownership_operations',
    'SELECT'
  ), 'Anonymous callers cannot read the private operation ledger';

  assert (
    select procedure_record.prosecdef
      and coalesce(procedure_record.proconfig, array[]::text[]) @> array['search_path=""']
    from pg_catalog.pg_proc procedure_record
    where procedure_record.oid = 'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure
  ), 'Guarded mutator is security-definer with an empty search path';
  assert position(
    'actor_id <> target_expected_employee_id' in lower(pg_get_functiondef(
      'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0, 'Guarded mutator validates the immutable employee';
  assert position(
    'actor_auth_session_id <> target_expected_auth_session_id' in lower(pg_get_functiondef(
      'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0, 'Guarded mutator validates the immutable auth session';
  assert position(
    'existing_operation.desired_enabled <> target_enabled' in lower(pg_get_functiondef(
      'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0, 'Operation UUID reuse validates its immutable request binding';
  assert position(
    'owner_operation_id is not distinct from target_expected_owner_operation_id' in lower(pg_get_functiondef(
      'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0, 'First execution uses expected-predecessor compare-and-set ordering';
  assert position(
    'if operation_is_replay then' in lower(pg_get_functiondef(
      'public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure
    ))
  ) > 0, 'Operation replays are evaluated without reapplying their mutation';
  assert (
    select count(*) = 3
    from regexp_matches(
      lower(pg_get_functiondef('public.get_my_push_subscription_guarded(text,uuid,uuid)'::regprocedure)),
      'case when owner_employee_id = actor_id[[:space:]]+and owner_auth_user_id = actor_auth_user_id[[:space:]]+and owner_auth_session_id = actor_auth_session_id then owner_(employee_id|auth_user_id|auth_session_id) else null end',
      'g'
    )
  ), 'Status reads disclose all owner identifiers only for a complete actor identity match';
  assert (
    select count(*) = 3
    from regexp_matches(
      lower(pg_get_functiondef('public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid)'::regprocedure)),
      'case when owner_employee_id = actor_id[[:space:]]+and owner_auth_user_id = actor_auth_user_id[[:space:]]+and owner_auth_session_id = actor_auth_session_id then owner_(employee_id|auth_user_id|auth_session_id) else null end',
      'g'
    )
  ), 'Mutation results disclose all owner identifiers only for a complete actor identity match';

  select employee.id, account.auth_user_id, auth_session.id
  into actor_employee_id, actor_auth_user_id, actor_auth_session_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  join auth.sessions auth_session on auth_session.user_id = account.auth_user_id
  where employee.status = 'active'
    and account.disabled_at is null
    and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  order by auth_session.created_at desc
  limit 1;

  if actor_employee_id is null then
    raise exception 'Push ownership behavioral regression requires an active Auth session fixture.';
  end if;

  select employee.id
  into other_employee_id
  from public.employees employee
  where employee.id <> actor_employee_id
  order by employee.id
  limit 1;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', actor_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2',
      'session_id', actor_auth_session_id
    )::text,
    true
  );

  assert private.current_employee_id() = actor_employee_id,
    'The rollback fixture must resolve to the selected employee identity';
  assert auth.uid() = actor_auth_user_id,
    'The rollback fixture must resolve to the selected Auth user identity';
  assert auth.jwt() ->> 'session_id' = actor_auth_session_id::text,
    'The rollback fixture must resolve to the selected Auth session identity';

  result := public.set_my_push_subscription_guarded(
    jsonb_build_object(
      'endpoint', endpoint_value,
      'keys', jsonb_build_object('p256dh', repeat('A', 87), 'auth', repeat('B', 22))
    ),
    true,
    actor_employee_id,
    actor_auth_user_id,
    actor_auth_session_id,
    null,
    first_operation_id
  );
  assert (result ->> 'confirmed')::boolean, 'Matching immutable identity enables push ownership';
  assert (result ->> 'enabled')::boolean, 'Enable result reports authoritative state';
  assert result ->> 'ownerEmployeeId' = actor_employee_id::text, 'Enable result proves the owner';

  assert exists (
    select 1
    from private.employee_push_ownership_operations operation
    where operation.operation_id = first_operation_id
      and operation.endpoint = endpoint_value
      and operation.desired_enabled
      and operation.expected_owner_operation_id is null
      and operation.employee_id = actor_employee_id
      and operation.auth_user_id = actor_auth_user_id
      and operation.auth_session_id = actor_auth_session_id
      and operation.confirmed_at is not null
  ), 'The first operation is durably bound to its immutable request and confirmation';

  select count(*)
  into audit_count_before
  from private.audit_events event
  where event.table_name = 'employee_push_subscriptions'
    and event.new_record ->> 'ownershipOperationId' = first_operation_id::text;
  assert audit_count_before = 1, 'The first confirmed ownership mutation is audited once';

  result := public.set_my_push_subscription_guarded(
    jsonb_build_object(
      'endpoint', endpoint_value,
      'keys', jsonb_build_object('p256dh', repeat('A', 87), 'auth', repeat('B', 22))
    ),
    true,
    actor_employee_id,
    actor_auth_user_id,
    actor_auth_session_id,
    null,
    first_operation_id
  );
  assert (result ->> 'confirmed')::boolean,
    'An exact response-loss replay is idempotently confirmed while it remains current';
  select count(*)
  into audit_count_after
  from private.audit_events event
  where event.table_name = 'employee_push_subscriptions'
    and event.new_record ->> 'ownershipOperationId' = first_operation_id::text;
  assert audit_count_after = audit_count_before,
    'An exact current replay does not duplicate its mutation audit';

  update private.employee_push_subscriptions subscription
  set auth_session_id = foreign_session_id
  where subscription.endpoint = endpoint_value;
  result := public.get_my_push_subscription_guarded(
    endpoint_value,
    actor_auth_user_id,
    actor_auth_session_id
  );
  assert not (result ->> 'enabled')::boolean,
    'A subscription owned by another auth session is not reported as enabled';
  assert result -> 'ownerEmployeeId' = 'null'::jsonb
    and result -> 'ownerAuthUserId' = 'null'::jsonb
    and result -> 'ownerAuthSessionId' = 'null'::jsonb,
    'A partial employee-only match redacts every owner identifier';
  update private.employee_push_subscriptions subscription
  set auth_session_id = actor_auth_session_id
  where subscription.endpoint = endpoint_value;

  result := public.set_my_push_subscription_guarded(
    jsonb_build_object(
      'endpoint', endpoint_value,
      'keys', jsonb_build_object('p256dh', repeat('A', 87), 'auth', repeat('B', 22))
    ),
    true,
    actor_employee_id,
    actor_auth_user_id,
    actor_auth_session_id,
    first_operation_id,
    newer_operation_id
  );
  assert (result ->> 'confirmed')::boolean,
    'A newer operation can replace the current ownership operation evidence';
  assert (
    select subscription.ownership_operation_id = newer_operation_id
    from private.employee_push_subscriptions subscription
    where subscription.endpoint = endpoint_value
  ), 'The newer operation becomes current';

  result := public.set_my_push_subscription_guarded(
    jsonb_build_object('endpoint', endpoint_value),
    false,
    actor_employee_id,
    actor_auth_user_id,
    actor_auth_session_id,
    first_operation_id,
    delayed_operation_id
  );
  assert not (result ->> 'confirmed')::boolean,
    'A unique operation delayed behind its expected predecessor is rejected after a newer operation commits';
  assert (result ->> 'enabled')::boolean,
    'The delayed stale operation returns the current enabled state';
  assert (
    select subscription.ownership_operation_id = newer_operation_id
      and subscription.enabled
    from private.employee_push_subscriptions subscription
    where subscription.endpoint = endpoint_value
  ), 'Expected-predecessor CAS prevents a delayed unique operation from overwriting newer ownership';
  assert exists (
    select 1
    from private.employee_push_ownership_operations operation
    where operation.operation_id = delayed_operation_id
      and operation.expected_owner_operation_id = first_operation_id
      and operation.confirmed_at is null
  ), 'The rejected delayed operation remains durably bound and unconfirmed';
  assert not exists (
    select 1
    from private.audit_events event
    where event.table_name = 'employee_push_subscriptions'
      and event.new_record ->> 'ownershipOperationId' = delayed_operation_id::text
  ), 'A rejected delayed operation does not create a mutation audit';

  select count(*)
  into audit_count_before
  from private.audit_events event
  where event.table_name = 'employee_push_subscriptions'
    and event.new_record ->> 'ownershipOperationId' = first_operation_id::text;
  result := public.set_my_push_subscription_guarded(
    jsonb_build_object(
      'endpoint', endpoint_value,
      'keys', jsonb_build_object('p256dh', repeat('A', 87), 'auth', repeat('B', 22))
    ),
    true,
    actor_employee_id,
    actor_auth_user_id,
    actor_auth_session_id,
    null,
    first_operation_id
  );
  assert not (result ->> 'confirmed')::boolean,
    'An old response-loss replay is unconfirmed after a newer operation supersedes it';
  assert (result ->> 'enabled')::boolean,
    'A superseded replay returns the current enabled state without changing it';
  assert (
    select subscription.ownership_operation_id = newer_operation_id
      and subscription.enabled
    from private.employee_push_subscriptions subscription
    where subscription.endpoint = endpoint_value
  ), 'The old replay cannot overwrite the newer operation';
  select count(*)
  into audit_count_after
  from private.audit_events event
  where event.table_name = 'employee_push_subscriptions'
    and event.new_record ->> 'ownershipOperationId' = first_operation_id::text;
  assert audit_count_after = audit_count_before,
    'A superseded replay does not add a mutation audit';

  begin
    perform public.set_my_push_subscription_guarded(
      jsonb_build_object('endpoint', endpoint_value),
      false,
      actor_employee_id,
      actor_auth_user_id,
      actor_auth_session_id,
      null,
      first_operation_id
    );
    raise exception 'A reused operation UUID accepted a different desired state';
  exception when check_violation then null;
  end;
  assert (
    select subscription.ownership_operation_id = newer_operation_id
      and subscription.enabled
    from private.employee_push_subscriptions subscription
    where subscription.endpoint = endpoint_value
  ), 'A binding mismatch cannot alter current ownership';

  begin
    perform public.set_my_push_subscription_guarded(
      jsonb_build_object('endpoint', endpoint_value),
      false,
      coalesce(other_employee_id, gen_random_uuid()),
      actor_auth_user_id,
      actor_auth_session_id,
      newer_operation_id,
      gen_random_uuid()
    );
    raise exception 'Mismatched employee identity changed push ownership';
  exception when insufficient_privilege then null;
  end;
  assert (
    select subscription.enabled and subscription.employee_id = actor_employee_id
    from private.employee_push_subscriptions subscription
    where subscription.endpoint = endpoint_value
  ), 'Rejected identity mismatch leaves the subscription unchanged';

  result := public.set_my_push_subscription_guarded(
    jsonb_build_object('endpoint', endpoint_value),
    false,
    actor_employee_id,
    actor_auth_user_id,
    actor_auth_session_id,
    newer_operation_id,
    disable_operation_id
  );
  assert (result ->> 'confirmed')::boolean, 'Matching owner receives confirmed disable evidence';
  assert not (result ->> 'enabled')::boolean, 'Confirmed disable reports the authoritative disabled state';
  assert result ->> 'operationId' = disable_operation_id::text, 'Response is bound to the caller operation';
end
$$;

rollback;

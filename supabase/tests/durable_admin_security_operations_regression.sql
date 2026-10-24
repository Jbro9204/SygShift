-- Rollback-only regression for durable/replay-safe admin password and MFA reset operations.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $durable_admin_security_operations_regression$
declare
  actor_id uuid;
  employee_auth_user_id uuid;
  mfa_operation_id uuid := gen_random_uuid();
  poison_operation_id uuid := gen_random_uuid();
  password_operation_id uuid := gen_random_uuid();
  factor_a uuid := gen_random_uuid();
  factor_b uuid := gen_random_uuid();
  recovery_code_id uuid := gen_random_uuid();
  trusted_device_id uuid := gen_random_uuid();
  security_key_id uuid := gen_random_uuid();
  security_session_id uuid := gen_random_uuid();
  password_recipient text := 'durable.password.reset@example.com';
  dispatch jsonb;
  identity_mismatch_rejected boolean := false;
  result jsonb;
  replay jsonb;
  attempt integer;
  existing_recovery_code_count integer;
  existing_trusted_device_count integer;
  existing_security_key_count integer;
  existing_security_session_count integer;
begin
  select employee.id, account.auth_user_id
  into actor_id, employee_auth_user_id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  where employee.status = 'active'
    and account.auth_user_id is not null
  order by employee.created_at, employee.id
  limit 1;

  assert actor_id is not null and employee_auth_user_id is not null,
    'An active employee account is required for this rollback-only regression.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth_user_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );

  result := public.service_begin_admin_mfa_reset_operation(
    mfa_operation_id,
    actor_id,
    actor_id,
    employee_auth_user_id,
    jsonb_build_array(factor_a, factor_b)
  );
  replay := public.service_begin_admin_mfa_reset_operation(
    mfa_operation_id,
    actor_id,
    actor_id,
    employee_auth_user_id,
    jsonb_build_array(factor_a, factor_b)
  );
  assert result ->> 'state' = 'prepared'
    and replay ->> 'operationId' = mfa_operation_id::text
    and (replay ->> 'factorCount')::integer = 2,
    'MFA begin must durably preserve and replay one exact factor manifest.';
  assert (
    select count(*) from private.admin_mfa_reset_operations operation
    where operation.id = mfa_operation_id
  ) = 1, 'Exact begin replay must not create another durable operation.';

  result := public.service_mark_admin_mfa_reset_deleting(
    mfa_operation_id, actor_id, actor_id, employee_auth_user_id
  );
  replay := public.service_mark_admin_mfa_reset_deleting(
    mfa_operation_id, actor_id, actor_id, employee_auth_user_id
  );
  assert result ->> 'state' = 'deleting'
    and replay ->> 'authMutationStartedAt' = result ->> 'authMutationStartedAt',
    'The durable destructive-mutation boundary must be replay safe.';

  select count(*) into existing_recovery_code_count
  from private.mfa_recovery_codes code
  where code.employee_id = actor_id
    and code.used_at is null
    and code.revoked_at is null;
  select count(*) into existing_trusted_device_count
  from private.trusted_devices device
  where device.employee_id = actor_id
    and device.revoked_at is null
    and device.expires_at > now();
  select count(*) into existing_security_key_count
  from private.webauthn_credentials credential
  where credential.employee_id = actor_id
    and credential.revoked_at is null;
  select count(*) into existing_security_session_count
  from private.security_key_sessions security_session
  where security_session.employee_id = actor_id
    and security_session.revoked_at is null;

  insert into private.mfa_recovery_codes(
    id, batch_id, employee_id, created_by, code_hash, code_hint, expires_at
  ) values (
    recovery_code_id,
    gen_random_uuid(),
    actor_id,
    actor_id,
    md5(mfa_operation_id::text) || md5(factor_a::text),
    '****A1B2',
    clock_timestamp() + interval '1 day'
  );
  insert into private.trusted_devices(
    id, employee_id, token_hash, device_label, expires_at
  ) values (
    trusted_device_id,
    actor_id,
    md5(mfa_operation_id::text) || md5(factor_b::text),
    'Durability regression device',
    clock_timestamp() + interval '1 day'
  );
  insert into private.webauthn_credentials(
    id, employee_id, credential_id, public_key, signature_counter, transports,
    device_type, backed_up, label, webauthn_user_id
  ) values (
    security_key_id,
    actor_id,
    'durability-' || mfa_operation_id::text,
    'rollback-only-public-key',
    0,
    array['internal']::text[],
    'singleDevice',
    false,
    'Durability regression key',
    'durability-' || actor_id::text
  );
  insert into private.security_key_sessions(
    id, employee_id, auth_session_id, token_hash, expires_at
  ) values (
    security_session_id,
    actor_id,
    gen_random_uuid(),
    md5(security_session_id::text) || md5(mfa_operation_id::text),
    clock_timestamp() + interval '1 day'
  );

  result := public.service_complete_admin_mfa_reset_operation(
    mfa_operation_id, actor_id, actor_id, employee_auth_user_id
  );
  replay := public.service_complete_admin_mfa_reset_operation(
    mfa_operation_id, actor_id, actor_id, employee_auth_user_id
  );
  assert result ->> 'state' = 'completed'
    and replay = result
    and (result ->> 'recoveryCodesRevoked')::integer = existing_recovery_code_count + 1
    and (result ->> 'trustedDevicesRevoked')::integer = existing_trusted_device_count + 1
    and (result ->> 'securityKeysRevoked')::integer = existing_security_key_count + 1
    and (result ->> 'securityKeySessionsRevoked')::integer = existing_security_session_count + 1,
    'Completion and response-loss replay must return one exact persisted cleanup result.';
  assert (
    select count(*) from private.employee_mfa_reset_events event
    where event.operation_id = mfa_operation_id
  ) = 1, 'MFA completion replay must not duplicate the append-only reset event.';
  assert (select revoked_at is not null from private.mfa_recovery_codes where id = recovery_code_id)
    and (select revoked_at is not null from private.trusted_devices where id = trusted_device_id)
    and (select revoked_at is not null from private.webauthn_credentials where id = security_key_id)
    and (select revoked_at is not null from private.security_key_sessions where id = security_session_id),
    'Atomic MFA completion must revoke every database-backed recovery/security artifact.';

  perform public.service_begin_admin_mfa_reset_operation(
    poison_operation_id,
    actor_id,
    actor_id,
    employee_auth_user_id,
    '[]'::jsonb
  );
  perform public.service_mark_admin_mfa_reset_deleting(
    poison_operation_id, actor_id, actor_id, employee_auth_user_id
  );
  for attempt in 1..8 loop
    result := public.service_defer_admin_mfa_reset_recovery(
      poison_operation_id,
      actor_id,
      actor_id,
      employee_auth_user_id,
      'Rollback-only poison operation ' || attempt::text
    );
  end loop;
  assert (result ->> 'recoveryAttempts')::integer = 8
    and result ->> 'recoveryQuarantinedAt' is not null,
    'A repeatedly failing recovery must be quarantined after bounded attempts.';
  assert not exists (
    select 1
    from jsonb_array_elements(public.service_list_admin_mfa_reset_recovery(25)) item
    where item ->> 'operationId' = poison_operation_id::text
  ), 'A quarantined poison operation must not starve the scheduled recovery queue.';

  result := public.service_resume_admin_mfa_reset_recovery(
    poison_operation_id, actor_id, actor_id, employee_auth_user_id
  );
  update private.admin_mfa_reset_operations operation
  set recovery_next_attempt_at = timestamptz '2000-01-01 00:00:00+00',
      updated_at = clock_timestamp() - interval '2 minutes'
  where operation.id = poison_operation_id;
  assert (result ->> 'recoveryAttempts')::integer = 0
    and result ->> 'recoveryQuarantinedAt' is null,
    'A service operator must be able to resume a quarantined durable reset.';
  assert exists (
    select 1
    from jsonb_array_elements(public.service_list_admin_mfa_reset_recovery(25)) item
    where item ->> 'operationId' = poison_operation_id::text
  ), 'A resumed operation must re-enter bounded scheduled recovery.';

  result := public.service_prepare_employee_password_reset_operation(
    password_operation_id,
    actor_id,
    employee_auth_user_id,
    password_recipient,
    actor_id
  );
  replay := public.service_prepare_employee_password_reset_operation(
    password_operation_id,
    actor_id,
    employee_auth_user_id,
    password_recipient,
    actor_id
  );
  assert result = replay and result ->> 'state' = 'prepared',
    'Password-reset preparation must preserve one immutable account and recipient identity.';

  begin
    perform public.service_prepare_employee_password_reset_operation(
      password_operation_id,
      actor_id,
      employee_auth_user_id,
      'replacement.recipient@example.com',
      actor_id
    );
  exception when check_violation then
    identity_mismatch_rejected := true;
  end;
  assert identity_mismatch_rejected,
    'A retry must not substitute another recipient into a prepared password reset.';

  dispatch := public.service_prepare_email_recipient_dispatch(
    'inline_email',
    password_operation_id,
    password_recipient,
    'password_reset',
    'employee',
    actor_id
  );
  perform public.service_complete_email_recipient_dispatch(
    'inline_email',
    password_operation_id,
    password_recipient,
    'password_reset',
    (dispatch ->> 'dispatchToken')::uuid,
    'accepted',
    'durable-admin-reset-regression',
    null
  );

  result := public.service_complete_employee_password_reset_operation(
    password_operation_id,
    actor_id,
    employee_auth_user_id,
    password_recipient,
    actor_id
  );
  replay := public.service_complete_employee_password_reset_operation(
    password_operation_id,
    actor_id,
    employee_auth_user_id,
    password_recipient,
    actor_id
  );
  assert result = replay
    and result ->> 'operationId' = password_operation_id::text
    and result ->> 'state' = 'completed'
    and (result ->> 'recorded')::boolean,
    'Password-reset completion must return the same immutable result after response loss.';
  assert (
    select count(*) from private.employee_password_reset_events event
    where event.operation_id = password_operation_id
  ) = 1, 'Password-reset replay must not duplicate its append-only audit event.';
  assert exists (
    select 1
    from private.admin_password_reset_operations operation
    where operation.id = password_operation_id
      and operation.employee_id = actor_id
      and operation.auth_user_id = employee_auth_user_id
      and operation.recipient_email = password_recipient
      and operation.state = 'completed'
  ), 'Password-reset success must remain bound to the exact prepared login and recipient.';
end
$durable_admin_security_operations_regression$;

rollback;

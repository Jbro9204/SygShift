begin;

set local statement_timeout = '45s';

do $emergency_access_regression$
declare
  actor_employee_id uuid;
  actor_auth_session_id uuid;
  target_employee_id uuid := gen_random_uuid();
  target_auth_user_id uuid := gen_random_uuid();
  target_auth_session_id uuid := gen_random_uuid();
  target_refresh_token text := 'emergency-refresh-' || gen_random_uuid()::text;
  revoke_request_id uuid := gen_random_uuid();
  restore_request_id uuid := gen_random_uuid();
  target_username text := 'emergency' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  payload jsonb;
  schedule_count_before bigint;
  shift_count_before bigint;
  punch_count_before bigint;
  payroll_count_before bigint;
begin
  select employee.id, auth_session.id
  into actor_employee_id, actor_auth_session_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  join auth.sessions auth_session on auth_session.user_id = account.auth_user_id
  where employee.role = 'admin'
    and employee.status = 'active'
    and account.activated_at is not null
    and account.disabled_at is null
    and 'admin.users.manage' = any(private.employee_effective_permissions(employee.id))
    and 'admin.security.manage' = any(private.employee_effective_permissions(employee.id))
    and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  order by auth_session.created_at desc
  limit 1;

  if actor_employee_id is null or actor_auth_session_id is null then
    raise exception 'An active recovery-capable Admin session is required for the emergency access rollback regression.';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  select count(*) into schedule_count_before from public.schedules;
  select count(*) into shift_count_before from public.shifts;
  select count(*) into punch_count_before from public.time_events;
  select count(*) into payroll_count_before from private.payroll_export_rows;

  insert into public.employees (
    id, username, first_name, last_name,
    role, employment_type, status, time_zone
  ) values (
    target_employee_id,
    target_username,
    'Emergency', 'Access Regression', 'guard', 'hourly', 'active', 'America/Denver'
  );
  -- Production assigns permanent usernames in a BEFORE INSERT trigger. Read
  -- back that authoritative value instead of assuming the proposed fixture
  -- username survived the normal account-creation boundary.
  select employee.username
  into target_username
  from public.employees employee
  where employee.id = target_employee_id;

  insert into auth.users (id, email)
  values (target_auth_user_id, target_username || '@accounts.sygshift.invalid');
  insert into private.employee_accounts (employee_id, auth_user_id, invited_at, activated_at)
  values (target_employee_id, target_auth_user_id, clock_timestamp(), clock_timestamp());
  insert into private.employee_contacts (employee_id, personal_email)
  values (target_employee_id, target_username || '@example.com');
  insert into auth.sessions (id, user_id, not_after)
  values (target_auth_session_id, target_auth_user_id, clock_timestamp() + interval '1 hour');
  insert into auth.refresh_tokens (token, user_id, revoked, session_id)
  values (target_refresh_token, target_auth_user_id::text, false, target_auth_session_id);

  insert into private.trusted_devices (employee_id, token_hash, device_label, expires_at)
  values (
    target_employee_id,
    encode(extensions.digest('emergency-trusted-' || target_employee_id::text, 'sha256'), 'hex'),
    'Rollback regression device',
    clock_timestamp() + interval '1 day'
  );
  insert into private.security_key_sessions (
    employee_id, auth_session_id, token_hash, expires_at
  ) values (
    target_employee_id,
    gen_random_uuid(),
    encode(extensions.digest('emergency-security-' || target_employee_id::text, 'sha256'), 'hex'),
    clock_timestamp() + interval '1 hour'
  );
  insert into private.shared_identity_sessions (
    employee_id, auth_user_id, auth_session_id, launch_request_id,
    token_hash, assurance_level, scope, expires_at
  ) values (
    target_employee_id,
    target_auth_user_id,
    gen_random_uuid(),
    gen_random_uuid(),
    encode(extensions.digest('emergency-shared-' || target_employee_id::text, 'sha256'), 'hex'),
    'aal2',
    'sygsphere',
    clock_timestamp() + interval '1 hour'
  );
  insert into private.platform_presence_sessions (
    auth_session_id, client_instance_id, application, employee_id,
    auth_user_id, state, expires_at
  ) values (
    gen_random_uuid(), gen_random_uuid(), 'sygshift', target_employee_id,
    target_auth_user_id, 'active', clock_timestamp() + interval '2 minutes'
  );
  insert into private.webauthn_challenges (employee_id, purpose, challenge, expires_at)
  values (
    target_employee_id,
    'authentication',
    'rollback-regression-challenge-' || target_employee_id::text,
    clock_timestamp() + interval '5 minutes'
  );

  begin
    perform public.service_begin_emergency_access_revoke(
      actor_employee_id, target_employee_id, gen_random_uuid(),
      'Rollback regression wrong username denial.', target_username || 'x', true,
      actor_auth_session_id, 'authenticator', clock_timestamp()
    );
    raise exception 'Emergency revocation accepted an incorrect confirmation username.';
  exception when check_violation then
    null;
  end;

  update private.employee_accounts
  set disabled_at = clock_timestamp(),
      disabled_by = actor_employee_id,
      disabled_reason = 'Rollback regression legacy disable.'
  where employee_id = target_employee_id;
  begin
    perform public.service_begin_emergency_access_revoke(
      actor_employee_id, target_employee_id, gen_random_uuid(),
      'Rollback regression must preserve an unrelated legacy disable.', target_username, true,
      actor_auth_session_id, 'authenticator', clock_timestamp()
    );
    raise exception 'Emergency revocation replaced an unrelated legacy disable.';
  exception when check_violation then
    null;
  end;
  assert (select disabled_reason = 'Rollback regression legacy disable.'
                 and current_emergency_revocation_id is null
          from private.employee_accounts where employee_id = target_employee_id),
    'Denied legacy-disable conversion changed the original account block.';
  update private.employee_accounts
  set disabled_at = null,
      disabled_by = null,
      disabled_reason = null
  where employee_id = target_employee_id;

  payload := public.service_begin_emergency_access_revoke(
    actor_employee_id, target_employee_id, revoke_request_id,
    'Rollback regression complete access revocation.', target_username, true,
    actor_auth_session_id, 'authenticator', clock_timestamp()
  );
  assert payload #>> '{operation,status}' = 'provider_pending'
    and payload #>> '{state,accountState}' = 'revocation_pending',
    'Revocation did not stop at the explicit fail-closed provider boundary.';
  assert (select disabled_at is not null and current_emergency_revocation_id = revoke_request_id
          from private.employee_accounts where employee_id = target_employee_id),
    'Revocation did not disable and mark the exact account.';
  assert (select bool_and(revoked_at is not null) from private.trusted_devices where employee_id = target_employee_id)
    and (select bool_and(revoked_at is not null) from private.security_key_sessions where employee_id = target_employee_id)
    and (select bool_and(revoked_at is not null) from private.shared_identity_sessions where employee_id = target_employee_id),
    'One or more app-owned session types survived emergency revocation.';
  assert not exists (select 1 from private.platform_presence_sessions where employee_id = target_employee_id)
    and not exists (
      select 1 from private.webauthn_challenges
      where employee_id = target_employee_id and consumed_at is null
    ), 'Presence or an outstanding WebAuthn challenge survived revocation.';
  assert exists (
    select 1
    from private.emergency_revoked_auth_sessions tombstone
    where tombstone.auth_session_id = target_auth_session_id
      and tombstone.auth_user_id = target_auth_user_id
      and tombstone.employee_id = target_employee_id
      and tombstone.revocation_operation_id = revoke_request_id
  ), 'The observed Supabase Auth session was not tombstoned.';
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', target_auth_user_id,
    'role', 'service_role',
    'session_id', target_auth_session_id,
    'iat', floor(extract(epoch from clock_timestamp()))::bigint
  )::text, true);
  assert private.current_employee_id() is null,
    'A tombstoned session still resolved an active employee identity.';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  payload := public.service_begin_emergency_access_revoke(
    actor_employee_id, target_employee_id, revoke_request_id,
    'Rollback regression complete access revocation.', target_username, true,
    actor_auth_session_id, 'authenticator', clock_timestamp()
  );
  assert (select count(*) = 1 from private.emergency_access_operations
          where operation_request_id = revoke_request_id),
    'An idempotent revocation replay created duplicate operations.';

  update auth.users
  set banned_until = clock_timestamp() + interval '100 years'
  where id = target_auth_user_id;

  begin
    perform public.service_complete_emergency_access_operation(
      actor_employee_id,
      revoke_request_id,
      'revoke',
      true,
      jsonb_build_object('passwordRotated', true, 'banned', true)
    );
    raise exception 'Provider completion accepted a surviving Auth session or refresh token.';
  exception when check_violation then
    null;
  end;

  -- The supported Auth Admin password rotation is expected to retire both
  -- surfaces. The rollback-only fixture deletes only its own managed-auth rows
  -- to model that verified provider postcondition before finalization.
  delete from auth.refresh_tokens
  where token = target_refresh_token
    and user_id = target_auth_user_id::text;
  delete from auth.sessions
  where id = target_auth_session_id
    and user_id = target_auth_user_id;

  payload := public.service_complete_emergency_access_operation(
    actor_employee_id,
    revoke_request_id,
    'revoke',
    true,
    jsonb_build_object('passwordRotated', true, 'banned', true)
  );
  assert payload #>> '{operation,status}' = 'completed'
    and payload #>> '{state,accountState}' = 'revoked',
    'Provider-verified revocation did not produce a durable revoked receipt.';

  payload := public.service_begin_emergency_access_restore(
    actor_employee_id, target_employee_id, restore_request_id,
    'Rollback regression controlled access restoration.', target_username, true,
    actor_auth_session_id, 'security_key', clock_timestamp()
  );
  assert payload #>> '{operation,status}' = 'provider_pending'
    and payload #>> '{state,accountState}' = 'restoration_pending'
    and (select disabled_at is not null from private.employee_accounts where employee_id = target_employee_id),
    'Restoration enabled the account before provider recovery completed.';

  payload := public.service_record_emergency_access_provider_progress(
    actor_employee_id,
    restore_request_id,
    'restore',
    jsonb_build_object(
      'recoveryDelivered', true,
      'recoveryDeliveredAt', clock_timestamp(),
      'recoveryUsableUntil', clock_timestamp() + interval '1 hour',
      'recoveryEmailMasked', 'e***@example.com'
    )
  );
  assert payload #>> '{operation,status}' = 'provider_pending'
    and (payload #>> '{providerResult,recoveryDelivered}')::boolean,
    'Recovery delivery progress was not checkpointed before unban.';

  payload := public.service_complete_emergency_access_operation(
    actor_employee_id,
    restore_request_id,
    'restore',
    false,
    jsonb_build_object('error', jsonb_build_object('code', 'unban_failed'))
  );
  assert payload #>> '{operation,status}' = 'provider_failed'
    and payload #>> '{state,accountState}' = 'restoration_attention'
    and (payload #>> '{providerResult,recoveryDelivered}')::boolean,
    'A restore delivery checkpoint was not retained for safe retry.';

  payload := public.service_begin_emergency_access_restore(
    actor_employee_id, target_employee_id, restore_request_id,
    'Rollback regression controlled access restoration.', target_username, true,
    actor_auth_session_id, 'security_key', clock_timestamp()
  );
  assert payload #>> '{operation,status}' = 'provider_pending'
    and (payload #>> '{providerResult,recoveryDelivered}')::boolean,
    'A restore retry discarded the prior recovery-delivery checkpoint.';

  update auth.users set banned_until = null where id = target_auth_user_id;
  payload := public.service_complete_emergency_access_operation(
    actor_employee_id,
    restore_request_id,
    'restore',
    true,
    jsonb_build_object('unbanned', true)
  );
  assert payload #>> '{operation,status}' = 'completed'
    and payload #>> '{state,accountState}' = 'active',
    'Provider-verified restoration did not reactivate the exact account.';
  assert (select disabled_at is null
                 and current_emergency_revocation_id is null
                 and must_change_password
                 and auth_tokens_invalid_before_epoch > 0
          from private.employee_accounts where employee_id = target_employee_id),
    'Restoration did not enforce a fresh password and session boundary.';

  assert not has_function_privilege(
    'authenticated',
    'public.admin_set_employee_account_state(uuid,boolean)',
    'EXECUTE'
  ), 'The timestamp-only browser account toggle remains executable.';
  assert has_function_privilege(
    'service_role',
    'public.service_begin_emergency_access_revoke(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.service_begin_emergency_access_revoke(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ), 'The emergency control plane is not service-role-only.';

  assert (select count(*) from public.schedules) = schedule_count_before
    and (select count(*) from public.shifts) = shift_count_before
    and (select count(*) from public.time_events) = punch_count_before
    and (select count(*) from private.payroll_export_rows) = payroll_count_before,
    'Emergency access work changed schedule, punch, or payroll records.';
end
$emergency_access_regression$;

rollback;

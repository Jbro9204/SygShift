-- Rollback-only regression for exact, replay-safe admin login-instruction
-- membership, credential identity, and completion audit semantics.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $durable_admin_login_instructions_regression$
declare
  actor_id uuid;
  recovery_actor_id uuid;
  auth_user_id uuid;
  operation_id uuid := gen_random_uuid();
  competing_operation_id uuid := gen_random_uuid();
  empty_operation_id uuid := gen_random_uuid();
  result jsonb;
  replay jsonb;
  manifest jsonb;
  conflict_rejected boolean := false;
  active_operation_rejected boolean := false;
  purpose_mismatch_rejected boolean := false;
  unresolved_audit_count_before integer := 0;
begin
  select employee.id, account.auth_user_id
  into actor_id, auth_user_id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  where employee.status = 'active'
    and account.auth_user_id is not null
  order by employee.created_at, employee.id
  limit 1;

  assert actor_id is not null and auth_user_id is not null,
    'An active employee account is required for this rollback-only regression.';

  select employee.id into recovery_actor_id
  from public.employees employee
  where employee.status = 'active'
  order by (employee.id = actor_id), employee.created_at, employee.id
  limit 1;
  assert recovery_actor_id is not null,
    'An active recovery operator is required for this rollback-only regression.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', auth_user_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );

  manifest := jsonb_build_array(jsonb_build_object(
    'employeeId', actor_id,
    'ordinal', 0,
    'employeeNumber', 'ROLLBACK-ONLY',
    'jobTitle', 'Regression',
    'username', 'durability-regression',
    'authEmail', 'durability-regression@sygshift.invalid',
    'contactEmail', 'durability-regression@example.net',
    'displayName', 'Durability Regression',
    'role', 'guard',
    'employmentType', 'hourly',
    'status', 'active',
    'existingAuthUserId', null,
    'candidateAuthUserId', null,
    'requiresMfa', false,
    'credentialFingerprint', repeat('a', 64)
  ));

  result := public.service_begin_admin_login_instruction_operation(
    operation_id, actor_id, 'bulk', 'admin_login_instructions', manifest
  );
  -- Simulate a racing/replayed request whose live directory membership has
  -- changed. First writer wins; the original exact member remains authoritative.
  replay := public.service_begin_admin_login_instruction_operation(
    operation_id, actor_id, 'bulk', 'admin_login_instructions', '[]'::jsonb
  );
  assert jsonb_array_length(result -> 'items') = 1
    and replay -> 'items' = result -> 'items',
    'A response-loss/concurrent retry must replay the first exact recipient manifest.';
  assert (
    select count(*) from private.admin_login_instruction_operations operation
    where operation.id = operation_id
  ) = 1, 'An exact retry must not add another operation.';
  assert (
    select count(*) from private.audit_events event
    where event.table_name = 'admin_login_instruction_operations'
      and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_PREPARED'
      and event.row_id = operation_id::text
  ) = 1, 'Operation preparation must have one audit event.';

  begin
    perform public.service_claim_admin_login_instruction_operation(
      operation_id, recovery_actor_id, 'bulk', 'onboarding_account_setup'
    );
  exception when check_violation then
    purpose_mismatch_rejected := true;
  end;
  assert purpose_mismatch_rejected,
    'An HR onboarding caller must not claim an admin login-instruction operation.';

  begin
    perform public.service_begin_admin_login_instruction_operation(
      competing_operation_id, actor_id, 'single', 'admin_login_instructions', manifest
    );
  exception when check_violation then
    active_operation_rejected := sqlerrm = 'login_instruction_employee_operation_active';
  end;
  assert active_operation_rejected,
    'A distinct-key concurrent operation for the same employee must fail before Auth work can begin.';
  assert not exists (
    select 1 from private.admin_login_instruction_operations operation
    where operation.id = competing_operation_id
  ), 'A conflicting bulk/single manifest must roll back atomically without a partial operation.';

  result := public.service_mark_admin_login_instruction_provisioned(
    operation_id, actor_id, actor_id, auth_user_id, 'created_auth_user'
  );
  -- Model a retryable response loss after the Auth mutation and durable
  -- provision mark. It remains unresolved/active rather than releasing the
  -- employee to a second credential operation.
  perform public.service_record_admin_login_instruction_outcome(
    operation_id,
    actor_id,
    actor_id,
    'unresolved',
    'auth_response_lost',
    503,
    'Rollback-only simulated response loss.'
  );
  active_operation_rejected := false;
  begin
    perform public.service_begin_admin_login_instruction_operation(
      competing_operation_id, recovery_actor_id, 'single', 'admin_login_instructions', manifest
    );
  exception when check_violation then
    active_operation_rejected := sqlerrm = 'login_instruction_employee_operation_active';
  end;
  assert active_operation_rejected,
    'A retryable unresolved item must retain the active employee reservation.';

  replay := public.service_claim_admin_login_instruction_operation(
    operation_id, recovery_actor_id, 'bulk', 'admin_login_instructions'
  );
  perform public.service_claim_admin_login_instruction_operation(
    operation_id, recovery_actor_id, 'bulk', 'admin_login_instructions'
  );
  assert replay ->> 'operationId' = operation_id::text
    and replay ->> 'actorEmployeeId' = actor_id::text,
    'Browser-loss recovery must preserve the original operation and actor.';
  assert (
    select count(*) from private.audit_events event
    where event.table_name = 'admin_login_instruction_operations'
      and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_RECOVERY_CLAIMED'
      and event.row_id = operation_id::text || ':recovery:' || recovery_actor_id::text
  ) = 1, 'Repeated recovery claims by one administrator must have one audit event.';

  replay := public.service_mark_admin_login_instruction_provisioned(
    operation_id, actor_id, actor_id, auth_user_id, 'created_auth_user'
  );
  assert replay -> 'items' -> 0 ->> 'state' = 'provisioned'
    and replay -> 'items' -> 0 ->> 'action' = 'created_auth_user'
    and replay -> 'items' -> 0 ->> 'errorCode' is null,
    'Created-account retry must preserve its original action and clear current error state.';

  begin
    perform public.service_mark_admin_login_instruction_provisioned(
      operation_id, actor_id, actor_id, gen_random_uuid(), 'updated_existing_auth_user'
    );
  exception when check_violation then
    conflict_rejected := true;
  end;
  assert conflict_rejected,
    'An active retry must not replace the durable Auth identity or action.';

  result := public.service_record_admin_login_instruction_outcome(
    operation_id, actor_id, actor_id, 'completed', null, null, null
  );
  replay := public.service_record_admin_login_instruction_outcome(
    operation_id, actor_id, actor_id, 'completed', null, null, null
  );
  assert result ->> 'state' = 'completed'
    and replay = result,
    'Accepted-delivery completion must replay the exact completed result.';
  assert (
    select count(*) from private.audit_events event
    where event.table_name = 'admin_login_instruction_items'
      and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_COMPLETED'
      and event.row_id = operation_id::text || ':' || actor_id::text
  ) = 1, 'Completion replay must not duplicate the completion audit.';

  select count(*) into unresolved_audit_count_before
  from private.audit_events event
  where event.table_name = 'admin_login_instruction_items'
    and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_UNRESOLVED'
    and event.row_id = operation_id::text || ':' || actor_id::text;
  assert unresolved_audit_count_before = 1,
    'The earlier durable unresolved outcome must retain exactly one historical audit.';

  replay := public.service_record_admin_login_instruction_outcome(
    operation_id,
    actor_id,
    actor_id,
    'unresolved',
    'email_delivery_unresolved',
    409,
    'Rollback-only stale concurrent observation.'
  );
  assert replay -> 'items' -> 0 ->> 'state' = 'completed'
    and (
      select count(*) from private.audit_events event
      where event.table_name = 'admin_login_instruction_items'
        and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_UNRESOLVED'
        and event.row_id = operation_id::text || ':' || actor_id::text
    ) = unresolved_audit_count_before,
    'A stale concurrent unresolved outcome must replay terminal completion without a conflicting audit.';

  replay := public.service_mark_admin_login_instruction_provisioned(
    operation_id, actor_id, actor_id, gen_random_uuid(), 'updated_existing_auth_user'
  );
  assert replay -> 'items' -> 0 ->> 'state' = 'completed',
    'A stale provision result must not reopen or rewrite terminal completion.';

  result := public.service_begin_admin_login_instruction_operation(
    competing_operation_id, recovery_actor_id, 'single', 'admin_login_instructions', manifest
  );
  result := public.service_record_admin_login_instruction_outcome(
    competing_operation_id,
    recovery_actor_id,
    actor_id,
    'failed',
    'login_instruction_target_changed',
    409,
    'Rollback-only terminal target change.'
  );
  replay := public.service_record_admin_login_instruction_outcome(
    competing_operation_id,
    recovery_actor_id,
    actor_id,
    'unresolved',
    'email_delivery_unresolved',
    409,
    'Rollback-only stale concurrent observation after terminal failure.'
  );
  replay := public.service_mark_admin_login_instruction_provisioned(
    competing_operation_id,
    recovery_actor_id,
    actor_id,
    auth_user_id,
    'updated_existing_auth_user'
  );
  assert replay -> 'items' -> 0 ->> 'state' = 'failed'
    and (
      select count(*) from private.audit_events event
      where event.table_name = 'admin_login_instruction_items'
        and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_UNRESOLVED'
        and event.row_id = competing_operation_id::text || ':' || actor_id::text
    ) = 0,
    'A stale provision/unresolved caller must not reopen a terminal failed item.';

  result := public.service_begin_admin_login_instruction_operation(
    empty_operation_id, actor_id, 'bulk', 'admin_login_instructions', '[]'::jsonb
  );
  replay := public.service_begin_admin_login_instruction_operation(
    empty_operation_id, actor_id, 'bulk', 'admin_login_instructions', manifest
  );
  assert result ->> 'state' = 'completed'
    and jsonb_array_length(result -> 'items') = 0
    and replay -> 'items' = '[]'::jsonb,
    'An empty bulk operation must be durably completed and cannot select later employees on retry.';

  assert not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'private'
      and column_info.table_name in ('admin_login_instruction_operations', 'admin_login_instruction_items')
      and column_info.column_name ~ '(password|credential_value|secret)'
  ), 'Durable login-instruction storage must not contain plaintext credential columns.';
end
$durable_admin_login_instructions_regression$;

do $durable_onboarding_delivery_attempt_regression$
declare
  actor_id uuid;
  actor_auth_user_id uuid;
  onboarding_case_id uuid;
  fixture jsonb;
  first_attempt jsonb;
  replay jsonb;
  replacement_attempt jsonb;
  stale_result_rejected boolean := false;
begin
  select employee.id, account.auth_user_id
  into actor_id, actor_auth_user_id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
   and account.activated_at is not null
  where employee.status = 'active'
    and 'hr.onboarding.manage' = any(coalesce(private.employee_effective_permissions(employee.id), array[]::text[]))
  order by employee.created_at, employee.id
  limit 1;
  assert actor_id is not null and actor_auth_user_id is not null,
    'An active onboarding manager is required for this rollback-only regression.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );
  update private.hr_onboarding_release_gate set enabled = true where singleton = true;

  -- Build an isolated onboarding target inside this rollback-only transaction.
  -- Production can legitimately have no active onboarding profile, and the
  -- regression must not depend on or rewrite an employee's real case.
  fixture := public.service_hr_onboarding_create_prehire(
    actor_id,
    jsonb_build_object(
      'firstName', 'Rollback',
      'lastName', 'Durability',
      'personalEmail', 'rollback-durability-' || gen_random_uuid()::text || '@example.net',
      'positionTitle', 'Regression Fixture',
      'workState', 'CO',
      'timeZone', 'America/Denver',
      'role', 'guard',
      'employmentType', 'hourly',
      'jobFamily', 'guard',
      'startDate', current_date::text,
      'requiresGuardLicense', false,
      'requiresArmedCredentials', false
    ),
    'Rollback-only delivery durability regression fixture.'
  );
  onboarding_case_id := (fixture ->> 'caseId')::uuid;
  assert onboarding_case_id is not null,
    'The rollback-only onboarding fixture must create a case.';

  update private.hr_onboarding_profiles profile
  set welcome_email_status = 'not_sent',
      welcome_email_sent_at = null,
      account_setup_status = 'not_sent',
      account_setup_sent_at = null,
      last_delivery_error = null,
      welcome_package_attempt_id = null,
      welcome_package_attempt_number = 0,
      welcome_package_attempt_state = null,
      welcome_package_attempt_started_at = null
  where profile.case_id = onboarding_case_id;

  first_attempt := public.service_claim_hr_onboarding_delivery_attempt(actor_id, onboarding_case_id);
  replay := public.service_claim_hr_onboarding_delivery_attempt(actor_id, onboarding_case_id);
  assert first_attempt ->> 'attemptId' = replay ->> 'attemptId'
    and first_attempt ->> 'state' = 'active',
    'A response-loss retry must reuse the active onboarding delivery attempt.';

  perform public.service_hr_onboarding_record_delivery(
    actor_id, onboarding_case_id, (first_attempt ->> 'attemptId')::uuid,
    'welcome', 'sent', null, 'Rollback-only welcome acceptance.'
  );
  -- Replaying a committed result after response loss is monotonic and must not
  -- append a duplicate delivery event or allocate another source identity.
  perform public.service_hr_onboarding_record_delivery(
    actor_id, onboarding_case_id, (first_attempt ->> 'attemptId')::uuid,
    'welcome', 'sent', null, 'Rollback-only welcome acceptance.'
  );
  replay := public.service_claim_hr_onboarding_delivery_attempt(actor_id, onboarding_case_id);
  assert replay ->> 'attemptId' = first_attempt ->> 'attemptId'
    and replay ->> 'welcomeStatus' = 'sent'
    and replay ->> 'accountSetupStatus' = 'not_sent',
    'Welcome finalization replay must preserve the attempt and must not resend the accepted welcome.';
  assert (
    select count(*)
    from private.hr_onboarding_events event
    where event.case_id = onboarding_case_id
      and event.action = 'deliver_welcome'
      and event.details ->> 'attemptId' = first_attempt ->> 'attemptId'
  ) = 1, 'Welcome response-loss replay must have one delivery event.';

  perform public.service_hr_onboarding_record_delivery(
    actor_id, onboarding_case_id, (first_attempt ->> 'attemptId')::uuid,
    'account_setup', 'failed', 'Definitively unsent rollback-only failure.', 'Rollback-only terminal failure.'
  );
  replacement_attempt := public.service_claim_hr_onboarding_delivery_attempt(actor_id, onboarding_case_id);
  replay := public.service_claim_hr_onboarding_delivery_attempt(actor_id, onboarding_case_id);
  assert replacement_attempt ->> 'attemptId' <> first_attempt ->> 'attemptId'
    and replacement_attempt ->> 'attemptId' = replay ->> 'attemptId'
    and (replacement_attempt ->> 'attemptNumber')::integer = (first_attempt ->> 'attemptNumber')::integer + 1
    and replacement_attempt ->> 'welcomeStatus' = 'sent'
    and replacement_attempt ->> 'accountSetupStatus' = 'not_sent',
    'Only a terminal failed attempt may advance, and concurrent/replayed claims must share the replacement identity.';

  perform public.service_hr_onboarding_record_delivery(
    actor_id, onboarding_case_id, (replacement_attempt ->> 'attemptId')::uuid,
    'account_setup', 'sent', null, 'Rollback-only repaired account setup.'
  );
  replay := public.service_claim_hr_onboarding_delivery_attempt(actor_id, onboarding_case_id);
  assert replay ->> 'attemptId' = replacement_attempt ->> 'attemptId'
    and replay ->> 'state' = 'completed',
    'A completed replacement remains replayable and can never rotate delivery identity.';

  begin
    perform public.service_hr_onboarding_record_delivery(
      actor_id, onboarding_case_id, (first_attempt ->> 'attemptId')::uuid,
      'account_setup', 'failed', 'Stale failure.', 'Rollback-only stale result.'
    );
  exception when check_violation then
    stale_result_rejected := true;
  end;
  assert stale_result_rejected,
    'A stale prior-attempt result must not downgrade or replace the current completed attempt.';

  assert (
    select count(*)
    from private.hr_onboarding_events event
    where event.case_id = onboarding_case_id
      and event.action = 'claim_welcome_package_delivery_attempt'
  ) = 2, 'Exactly one claim event is required for the original and replacement attempts.';
end
$durable_onboarding_delivery_attempt_regression$;

rollback;

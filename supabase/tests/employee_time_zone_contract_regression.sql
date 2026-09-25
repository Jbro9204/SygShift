begin;

select set_config('request.jwt.claim.role', 'service_role', true);

create temporary table employee_time_zone_regression_targets (
  shift_id uuid primary key,
  expected_starts_at timestamptz not null,
  expected_ends_at timestamptz not null
) on commit drop;

insert into employee_time_zone_regression_targets (shift_id, expected_starts_at, expected_ends_at) values
  ('eeefd9ad-24a3-4b2f-9eb0-024c2ad11b72','2026-09-25 14:00:00+00','2026-09-25 22:00:00+00'),
  ('3cbaedd1-b0bc-49ce-bf6c-e072bbfbdd59','2026-09-28 13:00:00+00','2026-09-28 21:00:00+00'),
  ('1bb70e30-75ca-47ff-a7e6-74e9e680c063','2026-09-28 13:00:00+00','2026-09-28 21:00:00+00'),
  ('ac5a2a95-3927-4a22-96c3-b7ff249c076c','2026-09-29 13:00:00+00','2026-09-29 21:00:00+00'),
  ('30018cf0-518e-441b-b09a-e932a066575e','2026-09-29 13:00:00+00','2026-09-29 21:00:00+00'),
  ('f71580b0-2f25-409e-9788-d41473068584','2026-09-30 13:00:00+00','2026-09-30 21:00:00+00'),
  ('ca5b3620-a985-4a05-9453-e04005657637','2026-09-30 13:00:00+00','2026-09-30 21:00:00+00'),
  ('de438f72-e755-4a94-8582-c3301428e221','2026-10-01 13:00:00+00','2026-10-01 21:00:00+00'),
  ('8791d986-ac7a-4851-8a09-2c9554d96a9f','2026-10-01 13:00:00+00','2026-10-01 21:00:00+00'),
  ('86b74b86-7975-43f7-9db9-7d6691282ab7','2026-10-02 13:00:00+00','2026-10-02 21:00:00+00'),
  ('592930df-6dbd-486e-8525-50ede68e4644','2026-10-02 13:00:00+00','2026-10-02 21:00:00+00');

do $$
begin
  if has_table_privilege('authenticated', 'public.employees', 'INSERT')
    or has_table_privilege('authenticated', 'public.employees', 'UPDATE')
    or has_table_privilege('authenticated', 'public.employees', 'DELETE')
  then
    raise exception 'Authenticated clients retain direct employee mutation privileges.';
  end if;
end
$$;

set local role authenticated;
do $$
begin
  begin
    insert into public.employees (first_name, last_name, time_zone)
    values ('Direct', 'DmlTimezoneBypass', 'America/New_York');
    raise exception 'Authenticated direct employee INSERT unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
reset role;

do $$
declare
  onboarding_actor_id uuid;
  recruiting_actor_id uuid;
  licensing_actor_auth_user_id uuid;
  licensing_created_employee_id uuid;
  licensing_existing_employee_id uuid;
  error_message text;
  constraint_definition text;
  import_legacy_definition text;
  import_wrapper_definition text;
  licensing_definition text;
  weekly_definition text;
  dashboard_definition text;
  misty_id constant uuid := 'd4893a26-1a0b-483d-bbe3-00373c3caaac';
begin
  begin
    perform public.admin_create_employee_with_time_zone(
      target_first_name => 'Blank',
      target_last_name => 'Zone',
      target_time_zone => null
    );
    raise exception 'User Accounts accepted a blank employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected blank time-zone denial: %', error_message;
      end if;
  end;

  begin
    perform public.admin_create_employee_with_time_zone(
      target_first_name => 'Unsupported',
      target_last_name => 'Zone',
      target_time_zone => 'UTC'
    );
    raise exception 'User Accounts accepted an unsupported employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected unsupported time-zone denial: %', error_message;
      end if;
  end;

  if has_function_privilege(
    'authenticated',
    'public.admin_create_employee(text,text,text,text,public.app_role,public.employment_type,public.employee_status,text,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated users can still bypass the explicit-zone wrapper through admin_create_employee.';
  end if;

  if exists (
    select 1
    from pg_proc procedure_record
    join pg_namespace namespace_record on namespace_record.oid = procedure_record.pronamespace
    where namespace_record.nspname = 'public'
      and procedure_record.prokind = 'f'
      and position('insert into public.employees' in lower(pg_get_functiondef(procedure_record.oid))) > 0
      and has_function_privilege('authenticated', procedure_record.oid, 'EXECUTE')
      and procedure_record.oid not in (
        'public.admin_create_employee_with_time_zone(text,text,text,text,public.app_role,public.employment_type,public.employee_status,text,text,text,text,text,text)'::regprocedure,
        'public.upsert_licensing_employee(uuid,text,text,text,text,text,public.employment_type,public.employee_status,text,text,text,public.app_role,text)'::regprocedure
      )
  ) then
    raise exception 'An unreviewed authenticated employee-creation RPC remains outside the explicit-zone contract.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.upsert_licensing_employee(uuid,text,text,text,text,text,public.employment_type,public.employee_status,text,text,text,public.app_role)',
    'EXECUTE'
  ) then
    raise exception 'The rolling-release Licensing Center edit signature is unavailable.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.upsert_licensing_employee(uuid,text,text,text,text,text,public.employment_type,public.employee_status,text,text,text,public.app_role,text)',
    'EXECUTE'
  ) then
    raise exception 'The explicit-zone Licensing Center employee RPC is unavailable to authenticated users.';
  end if;

  select pg_get_functiondef(
    'public.upsert_licensing_employee(uuid,text,text,text,text,text,public.employment_type,public.employee_status,text,text,text,public.app_role,text)'::regprocedure
  ) into licensing_definition;
  if position('insert into public.employees' in lower(licensing_definition)) = 0
    or position('time_zone' in lower(licensing_definition)) = 0
    or position('use user accounts to change an existing employee time zone' in lower(licensing_definition)) = 0
    or position('private.generate_username' in lower(licensing_definition)) = 0
  then
    raise exception 'The Licensing Center employee RPC does not enforce the reviewed create/update time-zone contract.';
  end if;

  select account.auth_user_id
  into licensing_actor_auth_user_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.disabled_at is null
    and employee.status = 'active'
    and employee.role = 'admin'
  order by employee.created_at
  limit 1;

  if licensing_actor_auth_user_id is null then
    raise exception 'An active admin account is required for the Licensing Center regression.';
  end if;

  perform set_config('request.jwt.claim.sub', licensing_actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', licensing_actor_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  begin
    perform public.upsert_licensing_employee(
      null, 'BlankLicensing', null, 'TimezoneRegression', null, null,
      'hourly', 'onboarding', null, null, null, 'guard', null
    );
    raise exception 'Licensing Center accepted a blank employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected Licensing Center blank time-zone denial: %', error_message;
      end if;
  end;

  begin
    perform public.upsert_licensing_employee(
      null, 'UnsupportedLicensing', null, 'TimezoneRegression', null, null,
      'hourly', 'onboarding', null, null, null, 'guard', 'UTC'
    );
    raise exception 'Licensing Center accepted an unsupported employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected Licensing Center unsupported time-zone denial: %', error_message;
      end if;
  end;

  perform public.upsert_licensing_employee(
    null, 'ExplicitLicensing', null, 'TimezoneRegression', null, null,
    'hourly', 'onboarding', null, null, null, 'guard', 'America/Phoenix'
  );

  select employee.id into strict licensing_created_employee_id
  from public.employees employee
  where employee.first_name = 'ExplicitLicensing'
    and employee.last_name = 'TimezoneRegression'
    and employee.time_zone = 'America/Phoenix'
    and employee.username ~ '^etimezoneregression[0-9]*$';

  if not exists (
    select 1
    from private.username_registry registry
    where registry.employee_id = licensing_created_employee_id
      and registry.username = (
        select employee.username from public.employees employee where employee.id = licensing_created_employee_id
      )
  ) then
    raise exception 'Licensing Center creation did not preserve generated username registration.';
  end if;

  begin
    perform public.upsert_licensing_employee(
      null, 'LegacyLicensing', null, 'TimezoneRegression', null, null,
      'hourly', 'onboarding', null, null, null, 'guard'
    );
    raise exception 'The rolling-release Licensing Center signature created an employee without a zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Refresh this page and choose the employee time zone before creating the employee.' then
        raise exception 'Unexpected rolling-release Licensing create denial: %', error_message;
      end if;
  end;

  insert into public.employees (first_name, last_name, role, status, time_zone)
  values ('ExistingLicensing', 'TimezoneRegression', 'guard', 'onboarding', 'America/New_York')
  returning id into licensing_existing_employee_id;

  perform public.upsert_licensing_employee(
    licensing_existing_employee_id, 'ExistingLicensingUpdated', null,
    'TimezoneRegression', null, null, 'hourly', 'onboarding',
    null, null, null, 'guard'
  );

  if not exists (
    select 1 from public.employees employee
    where employee.id = licensing_existing_employee_id
      and employee.first_name = 'ExistingLicensingUpdated'
      and employee.time_zone = 'America/New_York'
  ) then
    raise exception 'Licensing Center existing-profile update replaced the saved employee time zone.';
  end if;

  begin
    perform public.upsert_licensing_employee(
      licensing_existing_employee_id, 'ExistingLicensingUpdated', null,
      'TimezoneRegression', null, null, 'hourly', 'onboarding',
      null, null, null, 'guard', 'America/Chicago'
    );
    raise exception 'Licensing Center accepted an unauthorized existing-employee time-zone change.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Use User Accounts to change an existing employee time zone.' then
        raise exception 'Unexpected Licensing Center existing-zone denial: %', error_message;
      end if;
  end;

  if not has_function_privilege(
    'authenticated',
    'public.promote_import_scope(uuid,date,date,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'The hard-locked Operational Import wrapper is unavailable to its authorized UI.';
  end if;

  if has_function_privilege(
    'authenticated',
    'private.promote_legacy_colorado_import_scope(uuid,date,date,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated clients can bypass the hard-locked Operational Import wrapper.';
  end if;

  select pg_get_functiondef(
    'public.promote_import_scope(uuid,date,date,boolean,text)'::regprocedure
  ) into import_wrapper_definition;
  select pg_get_functiondef(
    'private.promote_legacy_colorado_import_scope(uuid,date,date,boolean,text)'::regprocedure
  ) into import_legacy_definition;

  if position('68d8dc39-d46b-4306-b82d-e10f3dd0c554' in import_wrapper_definition) = 0
    or position('5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0' in import_wrapper_definition) = 0
    or position('2026-06-28' in import_wrapper_definition) = 0
    or position('2026-08-15' in import_wrapper_definition) = 0
    or position('America/Denver' in import_wrapper_definition) = 0
    or position('promote_legacy_colorado_import_scope' in import_wrapper_definition) = 0
    or position('at time zone ''America/Denver''' in import_legacy_definition) = 0
  then
    raise exception 'Operational Import is not locked to the reviewed Colorado source, scope, and Mountain semantics.';
  end if;

  if exists (
    select 1 from private.source_files source
    where source.sha256 = '5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0'
  ) and not exists (
    select 1
    from private.import_runs import_run
    join private.source_files source on source.id = import_run.source_file_id
    join private.import_promotion_batches batch on batch.import_run_id = import_run.id
    where import_run.id = '68d8dc39-d46b-4306-b82d-e10f3dd0c554'::uuid
      and source.sha256 = '5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0'
      and batch.from_date = date '2026-06-28'
      and batch.through_date = date '2026-08-15'
  ) then
    raise exception 'The production Colorado legacy source no longer matches its locked run and completed scope.';
  end if;

  if exists (
    select 1
    from private.import_promotion_batches batch
    where batch.import_run_id = '68d8dc39-d46b-4306-b82d-e10f3dd0c554'::uuid
      and batch.from_date = date '2026-06-28'
      and batch.through_date = date '2026-08-15'
  ) then
    begin
      perform public.promote_import_scope(
        '68d8dc39-d46b-4306-b82d-e10f3dd0c554'::uuid,
        date '2026-06-28', date '2026-08-15', true,
        'Rollback-only replay denial regression.'
      );
      raise exception 'The completed Colorado legacy import could be replayed.';
    exception
      when check_violation then
        get stacked diagnostics error_message = message_text;
        if error_message <> 'This import date range overlaps an existing promotion batch.' then
          raise exception 'Unexpected Colorado legacy import replay denial: %', error_message;
        end if;
    end;
  end if;

  if exists (
    select 1
    from private.import_runs import_run
    where import_run.id = '68d8dc39-d46b-4306-b82d-e10f3dd0c554'::uuid
  ) and not exists (
    select 1 from private.audit_events audit
    where audit.operation = 'LEGACY_COLORADO_IMPORT_CONTRACT_LOCK'
      and audit.row_id = '68d8dc39-d46b-4306-b82d-e10f3dd0c554'
      and audit.new_record ->> 'employeeTimeZone' = 'America/Denver'
      and audit.new_record ->> 'authenticatedReplayBlocked' = 'true'
  ) then
    raise exception 'The Colorado legacy import contract lock audit is missing.';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.service_request_candidate_conversion(uuid,uuid,public.app_role,public.employment_type,text,date,text)',
    'EXECUTE'
  ) then
    raise exception 'The rolling-release candidate-conversion signature is unavailable to the Worker service role.';
  end if;

  begin
    perform public.service_request_candidate_conversion(
      null, null, 'guard', 'hourly', 'Guard', '2026-10-05',
      'Rollback-only rolling-release candidate conversion rejection.'
    );
    raise exception 'The rolling-release candidate-conversion signature accepted a request without a time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Refresh SygShift and choose the employee time zone before requesting candidate conversion.' then
        raise exception 'Unexpected rolling-release candidate conversion denial: %', error_message;
      end if;
  end;

  if not has_function_privilege(
    'service_role',
    'public.service_request_candidate_conversion(uuid,uuid,public.app_role,public.employment_type,text,date,text,text)',
    'EXECUTE'
  ) then
    raise exception 'The explicit-zone candidate-conversion signature is not available to the Worker service role.';
  end if;

  if exists (
    select 1
    from information_schema.columns column_record
    where column_record.table_schema = 'private'
      and column_record.table_name = 'hr_candidate_conversion_requests'
      and column_record.column_name = 'proposed_time_zone'
      and column_record.is_nullable <> 'NO'
  ) then
    raise exception 'Candidate conversion proposed_time_zone is still nullable.';
  end if;

  select pg_get_constraintdef(constraint_record.oid)
  into constraint_definition
  from pg_constraint constraint_record
  where constraint_record.conrelid = 'public.employees'::regclass
    and constraint_record.conname = 'employees_continental_us_time_zone';
  if constraint_definition is null or position('America/Phoenix' in constraint_definition) = 0 then
    raise exception 'The employee time-zone constraint does not support non-DST Arizona time.';
  end if;

  select pg_get_constraintdef(constraint_record.oid)
  into constraint_definition
  from pg_constraint constraint_record
  where constraint_record.conrelid = 'private.hr_onboarding_profiles'::regclass
    and constraint_record.conname = 'hr_onboarding_profile_state';
  if constraint_definition is null or position('NC' in constraint_definition) = 0 then
    raise exception 'The onboarding work-state constraint does not allow North Carolina.';
  end if;

  select gate.enabled_by into onboarding_actor_id
  from private.hr_onboarding_release_gate gate
  where gate.singleton and gate.enabled;
  if onboarding_actor_id is null then
    raise exception 'The enabled onboarding release does not have a regression actor.';
  end if;

  begin
    perform public.service_hr_onboarding_create_prehire(
      onboarding_actor_id,
      jsonb_build_object(
        'firstName','Blank', 'lastName','Zone',
        'personalEmail','blank-zone-regression@example.invalid',
        'positionTitle','Guard', 'workState','NC', 'timeZone','',
        'role','guard', 'employmentType','hourly', 'jobFamily','guard',
        'startDate','2026-10-05', 'requiresGuardLicense',true,
        'requiresArmedCredentials',false
      ),
      'Rollback-only blank time-zone rejection.'
    );
    raise exception 'Onboarding accepted a blank employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected onboarding blank time-zone denial: %', error_message;
      end if;
  end;

  begin
    perform public.service_hr_onboarding_create_prehire(
      onboarding_actor_id,
      jsonb_build_object(
        'firstName','Unsupported', 'lastName','Zone',
        'personalEmail','unsupported-zone-regression@example.invalid',
        'positionTitle','Guard', 'workState','NC', 'timeZone','UTC',
        'role','guard', 'employmentType','hourly', 'jobFamily','guard',
        'startDate','2026-10-05', 'requiresGuardLicense',true,
        'requiresArmedCredentials',false
      ),
      'Rollback-only unsupported time-zone rejection.'
    );
    raise exception 'Onboarding accepted an unsupported employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected onboarding unsupported time-zone denial: %', error_message;
      end if;
  end;

  select gate.enabled_by into recruiting_actor_id
  from private.hr_recruiting_release_gate gate
  where gate.singleton and gate.enabled;
  if recruiting_actor_id is null then
    raise exception 'The enabled recruiting release does not have a regression actor.';
  end if;

  begin
    perform public.service_request_candidate_conversion(
      recruiting_actor_id,
      '10000000-0000-4000-8000-000000000001',
      'guard', 'hourly', 'Guard', '2026-10-05', '',
      'Rollback-only blank candidate time-zone rejection.'
    );
    raise exception 'Candidate conversion accepted a blank employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected candidate blank time-zone denial: %', error_message;
      end if;
  end;

  begin
    perform public.service_request_candidate_conversion(
      recruiting_actor_id,
      '10000000-0000-4000-8000-000000000001',
      'guard', 'hourly', 'Guard', '2026-10-05', 'UTC',
      'Rollback-only unsupported candidate time-zone rejection.'
    );
    raise exception 'Candidate conversion accepted an unsupported employee time zone.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected candidate unsupported time-zone denial: %', error_message;
      end if;
  end;

  select pg_get_functiondef('public.get_weekly_schedule_payload(date)'::regprocedure)
  into weekly_definition;
  if position('time_zone_source' in lower(weekly_definition)) = 0
    or lower(weekly_definition) !~ '''time_zone_employee_id''[^\n]*case[^\n]*when[[:space:]]+can_view_all_schedule[^\n]*then[[:space:]]+shift.time_zone_employee_id[^\n]*else[[:space:]]+null'
  then
    raise exception 'The weekly schedule payload is missing source metadata or employee-id privacy.';
  end if;

  select pg_get_functiondef('public.get_timekeeping_dashboard(date)'::regprocedure)
  into dashboard_definition;
  if position('server_now at time zone employee_record.time_zone' in lower(dashboard_definition)) = 0
    or position('event.recorded_at at time zone employee_record.time_zone' in lower(dashboard_definition)) = 0
    or position('operationaltimezone' in lower(dashboard_definition)) = 0
    or position('employee_record.time_zone' in lower(dashboard_definition)) = 0
  then
    raise exception 'The personal timekeeping dashboard is not based on the employee profile zone.';
  end if;

  if not exists (select 1 from public.employees employee where employee.id = misty_id) then
    raise exception 'The exact Misty Kimbal production repair target is missing.';
  end if;

    if not exists (
      select 1 from public.employees employee
      where employee.id = misty_id
        and employee.employee_number = 'SYG-1131'
        and employee.username = 'mkimbal'
        and employee.first_name = 'Misty'
        and employee.last_name = 'Kimbal'
        and employee.time_zone = 'America/New_York'
    ) then
      raise exception 'Misty Kimbal employee identity/time-zone repair is not exact.';
    end if;

    if (
      select count(*)
      from employee_time_zone_regression_targets target
      join public.shifts shift on shift.id = target.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      where shift.starts_at = target.expected_starts_at
        and shift.ends_at = target.expected_ends_at
        and shift.time_zone = 'America/New_York'
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = misty_id
        and shift.canceled_at is null
        and schedule.status in ('draft','published')
        and exists (
          select 1 from public.shift_assignments assignment
          where assignment.shift_id = shift.id
            and assignment.employee_id = misty_id
            and assignment.status in ('assigned','confirmed','completed')
            and assignment.canceled_at is null
        )
    ) <> 11 then
      raise exception 'Misty Kimbal reviewed shifts did not preserve all 11 active UTC ranges and source links.';
    end if;

    if not exists (
      select 1
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id
      where shift.id = 'eeefd9ad-24a3-4b2f-9eb0-024c2ad11b72'::uuid
        and shift.starts_at = '2026-09-25 14:00:00+00'::timestamptz
        and shift.ends_at = '2026-09-25 22:00:00+00'::timestamptz
        and shift.time_zone = 'America/New_York'
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = misty_id
        and schedule.status = 'published'
        and exists (
          select 1 from public.shift_assignments assignment
          where assignment.shift_id = shift.id
            and assignment.employee_id = misty_id
            and assignment.status in ('assigned','confirmed','completed')
            and assignment.canceled_at is null
        )
    ) then
      raise exception 'Misty Kimbal published 09/25 14:00Z occurrence did not retain its reviewed instant/source/assignment.';
    end if;

    if not exists (
      select 1
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id
      where shift.id = '6b80d59a-8d5e-43be-8131-23100d19c1a9'::uuid
        and shift.starts_at = '2026-09-25 13:00:00+00'::timestamptz
        and shift.ends_at = '2026-09-25 21:00:00+00'::timestamptz
        and shift.time_zone = 'America/Denver'
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = misty_id
        and schedule.status = 'superseded'
    ) then
      raise exception 'Misty Kimbal superseded 09/25 history was not preserved exactly.';
    end if;

    if exists (
      select 1
      from public.shifts shift
      join public.schedules schedule on schedule.id = shift.schedule_id
      where schedule.status in ('draft','published')
        and shift.canceled_at is null
        and shift.time_zone_source = 'employee'
        and shift.time_zone_employee_id = misty_id
        and shift.starts_at >= '2026-09-25 00:00:00+00'::timestamptz
        and exists (
          select 1 from public.shift_assignments assignment
          where assignment.shift_id = shift.id
            and assignment.employee_id = misty_id
            and assignment.status in ('assigned','confirmed','completed')
            and assignment.canceled_at is null
        )
        and not exists (
          select 1 from employee_time_zone_regression_targets target where target.shift_id = shift.id
        )
    ) then
      raise exception 'An unreviewed active assigned Misty shift was changed by the repair scope.';
    end if;

    if not exists (
      select 1
      from public.shifts shift
      where shift.id = 'eeefd9ad-24a3-4b2f-9eb0-024c2ad11b72'
        and shift.starts_at = '2026-09-25 14:00:00+00'::timestamptz
        and shift.ends_at = '2026-09-25 22:00:00+00'::timestamptz
    ) then
      raise exception 'The unresolved 09/25 published timing anomaly was silently converted.';
    end if;

    if not exists (
      select 1 from private.audit_events audit
      where audit.operation = 'TIME_ZONE_CONTRACT_REPAIR'
        and audit.row_id = misty_id::text
        and audit.new_record->>'startsAtAndEndsAtPreserved' = 'true'
        and audit.new_record->>'reviewedShiftCount' = '11'
        and audit.new_record->>'published1400UtcCurrentRowGuarded' = 'true'
        and audit.new_record->>'superseded1300UtcHistoryPreserved' = 'true'
        and audit.new_record->>'published1400UtcAnomalyPreservedForManualReview' = 'true'
    ) then
      raise exception 'The exact Misty time-zone repair audit event is missing.';
    end if;
end
$$;

rollback;

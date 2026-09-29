begin;

set local statement_timeout = '60s';

do $permission_contract$
declare
  expected_role_count integer;
begin
  assert exists (
    select 1
    from public.permission_catalog permission
    where permission.code = 'schedule.salary_shifts.manage'
      and permission.active
      and permission.requires_mfa
      and permission.locked
  ), 'Salaried shift presence uses an active, locked, MFA-protected permission.';

  select count(*) into expected_role_count
  from public.access_role_permissions role_permission
  join public.access_roles access_role on access_role.id = role_permission.role_id
  where role_permission.permission_code = 'schedule.salary_shifts.manage'
    and role_permission.enabled
    and access_role.code in (
      'system_scheduler',
      'system_supervisor',
      'operations_manager',
      'human_resources',
      'system_admin'
    );

  assert expected_role_count = 5,
    'Scheduler, Supervisor, Operations Manager, HR Manager, and Admin receive the manager permission.';
  assert not exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'schedule.salary_shifts.manage'
      and role_permission.enabled
      and access_role.code in ('system_guard', 'system_dispatcher', 'human_resources_employee')
  ), 'Guard, Dispatcher, and HR Employee do not receive salaried shift management by default.';

  assert not has_schema_privilege('authenticated', 'private', 'USAGE'),
    'Authenticated clients cannot enter the private ledger schema.';
  assert not has_table_privilege(
    'authenticated', 'private.salaried_shift_presence_events', 'SELECT'
  ), 'Authenticated clients cannot read the private marker ledger directly.';
  assert not has_table_privilege(
    'authenticated', 'private.salaried_shift_presence_events', 'INSERT'
  ), 'Authenticated clients cannot insert marker ledger rows directly.';
  assert not has_table_privilege(
    'authenticated', 'private.salaried_shift_presence_events', 'UPDATE'
  ), 'Authenticated clients cannot update marker ledger rows directly.';
  assert not has_table_privilege(
    'authenticated', 'private.salaried_shift_presence_events', 'DELETE'
  ), 'Authenticated clients cannot delete marker ledger rows directly.';
  assert not has_table_privilege(
    'authenticated', 'private.salaried_shift_presence_requests', 'SELECT'
  ) and not has_table_privilege(
    'authenticated', 'private.salaried_shift_presence_requests', 'INSERT'
  ), 'Authenticated clients cannot read or write replay receipts directly.';
  assert has_function_privilege(
    'authenticated',
    'public.get_salaried_shift_workspace(date,date,uuid)',
    'EXECUTE'
  ), 'Authenticated sessions can call the permission-gated workspace RPC.';
  assert has_function_privilege(
    'authenticated',
    'public.record_salaried_shift_outcome(uuid,text,uuid,text)',
    'EXECUTE'
  ), 'Authenticated sessions can call the permission-gated mutation RPC.';
end
$permission_contract$;

do $salaried_shift_fixture$
declare
  manager_employee constant uuid := 'fa110000-0000-4000-8000-000000000001';
  manager_auth constant uuid := 'fa120000-0000-4000-8000-000000000001';
  salary_employee constant uuid := 'fa110000-0000-4000-8000-000000000002';
  salary_auth constant uuid := 'fa120000-0000-4000-8000-000000000002';
  other_salary_employee constant uuid := 'fa110000-0000-4000-8000-000000000003';
  hourly_employee constant uuid := 'fa110000-0000-4000-8000-000000000004';
  unauthorized_employee constant uuid := 'fa110000-0000-4000-8000-000000000005';
  unauthorized_auth constant uuid := 'fa120000-0000-4000-8000-000000000005';
  hr_manager_employee constant uuid := 'fa110000-0000-4000-8000-000000000006';
  hr_manager_auth constant uuid := 'fa120000-0000-4000-8000-000000000006';
  normal_site constant uuid := 'fa130000-0000-4000-8000-000000000001';
  dispatch_site constant uuid := 'fa130000-0000-4000-8000-000000000002';
  normal_post constant uuid := 'fa140000-0000-4000-8000-000000000001';
  dispatch_post constant uuid := 'fa140000-0000-4000-8000-000000000002';
  revision_one constant uuid := 'fa150000-0000-4000-8000-000000000001';
  revision_two constant uuid := 'fa150000-0000-4000-8000-000000000002';
  copied_week_schedule constant uuid := 'fa150000-0000-4000-8000-000000000003';
  future_schedule constant uuid := 'fa150000-0000-4000-8000-000000000004';
  draft_only_schedule constant uuid := 'fa150000-0000-4000-8000-000000000005';
  fall_dst_schedule constant uuid := 'fa150000-0000-4000-8000-000000000006';
  archived_schedule constant uuid := 'fa150000-0000-4000-8000-000000000007';
  main_shift_one constant uuid := 'fa160000-0000-4000-8000-000000000001';
  hourly_shift constant uuid := 'fa160000-0000-4000-8000-000000000002';
  dispatch_duty_shift constant uuid := 'fa160000-0000-4000-8000-000000000003';
  dispatch_primary_shift constant uuid := 'fa160000-0000-4000-8000-000000000004';
  call_off_shift constant uuid := 'fa160000-0000-4000-8000-000000000005';
  time_off_shift constant uuid := 'fa160000-0000-4000-8000-000000000006';
  main_shift_two constant uuid := 'fa160000-0000-4000-8000-000000000007';
  copied_week_shift constant uuid := 'fa160000-0000-4000-8000-000000000008';
  future_shift constant uuid := 'fa160000-0000-4000-8000-000000000009';
  draft_only_shift constant uuid := 'fa160000-0000-4000-8000-00000000000a';
  changed_revision_shift constant uuid := 'fa160000-0000-4000-8000-00000000000b';
  coverage_shift constant uuid := 'fa160000-0000-4000-8000-00000000000c';
  fall_dst_shift constant uuid := 'fa160000-0000-4000-8000-00000000000d';
  archived_shift constant uuid := 'fa160000-0000-4000-8000-00000000000e';
  canceled_shift constant uuid := 'fa160000-0000-4000-8000-00000000000f';
  main_assignment_one constant uuid := 'fa170000-0000-4000-8000-000000000001';
  other_assignment_one constant uuid := 'fa170000-0000-4000-8000-000000000002';
  hourly_assignment constant uuid := 'fa170000-0000-4000-8000-000000000003';
  dispatch_duty_assignment constant uuid := 'fa170000-0000-4000-8000-000000000004';
  dispatch_primary_assignment constant uuid := 'fa170000-0000-4000-8000-000000000005';
  call_off_assignment constant uuid := 'fa170000-0000-4000-8000-000000000006';
  time_off_assignment constant uuid := 'fa170000-0000-4000-8000-000000000007';
  main_assignment_two constant uuid := 'fa170000-0000-4000-8000-000000000008';
  copied_week_assignment constant uuid := 'fa170000-0000-4000-8000-000000000009';
  future_assignment constant uuid := 'fa170000-0000-4000-8000-00000000000a';
  draft_only_assignment constant uuid := 'fa170000-0000-4000-8000-00000000000b';
  changed_revision_assignment constant uuid := 'fa170000-0000-4000-8000-00000000000c';
  coverage_assignment constant uuid := 'fa170000-0000-4000-8000-00000000000d';
  fall_dst_assignment constant uuid := 'fa170000-0000-4000-8000-00000000000e';
  archived_assignment constant uuid := 'fa170000-0000-4000-8000-00000000000f';
  canceled_assignment constant uuid := 'fa170000-0000-4000-8000-000000000010';
  call_off_id constant uuid := 'fa180000-0000-4000-8000-000000000001';
  coverage_case_id constant uuid := 'fa180000-0000-4000-8000-000000000002';
  time_off_id constant uuid := 'fa190000-0000-4000-8000-000000000001';
  request_one constant uuid := 'faa00000-0000-4000-8000-000000000001';
  request_two constant uuid := 'faa00000-0000-4000-8000-000000000002';
  request_three constant uuid := 'faa00000-0000-4000-8000-000000000003';
  request_four constant uuid := 'faa00000-0000-4000-8000-000000000004';
  request_five constant uuid := 'faa00000-0000-4000-8000-000000000005';
  request_six constant uuid := 'faa00000-0000-4000-8000-000000000006';
  request_seven constant uuid := 'faa00000-0000-4000-8000-000000000007';
  request_eight constant uuid := 'faa00000-0000-4000-8000-000000000008';
  workspace jsonb;
  result jsonb;
  admin_role_id uuid;
  hr_role_id uuid;
  before_time_event_count bigint;
  before_payroll_batch_count bigint;
  before_exception_count bigint;
  event_count integer;
  denied boolean;
  marker_id uuid;
  function_definition text;
begin
  insert into public.employees (
    id, employee_number, username, first_name, last_name, role,
    employment_type, status, time_zone
  ) values
    (manager_employee, 'SYG-9901', 'salaryshiftmanager', 'Salary', 'Manager', 'admin', 'salary', 'active', 'America/New_York'),
    (salary_employee, 'SYG-9902', 'salaryshifttarget', 'Salary', 'Employee', 'guard', 'salary', 'active', 'America/New_York'),
    (other_salary_employee, 'SYG-9903', 'salaryshiftother', 'Other', 'Salary', 'guard', 'salary', 'active', 'America/New_York'),
    (hourly_employee, 'SYG-9904', 'salaryshifthourly', 'Hourly', 'Employee', 'guard', 'hourly', 'active', 'America/New_York'),
    (unauthorized_employee, 'SYG-9905', 'salaryshiftunauth', 'Unauthorized', 'Employee', 'guard', 'hourly', 'active', 'America/New_York'),
    (hr_manager_employee, 'SYG-9906', 'salaryshifthrmanager', 'Human Resources', 'Manager', 'guard', 'salary', 'active', 'America/New_York');

  insert into auth.users(id, email)
  values
    (manager_auth, 'salary-shift-manager@example.invalid'),
    (salary_auth, 'salary-shift-target@example.invalid'),
    (unauthorized_auth, 'salary-shift-unauthorized@example.invalid'),
    (hr_manager_auth, 'salary-shift-hr-manager@example.invalid');

  insert into private.employee_accounts(employee_id, auth_user_id, activated_at)
  values
    (manager_employee, manager_auth, clock_timestamp()),
    (salary_employee, salary_auth, clock_timestamp()),
    (unauthorized_employee, unauthorized_auth, clock_timestamp()),
    (hr_manager_employee, hr_manager_auth, clock_timestamp());

  select access_role.id into admin_role_id
  from public.access_roles access_role
  where access_role.code = 'system_admin';
  assert admin_role_id is not null, 'The regression requires the protected Admin role.';
  select access_role.id into hr_role_id
  from public.access_roles access_role
  where access_role.code = 'human_resources';
  assert hr_role_id is not null, 'The regression requires the Human Resources Manager role.';

  insert into public.employee_access_roles(employee_id, role_id, assigned_by)
  values
    (manager_employee, admin_role_id, manager_employee),
    (hr_manager_employee, hr_role_id, manager_employee)
  on conflict (employee_id, role_id) do nothing;

  insert into public.sites(id, code, name, time_zone, supports_dispatch_phone_duty)
  values
    (normal_site, 'SSP-NORMAL', 'Salary Presence Site', 'America/New_York', false),
    (dispatch_site, 'SSP-DISPATCH', 'Dispatch Phone Coverage', 'America/New_York', true);

  insert into public.posts(id, site_id, name)
  values
    (normal_post, normal_site, 'Salary Presence Post'),
    (dispatch_post, dispatch_site, 'Dispatch Desk');

  insert into public.schedules(
    id, week_starts_on, revision, status, previous_revision_id, created_by
  ) values
    (revision_one, date '2020-03-02', 1, 'draft', null, manager_employee),
    (revision_two, date '2020-03-02', 2, 'draft', revision_one, manager_employee),
    (copied_week_schedule, date '2020-03-09', 1, 'draft', null, manager_employee),
    (future_schedule, date '2198-06-01', 1, 'draft', null, manager_employee),
    (draft_only_schedule, date '2020-04-06', 1, 'draft', null, manager_employee),
    (fall_dst_schedule, date '2020-10-26', 1, 'draft', null, manager_employee),
    (archived_schedule, date '2020-05-04', 1, 'draft', null, manager_employee);

  insert into public.shifts(
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, assignment_type, created_by
  ) values
    -- Spring DST advances during this overnight shift; it is still one scheduled shift.
    (main_shift_one, revision_one, normal_post, timestamptz '2020-03-08 06:00:00+00', timestamptz '2020-03-08 08:00:00+00', 'America/New_York', 2, 'standard', manager_employee),
    (hourly_shift, revision_one, normal_post, timestamptz '2020-03-03 14:00:00+00', timestamptz '2020-03-03 22:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (dispatch_duty_shift, revision_one, dispatch_post, timestamptz '2020-03-04 14:00:00+00', timestamptz '2020-03-04 22:00:00+00', 'America/New_York', 1, 'dispatch_phone_duty', manager_employee),
    (dispatch_primary_shift, revision_one, dispatch_post, timestamptz '2020-03-05 14:00:00+00', timestamptz '2020-03-05 22:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (call_off_shift, revision_one, normal_post, timestamptz '2020-03-06 14:00:00+00', timestamptz '2020-03-06 22:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (time_off_shift, revision_one, normal_post, timestamptz '2020-03-07 14:00:00+00', timestamptz '2020-03-07 22:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (main_shift_two, revision_two, normal_post, timestamptz '2020-03-08 06:00:00+00', timestamptz '2020-03-08 08:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (copied_week_shift, copied_week_schedule, normal_post, timestamptz '2020-03-15 05:00:00+00', timestamptz '2020-03-15 08:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (future_shift, future_schedule, normal_post, timestamptz '2198-06-02 13:00:00+00', timestamptz '2198-06-02 21:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (draft_only_shift, draft_only_schedule, normal_post, timestamptz '2020-04-07 13:00:00+00', timestamptz '2020-04-07 21:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (changed_revision_shift, revision_two, dispatch_post, timestamptz '2020-03-05 15:00:00+00', timestamptz '2020-03-05 23:00:00+00', 'America/New_York', 1, 'standard', manager_employee),
    -- Fall DST repeats the 1:00 AM hour; the absolute shift still counts once.
    (fall_dst_shift, fall_dst_schedule, normal_post, timestamptz '2020-11-01 05:30:00+00', timestamptz '2020-11-01 07:30:00+00', 'America/New_York', 1, 'standard', manager_employee),
    (archived_shift, archived_schedule, normal_post, timestamptz '2020-05-05 13:00:00+00', timestamptz '2020-05-05 21:00:00+00', 'America/New_York', 1, 'standard', manager_employee);

  insert into public.shifts(
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, assignment_type, coverage_source_shift_id, created_by
  ) values (
    coverage_shift, revision_one, normal_post,
    timestamptz '2020-03-06 14:00:00+00', timestamptz '2020-03-06 22:00:00+00',
    'America/New_York', 1, 'standard', call_off_shift, manager_employee
  );

  insert into public.shifts(
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, assignment_type, created_by
  ) values (
    canceled_shift, revision_one, normal_post,
    timestamptz '2020-03-02 14:00:00+00', timestamptz '2020-03-02 22:00:00+00',
    'America/New_York', 1, 'standard', manager_employee
  );

  insert into public.shift_assignments(
    id, shift_id, employee_id, status, assigned_by
  ) values
    (main_assignment_one, main_shift_one, salary_employee, 'assigned', manager_employee),
    (other_assignment_one, main_shift_one, other_salary_employee, 'assigned', manager_employee),
    (hourly_assignment, hourly_shift, hourly_employee, 'assigned', manager_employee),
    (dispatch_duty_assignment, dispatch_duty_shift, salary_employee, 'assigned', manager_employee),
    (dispatch_primary_assignment, dispatch_primary_shift, salary_employee, 'assigned', manager_employee),
    (call_off_assignment, call_off_shift, salary_employee, 'assigned', manager_employee),
    (time_off_assignment, time_off_shift, salary_employee, 'assigned', manager_employee),
    (main_assignment_two, main_shift_two, salary_employee, 'assigned', manager_employee),
    (copied_week_assignment, copied_week_shift, salary_employee, 'assigned', manager_employee),
    (future_assignment, future_shift, salary_employee, 'assigned', manager_employee),
    (draft_only_assignment, draft_only_shift, salary_employee, 'assigned', manager_employee),
    (changed_revision_assignment, changed_revision_shift, salary_employee, 'assigned', manager_employee),
    (coverage_assignment, coverage_shift, other_salary_employee, 'assigned', manager_employee),
    (fall_dst_assignment, fall_dst_shift, salary_employee, 'assigned', manager_employee),
    (archived_assignment, archived_shift, salary_employee, 'assigned', manager_employee),
    (canceled_assignment, canceled_shift, salary_employee, 'assigned', manager_employee);

  -- The assignment guard correctly rejects assigning an already-canceled shift,
  -- so build the historical fixture in the same order production does: assign,
  -- then cancel the occurrence while retaining its assignment for audit history.
  update public.shifts
  set canceled_at = clock_timestamp(),
      canceled_by = manager_employee,
      cancellation_reason = 'Rollback-only canceled occurrence fixture.'
  where id = canceled_shift;

  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = manager_employee
  where id in (
    revision_one,
    copied_week_schedule,
    future_schedule,
    fall_dst_schedule,
    archived_schedule
  );

  insert into public.call_off_reports(
    id, shift_id, employee_id, reported_by, reason, reported_at
  ) values (
    call_off_id, call_off_shift, salary_employee, manager_employee,
    'Rollback-only salaried shift absence fixture.', clock_timestamp()
  );

  insert into public.shift_coverage_cases (
    id, call_off_report_id, source_shift_id, source_assignment_id,
    coverage_shift_id, absent_employee_id, status, coverage_mode,
    replacement_employee_id, replacement_assignment_id,
    original_assignment_snapshot, last_idempotency_key, opened_by,
    resolved_by, resolved_at
  ) values (
    coverage_case_id, call_off_id, call_off_shift, call_off_assignment,
    coverage_shift, salary_employee, 'assigned', 'assigned_guard',
    other_salary_employee, coverage_assignment,
    jsonb_build_object('assignmentId', call_off_assignment),
    gen_random_uuid(), manager_employee, manager_employee, clock_timestamp()
  );

  insert into public.time_off_requests(
    id, employee_id, starts_on, ends_on, partial_day_start, partial_day_end,
    reason, status,
    employment_type_snapshot, pay_treatment, requested_minutes,
    submission_snapshot, affected_shifts_snapshot
  ) values (
    time_off_id, salary_employee, date '2020-03-07', date '2020-03-07',
    time '16:00', time '17:00',
    'Rollback-only approved leave fixture.', 'approved', 'salary',
    'salary_paid_leave', 60,
    jsonb_build_object('timeZone', 'America/New_York'), '[]'::jsonb
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', unauthorized_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', unauthorized_auth::text, true);
  denied := false;
  begin
    perform public.get_salaried_shift_workspace(date '2020-03-02', date '2020-03-15', null);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'An employee without the dedicated permission cannot read the workspace.';

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, active, created_by
  ) values (
    unauthorized_employee,
    'schedule.salary_shifts.manage',
    'grant',
    'Rollback-only proof that an explicit individual grant enables the manager workspace.',
    true,
    manager_employee
  );
  workspace := public.get_salaried_shift_workspace(date '2020-03-02', date '2020-03-15', null);
  assert coalesce((workspace #>> '{viewer,canManage}')::boolean, false)
    and workspace #>> '{viewer,employeeId}' = unauthorized_employee::text,
    'An MFA-verified employee with an explicit individual grant can manage salaried shift presence.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', manager_auth, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);
  denied := false;
  begin
    perform public.get_salaried_shift_workspace(date '2020-03-02', date '2020-03-15', null);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'The MFA-protected permission is not effective at AAL1.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', hr_manager_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', hr_manager_auth::text, true);
  workspace := public.get_salaried_shift_workspace(date '2020-03-02', date '2020-03-15', null);
  assert coalesce((workspace #>> '{viewer,canManage}')::boolean, false)
    and workspace #>> '{viewer,employeeId}' = hr_manager_employee::text,
    'Human Resources Manager can use the MFA-protected salaried shift workspace.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', manager_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  workspace := public.get_salaried_shift_workspace(date '2020-03-02', date '2020-03-15', null);
  assert workspace #>> '{viewer,employeeId}' = manager_employee::text
    and workspace #>> '{viewer,timeZone}' = 'America/New_York'
    and workspace #>> '{viewer,employmentType}' = 'salary'
    and coalesce((workspace #>> '{viewer,canManage}')::boolean, false),
    'Workspace viewer context is authoritative and manager-only.';
  assert exists (
    select 1
    from jsonb_array_elements(workspace -> 'assignments') item
    where (item ->> 'assignmentId')::uuid = main_assignment_one
      and item ->> 'workday' = '2020-03-08'
      and item ->> 'presenceStatus' = 'unconfirmed'
      and item ->> 'shiftTimeZone' = 'America/New_York'
      and item ->> 'employeeTimeZone' = 'America/New_York'
  ), 'The DST-crossing shift is one unconfirmed record on its scheduled-start workday.';
  assert exists (
    select 1
    from jsonb_array_elements(workspace -> 'assignments') item
    where (item ->> 'assignmentId')::uuid = dispatch_primary_assignment
      and item ->> 'assignmentType' = 'dispatch_primary'
  ), 'A primary Dispatch assignment remains eligible and is labeled for presentation.';
  assert exists (
    select 1
    from jsonb_array_elements(workspace -> 'assignments') item
    where (item ->> 'assignmentId')::uuid = coverage_assignment
      and (item #>> '{employee,id}')::uuid = other_salary_employee
  ), 'The salaried replacement assignment remains eligible while the absent employee is blocked.';
  assert not exists (
    select 1
    from jsonb_array_elements(workspace -> 'assignments') item
    where (item ->> 'assignmentId')::uuid in (
      hourly_assignment,
      dispatch_duty_assignment,
      call_off_assignment,
      time_off_assignment,
      canceled_assignment
    )
  ), 'Hourly, supplemental Dispatch, call-off, approved-leave, and canceled rows are excluded.';
  assert position('workedMinutes' in workspace::text) = 0
    and position('actual' in lower(workspace::text)) = 0
    and position('overtime' in lower(workspace::text)) = 0
    and position('payroll' in lower(workspace::text)) = 0,
    'The presence payload exposes no timekeeping, duration, overtime, or payroll facts.';
  assert not exists (
    select 1
    from jsonb_array_elements(workspace -> 'assignments') item
    where jsonb_typeof(item -> 'canMarkWorked') <> 'boolean'
      or jsonb_typeof(item -> 'canVoid') <> 'boolean'
  ), 'Every assignment exposes concrete boolean action flags, including rows without prior events.';

  workspace := public.get_salaried_shift_workspace(date '2020-11-01', date '2020-11-01', salary_employee);
  assert jsonb_array_length(workspace -> 'assignments') = 1
    and (workspace #>> '{assignments,0,assignmentId}')::uuid = fall_dst_assignment
    and workspace #>> '{assignments,0,workday}' = '2020-11-01',
    'A fall-back DST shift appears exactly once on its scheduled-start workday.';

  workspace := public.get_salaried_shift_workspace(date '2198-06-02', date '2198-06-02', salary_employee);
  assert jsonb_array_length(workspace -> 'assignments') = 1
    and workspace #>> '{assignments,0,blockingReason}' = 'shift_not_ended'
    and not (workspace #>> '{assignments,0,canMarkWorked}')::boolean
    and (workspace #>> '{summary,total}')::integer = 0
    and (workspace #>> '{summary,unconfirmed}')::integer = 0,
    'A custom future range shows scheduled work without inflating due/unconfirmed totals.';

  select count(*) into before_time_event_count from public.time_events;
  select count(*) into before_payroll_batch_count from private.payroll_export_batches;
  select count(*) into before_exception_count from public.timekeeping_operational_exceptions;

  result := public.record_salaried_shift_outcome(
    main_assignment_one, 'worked', request_one, null
  );
  assert result ->> 'action' = 'recorded'
    and result ->> 'presenceStatus' = 'worked'
    and (result ->> 'assignmentId')::uuid = main_assignment_one,
    'The manager can record one affirmative Worked marker.';

  result := public.record_salaried_shift_outcome(
    main_assignment_one, 'worked', request_one, null
  );
  assert result ->> 'action' = 'unchanged',
    'An exact request replay is idempotent.';
  select count(*) into event_count
  from private.salaried_shift_presence_events event
  where event.employee_id = salary_employee;
  assert event_count = 1, 'An exact retry does not append another marker event.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      main_assignment_one, 'worked', request_one, 'Changed replay note'
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'A request identifier cannot be reused with a different normalized note.';

  result := public.record_salaried_shift_outcome(
    main_assignment_one, 'worked', request_two, null
  );
  assert result ->> 'action' = 'unchanged',
    'A second Worked request does not append a duplicate active marker.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      main_assignment_one, 'unconfirmed', request_three, 'short'
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'Removing a Worked marker requires an adequate audit reason.';

  result := public.record_salaried_shift_outcome(
    main_assignment_one, 'unconfirmed', request_three,
    'Correcting an incorrectly recorded Worked marker.'
  );
  assert result ->> 'action' = 'voided'
    and result ->> 'presenceStatus' = 'unconfirmed',
    'Removing a Worked marker appends a void rather than deleting history.';

  result := public.record_salaried_shift_outcome(
    main_assignment_one, 'worked', request_two, null
  );
  assert result ->> 'action' = 'unchanged'
    and result ->> 'presenceStatus' = 'unconfirmed',
    'A delayed retry of an earlier no-op cannot restore a marker after state changes.';
  select count(*) into event_count
  from private.salaried_shift_presence_events event
  where event.employee_id = salary_employee;
  assert event_count = 2,
    'A delayed no-op retry appends no marker event.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      main_assignment_one, 'worked', request_four, null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'Restoring a voided marker requires a correction note.';

  result := public.record_salaried_shift_outcome(
    main_assignment_one, 'worked', request_four,
    'Manager verified the employee did work this scheduled shift.'
  );
  assert result ->> 'action' = 'corrected'
    and result ->> 'presenceStatus' = 'worked',
    'A documented correction restores the affirmative marker.';

  workspace := public.get_salaried_shift_workspace(date '2020-03-08', date '2020-03-08', salary_employee);
  assert jsonb_array_length(workspace #> '{assignments,0,history}') = 3
    and workspace #>> '{assignments,0,history,0,action}' = 'worked'
    and workspace #>> '{assignments,0,history,1,action}' = 'voided'
    and workspace #>> '{assignments,0,history,2,action}' = 'worked',
    'The complete action history is returned in stable chronological order.';

  workspace := public.get_salaried_shift_workspace(date '2020-03-08', date '2020-03-08', null);
  assert exists (
    select 1
    from jsonb_array_elements(workspace -> 'assignments') item
    where (item ->> 'assignmentId')::uuid = other_assignment_one
      and item ->> 'presenceStatus' = 'unconfirmed'
      and jsonb_array_length(item -> 'history') = 0
  ), 'A marker never leaks to another employee on the same shift.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      hourly_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'An hourly assignment cannot receive a salaried Worked marker.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      dispatch_duty_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'Supplemental Dispatch phone duty cannot receive a Worked marker.';

  result := public.record_salaried_shift_outcome(
    dispatch_primary_assignment, 'worked', request_five, null
  );
  assert result ->> 'action' = 'recorded',
    'A primary scheduled Dispatch shift remains eligible.';

  result := public.record_salaried_shift_outcome(
    coverage_assignment, 'worked', request_seven, null
  );
  assert result ->> 'action' = 'recorded'
    and result ->> 'presenceStatus' = 'worked',
    'A salaried replacement can be marked Worked without marking the absent employee.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      call_off_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'A call-off occurrence cannot be marked Worked.';

  update public.employees
  set time_zone = 'America/Los_Angeles'
  where id = salary_employee;
  assert private.salaried_shift_assignment_has_approved_time_off(time_off_assignment),
    'Approved leave remains anchored to its submission time zone after a profile-zone change.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      time_off_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'Approved overlapping leave prevents a Worked marker.';

  update public.employees
  set time_zone = 'America/New_York'
  where id = salary_employee;

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      future_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'A shift cannot be marked Worked before its scheduled end.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      draft_only_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'A draft-only assignment cannot be marked Worked.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      canceled_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'A canceled scheduled occurrence cannot be marked Worked.';

  result := public.record_salaried_shift_outcome(
    archived_assignment, 'worked', request_eight, null
  );
  assert result ->> 'action' = 'recorded',
    'A completed assignment can be marked while its schedule is the published revision.';

  update public.schedules
  set status = 'superseded'
  where id = archived_schedule;
  update public.schedules
  set status = 'archived'
  where id = archived_schedule;

  workspace := public.get_salaried_shift_workspace(date '2020-05-05', date '2020-05-05', salary_employee);
  assert jsonb_array_length(workspace -> 'assignments') = 0
    and exists (
      select 1
      from private.salaried_shift_presence_events event
      where event.request_id = request_eight
        and event.action = 'worked'
    ), 'Archiving a schedule hides the occurrence without deleting its audit history.';

  result := public.record_salaried_shift_outcome(
    archived_assignment, 'worked', request_eight, null
  );
  assert result ->> 'action' = 'unchanged'
    and result ->> 'presenceStatus' = 'worked',
    'An exact replay remains safe after the source schedule is archived.';

  denied := false;
  begin
    perform public.record_salaried_shift_outcome(
      archived_assignment, 'worked', gen_random_uuid(), null
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'An archived occurrence rejects a new marker request.';

  result := public.record_salaried_shift_outcome(
    main_assignment_two, 'worked', request_six,
    'Equivalent draft request resolves to the already published occurrence.'
  );
  assert result ->> 'action' = 'unchanged'
    and (result ->> 'assignmentId')::uuid = main_assignment_one,
    'A draft UI row may resolve only to its exact currently published equivalent.';

  update public.schedules
  set status = 'superseded'
  where id = revision_one;
  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = manager_employee
  where id = revision_two;

  workspace := public.get_salaried_shift_workspace(date '2020-03-08', date '2020-03-08', salary_employee);
  assert jsonb_array_length(workspace -> 'assignments') = 1
    and (workspace #>> '{assignments,0,assignmentId}')::uuid = main_assignment_two
    and workspace #>> '{assignments,0,presenceStatus}' = 'worked'
    and jsonb_array_length(workspace #> '{assignments,0,history}') = 3,
    'The current published revision inherits exact occurrence history without copying rows.';

  workspace := public.get_salaried_shift_workspace(date '2020-03-15', date '2020-03-15', salary_employee);
  assert jsonb_array_length(workspace -> 'assignments') = 1
    and (workspace #>> '{assignments,0,assignmentId}')::uuid = copied_week_assignment
    and workspace #>> '{assignments,0,presenceStatus}' = 'unconfirmed'
    and jsonb_array_length(workspace #> '{assignments,0,history}') = 0,
    'A copied week starts unconfirmed and never inherits the source marker.';

  workspace := public.get_salaried_shift_workspace(date '2020-03-05', date '2020-03-05', salary_employee);
  assert jsonb_array_length(workspace -> 'assignments') = 1
    and (workspace #>> '{assignments,0,assignmentId}')::uuid = changed_revision_assignment
    and workspace #>> '{assignments,0,presenceStatus}' = 'unconfirmed'
    and jsonb_array_length(workspace #> '{assignments,0,history}') = 0,
    'A changed start/end in a later revision is a new occurrence and inherits no marker.';

  select event.id into marker_id
  from private.salaried_shift_presence_events event
  where event.request_id = request_one;
  denied := false;
  begin
    update private.salaried_shift_presence_events
    set note = 'Attempted history rewrite.'
    where id = marker_id;
  exception when others then
    denied := true;
  end;
  assert denied, 'Presence history is append-only even for privileged SQL.';

  denied := false;
  begin
    update private.salaried_shift_presence_requests
    set normalized_note = 'Attempted request receipt rewrite.'
    where request_id = request_one;
  exception when others then
    denied := true;
  end;
  assert denied, 'Accepted request receipts are append-only.';

  assert (select count(*) from public.time_events) = before_time_event_count,
    'Salaried shift presence creates no time events.';
  assert (select count(*) from private.payroll_export_batches) = before_payroll_batch_count,
    'Salaried shift presence creates no payroll export rows.';
  assert (select count(*) from public.timekeeping_operational_exceptions) = before_exception_count,
    'Salaried shift presence creates no missing-clock or timekeeping exceptions.';
  assert exists (
    select 1
    from public.shift_assignments assignment
    where assignment.id = main_assignment_one and assignment.status = 'assigned'
  ) and exists (
    select 1
    from public.shift_assignments assignment
    where assignment.id = main_assignment_two and assignment.status = 'assigned'
  ), 'Recording Worked never mutates the shift assignment status.';

  select pg_get_functiondef(
    'private.salaried_shift_assignment_has_approved_time_off(uuid)'::regprocedure
  ) into function_definition;
  assert position('request.submission_snapshot ->> ''timeZone''' in function_definition) > 0,
    'Approved-leave checks use the immutable request submission time zone.';

  select pg_get_functiondef(
    'public.record_salaried_shift_outcome(uuid,text,uuid,text)'::regprocedure
  ) into function_definition;
  assert position(
    'pg_advisory_xact_lock(hashtext(''schedule-draft:'' || target_record.week_starts_on::text))'
    in function_definition
  ) > 0 and position(
    'pg_advisory_xact_lock(hashtext(''schedule-draft:'' || target_record.week_starts_on::text))'
    in function_definition
  ) < position(
    'private.lock_employee_schedule_time_off(target_record.employee_id)'
    in function_definition
  ), 'Presence mutations take the schedule-week lock before the employee lock.';

  select pg_get_functiondef('public.ensure_schedule_draft(date)'::regprocedure)
  into function_definition;
  assert position('pg_advisory_xact_lock(hashtext(''schedule-draft:''' in function_definition) > 0
    and position('pg_advisory_xact_lock(hashtext(''schedule-draft:''' in function_definition)
      < position('private.copy_schedule_shift_block' in function_definition),
    'Draft creation takes the schedule-week lock before copied assignment inserts acquire employee locks.';

  select pg_get_functiondef('private.enforce_assignment_capacity_and_overlap()'::regprocedure)
  into function_definition;
  assert position('private.lock_employee_schedule_time_off(new.employee_id)' in function_definition) > 0,
    'Assignment inserts retain the shared employee lock after the schedule-week lock.';

  insert into public.employee_permission_overrides (
    employee_id, permission_code, effect, reason, active, created_by
  ) values (
    manager_employee,
    'schedule.salary_shifts.manage',
    'deny',
    'Rollback-only proof that a direct employee denial remains authoritative.',
    true,
    manager_employee
  );
  denied := false;
  begin
    perform public.get_salaried_shift_workspace(date '2020-03-08', date '2020-03-08', null);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'A direct employee permission denial wins over the Admin role grant.';
end
$salaried_shift_fixture$;

rollback;

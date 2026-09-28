begin;

do $request_center_fixture$
declare
  scheduler_employee constant uuid := 'f9110000-0000-4000-8000-000000000001';
  scheduler_auth constant uuid := 'f9120000-0000-4000-8000-000000000001';
  additive_employee constant uuid := 'f9110000-0000-4000-8000-000000000002';
  additive_auth constant uuid := 'f9120000-0000-4000-8000-000000000002';
  employee_id constant uuid := 'f9110000-0000-4000-8000-000000000003';
  employee_auth constant uuid := 'f9120000-0000-4000-8000-000000000003';
  manager_role_id constant uuid := 'f9130000-0000-4000-8000-000000000001';
  site_id constant uuid := 'f9140000-0000-4000-8000-000000000001';
  post_id constant uuid := 'f9150000-0000-4000-8000-000000000001';
  future_schedule_id constant uuid := 'f9160000-0000-4000-8000-000000000001';
  past_schedule_id constant uuid := 'f9160000-0000-4000-8000-000000000002';
  future_shift_id constant uuid := 'f9170000-0000-4000-8000-000000000001';
  decided_shift_id constant uuid := 'f9170000-0000-4000-8000-000000000002';
  resolved_call_off_shift_id constant uuid := 'f9170000-0000-4000-8000-000000000003';
  past_shift_id constant uuid := 'f9170000-0000-4000-8000-000000000004';
  pending_time_off_id constant uuid := 'f9180000-0000-4000-8000-000000000001';
  decided_time_off_id constant uuid := 'f9180000-0000-4000-8000-000000000002';
  scheduler_history_id constant uuid := 'f9180000-0000-4000-8000-000000000003';
  pending_shift_request_id constant uuid := 'f9190000-0000-4000-8000-000000000001';
  decided_shift_request_id constant uuid := 'f9190000-0000-4000-8000-000000000002';
  past_shift_request_id constant uuid := 'f9190000-0000-4000-8000-000000000003';
  open_call_off_id constant uuid := 'f91a0000-0000-4000-8000-000000000001';
  resolved_call_off_id constant uuid := 'f91a0000-0000-4000-8000-000000000002';
  past_call_off_id constant uuid := 'f91a0000-0000-4000-8000-000000000003';
  payload jsonb;
begin
  insert into public.employees (
    id, employee_number, username, first_name, last_name, role,
    employment_type, status, time_zone
  ) values
    (scheduler_employee, 'SYG-9801', 'torcscheduler', 'Request', 'Scheduler', 'scheduler', 'salary', 'active', 'America/New_York'),
    (additive_employee, 'SYG-9802', 'torcadditive', 'Additive', 'Manager', 'guard', 'hourly', 'active', 'America/Chicago'),
    (employee_id, 'SYG-9803', 'torcemployee', 'Request', 'Employee', 'guard', 'hourly', 'active', 'America/New_York');

  insert into auth.users(id, email)
  values
    (scheduler_auth, 'time-off-request-center-scheduler@example.invalid'),
    (additive_auth, 'time-off-request-center-additive@example.invalid'),
    (employee_auth, 'time-off-request-center-employee@example.invalid');

  insert into private.employee_accounts(employee_id, auth_user_id, activated_at)
  values
    (scheduler_employee, scheduler_auth, clock_timestamp()),
    (additive_employee, additive_auth, clock_timestamp()),
    (employee_id, employee_auth, clock_timestamp());

  insert into public.access_roles (
    id, code, name, description, system_role, protected, mfa_required, active
  ) values (
    manager_role_id,
    'time_off_regression_manager',
    'Time-off Regression Manager',
    'Rollback-only additive request-manager role.',
    false,
    false,
    true,
    true
  );
  insert into public.access_role_permissions(role_id, permission_code, enabled)
  values(manager_role_id, 'requests.manage', true);
  insert into public.employee_access_roles(employee_id, role_id, assigned_by)
  values(additive_employee, manager_role_id, scheduler_employee);

  insert into public.sites(id, code, name, time_zone)
  values(site_id, 'TO-RC', 'Time-off Request Center Site', 'America/New_York');
  insert into public.posts(id, site_id, name)
  values(post_id, site_id, 'Time-off Request Center Post');
  insert into public.schedules(id, week_starts_on, revision, status, created_by)
  values
    (future_schedule_id, date '2198-05-31', 1, 'draft', scheduler_employee),
    (past_schedule_id, date '2020-05-31', 1, 'draft', scheduler_employee);
  insert into public.shifts(
    id, schedule_id, post_id, starts_at, ends_at, time_zone, headcount_required, created_by
  ) values
    (future_shift_id, future_schedule_id, post_id, timestamptz '2198-06-01 13:00:00+00', timestamptz '2198-06-01 21:00:00+00', 'America/New_York', 1, scheduler_employee),
    (decided_shift_id, future_schedule_id, post_id, timestamptz '2198-06-02 13:00:00+00', timestamptz '2198-06-02 21:00:00+00', 'America/New_York', 1, scheduler_employee),
    (resolved_call_off_shift_id, future_schedule_id, post_id, timestamptz '2198-06-03 13:00:00+00', timestamptz '2198-06-03 21:00:00+00', 'America/New_York', 1, scheduler_employee),
    (past_shift_id, past_schedule_id, post_id, timestamptz '2020-06-01 13:00:00+00', timestamptz '2020-06-01 21:00:00+00', 'America/New_York', 1, scheduler_employee);
  insert into public.shift_assignments(shift_id, employee_id, status, assigned_by)
  values
    (future_shift_id, employee_id, 'assigned', scheduler_employee),
    (decided_shift_id, employee_id, 'assigned', scheduler_employee),
    (resolved_call_off_shift_id, employee_id, 'assigned', scheduler_employee),
    (past_shift_id, employee_id, 'assigned', scheduler_employee);

  insert into public.time_off_requests (
    id, employee_id, starts_on, ends_on, partial_day_start, partial_day_end,
    return_on, reason, status, request_type, employment_type_snapshot,
    pay_treatment, requested_minutes, submission_snapshot,
    affected_shifts_snapshot, created_at, updated_at
  ) values
    (
      pending_time_off_id, employee_id, date '2198-07-01', date '2198-07-01',
      time '09:00', time '12:00', date '2198-07-02', 'Pending request center fixture.',
      'pending', 'unpaid_time_off', 'hourly', 'unpaid', 180,
      jsonb_build_object('timeZone', 'America/New_York'), '[]'::jsonb,
      clock_timestamp() - interval '2 days', clock_timestamp() - interval '2 days'
    ),
    (
      decided_time_off_id, employee_id, date '2198-07-10', date '2198-07-10',
      null, null, date '2198-07-11', 'Decided history fixture.',
      'declined', 'sick_time', 'hourly', 'sick_policy', 0,
      jsonb_build_object('timeZone', 'America/New_York'), '[]'::jsonb,
      clock_timestamp() - interval '4 days', clock_timestamp() - interval '1 day'
    ),
    (
      scheduler_history_id, scheduler_employee, date '2198-08-01', date '2198-08-01',
      null, null, date '2198-08-02', 'Manager self-history fixture.',
      'withdrawn', 'paid_vacation', 'salary', 'salary_paid_leave', 0,
      jsonb_build_object('timeZone', 'America/New_York'), '[]'::jsonb,
      clock_timestamp() - interval '5 days', clock_timestamp() - interval '3 days'
    );

  update public.time_off_requests
  set
    decided_by = scheduler_employee,
    decided_at = clock_timestamp() - interval '1 day',
    decision_note = 'Declined with a valid regression note.'
  where id = decided_time_off_id;

  insert into public.shift_requests(id, shift_id, employee_id, status, employee_note)
  values
    (pending_shift_request_id, future_shift_id, employee_id, 'pending', 'Pending future request.'),
    (decided_shift_request_id, decided_shift_id, employee_id, 'approved', 'Decided future request.'),
    (past_shift_request_id, past_shift_id, employee_id, 'pending', 'Expired pending request.');

  insert into public.call_off_reports(
    id, shift_id, employee_id, reported_by, reason, reported_at, resolved_at
  ) values
    (open_call_off_id, future_shift_id, employee_id, employee_id, 'Open future call-off.', clock_timestamp(), null),
    (resolved_call_off_id, resolved_call_off_shift_id, employee_id, employee_id, 'Resolved future call-off.', clock_timestamp(), clock_timestamp()),
    (past_call_off_id, past_shift_id, employee_id, employee_id, 'Past open call-off.', timestamptz '2020-06-01 10:00:00+00', null);

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  payload := public.get_request_center_payload();

  assert coalesce((payload #>> '{permissions,canManage}')::boolean, false),
    'AAL2 Scheduler receives request management capability.';
  assert payload ->> 'employeeTimeZone' = 'America/New_York',
    'Request Center exposes the viewer profile time zone.';
  assert payload #>> '{timeOffHistory,managerHistoryLimit}' = '100',
    'Manager time-off history is explicitly bounded.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'timeOff') item
    where (item ->> 'id')::uuid = pending_time_off_id
      and item ->> 'requestType' = 'unpaid_time_off'
      and item ->> 'employmentType' = 'hourly'
      and item ->> 'payTreatment' = 'unpaid'
      and (item ->> 'requestedMinutes')::integer = 180
      and item ->> 'returnOn' = '2198-07-02'
      and jsonb_typeof(item -> 'affectedShifts') = 'array'
  ), 'Scheduler sees enriched pending time-off rows.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'timeOff') item
    where (item ->> 'id')::uuid = decided_time_off_id
      and item ->> 'status' = 'declined'
      and item ->> 'decidedByName' = 'Request Scheduler'
  ), 'Scheduler sees bounded decided time-off history.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'timeOff') item
    where (item ->> 'id')::uuid = scheduler_history_id
  ), 'A manager retains complete self-history.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'shiftRequests') item
    where (item ->> 'id')::uuid = pending_shift_request_id
  ) and not exists (
    select 1 from jsonb_array_elements(payload -> 'shiftRequests') item
    where (item ->> 'id')::uuid in (decided_shift_request_id, past_shift_request_id)
  ), 'Manager shift queue contains only pending future work.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'callOffs') item
    where (item ->> 'id')::uuid = open_call_off_id
  ) and not exists (
    select 1 from jsonb_array_elements(payload -> 'callOffs') item
    where (item ->> 'id')::uuid in (resolved_call_off_id, past_call_off_id)
  ), 'Manager call-off queue contains only unresolved future absences.';
  assert jsonb_array_length(payload -> 'upcomingAssignments') = 0,
    'Manager payload does not include an employee assignment list.';

  perform set_config('request.jwt.claim.sub', additive_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', additive_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  payload := public.get_request_center_payload();
  assert coalesce((payload #>> '{permissions,canManage}')::boolean, false),
    'An additive requests.manage grant controls canManage.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'timeOff') item
    where (item ->> 'id')::uuid = pending_time_off_id
  ), 'The same additive permission controls manager row visibility.';

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  payload := public.get_request_center_payload();
  assert not coalesce((payload #>> '{permissions,canManage}')::boolean, false),
    'Unauthorized employee does not receive request management capability.';
  assert payload ->> 'employeeTimeZone' = 'America/New_York',
    'Employee Request Center uses the employee profile time zone.';
  assert not exists (
    select 1 from jsonb_array_elements(payload -> 'timeOff') item
    where (item ->> 'employeeId')::uuid <> employee_id
  ), 'Unauthorized employee cannot see another employee time-off row.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'timeOff') item
    where (item ->> 'id')::uuid in (pending_time_off_id, decided_time_off_id)
  ), 'Employee retains their own pending and decided time-off history.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'shiftRequests') item
    where (item ->> 'id')::uuid = decided_shift_request_id
  ), 'Employee retains their own future shift-request history.';
  assert exists (
    select 1 from jsonb_array_elements(payload -> 'upcomingAssignments') item
    where (item #>> '{shift,id}')::uuid = future_shift_id
  ), 'Employee receives their future assigned shifts.';

  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = pending_time_off_id
      and notification.recipient_employee_id in (scheduler_employee, additive_employee)
      and notification.action_required
      and notification.resolved_at is null
      and notification.action_path = concat('/time-off?tab=time-off&request=', pending_time_off_id)
  ), 'Pending time-off actions deep-link to the canonical request.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'shift_request'
      and notification.source_id = pending_shift_request_id
      and notification.action_path = concat('/time-off?tab=shift-requests&request=', pending_shift_request_id)
  ), 'Pending shift actions deep-link to the canonical request.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = open_call_off_id
      and notification.action_path = concat('/time-off?tab=call-offs&callOff=', open_call_off_id)
  ), 'Open call-off actions deep-link to the canonical absence.';
end
$request_center_fixture$;

do $rpc_only_contract$
begin
  assert not has_table_privilege('authenticated', 'public.time_off_requests', 'INSERT'),
    'Authenticated clients cannot insert time-off rows directly.';
  assert not has_table_privilege('authenticated', 'public.time_off_requests', 'UPDATE'),
    'Authenticated clients cannot update time-off rows directly.';
  assert not has_any_column_privilege('authenticated', 'public.time_off_requests', 'INSERT'),
    'Authenticated clients have no column-level insert bypass.';
  assert not has_any_column_privilege('authenticated', 'public.time_off_requests', 'UPDATE'),
    'Authenticated clients have no column-level update bypass.';
  assert has_table_privilege('authenticated', 'public.time_off_requests', 'SELECT'),
    'Authenticated SELECT remains governed by existing RLS.';
end
$rpc_only_contract$;

set local role authenticated;
do $direct_dml_denials$
begin
  begin
    insert into public.time_off_requests(employee_id, starts_on, ends_on, status)
    values(
      'f9110000-0000-4000-8000-000000000003',
      date '2198-09-01',
      date '2198-09-01',
      'pending'
    );
    raise exception 'Authenticated direct time-off INSERT unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.time_off_requests
    set status = 'approved', decision_note = 'Forged direct decision.'
    where id = 'f9180000-0000-4000-8000-000000000001';
    raise exception 'Authenticated direct time-off UPDATE unexpectedly succeeded.';
  exception
    when insufficient_privilege then null;
  end;
end
$direct_dml_denials$;
reset role;

rollback;

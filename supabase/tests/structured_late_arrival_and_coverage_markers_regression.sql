begin;

set local statement_timeout = '30s';

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  target_employee_id uuid;
  target_shift_id uuid;
  target_week date;
  event_id uuid;
  alert_id uuid;
  expected_arrival timestamptz;
  result jsonb;
  workspace jsonb;
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and 'accountability.create' = any(private.employee_effective_permissions(employee.id))
    and 'accountability.view' = any(private.employee_effective_permissions(employee.id))
  order by (employee.role = 'admin') desc, employee.id
  limit 1;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  select assignment.employee_id, shift.id, schedule.week_starts_on
  into target_employee_id, target_shift_id, target_week
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  join public.shift_assignments assignment on assignment.shift_id = shift.id and assignment.status in ('assigned', 'confirmed')
  where shift.canceled_at is null
    and shift.ends_at > clock_timestamp() + interval '1 hour'
    and not exists (
      select 1 from public.attendance_accountability_events event
      where event.employee_id = assignment.employee_id
        and event.shift_id = shift.id
        and event.event_type = 'late_arrival'
        and event.status <> 'voided'
    )
  order by shift.starts_at
  limit 1;

  assert actor_auth_user_id is not null and actor_employee_id is not null,
    'The regression requires an active Accountability manager.';
  assert target_shift_id is not null,
    'The regression requires a future assigned shift.';

  result := public.create_attendance_accountability_event_v2(
    target_employee_id, target_shift_id, 'late_arrival', null,
    'Rollback-only structured late-arrival regression.', 45
  );
  event_id := (result ->> 'id')::uuid;

  select event.operational_alert_id, event.expected_arrival_at
  into alert_id, expected_arrival
  from public.attendance_accountability_events event
  where event.id = event_id;

  assert expected_arrival is not null and alert_id is not null,
    'The structured delay or live operations alert was not created.';
  assert exists (
    select 1 from public.operational_alerts alert
    where alert.id = alert_id and alert.active and alert.alert_type = 'reported_late_arrival'
  ), 'The reported late arrival is not active on the operations board.';

  workspace := public.get_accountability_workspace_v2(target_week, target_week + 6);
  assert exists (
    select 1 from jsonb_array_elements(workspace -> 'events') item
    where (item ->> 'id')::uuid = event_id
      and (item ->> 'reportedLateMinutes')::integer = 45
      and item ->> 'expectedArrivalAt' is not null
  ), 'Accountability did not return the structured late-arrival details.';

  insert into public.time_events(
    employee_id, shift_id, kind, recorded_at, source, idempotency_key, created_by
  ) values (
    target_employee_id, target_shift_id, 'clock_in', expected_arrival,
    'supervisor', 'rollback-late-arrival-' || gen_random_uuid()::text, actor_employee_id
  );

  assert exists (
    select 1 from public.attendance_accountability_events event
    where event.id = event_id and event.actual_arrival_at = expected_arrival
  ), 'The actual clock-in did not close the reported late arrival.';
  assert exists (
    select 1 from public.operational_alerts alert
    where alert.id = alert_id and not alert.active and alert.lifecycle_state = 'resolved'
  ), 'The operations alert remained active after clock-in.';
end
$$;

do $$
declare
  actor_auth_user_id uuid;
  target_employee_id uuid;
  target_shift_id uuid;
  target_week date;
  call_off_id uuid;
  coverage_shift_id uuid;
  result jsonb;
  clock_in_blocked boolean := false;
begin
  select account.auth_user_id
  into actor_auth_user_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and 'accountability.create' = any(private.employee_effective_permissions(employee.id))
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['requests.manage', 'shift_pool.manage', 'announcements.send', 'schedule.manage']::text[]
  order by (employee.role = 'admin') desc, employee.id
  limit 1;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  select assignment.employee_id, shift.id, schedule.week_starts_on
  into target_employee_id, target_shift_id, target_week
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  join public.shift_assignments assignment on assignment.shift_id = shift.id and assignment.status in ('assigned', 'confirmed')
  where shift.canceled_at is null
    and shift.ends_at > clock_timestamp() + interval '1 hour'
    and not exists (
      select 1 from public.call_off_reports report
      where report.shift_id = shift.id and report.employee_id = assignment.employee_id
    )
  order by shift.starts_at
  limit 1;

  result := public.create_attendance_accountability_event_v2(
    target_employee_id, target_shift_id, 'call_off', null,
    'Rollback-only coverage marker regression.', null
  );
  call_off_id := (result ->> 'callOffId')::uuid;
  result := public.resolve_call_off_coverage(
    call_off_id, 'open_pool', null, 'Rollback-only coverage opening',
    'Rollback-only test of visible call-off and coverage markers.',
    'Rollback-only test preserves the original schedule record.', false, gen_random_uuid()
  );
  coverage_shift_id := (result ->> 'coverageShiftId')::uuid;

  assert exists (
    select 1 from public.get_shift_coverage_status_map(target_week) item
    where item."marker" = 'call_off' and item."absentEmployeeId" = target_employee_id
  ), 'The original schedule block is missing its CALL OFF marker.';
  assert exists (
    select 1 from public.get_shift_coverage_status_map(target_week) item
    where item."shiftId" = coverage_shift_id and item."marker" = 'coverage'
  ), 'The replacement schedule block is missing its COVERAGE marker.';

  begin
    insert into public.time_events(employee_id, shift_id, kind, recorded_at, source, idempotency_key)
    values (target_employee_id, target_shift_id, 'clock_in', clock_timestamp(), 'web', 'rollback-called-off-' || gen_random_uuid()::text);
  exception when check_violation then
    clock_in_blocked := true;
  end;
  assert clock_in_blocked,
    'The called-off employee could still clock into the original occurrence.';
end
$$;

rollback;

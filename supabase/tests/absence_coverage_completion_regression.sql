begin;

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  target_shift_id uuid;
  target_employee_id uuid;
  target_operational_date date;
  original_assignment_id uuid;
  occurrence_result jsonb;
  coverage_result jsonb;
  request_payload jsonb;
  operations_payload jsonb;
  call_off_id uuid;
  occurrence_id uuid;
  coverage_shift_id uuid;
  idempotency_key uuid := gen_random_uuid();
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and employee.role in ('admin', 'supervisor', 'scheduler', 'dispatcher')
    and account.auth_user_id is not null
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and 'accountability.create' = any(private.employee_effective_permissions(employee.id))
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['requests.manage', 'shift_pool.manage', 'announcements.send', 'schedule.manage']::text[]
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise exception 'A linked active manager account is required for the rollback-only absence test.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', actor_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  select shift.id, assignment.employee_id, assignment.id,
         (shift.starts_at at time zone shift.time_zone)::date
  into target_shift_id, target_employee_id, original_assignment_id, target_operational_date
  from public.shifts shift
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  join public.shift_assignments assignment
    on assignment.shift_id = shift.id
   and assignment.status in ('assigned', 'confirmed')
  join public.employees employee
    on employee.id = assignment.employee_id
   and employee.status = 'active'
  where shift.canceled_at is null
    and shift.ends_at > clock_timestamp() + interval '1 hour'
    and not exists (
      select 1
      from public.call_off_reports report
      where report.shift_id = shift.id
        and report.employee_id = assignment.employee_id
    )
    and not exists (
      select 1
      from public.attendance_accountability_events event
      where event.shift_id = shift.id
        and event.employee_id = assignment.employee_id
        and event.event_type = 'call_off'
        and event.status <> 'voided'
    )
  order by shift.starts_at
  limit 1;

  if target_shift_id is null then
    raise exception 'A future assigned shift is required for the rollback-only absence test.';
  end if;

  occurrence_result := public.create_attendance_accountability_event(
    target_employee_id,
    target_shift_id,
    'call_off',
    null,
    'Rollback-only absence coverage completion regression.'
  );
  occurrence_id := (occurrence_result ->> 'id')::uuid;
  call_off_id := (occurrence_result ->> 'callOffId')::uuid;

  if call_off_id is null or not coalesce((occurrence_result ->> 'coverageRequired')::boolean, false) then
    raise exception 'The Accountability absence did not return a required call-off coverage handoff.';
  end if;
  if not exists (
    select 1
    from public.attendance_accountability_events event
    where event.id = occurrence_id
      and event.call_off_report_id = call_off_id
      and event.event_type = 'call_off'
  ) then
    raise exception 'The factual absence and call-off report were not linked.';
  end if;
  if exists (
    select 1
    from public.shifts coverage_shift
    where coverage_shift.coverage_source_shift_id = target_shift_id
      and coverage_shift.canceled_at is null
  ) then
    raise exception 'Recording the absence created a coverage shift before management chose a plan.';
  end if;

  coverage_result := public.resolve_call_off_coverage(
    call_off_id,
    'open_pool',
    null,
    'Rollback-only open coverage shift',
    'Rollback-only test of the Flex-first open-shift workflow.',
    'Rollback-only test confirms the separate opening and original assignment.',
    false,
    idempotency_key
  );
  coverage_shift_id := (coverage_result ->> 'coverageShiftId')::uuid;

  if coverage_result ->> 'status' <> 'open_pool' or coverage_shift_id is null then
    raise exception 'The open-pool coverage decision did not create a separate opening.';
  end if;
  if not exists (
    select 1
    from public.shift_assignments assignment
    where assignment.id = original_assignment_id
      and assignment.shift_id = target_shift_id
      and assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'confirmed')
  ) then
    raise exception 'The original published assignment was not preserved.';
  end if;
  if not exists (
    select 1
    from public.shifts coverage_shift
    where coverage_shift.id = coverage_shift_id
      and coverage_shift.coverage_source_shift_id = target_shift_id
      and coverage_shift.is_open
      and coverage_shift.canceled_at is null
  ) then
    raise exception 'The separate open coverage shift was not published to the open pool.';
  end if;
  if not exists (
    select 1
    from public.call_off_reports report
    where report.id = call_off_id
      and report.acknowledged_at is not null
      and report.resolved_at is null
  ) then
    raise exception 'The open coverage call-off was not acknowledged or was incorrectly closed.';
  end if;

  request_payload := public.get_request_center_payload();
  if not coalesce((request_payload #>> '{permissions,canManage}')::boolean, false) then
    raise exception 'The manager permission contract is missing from Requests.';
  end if;

  operations_payload := public.get_timekeeping_operations_workspace(
    target_operational_date,
    target_operational_date
  );
  if not exists (
    select 1
    from jsonb_array_elements(operations_payload -> 'callOffReports') item
    where (item ->> 'id')::uuid = call_off_id
      and item ->> 'resolvedAt' is null
      and item ->> 'coverageStatus' = 'open_pool'
  ) then
    raise exception 'Time Operations did not receive the durable coverage status.';
  end if;

  raise notice 'Absence entry, separate open coverage shift, permission contract, and original-assignment preservation passed.';
end
$$;

rollback;

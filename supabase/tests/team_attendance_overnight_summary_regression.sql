-- Run against a database with
-- 20261018225038_repair_team_attendance_overnight_summary.sql installed.
-- Every employee, schedule, shift, punch, and correction fixture is rolled back.

begin;

set local statement_timeout = '90s';

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  completed_employee_id constant uuid := 'fa000000-0000-4000-8000-000000000101';
  incomplete_employee_id constant uuid := 'fa000000-0000-4000-8000-000000000102';
  boundary_employee_id constant uuid := 'fa000000-0000-4000-8000-000000000103';
  rounding_employee_id constant uuid := 'fa000000-0000-4000-8000-000000000104';
  site_id constant uuid := 'fa100000-0000-4000-8000-000000000101';
  post_id constant uuid := 'fa200000-0000-4000-8000-000000000101';
  prior_schedule_id constant uuid := 'fa300000-0000-4000-8000-000000000101';
  current_schedule_id constant uuid := 'fa300000-0000-4000-8000-000000000102';
  boundary_shift_id constant uuid := 'fa400000-0000-4000-8000-000000000101';
  completed_shift_id constant uuid := 'fa400000-0000-4000-8000-000000000102';
  incomplete_shift_id constant uuid := 'fa400000-0000-4000-8000-000000000103';
  rounding_shift_id constant uuid := 'fa400000-0000-4000-8000-000000000104';
  boundary_clock_in_id constant uuid := 'fa500000-0000-4000-8000-000000000101';
  boundary_clock_out_id constant uuid := 'fa500000-0000-4000-8000-000000000102';
  completed_clock_in_id constant uuid := 'fa500000-0000-4000-8000-000000000103';
  completed_clock_out_id constant uuid := 'fa500000-0000-4000-8000-000000000104';
  incomplete_clock_in_id constant uuid := 'fa500000-0000-4000-8000-000000000105';
  rounding_clock_in_id constant uuid := 'fa500000-0000-4000-8000-000000000106';
  rounding_gap_out_id constant uuid := 'fa500000-0000-4000-8000-000000000107';
  rounding_gap_in_id constant uuid := 'fa500000-0000-4000-8000-000000000108';
  rounding_clock_out_id constant uuid := 'fa500000-0000-4000-8000-000000000109';
  correction_id constant uuid := 'fa600000-0000-4000-8000-000000000101';
  summary_payload jsonb;
  completed_row jsonb;
  incomplete_row jsonb;
  boundary_row jsonb;
  totals_payload jsonb;
  rounding_totals_row jsonb;
  rounding_review_row jsonb;
  current_review jsonb;
  following_review jsonb;
  current_review_row jsonb;
  following_review_row jsonb;
  occurrence_key text;
  function_is_definer boolean;
  function_config text[];
  totals_is_definer boolean;
  totals_config text[];
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise exception 'An active MFA-capable Team Attendance viewer is required for this rollback-only regression.';
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

  select procedure.prosecdef, procedure.proconfig
  into function_is_definer, function_config
  from pg_catalog.pg_proc procedure
  where procedure.oid = 'public.get_team_attendance_summary(date,date)'::regprocedure;

  if not coalesce(function_is_definer, false)
    or not coalesce(function_config @> array['search_path=""'], false)
    or has_function_privilege('public', 'public.get_team_attendance_summary(date,date)', 'execute')
    or has_function_privilege('anon', 'public.get_team_attendance_summary(date,date)', 'execute')
    or not has_function_privilege('authenticated', 'public.get_team_attendance_summary(date,date)', 'execute')
  then
    raise exception 'Team Attendance function security or grants changed unexpectedly.';
  end if;

  select procedure.prosecdef, procedure.proconfig
  into totals_is_definer, totals_config
  from pg_catalog.pg_proc procedure
  where procedure.oid = 'public.get_team_attendance_totals(date,date)'::regprocedure;

  if not coalesce(totals_is_definer, false)
    or not coalesce(totals_config @> array['search_path=""'], false)
    or has_function_privilege('public', 'public.get_team_attendance_totals(date,date)', 'execute')
    or has_function_privilege('anon', 'public.get_team_attendance_totals(date,date)', 'execute')
    or not has_function_privilege('authenticated', 'public.get_team_attendance_totals(date,date)', 'execute')
  then
    raise exception 'Team Attendance totals function security or grants changed unexpectedly.';
  end if;

  insert into public.employees (
    id, username, first_name, last_name, role, employment_type, status, time_zone
  ) values
    (
      completed_employee_id, 'overnightcomplete2099', 'Overnight', 'Complete',
      'guard', 'hourly', 'active', 'America/Denver'
    ),
    (
      incomplete_employee_id, 'overnightopen2099', 'Overnight', 'Open',
      'guard', 'hourly', 'active', 'America/Denver'
    ),
    (
      boundary_employee_id, 'dstboundary2099', 'DST', 'Boundary',
      'guard', 'hourly', 'active', 'America/Denver'
    ),
    (
      rounding_employee_id, 'occurrencerounding2099', 'Occurrence', 'Rounding',
      'guard', 'hourly', 'active', 'America/Denver'
    );

  insert into public.sites (id, code, name, time_zone, active)
  values (site_id, 'OVERNIGHT-REG', 'Overnight Summary Regression', 'America/Denver', true);

  insert into public.posts (id, site_id, name, requires_armed, active)
  values (post_id, site_id, 'Summary Regression Post', false, true);

  insert into public.schedules (id, week_starts_on, revision, status, created_by)
  values
    (prior_schedule_id, date '2099-10-25', 97, 'draft', actor_employee_id),
    (current_schedule_id, date '2099-11-01', 97, 'draft', actor_employee_id);

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, payroll_category, created_by
  ) values
    (
      boundary_shift_id, prior_schedule_id, post_id,
      timestamptz '2099-11-01 04:00:00+00',
      timestamptz '2099-11-01 11:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      completed_shift_id, current_schedule_id, post_id,
      timestamptz '2099-11-08 03:00:00+00',
      timestamptz '2099-11-08 11:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      incomplete_shift_id, current_schedule_id, post_id,
      timestamptz '2099-11-08 03:00:00+00',
      timestamptz '2099-11-08 11:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      rounding_shift_id, current_schedule_id, post_id,
      timestamptz '2099-11-04 03:00:00+00',
      timestamptz '2099-11-04 11:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    );

  insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
  values
    (boundary_shift_id, boundary_employee_id, 'assigned', actor_employee_id),
    (completed_shift_id, completed_employee_id, 'assigned', actor_employee_id),
    (incomplete_shift_id, incomplete_employee_id, 'assigned', actor_employee_id),
    (rounding_shift_id, rounding_employee_id, 'assigned', actor_employee_id);

  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = actor_employee_id
  where id in (prior_schedule_id, current_schedule_id);

  -- Saturday 10 PM MDT through Sunday 4 AM MST crosses the fall-back hour.
  -- It belongs only to the operational range containing Saturday 10/31.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      boundary_clock_in_id, boundary_employee_id, boundary_shift_id, 'clock_in',
      timestamptz '2099-11-01 04:00:00+00', 'web',
      'team-summary-dst-boundary-clock-in', actor_employee_id
    ),
    (
      boundary_clock_out_id, boundary_employee_id, boundary_shift_id, 'clock_out',
      timestamptz '2099-11-01 11:00:00+00', 'web',
      'team-summary-dst-boundary-clock-out', actor_employee_id
    ),
    (
      completed_clock_in_id, completed_employee_id, completed_shift_id, 'clock_in',
      timestamptz '2099-11-08 06:36:00+00', 'web',
      'team-summary-adjusted-clock-in', actor_employee_id
    ),
    (
      completed_clock_out_id, completed_employee_id, completed_shift_id, 'clock_out',
      timestamptz '2099-11-08 11:00:00+00', 'web',
      'team-summary-completed-clock-out', actor_employee_id
    ),
    (
      incomplete_clock_in_id, incomplete_employee_id, incomplete_shift_id, 'clock_in',
      timestamptz '2099-11-08 03:00:00+00', 'web',
      'team-summary-incomplete-clock-in', actor_employee_id
    ),
    (
      rounding_clock_in_id, rounding_employee_id, rounding_shift_id, 'clock_in',
      timestamptz '2099-11-04 03:00:00+00', 'web',
      'team-summary-rounding-clock-in', actor_employee_id
    ),
    (
      rounding_gap_out_id, rounding_employee_id, rounding_shift_id, 'clock_out',
      timestamptz '2099-11-04 06:59:29+00', 'web',
      'team-summary-rounding-gap-out', actor_employee_id
    ),
    (
      rounding_gap_in_id, rounding_employee_id, rounding_shift_id, 'clock_in',
      timestamptz '2099-11-04 06:59:31+00', 'web',
      'team-summary-rounding-gap-in', actor_employee_id
    ),
    (
      rounding_clock_out_id, rounding_employee_id, rounding_shift_id, 'clock_out',
      timestamptz '2099-11-04 11:00:00+00', 'web',
      'team-summary-rounding-clock-out', actor_employee_id
    );

  insert into public.time_event_corrections (
    id, time_event_id, replacement_time, voided, reason,
    requested_by, approved_by, approved_at
  ) values (
    correction_id,
    completed_clock_in_id,
    timestamptz '2099-11-08 03:00:00+00',
    false,
    'Rollback-only first-day onboarding adjustment.',
    actor_employee_id,
    actor_employee_id,
    clock_timestamp()
  );

  summary_payload := public.get_team_attendance_summary(
    date '2099-11-01',
    date '2099-11-07'
  );

  select item.value into completed_row
  from jsonb_array_elements(summary_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = completed_employee_id::text;

  select item.value into incomplete_row
  from jsonb_array_elements(summary_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = incomplete_employee_id::text;

  select item.value into boundary_row
  from jsonb_array_elements(summary_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = boundary_employee_id::text;

  if completed_row is null
    or completed_row ->> 'latestKind' <> 'clock_out'
    or (completed_row ->> 'latestEffectiveAt')::timestamptz
      <> timestamptz '2099-11-08 11:00:00+00'
    or (completed_row ->> 'firstClockIn')::timestamptz
      <> timestamptz '2099-11-08 03:00:00+00'
    or (completed_row ->> 'lastClockOut')::timestamptz
      <> timestamptz '2099-11-08 11:00:00+00'
    or (completed_row ->> 'eventCount')::integer <> 2
    or (completed_row ->> 'scheduledShiftCount')::integer <> 1
    or (completed_row ->> 'scheduledMinutes')::integer <> 480
  then
    raise exception 'Completed final-day overnight occurrence did not remain whole: %', completed_row;
  end if;

  if incomplete_row is null
    or incomplete_row ->> 'latestKind' <> 'clock_in'
    or incomplete_row ->> 'lastClockOut' is not null
    or (incomplete_row ->> 'eventCount')::integer <> 1
  then
    raise exception 'Incomplete overnight occurrence was silently completed: %', incomplete_row;
  end if;

  totals_payload := public.get_team_attendance_totals(
    date '2099-11-01',
    date '2099-11-07'
  );

  select item.value into rounding_totals_row
  from jsonb_array_elements(totals_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = rounding_employee_id::text;

  occurrence_key := 'shift:' || rounding_shift_id::text
    || ':employee:' || rounding_employee_id::text;
  current_review := public.get_timekeeping_review(date '2099-11-01', date '2099-11-07');

  select item.value into rounding_review_row
  from jsonb_array_elements(current_review -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = occurrence_key;

  if rounding_totals_row is null
    or rounding_review_row is null
    or (rounding_totals_row ->> 'paidMinutes')::integer <> 480
    or (rounding_totals_row ->> 'workedSegmentCount')::integer <> 2
    or (rounding_totals_row ->> 'breakMinutes')::integer <> 0
    or (rounding_review_row ->> 'occurrencePaidMinutes')::integer <> 480
    or (rounding_totals_row ->> 'paidMinutes')::integer
      <> (rounding_review_row ->> 'occurrencePaidMinutes')::integer
  then
    raise exception 'Team totals did not use canonical occurrence-level minute rounding: totals %, review %',
      rounding_totals_row, rounding_review_row;
  end if;

  if boundary_row is not null then
    raise exception 'A prior-range fall-back occurrence leaked into the following operational range: %', boundary_row;
  end if;

  if (select event.recorded_at from public.time_events event where event.id = completed_clock_in_id)
      <> timestamptz '2099-11-08 06:36:00+00'
    or (select correction.replacement_time from public.time_event_corrections correction where correction.id = correction_id)
      <> timestamptz '2099-11-08 03:00:00+00'
  then
    raise exception 'The effective adjustment replaced original punch evidence.';
  end if;

  summary_payload := public.get_team_attendance_summary(
    date '2099-10-25',
    date '2099-10-31'
  );

  select item.value into boundary_row
  from jsonb_array_elements(summary_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = boundary_employee_id::text;

  if boundary_row is null
    or boundary_row ->> 'latestKind' <> 'clock_out'
    or (boundary_row ->> 'lastClockOut')::timestamptz
      <> timestamptz '2099-11-01 11:00:00+00'
    or (boundary_row ->> 'eventCount')::integer <> 2
    or (boundary_row ->> 'scheduledMinutes')::integer <> 420
  then
    raise exception 'Fall-back overnight occurrence was not retained by its starting workday: %', boundary_row;
  end if;

  summary_payload := public.get_team_attendance_summary(
    date '2099-11-08',
    date '2099-11-14'
  );

  select item.value into completed_row
  from jsonb_array_elements(summary_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = completed_employee_id::text;

  if completed_row is not null then
    raise exception 'A closing punch was double-counted in the next operational range: %', completed_row;
  end if;

  occurrence_key := 'shift:' || completed_shift_id::text
    || ':employee:' || completed_employee_id::text;
  current_review := public.get_timekeeping_review(date '2099-11-01', date '2099-11-07');
  following_review := public.get_timekeeping_review(date '2099-11-08', date '2099-11-14');

  select item.value into current_review_row
  from jsonb_array_elements(current_review -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = occurrence_key;

  select item.value into following_review_row
  from jsonb_array_elements(following_review -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = occurrence_key;

  if current_review_row is null
    or following_review_row is null
    or (current_review_row ->> 'occurrencePaidMinutes')::integer <> 480
    or (following_review_row ->> 'occurrencePaidMinutes')::integer <> 480
    or (current_review_row ->> 'paidMinutes')::integer <> 240
    or (following_review_row ->> 'paidMinutes')::integer <> 240
    or (current_review_row ->> 'paidMinutes')::integer
      + (following_review_row ->> 'paidMinutes')::integer <> 480
  then
    raise exception 'Adjacent payroll allocations no longer reconcile to the complete occurrence: current %, following %',
      current_review_row, following_review_row;
  end if;

  raise notice 'team_attendance_overnight_summary_regression_passed';
end
$$;

rollback;

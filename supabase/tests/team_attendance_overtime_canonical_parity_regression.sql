-- Run against a database with
-- 20261018231406_team_attendance_overtime_canonical_parity.sql installed.
-- All fixtures are isolated by the outer transaction and rolled back.

begin;

set local statement_timeout = '90s';

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  prior_hours_employee_id constant uuid := 'fb000000-0000-4000-8000-000000000201';
  boundary_employee_id constant uuid := 'fb000000-0000-4000-8000-000000000202';
  incomplete_employee_id constant uuid := 'fb000000-0000-4000-8000-000000000203';
  totals_payload jsonb;
  next_totals_payload jsonb;
  current_review jsonb;
  following_review jsonb;
  prior_hours_total jsonb;
  boundary_total jsonb;
  incomplete_total jsonb;
  prior_hours_review jsonb;
  boundary_current_review jsonb;
  boundary_following_review jsonb;
  corrected_totals_payload jsonb;
  corrected_total jsonb;
  corrected_review_payload jsonb;
  corrected_review jsonb;
  function_is_definer boolean;
  function_config text[];
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 when 'supervisor' then 1 else 2 end,
    employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise exception 'An active MFA-capable operations viewer is required for this rollback-only regression.';
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
  where procedure.oid = 'public.get_team_attendance_totals(date,date)'::regprocedure;

  if not coalesce(function_is_definer, false)
    or not coalesce(function_config @> array['search_path=""'], false)
    or has_function_privilege('public', 'public.get_team_attendance_totals(date,date)', 'execute')
    or has_function_privilege('anon', 'public.get_team_attendance_totals(date,date)', 'execute')
    or not has_function_privilege('authenticated', 'public.get_team_attendance_totals(date,date)', 'execute')
  then
    raise exception 'Team Attendance totals security, search_path, or grants changed unexpectedly.';
  end if;

  insert into public.employees (
    id, username, first_name, last_name, role, employment_type, status, time_zone
  ) values
    (
      prior_hours_employee_id, 'partialweekot2099', 'Partial', 'Week OT',
      'guard', 'hourly', 'active', 'America/Denver'
    ),
    (
      boundary_employee_id, 'saturdayboundary2099', 'Saturday', 'Boundary',
      'guard', 'hourly', 'active', 'America/Denver'
    ),
    (
      incomplete_employee_id, 'incompletepunch2099', 'Incomplete', 'Punch',
      'guard', 'hourly', 'active', 'America/Denver'
    );

  -- Forty prior hours are outside the one-day request but inside its payroll
  -- week. The Saturday occurrence must therefore be 480 overtime minutes.
  with shifts(local_date, duration_hours) as (
    values
      (date '2099-11-01', 8),
      (date '2099-11-02', 8),
      (date '2099-11-03', 8),
      (date '2099-11-04', 8),
      (date '2099-11-05', 8),
      (date '2099-11-07', 8)
  ), punches as (
    select
      gen_random_uuid() as id,
      prior_hours_employee_id as employee_id,
      'clock_in'::public.time_event_kind as kind,
      (shift.local_date::timestamp + time '08:00') at time zone 'America/Denver' as recorded_at,
      'team-ot-prior-' || shift.local_date::text || '-in' as idempotency_key
    from shifts shift
    union all
    select
      gen_random_uuid(),
      prior_hours_employee_id,
      'clock_out'::public.time_event_kind,
      ((shift.local_date::timestamp + time '08:00') at time zone 'America/Denver')
        + make_interval(hours => shift.duration_hours),
      'team-ot-prior-' || shift.local_date::text || '-out'
    from shifts shift
  )
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  )
  select
    punch.id, punch.employee_id, null, punch.kind, punch.recorded_at, 'web',
    punch.idempotency_key, actor_employee_id
  from punches punch;

  -- Thirty-eight hours precede a Saturday 10 PM to Sunday 4 AM occurrence.
  -- Only two hours belong to the old payroll week; four belong to the new
  -- week, so the complete six-hour occurrence has no overtime.
  with shifts(local_date, duration_hours) as (
    values
      (date '2099-11-01', 8),
      (date '2099-11-02', 8),
      (date '2099-11-03', 8),
      (date '2099-11-04', 8),
      (date '2099-11-05', 6)
  ), punches as (
    select
      gen_random_uuid() as id,
      boundary_employee_id as employee_id,
      'clock_in'::public.time_event_kind as kind,
      (shift.local_date::timestamp + time '08:00') at time zone 'America/Denver' as recorded_at,
      'team-ot-boundary-' || shift.local_date::text || '-in' as idempotency_key
    from shifts shift
    union all
    select
      gen_random_uuid(),
      boundary_employee_id,
      'clock_out'::public.time_event_kind,
      ((shift.local_date::timestamp + time '08:00') at time zone 'America/Denver')
        + make_interval(hours => shift.duration_hours),
      'team-ot-boundary-' || shift.local_date::text || '-out'
    from shifts shift
  )
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  )
  select
    punch.id, punch.employee_id, null, punch.kind, punch.recorded_at, 'web',
    punch.idempotency_key, actor_employee_id
  from punches punch;

  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      'fb500000-0000-4000-8000-000000000201', boundary_employee_id, null,
      'clock_in', timestamptz '2099-11-08 05:00:00+00', 'web',
      'team-ot-boundary-overnight-in', actor_employee_id
    ),
    (
      'fb500000-0000-4000-8000-000000000202', boundary_employee_id, null,
      'clock_out', timestamptz '2099-11-08 11:00:00+00', 'web',
      'team-ot-boundary-overnight-out', actor_employee_id
    ),
    (
      'fb500000-0000-4000-8000-000000000203', incomplete_employee_id, null,
      'clock_in', timestamptz '2099-11-08 03:00:00+00', 'web',
      'team-ot-incomplete-clock-in', actor_employee_id
    );

  totals_payload := public.get_team_attendance_totals(
    date '2099-11-07',
    date '2099-11-07'
  );
  current_review := public.get_timekeeping_review(
    date '2099-11-07',
    date '2099-11-07'
  );
  following_review := public.get_timekeeping_review(
    date '2099-11-08',
    date '2099-11-08'
  );

  select item.value into prior_hours_total
  from jsonb_array_elements(totals_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = prior_hours_employee_id::text;

  select item.value into boundary_total
  from jsonb_array_elements(totals_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = boundary_employee_id::text;

  select item.value into incomplete_total
  from jsonb_array_elements(totals_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = incomplete_employee_id::text;

  select item.value into prior_hours_review
  from jsonb_array_elements(current_review -> 'rows') item(value)
  where item.value ->> 'rowKind' = 'time_event'
    and item.value ->> 'employeeId' = prior_hours_employee_id::text
    and item.value ->> 'operationalDate' = '2099-11-07';

  select item.value into boundary_current_review
  from jsonb_array_elements(current_review -> 'rows') item(value)
  where item.value ->> 'rowKind' = 'time_event'
    and item.value ->> 'employeeId' = boundary_employee_id::text
    and item.value ->> 'operationalDate' = '2099-11-07';

  select item.value into boundary_following_review
  from jsonb_array_elements(following_review -> 'rows') item(value)
  where item.value ->> 'rowKind' = 'time_event'
    and item.value ->> 'employeeId' = boundary_employee_id::text
    and item.value ->> 'operationalDate' = '2099-11-07';

  if prior_hours_total is null
    or prior_hours_review is null
    or (prior_hours_total ->> 'paidMinutes')::integer <> 480
    or (prior_hours_total ->> 'overtimeMinutes')::integer <> 480
    or (prior_hours_total ->> 'workedSegmentCount')::integer <> 1
    or (prior_hours_total ->> 'incompletePunchCount')::integer <> 0
    or (prior_hours_total ->> 'overtimeMinutes')::integer
      <> (prior_hours_review ->> 'occurrenceOvertimeMinutes')::integer
  then
    raise exception 'Partial-range prior-hours overtime did not match the canonical review: totals %, review %',
      prior_hours_total, prior_hours_review;
  end if;

  if boundary_total is null
    or boundary_current_review is null
    or boundary_following_review is null
    or (boundary_total ->> 'paidMinutes')::integer <> 360
    or (boundary_total ->> 'overtimeMinutes')::integer <> 0
    or (boundary_total ->> 'workedSegmentCount')::integer <> 1
    or (boundary_total ->> 'incompletePunchCount')::integer <> 0
    or (boundary_current_review ->> 'occurrencePaidMinutes')::integer <> 360
    or (boundary_current_review ->> 'occurrenceOvertimeMinutes')::integer <> 0
    or (boundary_current_review ->> 'paidMinutes')::integer <> 120
    or (boundary_following_review ->> 'paidMinutes')::integer <> 240
    or (boundary_current_review ->> 'paidMinutes')::integer
      + (boundary_following_review ->> 'paidMinutes')::integer <> 360
  then
    raise exception 'Saturday overnight payroll-week allocation did not reconcile: totals %, current %, following %',
      boundary_total, boundary_current_review, boundary_following_review;
  end if;

  if incomplete_total is null
    or (incomplete_total ->> 'paidMinutes')::integer <> 0
    or (incomplete_total ->> 'workedSegmentCount')::integer <> 0
    or (incomplete_total ->> 'incompletePunchCount')::integer <> 1
  then
    raise exception 'Incomplete canonical occurrence was not flagged without fabricated time: %',
      incomplete_total;
  end if;

  -- Preserve an authorized whole-occurrence payroll-week correction. Team
  -- Attendance still owns the occurrence on Saturday, but its overtime must
  -- match the canonical review after the occurrence is assigned to the next
  -- payroll week.
  insert into private.payroll_batch_assignments (
    occurrence_key,
    occurrence_fingerprint,
    employee_id,
    shift_id,
    assignment_source,
    assignment_status,
    assignment_anchor,
    original_week_start,
    assigned_week_start,
    policy_version,
    configuration_version,
    cross_boundary,
    correction_reason,
    corrected_by,
    corrected_at,
    recalculated_at
  )
  select
    prior_hours_review ->> 'payrollOccurrenceKey',
    prior_hours_review ->> 'payrollOccurrenceFingerprint',
    prior_hours_employee_id,
    null,
    'authorized_correction',
    'corrected',
    (prior_hours_review ->> 'firstClockIn')::timestamptz,
    date '2099-11-01',
    date '2099-11-08',
    rules.payroll_calculation_policy_version,
    rules.payroll_configuration_version,
    false,
    'Rollback-only canonical parity fixture.',
    actor_employee_id,
    clock_timestamp(),
    clock_timestamp()
  from private.payroll_rules rules
  where rules.id = true;

  corrected_totals_payload := public.get_team_attendance_totals(
    date '2099-11-07',
    date '2099-11-07'
  );
  corrected_review_payload := public.get_timekeeping_review(
    date '2099-11-08',
    date '2099-11-08'
  );

  select item.value into corrected_total
  from jsonb_array_elements(corrected_totals_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = prior_hours_employee_id::text;

  select item.value into corrected_review
  from jsonb_array_elements(corrected_review_payload -> 'rows') item(value)
  where item.value ->> 'rowKind' = 'time_event'
    and item.value ->> 'employeeId' = prior_hours_employee_id::text
    and item.value ->> 'payrollOccurrenceKey'
      = prior_hours_review ->> 'payrollOccurrenceKey';

  if corrected_total is null
    or corrected_review is null
    or (corrected_total ->> 'paidMinutes')::integer <> 480
    or (corrected_total ->> 'overtimeMinutes')::integer <> 0
    or corrected_review ->> 'payrollAssignmentStatus' <> 'corrected'
    or (corrected_review ->> 'occurrencePaidMinutes')::integer <> 480
    or (corrected_review ->> 'occurrenceOvertimeMinutes')::integer <> 0
  then
    raise exception 'Authorized payroll-week correction did not retain canonical Team Attendance parity: totals %, review %',
      corrected_total, corrected_review;
  end if;

  next_totals_payload := public.get_team_attendance_totals(
    date '2099-11-08',
    date '2099-11-08'
  );

  if exists (
    select 1
    from jsonb_array_elements(next_totals_payload -> 'rows') item(value)
    where item.value ->> 'employeeId' = boundary_employee_id::text
  )
  then
    raise exception 'The next-day close was double-counted as a Sunday operational occurrence: %',
      next_totals_payload;
  end if;

  raise notice 'team_attendance_overtime_canonical_parity_regression_passed';
end
$$;

rollback;

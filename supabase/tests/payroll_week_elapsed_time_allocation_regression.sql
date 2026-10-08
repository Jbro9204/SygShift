-- Run against a database with
-- 20261008125500_payroll_week_elapsed_time_allocation.sql installed.
-- Every fixture, locked snapshot, and audit row is rolled back.

begin;

set local statement_timeout = '90s';

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  worked_employee_id constant uuid := 'ae000000-0000-4000-8000-000000000001';
  incomplete_employee_id constant uuid := 'ae000000-0000-4000-8000-000000000002';
  site_id constant uuid := 'ae100000-0000-4000-8000-000000000001';
  post_id constant uuid := 'ae200000-0000-4000-8000-000000000001';
  prior_schedule_id constant uuid := 'ae300000-0000-4000-8000-000000000001';
  current_schedule_id constant uuid := 'ae300000-0000-4000-8000-000000000002';
  following_schedule_id constant uuid := 'ae300000-0000-4000-8000-000000000003';
  boundary_shift_id constant uuid := 'ae400000-0000-4000-8000-000000000001';
  wednesday_shift_id constant uuid := 'ae400000-0000-4000-8000-000000000002';
  corrected_shift_id constant uuid := 'ae400000-0000-4000-8000-000000000003';
  incomplete_shift_id constant uuid := 'ae400000-0000-4000-8000-000000000004';
  legacy_shift_id constant uuid := 'ae400000-0000-4000-8000-000000000005';
  boundary_clock_in_id constant uuid := 'ae500000-0000-4000-8000-000000000001';
  boundary_break_start_id constant uuid := 'ae500000-0000-4000-8000-000000000002';
  boundary_break_end_id constant uuid := 'ae500000-0000-4000-8000-000000000003';
  boundary_clock_out_id constant uuid := 'ae500000-0000-4000-8000-000000000004';
  wednesday_clock_in_id constant uuid := 'ae500000-0000-4000-8000-000000000005';
  wednesday_clock_out_id constant uuid := 'ae500000-0000-4000-8000-000000000006';
  corrected_clock_in_id constant uuid := 'ae500000-0000-4000-8000-000000000007';
  corrected_clock_out_id constant uuid := 'ae500000-0000-4000-8000-000000000008';
  incomplete_clock_in_id constant uuid := 'ae500000-0000-4000-8000-000000000009';
  legacy_clock_in_id constant uuid := 'ae500000-0000-4000-8000-00000000000a';
  legacy_clock_out_id constant uuid := 'ae500000-0000-4000-8000-00000000000b';
  boundary_occurrence_key text;
  wednesday_occurrence_key text;
  corrected_occurrence_key text;
  legacy_occurrence_key text;
  review_payload jsonb;
  boundary_row jsonb;
  wednesday_row jsonb;
  corrected_row jsonb;
  incomplete_row jsonb;
  legacy_row jsonb;
  prior_allocation jsonb;
  current_allocation jsonb;
  prior_batch jsonb;
  current_batch jsonb;
  duplicate_batch jsonb;
  legacy_batch_id uuid;
  existing_batch_ids uuid[] := '{}'::uuid[];
  existing_export_row_ids bigint[] := '{}'::bigint[];
  existing_history_ids uuid[] := '{}'::uuid[];
  existing_batch_hash text;
  existing_export_row_hash text;
  existing_history_hash text;
  current_hash text;
  prior_locked_boundary_payload jsonb;
  function_sql text;
  duplicate_slice_blocked boolean := false;
  legacy_reallocation_blocked boolean := false;
  incomplete_lock_blocked boolean := false;
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
    and 'time.export_payroll' = any(private.employee_effective_permissions(employee.id))
    and 'time.override_payroll_assignment' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise exception 'An active MFA-capable payroll export/override actor is required for this rollback-only regression.';
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

  select coalesce(array_agg(batch.id order by batch.id), '{}'::uuid[]),
    md5(coalesce(jsonb_agg(to_jsonb(batch) order by batch.id)::text, '[]'))
  into existing_batch_ids, existing_batch_hash
  from private.payroll_export_batches batch;

  select coalesce(array_agg(export_row.id order by export_row.id), '{}'::bigint[]),
    md5(coalesce(jsonb_agg(to_jsonb(export_row) order by export_row.id)::text, '[]'))
  into existing_export_row_ids, existing_export_row_hash
  from private.payroll_export_rows export_row;

  select coalesce(array_agg(history.id order by history.id), '{}'::uuid[]),
    md5(coalesce(jsonb_agg(to_jsonb(history) order by history.id)::text, '[]'))
  into existing_history_ids, existing_history_hash
  from public.payroll_batch_assignment_history history;

  -- A low weekly threshold makes the boundary-week assignment observable.
  -- Daily overtime remains above every fixture occurrence.
  update private.payroll_rules
  set daily_overtime_minutes = 720,
      weekly_overtime_minutes = 180,
      updated_at = clock_timestamp()
  where id = true;

  insert into public.employees (
    id, username, first_name, last_name, role, employment_type, status, time_zone
  ) values
    (
      worked_employee_id, 'weekalloc2098', 'Week', 'Allocation', 'guard',
      'hourly', 'active', 'America/Denver'
    ),
    (
      incomplete_employee_id, 'weekopen2098', 'Open', 'Occurrence', 'guard',
      'hourly', 'active', 'America/Denver'
    );

  insert into public.sites (id, code, name, time_zone, active)
  values (site_id, 'WEEK-ALLOC', 'Payroll Week Allocation', 'America/Denver', true);

  insert into public.posts (id, site_id, name, requires_armed, active)
  values (post_id, site_id, 'Allocation Post', false, true);

  insert into public.schedules (id, week_starts_on, revision, status, created_by)
  values
    (prior_schedule_id, date '2098-01-12', 91, 'draft', actor_employee_id),
    (current_schedule_id, date '2098-01-19', 91, 'draft', actor_employee_id),
    (following_schedule_id, date '2098-01-26', 91, 'draft', actor_employee_id);

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, payroll_category, created_by
  ) values
    (
      boundary_shift_id, prior_schedule_id, post_id,
      timestamptz '2098-01-19 05:00:00+00',
      timestamptz '2098-01-19 13:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      wednesday_shift_id, current_schedule_id, post_id,
      timestamptz '2098-01-22 19:00:00+00',
      timestamptz '2098-01-22 20:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      corrected_shift_id, current_schedule_id, post_id,
      timestamptz '2098-01-19 14:00:00+00',
      timestamptz '2098-01-19 15:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      incomplete_shift_id, current_schedule_id, post_id,
      timestamptz '2098-01-26 05:00:00+00',
      timestamptz '2098-01-26 13:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    ),
    (
      legacy_shift_id, following_schedule_id, post_id,
      timestamptz '2098-01-30 19:00:00+00',
      timestamptz '2098-01-30 20:00:00+00',
      'America/Denver', 1, 'regular', actor_employee_id
    );

  insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
  values
    (boundary_shift_id, worked_employee_id, 'assigned', actor_employee_id),
    (wednesday_shift_id, worked_employee_id, 'assigned', actor_employee_id),
    (corrected_shift_id, worked_employee_id, 'assigned', actor_employee_id),
    (incomplete_shift_id, incomplete_employee_id, 'assigned', actor_employee_id),
    (legacy_shift_id, worked_employee_id, 'assigned', actor_employee_id);

  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = actor_employee_id
  where id in (prior_schedule_id, current_schedule_id, following_schedule_id);

  -- Saturday 10 PM through Sunday 6 AM. The 30-minute break straddles
  -- Sunday 00:00, so each payroll week owns 15 unpaid minutes.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      boundary_clock_in_id, worked_employee_id, boundary_shift_id, 'clock_in',
      timestamptz '2098-01-19 05:00:00+00', 'web',
      'week-allocation-boundary-clock-in', actor_employee_id
    ),
    (
      boundary_break_start_id, worked_employee_id, boundary_shift_id, 'break_start',
      timestamptz '2098-01-19 06:45:00+00', 'web',
      'week-allocation-boundary-break-start', actor_employee_id
    ),
    (
      boundary_break_end_id, worked_employee_id, boundary_shift_id, 'break_end',
      timestamptz '2098-01-19 07:15:00+00', 'web',
      'week-allocation-boundary-break-end', actor_employee_id
    ),
    (
      boundary_clock_out_id, worked_employee_id, boundary_shift_id, 'clock_out',
      timestamptz '2098-01-19 13:00:00+00', 'web',
      'week-allocation-boundary-clock-out', actor_employee_id
    ),
    (
      wednesday_clock_in_id, worked_employee_id, wednesday_shift_id, 'clock_in',
      timestamptz '2098-01-22 19:00:00+00', 'web',
      'week-allocation-wednesday-clock-in', actor_employee_id
    ),
    (
      wednesday_clock_out_id, worked_employee_id, wednesday_shift_id, 'clock_out',
      timestamptz '2098-01-22 20:00:00+00', 'web',
      'week-allocation-wednesday-clock-out', actor_employee_id
    );

  boundary_occurrence_key := 'shift:' || boundary_shift_id::text
    || ':employee:' || worked_employee_id::text;
  wednesday_occurrence_key := 'shift:' || wednesday_shift_id::text
    || ':employee:' || worked_employee_id::text;

  review_payload := public.get_timekeeping_review(date '2098-01-12', date '2098-01-25');
  select item.value into boundary_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = boundary_occurrence_key;

  if boundary_row is null
    or jsonb_array_length(boundary_row -> 'eventTimeline') <> 4
    or jsonb_array_length(boundary_row -> 'payrollWeekAllocations') <> 2
    or (boundary_row ->> 'occurrenceGrossMinutes')::integer <> 480
    or (boundary_row ->> 'occurrenceBreakMinutes')::integer <> 30
    or (boundary_row ->> 'occurrenceUnpaidGapMinutes')::integer <> 0
    or (boundary_row ->> 'occurrencePaidMinutes')::integer <> 450
    or (boundary_row ->> 'occurrenceRegularMinutes')::integer <> 285
    or (boundary_row ->> 'occurrenceOvertimeMinutes')::integer <> 165
    or (boundary_row ->> 'grossMinutes')::integer <> 480
    or (boundary_row ->> 'breakMinutes')::integer <> 30
    or (boundary_row ->> 'paidMinutes')::integer <> 450
    or boundary_row ->> 'payrollGroupingPolicy' <> 'elapsed_time_boundary_split'
    or boundary_row ->> 'payrollPolicyVersion' <> 'payroll-batch-v2'
  then
    raise exception 'The canonical overnight row or whole-occurrence totals changed: %', boundary_row;
  end if;

  select item.value into prior_allocation
  from jsonb_array_elements(boundary_row -> 'payrollWeekAllocations') item(value)
  where item.value ->> 'weekStartsOn' = '2098-01-12';

  select item.value into current_allocation
  from jsonb_array_elements(boundary_row -> 'payrollWeekAllocations') item(value)
  where item.value ->> 'weekStartsOn' = '2098-01-19';

  if prior_allocation is null
    or prior_allocation ->> 'allocationKey' <> boundary_occurrence_key || '|2098-01-12'
    or (prior_allocation ->> 'grossMinutes')::integer <> 120
    or (prior_allocation ->> 'breakMinutes')::integer <> 15
    or (prior_allocation ->> 'paidMinutes')::integer <> 105
    or (prior_allocation ->> 'regularMinutes')::integer <> 105
    or (prior_allocation ->> 'overtimeMinutes')::integer <> 0
    or (prior_allocation ->> 'regularCategoryMinutes')::integer <> 105
    or current_allocation is null
    or current_allocation ->> 'allocationKey' <> boundary_occurrence_key || '|2098-01-19'
    or (current_allocation ->> 'grossMinutes')::integer <> 360
    or (current_allocation ->> 'breakMinutes')::integer <> 15
    or (current_allocation ->> 'paidMinutes')::integer <> 345
    or (current_allocation ->> 'regularMinutes')::integer <> 180
    or (current_allocation ->> 'overtimeMinutes')::integer <> 165
    or (current_allocation ->> 'regularCategoryMinutes')::integer <> 345
  then
    raise exception 'Sunday elapsed-time allocation or weekly overtime is wrong: %, %',
      prior_allocation, current_allocation;
  end if;

  if not coalesce((review_payload -> 'reconciliation' ->> 'passed')::boolean, false)
    or not coalesce((review_payload -> 'reconciliation' ->> 'payrollWeekAllocationsMatchPaid')::boolean, false)
    or (review_payload -> 'reconciliation' ->> 'payrollWeekAllocationBreakMinutes')::integer <> 30
    or (review_payload -> 'reconciliation' ->> 'payrollWeekAllocationUnpaidGapMinutes')::integer <> 0
  then
    raise exception 'Allocation reconciliation failed: %', review_payload -> 'reconciliation';
  end if;

  -- A Wednesday-only review must still load the prior Saturday occurrence as
  -- weekly-OT context. Its 345 Sunday minutes exhaust the 180-minute threshold.
  review_payload := public.get_timekeeping_review(date '2098-01-22', date '2098-01-22');
  select item.value into wednesday_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = wednesday_occurrence_key;

  if wednesday_row is null
    or (wednesday_row ->> 'paidMinutes')::integer <> 60
    or (wednesday_row ->> 'regularMinutes')::integer <> 0
    or (wednesday_row ->> 'overtimeMinutes')::integer <> 60
  then
    raise exception 'Partial-week review lost prior-Saturday weekly OT context: %', wednesday_row;
  end if;

  -- Existing authorized corrections remain auditable, intentional exceptions:
  -- the entire corrected occurrence follows its assigned week.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      corrected_clock_in_id, worked_employee_id, corrected_shift_id, 'clock_in',
      timestamptz '2098-01-19 14:00:00+00', 'web',
      'week-allocation-corrected-clock-in', actor_employee_id
    ),
    (
      corrected_clock_out_id, worked_employee_id, corrected_shift_id, 'clock_out',
      timestamptz '2098-01-19 15:00:00+00', 'web',
      'week-allocation-corrected-clock-out', actor_employee_id
    );

  corrected_occurrence_key := 'shift:' || corrected_shift_id::text
    || ':employee:' || worked_employee_id::text;
  review_payload := public.get_timekeeping_review(date '2098-01-19', date '2098-01-25');
  select item.value into corrected_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = corrected_occurrence_key;

  perform public.correct_payroll_batch_assignment(
    corrected_occurrence_key,
    corrected_row ->> 'payrollOccurrenceFingerprint',
    worked_employee_id,
    corrected_shift_id,
    (corrected_row ->> 'firstClockIn')::timestamptz,
    date '2098-01-19',
    date '2098-01-12',
    'Rollback regression preserves the authorized corrected payroll week.'
  );

  review_payload := public.get_timekeeping_review(date '2098-01-12', date '2098-01-18');
  select item.value into corrected_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = corrected_occurrence_key;

  if corrected_row is null
    or corrected_row ->> 'payrollAssignmentStatus' <> 'corrected'
    or (corrected_row ->> 'paidMinutes')::integer <> 60
    or jsonb_array_length(corrected_row -> 'payrollWeekAllocations') <> 1
    or corrected_row -> 'payrollWeekAllocations' -> 0 ->> 'weekStartsOn' <> '2098-01-12'
  then
    raise exception 'Authorized corrected-week allocation became cosmetic: %', corrected_row;
  end if;

  -- The two adjacent weeks are different biweekly periods for the configured
  -- anchor. Each can lock its distinct slice without duplicating the occurrence.
  if private.get_payroll_period_for_week(date '2098-01-12') ->> 'periodStartsOn'
    = private.get_payroll_period_for_week(date '2098-01-19') ->> 'periodStartsOn'
  then
    raise exception 'Regression dates no longer straddle a configured biweekly boundary.';
  end if;

  prior_batch := public.create_payroll_export_batch(
    date '2098-01-12', date '2098-01-18',
    'Rollback regression locks the prior payroll allocation.'
  );

  if not private.payroll_assignment_is_locked(
    boundary_occurrence_key,
    worked_employee_id,
    boundary_shift_id,
    timestamptz '2098-01-19 05:00:00+00'
  ) then
    raise exception 'The first allocation lock did not preserve occurrence correction safety.';
  end if;

  select export_row.row_payload into prior_locked_boundary_payload
  from private.payroll_export_rows export_row
  where export_row.batch_id = (prior_batch ->> 'id')::uuid
    and export_row.row_payload ->> 'payrollOccurrenceKey' = boundary_occurrence_key;

  current_batch := public.create_payroll_export_batch(
    date '2098-01-19', date '2098-01-25',
    'Rollback regression locks the next payroll allocation.'
  );

  if prior_locked_boundary_payload is null
    or (prior_locked_boundary_payload ->> 'paidMinutes')::integer <> 105
    or prior_locked_boundary_payload -> 'payrollWeekAllocations' -> 0 ->> 'allocationKey'
      <> boundary_occurrence_key || '|2098-01-12'
    or not exists (
      select 1
      from private.payroll_export_rows export_row
      where export_row.batch_id = (current_batch ->> 'id')::uuid
        and export_row.row_payload ->> 'payrollOccurrenceKey' = boundary_occurrence_key
        and (export_row.row_payload ->> 'paidMinutes')::integer = 345
        and export_row.row_payload -> 'payrollWeekAllocations' -> 0 ->> 'allocationKey'
          = boundary_occurrence_key || '|2098-01-19'
    )
  then
    raise exception 'Distinct boundary allocations were not preserved in adjacent locked batches.';
  end if;

  if exists (
    select 1
    from private.payroll_export_batches batch
    where batch.id in ((prior_batch ->> 'id')::uuid, (current_batch ->> 'id')::uuid)
      and (
        batch.payroll_calculation_policy_version <> 'payroll-batch-v2'
        or batch.cross_boundary_grouping_policy <> 'elapsed_time_boundary_split'
      )
  ) then
    raise exception 'A new locked batch was stamped with legacy payroll policy metadata.';
  end if;

  if not exists (
      select 1 from private.audit_events audit
      where audit.table_name = 'payroll_export_batches'
        and audit.operation = 'INSERT'
        and audit.row_id = (prior_batch ->> 'id')
    )
    or not exists (
      select 1 from private.audit_events audit
      where audit.table_name = 'payroll_export_batches'
        and audit.operation = 'INSERT'
        and audit.row_id = (current_batch ->> 'id')
    )
  then
    raise exception 'Locked payroll batches did not append audit events.';
  end if;

  duplicate_batch := public.create_payroll_export_batch(
    date '2098-01-12', date '2098-01-18',
    'Rollback regression locks the prior payroll allocation.'
  );
  if (duplicate_batch ->> 'id')::uuid <> (prior_batch ->> 'id')::uuid
    or not coalesce((duplicate_batch ->> 'duplicate')::boolean, false)
  then
    raise exception 'Exact same-range/digest export idempotency changed: %', duplicate_batch;
  end if;

  begin
    perform public.create_payroll_export_batch(
      date '2098-01-19', date '2098-01-22',
      'Rollback regression rejects an overlapping owned allocation key.'
    );
  exception
    when check_violation then
      duplicate_slice_blocked := position('already present in a locked payroll export' in sqlerrm) > 0;
  end;
  if not duplicate_slice_blocked then
    raise exception 'An overlapping range locked the same payroll-week allocation twice.';
  end if;

  -- Seed a representative immutable v1 row with the new guard disabled only
  -- for this rollback transaction. It must retain whole-occurrence ownership.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      legacy_clock_in_id, worked_employee_id, legacy_shift_id, 'clock_in',
      timestamptz '2098-01-30 19:00:00+00', 'web',
      'week-allocation-legacy-clock-in', actor_employee_id
    ),
    (
      legacy_clock_out_id, worked_employee_id, legacy_shift_id, 'clock_out',
      timestamptz '2098-01-30 20:00:00+00', 'web',
      'week-allocation-legacy-clock-out', actor_employee_id
    );

  legacy_occurrence_key := 'shift:' || legacy_shift_id::text
    || ':employee:' || worked_employee_id::text;
  review_payload := public.get_timekeeping_review(date '2098-01-26', date '2098-02-01');
  select item.value into legacy_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'payrollOccurrenceKey' = legacy_occurrence_key;

  insert into private.payroll_export_batches (
    from_date, through_date, created_by, row_count, gross_minutes, paid_minutes,
    digest, note, review_payload, payroll_configuration_version,
    payroll_calculation_policy_version, payroll_time_zone,
    cross_boundary_grouping_policy
  ) values (
    date '2098-01-26', date '2098-02-01', actor_employee_id, 1, 60, 60,
    encode(extensions.digest(convert_to('legacy-allocation-lock-fixture', 'UTF8'), 'sha256'), 'hex'),
    'Rollback-only legacy allocation ownership fixture.',
    jsonb_build_object('rows', jsonb_build_array(legacy_row - 'payrollWeekAllocations')),
    1, 'payroll-batch-v1', 'America/Denver', 'scheduled_shift_start'
  ) returning id into legacy_batch_id;

  execute 'alter table private.payroll_export_rows disable trigger payroll_export_rows_allocation_lock';
  begin
    insert into private.payroll_export_rows (
      batch_id, row_number, employee_id, shift_id, operational_date, row_payload,
      gross_minutes, paid_minutes, exception_codes, payroll_ready
    ) values (
      legacy_batch_id, 1, worked_employee_id, legacy_shift_id, date '2098-01-30',
      (legacy_row - 'payrollWeekAllocations') || jsonb_build_object(
        'payrollPolicyVersion', 'payroll-batch-v1',
        'payrollGroupingPolicy', 'scheduled_shift_start'
      ),
      60, 60, '{}'::text[], true
    );
  exception
    when others then
      execute 'alter table private.payroll_export_rows enable trigger payroll_export_rows_allocation_lock';
      raise;
  end;
  execute 'alter table private.payroll_export_rows enable trigger payroll_export_rows_allocation_lock';

  begin
    perform public.create_payroll_export_batch(
      date '2098-01-26', date '2098-02-01',
      'Rollback regression rejects v2 reallocation of a legacy locked occurrence.'
    );
  exception
    when check_violation then
      legacy_reallocation_blocked := position('legacy locked payroll export' in sqlerrm) > 0;
  end;
  if not legacy_reallocation_blocked then
    raise exception 'A legacy v1 locked occurrence was reallocated under v2.';
  end if;

  -- A prior-Saturday open row may extend into Sunday. It stays visible with an
  -- empty allocation and blocks locking instead of disappearing.
  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values (
    incomplete_clock_in_id, incomplete_employee_id, incomplete_shift_id, 'clock_in',
    timestamptz '2098-01-26 05:00:00+00', 'web',
    'week-allocation-incomplete-clock-in', actor_employee_id
  );

  review_payload := public.get_timekeeping_review(date '2098-01-26', date '2098-02-01');
  select item.value into incomplete_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'shiftId' = incomplete_shift_id::text;

  if incomplete_row is null
    or incomplete_row ->> 'employeeId' <> incomplete_employee_id::text
    or coalesce((incomplete_row ->> 'payrollReady')::boolean, true)
    or (incomplete_row ->> 'paidMinutes')::integer <> 0
    or jsonb_array_length(incomplete_row -> 'payrollWeekAllocations') <> 0
    or coalesce(
      (review_payload -> 'reconciliation' ->> 'payrollWeekAllocationsReadyForLock')::boolean,
      true
    )
  then
    raise exception 'Prior-day incomplete occurrence disappeared or looked lockable: %', incomplete_row;
  end if;

  begin
    perform public.create_payroll_export_batch(
      date '2098-01-26', date '2098-02-01',
      'Rollback regression confirms incomplete context blocks locking.'
    );
  exception
    when check_violation then
      incomplete_lock_blocked := position('complete, clean, and ready' in sqlerrm) > 0;
  end;
  if not incomplete_lock_blocked then
    raise exception 'Prior-day incomplete occurrence did not block payroll locking.';
  end if;

  if (
    select export_row.row_payload
    from private.payroll_export_rows export_row
    where export_row.batch_id = (prior_batch ->> 'id')::uuid
      and export_row.row_payload ->> 'payrollOccurrenceKey' = boundary_occurrence_key
  ) is distinct from prior_locked_boundary_payload then
    raise exception 'The first locked boundary payload changed after later locks.';
  end if;

  if (select count(*) from public.shifts where id = boundary_shift_id) <> 1
    or (
      select count(*) from public.time_events
      where id in (
        boundary_clock_in_id, boundary_break_start_id,
        boundary_break_end_id, boundary_clock_out_id
      )
    ) <> 4
    or (
      select count(distinct event.occurrence_key)
      from private.get_effective_time_event_payroll_categories(worked_employee_id) event
      where event.id in (
        boundary_clock_in_id, boundary_break_start_id,
        boundary_break_end_id, boundary_clock_out_id
      )
    ) <> 1
  then
    raise exception 'Derived payroll allocation split or duplicated canonical shift/punch evidence.';
  end if;

  -- All rows that existed before this test retain byte-equivalent JSON state.
  select md5(coalesce(jsonb_agg(to_jsonb(batch) order by batch.id)::text, '[]'))
  into current_hash
  from private.payroll_export_batches batch
  where batch.id = any(existing_batch_ids);
  if current_hash <> existing_batch_hash then
    raise exception 'A pre-existing locked payroll batch changed.';
  end if;

  select md5(coalesce(jsonb_agg(to_jsonb(export_row) order by export_row.id)::text, '[]'))
  into current_hash
  from private.payroll_export_rows export_row
  where export_row.id = any(existing_export_row_ids);
  if current_hash <> existing_export_row_hash then
    raise exception 'A pre-existing locked payroll row changed.';
  end if;

  select md5(coalesce(jsonb_agg(to_jsonb(history) order by history.id)::text, '[]'))
  into current_hash
  from public.payroll_batch_assignment_history history
  where history.id = any(existing_history_ids);
  if current_hash <> existing_history_hash then
    raise exception 'Pre-existing payroll assignment audit history changed.';
  end if;

  if not exists (
    select 1
    from public.payroll_batch_assignment_history history
    where history.occurrence_key = corrected_occurrence_key
      and history.action = 'corrected'
      and history.assigned_week_start = date '2098-01-12'
  ) then
    raise exception 'Corrected-week override did not append audit history.';
  end if;

  if has_function_privilege('anon', 'private.get_payroll_boundary_minute_slices(jsonb,timestamptz,timestamptz)', 'EXECUTE')
    or has_function_privilege('authenticated', 'private.get_payroll_boundary_minute_slices(jsonb,timestamptz,timestamptz)', 'EXECUTE')
    or has_function_privilege('anon', 'private.validate_payroll_export_row_allocation_lock()', 'EXECUTE')
    or has_function_privilege('authenticated', 'private.validate_payroll_export_row_allocation_lock()', 'EXECUTE')
  then
    raise exception 'Private allocation helpers are executable through Data API roles.';
  end if;

  select pg_get_functiondef(
    'private.validate_payroll_export_row_category()'::regprocedure
  ) into function_sql;
  if position('target_occurrence_key text' in function_sql) = 0
    or position('event.occurrence_key = target_occurrence_key' in function_sql) = 0
  then
    raise exception 'The payroll category export trigger still has an ambiguous occurrence key.';
  end if;
end
$$;

rollback;

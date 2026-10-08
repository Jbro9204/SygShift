-- Run against a database with 20261006130458_event_payroll_classification.sql
-- and the current payroll-week allocation policy installed. All fixtures and
-- audit records are rolled back.

begin;

set local statement_timeout = '60s';

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  worked_employee_id uuid;
  salary_employee_id constant uuid := 'ed100000-0000-4000-8000-000000000003';
  enabled_site_id constant uuid := 'ed110000-0000-4000-8000-000000000001';
  ordinary_site_id constant uuid := 'ed110000-0000-4000-8000-000000000002';
  enabled_post_id constant uuid := 'ed120000-0000-4000-8000-000000000001';
  ordinary_post_id constant uuid := 'ed120000-0000-4000-8000-000000000002';
  source_schedule_id constant uuid := 'ed130000-0000-4000-8000-000000000001';
  revision_schedule_id constant uuid := 'ed130000-0000-4000-8000-000000000002';
  future_schedule_id constant uuid := 'ed130000-0000-4000-8000-000000000003';
  source_shift_id constant uuid := 'ed140000-0000-4000-8000-000000000001';
  regular_shift_id constant uuid := 'ed140000-0000-4000-8000-000000000002';
  copied_shift_id uuid;
  coverage_shift_id constant uuid := 'ed140000-0000-4000-8000-000000000003';
  boundary_shift_id constant uuid := 'ed140000-0000-4000-8000-000000000004';
  boundary_display_shift_id constant uuid := 'ed140000-0000-4000-8000-000000000005';
  clock_in_id constant uuid := 'ed150000-0000-4000-8000-000000000001';
  clock_out_id constant uuid := 'ed150000-0000-4000-8000-000000000002';
  boundary_clock_in_id constant uuid := 'ed150000-0000-4000-8000-000000000003';
  boundary_break_start_id constant uuid := 'ed150000-0000-4000-8000-000000000004';
  boundary_break_end_id constant uuid := 'ed150000-0000-4000-8000-000000000005';
  boundary_voided_event_id constant uuid := 'ed150000-0000-4000-8000-000000000006';
  boundary_clock_out_id constant uuid := 'ed150000-0000-4000-8000-000000000007';
  boundary_occurrence_key text;
  shift_map jsonb;
  time_map jsonb;
  correction_result jsonb;
  review_payload jsonb;
  reviewed_row jsonb;
  salary_row jsonb;
  function_sql text;
  published_reclassification_blocked boolean := false;
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'sites.manage' = any(private.employee_effective_permissions(employee.id))
    and 'schedule.manage' = any(private.employee_effective_permissions(employee.id))
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
    and 'time.export_payroll' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_user_id is null then
    raise exception 'An active MFA-capable sites/schedule/payroll manager is required for this rollback-only regression.';
  end if;

  select employee.id
  into worked_employee_id
  from public.employees employee
  where employee.status = 'active'
    and employee.employment_type in ('hourly', 'flex')
  order by employee.created_at, employee.id
  limit 1;

  if worked_employee_id is null then
    raise exception 'An active hourly or flex employee is required for this rollback-only regression.';
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

  insert into public.employees (
    id, username, first_name, last_name, role, employment_type, status, time_zone
  ) values (
    salary_employee_id, 'paycatsalary', 'Payroll', 'Salary', 'guard',
    'salary', 'active', 'America/Denver'
  );

  insert into public.sites (
    id, code, name, time_zone, active, supports_ep_truep_payroll
  ) values
    (enabled_site_id, 'PAYCAT-EP', 'Payroll Category Enabled', 'America/Denver', true, true),
    (ordinary_site_id, 'PAYCAT-REG', 'Payroll Category Ordinary', 'America/Denver', true, false);

  insert into public.posts (id, site_id, name, requires_armed, active)
  values
    (enabled_post_id, enabled_site_id, 'Enabled Post', false, true),
    (ordinary_post_id, ordinary_site_id, 'Ordinary Post', false, true);

  insert into public.schedules (
    id, week_starts_on, revision, status, created_by
  ) values
    (source_schedule_id, date '2098-01-05', 1, 'draft', actor_employee_id),
    (future_schedule_id, date '2098-01-12', 1, 'draft', actor_employee_id);

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, payroll_category, created_by
  ) values (
    source_shift_id,
    source_schedule_id,
    enabled_post_id,
    timestamptz '2098-01-06 16:00:00+00',
    timestamptz '2098-01-07 00:00:00+00',
    'America/Denver',
    1,
    'ep',
    actor_employee_id
  );

  -- Saturday night through Sunday morning crosses both midnight and the
  -- configured Sunday payroll-week boundary. A parallel EP shift is used as
  -- the audited display Site/Post override without changing occurrence owner.
  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, payroll_category, created_by
  ) values
    (
      boundary_shift_id,
      source_schedule_id,
      enabled_post_id,
      timestamptz '2098-01-12 06:00:00+00',
      timestamptz '2098-01-12 14:00:00+00',
      'America/Denver',
      1,
      'truep',
      actor_employee_id
    ),
    (
      boundary_display_shift_id,
      source_schedule_id,
      enabled_post_id,
      timestamptz '2098-01-12 06:00:00+00',
      timestamptz '2098-01-12 14:00:00+00',
      'America/Denver',
      1,
      'ep',
      actor_employee_id
    );

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, created_by
  ) values (
    regular_shift_id,
    source_schedule_id,
    ordinary_post_id,
    timestamptz '2098-01-07 16:00:00+00',
    timestamptz '2098-01-08 00:00:00+00',
    'America/Denver',
    1,
    actor_employee_id
  );

  if (select payroll_category from public.shifts where id = regular_shift_id) <> 'regular' then
    raise exception 'Ordinary shifts must default to Regular.';
  end if;

  begin
    insert into public.shifts (
      schedule_id, post_id, starts_at, ends_at, time_zone,
      headcount_required, payroll_category, created_by
    ) values (
      future_schedule_id,
      ordinary_post_id,
      timestamptz '2098-01-13 16:00:00+00',
      timestamptz '2098-01-14 00:00:00+00',
      'America/Denver',
      1,
      'truep',
      actor_employee_id
    );
    raise exception 'An ordinary site accepted TRUEP.';
  exception
    when check_violation then
      if position('only for a site' in sqlerrm) = 0 then raise; end if;
  end;

  -- A nine-argument named call represents an old cached client. It must not
  -- silently clear the newly enabled flag.
  perform public.upsert_site(
    target_site_id => enabled_site_id,
    target_code => 'PAYCAT-EP',
    target_name => 'Payroll Category Enabled',
    target_address_line_1 => null,
    target_city => null,
    target_region => null,
    target_postal_code => null,
    target_time_zone => 'America/Denver',
    target_active => true
  );

  if not (select supports_ep_truep_payroll from public.sites where id = enabled_site_id) then
    raise exception 'An old site client cleared supports_ep_truep_payroll.';
  end if;

  update public.sites
  set supports_ep_truep_payroll = false
  where id = enabled_site_id;

  -- Disabling a site cannot rewrite or freeze unrelated edits to historical
  -- classification.
  update public.shifts
  set notes = 'Still editable after the site flag is disabled.'
  where id = source_shift_id;

  if (select payroll_category from public.shifts where id = source_shift_id) <> 'ep' then
    raise exception 'Disabling a site rewrote historical payroll category.';
  end if;

  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = actor_employee_id
  where id = source_schedule_id;

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by
  ) values (
    boundary_shift_id, worked_employee_id, 'assigned', actor_employee_id
  );

  insert into public.schedules (
    id, week_starts_on, revision, status, previous_revision_id, created_by
  ) values (
    revision_schedule_id,
    date '2098-01-05',
    2,
    'draft',
    source_schedule_id,
    actor_employee_id
  );

  copied_shift_id := private.copy_schedule_shift_block(
    source_shift_id,
    revision_schedule_id,
    actor_employee_id
  );

  if copied_shift_id is null
    or (select payroll_category from public.shifts where id = copied_shift_id) <> 'ep'
  then
    raise exception 'Same-week revision cloning did not preserve EP.';
  end if;

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, coverage_source_shift_id, created_by
  ) values (
    coverage_shift_id,
    revision_schedule_id,
    enabled_post_id,
    timestamptz '2098-01-06 16:00:00+00',
    timestamptz '2098-01-07 00:00:00+00',
    'America/Denver',
    1,
    source_shift_id,
    actor_employee_id
  );

  if (select payroll_category from public.shifts where id = coverage_shift_id) <> 'ep' then
    raise exception 'Coverage did not inherit the source shift payroll category.';
  end if;

  begin
    insert into public.shifts (
      schedule_id, post_id, starts_at, ends_at, time_zone,
      headcount_required, payroll_category, created_by
    ) values (
      future_schedule_id,
      enabled_post_id,
      timestamptz '2098-01-13 16:00:00+00',
      timestamptz '2098-01-14 00:00:00+00',
      'America/Denver',
      1,
      'ep',
      actor_employee_id
    );
    raise exception 'A disabled EP site accepted a newly classified future shift.';
  exception
    when check_violation then
      if position('only for a site' in sqlerrm) = 0 then raise; end if;
  end;

  begin
    update public.shifts set payroll_category = 'truep' where id = source_shift_id;
  exception
    when check_violation or raise_exception then
      published_reclassification_blocked := true;
  end;

  if not published_reclassification_blocked then
    raise exception 'Published shift history was reclassified.';
  end if;

  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      clock_in_id, worked_employee_id, copied_shift_id, 'clock_in',
      timestamptz '2098-01-06 16:00:00+00', 'web',
      'paycat-regression-clock-in', actor_employee_id
    ),
    (
      clock_out_id, worked_employee_id, copied_shift_id, 'clock_out',
      timestamptz '2098-01-07 00:00:00+00', 'web',
      'paycat-regression-clock-out', actor_employee_id
    );

  if exists (
    select 1 from public.time_events
    where id in (clock_in_id, clock_out_id) and payroll_category <> 'ep'
  ) then
    raise exception 'Time events did not snapshot the shift payroll category.';
  end if;

  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source,
    idempotency_key, created_by
  ) values
    (
      boundary_clock_in_id, worked_employee_id, boundary_shift_id, 'clock_in',
      timestamptz '2098-01-12 06:00:00+00', 'web',
      'paycat-boundary-clock-in', actor_employee_id
    ),
    (
      boundary_break_start_id, worked_employee_id, regular_shift_id, 'break_start',
      timestamptz '2098-01-12 10:00:00+00', 'web',
      'paycat-boundary-break-start', actor_employee_id
    ),
    (
      boundary_break_end_id, worked_employee_id, regular_shift_id, 'break_end',
      timestamptz '2098-01-12 10:30:00+00', 'web',
      'paycat-boundary-break-end', actor_employee_id
    ),
    (
      boundary_voided_event_id, worked_employee_id, boundary_shift_id, 'break_start',
      timestamptz '2098-01-12 11:00:00+00', 'web',
      'paycat-boundary-voided', actor_employee_id
    ),
    (
      boundary_clock_out_id, worked_employee_id, null, 'clock_out',
      timestamptz '2098-01-12 14:00:00+00', 'web',
      'paycat-boundary-clock-out', actor_employee_id
    );

  insert into public.time_event_occurrence_overrides (
    time_event_id, original_shift_id, replacement_shift_id,
    reason, source, created_by
  ) values (
    boundary_break_start_id, regular_shift_id, boundary_shift_id,
    'Regression repair moves the break into the authoritative overnight occurrence.',
    'authorized_correction', actor_employee_id
  );

  insert into public.time_event_shift_overrides (
    time_event_id, shift_id, reason, created_by
  ) values
    (
      boundary_clock_in_id, boundary_display_shift_id,
      'Regression Site/Post override.', actor_employee_id
    ),
    (
      boundary_break_start_id, boundary_display_shift_id,
      'Regression Site/Post override.', actor_employee_id
    ),
    (
      boundary_break_end_id, boundary_display_shift_id,
      'Regression Site/Post override.', actor_employee_id
    ),
    (
      boundary_clock_out_id, boundary_display_shift_id,
      'Regression Site/Post override.', actor_employee_id
    );

  insert into public.time_event_payroll_category_corrections (
    time_event_id, payroll_category, reason, corrected_by
  ) values (
    boundary_voided_event_id, 'regular',
    'Regression fixture gives the voided punch a different category.',
    actor_employee_id
  );

  insert into public.time_event_corrections (
    time_event_id, voided, reason, requested_by, approved_by, approved_at
  ) values (
    boundary_voided_event_id, true,
    'Regression fixture voids a differently classified punch.',
    actor_employee_id, actor_employee_id, clock_timestamp()
  );

  select event.occurrence_key into boundary_occurrence_key
  from private.get_effective_time_event_payroll_categories(worked_employee_id) event
  where event.id = boundary_clock_in_id;

  if boundary_occurrence_key <>
    'shift:' || boundary_shift_id::text || ':employee:' || worked_employee_id::text
  then
    raise exception 'Canonical occurrence repair did not retain the overnight source shift: %',
      boundary_occurrence_key;
  end if;

  if exists (
    select 1
    from private.get_effective_time_event_payroll_categories(worked_employee_id) event
    where event.id in (
      boundary_clock_in_id, boundary_break_start_id,
      boundary_break_end_id, boundary_clock_out_id
    )
      and (
        event.occurrence_key <> boundary_occurrence_key
        or event.shift_id <> boundary_display_shift_id
        or event.payroll_category <> 'ep'
      )
  ) then
    raise exception 'Occurrence repair, session inheritance, or Site/Post override lost the effective EP category.';
  end if;

  if not exists (
    select 1
    from private.get_effective_time_event_payroll_categories(worked_employee_id) event
    where event.id = boundary_voided_event_id
      and event.voided
      and event.payroll_category = 'regular'
  ) then
    raise exception 'The voided differently classified punch fixture was not effective.';
  end if;

  time_map := public.get_time_payroll_category_map(date '2098-01-11', date '2098-01-11');
  if not exists (
    select 1
    from jsonb_array_elements(time_map) item(value)
    where item.value ->> 'payrollOccurrenceKey' = boundary_occurrence_key
      and item.value ->> 'operationalDate' = '2098-01-11'
      and item.value ->> 'shiftId' = boundary_display_shift_id::text
      and item.value ->> 'payrollCategory' = 'ep'
      and not coalesce((item.value ->> 'mixedPayrollCategories')::boolean, false)
      and jsonb_array_length(item.value -> 'eventIds') = 4
      and not ((item.value -> 'eventIds') @> jsonb_build_array(boundary_voided_event_id::text))
  ) then
    raise exception 'Overnight Saturday-to-Sunday occurrence was split, mixed, or included a voided punch: %', time_map;
  end if;

  review_payload := public.get_timekeeping_review(date '2098-01-11', date '2098-01-11');

  select item.value into salary_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = salary_employee_id::text
    and item.value ->> 'rowKind' = 'salary_default'
  limit 1;

  if salary_row is null
    or salary_row ->> 'payrollCategory' is not null
    or salary_row ->> 'payrollCategoryLabel' <> 'Not applicable'
    or coalesce((salary_row ->> 'regularCategoryMinutes')::integer, -1) <> 0
    or coalesce((salary_row ->> 'epMinutes')::integer, -1) <> 0
    or coalesce((salary_row ->> 'truepMinutes')::integer, -1) <> 0
    or coalesce((salary_row ->> 'unclassifiedCategoryMinutes')::integer, -1) <> 0
  then
    raise exception 'Salary defaults were incorrectly allocated to worked-time payroll categories: %',
      salary_row;
  end if;
  select item.value into reviewed_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = worked_employee_id::text
    and item.value ->> 'payrollOccurrenceKey' = boundary_occurrence_key
  limit 1;

  if reviewed_row is null
    or reviewed_row ->> 'shiftId' <> boundary_display_shift_id::text
    or reviewed_row ->> 'payrollCategory' <> 'ep'
    or coalesce((reviewed_row ->> 'epMinutes')::integer, 0)
      <> coalesce((reviewed_row ->> 'paidMinutes')::integer, 0)
    or jsonb_array_length(reviewed_row -> 'eventTimeline') <> 4
    or jsonb_array_length(reviewed_row -> 'payrollWeekAllocations') <> 1
    or reviewed_row -> 'payrollWeekAllocations' -> 0 ->> 'weekStartsOn' <> '2098-01-05'
    or coalesce((reviewed_row ->> 'paidMinutes')::integer, -1) <> 60
    or coalesce((reviewed_row ->> 'occurrencePaidMinutes')::integer, -1) <> 450
    or coalesce((reviewed_row ->> 'occurrenceEpMinutes')::integer, -1) <> 450
    or reviewed_row ->> 'payrollGroupingPolicy' <> 'elapsed_time_boundary_split'
    or reviewed_row ->> 'payrollBatchWeekStartsOn' <> '2098-01-05'
  then
    raise exception 'Canonical category or derived payroll-week allocation failed across the boundary: %', reviewed_row;
  end if;

  correction_result := public.correct_time_event_payroll_category(
    boundary_clock_in_id,
    'ep',
    'Regression verifies canonical occurrence-wide correction.'
  );

  if coalesce((correction_result ->> 'correctionCount')::integer, 0) <> 4
    or correction_result ->> 'payrollOccurrenceKey' <> boundary_occurrence_key
    or ((correction_result -> 'eventIds') @> jsonb_build_array(boundary_voided_event_id::text))
  then
    raise exception 'Canonical correction did not update exactly the four active occurrence punches: %',
      correction_result;
  end if;

  shift_map := public.get_shift_payroll_category_map(date '2098-01-05');
  if not exists (
    select 1
    from jsonb_array_elements(shift_map) item(value)
    where item.value ->> 'shiftId' = copied_shift_id::text
      and item.value ->> 'payrollCategory' = 'ep'
  ) then
    raise exception 'Shift payroll category map omitted the copied EP shift.';
  end if;

  time_map := public.get_time_payroll_category_map(date '2098-01-06', date '2098-01-07');
  if not exists (
    select 1
    from jsonb_array_elements(time_map) item(value)
    where item.value ->> 'employeeId' = worked_employee_id::text
      and item.value ->> 'shiftId' = copied_shift_id::text
      and item.value ->> 'payrollCategory' = 'ep'
      and not coalesce((item.value ->> 'mixedPayrollCategories')::boolean, false)
  ) then
    raise exception 'Worked-time payroll category map omitted the EP occurrence.';
  end if;

  review_payload := public.get_timekeeping_review(date '2098-01-06', date '2098-01-07');
  select item.value into reviewed_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = worked_employee_id::text
    and item.value ->> 'shiftId' = copied_shift_id::text
  limit 1;

  if reviewed_row is null
    or reviewed_row ->> 'payrollCategory' <> 'ep'
    or coalesce((reviewed_row ->> 'epMinutes')::integer, 0)
      <> coalesce((reviewed_row ->> 'paidMinutes')::integer, 0)
  then
    raise exception 'Server payroll review did not include reconciled EP minutes: %', reviewed_row;
  end if;

  insert into public.time_event_payroll_category_corrections (
    time_event_id, payroll_category, reason, corrected_by
  ) values (
    clock_out_id, 'regular', 'Regression fixture creates a mixed category.', actor_employee_id
  );

  review_payload := public.get_timekeeping_review(date '2098-01-06', date '2098-01-07');
  select item.value into reviewed_row
  from jsonb_array_elements(review_payload -> 'rows') item(value)
  where item.value ->> 'employeeId' = worked_employee_id::text
    and item.value ->> 'shiftId' = copied_shift_id::text
  limit 1;

  if reviewed_row is null
    or not coalesce((reviewed_row ->> 'mixedPayrollCategories')::boolean, false)
    or coalesce((reviewed_row ->> 'payrollReady')::boolean, true)
    or coalesce((reviewed_row ->> 'unclassifiedCategoryMinutes')::integer, 0)
      <> coalesce((reviewed_row ->> 'paidMinutes')::integer, 0)
    or coalesce((review_payload -> 'reconciliation' ->> 'passed')::boolean, true)
  then
    raise exception 'Mixed category did not block and reconcile as unclassified.';
  end if;

  time_map := public.get_time_payroll_category_map(date '2098-01-06', date '2098-01-07');
  if not exists (
    select 1
    from jsonb_array_elements(time_map) item(value)
    where item.value ->> 'employeeId' = worked_employee_id::text
      and item.value ->> 'shiftId' = copied_shift_id::text
      and coalesce((item.value ->> 'mixedPayrollCategories')::boolean, false)
      and item.value ->> 'payrollCategoryLabel' = 'Conflicting categories'
  ) then
    raise exception 'Mixed category map did not expose the conflict label.';
  end if;

  begin
    perform public.create_payroll_export_batch(
      date '2098-01-06', date '2098-01-07', 'Payroll category regression'
    );
    raise exception 'Mixed payroll categories were locked.';
  exception
    when check_violation then
      if position('mixed or unclassified payroll categories' in sqlerrm) = 0 then raise; end if;
  end;

  select pg_get_functiondef(
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)'::regprocedure
  ) into function_sql;

  if position('source_shift.payroll_category' in function_sql) = 0
    or position('copied_shift.payroll_category' in function_sql) = 0
    or position('site no longer permits' in function_sql) = 0
  then
    raise exception 'DST-safe future-week copy was not category-aware.';
  end if;

  select pg_get_functiondef('public.get_sites_payload()'::regprocedure)
  into function_sql;

  if position('sites.manage' in lower(function_sql)) = 0
    or position('sites.view' in lower(function_sql)) > 0
    or position('current_app_role' in lower(function_sql)) > 0
  then
    raise exception 'Site visibility no longer preserves the manage-only effective-permission contract.';
  end if;

  select pg_get_functiondef(
    'public.get_shift_payroll_category_map(date)'::regprocedure
  ) into function_sql;

  if position('scheduler.view' in lower(function_sql)) = 0
    or position('scheduler.manage' in lower(function_sql)) = 0
    or position('schedule.publish' in lower(function_sql)) = 0
    or position('schedule.delete_shift' in lower(function_sql)) = 0
    or position('schedule.override_warnings' in lower(function_sql)) = 0
    or position('assignment.canceled_at is null' in lower(function_sql)) = 0
  then
    raise exception 'Shift category-map authorization drifted from schedule assignment visibility.';
  end if;

  select pg_get_functiondef(
    'public.get_time_payroll_category_map(date,date)'::regprocedure
  ) into function_sql;

  if position('public.has_mfa()' in lower(function_sql)) = 0
    or position('time.resolve_exceptions' in lower(function_sql)) = 0
    or position('get_effective_time_event_payroll_categories' in lower(function_sql)) = 0
    or position('occurrence_key' in lower(function_sql)) = 0
    or position('event_ids' in lower(function_sql)) = 0
  then
    raise exception 'Time category-map authorization or canonical occurrence contract drifted.';
  end if;

  select pg_get_functiondef(
    'public.correct_time_event_payroll_category(uuid,text,text)'::regprocedure
  ) into function_sql;

  if position('lock_payroll_category_occurrence' in lower(function_sql)) = 0
    or position('payroll_assignment_is_locked' in lower(function_sql)) = 0
    or position('event.occurrence_key = target_state.occurrence_key' in lower(function_sql)) = 0
    or position('not event.voided' in lower(function_sql)) = 0
  then
    raise exception 'Payroll category correction lost canonical occurrence locking or its post-lock recheck.';
  end if;

  select pg_get_functiondef(
    'public.create_payroll_export_batch(date,date,text)'::regprocedure
  ) into function_sql;

  if position('lock_payroll_category_occurrence' in lower(function_sql)) = 0
    or position('review_payload := public.get_timekeeping_review' in lower(function_sql)) = 0
    or position('order by row_item.value ->> ''payrolloccurrencekey''' in lower(function_sql)) = 0
  then
    raise exception 'Payroll export lost deterministic shared occurrence locks or its locked re-review.';
  end if;

  select pg_get_functiondef(
    'private.validate_payroll_export_row_category()'::regprocedure
  ) into function_sql;

  if position('lock_payroll_category_occurrence' in lower(function_sql)) = 0
    or position('get_effective_time_event_payroll_categories' in lower(function_sql)) = 0
    or position('event.occurrence_key = target_occurrence_key' in lower(function_sql)) = 0
    or position('event.occurrence_key = occurrence_key' in lower(function_sql)) <> 0
    or position('not event.voided' in lower(function_sql)) = 0
  then
    raise exception 'Payroll row validation lost its shared lock or canonical post-lock category read.';
  end if;

  -- The helper is transaction-scoped and re-entrant for the same canonical
  -- occurrence. Correction, export, and row validation statically prove they
  -- call this exact boundary; this call proves the lock survives in this xact.
  perform private.lock_payroll_category_occurrence(boundary_occurrence_key);
  if not pg_try_advisory_xact_lock(
    hashtextextended('payroll-category-occurrence:' || boundary_occurrence_key, 0)
  ) then
    raise exception 'The shared occurrence advisory lock is not transaction re-entrant.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.get_shift_payroll_category_map(date)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.get_shift_payroll_category_map(date)',
    'execute'
  ) then
    raise exception 'Shift payroll-category map grants are incorrect.';
  end if;

  if has_table_privilege(
    'authenticated',
    'public.time_event_payroll_category_corrections',
    'insert'
  ) then
    raise exception 'Payroll-category correction table is directly writable.';
  end if;
end
$$;

rollback;

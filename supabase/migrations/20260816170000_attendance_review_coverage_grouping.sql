create or replace function private.get_attendance_reconciliation_group_snapshot(
  target_shift_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with anchor_shift as (
  select
    shift.id,
    shift.schedule_id,
    shift.post_id,
    shift.event_id,
    shift.starts_at,
    shift.ends_at,
    coalesce(shift.time_zone, 'America/Denver') as time_zone,
    shift.requires_armed
  from public.shifts shift
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  where shift.id = target_shift_id
    and shift.canceled_at is null
),
member_snapshots as (
  select
    member.id as shift_id,
    private.get_attendance_reconciliation_snapshot(member.id) as snapshot
  from public.shifts member
  cross join anchor_shift anchor
  where member.schedule_id = anchor.schedule_id
    and member.post_id is not distinct from anchor.post_id
    and member.event_id is not distinct from anchor.event_id
    and member.starts_at = anchor.starts_at
    and member.ends_at = anchor.ends_at
    and coalesce(member.time_zone, 'America/Denver') = anchor.time_zone
    and member.requires_armed = anchor.requires_armed
    and member.canceled_at is null
),
member_stats as (
  select
    count(*)::integer as member_count,
    (array_agg(member.shift_id order by member.shift_id))[1] as canonical_shift_id,
    coalesce(max((member.snapshot ->> 'headcountRequired')::integer), 0)::integer as maximum_headcount_required,
    jsonb_agg(member.shift_id order by member.shift_id) as member_shift_ids
  from member_snapshots member
),
seed as (
  select member.snapshot as value
  from member_snapshots member
  order by member.shift_id
  limit 1
),
scheduled_employee_rows as (
  select employee.value as employee
  from member_snapshots member
  cross join lateral jsonb_array_elements(coalesce(member.snapshot -> 'scheduledEmployees', '[]'::jsonb)) employee(value)
),
scheduled_employees as (
  select distinct on (employee ->> 'employeeId') employee
  from scheduled_employee_rows
  order by employee ->> 'employeeId', employee ->> 'employeeName'
),
scheduled_rollup as (
  select
    count(*)::integer as employee_count,
    coalesce(jsonb_agg(employee order by employee ->> 'employeeName', employee ->> 'employeeId'), '[]'::jsonb) as employees
  from scheduled_employees
),
actual_employee_rows as (
  select employee.value as employee
  from member_snapshots member
  cross join lateral jsonb_array_elements(coalesce(member.snapshot -> 'actualEmployees', '[]'::jsonb)) employee(value)
),
actual_employees as (
  select
    employee ->> 'employeeId' as employee_id,
    jsonb_build_object(
      'employeeId', employee ->> 'employeeId',
      'employeeName', max(employee ->> 'employeeName'),
      'username', max(employee ->> 'username'),
      'eventCount', sum((employee ->> 'eventCount')::integer)::integer,
      'segmentCount', sum((employee ->> 'segmentCount')::integer)::integer,
      'sequenceComplete', bool_and((employee ->> 'sequenceComplete')::boolean),
      'firstClockIn', min(nullif(employee ->> 'firstClockIn', '')::timestamptz),
      'lastClockOut', max(nullif(employee ->> 'lastClockOut', '')::timestamptz),
      'paidMinutes', sum((employee ->> 'paidMinutes')::integer)::integer,
      'breakMinutes', sum((employee ->> 'breakMinutes')::integer)::integer,
      'unpaidGapMinutes', sum((employee ->> 'unpaidGapMinutes')::integer)::integer,
      'eventTimeline', jsonb_path_query_array(jsonb_agg(coalesce(employee -> 'eventTimeline', '[]'::jsonb)), '$[*][*]'),
      'workedSegments', jsonb_path_query_array(jsonb_agg(coalesce(employee -> 'workedSegments', '[]'::jsonb)), '$[*][*]'),
      'unpaidGaps', jsonb_path_query_array(jsonb_agg(coalesce(employee -> 'unpaidGaps', '[]'::jsonb)), '$[*][*]')
    ) as employee
  from actual_employee_rows
  group by employee ->> 'employeeId'
),
actual_rollup as (
  select
    count(*)::integer as employee_count,
    coalesce(sum((employee ->> 'paidMinutes')::integer), 0)::integer as paid_minutes,
    coalesce(bool_and((employee ->> 'sequenceComplete')::boolean), false) as all_sequences_complete,
    coalesce(bool_or((employee ->> 'segmentCount')::integer > 1), false) as has_multiple_segments,
    coalesce(jsonb_agg(employee order by employee ->> 'employeeName', employee ->> 'employeeId'), '[]'::jsonb) as employees
  from actual_employees
),
call_off_rows as (
  select call_off.value as call_off
  from member_snapshots member
  cross join lateral jsonb_array_elements(coalesce(member.snapshot -> 'callOffs', '[]'::jsonb)) call_off(value)
),
call_offs as (
  select distinct on (call_off ->> 'id') call_off
  from call_off_rows
  order by call_off ->> 'id', call_off ->> 'reportedAt'
),
call_off_rollup as (
  select
    count(*)::integer as event_count,
    coalesce(jsonb_agg(call_off order by call_off ->> 'reportedAt', call_off ->> 'id'), '[]'::jsonb) as events
  from call_offs
),
comparison as (
  select
    seed.value,
    member_stats.member_count,
    member_stats.canonical_shift_id,
    member_stats.member_shift_ids,
    greatest(member_stats.maximum_headcount_required, scheduled_rollup.employee_count) as headcount_required,
    (
      (seed.value ->> 'scheduledMinutesPerPosition')::integer
      * greatest(member_stats.maximum_headcount_required, scheduled_rollup.employee_count)
    )::integer as scheduled_coverage_minutes,
    scheduled_rollup.employee_count as scheduled_employee_count,
    scheduled_rollup.employees as scheduled_employees,
    actual_rollup.employee_count as actual_employee_count,
    actual_rollup.paid_minutes as actual_paid_minutes,
    actual_rollup.all_sequences_complete,
    actual_rollup.has_multiple_segments,
    actual_rollup.employees as actual_employees,
    call_off_rollup.event_count as call_off_count,
    call_off_rollup.events as call_offs,
    actual_rollup.paid_minutes - (
      (seed.value ->> 'scheduledMinutesPerPosition')::integer
      * greatest(member_stats.maximum_headcount_required, scheduled_rollup.employee_count)
    ) as variance_minutes,
    (
      select count(*)::integer
      from scheduled_employees scheduled
      where not exists (
        select 1
        from actual_employees actual
        where actual.employee_id = scheduled.employee ->> 'employeeId'
      )
    ) as scheduled_missing_count,
    (
      select count(*)::integer
      from actual_employees actual
      where not exists (
        select 1
        from scheduled_employees scheduled
        where scheduled.employee ->> 'employeeId' = actual.employee_id
      )
    ) as unexpected_actual_count
  from seed
  cross join member_stats
  cross join scheduled_rollup
  cross join actual_rollup
  cross join call_off_rollup
),
classified as (
  select
    comparison.*,
    array_remove(array[
      case when comparison.call_off_count > 0 then 'call_off_reported' end,
      case when comparison.scheduled_employee_count < comparison.headcount_required then 'planned_understaffing' end,
      case when comparison.actual_employee_count < comparison.headcount_required then 'understaffed_or_uncovered' end,
      case when comparison.actual_employee_count = 0 then 'missing_recorded_time' end,
      case when comparison.scheduled_missing_count > 0 then 'scheduled_employee_missing' end,
      case when comparison.unexpected_actual_count > 0 then 'replacement_or_unplanned_worker' end,
      case when comparison.actual_employee_count > 0 and not comparison.all_sequences_complete then 'incomplete_punch_sequence' end,
      case when comparison.has_multiple_segments then 'multiple_work_segments' end,
      case when abs(comparison.variance_minutes) > 15 then 'worked_time_variance' end
    ]::text[], null) as discrepancy_codes
  from comparison
),
group_snapshot as (
  select jsonb_build_object(
    'shiftId', classified.canonical_shift_id,
    'scheduleId', classified.value ->> 'scheduleId',
    'operationalDate', classified.value ->> 'operationalDate',
    'startsAt', classified.value ->> 'startsAt',
    'endsAt', classified.value ->> 'endsAt',
    'timeZone', classified.value ->> 'timeZone',
    'headcountRequired', classified.headcount_required,
    'requiresArmed', (classified.value ->> 'requiresArmed')::boolean,
    'scheduledMinutesPerPosition', (classified.value ->> 'scheduledMinutesPerPosition')::integer,
    'scheduledCoverageMinutes', classified.scheduled_coverage_minutes,
    'actualPaidMinutes', classified.actual_paid_minutes,
    'varianceMinutes', classified.variance_minutes,
    'scheduledEmployeeCount', classified.scheduled_employee_count,
    'actualEmployeeCount', classified.actual_employee_count,
    'scheduledMissingCount', classified.scheduled_missing_count,
    'unexpectedActualCount', classified.unexpected_actual_count,
    'siteId', classified.value -> 'siteId',
    'siteCode', classified.value -> 'siteCode',
    'siteName', classified.value -> 'siteName',
    'postId', classified.value -> 'postId',
    'postName', classified.value -> 'postName',
    'eventId', classified.value -> 'eventId',
    'eventName', classified.value -> 'eventName',
    'locationName', classified.value ->> 'locationName',
    'scheduledEmployees', classified.scheduled_employees,
    'actualEmployees', classified.actual_employees,
    'callOffs', classified.call_offs,
    'discrepancyCodes', to_jsonb(classified.discrepancy_codes),
    'requiresTimeCorrection', classified.actual_employee_count > 0 and not classified.all_sequences_complete,
    'coverageGroupSize', classified.member_count,
    'memberShiftIds', classified.member_shift_ids
  ) as value
  from classified
),
result as (
  select
    case
      when member_stats.member_count = 1 then seed.value
      else group_snapshot.value || jsonb_build_object(
        'occurrenceFingerprint', encode(
          extensions.digest(convert_to(group_snapshot.value::text, 'UTF8'), 'sha256'),
          'hex'
        )
      )
    end as value
  from member_stats
  cross join seed
  cross join group_snapshot
)
select result.value
from result
$$;

create or replace function public.get_daily_attendance_review(
  target_from_date date,
  target_through_date date,
  target_include_resolved boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  server_now timestamptz := clock_timestamp();
  rows_payload jsonb := '[]'::jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() or not (
    public.has_effective_permission('accountability.view')
    or public.has_effective_permission('accountability.manage')
    or public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
    or public.has_effective_permission('time.resolve_exceptions')
  ) then
    raise insufficient_privilege using message = 'Attendance review permission with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'Choose a valid attendance review date range.';
  end if;

  if target_through_date - target_from_date > 31 then
    raise check_violation using message = 'Attendance review is limited to 32 days at a time.';
  end if;

  with canonical_shifts as (
    select shift.*
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where schedule.status = 'published'
      and shift.canceled_at is null
      and (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date between target_from_date and target_through_date
      and shift.ends_at + interval '2 hours' <= server_now
      and shift.id = (
        select member.id
        from public.shifts member
        where member.schedule_id = shift.schedule_id
          and member.post_id is not distinct from shift.post_id
          and member.event_id is not distinct from shift.event_id
          and member.starts_at = shift.starts_at
          and member.ends_at = shift.ends_at
          and coalesce(member.time_zone, 'America/Denver') = coalesce(shift.time_zone, 'America/Denver')
          and member.requires_armed = shift.requires_armed
          and member.canceled_at is null
        order by member.id
        limit 1
      )
  ),
  review_rows as (
    select
      snapshot.value,
      latest_decision.id as resolution_id,
      latest_decision.action as resolution_action,
      latest_decision.client_credit_status,
      latest_decision.reason as resolution_reason,
      latest_decision.resolved_by,
      resolver_name.display_name as resolved_by_name,
      latest_decision.resolved_at,
      latest_decision.id is not null and latest_decision.action <> 'reopened' as resolved
    from canonical_shifts shift
    cross join lateral (
      select private.get_attendance_reconciliation_group_snapshot(shift.id) as value
    ) snapshot
    left join lateral (
      select decision.*
      from public.attendance_reconciliation_decisions decision
      where decision.shift_id = shift.id
        and decision.occurrence_fingerprint = snapshot.value ->> 'occurrenceFingerprint'
      order by decision.resolved_at desc, decision.id desc
      limit 1
    ) latest_decision on true
    left join lateral (
      select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as display_name
      from public.employees employee
      where employee.id = latest_decision.resolved_by
    ) resolver_name on true
    where jsonb_array_length(coalesce(snapshot.value -> 'discrepancyCodes', '[]'::jsonb)) > 0
  )
  select coalesce(jsonb_agg(
    review.value || jsonb_build_object(
      'reviewStatus', case when review.resolved then review.resolution_action else 'unresolved' end,
      'resolution', case when review.resolution_id is null then null else jsonb_build_object(
        'id', review.resolution_id,
        'action', review.resolution_action,
        'clientCreditStatus', review.client_credit_status,
        'reason', review.resolution_reason,
        'resolvedBy', review.resolved_by,
        'resolvedByName', review.resolved_by_name,
        'resolvedAt', review.resolved_at
      ) end
    )
    order by review.value ->> 'operationalDate' desc, review.value ->> 'startsAt' desc, review.value ->> 'locationName'
  ) filter (where target_include_resolved or not review.resolved), '[]'::jsonb)
  into rows_payload
  from review_rows review;

  return jsonb_build_object(
    'serverTimestamp', server_now,
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', 'America/Denver',
    'graceMinutes', 120,
    'rows', rows_payload,
    'summary', jsonb_build_object(
      'total', jsonb_array_length(rows_payload),
      'unresolved', (
        select count(*)
        from jsonb_array_elements(rows_payload) row_value
        where row_value ->> 'reviewStatus' = 'unresolved'
      ),
      'resolved', (
        select count(*)
        from jsonb_array_elements(rows_payload) row_value
        where row_value ->> 'reviewStatus' <> 'unresolved'
      )
    )
  );
end
$$;

create or replace function public.resolve_daily_attendance_review(
  target_shift_id uuid,
  target_occurrence_fingerprint text,
  target_action text,
  target_client_credit_status text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_action text := lower(btrim(coalesce(target_action, '')));
  clean_credit_status text := lower(btrim(coalesce(target_client_credit_status, 'not_required')));
  clean_reason text := btrim(coalesce(target_reason, ''));
  current_snapshot jsonb;
  latest_action text;
  inserted_decision public.attendance_reconciliation_decisions%rowtype;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() or not (
    public.has_effective_permission('accountability.manage')
    or public.has_effective_permission('time.manage')
  ) then
    raise insufficient_privilege using message = 'Attendance review management permission with MFA is required.';
  end if;

  if clean_action not in (
    'confirmed_replacement',
    'confirmed_call_off',
    'confirmed_uncovered',
    'approved_variance',
    'dismissed_false_positive',
    'reopened'
  ) then
    raise check_violation using message = 'Choose a supported attendance review decision.';
  end if;

  if clean_credit_status not in ('not_required', 'review_required', 'approved_credit', 'no_credit') then
    raise check_violation using message = 'Choose a supported client-credit status.';
  end if;

  if clean_action = 'confirmed_uncovered' and clean_credit_status = 'not_required' then
    raise check_violation using message = 'Uncovered work requires a client-credit review decision.';
  end if;

  if char_length(clean_reason) < 8 then
    raise check_violation using message = 'Enter a clear reason of at least 8 characters.';
  end if;

  if target_occurrence_fingerprint is null or target_occurrence_fingerprint !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The attendance review occurrence is invalid. Reload and try again.';
  end if;

  perform pg_advisory_xact_lock(hashtext('attendance-review:' || target_shift_id::text));

  current_snapshot := private.get_attendance_reconciliation_group_snapshot(target_shift_id);

  if current_snapshot is not null
    and (current_snapshot ->> 'shiftId')::uuid <> target_shift_id
  then
    raise check_violation using message = 'This coverage occurrence changed. Reload before deciding.';
  end if;

  if current_snapshot is not null
    and (current_snapshot ->> 'endsAt')::timestamptz + interval '2 hours' > clock_timestamp()
  then
    raise check_violation using message = 'Attendance review decisions are available two hours after the shift ends.';
  end if;

  if current_snapshot is null
    or jsonb_array_length(coalesce(current_snapshot -> 'discrepancyCodes', '[]'::jsonb)) = 0
  then
    raise no_data_found using message = 'This coverage occurrence no longer requires attendance review. Reload the page.';
  end if;

  if current_snapshot ->> 'occurrenceFingerprint' <> target_occurrence_fingerprint then
    raise check_violation using message = 'The schedule, punches, or call-off record changed after this review opened. Reload before deciding.';
  end if;

  select decision.action
  into latest_action
  from public.attendance_reconciliation_decisions decision
  where decision.shift_id = target_shift_id
    and decision.occurrence_fingerprint = target_occurrence_fingerprint
  order by decision.resolved_at desc, decision.id desc
  limit 1;

  if clean_action = 'reopened' then
    if latest_action is null or latest_action = 'reopened' then
      raise check_violation using message = 'This attendance review is already unresolved.';
    end if;
    clean_credit_status := 'not_required';
  elsif latest_action is not null and latest_action <> 'reopened' then
    raise check_violation using message = 'Reopen the prior decision before recording a different outcome.';
  end if;

  insert into public.attendance_reconciliation_decisions (
    shift_id,
    operational_date,
    occurrence_fingerprint,
    action,
    client_credit_status,
    reason,
    occurrence_snapshot,
    resolved_by
  ) values (
    target_shift_id,
    (current_snapshot ->> 'operationalDate')::date,
    target_occurrence_fingerprint,
    clean_action,
    clean_credit_status,
    clean_reason,
    current_snapshot,
    actor_id
  )
  returning * into inserted_decision;

  return jsonb_build_object(
    'id', inserted_decision.id,
    'shiftId', inserted_decision.shift_id,
    'operationalDate', inserted_decision.operational_date,
    'occurrenceFingerprint', inserted_decision.occurrence_fingerprint,
    'action', inserted_decision.action,
    'clientCreditStatus', inserted_decision.client_credit_status,
    'reason', inserted_decision.reason,
    'resolvedBy', inserted_decision.resolved_by,
    'resolvedAt', inserted_decision.resolved_at
  );
end
$$;

comment on function private.get_attendance_reconciliation_group_snapshot(uuid) is
  'Combines identical published coverage slots into one attendance-review occurrence while retaining each scheduled employee and worked segment.';

comment on function public.get_daily_attendance_review(date, date, boolean) is
  'Returns ended published coverage occurrences grouped by schedule, location, date, time, time zone, and armed requirement for schedule-versus-worked review.';

comment on function public.resolve_daily_attendance_review(uuid, text, text, text, text) is
  'Records an audited decision for one consolidated coverage occurrence without modifying the published schedule or original punches.';

revoke all on function private.get_attendance_reconciliation_group_snapshot(uuid) from public, anon, authenticated;
grant execute on function private.get_attendance_reconciliation_group_snapshot(uuid) to service_role;

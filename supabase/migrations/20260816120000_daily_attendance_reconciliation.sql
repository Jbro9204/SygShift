begin;

create table public.attendance_reconciliation_decisions (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts(id) on delete restrict,
  operational_date date not null,
  occurrence_fingerprint text not null,
  action text not null,
  client_credit_status text not null default 'not_required',
  reason text not null,
  occurrence_snapshot jsonb not null,
  resolved_by uuid not null references public.employees(id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp(),
  constraint attendance_reconciliation_fingerprint_format
    check (occurrence_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint attendance_reconciliation_action_check
    check (action in (
      'confirmed_replacement',
      'confirmed_call_off',
      'confirmed_uncovered',
      'approved_variance',
      'dismissed_false_positive',
      'reopened'
    )),
  constraint attendance_reconciliation_credit_status_check
    check (client_credit_status in ('not_required', 'review_required', 'approved_credit', 'no_credit')),
  constraint attendance_reconciliation_reason_present
    check (char_length(btrim(reason)) between 8 and 1000),
  constraint attendance_reconciliation_snapshot_object
    check (jsonb_typeof(occurrence_snapshot) = 'object')
);

create index attendance_reconciliation_occurrence_idx
  on public.attendance_reconciliation_decisions (
    shift_id,
    occurrence_fingerprint,
    resolved_at desc,
    id desc
  );

create index attendance_reconciliation_date_idx
  on public.attendance_reconciliation_decisions (
    operational_date desc,
    resolved_at desc
  );

alter table public.attendance_reconciliation_decisions enable row level security;

create trigger attendance_reconciliation_decisions_audit
after insert on public.attendance_reconciliation_decisions
for each row execute function private.write_audit_event();

create trigger attendance_reconciliation_decisions_append_only
before update or delete on public.attendance_reconciliation_decisions
for each row execute function private.prevent_append_only_change();

revoke all on table public.attendance_reconciliation_decisions from public, anon, authenticated;

create or replace function private.get_attendance_reconciliation_snapshot(
  target_shift_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with shift_record as (
  select
    shift.id,
    shift.schedule_id,
    shift.starts_at,
    shift.ends_at,
    coalesce(shift.time_zone, 'America/Denver') as time_zone,
    shift.headcount_required,
    shift.requires_armed,
    (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date as operational_date,
    greatest(0, floor(extract(epoch from (shift.ends_at - shift.starts_at)) / 60)::integer) as scheduled_minutes_per_position,
    site.id as site_id,
    site.code as site_code,
    site.name as site_name,
    post.id as post_id,
    post.name as post_name,
    schedule_event.id as event_id,
    schedule_event.name as event_name,
    coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Scheduled location') as location_name
  from public.shifts shift
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events schedule_event on schedule_event.id = shift.event_id
  where shift.id = target_shift_id
    and shift.canceled_at is null
),
scheduled_employee_rows as (
  select
    assignment.employee_id,
    assignment.status,
    btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
    employee.username
  from public.shift_assignments assignment
  join public.employees employee on employee.id = assignment.employee_id
  where assignment.shift_id = target_shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
),
scheduled_rollup as (
  select
    count(*)::integer as employee_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'employeeId', employee_id,
      'employeeName', employee_name,
      'username', username,
      'assignmentStatus', status
    ) order by employee_name, employee_id), '[]'::jsonb) as employees
  from scheduled_employee_rows
),
latest_correction as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_time,
    correction.voided
  from public.time_event_corrections correction
  where correction.approved_at is not null
  order by correction.time_event_id, correction.approved_at desc, correction.id desc
),
latest_shift_override as (
  select distinct on (shift_override.time_event_id)
    shift_override.time_event_id,
    shift_override.shift_id
  from public.time_event_shift_overrides shift_override
  order by shift_override.time_event_id, shift_override.created_at desc, shift_override.id desc
),
effective_events as (
  select
    time_event.id,
    time_event.employee_id,
    coalesce(latest_shift_override.shift_id, time_event.shift_id) as shift_id,
    time_event.kind,
    time_event.recorded_at,
    coalesce(latest_correction.replacement_time, time_event.recorded_at) as effective_at,
    coalesce(latest_correction.voided, false) as voided
  from public.time_events time_event
  left join latest_correction on latest_correction.time_event_id = time_event.id
  left join latest_shift_override on latest_shift_override.time_event_id = time_event.id
),
actual_employee_ids as (
  select distinct event.employee_id
  from effective_events event
  where event.shift_id = target_shift_id
    and not event.voided
),
actual_employee_contexts as (
  select
    employee.id as employee_id,
    btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
    employee.username,
    private.get_timekeeping_occurrence_context(
      employee.id,
      target_shift_id,
      shift_record.operational_date
    ) as context
  from actual_employee_ids actual_employee
  join public.employees employee on employee.id = actual_employee.employee_id
  cross join shift_record
),
actual_rollup as (
  select
    count(*)::integer as employee_count,
    coalesce(sum((context ->> 'paidMinutes')::integer), 0)::integer as paid_minutes,
    coalesce(bool_and((context ->> 'sequenceComplete')::boolean), false) as all_sequences_complete,
    coalesce(bool_or((context ->> 'segmentCount')::integer > 1), false) as has_multiple_segments,
    coalesce(jsonb_agg(jsonb_build_object(
      'employeeId', employee_id,
      'employeeName', employee_name,
      'username', username,
      'eventCount', (context ->> 'eventCount')::integer,
      'segmentCount', (context ->> 'segmentCount')::integer,
      'sequenceComplete', (context ->> 'sequenceComplete')::boolean,
      'firstClockIn', context ->> 'firstClockIn',
      'lastClockOut', context ->> 'lastClockOut',
      'paidMinutes', (context ->> 'paidMinutes')::integer,
      'breakMinutes', (context ->> 'breakMinutes')::integer,
      'unpaidGapMinutes', (context ->> 'unpaidGapMinutes')::integer,
      'eventTimeline', coalesce(context -> 'events', '[]'::jsonb),
      'workedSegments', coalesce(context -> 'segments', '[]'::jsonb),
      'unpaidGaps', coalesce(context -> 'unpaidGaps', '[]'::jsonb)
    ) order by employee_name, employee_id), '[]'::jsonb) as employees
  from actual_employee_contexts
),
call_off_source as (
  select
    attendance.id,
    attendance.employee_id,
    attendance.event_type,
    attendance.status,
    attendance.note,
    attendance.created_at as reported_at
  from public.attendance_accountability_events attendance
  where attendance.shift_id = target_shift_id
    and attendance.event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
    and attendance.status <> 'voided'

  union all

  select
    call_off.id,
    call_off.employee_id,
    'call_off'::text as event_type,
    case when call_off.acknowledged_at is null then 'reported' else 'acknowledged' end as status,
    coalesce(nullif(btrim(call_off.reason), ''), 'Call-off reported.') as note,
    call_off.reported_at
  from public.call_off_reports call_off
  where call_off.shift_id = target_shift_id
    and not exists (
      select 1
      from public.attendance_accountability_events attendance
      where attendance.call_off_report_id = call_off.id
    )
),
call_off_rollup as (
  select
    count(*)::integer as event_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', call_off.id,
      'employeeId', call_off.employee_id,
      'employeeName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
      'eventType', call_off.event_type,
      'status', call_off.status,
      'note', call_off.note,
      'reportedAt', call_off.reported_at
    ) order by call_off.reported_at, call_off.id), '[]'::jsonb) as events
  from call_off_source call_off
  join public.employees employee on employee.id = call_off.employee_id
),
comparison as (
  select
    shift_record.*,
    scheduled_rollup.employee_count as scheduled_employee_count,
    scheduled_rollup.employees as scheduled_employees,
    actual_rollup.employee_count as actual_employee_count,
    actual_rollup.paid_minutes as actual_paid_minutes,
    actual_rollup.all_sequences_complete,
    actual_rollup.has_multiple_segments,
    actual_rollup.employees as actual_employees,
    call_off_rollup.event_count as call_off_count,
    call_off_rollup.events as call_offs,
    (shift_record.scheduled_minutes_per_position * shift_record.headcount_required)::integer as scheduled_coverage_minutes,
    actual_rollup.paid_minutes - (shift_record.scheduled_minutes_per_position * shift_record.headcount_required) as variance_minutes,
    (
      select count(*)::integer
      from scheduled_employee_rows scheduled_employee
      where not exists (
        select 1 from actual_employee_ids actual_employee
        where actual_employee.employee_id = scheduled_employee.employee_id
      )
    ) as scheduled_missing_count,
    (
      select count(*)::integer
      from actual_employee_ids actual_employee
      where not exists (
        select 1 from scheduled_employee_rows scheduled_employee
        where scheduled_employee.employee_id = actual_employee.employee_id
      )
    ) as unexpected_actual_count
  from shift_record
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
snapshot as (
  select jsonb_build_object(
    'shiftId', classified.id,
    'scheduleId', classified.schedule_id,
    'operationalDate', classified.operational_date,
    'startsAt', classified.starts_at,
    'endsAt', classified.ends_at,
    'timeZone', classified.time_zone,
    'headcountRequired', classified.headcount_required,
    'requiresArmed', classified.requires_armed,
    'scheduledMinutesPerPosition', classified.scheduled_minutes_per_position,
    'scheduledCoverageMinutes', classified.scheduled_coverage_minutes,
    'actualPaidMinutes', classified.actual_paid_minutes,
    'varianceMinutes', classified.variance_minutes,
    'scheduledEmployeeCount', classified.scheduled_employee_count,
    'actualEmployeeCount', classified.actual_employee_count,
    'scheduledMissingCount', classified.scheduled_missing_count,
    'unexpectedActualCount', classified.unexpected_actual_count,
    'siteId', classified.site_id,
    'siteCode', classified.site_code,
    'siteName', classified.site_name,
    'postId', classified.post_id,
    'postName', classified.post_name,
    'eventId', classified.event_id,
    'eventName', classified.event_name,
    'locationName', classified.location_name,
    'scheduledEmployees', classified.scheduled_employees,
    'actualEmployees', classified.actual_employees,
    'callOffs', classified.call_offs,
    'discrepancyCodes', to_jsonb(classified.discrepancy_codes),
    'requiresTimeCorrection', classified.actual_employee_count > 0 and not classified.all_sequences_complete
  ) as value
  from classified
)
select snapshot.value || jsonb_build_object(
  'occurrenceFingerprint', encode(
    extensions.digest(convert_to(snapshot.value::text, 'UTF8'), 'sha256'),
    'hex'
  )
)
from snapshot
$$;

create function public.get_daily_attendance_review(
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

  with review_rows as (
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
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    cross join lateral (
      select private.get_attendance_reconciliation_snapshot(shift.id) as value
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
    where schedule.status = 'published'
      and shift.canceled_at is null
      and (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date between target_from_date and target_through_date
      and shift.ends_at + interval '2 hours' <= server_now
      and jsonb_array_length(coalesce(snapshot.value -> 'discrepancyCodes', '[]'::jsonb)) > 0
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

create function public.resolve_daily_attendance_review(
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

  current_snapshot := private.get_attendance_reconciliation_snapshot(target_shift_id);

  if current_snapshot is not null
    and (current_snapshot ->> 'endsAt')::timestamptz + interval '2 hours' > clock_timestamp()
  then
    raise check_violation using message = 'Attendance review decisions are available two hours after the shift ends.';
  end if;

  if current_snapshot is null
    or jsonb_array_length(coalesce(current_snapshot -> 'discrepancyCodes', '[]'::jsonb)) = 0
  then
    raise no_data_found using message = 'This shift no longer requires attendance review. Reload the page.';
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

comment on table public.attendance_reconciliation_decisions is
  'Append-only human decisions for post-shift schedule, punch, and call-off discrepancies.';

comment on function public.get_daily_attendance_review(date, date, boolean) is
  'Returns ended published shifts with schedule-versus-actual discrepancies after a two-hour grace period.';

comment on function public.resolve_daily_attendance_review(uuid, text, text, text, text) is
  'Records an audited occurrence-specific attendance decision without modifying the published schedule or original punches.';

revoke all on function private.get_attendance_reconciliation_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.get_daily_attendance_review(date, date, boolean) from public, anon;
revoke all on function public.resolve_daily_attendance_review(uuid, text, text, text, text) from public, anon;

grant execute on function public.get_daily_attendance_review(date, date, boolean) to authenticated;
grant execute on function public.resolve_daily_attendance_review(uuid, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;

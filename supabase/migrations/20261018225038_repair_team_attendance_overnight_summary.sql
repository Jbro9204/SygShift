begin;

-- Team Attendance is an operational-workday view. Scope the complete
-- occurrence by its assignment anchor before rolling up punches so an
-- overnight clock-out on the following calendar date remains attached to the
-- workday on which the occurrence started. The payroll allocation layer keeps
-- its separate Sunday-midnight clipping policy.
create or replace function public.get_team_attendance_summary(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  operational_time_zone text := 'America/Denver';
  rows_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Team Attendance permission with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Team Attendance ranges are limited to 46 days.';
  end if;

  with effective_events as materialized (
    select event.*
    from private.get_effective_time_events_with_occurrence(null) event
    where not event.voided
  ),
  range_events as materialized (
    select event.*
    from effective_events event
    where (event.assignment_anchor at time zone operational_time_zone)::date
      between target_from_date and target_through_date
  ),
  latest_event as (
    select distinct on (time_event.employee_id)
      time_event.employee_id,
      time_event.kind as latest_kind,
      time_event.effective_at as latest_effective_at,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled') as latest_location_name,
      site.name as latest_site_name,
      site.code as latest_site_code,
      post.name as latest_post_name,
      schedule_event.name as latest_event_name,
      coalesce(shift.time_zone, operational_time_zone) as latest_time_zone
    from range_events time_event
    left join public.shifts shift on shift.id = time_event.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    order by time_event.employee_id, time_event.effective_at desc, time_event.recorded_at desc, time_event.id desc
  ),
  event_rollup as (
    select
      time_event.employee_id,
      min(time_event.effective_at) filter (where time_event.kind = 'clock_in') as first_clock_in,
      max(time_event.effective_at) filter (where time_event.kind = 'clock_out') as last_clock_out,
      count(*)::integer as event_count
    from range_events time_event
    group by time_event.employee_id
  ),
  scheduled_rows as (
    select
      assignment.employee_id,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, operational_time_zone) as time_zone,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Scheduled location') as location_name,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      schedule_event.name as event_name
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where assignment.status in ('assigned', 'confirmed', 'completed')
      and schedule.status = 'published'
      and not exists (
        select 1
        from public.schedules newer_schedule
        where newer_schedule.week_starts_on = schedule.week_starts_on
          and newer_schedule.status = 'published'
          and newer_schedule.revision > schedule.revision
      )
      and shift.canceled_at is null
      and (shift.starts_at at time zone coalesce(shift.time_zone, operational_time_zone))::date
        between target_from_date and target_through_date
  ),
  scheduled_count as (
    select
      scheduled_rows.employee_id,
      count(distinct scheduled_rows.shift_id)::integer as scheduled_shift_count,
      coalesce(sum(greatest(0, extract(epoch from (scheduled_rows.ends_at - scheduled_rows.starts_at)) / 60)), 0)::integer as scheduled_minutes
    from scheduled_rows
    group by scheduled_rows.employee_id
  ),
  scheduled_first as (
    select distinct on (scheduled_rows.employee_id)
      scheduled_rows.employee_id,
      scheduled_rows.starts_at as scheduled_starts_at,
      scheduled_rows.ends_at as scheduled_ends_at,
      scheduled_rows.location_name as scheduled_location_name,
      scheduled_rows.site_name as scheduled_site_name,
      scheduled_rows.site_code as scheduled_site_code,
      scheduled_rows.post_name as scheduled_post_name,
      scheduled_rows.event_name as scheduled_event_name,
      scheduled_rows.time_zone as scheduled_time_zone
    from scheduled_rows
    order by scheduled_rows.employee_id, scheduled_rows.starts_at, scheduled_rows.shift_id
  ),
  pending_correction_scope as (
    select distinct event.employee_id
    from public.time_event_corrections correction
    join effective_events event on event.id = correction.time_event_id
    where correction.approved_at is null
      and correction.declined_at is null
      and (event.assignment_anchor at time zone operational_time_zone)::date
        between target_from_date and target_through_date
  ),
  employees_in_scope as (
    select employee_id from event_rollup
    union
    select employee_id from scheduled_count
    union
    select employee_id from pending_correction_scope
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', employee.id,
    'username', employee.username,
    'employeeName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'latestKind', latest_event.latest_kind,
    'latestEffectiveAt', latest_event.latest_effective_at,
    'latestLocationName', latest_event.latest_location_name,
    'latestSiteName', latest_event.latest_site_name,
    'latestSiteCode', latest_event.latest_site_code,
    'latestPostName', latest_event.latest_post_name,
    'latestEventName', latest_event.latest_event_name,
    'latestTimeZone', coalesce(latest_event.latest_time_zone, operational_time_zone),
    'firstClockIn', event_rollup.first_clock_in,
    'lastClockOut', event_rollup.last_clock_out,
    'eventCount', coalesce(event_rollup.event_count, 0),
    'scheduledShiftCount', coalesce(scheduled_count.scheduled_shift_count, 0),
    'scheduledMinutes', coalesce(scheduled_count.scheduled_minutes, 0),
    'scheduledStartsAt', scheduled_first.scheduled_starts_at,
    'scheduledEndsAt', scheduled_first.scheduled_ends_at,
    'scheduledLocationName', scheduled_first.scheduled_location_name,
    'scheduledSiteName', scheduled_first.scheduled_site_name,
    'scheduledSiteCode', scheduled_first.scheduled_site_code,
    'scheduledPostName', scheduled_first.scheduled_post_name,
    'scheduledEventName', scheduled_first.scheduled_event_name,
    'scheduledTimeZone', coalesce(scheduled_first.scheduled_time_zone, operational_time_zone)
  ) order by employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into rows_payload
  from employees_in_scope scope
  join public.employees employee on employee.id = scope.employee_id
  left join latest_event on latest_event.employee_id = employee.id
  left join event_rollup on event_rollup.employee_id = employee.id
  left join scheduled_count on scheduled_count.employee_id = employee.id
  left join scheduled_first on scheduled_first.employee_id = employee.id
  where employee.status in ('active', 'leave')
    and employee.username is not null;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', operational_time_zone,
    'rows', rows_payload
  );
end
$$;

-- Round paid and break minutes once per canonical occurrence, matching the
-- authoritative timekeeping review. Rounding every individual work segment
-- can lose or add a minute when one occurrence contains a short unpaid gap.
create or replace function public.get_team_attendance_totals(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  operational_time_zone text := 'America/Denver';
  rules private.payroll_rules%rowtype;
  rows_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    )
  then
    raise insufficient_privilege using message = 'Team Attendance permission with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Team Attendance ranges are limited to 46 days.';
  end if;

  select * into rules from private.payroll_rules where id = true;

  with effective_events as materialized (
    select
      event.*,
      (event.assignment_anchor at time zone operational_time_zone)::date as operational_date
    from private.get_effective_time_events_with_occurrence(null) event
    where not event.voided
      and (event.assignment_anchor at time zone operational_time_zone)::date
        between target_from_date and target_through_date
  ),
  context_events as materialized (
    select
      event.*,
      lead(event.kind) over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
      ) as next_kind,
      lead(event.effective_at) over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
      ) as next_effective_at
    from effective_events event
  ),
  work_segments as (
    select
      event.employee_id,
      event.occurrence_key,
      event.operational_date,
      (event.operational_date - extract(dow from event.operational_date)::integer)::date as week_starts_on,
      greatest(0, extract(epoch from (event.next_effective_at - event.effective_at)) / 60) as exact_paid_minutes
    from context_events event
    where event.kind in ('clock_in', 'break_end')
      and event.next_kind in ('break_start', 'clock_out')
      and event.next_effective_at > event.effective_at
  ),
  break_segments as (
    select
      event.employee_id,
      event.occurrence_key,
      greatest(0, extract(epoch from (event.next_effective_at - event.effective_at)) / 60) as exact_break_minutes
    from context_events event
    where event.kind = 'break_start'
      and event.next_kind = 'break_end'
      and event.next_effective_at > event.effective_at
  ),
  occurrence_work as (
    select
      segment.employee_id,
      segment.occurrence_key,
      segment.operational_date,
      segment.week_starts_on,
      sum(segment.exact_paid_minutes)::integer as paid_minutes,
      count(*)::integer as worked_segment_count
    from work_segments segment
    group by
      segment.employee_id,
      segment.occurrence_key,
      segment.operational_date,
      segment.week_starts_on
  ),
  occurrence_break as (
    select
      segment.employee_id,
      segment.occurrence_key,
      sum(segment.exact_break_minutes)::integer as break_minutes
    from break_segments segment
    group by segment.employee_id, segment.occurrence_key
  ),
  daily_totals as (
    select
      occurrence.employee_id,
      occurrence.operational_date,
      occurrence.week_starts_on,
      sum(occurrence.paid_minutes)::integer as paid_minutes,
      greatest(
        0,
        sum(occurrence.paid_minutes) - rules.daily_overtime_minutes
      )::integer as daily_overtime_minutes
    from occurrence_work occurrence
    group by occurrence.employee_id, occurrence.operational_date, occurrence.week_starts_on
  ),
  weekly_totals as (
    select
      daily.employee_id,
      daily.week_starts_on,
      sum(greatest(0, daily.paid_minutes - daily.daily_overtime_minutes))::integer as weekly_candidate_minutes,
      greatest(
        0,
        sum(greatest(0, daily.paid_minutes - daily.daily_overtime_minutes))
          - rules.weekly_overtime_minutes
      )::integer as weekly_overtime_minutes
    from daily_totals daily
    group by daily.employee_id, daily.week_starts_on
  ),
  worked_rollup as (
    select
      occurrence.employee_id,
      sum(occurrence.paid_minutes)::integer as paid_minutes,
      sum(occurrence.worked_segment_count)::integer as worked_segment_count
    from occurrence_work occurrence
    group by occurrence.employee_id
  ),
  break_rollup as (
    select occurrence.employee_id, sum(occurrence.break_minutes)::integer as break_minutes
    from occurrence_break occurrence
    group by occurrence.employee_id
  ),
  daily_overtime_rollup as (
    select daily.employee_id, sum(daily.daily_overtime_minutes)::integer as daily_overtime_minutes
    from daily_totals daily
    group by daily.employee_id
  ),
  weekly_overtime_rollup as (
    select weekly.employee_id, sum(weekly.weekly_overtime_minutes)::integer as weekly_overtime_minutes
    from weekly_totals weekly
    group by weekly.employee_id
  ),
  pending_rollup as (
    select
      event.employee_id,
      count(*)::integer as pending_correction_count
    from public.time_event_corrections correction
    join effective_events event on event.id = correction.time_event_id
    where correction.approved_at is null
      and correction.declined_at is null
    group by event.employee_id
  ),
  employees_in_scope as (
    select employee_id from worked_rollup
    union
    select employee_id from break_rollup
    union
    select employee_id from pending_rollup
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', scope.employee_id,
    'paidMinutes', coalesce(worked_rollup.paid_minutes, 0),
    'breakMinutes', coalesce(break_rollup.break_minutes, 0),
    'overtimeMinutes', coalesce(daily_overtime_rollup.daily_overtime_minutes, 0)
      + coalesce(weekly_overtime_rollup.weekly_overtime_minutes, 0),
    'workedSegmentCount', coalesce(worked_rollup.worked_segment_count, 0),
    'pendingCorrectionCount', coalesce(pending_rollup.pending_correction_count, 0)
  ) order by scope.employee_id), '[]'::jsonb)
  into rows_payload
  from employees_in_scope scope
  left join worked_rollup on worked_rollup.employee_id = scope.employee_id
  left join break_rollup on break_rollup.employee_id = scope.employee_id
  left join daily_overtime_rollup on daily_overtime_rollup.employee_id = scope.employee_id
  left join weekly_overtime_rollup on weekly_overtime_rollup.employee_id = scope.employee_id
  left join pending_rollup on pending_rollup.employee_id = scope.employee_id;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', operational_time_zone,
    'rows', rows_payload
  );
end
$$;

revoke all on function public.get_team_attendance_summary(date, date) from public, anon;
grant execute on function public.get_team_attendance_summary(date, date) to authenticated;

revoke all on function public.get_team_attendance_totals(date, date) from public, anon;
grant execute on function public.get_team_attendance_totals(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;

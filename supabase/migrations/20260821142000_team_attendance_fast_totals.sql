begin;

-- Team Attendance is an operational overview, not a payroll export. Keep its
-- aggregate query set-based so the employee list does not have to execute the
-- full payroll review pipeline before it can render.
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

  with latest_correction as (
    select distinct on (correction.time_event_id)
      correction.time_event_id,
      correction.replacement_time,
      correction.voided
    from public.time_event_corrections correction
    where correction.approved_at is not null
    order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
  ),
  effective_events as (
    select
      event.id,
      event.employee_id,
      private.current_effective_time_event_kind(event.id) as kind,
      event.recorded_at,
      coalesce(latest_correction.replacement_time, event.recorded_at) as effective_at,
      coalesce(latest_correction.voided, false) as voided
    from public.time_events event
    left join latest_correction on latest_correction.time_event_id = event.id
  ),
  context_events as (
    select
      event.*,
      (event.effective_at at time zone operational_time_zone)::date as operational_date,
      lead(event.kind) over (
        partition by event.employee_id
        order by event.effective_at, event.recorded_at, event.id
      ) as next_kind,
      lead(event.effective_at) over (
        partition by event.employee_id
        order by event.effective_at, event.recorded_at, event.id
      ) as next_effective_at
    from effective_events event
    where not event.voided
      and (event.effective_at at time zone operational_time_zone)::date
        between target_from_date - 1 and target_through_date + 1
  ),
  work_segments as (
    select
      event.employee_id,
      event.operational_date,
      (event.operational_date - extract(dow from event.operational_date)::integer)::date as week_starts_on,
      greatest(0, extract(epoch from (event.next_effective_at - event.effective_at)) / 60)::integer as paid_minutes
    from context_events event
    where event.operational_date between target_from_date and target_through_date
      and event.kind in ('clock_in', 'break_end')
      and event.next_kind in ('break_start', 'clock_out')
      and event.next_effective_at > event.effective_at
  ),
  break_segments as (
    select
      event.employee_id,
      greatest(0, extract(epoch from (event.next_effective_at - event.effective_at)) / 60)::integer as break_minutes
    from context_events event
    where event.operational_date between target_from_date and target_through_date
      and event.kind = 'break_start'
      and event.next_kind = 'break_end'
      and event.next_effective_at > event.effective_at
  ),
  daily_totals as (
    select
      segment.employee_id,
      segment.operational_date,
      segment.week_starts_on,
      sum(segment.paid_minutes)::integer as paid_minutes,
      greatest(0, sum(segment.paid_minutes) - 720)::integer as daily_overtime_minutes
    from work_segments segment
    group by segment.employee_id, segment.operational_date, segment.week_starts_on
  ),
  weekly_totals as (
    select
      daily.employee_id,
      daily.week_starts_on,
      sum(greatest(0, daily.paid_minutes - daily.daily_overtime_minutes))::integer as weekly_candidate_minutes,
      greatest(
        0,
        sum(greatest(0, daily.paid_minutes - daily.daily_overtime_minutes)) - 2400
      )::integer as weekly_overtime_minutes
    from daily_totals daily
    group by daily.employee_id, daily.week_starts_on
  ),
  worked_rollup as (
    select
      segment.employee_id,
      sum(segment.paid_minutes)::integer as paid_minutes,
      count(*)::integer as worked_segment_count
    from work_segments segment
    group by segment.employee_id
  ),
  break_rollup as (
    select
      segment.employee_id,
      sum(segment.break_minutes)::integer as break_minutes
    from break_segments segment
    group by segment.employee_id
  ),
  daily_overtime_rollup as (
    select
      daily.employee_id,
      sum(daily.daily_overtime_minutes)::integer as daily_overtime_minutes
    from daily_totals daily
    group by daily.employee_id
  ),
  weekly_overtime_rollup as (
    select
      weekly.employee_id,
      sum(weekly.weekly_overtime_minutes)::integer as weekly_overtime_minutes
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
      and not event.voided
      and (event.effective_at at time zone operational_time_zone)::date
        between target_from_date and target_through_date
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

revoke all on function public.get_team_attendance_totals(date, date) from public, anon;
grant execute on function public.get_team_attendance_totals(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;

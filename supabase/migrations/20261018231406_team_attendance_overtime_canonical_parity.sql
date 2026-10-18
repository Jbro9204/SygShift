begin;

-- Team Attendance is an operational-workday view, so paid and break minutes
-- remain attached to the occurrence's assignment-anchor date. Overtime is a
-- payroll-policy fact, however: it needs the same prior-week context and the
-- same Sunday-midnight allocation used by the authoritative payroll review.
-- Build that classification from canonical effective occurrences without
-- broadening access to the more detailed payroll-review RPC.
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
  context_from_date date;
  range_starts_at timestamptz;
  range_ends_at_exclusive timestamptz;
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

  if target_from_date is null
    or target_through_date is null
    or target_through_date < target_from_date
  then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Team Attendance ranges are limited to 46 days.';
  end if;

  select * into rules
  from private.payroll_rules
  where id = true;

  -- Match the authoritative review's bounded prefix: the Saturday before the
  -- active overtime week is included because it can contribute paid minutes
  -- after the Sunday payroll boundary.
  context_from_date := target_from_date - mod(
    extract(dow from target_from_date)::integer - rules.week_starts_on + 7,
    7
  ) - 1;
  range_starts_at := (target_from_date::timestamp + rules.payroll_week_start_time)
    at time zone rules.time_zone;
  range_ends_at_exclusive := ((target_through_date + 1)::timestamp + rules.payroll_week_start_time)
    at time zone rules.time_zone;

  with corrected_occurrence_keys as materialized (
    select assignment.occurrence_key
    from private.payroll_batch_assignments assignment
    where assignment.assignment_status = 'corrected'
      and assignment.assigned_week_start <= target_through_date
      and assignment.assigned_week_start + 6 >= target_from_date
  ), effective_events as materialized (
    select
      event.*,
      (event.assignment_anchor at time zone operational_time_zone)::date as operational_date
    from private.get_effective_time_events_with_occurrence(null) event
    where not event.voided
      and (
        (event.assignment_anchor at time zone operational_time_zone)::date
          between context_from_date and target_through_date
        or exists (
          select 1
          from corrected_occurrence_keys corrected
          where corrected.occurrence_key = event.occurrence_key
        )
      )
  ), sequenced_events as materialized (
    select
      event.*,
      row_number() over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
      )::integer as sequence_number,
      lag(event.kind) over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
      ) as previous_kind,
      lead(event.kind) over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
      ) as next_kind,
      lead(event.effective_at) over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
      ) as next_effective_at,
      sum(case when event.kind = 'clock_in' then 1 else 0 end) over (
        partition by event.employee_id, event.occurrence_key
        order by event.effective_at, event.recorded_at, event.id
        rows between unbounded preceding and current row
      )::integer as segment_number
    from effective_events event
  ), occurrence_summary as materialized (
    select
      event.employee_id,
      event.occurrence_key,
      min(event.operational_date) as operational_date,
      (array_agg(event.shift_id order by event.effective_at, event.recorded_at, event.id))[1]
        as shift_id,
      min(event.assignment_anchor) as assignment_anchor,
      (array_agg(event.kind order by event.effective_at, event.recorded_at, event.id))[1]
        as first_kind,
      (array_agg(event.kind order by event.effective_at desc, event.recorded_at desc, event.id desc))[1]
        as last_kind,
      min(event.effective_at) filter (where event.kind = 'clock_in') as first_clock_in,
      max(event.effective_at) filter (where event.kind = 'clock_out') as last_clock_out,
      coalesce(bool_and(
        (event.previous_kind is null and event.kind = 'clock_in')
        or (event.previous_kind = 'clock_in' and event.kind in ('break_start', 'clock_out'))
        or (event.previous_kind = 'break_start' and event.kind = 'break_end')
        or (event.previous_kind = 'break_end' and event.kind in ('break_start', 'clock_out'))
        or (event.previous_kind = 'clock_out' and event.kind = 'clock_in')
      ), false) as valid_sequence,
      coalesce(sum(
        case
          when event.kind in ('clock_in', 'break_end')
            and event.next_kind in ('break_start', 'clock_out')
            and event.next_effective_at > event.effective_at
          then extract(epoch from (event.next_effective_at - event.effective_at)) / 60
          else 0
        end
      ), 0)::integer as paid_minutes,
      coalesce(sum(
        case
          when event.kind = 'break_start'
            and event.next_kind = 'break_end'
            and event.next_effective_at > event.effective_at
          then extract(epoch from (event.next_effective_at - event.effective_at)) / 60
          else 0
        end
      ), 0)::integer as break_minutes,
      coalesce(sum(
        case
          when event.kind = 'clock_out'
            and event.next_kind = 'clock_in'
            and event.next_effective_at > event.effective_at
          then extract(epoch from (event.next_effective_at - event.effective_at)) / 60
          else 0
        end
      ), 0)::integer as unpaid_gap_minutes,
      jsonb_agg(jsonb_build_object(
        'id', event.id,
        'employeeId', event.employee_id,
        'shiftId', event.shift_id,
        'kind', event.kind,
        'recordedAt', event.recorded_at,
        'effectiveAt', event.effective_at,
        'hasApprovedCorrection', event.has_approved_correction,
        'voided', event.voided
      ) order by event.effective_at, event.recorded_at, event.id) as event_timeline
    from sequenced_events event
    group by event.employee_id, event.occurrence_key
  ), segment_summary as materialized (
    select
      segment.employee_id,
      segment.occurrence_key,
      count(*) filter (
        where segment.starts_at is not null
          and segment.ends_at is not null
          and segment.ends_at > segment.starts_at
      )::integer as completed_segment_count
    from (
      select
        event.employee_id,
        event.occurrence_key,
        event.segment_number,
        min(event.effective_at) filter (where event.kind = 'clock_in') as starts_at,
        max(event.effective_at) filter (where event.kind = 'clock_out') as ends_at
      from sequenced_events event
      where event.segment_number > 0
      group by event.employee_id, event.occurrence_key, event.segment_number
    ) segment
    group by segment.employee_id, segment.occurrence_key
  ), occurrence_base as materialized (
    select
      occurrence.*,
      coalesce(segment.completed_segment_count, 0) as completed_segment_count,
      occurrence.valid_sequence
        and occurrence.first_kind = 'clock_in'
        and occurrence.last_kind = 'clock_out' as sequence_complete,
      case
        when occurrence.first_clock_in is not null
          and occurrence.last_clock_out > occurrence.first_clock_in
        then (extract(epoch from (occurrence.last_clock_out - occurrence.first_clock_in)) / 60)::integer
        else 0
      end as gross_minutes
    from occurrence_summary occurrence
    left join segment_summary segment
      on segment.employee_id = occurrence.employee_id
     and segment.occurrence_key = occurrence.occurrence_key
  ), occurrence_fingerprinted as materialized (
    select
      occurrence.*,
      encode(extensions.digest(convert_to(jsonb_build_object(
        'occurrenceKey', occurrence.occurrence_key,
        'employeeId', occurrence.employee_id::text,
        'shiftId', occurrence.shift_id::text,
        'firstClockIn', to_jsonb(occurrence.first_clock_in) #>> '{}',
        'lastClockOut', to_jsonb(occurrence.last_clock_out) #>> '{}',
        'paidMinutes', occurrence.paid_minutes::text,
        'events', occurrence.event_timeline
      )::text, 'UTF8'), 'sha256'), 'hex') as occurrence_fingerprint
    from occurrence_base occurrence
  ), occurrence_scoped as materialized (
    select
      occurrence.*,
      case
        when assignment.assignment_status = 'corrected' then 'corrected'
        else 'derived'
      end as payroll_assignment_status,
      case
        when assignment.assignment_status = 'corrected' then assignment.assigned_week_start
        else null
      end as corrected_week_start
    from occurrence_fingerprinted occurrence
    left join private.payroll_batch_assignments assignment
      on assignment.occurrence_key = occurrence.occurrence_key
     and assignment.occurrence_fingerprint = occurrence.occurrence_fingerprint
     and assignment.assignment_status = 'corrected'
    where occurrence.operational_date between context_from_date and target_through_date
      or (
        assignment.assignment_status = 'corrected'
        and assignment.assigned_week_start <= target_through_date
        and assignment.assigned_week_start + 6 >= target_from_date
      )
  ), occurrence_rows as materialized (
    select
      occurrence.*,
      jsonb_build_object(
        'firstClockIn', occurrence.first_clock_in,
        'lastClockOut', occurrence.last_clock_out,
        'grossMinutes', occurrence.gross_minutes,
        'paidMinutes', occurrence.paid_minutes,
        'breakMinutes', occurrence.break_minutes,
        'unpaidGapMinutes', occurrence.unpaid_gap_minutes,
        'eventTimeline', occurrence.event_timeline,
        'payrollAssignmentStatus', occurrence.payroll_assignment_status,
        'payrollBatchWeekStartsOn', occurrence.corrected_week_start
      ) as boundary_row
    from occurrence_scoped occurrence
  ), daily_window as materialized (
    select
      occurrence.*,
      coalesce(sum(occurrence.paid_minutes) over (
        partition by occurrence.employee_id, occurrence.operational_date
        order by occurrence.first_clock_in nulls last, occurrence.occurrence_key
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as prior_day_paid,
      sum(occurrence.paid_minutes) over (
        partition by occurrence.employee_id, occurrence.operational_date
        order by occurrence.first_clock_in nulls last, occurrence.occurrence_key
        rows between unbounded preceding and current row
      )::integer as cumulative_day_paid
    from occurrence_rows occurrence
  ), daily_occurrences as materialized (
    select
      occurrence.*,
      (
        greatest(0, occurrence.cumulative_day_paid - rules.daily_overtime_minutes)
        - greatest(0, occurrence.prior_day_paid - rules.daily_overtime_minutes)
      )::integer as daily_overtime_minutes
    from daily_window occurrence
  ), slice_source as materialized (
    select
      occurrence.employee_id,
      occurrence.occurrence_key,
      occurrence.operational_date,
      occurrence.first_clock_in,
      occurrence.daily_overtime_minutes,
      slice_item.ordinality::integer as slice_number,
      (slice_item.value ->> 'weekStartsOn')::date as week_starts_on,
      (slice_item.value ->> 'startsAt')::timestamptz as slice_starts_at,
      coalesce((slice_item.value ->> 'paidMinutes')::integer, 0) as paid_minutes
    from daily_occurrences occurrence
    cross join lateral jsonb_array_elements(
      private.get_payroll_boundary_minute_slices(
        occurrence.boundary_row,
        range_starts_at,
        range_ends_at_exclusive
      )
    ) with ordinality as slice_item(value, ordinality)
  ), daily_slice_window as materialized (
    select
      slice.*,
      coalesce(sum(slice.paid_minutes) over (
        partition by slice.employee_id, slice.occurrence_key
        order by slice.slice_starts_at desc, slice.slice_number desc
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as later_occurrence_paid
    from slice_source slice
  ), daily_slices as materialized (
    select
      slice.*,
      least(
        slice.paid_minutes,
        greatest(0, slice.daily_overtime_minutes - slice.later_occurrence_paid)
      )::integer as daily_overtime_slice,
      greatest(
        0,
        slice.paid_minutes - least(
          slice.paid_minutes,
          greatest(0, slice.daily_overtime_minutes - slice.later_occurrence_paid)
        )
      )::integer as weekly_candidate_minutes
    from daily_slice_window slice
  ), weekly_window as materialized (
    select
      slice.*,
      coalesce(sum(slice.weekly_candidate_minutes) over (
        partition by slice.employee_id, slice.week_starts_on
        order by slice.slice_starts_at, slice.occurrence_key, slice.slice_number
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as prior_week_candidate,
      sum(slice.weekly_candidate_minutes) over (
        partition by slice.employee_id, slice.week_starts_on
        order by slice.slice_starts_at, slice.occurrence_key, slice.slice_number
        rows between unbounded preceding and current row
      )::integer as cumulative_week_candidate
    from daily_slices slice
  ), finalized_slices as materialized (
    select
      slice.*,
      (
        slice.daily_overtime_slice
        + greatest(0, slice.cumulative_week_candidate - rules.weekly_overtime_minutes)
        - greatest(0, slice.prior_week_candidate - rules.weekly_overtime_minutes)
      )::integer as overtime_minutes
    from weekly_window slice
  ), occurrence_overtime as materialized (
    select
      slice.employee_id,
      slice.occurrence_key,
      coalesce(sum(slice.overtime_minutes), 0)::integer as overtime_minutes
    from finalized_slices slice
    group by slice.employee_id, slice.occurrence_key
  ), selected_occurrence_rollup as materialized (
    select
      occurrence.employee_id,
      sum(occurrence.paid_minutes)::integer as paid_minutes,
      sum(occurrence.break_minutes)::integer as break_minutes,
      sum(occurrence.completed_segment_count)::integer as worked_segment_count,
      sum(coalesce(overtime.overtime_minutes, 0))::integer as overtime_minutes,
      count(*) filter (where not occurrence.sequence_complete)::integer as incomplete_punch_count
    from occurrence_scoped occurrence
    left join occurrence_overtime overtime
      on overtime.employee_id = occurrence.employee_id
     and overtime.occurrence_key = occurrence.occurrence_key
    where occurrence.operational_date between target_from_date and target_through_date
    group by occurrence.employee_id
  ), pending_rollup as materialized (
    select
      event.employee_id,
      count(*)::integer as pending_correction_count
    from public.time_event_corrections correction
    join effective_events event on event.id = correction.time_event_id
    where event.operational_date between target_from_date and target_through_date
      and correction.approved_at is null
      and correction.declined_at is null
    group by event.employee_id
  ), employees_in_scope as (
    select employee_id from selected_occurrence_rollup
    union
    select employee_id from pending_rollup
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', scope.employee_id,
    'paidMinutes', coalesce(occurrence.paid_minutes, 0),
    'breakMinutes', coalesce(occurrence.break_minutes, 0),
    'overtimeMinutes', coalesce(occurrence.overtime_minutes, 0),
    'workedSegmentCount', coalesce(occurrence.worked_segment_count, 0),
    'pendingCorrectionCount', coalesce(pending.pending_correction_count, 0),
    'incompletePunchCount', coalesce(occurrence.incomplete_punch_count, 0)
  ) order by scope.employee_id), '[]'::jsonb)
  into rows_payload
  from employees_in_scope scope
  left join selected_occurrence_rollup occurrence
    on occurrence.employee_id = scope.employee_id
  left join pending_rollup pending
    on pending.employee_id = scope.employee_id;

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

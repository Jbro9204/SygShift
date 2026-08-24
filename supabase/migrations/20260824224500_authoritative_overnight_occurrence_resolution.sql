begin;

-- Workday ownership is occurrence-based, not calendar-date based. A clock-in
-- starts a work session and every following break/clock-out inherits that
-- session's scheduled occurrence across midnight. A stored shift link is only
-- accepted when the punch actually falls inside that shift's working window.
-- Source punches remain append-only; deterministic historical repairs are
-- recorded through the audited occurrence-override ledger.

with effective as materialized (
  select event.*
  from private.get_effective_time_events() event
  where not event.voided
    and event.original_shift_id is not null
), invalid_links as materialized (
  select event.*
  from effective event
  join public.shifts shift on shift.id = event.original_shift_id
  where event.effective_at < shift.starts_at - interval '4 hours'
     or event.effective_at > shift.ends_at + interval '4 hours'
), candidate_rows as materialized (
  select distinct
    event.id as time_event_id,
    candidate.id as shift_id,
    case schedule.status::text
      when 'published' then 3
      when 'archived' then 2
      when 'superseded' then 1
      else 0
    end as schedule_priority
  from invalid_links event
  join public.shift_assignments assignment
    on assignment.employee_id = event.employee_id
   and assignment.status::text in ('assigned', 'confirmed', 'completed')
  join public.shifts candidate
    on candidate.id = assignment.shift_id
   and candidate.canceled_at is null
   and event.effective_at between candidate.starts_at - interval '4 hours'
     and candidate.ends_at + interval '4 hours'
  join public.schedules schedule
    on schedule.id = candidate.schedule_id
   and schedule.status::text in ('published', 'archived', 'superseded')
), best_priority as (
  select time_event_id, max(schedule_priority) as schedule_priority
  from candidate_rows
  group by time_event_id
), deterministic_repairs as (
  select
    candidate.time_event_id,
    min(candidate.shift_id::text)::uuid as replacement_shift_id
  from candidate_rows candidate
  join best_priority priority
    on priority.time_event_id = candidate.time_event_id
   and priority.schedule_priority = candidate.schedule_priority
  group by candidate.time_event_id
  having count(distinct candidate.shift_id) = 1
)
insert into public.time_event_occurrence_overrides (
  time_event_id,
  original_shift_id,
  replacement_shift_id,
  reason,
  source,
  created_by
)
select
  event.id,
  event.original_shift_id,
  repair.replacement_shift_id,
  'Reassigned an overnight punch from an impossible stored shift link to the only matching assigned work occurrence.',
  'system_repair',
  null
from invalid_links event
join deterministic_repairs repair on repair.time_event_id = event.id
where repair.replacement_shift_id is distinct from event.original_shift_id
  and not exists (
    select 1
    from public.time_event_occurrence_overrides existing
    where existing.time_event_id = event.id
      and existing.replacement_shift_id = repair.replacement_shift_id
  );

create or replace function private.get_effective_time_events(
  target_employee_id uuid default null
)
returns table (
  id uuid,
  employee_id uuid,
  original_shift_id uuid,
  shift_id uuid,
  location_override_name text,
  location_override_time_zone text,
  kind public.time_event_kind,
  recorded_at timestamptz,
  effective_at timestamptz,
  has_approved_correction boolean,
  voided boolean,
  pending_correction boolean,
  manual_entry_id uuid,
  manual_clock_in_at timestamptz,
  original_shift_starts_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
with source_events as materialized (
  select event.*
  from public.time_events event
  where target_employee_id is null or event.employee_id = target_employee_id
), latest_time as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_time
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  where correction.approved_at is not null
    and not correction.voided
    and correction.replacement_time is not null
  order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
), latest_kind as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.replacement_kind
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  where correction.approved_at is not null
    and correction.replacement_kind is not null
  order by correction.time_event_id, correction.approved_at desc, correction.created_at desc, correction.id desc
), correction_flags as (
  select
    correction.time_event_id,
    bool_or(correction.approved_at is not null) as has_approved_correction,
    bool_or(correction.approved_at is not null and correction.voided) as voided,
    bool_or(correction.approved_at is null and correction.declined_at is null) as pending_correction
  from public.time_event_corrections correction
  join source_events event on event.id = correction.time_event_id
  group by correction.time_event_id
), latest_shift_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.shift_id
  from public.time_event_shift_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
), latest_occurrence_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.replacement_shift_id
  from public.time_event_occurrence_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
), latest_location_override as (
  select distinct on (override.time_event_id)
    override.time_event_id,
    override.location_name,
    override.time_zone
  from public.time_event_location_overrides override
  join source_events event on event.id = override.time_event_id
  order by override.time_event_id, override.created_at desc, override.id desc
), manual_map as (
  select distinct on (mapped.time_event_id)
    mapped.time_event_id,
    mapped.manual_entry_id,
    mapped.clock_in_at
  from (
    select entry.clock_in_event_id as time_event_id, entry.id as manual_entry_id, entry.clock_in_at, entry.created_at
    from public.manual_time_entries entry
    where entry.clock_in_event_id is not null
    union all
    select entry.clock_out_event_id, entry.id, entry.clock_in_at, entry.created_at
    from public.manual_time_entries entry
    where entry.clock_out_event_id is not null
  ) mapped
  join source_events event on event.id = mapped.time_event_id
  order by mapped.time_event_id, mapped.created_at desc, mapped.manual_entry_id desc
), corrected as materialized (
  select
    event.id,
    event.employee_id,
    event.shift_id as stored_shift_id,
    shift_override.shift_id as display_shift_override_id,
    occurrence_override.replacement_shift_id as explicit_occurrence_shift_id,
    location_override.location_name as location_override_name,
    location_override.time_zone as location_override_time_zone,
    coalesce(kind_correction.replacement_kind, event.kind) as kind,
    event.recorded_at,
    coalesce(time_correction.replacement_time, event.recorded_at) as effective_at,
    coalesce(flags.has_approved_correction, false) as has_approved_correction,
    coalesce(flags.voided, false) as voided,
    coalesce(flags.pending_correction, false) as pending_correction,
    manual.manual_entry_id,
    manual.clock_in_at as manual_clock_in_at,
    case
      when stored_shift.id is not null
        and coalesce(time_correction.replacement_time, event.recorded_at)
          between stored_shift.starts_at - interval '4 hours'
            and stored_shift.ends_at + interval '4 hours'
      then event.shift_id
      else null
    end as valid_stored_shift_id
  from source_events event
  left join latest_time time_correction on time_correction.time_event_id = event.id
  left join latest_kind kind_correction on kind_correction.time_event_id = event.id
  left join correction_flags flags on flags.time_event_id = event.id
  left join latest_shift_override shift_override on shift_override.time_event_id = event.id
  left join latest_occurrence_override occurrence_override on occurrence_override.time_event_id = event.id
  left join latest_location_override location_override on location_override.time_event_id = event.id
  left join manual_map manual on manual.time_event_id = event.id
  left join public.shifts stored_shift on stored_shift.id = event.shift_id
), candidate_rows as materialized (
  select distinct
    event.id as time_event_id,
    candidate.id as shift_id,
    case schedule.status::text
      when 'published' then 3
      when 'archived' then 2
      when 'superseded' then 1
      else 0
    end as schedule_priority
  from corrected event
  join public.shift_assignments assignment
    on assignment.employee_id = event.employee_id
   and assignment.status::text in ('assigned', 'confirmed', 'completed')
  join public.shifts candidate
    on candidate.id = assignment.shift_id
   and candidate.canceled_at is null
   and event.effective_at between candidate.starts_at - interval '4 hours'
     and candidate.ends_at + interval '4 hours'
  join public.schedules schedule
    on schedule.id = candidate.schedule_id
   and schedule.status::text in ('published', 'archived', 'superseded')
  where event.stored_shift_id is not null
    and event.valid_stored_shift_id is null
    and event.explicit_occurrence_shift_id is null
), best_priority as (
  select time_event_id, max(schedule_priority) as schedule_priority
  from candidate_rows
  group by time_event_id
), unique_candidate as (
  select
    candidate.time_event_id,
    min(candidate.shift_id::text)::uuid as shift_id
  from candidate_rows candidate
  join best_priority priority
    on priority.time_event_id = candidate.time_event_id
   and priority.schedule_priority = candidate.schedule_priority
  group by candidate.time_event_id
  having count(distinct candidate.shift_id) = 1
), direct_resolution as materialized (
  select
    event.*,
    coalesce(
      event.explicit_occurrence_shift_id,
      event.valid_stored_shift_id,
      candidate.shift_id
    ) as direct_occurrence_shift_id
  from corrected event
  left join unique_candidate candidate on candidate.time_event_id = event.id
), active_ordered as materialized (
  select
    event.*,
    coalesce(sum(case when event.kind = 'clock_out' then 1 else 0 end) over (
      partition by event.employee_id
      order by event.effective_at, event.recorded_at, event.id
      rows between unbounded preceding and 1 preceding
    ), 0)::bigint as session_number
  from direct_resolution event
  where not event.voided
), session_starts as materialized (
  select
    event.employee_id,
    event.session_number,
    (array_agg(event.id order by event.effective_at, event.recorded_at, event.id)
      filter (where event.kind = 'clock_in'))[1] as clock_in_event_id
  from active_ordered event
  group by event.employee_id, event.session_number
), resolved as materialized (
  select
    event.*,
    case
      when event.explicit_occurrence_shift_id is not null
        then event.explicit_occurrence_shift_id
      when event.kind = 'clock_in'
        then event.direct_occurrence_shift_id
      when session.clock_in_event_id is not null
        then session_clock_in.direct_occurrence_shift_id
      else event.direct_occurrence_shift_id
    end as resolved_occurrence_shift_id
  from direct_resolution event
  left join active_ordered membership on membership.id = event.id
  left join session_starts session
    on session.employee_id = membership.employee_id
   and session.session_number = membership.session_number
  left join direct_resolution session_clock_in on session_clock_in.id = session.clock_in_event_id
)
select
  event.id,
  event.employee_id,
  event.resolved_occurrence_shift_id as original_shift_id,
  coalesce(
    event.display_shift_override_id,
    event.resolved_occurrence_shift_id,
    event.stored_shift_id
  ) as shift_id,
  event.location_override_name,
  event.location_override_time_zone,
  event.kind,
  event.recorded_at,
  event.effective_at,
  event.has_approved_correction,
  event.voided,
  event.pending_correction,
  event.manual_entry_id,
  event.manual_clock_in_at,
  occurrence_shift.starts_at as original_shift_starts_at
from resolved event
left join public.shifts occurrence_shift on occurrence_shift.id = event.resolved_occurrence_shift_id
$$;

revoke all on function private.get_effective_time_events(uuid) from public, anon, authenticated;

-- The live time clock must read the same corrected occurrence identity when it
-- continues a session. This prevents a corrected or repaired clock-in from
-- handing a stale shift link to a later break or clock-out.
do $route_live_clock_through_effective_occurrence$
declare
  function_sql text;
  updated_sql text;
  selection_start integer;
  selection_end integer;
  replacement text := $replacement$select event.kind, event.original_shift_id
  into last_kind, last_shift_id
  from private.get_effective_time_events(actor_employee_id) event
  where not event.voided
  order by event.effective_at desc, event.recorded_at desc, event.id desc
  limit 1;

  $replacement$;
begin
  select pg_get_functiondef(
    'public.record_time_event(public.time_event_kind,uuid,timestamp with time zone,text)'::regprocedure
  ) into function_sql;

  selection_start := position('select private.current_effective_time_event_kind(event.id), event.shift_id' in function_sql);
  selection_end := position('if target_kind = ''clock_in'' then' in function_sql);
  if selection_start = 0 or selection_end <= selection_start then
    raise check_violation using message = 'The live clock session lookup could not be located safely.';
  end if;

  updated_sql := substring(function_sql from 1 for selection_start - 1)
    || replacement
    || substring(function_sql from selection_end);

  if position('private.get_effective_time_events(actor_employee_id)' in updated_sql) = 0
    or position('select private.current_effective_time_event_kind(event.id), event.shift_id' in updated_sql) > 0 then
    raise check_violation using message = 'The live clock could not be routed through the authoritative occurrence source.';
  end if;

  execute updated_sql;
end
$route_live_clock_through_effective_occurrence$;

-- The legacy supervisor RPC remains callable for compatibility. Apply the same
-- temporal guard as the location-aware workflow so neither API can attach a
-- new punch to an unrelated overnight workday.
do $guard_legacy_supervisor_punch_occurrence$
declare
  function_sql text;
  updated_sql text;
begin
  select pg_get_functiondef(
    'public.supervisor_record_time_event(uuid,public.time_event_kind,timestamp with time zone,uuid,text,text)'::regprocedure
  ) into function_sql;

  if position('The selected shift does not match this punch date and time.' in function_sql) = 0 then
    updated_sql := replace(
      function_sql,
      E'  if target_shift_id is not null and not exists (\n    select 1\n    from public.shift_assignments assignment\n    where assignment.shift_id = target_shift_id\n      and assignment.employee_id = target_employee_id\n      and assignment.status in (''assigned'', ''confirmed'', ''completed'')\n  ) then\n    raise check_violation using message = ''The selected shift is not assigned to this employee.'';\n  end if;',
      E'  if target_shift_id is not null and not exists (\n    select 1\n    from public.shift_assignments assignment\n    join public.shifts shift on shift.id = assignment.shift_id\n    where assignment.shift_id = target_shift_id\n      and assignment.employee_id = target_employee_id\n      and assignment.status in (''assigned'', ''confirmed'', ''completed'')\n      and target_effective_at between shift.starts_at - interval ''4 hours'' and shift.ends_at + interval ''4 hours''\n  ) then\n    raise check_violation using message = ''The selected shift does not match this punch date and time.'';\n  end if;'
    );
  else
    updated_sql := function_sql;
  end if;

  if position('The selected shift does not match this punch date and time.' in updated_sql) = 0 then
    raise check_violation using message = 'The legacy supervisor punch occurrence guard could not be installed safely.';
  end if;

  execute updated_sql;
end
$guard_legacy_supervisor_punch_occurrence$;

-- Team Attendance totals must group paid segments by the same work occurrence
-- used by Time Maintenance and payroll. Dating each punch independently splits
-- an overnight clock-in/clock-out pair and moves hours into the wrong day/week.
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

  with effective_events as materialized (
    select
      event.*,
      (event.assignment_anchor at time zone operational_time_zone)::date as operational_date
    from private.get_effective_time_events_with_occurrence() event
    where not event.voided
      and (event.assignment_anchor at time zone operational_time_zone)::date
        between target_from_date and target_through_date
  ), context_events as materialized (
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
  ), work_segments as (
    select
      event.employee_id,
      event.operational_date,
      (event.operational_date - extract(dow from event.operational_date)::integer)::date as week_starts_on,
      greatest(0, extract(epoch from (event.next_effective_at - event.effective_at)) / 60)::integer as paid_minutes
    from context_events event
    where event.kind in ('clock_in', 'break_end')
      and event.next_kind in ('break_start', 'clock_out')
      and event.next_effective_at > event.effective_at
  ), break_segments as (
    select
      event.employee_id,
      greatest(0, extract(epoch from (event.next_effective_at - event.effective_at)) / 60)::integer as break_minutes
    from context_events event
    where event.kind = 'break_start'
      and event.next_kind = 'break_end'
      and event.next_effective_at > event.effective_at
  ), daily_totals as (
    select
      segment.employee_id,
      segment.operational_date,
      segment.week_starts_on,
      sum(segment.paid_minutes)::integer as paid_minutes,
      greatest(0, sum(segment.paid_minutes) - 720)::integer as daily_overtime_minutes
    from work_segments segment
    group by segment.employee_id, segment.operational_date, segment.week_starts_on
  ), weekly_totals as (
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
  ), worked_rollup as (
    select
      segment.employee_id,
      sum(segment.paid_minutes)::integer as paid_minutes,
      count(*)::integer as worked_segment_count
    from work_segments segment
    group by segment.employee_id
  ), break_rollup as (
    select segment.employee_id, sum(segment.break_minutes)::integer as break_minutes
    from break_segments segment
    group by segment.employee_id
  ), daily_overtime_rollup as (
    select daily.employee_id, sum(daily.daily_overtime_minutes)::integer as daily_overtime_minutes
    from daily_totals daily
    group by daily.employee_id
  ), weekly_overtime_rollup as (
    select weekly.employee_id, sum(weekly.weekly_overtime_minutes)::integer as weekly_overtime_minutes
    from weekly_totals weekly
    group by weekly.employee_id
  ), pending_rollup as (
    select
      event.employee_id,
      count(*)::integer as pending_correction_count
    from public.time_event_corrections correction
    join effective_events event on event.id = correction.time_event_id
    where correction.approved_at is null
      and correction.declined_at is null
    group by event.employee_id
  ), employees_in_scope as (
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

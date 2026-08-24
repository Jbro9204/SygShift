begin;

-- Resolve a single employee's session boundary from one corrected punch set.
-- The previous implementation recalculated corrections once for every candidate
-- punch, which made payroll review time grow sharply as punch history grew.
create or replace function private.get_unscheduled_time_session_start(
  target_event_id uuid,
  target_employee_id uuid,
  target_effective_at timestamptz
)
returns table(session_event_id uuid, session_started_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with effective_events as materialized (
    select event.*
    from private.get_effective_time_events(target_employee_id) event
    where not event.voided
  ), previous_close as (
    select max(event.effective_at) as effective_at
    from effective_events event
    where event.kind = 'clock_out'
      and event.id <> target_event_id
      and event.effective_at < target_effective_at
  )
  select candidate.id, candidate.effective_at
  from effective_events candidate
  cross join previous_close
  where candidate.kind = 'clock_in'
    and candidate.effective_at <= target_effective_at
    and candidate.effective_at >= target_effective_at - interval '24 hours'
    and (
      previous_close.effective_at is null
      or candidate.effective_at > previous_close.effective_at
    )
  order by candidate.effective_at, candidate.recorded_at, candidate.id
  limit 1
$$;

revoke all on function private.get_unscheduled_time_session_start(uuid, uuid, timestamptz)
  from public, anon, authenticated;

-- Payroll review already has the full corrected punch stream in memory. Assign
-- session identities with window functions over that stream instead of calling
-- the session resolver once per punch. This preserves the same chronological
-- workday boundaries while keeping readiness and export inside the API timeout.
do $optimize_payroll_session_identity$
declare
  function_sql text;
  updated_sql text;
  source_start integer;
  active_start integer;
  replacement text := $replacement$with effective_events as materialized (
    select event.*
    from private.get_effective_time_events() event
    where can_view_team_time or event.employee_id = reviewer_id
  ),
  session_membership as materialized (
    select
      event.id,
      event.employee_id,
      coalesce(sum(case when event.kind = 'clock_out' then 1 else 0 end) over (
        partition by event.employee_id
        order by event.effective_at, event.recorded_at, event.id
        rows between unbounded preceding and 1 preceding
      ), 0)::bigint as session_number
    from effective_events event
    where not event.voided
  ),
  session_candidates as materialized (
    select
      membership.id,
      (array_agg(candidate.id order by candidate.effective_at, candidate.recorded_at, candidate.id)
        filter (where candidate.kind = 'clock_in'))[1] as session_event_id,
      min(candidate.effective_at) filter (where candidate.kind = 'clock_in') as session_started_at
    from session_membership membership
    join effective_events target on target.id = membership.id
    left join session_membership candidate_membership
      on candidate_membership.employee_id = membership.employee_id
     and candidate_membership.session_number = membership.session_number
    left join effective_events candidate
      on candidate.id = candidate_membership.id
     and candidate.kind = 'clock_in'
     and candidate.effective_at <= target.effective_at
     and candidate.effective_at >= target.effective_at - interval '24 hours'
    group by membership.id
  ),
  identified_events as materialized (
    select
      event.*,
      case
        when event.manual_entry_id is not null
          then 'manual:' || event.manual_entry_id::text || ':employee:' || event.employee_id::text
        when event.original_shift_id is not null
          then 'shift:' || event.original_shift_id::text || ':employee:' || event.employee_id::text
        when session.session_event_id is not null
          then 'unscheduled-session:' || session.session_event_id::text || ':employee:' || event.employee_id::text
        else 'unscheduled:' || event.employee_id::text || ':' || (event.effective_at at time zone rules.time_zone)::date::text
      end as group_key,
      coalesce(
        event.manual_clock_in_at,
        event.original_shift_starts_at,
        session.session_started_at,
        event.effective_at
      ) as assignment_anchor
    from effective_events event
    left join session_membership membership on membership.id = event.id
    left join session_candidates session on session.id = event.id
    where not event.voided
  ),
  $replacement$;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_review_base(date,date)'::regprocedure
  ) into function_sql;

  source_start := position('with effective_events as materialized (' in function_sql);
  active_start := position('active_events as materialized (' in function_sql);

  if source_start = 0 or active_start <= source_start then
    raise check_violation using message = 'Payroll session source boundaries could not be located safely.';
  end if;

  updated_sql := substring(function_sql from 1 for source_start - 1)
    || replacement
    || substring(function_sql from active_start);

  if position('session_membership as materialized (' in updated_sql) = 0
    or position('session_candidates as materialized (' in updated_sql) = 0
    or position('private.get_unscheduled_time_session_start(event.id' in updated_sql) > 0 then
    raise check_violation using message = 'Set-based payroll session identity was not installed safely.';
  end if;

  execute updated_sql;
end
$optimize_payroll_session_identity$;

do $verify_payroll_session_timeout_repair$
declare
  review_sql text;
  session_sql text;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_review_base(date,date)'::regprocedure
  ) into review_sql;

  select pg_get_functiondef(
    'private.get_unscheduled_time_session_start(uuid,uuid,timestamptz)'::regprocedure
  ) into session_sql;

  if position('session_membership as materialized (' in review_sql) = 0
    or position('session_candidates as materialized (' in review_sql) = 0
    or position('rows between unbounded preceding and 1 preceding' in review_sql) = 0
    or position('private.get_unscheduled_time_session_start(event.id' in review_sql) > 0
    or position('private.get_effective_time_events(target_employee_id)' in session_sql) = 0
    or position('private.current_effective_time_event(' in session_sql) > 0
    or position('private.current_effective_time_event_kind(' in session_sql) > 0 then
    raise check_violation using message = 'Payroll session timeout repair verification failed.';
  end if;
end
$verify_payroll_session_timeout_repair$;

notify pgrst, 'reload schema';
commit;

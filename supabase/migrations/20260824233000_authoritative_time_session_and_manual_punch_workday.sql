begin;

-- An employee has one chronological punch stream. A prior clock-out closes the
-- preceding session whether that close was originally linked to a shift,
-- linked later by a supervisor, or left unscheduled. Restricting the boundary
-- to raw unlinked events caused a later valid clock-in and clock-out to receive
-- different occurrence keys, so payroll totals and exception details could
-- disagree about the same work session.
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
  with previous_close as (
    select max(effective.effective_at) as effective_at
    from public.time_events prior_event
    cross join lateral private.current_effective_time_event(prior_event.id) effective
    where prior_event.employee_id = target_employee_id
      and private.current_effective_time_event_kind(prior_event.id) = 'clock_out'
      and prior_event.id <> target_event_id
      and not effective.voided
      and effective.effective_at < target_effective_at
  )
  select candidate.id, effective.effective_at
  from public.time_events candidate
  cross join lateral private.current_effective_time_event(candidate.id) effective
  cross join previous_close
  where candidate.employee_id = target_employee_id
    and private.current_effective_time_event_kind(candidate.id) = 'clock_in'
    and not effective.voided
    and effective.effective_at <= target_effective_at
    and effective.effective_at >= target_effective_at - interval '24 hours'
    and (previous_close.effective_at is null or effective.effective_at > previous_close.effective_at)
  order by effective.effective_at, candidate.recorded_at, candidate.id
  limit 1
$$;

revoke all on function private.get_unscheduled_time_session_start(uuid, uuid, timestamptz)
  from public, anon, authenticated;

do $guard$
declare
  function_sql text;
begin
  select pg_get_functiondef(
    'private.get_unscheduled_time_session_start(uuid,uuid,timestamptz)'::regprocedure
  ) into function_sql;

  if position('prior_event.shift_id is null' in function_sql) > 0
    or position('candidate.shift_id is null' in function_sql) > 0
    or position('private.current_effective_time_event_kind(prior_event.id) = ''clock_out''' in function_sql) = 0
    or position('private.current_effective_time_event_kind(candidate.id) = ''clock_in''' in function_sql) = 0 then
    raise check_violation using message = 'The authoritative time-session boundary was not installed safely.';
  end if;
end
$guard$;

notify pgrst, 'reload schema';
commit;

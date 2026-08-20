begin;

-- Compute attendance sessions once with window functions. This retains the
-- overnight correctness from the prior repair without repeatedly searching an
-- employee's full punch history for every event and every scheduled shift.
do $optimize_attendance_occurrence_context$
declare
  function_sql text;
  updated_sql text;
  target_window_start integer;
  ordered_events_start integer;
  new_scope text := $scope$target_shift_window as (
  select shift.starts_at, shift.ends_at
  from public.shifts shift
  where shift.id = target_shift_id
),
sequenced_events as (
  select
    event.*,
    sum(case when event.kind = 'clock_in' then 1 else 0 end) over (
      order by event.effective_at, event.recorded_at, event.id
      rows between unbounded preceding and current row
    )::integer as session_number,
    max(event.effective_at) filter (where event.kind = 'clock_in') over (
      order by event.effective_at, event.recorded_at, event.id
      rows between unbounded preceding and current row
    ) as session_started_at
  from effective_events event
  where not event.voided
),
linked_sessions as (
  select distinct event.session_number
  from sequenced_events event
  cross join target_shift_window shift_window
  where target_shift_id is not null
    and event.shift_id = target_shift_id
    and event.session_started_at between shift_window.starts_at - interval '2 hours'
      and shift_window.ends_at + interval '2 hours'
),
scoped_events as (
  select
    event.id,
    event.employee_id,
    event.shift_id,
    event.kind,
    event.recorded_at,
    event.effective_at,
    event.has_approved_correction,
    event.voided
  from sequenced_events event
  where (
    (
      target_shift_id is not null
      and exists (
        select 1
        from linked_sessions session
        where session.session_number = event.session_number
      )
    )
    or (
      target_shift_id is null
      and event.shift_id is null
      and (event.effective_at at time zone 'America/Denver')::date = target_operational_date
    )
  )
),
$scope$;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_occurrence_context(uuid,uuid,date)'::regprocedure
  ) into function_sql;

  target_window_start := position('target_shift_window as (' in function_sql);
  ordered_events_start := position('ordered_events as (' in function_sql);

  if target_window_start = 0 or ordered_events_start <= target_window_start then
    raise check_violation using message = 'The overnight attendance optimization boundaries could not be found safely.';
  end if;

  updated_sql := substring(function_sql from 1 for target_window_start - 1)
    || new_scope
    || substring(function_sql from ordered_events_start);

  if updated_sql = function_sql
    or position('sequenced_events as (' in updated_sql) = 0
    or position('linked_sessions as (' in updated_sql) = 0
    or position('private.get_timekeeping_occurrence_key(' in updated_sql) > 0
    or position('private.get_payroll_assignment_anchor(' in updated_sql) > 0
  then
    raise check_violation using message = 'Overnight attendance occurrence lookup could not be optimized safely.';
  end if;

  execute updated_sql;
end
$optimize_attendance_occurrence_context$;

notify pgrst, 'reload schema';
commit;

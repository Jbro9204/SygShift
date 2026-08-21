begin;

-- Resolve immutable occurrence identity from the already-corrected punch set.
-- Original shift and manual-entry relationships remain the source of truth;
-- Site/Post maintenance changes only the displayed shift.
create or replace function private.get_effective_time_events_with_occurrence(
  target_employee_id uuid default null
)
returns table (
  id uuid,
  employee_id uuid,
  original_shift_id uuid,
  shift_id uuid,
  kind public.time_event_kind,
  recorded_at timestamptz,
  effective_at timestamptz,
  has_approved_correction boolean,
  voided boolean,
  occurrence_key text,
  assignment_anchor timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
with effective as materialized (
  select event.*
  from private.get_effective_time_events(target_employee_id) event
), unscheduled as materialized (
  select
    event.*,
    max(event.effective_at) filter (where event.kind = 'clock_out') over (
      partition by event.employee_id
      order by event.effective_at
      range between unbounded preceding and interval '0.001 milliseconds' preceding
    ) as previous_close_at
  from effective event
  where event.original_shift_id is null
    and event.manual_entry_id is null
    and not event.voided
), identified_unscheduled as materialized (
  select
    event.id,
    session.id as session_event_id,
    session.effective_at as session_started_at
  from unscheduled event
  left join lateral (
    select candidate.id, candidate.effective_at
    from unscheduled candidate
    where candidate.employee_id = event.employee_id
      and candidate.kind = 'clock_in'
      and candidate.effective_at <= event.effective_at
      and candidate.effective_at >= event.effective_at - interval '24 hours'
      and (event.previous_close_at is null or candidate.effective_at > event.previous_close_at)
    order by candidate.effective_at, candidate.recorded_at, candidate.id
    limit 1
  ) session on true
)
select
  event.id,
  event.employee_id,
  event.original_shift_id,
  event.shift_id,
  event.kind,
  event.recorded_at,
  event.effective_at,
  event.has_approved_correction,
  event.voided,
  case
    when event.manual_entry_id is not null
      then 'manual:' || event.manual_entry_id::text || ':employee:' || event.employee_id::text
    when event.original_shift_id is not null
      then 'shift:' || event.original_shift_id::text || ':employee:' || event.employee_id::text
    when unscheduled.session_event_id is not null
      then 'unscheduled-session:' || unscheduled.session_event_id::text || ':employee:' || event.employee_id::text
    else 'unscheduled:' || event.employee_id::text || ':' || (event.effective_at at time zone 'America/Denver')::date::text
  end as occurrence_key,
  coalesce(
    event.manual_clock_in_at,
    event.original_shift_starts_at,
    unscheduled.session_started_at,
    event.effective_at
  ) as assignment_anchor
from effective event
left join identified_unscheduled unscheduled on unscheduled.id = event.id
$$;

revoke all on function private.get_effective_time_events_with_occurrence(uuid) from public, anon, authenticated;

-- The four-argument context is the path used by payroll exception review. Use
-- the precomputed occurrence key rather than calling the session resolver once
-- for every punch in every reviewed row.
do $optimize_anchored_occurrence_context$
declare
  function_sql text;
  updated_sql text;
  effective_start integer;
  ordered_start integer;
  replacement text := $replacement$effective_events as materialized (
  select event.*
  from private.get_effective_time_events_with_occurrence(target_employee_id) event
),
anchor_occurrence as (
  select event.occurrence_key
  from effective_events event
  where event.kind = 'clock_in'
    and event.effective_at = target_first_clock_in
  order by event.recorded_at, event.id
  limit 1
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
  from effective_events event
  where not event.voided
    and (
      (
        target_first_clock_in is not null
        and event.occurrence_key = (select anchor.occurrence_key from anchor_occurrence anchor)
      )
      or (
        target_first_clock_in is null
        and (
          (target_shift_id is not null and event.shift_id = target_shift_id)
          or (
            target_shift_id is null
            and event.shift_id is null
            and (event.effective_at at time zone 'America/Denver')::date = target_operational_date
          )
        )
      )
    )
),
$replacement$;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_occurrence_context(uuid,uuid,date,timestamptz)'::regprocedure
  ) into function_sql;
  effective_start := position('effective_events as ' in function_sql);
  ordered_start := position('ordered_events as (' in function_sql);
  if effective_start = 0 or ordered_start <= effective_start then
    raise check_violation using message = 'Anchored occurrence context boundaries could not be found.';
  end if;
  updated_sql := substring(function_sql from 1 for effective_start - 1)
    || replacement
    || substring(function_sql from ordered_start);
  if position('get_effective_time_events_with_occurrence(target_employee_id)' in updated_sql) = 0
    or position('event.occurrence_key = ' in updated_sql) = 0
    or position('private.get_timekeeping_occurrence_key(' in updated_sql) > 0 then
    raise check_violation using message = 'Anchored payroll occurrence context could not be optimized safely.';
  end if;
  execute updated_sql;
end
$optimize_anchored_occurrence_context$;

notify pgrst, 'reload schema';
commit;

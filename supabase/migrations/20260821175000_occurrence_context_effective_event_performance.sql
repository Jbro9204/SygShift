begin;

-- Occurrence detail is still required for mapped, incomplete, and multi-segment
-- work. Read the same set-based effective-event source as payroll review instead
-- of re-running correction and override subqueries for every punch in every row.
do $optimize_occurrence_effective_events$
declare
  signature regprocedure;
  function_sql text;
  updated_sql text;
  effective_start integer;
  next_cte_start integer;
  next_cte_name text;
  replacement text := $replacement$effective_events as materialized (
  select
    event.id,
    event.employee_id,
    event.shift_id,
    event.kind,
    event.recorded_at,
    event.effective_at,
    event.has_approved_correction,
    event.voided
  from private.get_effective_time_events(target_employee_id) event
),
$replacement$;
begin
  foreach signature in array array[
    'private.get_timekeeping_occurrence_context(uuid,uuid,date)'::regprocedure,
    'private.get_timekeeping_occurrence_context(uuid,uuid,date,timestamptz)'::regprocedure
  ]
  loop
    select pg_get_functiondef(signature) into function_sql;
    effective_start := position('effective_events as (' in function_sql);
    next_cte_name := case
      when position('target_shift_window as (' in function_sql) > effective_start then 'target_shift_window as ('
      else 'scoped_events as ('
    end;
    next_cte_start := position(next_cte_name in function_sql);
    if effective_start = 0 or next_cte_start <= effective_start then
      raise check_violation using message = 'Occurrence effective-event boundaries could not be found.';
    end if;
    updated_sql := substring(function_sql from 1 for effective_start - 1)
      || replacement
      || substring(function_sql from next_cte_start);
    if position('private.get_effective_time_events(target_employee_id)' in updated_sql) = 0
      or position('select correction.replacement_time' in substring(updated_sql from effective_start for 2500)) > 0 then
      raise check_violation using message = 'Occurrence detail could not use the set-based punch source.';
    end if;
    execute updated_sql;
  end loop;
end
$optimize_occurrence_effective_events$;

notify pgrst, 'reload schema';
commit;

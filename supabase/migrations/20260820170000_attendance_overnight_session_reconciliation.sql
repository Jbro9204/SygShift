begin;

-- Attendance reconciliation must follow a complete work occurrence across
-- midnight. A Site/Post correction can point individual punches at different
-- schedule records, so use the immutable occurrence key and then confirm that
-- the occurrence anchor falls within the selected shift's operating window.
do $patch_attendance_occurrence_context$
declare
  function_sql text;
  updated_sql text;
  scoped_events_start integer;
  ordered_events_start integer;
  new_scope text := $scope$target_shift_window as (
  select shift.starts_at, shift.ends_at
  from public.shifts shift
  where shift.id = target_shift_id
),
linked_occurrences as (
  select distinct private.get_timekeeping_occurrence_key(
    event.id,
    event.employee_id,
    event.shift_id,
    event.effective_at,
    'America/Denver'
  ) as occurrence_key
  from effective_events event
  cross join target_shift_window shift_window
  where target_shift_id is not null
    and not event.voided
    and event.shift_id = target_shift_id
    and private.get_payroll_assignment_anchor(
      event.shift_id,
      event.id,
      event.effective_at
    ) between shift_window.starts_at - interval '2 hours'
      and shift_window.ends_at + interval '2 hours'
),
scoped_events as (
  select event.*
  from effective_events event
  where not event.voided
    and (
      (
        target_shift_id is not null
        and exists (
          select 1
          from linked_occurrences occurrence
          where occurrence.occurrence_key = private.get_timekeeping_occurrence_key(
            event.id,
            event.employee_id,
            event.shift_id,
            event.effective_at,
            'America/Denver'
          )
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

  scoped_events_start := position('scoped_events as (' in function_sql);
  ordered_events_start := position('ordered_events as (' in function_sql);

  if scoped_events_start = 0 or ordered_events_start <= scoped_events_start then
    raise check_violation using message = 'The attendance occurrence context boundaries could not be found safely.';
  end if;

  updated_sql := substring(function_sql from 1 for scoped_events_start - 1)
    || new_scope
    || substring(function_sql from ordered_events_start);

  if updated_sql = function_sql
    or position('linked_occurrences as (' in updated_sql) = 0
    or position('private.get_payroll_assignment_anchor(' in updated_sql) = 0
    or position('shift_window.ends_at + interval ''2 hours''' in updated_sql) = 0
  then
    raise check_violation using message = 'Attendance occurrences could not be made overnight-aware safely.';
  end if;

  execute updated_sql;
end
$patch_attendance_occurrence_context$;

-- A stale or incorrect historical shift link must not create a zero-event
-- employee row. Only retain employees whose reconciled context contains a
-- punch belonging to the shift occurrence after the anchor-window check.
do $patch_attendance_snapshot_empty_context$
declare
  function_sql text;
  updated_sql text;
  context_start integer;
  rollup_start integer;
  new_context text := $context$actual_employee_contexts as (
  select
    employee.id as employee_id,
    btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
    employee.username,
    occurrence_context.value as context
  from actual_employee_ids actual_employee
  join public.employees employee on employee.id = actual_employee.employee_id
  cross join shift_record
  cross join lateral (
    select private.get_timekeeping_occurrence_context(
      employee.id,
      target_shift_id,
      shift_record.operational_date
    ) as value
  ) occurrence_context
  where (occurrence_context.value ->> 'eventCount')::integer > 0
),
$context$;
begin
  select pg_get_functiondef(
    'private.get_attendance_reconciliation_snapshot(uuid)'::regprocedure
  ) into function_sql;

  context_start := position('actual_employee_contexts as (' in function_sql);
  rollup_start := position('actual_rollup as (' in function_sql);

  if context_start = 0 or rollup_start <= context_start then
    raise check_violation using message = 'The attendance snapshot context boundaries could not be found safely.';
  end if;

  updated_sql := substring(function_sql from 1 for context_start - 1)
    || new_context
    || substring(function_sql from rollup_start);

  if updated_sql = function_sql
    or position('(occurrence_context.value ->> ''eventCount'')::integer > 0' in updated_sql) = 0
  then
    raise check_violation using message = 'Empty attendance contexts could not be excluded safely.';
  end if;

  execute updated_sql;
end
$patch_attendance_snapshot_empty_context$;

notify pgrst, 'reload schema';
commit;

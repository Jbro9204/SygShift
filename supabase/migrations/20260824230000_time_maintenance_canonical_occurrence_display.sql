begin;

-- Time Maintenance already filters by the canonical operational occurrence.
-- Its displayed Shift/Site/Post must come from that same occurrence instead of
-- independently trusting the event's historical raw shift link. Keeping those
-- two concerns on one source prevents an overnight row from being grouped under
-- one workday while showing a different assignment.
do $migration$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_time_maintenance(date,date,uuid)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_time_maintenance(date,date,uuid) was not found.';
  end if;

  if position('occurrence.shift_id as shift_id' in function_sql) = 0 then
    if position('coalesce(latest_shift_override.shift_id, event.shift_id) as shift_id' in function_sql) = 0 then
      raise check_violation using message = 'Time Maintenance shift projection no longer matches the expected implementation.';
    end if;

    function_sql := replace(
      function_sql,
      'coalesce(latest_shift_override.shift_id, event.shift_id) as shift_id',
      'occurrence.shift_id as shift_id'
    );
  end if;

  if position('left join public.shifts shift on shift.id = occurrence.shift_id' in function_sql) = 0 then
    if position('left join public.shifts shift on shift.id = coalesce(latest_shift_override.shift_id, event.shift_id)' in function_sql) = 0 then
      raise check_violation using message = 'Time Maintenance shift join no longer matches the expected implementation.';
    end if;

    function_sql := replace(
      function_sql,
      'left join public.shifts shift on shift.id = coalesce(latest_shift_override.shift_id, event.shift_id)',
      'left join public.shifts shift on shift.id = occurrence.shift_id'
    );
  end if;

  execute function_sql;
end
$migration$;

notify pgrst, 'reload schema';
commit;

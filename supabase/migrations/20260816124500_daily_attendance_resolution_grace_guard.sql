begin;

do $patch$
declare
  function_sql text;
  guard_sql text :=
    '  if current_snapshot is not null' || chr(10)
    || '    and (current_snapshot ->> ''endsAt'')::timestamptz + interval ''2 hours'' > clock_timestamp()' || chr(10)
    || '  then' || chr(10)
    || '    raise check_violation using message = ''Attendance review decisions are available two hours after the shift ends.'';' || chr(10)
    || '  end if;' || chr(10) || chr(10);
begin
  select pg_get_functiondef(
    'public.resolve_daily_attendance_review(uuid,text,text,text,text)'::regprocedure
  )
  into function_sql;

  if position('Attendance review decisions are available two hours after the shift ends.' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '  current_snapshot := private.get_attendance_reconciliation_snapshot(target_shift_id);' || chr(10) || chr(10),
      '  current_snapshot := private.get_attendance_reconciliation_snapshot(target_shift_id);' || chr(10) || chr(10)
        || guard_sql
    );

    execute function_sql;
  end if;

  select pg_get_functiondef(
    'public.resolve_daily_attendance_review(uuid,text,text,text,text)'::regprocedure
  )
  into function_sql;

  if position('Attendance review decisions are available two hours after the shift ends.' in function_sql) = 0 then
    raise exception 'Daily attendance resolution grace guard failed.';
  end if;
end
$patch$;

notify pgrst, 'reload schema';

commit;

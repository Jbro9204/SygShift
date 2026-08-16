begin;

do $patch$
declare
  function_sql text;
begin
  select pg_get_functiondef(
    'public.get_daily_attendance_review(date,date,boolean)'::regprocedure
  )
  into function_sql;

  if position('time.resolve_exceptions' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '    or public.has_effective_permission(''time.export_payroll'')',
      '    or public.has_effective_permission(''time.export_payroll'')' || chr(10)
        || '    or public.has_effective_permission(''time.resolve_exceptions'')'
    );

    execute function_sql;
  end if;

  select pg_get_functiondef(
    'public.get_daily_attendance_review(date,date,boolean)'::regprocedure
  )
  into function_sql;

  if position('time.resolve_exceptions' in function_sql) = 0 then
    raise exception 'Daily attendance review permission alignment failed.';
  end if;
end
$patch$;

notify pgrst, 'reload schema';

commit;

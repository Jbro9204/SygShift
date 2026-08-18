begin;

do $patch$
declare
  function_sql text;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_operations_workspace_edit_base(date,date)'::regprocedure
  )
  into function_sql;

  if position('<<workspace_scope>>' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      'DECLARE' || chr(10) || '  actor_id uuid',
      '<<workspace_scope>>' || chr(10) || 'DECLARE' || chr(10) || '  actor_id uuid'
    );
  end if;

  function_sql := replace(
    function_sql,
    'request.employee_id = actor_id',
    'request.employee_id = workspace_scope.actor_id'
  );
  function_sql := replace(
    function_sql,
    'acknowledgment.employee_id = actor_id',
    'acknowledgment.employee_id = workspace_scope.actor_id'
  );
  function_sql := replace(
    function_sql,
    'employee.id = actor_id',
    'employee.id = workspace_scope.actor_id'
  );

  execute function_sql;
end
$patch$;

commit;

begin;

do $patch$
declare
  function_sql text;
begin
  select pg_get_functiondef(
    'private.get_timekeeping_operations_workspace_edit_base(date,date)'::regprocedure
  )
  into function_sql;

  function_sql := replace(function_sql, '<<workspace_scope>>' || chr(10), '');
  function_sql := replace(function_sql, 'actor_id uuid := private.current_employee_id()', 'workspace_actor_id uuid := private.current_employee_id()');
  function_sql := replace(function_sql, 'if actor_id is null then', 'if workspace_actor_id is null then');
  function_sql := replace(function_sql, 'request.employee_id = workspace_scope.actor_id', 'request.employee_id = workspace_actor_id');
  function_sql := replace(function_sql, 'acknowledgment.employee_id = workspace_scope.actor_id', 'acknowledgment.employee_id = workspace_actor_id');
  function_sql := replace(function_sql, 'employee.id = workspace_scope.actor_id', 'employee.id = workspace_actor_id');

  execute function_sql;
end
$patch$;

commit;

-- Rollback-only contract for immutable identities in paged operational report
-- rows. Same-start automatic clock-outs must remain distinguishable through a
-- refetch without changing any source timekeeping record.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $operational_report_row_identity_regression$
declare
  function_source text;
  function_security_definer boolean;
  function_volatility "char";
  function_search_path text[];
begin
  select
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proconfig
  into
    function_source,
    function_security_definer,
    function_volatility,
    function_search_path
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'get_timekeeping_operations_reports'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'target_from_date date, target_through_date date';

  assert function_source is not null,
    'The operational report source function must exist.';
  assert function_security_definer,
    'The operational report source must remain SECURITY DEFINER.';
  assert function_volatility = 's',
    'The operational report source must remain STABLE.';
  assert function_search_path = array['search_path=""'],
    'The operational report source must retain its empty search path.';
  assert position('''id'', exception.id' in function_source) > 0
    and position('''exceptionId'', exception.id' in function_source) > 0
    and position('''employeeId'', exception.employee_id' in function_source) > 0
    and position('''shiftId'', exception.shift_id' in function_source) > 0
    and position('''timeEventId'', time_event.id' in function_source) > 0,
    'Automatic clock-out report rows must expose their immutable source identities.';
  assert position('''id'', history.id' in function_source) > 0
    and position('''historyId'', history.id' in function_source) > 0
    and position('''manualEntryId'', entry.id' in function_source) > 0
    and position('''employeeId'', entry.employee_id' in function_source) > 0
    and position('order by history.created_at desc, history.id' in function_source) > 0,
    'Manual-entry audit rows must expose their immutable history identity and deterministic ordering.';
end
$operational_report_row_identity_regression$;

rollback;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '8s';

-- The live plan rebuilt candidate priority 996 times for 2,568 effective
-- punches. Materialize this unchanged aggregate once. Preserve every resolved
-- occurrence, privilege, security setting, and payroll calculation.
do $materialize_candidate_priority$
declare
  signature constant regprocedure := 'private.get_effective_time_events(uuid)'::regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  revised_sql text;
begin
  select * into strict original_function from pg_catalog.pg_proc where oid = signature;
  original_sql := pg_get_functiondef(signature);

  if md5(original_sql) = 'e4e6ab15b4a6bdca294cc4d250398396' then
    return;
  end if;

  if md5(original_sql) <> 'b4245dab37a679fad6eb52a63953c886'
    or cardinality(string_to_array(original_sql, 'best_priority as (')) <> 2
  then
    raise check_violation using message = 'Effective-punch source changed after the verified planner baseline; review before applying.';
  end if;

  revised_sql := replace(original_sql, 'best_priority as (', 'best_priority as materialized (');
  execute revised_sql;
  select * into strict revised_function from pg_catalog.pg_proc where oid = signature;

  if pg_get_functiondef(signature) <> revised_sql
    or revised_function.proowner is distinct from original_function.proowner
    or revised_function.proacl is distinct from original_function.proacl
    or revised_function.proconfig is distinct from original_function.proconfig
    or revised_function.prosecdef is distinct from original_function.prosecdef
    or revised_function.provolatile is distinct from original_function.provolatile
    or revised_function.proargdefaults is distinct from original_function.proargdefaults
  then
    raise check_violation using message = 'Effective-punch planner change did not preserve the verified function boundary.';
  end if;
end
$materialize_candidate_priority$;

commit;

begin;

-- Forward recovery only: restore the exact pre-change planner directive while
-- preserving the same function identity, data, owner, and execution boundary.
do $recover_candidate_priority$
declare
  signature constant regprocedure := 'private.get_effective_time_events(uuid)'::regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  recovered_sql text;
begin
  select * into strict original_function from pg_catalog.pg_proc where oid = signature;
  original_sql := pg_get_functiondef(signature);
  if md5(original_sql) = 'b4245dab37a679fad6eb52a63953c886' then
    return;
  end if;

  if cardinality(string_to_array(original_sql, 'best_priority as materialized (')) <> 2 then
    raise check_violation using message = 'Effective-punch planner source is not the exact recoverable revision.';
  end if;
  recovered_sql := replace(original_sql, 'best_priority as materialized (', 'best_priority as (');
  if md5(recovered_sql) <> 'b4245dab37a679fad6eb52a63953c886' then
    raise check_violation using message = 'Effective-punch source changed after the planner repair; review forward recovery.';
  end if;

  execute recovered_sql;
  select * into strict revised_function from pg_catalog.pg_proc where oid = signature;
  if pg_get_functiondef(signature) <> recovered_sql
    or revised_function.proowner is distinct from original_function.proowner
    or revised_function.proacl is distinct from original_function.proacl
    or revised_function.proconfig is distinct from original_function.proconfig
    or revised_function.prosecdef is distinct from original_function.prosecdef
    or revised_function.provolatile is distinct from original_function.provolatile
    or revised_function.proargdefaults is distinct from original_function.proargdefaults
  then
    raise check_violation using message = 'Effective-punch recovery did not preserve the verified function boundary.';
  end if;
end
$recover_candidate_priority$;

commit;

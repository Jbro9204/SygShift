begin;
-- Aggregate the same ordered occurrence gaps once; no payroll formula,
-- sequence identity, row enrichment, source record or access change.
set local lock_timeout='2s';
set local statement_timeout='8s';
do $materialize_occurrence_gaps$
declare
  signature constant regprocedure := 'private.get_timekeeping_review_base(date,date)'::regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  revised_sql text;
begin
  select * into strict original_function from pg_catalog.pg_proc where oid=signature;
  original_sql := pg_get_functiondef(signature);
  if md5(original_sql)='2bf025842841d13fa8a4f9facab445e7' then return;end if;
  if md5(original_sql)<>'63bf386020f89db8e3e1a64c2270d215' or cardinality(string_to_array(original_sql,'occurrence_gaps as ('))<>2 then
    raise check_violation using message='Occurrence gap source differs from the verified production baseline.';
  end if;
  revised_sql := replace(original_sql,'occurrence_gaps as (','occurrence_gaps as materialized (');
  if md5(revised_sql)<>'2bf025842841d13fa8a4f9facab445e7' then raise check_violation using message='Occurrence gap candidate differs from the independently tested source.';end if;
  execute revised_sql;
  select * into strict revised_function from pg_catalog.pg_proc where oid=signature;
  if pg_get_functiondef(signature)<>revised_sql
    or revised_function.proowner is distinct from original_function.proowner
    or revised_function.proacl is distinct from original_function.proacl
    or revised_function.proconfig is distinct from original_function.proconfig
    or revised_function.prosecdef is distinct from original_function.prosecdef
    or revised_function.provolatile is distinct from original_function.provolatile
    or revised_function.proargdefaults is distinct from original_function.proargdefaults then
    raise check_violation using message='Occurrence gap patch changed the verified function boundary.';
  end if;
end $materialize_occurrence_gaps$;
commit;

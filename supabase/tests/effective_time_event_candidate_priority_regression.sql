-- Installed planner repair regression; no fixture or data writes.
begin;
set local statement_timeout = '8s';
set local lock_timeout = '250ms';

do $verify_candidate_priority$
declare
  source_sql text;
  prior_sql text;
  added_rows bigint;
  removed_rows bigint;
  installed_count bigint;
  prior_count bigint;
begin
  select function.prosrc into strict source_sql
  from pg_catalog.pg_proc function
  where function.oid = 'private.get_effective_time_events(uuid)'::regprocedure;
  if cardinality(string_to_array(source_sql, 'best_priority as materialized (')) <> 2 then
    raise check_violation using message = 'Effective-punch candidate priority must be materialized once.';
  end if;
  source_sql := replace(source_sql, 'target_employee_id', '(null::uuid)');
  prior_sql := replace(source_sql, 'best_priority as materialized (', 'best_priority as (');

  execute 'with installed as materialized (' || source_sql || '), prior as materialized (' || prior_sql || ')
    select (select count(*) from installed), (select count(*) from prior),
      (select count(*) from (select * from installed except all select * from prior) difference),
      (select count(*) from (select * from prior except all select * from installed) difference)'
  into installed_count, prior_count, added_rows, removed_rows;

  if installed_count <> prior_count or added_rows <> 0 or removed_rows <> 0 then
    raise check_violation using message = 'Materialized candidate priority changed effective-punch output.';
  end if;
end
$verify_candidate_priority$;

rollback;

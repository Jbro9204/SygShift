-- The identity executor creates this exact temporary row shape at runtime.
-- Supply only that catalog shape to static lint. Never invoke the executor,
-- authorize a backfill, or open its production release gate.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
create extension if not exists plpgsql_check with schema extensions;

create temporary table identity_backfill_lint_before on commit drop as
select
  md5(pg_get_functiondef('private.execute_hris_stage2_identity_backfill(uuid)'::regprocedure)) as function_md5,
  (select md5(coalesce(jsonb_agg(to_jsonb(gate) order by gate.singleton)::text,'[]'))
    from private.hr_stage2_backfill_gate gate) as release_gate_md5;

create temporary table hris_stage2_execution_targets on commit drop as
select proposal.* from private.hris_stage2_mapping_proposal() proposal with no data;

create temporary table identity_backfill_contextual_lint on commit drop as
select issue.*
from extensions.plpgsql_check_function_tb(
  'private.execute_hris_stage2_identity_backfill(uuid)'::regprocedure,
  fatal_errors := false
) issue;

do $verify$
declare prior_state record;
begin
  select * into strict prior_state from pg_temp.identity_backfill_lint_before;
  if exists(select 1 from pg_temp.identity_backfill_contextual_lint where level='error') then
    raise exception 'The identity executor has a static error with its exact runtime temporary row shape.';
  end if;
  if prior_state.function_md5 <> md5(pg_get_functiondef('private.execute_hris_stage2_identity_backfill(uuid)'::regprocedure))
    or prior_state.release_gate_md5 is distinct from (
      select md5(coalesce(jsonb_agg(to_jsonb(gate) order by gate.singleton)::text,'[]'))
      from private.hr_stage2_backfill_gate gate
    ) then
    raise exception 'Contextual lint changed the identity executor or its production release gate.';
  end if;
  assert (select count(*) from pg_temp.hris_stage2_execution_targets) = 0,
    'The contextual lint target table must remain empty.';
end;
$verify$;

select
  (select count(*) from pg_temp.identity_backfill_contextual_lint where level='error') as contextual_errors,
  (select count(*) from pg_temp.hris_stage2_execution_targets) as execution_target_rows,
  false as executor_invoked,
  true as function_and_release_gate_preserved;
rollback;

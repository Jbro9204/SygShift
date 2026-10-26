begin;

set local lock_timeout = '2s';
set local statement_timeout = '8s';

do $scheduled_runtime_index_postflight$
declare
  automation_function pg_catalog.pg_proc%rowtype;
  automation_sql text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    where index_state.indexrelid = to_regclass('public.shifts_timekeeping_due_end_idx')
      and index_state.indisvalid
      and index_state.indisready
      and position('(ends_at, id)' in pg_get_indexdef(index_state.indexrelid)) > 0
      and position('WHERE (canceled_at IS NULL)' in pg_get_indexdef(index_state.indexrelid)) > 0
  ) then
    raise check_violation using message = 'The due-shift range index is missing or invalid.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    where index_state.indexrelid = to_regclass('public.time_events_employee_shift_recorded_idx')
      and index_state.indisvalid
      and index_state.indisready
      and position('(employee_id, shift_id, recorded_at DESC, id)' in pg_get_indexdef(index_state.indexrelid)) > 0
      and position('WHERE (shift_id IS NOT NULL)' in pg_get_indexdef(index_state.indexrelid)) > 0
  ) then
    raise check_violation using message = 'The employee-occurrence event index is missing or invalid.';
  end if;

  select * into strict automation_function
  from pg_catalog.pg_proc
  where oid = 'public.service_run_timekeeping_automation(uuid)'::regprocedure;
  automation_sql := pg_get_functiondef(automation_function.oid);

  if position('with due_shifts as materialized' in automation_sql) = 0
     or position('with due_missing_shifts as materialized' in automation_sql) = 0
     or position('occurrence_schedule.week_starts_on = schedule.week_starts_on' in automation_sql) = 0
     or position('occurrence_schedule.week_starts_on = target_schedule.week_starts_on' in automation_sql) = 0
     or pg_get_userbyid(automation_function.proowner) <> 'postgres'
     or not automation_function.prosecdef
     or automation_function.proconfig is distinct from array['search_path=""']::text[]
     or automation_function.proacl::text
       is distinct from '{postgres=X/postgres,service_role=X/postgres}' then
    raise check_violation using message =
      'The bounded scheduled automation or its service-only boundary is incomplete.';
  end if;
end
$scheduled_runtime_index_postflight$;

commit;

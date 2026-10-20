begin;
set local lock_timeout='2s';
set local statement_timeout='8s';

-- Restore exact prior category lookup and preserve its owner/ACL/configuration.
do $group_category_candidates$
declare
  signature constant regprocedure := 'private.get_timekeeping_review_pre_payroll_week_allocation(date,date)'::regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  revised_sql text;
begin
  select * into strict original_function from pg_catalog.pg_proc where oid=signature;
  original_sql := pg_get_functiondef(signature);
  if md5(original_sql)='419009e39eca36320e9a4dad8f4d79cc' then return;end if;
  if md5(original_sql)<>'50d56676c0b0daa7d2f795dc85e1b074' then
    raise check_violation using message='Payroll category source differs from the verified recovery baseline.';
  end if;
  revised_sql := original_sql;
  if cardinality(string_to_array(revised_sql,$category_old_0$  with employee_category_map as materialized (
    select map_item.value ->> 'employeeId' as employee_id,
      jsonb_agg(map_item.value order by map_item.ordinality) as items
    from jsonb_array_elements(category_map) with ordinality as map_item(value, ordinality)
    group by map_item.value ->> 'employeeId'
  )
  select coalesce(jsonb_agg(
$category_old_0$))<>2 then
    raise check_violation using message='Payroll category patch token is not unique.';
  end if;
  revised_sql := replace(revised_sql,$category_old_0$  with employee_category_map as materialized (
    select map_item.value ->> 'employeeId' as employee_id,
      jsonb_agg(map_item.value order by map_item.ordinality) as items
    from jsonb_array_elements(category_map) with ordinality as map_item(value, ordinality)
    group by map_item.value ->> 'employeeId'
  )
  select coalesce(jsonb_agg(
$category_old_0$,$category_new_0$  select coalesce(jsonb_agg(
$category_new_0$);
  if cardinality(string_to_array(revised_sql,$category_old_1$  left join employee_category_map employee_map
    on employee_map.employee_id = row_item.value ->> 'employeeId'
  left join lateral (
    select map_item.value
    from jsonb_array_elements(employee_map.items) map_item(value)$category_old_1$))<>2 then
    raise check_violation using message='Payroll category patch token is not unique.';
  end if;
  revised_sql := replace(revised_sql,$category_old_1$  left join employee_category_map employee_map
    on employee_map.employee_id = row_item.value ->> 'employeeId'
  left join lateral (
    select map_item.value
    from jsonb_array_elements(employee_map.items) map_item(value)$category_old_1$,$category_new_1$  left join lateral (
    select map_item.value
    from jsonb_array_elements(category_map) map_item(value)$category_new_1$);
  if md5(revised_sql)<>'419009e39eca36320e9a4dad8f4d79cc' then raise check_violation using message='Payroll category candidate differs from the independently tested source.';end if;
  execute revised_sql;
  select * into strict revised_function from pg_catalog.pg_proc where oid=signature;
  if pg_get_functiondef(signature)<>revised_sql
    or revised_function.proowner is distinct from original_function.proowner
    or revised_function.proacl is distinct from original_function.proacl
    or revised_function.proconfig is distinct from original_function.proconfig
    or revised_function.prosecdef is distinct from original_function.prosecdef
    or revised_function.provolatile is distinct from original_function.provolatile
    or revised_function.proargdefaults is distinct from original_function.proargdefaults then
    raise check_violation using message='Payroll category patch changed the verified function boundary.';
  end if;
end $group_category_candidates$;
commit;

-- Inactive inverse template. If recovery is required, copy this reviewed body
-- into a new forward migration version and run the normal release gates.
begin;

set local lock_timeout = '2s';
set local statement_timeout = '8s';

do $restore_prior_payroll_review_source$
declare
  signature constant regprocedure := 'public.get_timekeeping_review(date,date)'::regprocedure;
  current_function pg_catalog.pg_proc%rowtype;
  restored_function pg_catalog.pg_proc%rowtype;
  current_sql text;
  restored_sql text;
  new_partition text;
  old_partition text;
  new_corrected_filter text;
  old_corrected_filter text;
begin
  select * into strict current_function
  from pg_catalog.pg_proc
  where oid = signature;
  current_sql := pg_get_functiondef(signature);

  if md5(current_sql) = '9656bc6ff66fdf926a0c09c5f4852d24' then
    drop function if exists private.get_timekeeping_review_partitioned_sources(date, date, date);
    return;
  end if;
  if md5(current_sql) <> 'e244e55e85645ca05e7496588d860e8c' then
    raise check_violation using message =
      'Payroll review source differs from the exact single-pass candidate; recovery refused.';
  end if;

  new_partition := $new_partition$
  -- Prefix context starts on the operational day before the current overtime
  -- week (at most seven days earlier). This includes the prior Saturday
  -- occurrence even when a caller starts a partial-week review after Sunday.
  context_from_date := target_from_date - mod(
    extract(dow from target_from_date)::integer - rules.week_starts_on + 7,
    7
  ) - 1;

  corrected_payload := private.get_timekeeping_review_partitioned_sources(
    target_from_date,
    target_through_date,
    context_from_date
  );
  payload := corrected_payload -> 'mainPayload';
  context_payload := corrected_payload -> 'contextPayload';
  corrected_payload := '{}'::jsonb;
$new_partition$;
  old_partition := $old_partition$
  payload := private.get_timekeeping_review_pre_payroll_week_allocation(
    target_from_date,
    target_through_date
  );

  -- Prefix context starts on the operational day before the current overtime
  -- week (at most seven days earlier). This includes the prior Saturday
  -- occurrence even when a caller starts a partial-week review after Sunday.
  context_from_date := target_from_date - mod(
    extract(dow from target_from_date)::integer - rules.week_starts_on + 7,
    7
  ) - 1;

  if context_from_date <= target_from_date - 1 then
    context_payload := private.get_timekeeping_review_pre_payroll_week_allocation(
      context_from_date,
      target_from_date - 1
    );
  end if;
$old_partition$;

  new_corrected_filter := $new_filter$
      and coalesce(
        (shift.starts_at at time zone shift.time_zone)::date,
        (assignment.assignment_anchor at time zone rules.time_zone)::date
      ) is not null
      and not (
        coalesce(
          (shift.starts_at at time zone shift.time_zone)::date,
          (assignment.assignment_anchor at time zone rules.time_zone)::date
        ) between context_from_date and target_through_date
      )
$new_filter$;
  old_corrected_filter := $old_filter$
      and coalesce(
        (shift.starts_at at time zone shift.time_zone)::date,
        (assignment.assignment_anchor at time zone rules.time_zone)::date
      ) is not null
$old_filter$;

  restored_sql := replace(current_sql, new_corrected_filter, old_corrected_filter);
  restored_sql := replace(restored_sql, new_partition, old_partition);
  if md5(restored_sql) <> '9656bc6ff66fdf926a0c09c5f4852d24' then
    raise check_violation using message =
      'Recovered payroll review source does not match the verified prior source.';
  end if;

  execute restored_sql;
  select * into strict restored_function
  from pg_catalog.pg_proc
  where oid = signature;

  if restored_function.proowner is distinct from current_function.proowner
    or restored_function.proacl is distinct from current_function.proacl
    or restored_function.proconfig is distinct from current_function.proconfig
    or restored_function.prosecdef is distinct from current_function.prosecdef
    or restored_function.provolatile is distinct from current_function.provolatile
    or restored_function.proargdefaults is distinct from current_function.proargdefaults
  then
    raise check_violation using message =
      'Payroll review recovery changed the verified function boundary.';
  end if;
end
$restore_prior_payroll_review_source$;

drop function if exists private.get_timekeeping_review_partitioned_sources(date, date, date);

commit;

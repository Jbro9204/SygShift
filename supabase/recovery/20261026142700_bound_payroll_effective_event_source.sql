-- Inactive inverse template. Recovery must be released as a new forward
-- migration after the normal quality and database rehearsal gates.
begin;

set local lock_timeout = '2s';
set local statement_timeout = '8s';

do $restore_unbounded_payroll_source$
declare
  signature constant regprocedure :=
    'private.get_timekeeping_review_base(date,date)'::regprocedure;
  current_function pg_catalog.pg_proc%rowtype;
  restored_function pg_catalog.pg_proc%rowtype;
  current_sql text;
  restored_sql text;
  bounded_token text := $bounded_call$from private.get_effective_time_events_bounded(
      null,
      target_from_date::timestamp at time zone rules.time_zone,
      (target_through_date + 1)::timestamp at time zone rules.time_zone
    ) event$bounded_call$;
  original_token text := 'from private.get_effective_time_events() event';
begin
  select * into strict current_function
  from pg_catalog.pg_proc
  where oid = signature;
  current_sql := pg_get_functiondef(signature);

  if cardinality(string_to_array(current_sql, bounded_token)) <> 2 then
    raise check_violation using message =
      'Exact bounded payroll source is not installed; recovery refused.';
  end if;

  restored_sql := replace(current_sql, bounded_token, original_token);
  if md5(restored_sql) <> '2bf025842841d13fa8a4f9facab445e7' then
    raise check_violation using message =
      'Recovered payroll base does not match the verified prior source.';
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
    or restored_function.proargdefaults is distinct from current_function.proargdefaults then
    raise check_violation using message =
      'Payroll source recovery changed the verified function boundary.';
  end if;
end
$restore_unbounded_payroll_source$;

drop trigger if exists zzz_refresh_timekeeping_effective_projection
  on public.time_events;
drop trigger if exists zzz_refresh_timekeeping_effective_projection
  on public.time_event_corrections;
drop trigger if exists zzz_refresh_timekeeping_effective_projection
  on public.time_event_shift_overrides;
drop trigger if exists zzz_refresh_timekeeping_effective_projection
  on public.time_event_occurrence_overrides;
drop trigger if exists zzz_refresh_timekeeping_effective_projection
  on public.time_event_location_overrides;
drop trigger if exists zzz_refresh_timekeeping_effective_projection
  on public.manual_time_entries;

drop function private.get_effective_time_events_bounded(
  uuid,
  timestamptz,
  timestamptz
);
drop function private.refresh_timekeeping_effective_event_projection_trigger();
drop function private.refresh_timekeeping_effective_event_projection(uuid);
drop table private.timekeeping_effective_event_projection;

commit;

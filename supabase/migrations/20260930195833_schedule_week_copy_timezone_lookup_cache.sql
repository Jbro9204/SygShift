begin;

set local lock_timeout = '5s';

-- pg_timezone_names is a catalog view that is expensive to evaluate on the
-- hosted API connection. The DST-safe copy routine previously evaluated it
-- twice for every shift, which caused normal large-week copies to exceed the
-- authenticated statement-timeout boundary. Patch the reviewed live function
-- text only: retain its current local-calendar/DST, authorization, assignment,
-- audit, and atomic-replacement behavior while resolving the valid name set
-- once per copy transaction.
do $repair_schedule_week_copy_timezone_lookup_cache$
declare
  function_oid oid;
  function_sql text;
  updated_sql text;
  declaration_anchor text := $declaration_anchor$
  explicit_time_zone_source_count integer := 0;
begin$declaration_anchor$;
  cached_declaration text := $cached_declaration$
  explicit_time_zone_source_count integer := 0;
  valid_time_zone_names text[];
begin$cached_declaration$;
  week_guard_anchor text := $week_guard_anchor$
  if source_schedule.week_starts_on = destination_week_starts_on then
    raise check_violation using message = 'Choose a destination week different from the source week.';
  end if;

  perform pg_advisory_xact_lock($week_guard_anchor$;
  cached_week_guard text := $cached_week_guard$
  if source_schedule.week_starts_on = destination_week_starts_on then
    raise check_violation using message = 'Choose a destination week different from the source week.';
  end if;

  select coalesce(
    array_agg(zone.name order by zone.name),
    array[]::text[]
  )
  into valid_time_zone_names
  from pg_catalog.pg_timezone_names zone;

  perform pg_advisory_xact_lock($cached_week_guard$;
  source_zone_guard text := $source_zone_guard$
    if source_shift.time_zone is null or not exists (
      select 1
      from pg_catalog.pg_timezone_names zone
      where zone.name = source_shift.time_zone
    ) then$source_zone_guard$;
  cached_source_zone_guard text := $cached_source_zone_guard$
    if source_shift.time_zone is null
      or array_position(valid_time_zone_names, source_shift.time_zone) is null
    then$cached_source_zone_guard$;
  destination_zone_guard text := $destination_zone_guard$
    if not exists (
      select 1
      from pg_catalog.pg_timezone_names zone
      where zone.name = destination_time_zone
    ) then$destination_zone_guard$;
  cached_destination_zone_guard text := $cached_destination_zone_guard$
    if destination_time_zone is null
      or array_position(valid_time_zone_names, destination_time_zone) is null
    then$cached_destination_zone_guard$;
begin
  select procedure.oid, pg_get_functiondef(procedure.oid)
  into function_oid, function_sql
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'replace_schedule_week_draft_from_revision'
    and pg_get_function_identity_arguments(procedure.oid) =
      'source_schedule_id uuid, destination_week_starts_on date, include_assignments boolean, include_events boolean';

  if function_oid is null then
    raise check_violation using message =
      'The atomic schedule week-copy function was not found; no timeout repair was applied.';
  end if;

  if position('valid_time_zone_names text[]' in function_sql) > 0 then
    if position('array_position(valid_time_zone_names, source_shift.time_zone)' in function_sql) > 0
       and position('array_position(valid_time_zone_names, destination_time_zone)' in function_sql) > 0
       and length(function_sql) - length(replace(function_sql, 'pg_catalog.pg_timezone_names', '')) = length('pg_catalog.pg_timezone_names')
    then
      return;
    end if;

    raise check_violation using message =
      'The schedule week-copy function contains an unexpected time-zone cache; no timeout repair was applied.';
  end if;

  if position(declaration_anchor in function_sql) = 0
     or position(week_guard_anchor in function_sql) = 0
     or position(source_zone_guard in function_sql) = 0
     or position(destination_zone_guard in function_sql) = 0
  then
    raise check_violation using message =
      'The schedule week-copy function no longer matches the reviewed time-zone boundary; no timeout repair was applied.';
  end if;

  updated_sql := replace(function_sql, declaration_anchor, cached_declaration);
  updated_sql := replace(updated_sql, week_guard_anchor, cached_week_guard);
  updated_sql := replace(updated_sql, source_zone_guard, cached_source_zone_guard);
  updated_sql := replace(updated_sql, destination_zone_guard, cached_destination_zone_guard);

  if updated_sql = function_sql
     or position(declaration_anchor in updated_sql) > 0
     or position(week_guard_anchor in updated_sql) > 0
     or position(source_zone_guard in updated_sql) > 0
     or position(destination_zone_guard in updated_sql) > 0
     or position('array_position(valid_time_zone_names, source_shift.time_zone)' in updated_sql) = 0
     or position('array_position(valid_time_zone_names, destination_time_zone)' in updated_sql) = 0
     or length(updated_sql) - length(replace(updated_sql, 'pg_catalog.pg_timezone_names', '')) <> length('pg_catalog.pg_timezone_names')
  then
    raise check_violation using message =
      'The schedule week-copy timeout repair could not be verified before installation.';
  end if;

  execute updated_sql;
end
$repair_schedule_week_copy_timezone_lookup_cache$;

comment on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) is
  'Atomically replaces a destination working draft from one exact source revision, preserving local wall-clock/DST behavior, schedule classification, assignments, audit history, and one cached valid time-zone set per copy.';

do $verify_schedule_week_copy_timezone_lookup_cache$
declare
  installed_definition text;
begin
  select pg_get_functiondef(
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)'::regprocedure
  ) into installed_definition;

  if installed_definition is null
     or position('valid_time_zone_names text[]' in installed_definition) = 0
     or position('array_position(valid_time_zone_names, source_shift.time_zone)' in installed_definition) = 0
     or position('array_position(valid_time_zone_names, destination_time_zone)' in installed_definition) = 0
     or length(installed_definition) - length(replace(installed_definition, 'pg_catalog.pg_timezone_names', '')) <> length('pg_catalog.pg_timezone_names')
     or position('security definer' in lower(installed_definition)) = 0
     or position('set search_path to ' || quote_literal('') in lower(installed_definition)) = 0
  then
    raise check_violation using message =
      'The schedule week-copy timeout repair did not install completely.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean)',
    'EXECUTE'
  ) then
    raise insufficient_privilege using message =
      'The schedule week-copy execution boundary was not preserved.';
  end if;
end
$verify_schedule_week_copy_timezone_lookup_cache$;

notify pgrst, 'reload schema';

commit;

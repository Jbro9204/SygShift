begin;

-- The atomic week-copy function predates work_type and assignment_type. The
-- later compatibility wrapper restored those values only after the base copy
-- had inserted assignments. That ordering made a valid concurrent Dispatch
-- duty look like a standard shift while the overlap trigger was running.
-- Patch only the copied-shift INSERT so every downstream assignment check sees
-- the source shift's authoritative classification from the start.
do $repair_schedule_week_copy_dispatch_overlap$
declare
  function_oid oid;
  function_sql text;
  updated_sql text;
  old_insert text := $old_insert$
    insert into public.shifts (
      schedule_id,
      post_id,
      event_id,
      starts_at,
      ends_at,
      time_zone,
      headcount_required,
      requires_armed,
      is_open,
      is_overtime,
      notes,
      created_by
    ) values (
      destination_schedule.id,
      source_shift.post_id,
      source_shift.event_id,
      shifted_start,
      shifted_end,
      source_shift.time_zone,
      source_shift.headcount_required,
      source_shift.requires_armed,
      true,
      source_shift.is_overtime,
      source_shift.notes,
      actor_id
    )
$old_insert$;
  corrected_insert text := $corrected_insert$
    insert into public.shifts (
      schedule_id,
      post_id,
      event_id,
      starts_at,
      ends_at,
      time_zone,
      headcount_required,
      requires_armed,
      is_open,
      is_overtime,
      notes,
      work_type,
      time_zone_source,
      time_zone_employee_id,
      assignment_type,
      created_by
    ) values (
      destination_schedule.id,
      source_shift.post_id,
      source_shift.event_id,
      shifted_start,
      shifted_end,
      source_shift.time_zone,
      source_shift.headcount_required,
      source_shift.requires_armed,
      true,
      source_shift.is_overtime,
      source_shift.notes,
      source_shift.work_type,
      source_shift.time_zone_source,
      source_shift.time_zone_employee_id,
      source_shift.assignment_type,
      actor_id
    )
$corrected_insert$;
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
      'The atomic schedule week-copy function was not found; no repair was applied.';
  end if;

  if position(corrected_insert in function_sql) > 0 then
    return;
  end if;

  if position(old_insert in function_sql) = 0 then
    raise check_violation using message =
      'The schedule week-copy function no longer matches the reviewed definition; no repair was applied.';
  end if;

  updated_sql := replace(function_sql, old_insert, corrected_insert);

  if updated_sql = function_sql
     or position(old_insert in updated_sql) > 0
     or position(corrected_insert in updated_sql) = 0 then
    raise check_violation using message =
      'The schedule week-copy repair could not be verified before installation.';
  end if;

  execute updated_sql;
end
$repair_schedule_week_copy_dispatch_overlap$;

revoke all on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean)
from public, anon;
grant execute on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean)
to authenticated;

comment on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) is
  'Atomically replaces a destination working draft from one exact source revision, preserving shift work and assignment classification before validating copied assignments.';

do $verify_schedule_week_copy_dispatch_overlap$
declare
  installed_definition text;
begin
  select pg_get_functiondef(procedure.oid)
  into installed_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'replace_schedule_week_draft_from_revision'
    and pg_get_function_identity_arguments(procedure.oid) =
      'source_schedule_id uuid, destination_week_starts_on date, include_assignments boolean, include_events boolean';

  if installed_definition is null
     or position('source_shift.work_type' in installed_definition) = 0
     or position('source_shift.time_zone_source' in installed_definition) = 0
     or position('source_shift.time_zone_employee_id' in installed_definition) = 0
     or position('source_shift.assignment_type' in installed_definition) = 0 then
    raise check_violation using message =
      'The schedule week-copy classification repair did not install completely.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)',
    'EXECUTE'
  ) then
    raise insufficient_privilege using message =
      'The schedule week-copy execution boundary was not preserved.';
  end if;
end
$verify_schedule_week_copy_dispatch_overlap$;

notify pgrst, 'reload schema';

commit;

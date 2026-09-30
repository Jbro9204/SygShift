begin;

set local lock_timeout = '5s';

-- A copied schedule must never assign someone through already-approved leave.
-- The existing assignment trigger correctly enforces that rule, but a normal
-- week copy used to abort the entire replacement when just one carried-forward
-- assignment overlapped approved time off in the destination week. Patch the
-- current reviewed function text only: lock the employee/leave record in the
-- same order as the trigger, leave that placement open, and account for it in
-- the copy result and audit record. All other copy, DST, audit, and assignment
-- safeguards remain unchanged.
do $repair_schedule_week_copy_approved_time_off_skip$
declare
  function_oid oid;
  function_sql text;
  updated_sql text;
  source_assignment_declaration_anchor text := $source_assignment_declaration_anchor$
  source_assignment public.shift_assignments%rowtype;
  copied_shift public.shifts%rowtype;$source_assignment_declaration_anchor$;
  guarded_source_assignment_declaration text := $guarded_source_assignment_declaration$
  source_assignment record;
  copied_shift public.shifts%rowtype;$guarded_source_assignment_declaration$;
  assignment_query_anchor text := $assignment_query_anchor$
        select assignment.*
        from public.shift_assignments assignment
        join public.employees employee on employee.id = assignment.employee_id$assignment_query_anchor$;
  guarded_assignment_query text := $guarded_assignment_query$
        select assignment.*, employee.time_zone as employee_time_zone
        from public.shift_assignments assignment
        join public.employees employee on employee.id = assignment.employee_id$guarded_assignment_query$;
  declaration_anchor text := $declaration_anchor$
  explicit_time_zone_source_count integer := 0;
  valid_time_zone_names text[];
begin$declaration_anchor$;
  guarded_declaration text := $guarded_declaration$
  explicit_time_zone_source_count integer := 0;
  valid_time_zone_names text[];
  skipped_approved_time_off_assignment_count integer := 0;
begin$guarded_declaration$;
  assignment_loop_anchor text := $assignment_loop_anchor$
      loop
        insert into public.schedule_assignment_overrides ($assignment_loop_anchor$;
  guarded_assignment_loop text := $guarded_assignment_loop$
      loop
        -- Serialize this precheck with time-off approvals before copying any
        -- related override or assignment record. The assignment trigger takes
        -- the same employee lock, so the insertion remains protected if a
        -- concurrent approval wins the race.
        perform private.lock_employee_schedule_time_off(source_assignment.employee_id);

        if exists (
          select 1
          from public.time_off_requests request
          where request.employee_id = source_assignment.employee_id
            and request.status = 'approved'
            and private.time_off_window(
              request.starts_on,
              request.ends_on,
              request.partial_day_start,
              request.partial_day_end,
              coalesce(
                nullif(request.submission_snapshot ->> 'timeZone', ''),
                source_assignment.employee_time_zone
              )
            ) && tstzrange(shifted_start, shifted_end, '[)')
        ) then
          skipped_approved_time_off_assignment_count :=
            skipped_approved_time_off_assignment_count + 1;
          continue;
        end if;

        insert into public.schedule_assignment_overrides ($guarded_assignment_loop$;
  assignment_invariant_anchor text := $assignment_invariant_anchor$
  if include_assignments and copied_assignment_count <> expected_assignment_count then$assignment_invariant_anchor$;
  guarded_assignment_invariant text := $guarded_assignment_invariant$
  if include_assignments
    and copied_assignment_count + skipped_approved_time_off_assignment_count <> expected_assignment_count
  then$guarded_assignment_invariant$;
  audit_anchor text := $audit_anchor$
      'skipped_inactive_assignment_count', skipped_inactive_assignment_count,
      'carried_credential_override_count', carried_credential_override_count,$audit_anchor$;
  guarded_audit text := $guarded_audit$
      'skipped_inactive_assignment_count', skipped_inactive_assignment_count,
      'skipped_approved_time_off_assignment_count', skipped_approved_time_off_assignment_count,
      'carried_credential_override_count', carried_credential_override_count,$guarded_audit$;
  result_anchor text := $result_anchor$
    'skippedInactiveAssignmentCount', skipped_inactive_assignment_count,
    'carriedCredentialOverrideCount', carried_credential_override_count,$result_anchor$;
  guarded_result text := $guarded_result$
    'skippedInactiveAssignmentCount', skipped_inactive_assignment_count,
    'skippedApprovedTimeOffAssignmentCount', skipped_approved_time_off_assignment_count,
    'carriedCredentialOverrideCount', carried_credential_override_count,$guarded_result$;
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
      'The atomic schedule week-copy function was not found; no approved-time-off repair was applied.';
  end if;

  if position('skipped_approved_time_off_assignment_count integer := 0' in function_sql) > 0 then
    if position('private.lock_employee_schedule_time_off(source_assignment.employee_id)' in function_sql) > 0
       and position('skippedApprovedTimeOffAssignmentCount' in function_sql) > 0
    then
      return;
    end if;

    raise check_violation using message =
      'The schedule week-copy function contains an unexpected approved-time-off repair; no change was applied.';
  end if;

  if position('valid_time_zone_names text[]' in function_sql) = 0
     or position(source_assignment_declaration_anchor in function_sql) = 0
     or position(assignment_query_anchor in function_sql) = 0
     or position(declaration_anchor in function_sql) = 0
     or position(assignment_loop_anchor in function_sql) = 0
     or position(assignment_invariant_anchor in function_sql) = 0
     or position(audit_anchor in function_sql) = 0
     or position(result_anchor in function_sql) = 0
  then
    raise check_violation using message =
      'The schedule week-copy function no longer matches the reviewed approved-time-off boundary; no change was applied.';
  end if;

  updated_sql := replace(function_sql, source_assignment_declaration_anchor, guarded_source_assignment_declaration);
  updated_sql := replace(updated_sql, declaration_anchor, guarded_declaration);
  updated_sql := replace(updated_sql, assignment_query_anchor, guarded_assignment_query);
  updated_sql := replace(updated_sql, assignment_loop_anchor, guarded_assignment_loop);
  updated_sql := replace(updated_sql, assignment_invariant_anchor, guarded_assignment_invariant);
  updated_sql := replace(updated_sql, audit_anchor, guarded_audit);
  updated_sql := replace(updated_sql, result_anchor, guarded_result);

  if updated_sql = function_sql
     or position(source_assignment_declaration_anchor in updated_sql) > 0
     or position(assignment_query_anchor in updated_sql) > 0
     or position(declaration_anchor in updated_sql) > 0
     or position(assignment_loop_anchor in updated_sql) > 0
     or position(assignment_invariant_anchor in updated_sql) > 0
     or position(audit_anchor in updated_sql) > 0
     or position(result_anchor in updated_sql) > 0
     or position('private.lock_employee_schedule_time_off(source_assignment.employee_id)' in updated_sql) = 0
     or position('source_assignment record;' in updated_sql) = 0
     or position('employee.time_zone as employee_time_zone' in updated_sql) = 0
     or position('skipped_approved_time_off_assignment_count' in updated_sql) = 0
     or position('skippedApprovedTimeOffAssignmentCount' in updated_sql) = 0
  then
    raise check_violation using message =
      'The schedule week-copy approved-time-off repair could not be verified before installation.';
  end if;

  execute updated_sql;
end
$repair_schedule_week_copy_approved_time_off_skip$;

comment on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) is
  'Atomically replaces a destination working draft from one exact source revision, preserving local wall-clock/DST behavior, schedule classification, assignments, audit history, cached valid time-zone names, and approved-time-off coverage safeguards.';

do $verify_schedule_week_copy_approved_time_off_skip$
declare
  installed_definition text;
begin
  select pg_get_functiondef(
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)'::regprocedure
  ) into installed_definition;

  if installed_definition is null
     or position('valid_time_zone_names text[]' in installed_definition) = 0
     or position('skipped_approved_time_off_assignment_count integer := 0' in installed_definition) = 0
     or position('private.lock_employee_schedule_time_off(source_assignment.employee_id)' in installed_definition) = 0
     or position('source_assignment record;' in installed_definition) = 0
     or position('employee.time_zone as employee_time_zone' in installed_definition) = 0
     or position('skippedApprovedTimeOffAssignmentCount' in installed_definition) = 0
     or position('security definer' in lower(installed_definition)) = 0
     or position('set search_path to ' || quote_literal('') in lower(installed_definition)) = 0
  then
    raise check_violation using message =
      'The schedule week-copy approved-time-off repair did not install completely.';
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
$verify_schedule_week_copy_approved_time_off_skip$;

notify pgrst, 'reload schema';

commit;

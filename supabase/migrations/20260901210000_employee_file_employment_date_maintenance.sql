begin;

-- This release installs the authorized maintenance workflow only. Applying the
-- migration must not change any employee, access, schedule, time, or payroll row.
create temporary table employee_file_date_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select md5(coalesce(string_agg(to_jsonb(employee)::text, '|' order by employee.id), '')) from public.employees employee) as employee_fingerprint,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_stage2_effective_date_authorizations) as effective_date_history_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from private.payroll_export_batches) as payroll_batch_count,
  (select count(*) from private.payroll_export_rows) as payroll_row_count;

create or replace function public.get_hr_employee_employment_date_history(
  target_employee_id uuid,
  target_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  safe_limit integer := case when target_limit between 1 and 10 then target_limit else 5 end;
  employee_exists boolean;
begin
  perform actor_id;

  select exists(select 1 from public.employees employee where employee.id = target_employee_id)
  into employee_exists;

  if not employee_exists then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  return jsonb_build_object(
    'canManage', public.has_effective_permission('hr.people.manage'),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', history.id,
        'hiredOn', history.hired_on,
        'separatedOn', history.separated_on,
        'sourceType', history.source_type,
        'sourceReference', history.source_reference,
        'reason', history.reason,
        'sourceStatus', history.source_status,
        'authorizedBy', concat_ws(' ', actor.first_name, nullif(actor.middle_name, ''), actor.last_name),
        'authorizedAt', history.authorized_at,
        'current', not exists (
          select 1
          from private.hr_stage2_effective_date_authorizations replacement
          where replacement.supersedes_id = history.id
        )
      ) order by history.authorized_at desc, history.id desc)
      from (
        select authz.*
        from private.hr_stage2_effective_date_authorizations authz
        where authz.employee_id = target_employee_id
        order by authz.authorized_at desc, authz.id desc
        limit safe_limit
      ) history
      join public.employees actor on actor.id = history.authorized_by
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.update_hr_employee_employment_dates(
  target_employee_id uuid,
  target_hired_on date,
  target_separated_on date,
  target_source_type text,
  target_source_reference text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hris_stage2_manager();
  employee_record public.employees%rowtype;
  active_authorization_id uuid;
  saved_id uuid;
  changed_at timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('employee-file-employment-dates:' || target_employee_id::text, 0));

  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee does not exist.';
  end if;

  if target_hired_on is null then
    raise check_violation using message = 'A verified start or hire date is required.';
  end if;

  if target_hired_on > current_date and employee_record.status::text <> 'onboarding' then
    raise check_violation using message = 'A future start date is allowed only for an onboarding employee.';
  end if;

  if target_separated_on is not null and target_separated_on < target_hired_on then
    raise check_violation using message = 'The separation or termination date cannot be before the start or hire date.';
  end if;

  if target_separated_on is not null and target_separated_on > current_date then
    raise check_violation using message = 'Use the Offboarding workflow to plan a future separation. Record the termination date here after it becomes effective.';
  end if;

  if employee_record.status::text = 'separated' and target_separated_on is null then
    raise check_violation using message = 'A separated employee requires a verified separation or termination date.';
  end if;

  if target_source_type not in ('hr_export', 'employee_file', 'verified_hr_record', 'verified_manual') then
    raise check_violation using message = 'Choose a supported employment-date evidence source.';
  end if;

  if char_length(btrim(coalesce(target_source_reference, ''))) < 3
    or char_length(btrim(coalesce(target_source_reference, ''))) > 300 then
    raise check_violation using message = 'Enter a source reference between 3 and 300 characters.';
  end if;

  if char_length(btrim(coalesce(target_reason, ''))) < 10
    or char_length(btrim(coalesce(target_reason, ''))) > 1000 then
    raise check_violation using message = 'Explain the update in 10 to 1,000 characters.';
  end if;

  if employee_record.hired_on is not distinct from target_hired_on
    and employee_record.separated_on is not distinct from target_separated_on then
    raise check_violation using message = 'No employment date changes were entered.';
  end if;

  select authz.id into active_authorization_id
  from private.hr_stage2_effective_date_authorizations authz
  where authz.employee_id = target_employee_id
    and not exists (
      select 1
      from private.hr_stage2_effective_date_authorizations replacement
      where replacement.supersedes_id = authz.id
    )
  order by authz.authorized_at desc, authz.id desc
  limit 1;

  insert into private.hr_stage2_effective_date_authorizations (
    employee_id,
    hired_on,
    separated_on,
    source_type,
    source_reference,
    reason,
    source_status,
    authorized_by,
    authorized_at,
    supersedes_id
  ) values (
    target_employee_id,
    target_hired_on,
    target_separated_on,
    target_source_type,
    btrim(target_source_reference),
    btrim(target_reason),
    employee_record.status::text,
    actor_id,
    changed_at,
    active_authorization_id
  ) returning id into saved_id;

  update public.employees employee
  set hired_on = target_hired_on,
      separated_on = target_separated_on,
      updated_at = changed_at
  where employee.id = target_employee_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'UPDATE_EMPLOYMENT_DATES',
    target_employee_id::text,
    jsonb_build_object(
      'hiredOn', employee_record.hired_on,
      'separatedOn', employee_record.separated_on
    ),
    jsonb_build_object(
      'hiredOn', target_hired_on,
      'separatedOn', target_separated_on,
      'sourceType', target_source_type,
      'sourceReference', btrim(target_source_reference),
      'reason', btrim(target_reason),
      'effectiveDateAuthorizationId', saved_id
    )
  );

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'hiredOn', target_hired_on,
    'separatedOn', target_separated_on,
    'changeId', saved_id,
    'updatedAt', changed_at
  );
end
$$;

revoke all on function public.get_hr_employee_employment_date_history(uuid, integer) from public, anon;
revoke all on function public.update_hr_employee_employment_dates(uuid, date, date, text, text, text) from public, anon;
grant execute on function public.get_hr_employee_employment_date_history(uuid, integer) to authenticated;
grant execute on function public.update_hr_employee_employment_dates(uuid, date, date, text, text, text) to authenticated;

comment on function public.get_hr_employee_employment_date_history(uuid, integer) is
  'Returns a bounded append-only employment-date evidence history for the protected Employee File.';
comment on function public.update_hr_employee_employment_dates(uuid, date, date, text, text, text) is
  'Updates permanent hire and separation dates with MFA, exact HR permission, validated evidence, and append-only history without rewriting operational or payroll records.';

do $$
declare
  baseline employee_file_date_release_baseline%rowtype;
  current_employee_fingerprint text;
begin
  select * into strict baseline from employee_file_date_release_baseline;
  select md5(coalesce(string_agg(to_jsonb(employee)::text, '|' order by employee.id), ''))
  into current_employee_fingerprint
  from public.employees employee;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_fingerprint <> current_employee_fingerprint
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.effective_date_history_count <> (select count(*) from private.hr_stage2_effective_date_authorizations)
    or baseline.shift_count <> (select count(*) from public.shifts)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.payroll_batch_count <> (select count(*) from private.payroll_export_batches)
    or baseline.payroll_row_count <> (select count(*) from private.payroll_export_rows) then
    raise exception 'Employee File employment-date release changed protected production records; the migration was rolled back.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

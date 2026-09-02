begin;

-- This release installs new protected workflows only. Applying it must not
-- change an employee, account, access assignment, schedule, punch, or payroll
-- record.
create temporary table hr_termination_role_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select md5(coalesce(string_agg(to_jsonb(employee)::text, '|' order by employee.id), '')) from public.employees employee) as employee_fingerprint,
  (select count(*) from private.employee_accounts) as account_count,
  (select md5(coalesce(string_agg(to_jsonb(account)::text, '|' order by account.employee_id), '')) from private.employee_accounts account) as account_fingerprint,
  (select count(*) from public.employee_access_roles) as access_assignment_count,
  (select md5(coalesce(string_agg(to_jsonb(assignment)::text, '|' order by assignment.employee_id, assignment.role_id), '')) from public.employee_access_roles assignment) as access_assignment_fingerprint,
  (select count(*) from public.shift_assignments) as shift_assignment_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from private.payroll_export_batches) as payroll_batch_count,
  (select count(*) from private.payroll_export_rows) as payroll_row_count;

create or replace function private.replace_employee_additional_access_roles(
  target_actor_id uuid,
  target_employee_id uuid,
  target_role_ids uuid[]
)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_primary_role public.app_role;
  clean_role_ids uuid[];
  old_role_ids uuid[];
begin
  select employee.role
  into employee_primary_role
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee does not exist.';
  end if;

  if exists (
    select 1
    from unnest(coalesce(target_role_ids, array[]::uuid[])) requested_role(id)
    left join public.access_roles access_role
      on access_role.id = requested_role.id
     and access_role.active
    where access_role.id is null
  ) then
    raise check_violation using message = 'One or more selected roles are not available.';
  end if;

  select coalesce(array_agg(distinct access_role.id order by access_role.id), array[]::uuid[])
  into clean_role_ids
  from unnest(coalesce(target_role_ids, array[]::uuid[])) requested_role(id)
  join public.access_roles access_role on access_role.id = requested_role.id
  where access_role.active
    and not (
      access_role.system_role
      and access_role.base_app_role = employee_primary_role
    );

  select coalesce(array_agg(assignment.role_id order by assignment.role_id), array[]::uuid[])
  into old_role_ids
  from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id;

  delete from public.employee_access_roles assignment
  where assignment.employee_id = target_employee_id
    and not (assignment.role_id = any(clean_role_ids));

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  select target_employee_id, requested_role.id, target_actor_id
  from unnest(clean_role_ids) requested_role(id)
  on conflict (employee_id, role_id) do update
  set assigned_by = excluded.assigned_by,
      assigned_at = clock_timestamp();

  if old_role_ids is distinct from clean_role_ids then
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
      target_actor_id,
      'public',
      'employee_access_roles',
      'UPDATE_FROM_USER_ACCOUNTS',
      target_employee_id::text,
      jsonb_build_object('roleIds', old_role_ids),
      jsonb_build_object('roleIds', clean_role_ids)
    );
  end if;

  return clean_role_ids;
end
$$;

revoke all on function private.replace_employee_additional_access_roles(uuid, uuid, uuid[]) from public, anon, authenticated;

create or replace function public.admin_create_employee_with_time_zone_and_access_roles(
  target_first_name text,
  target_middle_name text default null,
  target_last_name text default null,
  target_preferred_name text default null,
  target_role public.app_role default 'guard',
  target_employment_type public.employment_type default 'hourly',
  target_status public.employee_status default 'active',
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null,
  target_time_zone text default 'America/Denver',
  target_access_role_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  created_record jsonb;
begin
  created_record := public.admin_create_employee_with_time_zone(
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_role,
    target_employment_type,
    target_status,
    target_employee_number,
    target_job_title,
    target_personal_email,
    target_company_email,
    target_mobile_phone,
    target_time_zone
  );

  perform private.replace_employee_additional_access_roles(
    actor_id,
    (created_record ->> 'id')::uuid,
    target_access_role_ids
  );

  return private.admin_user_record((created_record ->> 'id')::uuid);
end
$$;

create or replace function public.admin_update_employee_with_time_zone_and_access_roles(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null,
  target_time_zone text default 'America/Denver',
  target_access_role_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  updated_record jsonb;
begin
  updated_record := public.admin_update_employee_with_time_zone(
    target_employee_id,
    target_first_name,
    target_middle_name,
    target_last_name,
    target_preferred_name,
    target_role,
    target_employment_type,
    target_status,
    target_employee_number,
    target_job_title,
    target_personal_email,
    target_company_email,
    target_mobile_phone,
    target_time_zone
  );

  perform private.replace_employee_additional_access_roles(
    actor_id,
    target_employee_id,
    target_access_role_ids
  );

  return private.admin_user_record(target_employee_id);
end
$$;

revoke all on function public.admin_create_employee_with_time_zone_and_access_roles(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) from public, anon;
revoke all on function public.admin_update_employee_with_time_zone_and_access_roles(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) from public, anon;
grant execute on function public.admin_create_employee_with_time_zone_and_access_roles(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) to authenticated;
grant execute on function public.admin_update_employee_with_time_zone_and_access_roles(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) to authenticated;

create or replace function public.terminate_hr_employee(
  target_employee_id uuid,
  target_terminated_on date,
  target_reason text,
  target_confirmation_username text
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
  separation_result jsonb;
  clean_reason text := btrim(coalesce(target_reason, ''));
  operational_today date := (clock_timestamp() at time zone 'America/Denver')::date;
  changed_at timestamptz := clock_timestamp();
begin
  if not public.has_effective_permission('hr.offboarding.approve') then
    raise insufficient_privilege using message = 'HR offboarding approval permission is required to terminate employment.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hr-employee-termination:' || target_employee_id::text, 0));

  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected employee does not exist.';
  end if;

  if actor_id = target_employee_id then
    raise insufficient_privilege using message = 'You cannot terminate your own employment record.';
  end if;

  if employee_record.role = 'admin' and not public.is_admin() then
    raise insufficient_privilege using message = 'Only an Admin can terminate an Admin employee.';
  end if;

  if employee_record.status::text = 'separated' then
    raise check_violation using message = 'This employee is already terminated.';
  end if;

  if lower(btrim(coalesce(target_confirmation_username, ''))) <> lower(employee_record.username) then
    raise check_violation using message = 'Enter the employee username exactly to confirm termination.';
  end if;

  if target_terminated_on is null then
    raise check_violation using message = 'A termination date is required.';
  end if;

  if target_terminated_on > operational_today then
    raise check_violation using message = 'Use the Offboarding workflow to plan a future termination.';
  end if;

  if employee_record.hired_on is not null and target_terminated_on < employee_record.hired_on then
    raise check_violation using message = 'The termination date cannot be before the employee start date.';
  end if;

  if char_length(clean_reason) < 10 or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'Explain the termination in 10 to 1,000 characters.';
  end if;

  separation_result := private.separate_employee_account_and_future_work(
    target_employee_id,
    actor_id,
    clean_reason,
    target_terminated_on
  );

  if employee_record.hired_on is not null then
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
      employee_record.hired_on,
      target_terminated_on,
      'employee_file',
      'Employee File termination action',
      clean_reason,
      'separated',
      actor_id,
      changed_at,
      active_authorization_id
    );
  end if;

  return separation_result || jsonb_build_object(
    'employeeId', target_employee_id,
    'legalName', concat_ws(' ', employee_record.first_name, nullif(employee_record.middle_name, ''), employee_record.last_name),
    'username', employee_record.username,
    'terminatedOn', target_terminated_on,
    'status', 'separated'
  );
end
$$;

revoke all on function public.terminate_hr_employee(uuid, date, text, text) from public, anon;
grant execute on function public.terminate_hr_employee(uuid, date, text, text) to authenticated;

create or replace function public.get_hr_employee_profile_editor_context(target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  can_manage_profile boolean := public.has_effective_permission('hr.people.manage');
  can_view_restricted boolean := public.has_effective_permission('hr.people.restricted');
  can_terminate boolean := can_manage_profile and public.has_effective_permission('hr.offboarding.approve');
  compensation_enabled boolean := coalesce((select gate.enabled from private.hr_compensation_release_gate gate where gate.singleton), false);
  result jsonb;
begin
  perform actor_id;

  select jsonb_build_object(
    'employeeId', employee.id,
    'workClassification', employee.work_classification,
    'canManageProfile', can_manage_profile,
    'canManageRestricted', can_manage_profile and can_view_restricted,
    'canTerminate', can_terminate,
    'canViewCompensation', compensation_enabled and (
      public.has_effective_permission('hr.compensation.view')
      or public.has_effective_permission('hr.compensation.manage')
    ),
    'canManageCompensation', compensation_enabled and public.has_effective_permission('hr.compensation.manage'),
    'canApproveCompensation', compensation_enabled and public.has_effective_permission('hr.compensation.approve'),
    'restrictedContactExtension', case when can_view_restricted then jsonb_build_object(
      'emergencyContactRelationship', contact.emergency_contact_relationship,
      'emergencyContactEmail', contact.emergency_contact_email
    ) else null end
  )
  into result
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.id = target_employee_id;

  if result is null then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  return result;
end
$$;

revoke all on function public.get_hr_employee_profile_editor_context(uuid) from public, anon;
grant execute on function public.get_hr_employee_profile_editor_context(uuid) to authenticated;

comment on function public.terminate_hr_employee(uuid, date, text, text) is
  'Terminates an employee from the protected Employee File with MFA, HR management and offboarding approval, exact confirmation, immediate access revocation, future-work release, and audit history.';
comment on function public.admin_create_employee_with_time_zone_and_access_roles(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) is
  'Creates an employee and atomically assigns every selected active access role from User Accounts.';
comment on function public.admin_update_employee_with_time_zone_and_access_roles(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text, text, uuid[]) is
  'Updates an employee and atomically replaces selected additional access roles from User Accounts.';

do $$
declare
  baseline hr_termination_role_release_baseline%rowtype;
begin
  select * into strict baseline from hr_termination_role_release_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_fingerprint <> (select md5(coalesce(string_agg(to_jsonb(employee)::text, '|' order by employee.id), '')) from public.employees employee)
    or baseline.account_count <> (select count(*) from private.employee_accounts)
    or baseline.account_fingerprint <> (select md5(coalesce(string_agg(to_jsonb(account)::text, '|' order by account.employee_id), '')) from private.employee_accounts account)
    or baseline.access_assignment_count <> (select count(*) from public.employee_access_roles)
    or baseline.access_assignment_fingerprint <> (select md5(coalesce(string_agg(to_jsonb(assignment)::text, '|' order by assignment.employee_id, assignment.role_id), '')) from public.employee_access_roles assignment)
    or baseline.shift_assignment_count <> (select count(*) from public.shift_assignments)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.payroll_batch_count <> (select count(*) from private.payroll_export_batches)
    or baseline.payroll_row_count <> (select count(*) from private.payroll_export_rows) then
    raise exception 'HR termination and role-assignment release changed protected production records; the migration was rolled back.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

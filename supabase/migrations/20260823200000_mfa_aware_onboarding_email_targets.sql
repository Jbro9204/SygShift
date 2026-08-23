begin;

create or replace function private.employee_requires_mfa(
  target_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      exists (
        select 1
        from public.access_roles base_role
        where base_role.base_app_role = employee.role
          and base_role.system_role
          and base_role.active
          and base_role.mfa_required
      )
      or exists (
        select 1
        from public.access_roles access_role
        join public.employee_access_roles assignment on assignment.role_id = access_role.id
        where assignment.employee_id = employee.id
          and access_role.mfa_required
          and access_role.active
      )
      or exists (
        select 1
        from public.employee_permission_overrides permission_override
        join public.permission_catalog permission on permission.code = permission_override.permission_code
        where permission_override.employee_id = employee.id
          and permission_override.active
          and permission_override.effect = 'grant'
          and permission.requires_mfa
          and permission.active
      )
    from public.employees employee
    where employee.id = target_employee_id
  ), false)
$$;

comment on function private.employee_requires_mfa(uuid) is
  'Uses the same base-role, assigned-role, and employee-permission rules as the authenticated session to determine whether an employee must complete MFA.';

create or replace function public.service_get_employee_login_email_target(
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Only the service role can read login email targets.';
  end if;

  return (
    select jsonb_build_object(
      'employeeId', employee.id,
      'username', employee.username,
      'authEmail', employee.username || '@accounts.sygshift.invalid',
      'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
      'role', employee.role,
      'employmentType', employee.employment_type,
      'status', employee.status,
      'existingAuthUserId', account.auth_user_id,
      'contactEmail', private.preferred_delivery_email(contact.personal_email, contact.company_email),
      'requiresMfa', private.employee_requires_mfa(employee.id)
    )
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    left join private.employee_contacts contact on contact.employee_id = employee.id
    where employee.id = target_employee_id
      and employee.status = 'active'
  );
end
$$;

create or replace function public.service_get_employee_login_email_targets(
  target_include_existing boolean default true
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.role()) <> 'service_role' then
      jsonb_build_array()
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', employee.id,
        'username', employee.username,
        'authEmail', employee.username || '@accounts.sygshift.invalid',
        'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
        'role', employee.role,
        'employmentType', employee.employment_type,
        'status', employee.status,
        'existingAuthUserId', account.auth_user_id,
        'contactEmail', private.preferred_delivery_email(contact.personal_email, contact.company_email),
        'requiresMfa', private.employee_requires_mfa(employee.id)
      ) order by employee.first_name, employee.last_name)
      from public.employees employee
      left join private.employee_accounts account on account.employee_id = employee.id
      left join private.employee_contacts contact on contact.employee_id = employee.id
      where employee.status = 'active'
        and (target_include_existing or account.employee_id is null)
    ), '[]'::jsonb)
  end
$$;

revoke all on function private.employee_requires_mfa(uuid) from public, anon, authenticated;
revoke all on function public.service_get_employee_login_email_target(uuid) from public, anon, authenticated;
revoke all on function public.service_get_employee_login_email_targets(boolean) from public, anon, authenticated;
grant execute on function private.employee_requires_mfa(uuid) to service_role;
grant execute on function public.service_get_employee_login_email_target(uuid) to service_role;
grant execute on function public.service_get_employee_login_email_targets(boolean) to service_role;

notify pgrst, 'reload schema';
commit;

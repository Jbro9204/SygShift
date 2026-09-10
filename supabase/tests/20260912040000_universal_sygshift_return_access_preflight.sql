begin;

do $$
declare
  eligible_guard_auth_user_id uuid;
begin
  if (
    select count(*)
    from public.permission_catalog catalog
    where catalog.code in ('apps.sygilant.access', 'apps.sygshift.access')
      and catalog.risk_level = 'critical'
      and catalog.requires_mfa
      and catalog.locked
      and catalog.active
  ) <> 2 then
    raise exception 'The reciprocal platform-launch catalog safeguards are not intact.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygshift.access'
      and role_permission.enabled
      and access_role.code <> all(array[
        'system_guard',
        'system_dispatcher',
        'system_scheduler',
        'system_recruiting_licensing',
        'system_supervisor',
        'system_admin',
        'custom_chief',
        'operations_manager',
        'human_resources',
        'human_resources_employee'
      ]::text[])
  ) then
    raise exception 'An unapproved role already has SygShift return access.';
  end if;

  if (
    select count(*)
    from public.access_roles access_role
    join public.access_role_permissions role_permission
      on role_permission.role_id = access_role.id
     and role_permission.permission_code = 'apps.sygshift.access'
     and role_permission.enabled
    where access_role.code = any(array[
      'system_guard',
      'system_dispatcher',
      'system_scheduler',
      'system_recruiting_licensing',
      'system_supervisor',
      'system_admin',
      'custom_chief',
      'operations_manager',
      'human_resources',
      'human_resources_employee'
    ]::text[])
  ) = 10 then
    raise exception 'Universal SygShift return access is already present; stop before applying the release.';
  end if;

  select account.auth_user_id
  into eligible_guard_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = 'guard'
    and account.disabled_at is null
    and not private.employee_requires_mfa(employee.id)
    and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  if eligible_guard_auth_user_id is null then
    raise exception 'Reciprocal return preflight requires an active eligible Guard without exposing that identity.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', eligible_guard_auth_user_id::text, 'aal', 'aal1', 'role', 'authenticated')::text,
    true
  );

  if not ('apps.sygilant.access' = any(public.get_effective_permissions()))
     or 'apps.sygshift.access' = any(public.get_effective_permissions()) then
    raise exception 'The expected one-way Guard AAL1 launcher defect was not reproduced.';
  end if;

  if exists (
    select 1
    from unnest(public.get_effective_permissions()) projected(permission_code)
    join public.permission_catalog catalog on catalog.code = projected.permission_code
    where catalog.requires_mfa
      and projected.permission_code <> 'apps.sygilant.access'
  ) then
    raise exception 'The preflight found an unrelated MFA-sensitive permission in the Guard AAL1 session.';
  end if;
end
$$;

rollback;

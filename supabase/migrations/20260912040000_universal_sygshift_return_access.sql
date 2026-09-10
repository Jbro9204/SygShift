begin;
set local lock_timeout = '5s';

create temporary table sygshift_return_role_policy on commit drop as
select *
from (values
  ('system_guard'::text, false),
  ('system_dispatcher'::text, true),
  ('system_scheduler'::text, true),
  ('system_recruiting_licensing'::text, true),
  ('system_supervisor'::text, true),
  ('system_admin'::text, true),
  ('custom_chief'::text, true),
  ('operations_manager'::text, true),
  ('human_resources'::text, true),
  ('human_resources_employee'::text, true)
) expected(role_code, mfa_required);

do $$
begin
  if to_regprocedure('private.employee_effective_permissions(uuid)') is null
     or to_regprocedure('private.employee_requires_mfa(uuid)') is null
     or to_regprocedure('private.current_employee_id()') is null
     or to_regprocedure('public.has_mfa()') is null then
    raise check_violation
      using message = 'The protected SygShift access-control functions must exist before reciprocal return access is released.';
  end if;

  if (
    select count(*)
    from sygshift_return_role_policy expected
    join public.access_roles access_role
      on access_role.code = expected.role_code
     and access_role.active
     and access_role.mfa_required = expected.mfa_required
  ) <> 10 then
    raise check_violation
      using message = 'One or more approved platform roles are unavailable or have an unexpected MFA policy.';
  end if;

  if not exists (
    select 1
    from public.access_roles access_role
    where access_role.code = 'system_guard'
      and access_role.base_app_role = 'guard'
      and access_role.system_role
      and access_role.protected
      and not access_role.mfa_required
      and access_role.active
  ) then
    raise check_violation
      using message = 'The protected Guard role mapping is unavailable; reciprocal AAL1 access was not released.';
  end if;

  if (
    select count(*)
    from public.permission_catalog catalog
    where catalog.code in ('apps.sygilant.access', 'apps.sygshift.access')
      and catalog.risk_level = 'critical'
      and catalog.requires_mfa
      and catalog.locked
      and catalog.active
  ) <> 2 then
    raise check_violation
      using message = 'One or more protected platform-launch permissions are unavailable or their safeguards changed.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygshift.access'
      and role_permission.enabled
      and not exists (
        select 1
        from sygshift_return_role_policy expected
        where expected.role_code = access_role.code
      )
  ) then
    raise check_violation
      using message = 'An unapproved role already has SygShift return access; no universal release was applied.';
  end if;
end
$$;

create temporary table sygshift_return_protected_baseline on commit drop as
select jsonb_build_object(
  'employees', jsonb_build_object(
    'count', (select count(*) from public.employees),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(employee)::text, '|' order by employee.id)), md5(''))
      from public.employees employee
    )
  ),
  'employeeAccounts', jsonb_build_object(
    'count', (select count(*) from private.employee_accounts),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(account)::text, '|' order by account.employee_id)), md5(''))
      from private.employee_accounts account
    )
  ),
  'employeeAccessRoles', jsonb_build_object(
    'count', (select count(*) from public.employee_access_roles),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(assignment)::text, '|' order by assignment.employee_id, assignment.role_id)), md5(''))
      from public.employee_access_roles assignment
    )
  ),
  'employeePermissionOverrides', jsonb_build_object(
    'count', (select count(*) from public.employee_permission_overrides),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(permission_override)::text, '|' order by permission_override.id)), md5(''))
      from public.employee_permission_overrides permission_override
    )
  ),
  'accessRoles', jsonb_build_object(
    'count', (select count(*) from public.access_roles),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(access_role)::text, '|' order by access_role.id)), md5(''))
      from public.access_roles access_role
    )
  ),
  'permissionCatalog', jsonb_build_object(
    'count', (select count(*) from public.permission_catalog),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(catalog)::text, '|' order by catalog.code)), md5(''))
      from public.permission_catalog catalog
    )
  ),
  'unrelatedRolePermissions', jsonb_build_object(
    'count', (
      select count(*)
      from public.access_role_permissions role_permission
      where role_permission.permission_code <> 'apps.sygshift.access'
    ),
    'fingerprint', (
      select coalesce(md5(string_agg(to_jsonb(role_permission)::text, '|' order by role_permission.role_id, role_permission.permission_code)), md5(''))
      from public.access_role_permissions role_permission
      where role_permission.permission_code <> 'apps.sygshift.access'
    )
  )
) as snapshot;

create temporary table sygshift_return_target_baseline on commit drop as
select
  access_role.id as role_id,
  access_role.code as role_code,
  expected.mfa_required,
  coalesce(role_permission.enabled, false) as previously_enabled
from sygshift_return_role_policy expected
join public.access_roles access_role on access_role.code = expected.role_code
left join public.access_role_permissions role_permission
  on role_permission.role_id = access_role.id
 and role_permission.permission_code = 'apps.sygshift.access';

insert into public.access_role_permissions (role_id, permission_code, enabled)
select baseline.role_id, 'apps.sygshift.access', true
from sygshift_return_target_baseline baseline
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

insert into private.audit_events (
  auth_user_id,
  employee_id,
  request_id,
  schema_name,
  table_name,
  operation,
  row_id,
  old_record,
  new_record
)
select
  null,
  null,
  'migration:20260912040000',
  'public',
  'access_role_permissions',
  'UPDATE',
  baseline.role_id::text,
  jsonb_build_object(
    'enabled', baseline.previously_enabled,
    'permissionCode', 'apps.sygshift.access',
    'roleCode', baseline.role_code,
    'source', 'universal-sygshift-return-release'
  ),
  jsonb_build_object(
    'enabled', true,
    'mfaRequired', baseline.mfa_required,
    'permissionCode', 'apps.sygshift.access',
    'roleCode', baseline.role_code,
    'source', 'universal-sygshift-return-release'
  )
from sygshift_return_target_baseline baseline
where not baseline.previously_enabled;

-- Both platform launch permissions remain critical and MFA-protected in the
-- catalog. Only an active canonical Guard whose complete access profile does
-- not require MFA may receive them at AAL1. Direct employee denials remain
-- authoritative because projection starts with employee_effective_permissions.
create or replace function public.get_effective_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select
      employee.id as employee_id,
      employee.role,
      private.employee_requires_mfa(employee.id) as requires_mfa,
      public.has_mfa() as has_mfa
    from public.employees employee
    where employee.id = private.current_employee_id()
      and employee.status = 'active'
    limit 1
  )
  select coalesce(array_agg(granted.permission_code order by granted.permission_code), array[]::text[])
  from actor
  cross join lateral unnest(private.employee_effective_permissions(actor.employee_id)) as granted(permission_code)
  join public.permission_catalog catalog on catalog.code = granted.permission_code
  where catalog.active
    and (
      not catalog.requires_mfa
      or actor.has_mfa
      or (
        granted.permission_code in ('apps.sygilant.access', 'apps.sygshift.access')
        and actor.role = 'guard'
        and not actor.requires_mfa
      )
    )
$$;

comment on function public.get_effective_permissions() is
  'Returns the current active employee effective permissions after MFA projection. The only AAL1 exceptions are the reciprocal Sygilant and SygShift launch permissions for a canonical Guard whose complete access profile does not require MFA; direct denials remain authoritative.';

revoke all on function public.get_effective_permissions() from public, anon;
grant execute on function public.get_effective_permissions() to authenticated;

do $$
declare
  baseline jsonb;
  current_state jsonb;
begin
  select snapshot into strict baseline from sygshift_return_protected_baseline;

  select jsonb_build_object(
    'employees', jsonb_build_object(
      'count', (select count(*) from public.employees),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(employee)::text, '|' order by employee.id)), md5(''))
        from public.employees employee
      )
    ),
    'employeeAccounts', jsonb_build_object(
      'count', (select count(*) from private.employee_accounts),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(account)::text, '|' order by account.employee_id)), md5(''))
        from private.employee_accounts account
      )
    ),
    'employeeAccessRoles', jsonb_build_object(
      'count', (select count(*) from public.employee_access_roles),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(assignment)::text, '|' order by assignment.employee_id, assignment.role_id)), md5(''))
        from public.employee_access_roles assignment
      )
    ),
    'employeePermissionOverrides', jsonb_build_object(
      'count', (select count(*) from public.employee_permission_overrides),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(permission_override)::text, '|' order by permission_override.id)), md5(''))
        from public.employee_permission_overrides permission_override
      )
    ),
    'accessRoles', jsonb_build_object(
      'count', (select count(*) from public.access_roles),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(access_role)::text, '|' order by access_role.id)), md5(''))
        from public.access_roles access_role
      )
    ),
    'permissionCatalog', jsonb_build_object(
      'count', (select count(*) from public.permission_catalog),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(catalog)::text, '|' order by catalog.code)), md5(''))
        from public.permission_catalog catalog
      )
    ),
    'unrelatedRolePermissions', jsonb_build_object(
      'count', (
        select count(*)
        from public.access_role_permissions role_permission
        where role_permission.permission_code <> 'apps.sygshift.access'
      ),
      'fingerprint', (
        select coalesce(md5(string_agg(to_jsonb(role_permission)::text, '|' order by role_permission.role_id, role_permission.permission_code)), md5(''))
        from public.access_role_permissions role_permission
        where role_permission.permission_code <> 'apps.sygshift.access'
      )
    )
  ) into current_state;

  if baseline is distinct from current_state then
    raise exception 'Universal SygShift return access changed a protected identity, account, assignment, override, role, catalog, or unrelated permission record.';
  end if;

  if (
    select count(*)
    from sygshift_return_role_policy expected
    join public.access_roles access_role
      on access_role.code = expected.role_code
     and access_role.active
     and access_role.mfa_required = expected.mfa_required
    join public.access_role_permissions role_permission
      on role_permission.role_id = access_role.id
     and role_permission.permission_code = 'apps.sygshift.access'
     and role_permission.enabled
  ) <> 10 then
    raise exception 'SygShift return access was not enabled for all ten approved roles with the approved MFA policy.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygshift.access'
      and role_permission.enabled
      and not exists (
        select 1
        from sygshift_return_role_policy expected
        where expected.role_code = access_role.code
      )
  ) then
    raise exception 'SygShift return access was enabled for an unapproved role.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;

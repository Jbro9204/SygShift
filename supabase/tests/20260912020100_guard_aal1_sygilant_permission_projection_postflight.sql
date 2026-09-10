with projection as (
  select pg_catalog.pg_get_functiondef(procedure_record.oid) as definition
  from pg_catalog.pg_proc procedure_record
  join pg_catalog.pg_namespace namespace_record
    on namespace_record.oid = procedure_record.pronamespace
  where namespace_record.nspname = 'public'
    and procedure_record.proname = 'get_effective_permissions'
    and pg_catalog.pg_get_function_identity_arguments(procedure_record.oid) = ''
), guard_role as (
  select access_role.id
  from public.access_roles access_role
  where access_role.code = 'system_guard'
    and access_role.base_app_role = 'guard'
    and access_role.active
    and not access_role.mfa_required
)
select jsonb_build_object(
  'projectionInstalled', coalesce((
    select position('apps.sygilant.access' in definition) > 0
      and position('employee.role = ''guard''' in definition) > 0
      and position('not private.employee_requires_mfa(employee.id)' in definition) > 0
      and position('private.employee_effective_permissions(actor.employee_id)' in definition) > 0
    from projection
  ), false),
  'guardRolePolicyValid', exists (select 1 from guard_role),
  'guardLaunchGrantEnabled', exists (
    select 1
    from guard_role
    join public.access_role_permissions role_permission
      on role_permission.role_id = guard_role.id
     and role_permission.permission_code = 'apps.sygilant.access'
     and role_permission.enabled
  ),
  'launchPermissionStillProtected', exists (
    select 1
    from public.permission_catalog catalog
    where catalog.code = 'apps.sygilant.access'
      and catalog.active
      and catalog.requires_mfa
      and catalog.locked
      and catalog.risk_level = 'critical'
  )
) as guard_aal1_sygilant_permission_projection_postflight;

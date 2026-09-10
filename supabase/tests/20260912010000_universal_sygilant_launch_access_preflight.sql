select jsonb_build_object(
  'approvedRoles', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'code', access_role.code,
      'active', access_role.active,
      'mfaRequired', access_role.mfa_required,
      'sygilantAccess', coalesce(role_permission.enabled, false)
    ) order by access_role.code), '[]'::jsonb)
    from public.access_roles access_role
    left join public.access_role_permissions role_permission
      on role_permission.role_id = access_role.id
     and role_permission.permission_code = 'apps.sygilant.access'
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
  ),
  'permission', (
    select jsonb_build_object(
      'active', catalog.active,
      'locked', catalog.locked,
      'requiresMfa', catalog.requires_mfa,
      'riskLevel', catalog.risk_level
    )
    from public.permission_catalog catalog
    where catalog.code = 'apps.sygilant.access'
  ),
  'sharedIdentityAssuranceConstraint', (
    select pg_catalog.pg_get_constraintdef(constraint_record.oid)
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.shared_identity_sessions'::regclass
      and constraint_record.conname = 'shared_identity_sessions_assurance_level_check'
  ),
  'sygilantAssuranceConstraint', (
    select pg_catalog.pg_get_constraintdef(constraint_record.oid)
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
      and constraint_record.conname = 'sygilant_shared_launch_assurance'
  ),
  'unapprovedRoleGrantCount', (
    select count(*)
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygilant.access'
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
  )
) as universal_sygilant_launch_preflight;

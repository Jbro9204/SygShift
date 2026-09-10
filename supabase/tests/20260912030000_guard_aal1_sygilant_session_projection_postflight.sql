select jsonb_build_object(
  'migrationRecorded', exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = '20260912030000'
  ),
  'catalogSafeguardIntact', exists (
    select 1
    from public.permission_catalog catalog
    where catalog.code = 'apps.sygilant.access'
      and catalog.risk_level = 'critical'
      and catalog.requires_mfa
      and catalog.locked
      and catalog.active
  ),
  'authenticatedCanExecute', has_function_privilege(
    'authenticated',
    'public.get_effective_permissions()',
    'EXECUTE'
  ),
  'anonymousCanExecute', has_function_privilege(
    'anon',
    'public.get_effective_permissions()',
    'EXECUTE'
  ),
  'eligibleGuardUnderlyingGrantCount', (
    select count(*)
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and employee.role = 'guard'
      and account.disabled_at is null
      and not private.employee_requires_mfa(employee.id)
      and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  ),
  'mfaRequiredLaunchSubjectCount', (
    select count(*)
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and account.disabled_at is null
      and private.employee_requires_mfa(employee.id)
      and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  )
) as guard_aal1_sygilant_projection_postflight;

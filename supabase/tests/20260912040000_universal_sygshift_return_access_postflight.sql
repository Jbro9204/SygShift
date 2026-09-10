with approved_roles(role_code, mfa_required) as (
  values
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
), role_matrix as (
  select
    approved.role_code,
    approved.mfa_required as expected_mfa_required,
    access_role.active,
    access_role.mfa_required,
    coalesce(role_permission.enabled, false) as sygshift_access
  from approved_roles approved
  left join public.access_roles access_role on access_role.code = approved.role_code
  left join public.access_role_permissions role_permission
    on role_permission.role_id = access_role.id
   and role_permission.permission_code = 'apps.sygshift.access'
)
select jsonb_build_object(
  'migrationRecorded', exists (
    select 1
    from supabase_migrations.schema_migrations migration
    where migration.version = '20260912040000'
  ),
  'roleMatrix', (
    select jsonb_agg(to_jsonb(role_matrix) order by role_code)
    from role_matrix
  ),
  'approvedRoleGrantCount', (
    select count(*) from role_matrix where sygshift_access
  ),
  'unapprovedRoleGrantCount', (
    select count(*)
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygshift.access'
      and role_permission.enabled
      and access_role.code <> all(array(
        select approved.role_code from approved_roles approved
      ))
  ),
  'catalogSafeguardCount', (
    select count(*)
    from public.permission_catalog catalog
    where catalog.code in ('apps.sygilant.access', 'apps.sygshift.access')
      and catalog.risk_level = 'critical'
      and catalog.requires_mfa
      and catalog.locked
      and catalog.active
  ),
  'guardUnderlyingReciprocalGrantCount', (
    select count(*)
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and employee.role = 'guard'
      and account.disabled_at is null
      and not private.employee_requires_mfa(employee.id)
      and array['apps.sygilant.access', 'apps.sygshift.access']::text[]
        <@ private.employee_effective_permissions(employee.id)
  ),
  'projectionContainsReciprocalGuardException', (
    select position(
      'apps.sygilant.access' in pg_get_functiondef('public.get_effective_permissions()'::regprocedure)
    ) > 0 and position(
      'apps.sygshift.access' in pg_get_functiondef('public.get_effective_permissions()'::regprocedure)
    ) > 0
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
  )
) as universal_sygshift_return_postflight;

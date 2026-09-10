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
    coalesce(role_permission.enabled, false) as sygilant_access
  from approved_roles approved
  left join public.access_roles access_role on access_role.code = approved.role_code
  left join public.access_role_permissions role_permission
    on role_permission.role_id = access_role.id
   and role_permission.permission_code = 'apps.sygilant.access'
), employee_role_scope as (
  select employee.id as employee_id, access_role.code as role_code
  from public.employees employee
  join public.access_roles access_role
    on access_role.system_role
   and access_role.base_app_role = employee.role
   and access_role.active
  where employee.status = 'active'
  union
  select assignment.employee_id, access_role.code
  from public.employee_access_roles assignment
  join public.access_roles access_role
    on access_role.id = assignment.role_id
   and access_role.active
  join public.employees employee
    on employee.id = assignment.employee_id
   and employee.status = 'active'
), approved_employees as (
  select distinct role_scope.employee_id
  from employee_role_scope role_scope
  join approved_roles approved on approved.role_code = role_scope.role_code
)
select jsonb_build_object(
  'roleMatrix', (
    select jsonb_agg(to_jsonb(role_matrix) order by role_code)
    from role_matrix
  ),
  'approvedRoleGrantCount', (
    select count(*) from role_matrix where sygilant_access
  ),
  'approvedEmployeePermissionFailureCount', (
    select count(*)
    from approved_employees approved_employee
    where not ('apps.sygilant.access' = any(private.employee_effective_permissions(approved_employee.employee_id)))
  ),
  'guardOnlyAal1EligibleCount', (
    select count(*)
    from public.employees employee
    where employee.status = 'active'
      and employee.role = 'guard'
      and private.sygilant_launch_assurance_allowed(employee.id, 'aal1')
      and private.shared_identity_session_assurance_allowed(employee.id, 'aal1')
  ),
  'nonGuardAal1PolicyViolationCount', (
    select count(*)
    from public.employees employee
    where employee.status = 'active'
      and employee.role <> 'guard'
      and (
        private.sygilant_launch_assurance_allowed(employee.id, 'aal1')
        or private.shared_identity_session_assurance_allowed(employee.id, 'aal1')
      )
  ),
  'mfaRequiredGuardAal1PolicyViolationCount', (
    select count(*)
    from public.employees employee
    where employee.status = 'active'
      and employee.role = 'guard'
      and private.employee_requires_mfa(employee.id)
      and (
        private.sygilant_launch_assurance_allowed(employee.id, 'aal1')
        or private.shared_identity_session_assurance_allowed(employee.id, 'aal1')
      )
  ),
  'invalidOutgoingAal1LedgerCount', (
    select count(*)
    from private.sygilant_shared_launches launch
    where launch.assurance_level = 'aal1'
      and not private.sygilant_launch_assurance_allowed(launch.employee_id, launch.assurance_level)
  ),
  'invalidIncomingAal1SessionCount', (
    select count(*)
    from private.shared_identity_sessions shared_session
    where shared_session.assurance_level = 'aal1'
      and not private.shared_identity_session_assurance_allowed(shared_session.employee_id, shared_session.assurance_level)
  ),
  'outgoingAssuranceConstraint', (
    select pg_catalog.pg_get_constraintdef(constraint_record.oid)
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
      and constraint_record.conname = 'sygilant_shared_launch_assurance'
  ),
  'outgoingGuardConstraint', (
    select pg_catalog.pg_get_constraintdef(constraint_record.oid)
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
      and constraint_record.conname = 'sygilant_shared_launch_guard_aal1'
  ),
  'incomingAssuranceConstraint', (
    select pg_catalog.pg_get_constraintdef(constraint_record.oid)
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.shared_identity_sessions'::regclass
      and constraint_record.conname = 'shared_identity_sessions_assurance_level_check'
  )
) as universal_sygilant_launch_postflight;

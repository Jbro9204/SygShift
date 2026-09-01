create temporary table human_resources_employee_split_baseline on commit drop as
select
  (select id from public.access_roles where code = 'human_resources') as manager_role_id,
  (select count(*) from public.employee_access_roles) as assignment_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5(''))
     from public.employee_access_roles
    where role_id <> (select id from public.access_roles where code = 'human_resources')) as unrelated_assignment_fingerprint,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides) as override_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
     from public.access_roles
    where code <> 'human_resources') as unrelated_role_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
     from public.access_role_permissions
    where role_id <> (select id from public.access_roles where code = 'human_resources')) as unrelated_permission_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', code, category, name, coalesce(description, ''), risk_level, requires_mfa::text, locked::text, active::text), '|' order by code)), md5('')) from public.permission_catalog) as permission_catalog_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
     from public.access_roles
    where code = 'human_resources') as manager_role_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
     from public.access_role_permissions
    where role_id = (select id from public.access_roles where code = 'human_resources')) as manager_permission_fingerprint;

create temporary table human_resources_employee_assignments_to_restore on commit drop as
select employee_id, role_id, assigned_by, assigned_at
from public.employee_access_roles
where role_id = (select id from public.access_roles where code = 'human_resources');

do $$
begin
  if (select manager_role_id from human_resources_employee_split_baseline) is null then
    raise exception 'Human Resources Manager role is unavailable.';
  end if;

  if (select count(*) from human_resources_employee_assignments_to_restore) <> 1 then
    raise exception 'Expected exactly one prior Human Resources assignment to restore; found %.', (select count(*) from human_resources_employee_assignments_to_restore);
  end if;

  if exists (select 1 from public.access_roles where code = 'human_resources_employee') then
    raise exception 'Human Resources Employee role already exists; refusing to overwrite it.';
  end if;
end
$$;

insert into public.access_roles (
  code,
  name,
  description,
  base_app_role,
  system_role,
  protected,
  mfa_required,
  active
)
values (
  'human_resources_employee',
  'Human Resources Employee',
  'Protected ordinary HR employee-lifecycle authority for recruiting, onboarding, people records, ordinary HR documents, leave, benefits, talent, learning, employee relations, non-restricted safety, assets, offboarding, HR reporting, communications, and limited account recovery. Compensation, payroll, security administration, and highly restricted vaults remain excluded.',
  null,
  false,
  true,
  true,
  true
);

do $$
declare
  approved_permissions constant text[] := array[
    'accountability.view',
    'actions.self.view',
    'admin.users.invite',
    'admin.users.password_reset',
    'admin.users.view',
    'announcements.acknowledgments.manage',
    'announcements.send',
    'announcements.view',
    'availability.manage',
    'availability.view',
    'directory.edit_basic',
    'directory.edit_credentials',
    'directory.view',
    'hr.assets.approve',
    'hr.assets.manage',
    'hr.assets.view',
    'hr.automation.manage',
    'hr.automation.operate',
    'hr.automation.view',
    'hr.benefits.approve',
    'hr.benefits.manage',
    'hr.benefits.view',
    'hr.cases.manage',
    'hr.cases.restricted',
    'hr.cases.view',
    'hr.documents.disciplinary',
    'hr.documents.disciplinary_manage',
    'hr.documents.legal_safety',
    'hr.documents.legal_safety_manage',
    'hr.documents.manage',
    'hr.documents.view',
    'hr.learning.assign',
    'hr.learning.manage',
    'hr.learning.view',
    'hr.leave.approve',
    'hr.leave.manage',
    'hr.leave.view',
    'hr.offboarding.approve',
    'hr.offboarding.manage',
    'hr.offboarding.view',
    'hr.onboarding.approve',
    'hr.onboarding.manage',
    'hr.onboarding.view',
    'hr.people.manage',
    'hr.people.restricted',
    'hr.people.view',
    'hr.recruiting.approve',
    'hr.recruiting.manage',
    'hr.recruiting.view',
    'hr.reporting.export',
    'hr.reporting.manage',
    'hr.reporting.schedule',
    'hr.reporting.view',
    'hr.safety.manage',
    'hr.safety.view',
    'hr.self_service.manage',
    'hr.self_service.view',
    'hr.talent.manage',
    'hr.talent.restricted',
    'hr.talent.view',
    'licensing.communicate',
    'licensing.manage',
    'licensing.view',
    'notifications.view',
    'operations.view',
    'reports.export',
    'reports.view',
    'requests.manage',
    'requests.view',
    'schedule.self.view',
    'schedule.view',
    'time.punch',
    'time.reports.view',
    'time.self.view',
    'time.view',
    'training.export',
    'training.manage',
    'training.view'
  ]::text[];
  baseline human_resources_employee_split_baseline%rowtype;
  manager_id uuid;
  employee_role_id uuid;
  missing_permission text;
begin
  select * into strict baseline from human_resources_employee_split_baseline;
  manager_id := baseline.manager_role_id;
  select id into strict employee_role_id from public.access_roles where code = 'human_resources_employee';

  select requested_permission.code into missing_permission
  from unnest(approved_permissions) requested_permission(code)
  left join public.permission_catalog catalog
    on catalog.code = requested_permission.code
   and catalog.active
  where catalog.code is null
  limit 1;

  if missing_permission is not null then
    raise exception 'Human Resources Employee requires unavailable permission %.', missing_permission;
  end if;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select employee_role_id, requested_permission.code, true
  from unnest(approved_permissions) requested_permission(code);

  insert into public.employee_access_roles (employee_id, role_id, assigned_by, assigned_at)
  select employee_id, employee_role_id, assigned_by, assigned_at
  from human_resources_employee_assignments_to_restore;

  delete from public.employee_access_roles
  where role_id = manager_id
    and employee_id in (select employee_id from human_resources_employee_assignments_to_restore);

  insert into private.audit_events (schema_name, table_name, operation, row_id, old_record, new_record)
  select
    'public',
    'employee_access_roles',
    'UPDATE',
    restored.employee_id::text,
    jsonb_build_object('roleCode', 'human_resources', 'roleName', 'Human Resources Manager'),
    jsonb_build_object('roleCode', 'human_resources_employee', 'roleName', 'Human Resources Employee', 'reason', 'Restored the original ordinary HR boundary after the Manager role was separated.')
  from human_resources_employee_assignments_to_restore restored;

  if baseline.manager_role_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
    from public.access_roles
    where code = 'human_resources'
  ) then
    raise exception 'Human Resources Employee split changed the Manager role definition.';
  end if;

  if baseline.manager_permission_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
    from public.access_role_permissions
    where role_id = manager_id
  ) then
    raise exception 'Human Resources Employee split changed the Manager permission bundle.';
  end if;

  if baseline.unrelated_role_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
    from public.access_roles
    where code not in ('human_resources', 'human_resources_employee')
  ) then
    raise exception 'Human Resources Employee split changed another role definition.';
  end if;

  if baseline.unrelated_permission_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
    from public.access_role_permissions
    where role_id not in (manager_id, employee_role_id)
  ) then
    raise exception 'Human Resources Employee split changed another role permission bundle.';
  end if;

  if baseline.permission_catalog_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', code, category, name, coalesce(description, ''), risk_level, requires_mfa::text, locked::text, active::text), '|' order by code)), md5(''))
    from public.permission_catalog
  ) then
    raise exception 'Human Resources Employee split changed the permission catalog.';
  end if;

  if baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.override_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides)
  then
    raise exception 'Human Resources Employee split changed an individual permission override.';
  end if;

  if baseline.assignment_count <> (select count(*) from public.employee_access_roles)
    or baseline.unrelated_assignment_fingerprint <> (
      select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5(''))
      from public.employee_access_roles
      where role_id not in (manager_id, employee_role_id)
    )
  then
    raise exception 'Human Resources Employee split changed an unrelated employee role assignment.';
  end if;

  if exists (select 1 from public.employee_access_roles where role_id = manager_id) then
    raise exception 'Human Resources Manager must remain separately assignable after restoring the prior HR assignment.';
  end if;

  if exists (
    select 1
    from human_resources_employee_assignments_to_restore restored
    left join public.employee_access_roles current_assignment
      on current_assignment.employee_id = restored.employee_id
     and current_assignment.role_id = employee_role_id
     and current_assignment.assigned_by is not distinct from restored.assigned_by
     and current_assignment.assigned_at = restored.assigned_at
    where current_assignment.employee_id is null
  ) then
    raise exception 'Human Resources Employee split did not preserve the prior assignment metadata.';
  end if;

  if (
    select count(*)
    from public.access_role_permissions
    where role_id = employee_role_id
      and enabled
  ) <> cardinality(approved_permissions) then
    raise exception 'Human Resources Employee permission count does not match the approved ordinary HR bundle.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    where role_permission.role_id = employee_role_id
      and role_permission.enabled
      and not (role_permission.permission_code = any(approved_permissions))
  ) then
    raise exception 'Human Resources Employee received an unexpected permission.';
  end if;
end
$$;

comment on table public.access_roles is
  'Role bundles for effective access. Human Resources Employee is the protected ordinary HR role; Human Resources Manager and Operations Manager are separate protected additive leadership roles.';

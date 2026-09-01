create temporary table human_resources_access_baseline on commit drop as
select
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles) as employee_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides) as override_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5('')) from public.access_roles where code <> 'human_resources') as existing_role_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
     from public.access_role_permissions
    where role_id not in (select id from public.access_roles where code = 'human_resources')) as existing_permission_fingerprint;

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
  'human_resources',
  'Human Resources',
  'Protected employee-lifecycle authority for recruiting, onboarding, people records, ordinary HR documents, leave, benefits, talent, learning, employee relations, safety, assets, offboarding, HR reporting, communications, and limited account recovery. Compensation, payroll, security administration, and highly restricted vaults remain excluded.',
  null,
  false,
  true,
  true,
  true
)
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    base_app_role = null,
    system_role = false,
    protected = true,
    mfa_required = true,
    active = true,
    updated_at = now();

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
  baseline human_resources_access_baseline%rowtype;
  human_resources_id uuid;
  missing_permission text;
  unexpected_permission text;
begin
  select * into strict baseline from human_resources_access_baseline;
  select id into strict human_resources_id from public.access_roles where code = 'human_resources';

  select requested_permission.code into missing_permission
  from unnest(approved_permissions) requested_permission(code)
  left join public.permission_catalog catalog
    on catalog.code = requested_permission.code
   and catalog.active
  where catalog.code is null
  limit 1;

  if missing_permission is not null then
    raise exception 'Human Resources requires unavailable permission %.', missing_permission;
  end if;

  update public.access_role_permissions
  set enabled = false,
      updated_at = now()
  where role_id = human_resources_id;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select human_resources_id, requested_permission.code, true
  from unnest(approved_permissions) requested_permission(code)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = now();

  if baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_role_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.override_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides)
  then
    raise exception 'Human Resources installation changed an employee role assignment or individual permission override.';
  end if;

  if baseline.existing_role_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
    from public.access_roles
    where code <> 'human_resources'
  ) then
    raise exception 'Human Resources installation changed an existing role definition.';
  end if;

  if baseline.existing_permission_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
    from public.access_role_permissions
    where role_id <> human_resources_id
  ) then
    raise exception 'Human Resources installation changed another role permission bundle.';
  end if;

  if exists (select 1 from public.employee_access_roles where role_id = human_resources_id) then
    raise exception 'Human Resources installation must not assign the new role to an employee.';
  end if;

  select role_permission.permission_code into unexpected_permission
  from public.access_role_permissions role_permission
  where role_permission.role_id = human_resources_id
    and role_permission.enabled
    and not (role_permission.permission_code = any(approved_permissions))
  limit 1;

  if unexpected_permission is not null then
    raise exception 'Human Resources received unexpected permission %.', unexpected_permission;
  end if;

  if (
    select count(*)
    from public.access_role_permissions
    where role_id = human_resources_id
      and enabled
  ) <> cardinality(approved_permissions) then
    raise exception 'Human Resources permission count does not match the approved bundle.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    where role_permission.role_id = human_resources_id
      and role_permission.enabled
      and (
        role_permission.permission_code in (
          'admin.maintenance.manage',
          'admin.roles.manage',
          'admin.roles.view',
          'admin.security.manage',
          'admin.users.basic',
          'admin.users.delete',
          'admin.users.manage',
          'admin.users.separate',
          'hr.automation.override',
          'hr.documents.financial',
          'hr.documents.financial_manage',
          'hr.documents.identity',
          'hr.documents.identity_manage',
          'hr.documents.medical',
          'hr.documents.medical_manage',
          'hr.leave.protected.manage',
          'hr.leave.protected.view',
          'hr.safety.restricted',
          'licensing.configure',
          'time.export_payroll',
          'time.manage',
          'time.override_payroll_assignment'
        )
        or role_permission.permission_code like 'hr.compensation.%'
        or role_permission.permission_code like 'hr.payroll_integration.%'
        or role_permission.permission_code like 'hr.total_rewards.%'
      )
  ) then
    raise exception 'Human Resources received a prohibited security, payroll, compensation, or highly restricted data permission.';
  end if;
end
$$;

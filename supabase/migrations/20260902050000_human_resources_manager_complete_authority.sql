create temporary table human_resources_manager_access_baseline on commit drop as
select
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles) as employee_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides) as override_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5('')) from public.access_roles where code <> 'human_resources') as other_role_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5('')) from public.access_role_permissions where role_id not in (select id from public.access_roles where code = 'human_resources')) as other_permission_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', code, category, name, coalesce(description, ''), risk_level, requires_mfa::text, locked::text, active::text), '|' order by code)), md5('')) from public.permission_catalog) as permission_catalog_fingerprint;

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
  'Human Resources Manager',
  'Companywide HR leadership with complete employee-lifecycle, protected-document, leave, benefits, compensation, payroll-integration, HR reporting, licensing, payroll preparation, and employee-account administration authority. System security, roles and permissions, maintenance, and destructive account deletion remain Admin-only.',
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
    updated_at = clock_timestamp();

with desired_permissions as (
  select permission.code
  from public.permission_catalog permission
  where permission.active
    and (
      permission.category = 'HR & Finance'
      or permission.code = any(array[
        'accountability.view',
        'actions.self.view',
        'admin.users.basic',
        'admin.users.invite',
        'admin.users.password_reset',
        'admin.users.separate',
        'admin.users.view',
        'announcements.acknowledgments.manage',
        'announcements.banner.manage',
        'announcements.send',
        'announcements.view',
        'availability.manage',
        'availability.view',
        'directory.edit_basic',
        'directory.edit_credentials',
        'directory.view',
        'licensing.communicate',
        'licensing.configure',
        'licensing.manage',
        'licensing.view',
        'notifications.manage',
        'notifications.view',
        'operations.view',
        'reports.export',
        'reports.view',
        'requests.manage',
        'requests.view',
        'schedule.self.view',
        'schedule.view',
        'time.adjustments.review',
        'time.export_payroll',
        'time.manage',
        'time.override_payroll_assignment',
        'time.punch',
        'time.reports.view',
        'time.resolve_exceptions',
        'time.self.view',
        'time.view',
        'training.export',
        'training.manage',
        'training.view'
      ]::text[])
    )
), human_resources_manager_role as (
  select role.id
  from public.access_roles role
  where role.code = 'human_resources'
)
update public.access_role_permissions role_permission
set enabled = false,
    updated_at = clock_timestamp()
from human_resources_manager_role role
where role_permission.role_id = role.id
  and role_permission.enabled
  and not exists (
    select 1
    from desired_permissions desired
    where desired.code = role_permission.permission_code
  );

with desired_permissions as (
  select permission.code
  from public.permission_catalog permission
  where permission.active
    and (
      permission.category = 'HR & Finance'
      or permission.code = any(array[
        'accountability.view',
        'actions.self.view',
        'admin.users.basic',
        'admin.users.invite',
        'admin.users.password_reset',
        'admin.users.separate',
        'admin.users.view',
        'announcements.acknowledgments.manage',
        'announcements.banner.manage',
        'announcements.send',
        'announcements.view',
        'availability.manage',
        'availability.view',
        'directory.edit_basic',
        'directory.edit_credentials',
        'directory.view',
        'licensing.communicate',
        'licensing.configure',
        'licensing.manage',
        'licensing.view',
        'notifications.manage',
        'notifications.view',
        'operations.view',
        'reports.export',
        'reports.view',
        'requests.manage',
        'requests.view',
        'schedule.self.view',
        'schedule.view',
        'time.adjustments.review',
        'time.export_payroll',
        'time.manage',
        'time.override_payroll_assignment',
        'time.punch',
        'time.reports.view',
        'time.resolve_exceptions',
        'time.self.view',
        'time.view',
        'training.export',
        'training.manage',
        'training.view'
      ]::text[])
    )
), human_resources_manager_role as (
  select role.id
  from public.access_roles role
  where role.code = 'human_resources'
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, desired.code, true
from human_resources_manager_role role
cross join desired_permissions desired
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

do $$
declare
  baseline human_resources_manager_access_baseline%rowtype;
  human_resources_manager_id uuid;
  missing_permission text;
  prohibited_permission text;
begin
  select * into strict baseline from human_resources_manager_access_baseline;
  select role.id into strict human_resources_manager_id
  from public.access_roles role
  where role.code = 'human_resources'
    and role.name = 'Human Resources Manager'
    and role.protected
    and role.mfa_required
    and role.active;

  if baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_role_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.override_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides)
  then
    raise exception 'Human Resources Manager installation changed an employee role assignment or individual permission override.';
  end if;

  if baseline.other_role_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
    from public.access_roles
    where code <> 'human_resources'
  ) then
    raise exception 'Human Resources Manager installation changed another role definition.';
  end if;

  if baseline.other_permission_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
    from public.access_role_permissions
    where role_id <> human_resources_manager_id
  ) then
    raise exception 'Human Resources Manager installation changed another role permission bundle.';
  end if;

  if baseline.permission_catalog_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', code, category, name, coalesce(description, ''), risk_level, requires_mfa::text, locked::text, active::text), '|' order by code)), md5(''))
    from public.permission_catalog
  ) then
    raise exception 'Human Resources Manager installation changed the permission catalog.';
  end if;

  select permission.code into missing_permission
  from public.permission_catalog permission
  where permission.active
    and permission.category = 'HR & Finance'
    and not exists (
      select 1
      from public.access_role_permissions role_permission
      where role_permission.role_id = human_resources_manager_id
        and role_permission.permission_code = permission.code
        and role_permission.enabled
    )
  limit 1;

  if missing_permission is not null then
    raise exception 'Human Resources Manager is missing HR permission %.', missing_permission;
  end if;

  foreach missing_permission in array array[
    'accountability.view',
    'actions.self.view',
    'admin.users.basic',
    'admin.users.invite',
    'admin.users.password_reset',
    'admin.users.separate',
    'admin.users.view',
    'announcements.acknowledgments.manage',
    'announcements.banner.manage',
    'announcements.send',
    'announcements.view',
    'availability.manage',
    'availability.view',
    'directory.edit_basic',
    'directory.edit_credentials',
    'directory.view',
    'licensing.communicate',
    'licensing.configure',
    'licensing.manage',
    'licensing.view',
    'notifications.manage',
    'notifications.view',
    'operations.view',
    'reports.export',
    'reports.view',
    'requests.manage',
    'requests.view',
    'schedule.self.view',
    'schedule.view',
    'time.adjustments.review',
    'time.export_payroll',
    'time.manage',
    'time.override_payroll_assignment',
    'time.punch',
    'time.reports.view',
    'time.resolve_exceptions',
    'time.self.view',
    'time.view',
    'training.export',
    'training.manage',
    'training.view'
  ]::text[]
  loop
    if not exists (
      select 1
      from public.access_role_permissions role_permission
      where role_permission.role_id = human_resources_manager_id
        and role_permission.permission_code = missing_permission
        and role_permission.enabled
    ) then
      raise exception 'Human Resources Manager is missing required supporting permission %.', missing_permission;
    end if;
  end loop;

  select role_permission.permission_code into prohibited_permission
  from public.access_role_permissions role_permission
  where role_permission.role_id = human_resources_manager_id
    and role_permission.enabled
    and role_permission.permission_code = any(array[
      'admin.maintenance.manage',
      'admin.roles.manage',
      'admin.roles.view',
      'admin.security.manage',
      'admin.users.delete',
      'admin.users.manage',
      'patrol.manage',
      'schedule.manage',
      'schedule.publish',
      'sites.manage'
    ]::text[])
  limit 1;

  if prohibited_permission is not null then
    raise exception 'Human Resources Manager received Admin or Operations-only permission %.', prohibited_permission;
  end if;
end
$$;

comment on table public.access_roles is
  'Role bundles for effective access. Human Resources Manager and Operations Manager are protected additive leadership roles and are intentionally not primary app-role enum values.';

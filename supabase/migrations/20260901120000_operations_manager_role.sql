create temporary table operations_manager_access_baseline on commit drop as
select
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles) as employee_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides) as override_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5('')) from public.access_roles where code <> 'operations_manager') as existing_role_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
     from public.access_role_permissions
    where role_id not in (select id from public.access_roles where code in ('system_admin', 'operations_manager'))) as existing_non_admin_permission_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', code, category, name, coalesce(description, ''), risk_level, requires_mfa::text, locked::text, active::text), '|' order by code)), md5(''))
     from public.permission_catalog
    where code <> 'admin.users.password_reset') as existing_catalog_fingerprint;

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values (
  'admin.users.password_reset',
  'Administration',
  'Send employee password resets',
  'Send an audited password-recovery link without changing MFA, security keys, trusted devices, login state, employee data, or access.',
  'sensitive',
  true,
  true,
  true
)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = true,
    updated_at = now();

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
  'operations_manager',
  'Operations Manager',
  'Companywide operational leadership for scheduling, attendance, patrol, sites, licensing, communications, reports, onboarding visibility, and limited employee account recovery. Protected HR, payroll, security, permissions, and backend controls remain excluded.',
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

with operations_manager_role as (
  select id from public.access_roles where code = 'operations_manager'
), approved_permissions as (
  select role_permission.permission_code
  from public.access_role_permissions role_permission
  join public.access_roles supervisor_role
    on supervisor_role.id = role_permission.role_id
   and supervisor_role.code = 'system_supervisor'
  where role_permission.enabled
    and role_permission.permission_code <> 'time.export_payroll'

  union

  select permission_code
  from unnest(array[
    'admin.users.invite',
    'admin.users.password_reset',
    'admin.users.view',
    'announcements.acknowledgments.manage',
    'hr.onboarding.view',
    'hr.people.view',
    'licensing.communicate',
    'licensing.manage',
    'licensing.view',
    'time.resolve_exceptions',
    'training.export',
    'training.manage'
  ]::text[]) permission_code
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select operations_manager_role.id, approved_permissions.permission_code, true
from operations_manager_role
join approved_permissions on true
join public.permission_catalog catalog
  on catalog.code = approved_permissions.permission_code
 and catalog.active
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

update public.access_role_permissions role_permission
set enabled = false,
    updated_at = now()
from public.access_roles access_role
where access_role.id = role_permission.role_id
  and access_role.code = 'operations_manager'
  and role_permission.permission_code not in (
    select supervisor_permission.permission_code
    from public.access_role_permissions supervisor_permission
    join public.access_roles supervisor_role
      on supervisor_role.id = supervisor_permission.role_id
     and supervisor_role.code = 'system_supervisor'
    where supervisor_permission.enabled
      and supervisor_permission.permission_code <> 'time.export_payroll'

    union

    select permission_code
    from unnest(array[
      'admin.users.invite',
      'admin.users.password_reset',
      'admin.users.view',
      'announcements.acknowledgments.manage',
      'hr.onboarding.view',
      'hr.people.view',
      'licensing.communicate',
      'licensing.manage',
      'licensing.view',
      'time.resolve_exceptions',
      'training.export',
      'training.manage'
    ]::text[]) permission_code
  );

insert into public.access_role_permissions (role_id, permission_code, enabled)
select admin_role.id, 'admin.users.password_reset', true
from public.access_roles admin_role
where admin_role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

do $$
declare
  baseline operations_manager_access_baseline%rowtype;
  operations_manager_id uuid;
  required_permission text;
  prohibited_permission text;
begin
  select * into strict baseline from operations_manager_access_baseline;
  select id into strict operations_manager_id from public.access_roles where code = 'operations_manager';

  if baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_role_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text, coalesce(assigned_by::text, ''), assigned_at::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.override_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text, coalesce(created_by::text, ''), created_at::text, updated_at::text), '|' order by id)), md5('')) from public.employee_permission_overrides)
  then
    raise exception 'Operations Manager installation changed an existing employee access assignment or individual override.';
  end if;

  if baseline.existing_role_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', id::text, code, name, coalesce(description, ''), coalesce(base_app_role::text, ''), system_role::text, protected::text, mfa_required::text, active::text), '|' order by id)), md5(''))
    from public.access_roles
    where code <> 'operations_manager'
  ) then
    raise exception 'Operations Manager installation changed an existing role definition.';
  end if;

  if baseline.existing_non_admin_permission_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5(''))
    from public.access_role_permissions
    where role_id not in (select id from public.access_roles where code in ('system_admin', 'operations_manager'))
  ) then
    raise exception 'Operations Manager installation changed another non-Admin role permission bundle.';
  end if;

  if baseline.existing_catalog_fingerprint <> (
    select coalesce(md5(string_agg(concat_ws(':', code, category, name, coalesce(description, ''), risk_level, requires_mfa::text, locked::text, active::text), '|' order by code)), md5(''))
    from public.permission_catalog
    where code <> 'admin.users.password_reset'
  ) then
    raise exception 'Operations Manager installation changed an existing permission definition.';
  end if;

  if exists (select 1 from public.employee_access_roles where role_id = operations_manager_id) then
    raise exception 'Operations Manager installation must not assign the new role to an employee.';
  end if;

  foreach required_permission in array array[
    'operations.view',
    'schedule.manage',
    'schedule.publish',
    'scheduler.manage',
    'time.manage',
    'time.resolve_exceptions',
    'patrol.manage',
    'sites.manage',
    'licensing.manage',
    'announcements.send',
    'reports.export',
    'hr.people.view',
    'hr.onboarding.view',
    'admin.users.view',
    'admin.users.invite',
    'admin.users.password_reset'
  ]::text[]
  loop
    if not exists (
      select 1 from public.access_role_permissions
      where role_id = operations_manager_id
        and permission_code = required_permission
        and enabled
    ) then
      raise exception 'Operations Manager is missing required permission %.', required_permission;
    end if;
  end loop;

  select role_permission.permission_code into prohibited_permission
  from public.access_role_permissions role_permission
  where role_permission.role_id = operations_manager_id
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
        'licensing.configure',
        'time.export_payroll',
        'time.override_payroll_assignment'
      )
      or (
        role_permission.permission_code like 'hr.%'
        and role_permission.permission_code not in ('hr.people.view', 'hr.onboarding.view')
      )
    )
  limit 1;

  if prohibited_permission is not null then
    raise exception 'Operations Manager received prohibited permission %.', prohibited_permission;
  end if;

  if not exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles admin_role on admin_role.id = role_permission.role_id
    where admin_role.code = 'system_admin'
      and role_permission.permission_code = 'admin.users.password_reset'
      and role_permission.enabled
  ) then
    raise exception 'The protected Admin role did not receive the new active permission.';
  end if;
end
$$;

comment on table public.access_roles is
  'Role bundles for effective access. Operations Manager is a protected additive operational role and is intentionally not a primary app-role enum value.';


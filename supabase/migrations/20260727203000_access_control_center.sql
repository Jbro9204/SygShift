begin;

create table if not exists public.permission_catalog (
  code text primary key,
  category text not null,
  name text not null,
  description text,
  risk_level text not null default 'standard',
  requires_mfa boolean not null default true,
  locked boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permission_catalog_code_format check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint permission_catalog_name_present check (btrim(name) <> ''),
  constraint permission_catalog_category_present check (btrim(category) <> ''),
  constraint permission_catalog_risk_check check (risk_level in ('standard', 'sensitive', 'critical'))
);

create table if not exists public.access_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  base_app_role public.app_role,
  system_role boolean not null default false,
  protected boolean not null default false,
  mfa_required boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint access_roles_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint access_roles_name_present check (btrim(name) <> ''),
  constraint access_roles_system_base_role check ((system_role and base_app_role is not null) or (not system_role))
);

create table if not exists public.access_role_permissions (
  role_id uuid not null references public.access_roles(id) on delete cascade,
  permission_code text not null references public.permission_catalog(code) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (role_id, permission_code)
);

create table if not exists public.employee_access_roles (
  employee_id uuid not null references public.employees(id) on delete cascade,
  role_id uuid not null references public.access_roles(id) on delete cascade,
  assigned_by uuid references public.employees(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (employee_id, role_id)
);

create table if not exists public.employee_permission_overrides (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  permission_code text not null references public.permission_catalog(code) on delete cascade,
  effect text not null,
  reason text not null,
  active boolean not null default true,
  created_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_permission_overrides_effect_check check (effect in ('grant', 'deny')),
  constraint employee_permission_overrides_reason_present check (btrim(reason) <> '')
);

create unique index if not exists employee_permission_overrides_active_unique
  on public.employee_permission_overrides(employee_id, permission_code)
  where active;

create index if not exists access_roles_active_idx on public.access_roles(active, name);
create index if not exists access_role_permissions_role_idx on public.access_role_permissions(role_id, permission_code) where enabled;
create index if not exists employee_access_roles_employee_idx on public.employee_access_roles(employee_id);
create index if not exists employee_permission_overrides_employee_idx on public.employee_permission_overrides(employee_id, active);

alter table public.permission_catalog enable row level security;
alter table public.access_roles enable row level security;
alter table public.access_role_permissions enable row level security;
alter table public.employee_access_roles enable row level security;
alter table public.employee_permission_overrides enable row level security;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked)
values
  ('operations.view', 'Operations', 'View operations dashboard', 'See the operations overview and non-sensitive workspace status.', 'standard', false, true),
  ('schedule.view', 'Schedule', 'View schedule', 'View scheduled coverage and personal assignments.', 'standard', false, true),
  ('schedule.manage', 'Schedule', 'Manage schedule', 'Create, edit, reassign, and prepare schedule coverage.', 'sensitive', true, true),
  ('schedule.publish', 'Schedule', 'Publish schedule', 'Approve draft changes and publish them as the live schedule.', 'critical', true, true),
  ('schedule.delete_shift', 'Schedule', 'Remove shifts', 'Remove duplicate, canceled, or invalid shifts from schedule coverage.', 'critical', true, true),
  ('schedule.override_warnings', 'Schedule', 'Override schedule warnings', 'Override availability, credential, overtime, or conflict warnings with a documented reason.', 'critical', true, true),
  ('scheduler.view', 'Scheduler', 'View scheduler workspace', 'Open the planning workspace and view staffing suggestions.', 'standard', true, true),
  ('scheduler.manage', 'Scheduler', 'Manage scheduler workspace', 'Work schedule drafts, suggestions, open shifts, and coverage changes.', 'sensitive', true, true),
  ('events.view', 'Events & Openings', 'View events and openings', 'View events, open shifts, and coverage opportunities.', 'standard', false, true),
  ('events.manage', 'Events & Openings', 'Manage events and openings', 'Create events, open shifts, and coverage opportunities.', 'sensitive', true, true),
  ('shift_pool.view', 'Shift Pool', 'View shift pool', 'View open shifts and coverage requests.', 'standard', false, true),
  ('shift_pool.manage', 'Shift Pool', 'Manage shift pool', 'Approve, deny, and manually resolve open shift or coverage requests.', 'sensitive', true, true),
  ('time.view', 'Time & Attendance', 'View time records', 'View personal or permitted employee time records.', 'standard', true, true),
  ('time.manage', 'Time & Attendance', 'Manage time records', 'Add missing punches, correct punches, and review exceptions.', 'critical', true, true),
  ('time.export_payroll', 'Time & Attendance', 'Export payroll', 'Export approved timekeeping and payroll data.', 'critical', true, true),
  ('directory.view', 'Directory', 'View directory', 'View employee directory records.', 'standard', true, true),
  ('directory.edit_basic', 'Directory', 'Edit employee profile', 'Update basic employee contact, title, and employment details.', 'sensitive', true, true),
  ('directory.edit_credentials', 'Directory', 'Edit credentials', 'Update guard license, armed/unarmed, and work eligibility information.', 'critical', true, true),
  ('availability.view', 'Availability', 'View availability', 'View employee availability and unavailability records.', 'standard', true, true),
  ('availability.manage', 'Availability', 'Manage availability', 'Create, approve, deny, cancel, and override availability records.', 'sensitive', true, true),
  ('sites.view', 'Sites & Posts', 'View sites and posts', 'View sites, posts, and coverage requirements.', 'standard', true, true),
  ('sites.manage', 'Sites & Posts', 'Manage sites and posts', 'Create, edit, deactivate, and maintain sites and posts.', 'critical', true, true),
  ('patrol.view', 'Patrol', 'View patrol', 'View patrol assignments and patrol-related coverage.', 'standard', true, true),
  ('patrol.manage', 'Patrol', 'Manage patrol', 'Update patrol assignments and patrol operational details.', 'sensitive', true, true),
  ('requests.view', 'Time-Off Requests', 'View requests', 'View time-off and schedule-related requests.', 'standard', true, true),
  ('requests.manage', 'Time-Off Requests', 'Manage requests', 'Approve, decline, and resolve time-off and schedule requests.', 'critical', true, true),
  ('announcements.view', 'Announcements', 'View announcements', 'View announcements and message history.', 'standard', true, true),
  ('announcements.send', 'Announcements', 'Send announcements', 'Create and send approved announcements and email blasts.', 'critical', true, true),
  ('notifications.view', 'Notifications', 'View notifications', 'View system notifications and action items.', 'standard', true, true),
  ('notifications.manage', 'Notifications', 'Manage notifications', 'Resolve and process notification action items.', 'sensitive', true, true),
  ('reports.view', 'Reports', 'View reports', 'View schedule, workforce, and operational reports.', 'standard', true, true),
  ('reports.export', 'Reports', 'Export reports', 'Export reports and operational data.', 'sensitive', true, true),
  ('licensing.view', 'Licensing', 'View licensing center', 'View licensing and credential compliance.', 'standard', true, true),
  ('licensing.manage', 'Licensing', 'Manage licensing', 'Update licensing, compliance, and employee credential records.', 'critical', true, true),
  ('licensing.configure', 'Licensing', 'Configure licensing rules', 'Configure credential types, rules, renewal windows, and requirements.', 'critical', true, true),
  ('licensing.communicate', 'Licensing', 'Send licensing communication', 'Send approved licensing and credential communications.', 'sensitive', true, true),
  ('admin.users.view', 'Administration', 'View user administration', 'View login, employee account, and user access records.', 'sensitive', true, true),
  ('admin.users.manage', 'Administration', 'Manage users', 'Create employees, reset access, disable accounts, and update user records.', 'critical', true, true),
  ('admin.roles.view', 'Administration', 'View roles and permissions', 'View custom roles, permission assignments, and effective access.', 'sensitive', true, true),
  ('admin.roles.manage', 'Administration', 'Manage roles and permissions', 'Create roles, edit permissions, and assign per-person access overrides.', 'critical', true, true),
  ('admin.security.manage', 'Administration', 'Manage security', 'Manage MFA-sensitive account security controls.', 'critical', true, true)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = now();

insert into public.access_roles (code, name, description, base_app_role, system_role, protected, mfa_required, active)
values
  ('system_guard', 'Guard', 'Baseline access for guards.', 'guard', true, true, false, true),
  ('system_dispatcher', 'Dispatcher', 'Baseline access for dispatchers.', 'dispatcher', true, true, true, true),
  ('system_scheduler', 'Scheduler', 'Baseline access for schedulers.', 'scheduler', true, true, true, true),
  ('system_recruiting_licensing', 'Recruiting & Licensing', 'Baseline access for recruiting and licensing staff.', 'recruiting_licensing', true, true, true, true),
  ('system_supervisor', 'Supervisor', 'Baseline access for supervisors.', 'supervisor', true, true, true, true),
  ('system_admin', 'Admin', 'Protected full-access administrative role.', 'admin', true, true, true, true)
on conflict (code) do update
set
  name = excluded.name,
  description = excluded.description,
  base_app_role = excluded.base_app_role,
  system_role = excluded.system_role,
  protected = excluded.protected,
  mfa_required = excluded.mfa_required,
  active = true,
  updated_at = now();

with role_permissions_seed(role_code, permission_code) as (
  values
    ('system_guard', 'operations.view'),
    ('system_guard', 'schedule.view'),
    ('system_guard', 'events.view'),
    ('system_guard', 'shift_pool.view'),
    ('system_guard', 'time.view'),
    ('system_guard', 'availability.view'),
    ('system_guard', 'requests.view'),
    ('system_guard', 'announcements.view'),

    ('system_dispatcher', 'operations.view'),
    ('system_dispatcher', 'schedule.view'),
    ('system_dispatcher', 'scheduler.view'),
    ('system_dispatcher', 'events.view'),
    ('system_dispatcher', 'shift_pool.view'),
    ('system_dispatcher', 'directory.view'),
    ('system_dispatcher', 'availability.view'),
    ('system_dispatcher', 'sites.view'),
    ('system_dispatcher', 'patrol.view'),
    ('system_dispatcher', 'requests.view'),
    ('system_dispatcher', 'announcements.view'),
    ('system_dispatcher', 'notifications.view'),
    ('system_dispatcher', 'reports.view'),

    ('system_scheduler', 'operations.view'),
    ('system_scheduler', 'schedule.view'),
    ('system_scheduler', 'schedule.manage'),
    ('system_scheduler', 'schedule.delete_shift'),
    ('system_scheduler', 'schedule.override_warnings'),
    ('system_scheduler', 'scheduler.view'),
    ('system_scheduler', 'scheduler.manage'),
    ('system_scheduler', 'events.view'),
    ('system_scheduler', 'events.manage'),
    ('system_scheduler', 'shift_pool.view'),
    ('system_scheduler', 'shift_pool.manage'),
    ('system_scheduler', 'directory.view'),
    ('system_scheduler', 'directory.edit_credentials'),
    ('system_scheduler', 'availability.view'),
    ('system_scheduler', 'availability.manage'),
    ('system_scheduler', 'sites.view'),
    ('system_scheduler', 'patrol.view'),
    ('system_scheduler', 'requests.view'),
    ('system_scheduler', 'requests.manage'),
    ('system_scheduler', 'announcements.view'),
    ('system_scheduler', 'announcements.send'),
    ('system_scheduler', 'notifications.view'),
    ('system_scheduler', 'reports.view'),

    ('system_recruiting_licensing', 'operations.view'),
    ('system_recruiting_licensing', 'directory.view'),
    ('system_recruiting_licensing', 'directory.edit_basic'),
    ('system_recruiting_licensing', 'directory.edit_credentials'),
    ('system_recruiting_licensing', 'licensing.view'),
    ('system_recruiting_licensing', 'licensing.manage'),
    ('system_recruiting_licensing', 'licensing.configure'),
    ('system_recruiting_licensing', 'licensing.communicate'),
    ('system_recruiting_licensing', 'announcements.view'),
    ('system_recruiting_licensing', 'notifications.view'),
    ('system_recruiting_licensing', 'reports.view'),

    ('system_supervisor', 'operations.view'),
    ('system_supervisor', 'schedule.view'),
    ('system_supervisor', 'schedule.manage'),
    ('system_supervisor', 'schedule.publish'),
    ('system_supervisor', 'schedule.delete_shift'),
    ('system_supervisor', 'schedule.override_warnings'),
    ('system_supervisor', 'scheduler.view'),
    ('system_supervisor', 'scheduler.manage'),
    ('system_supervisor', 'events.view'),
    ('system_supervisor', 'events.manage'),
    ('system_supervisor', 'shift_pool.view'),
    ('system_supervisor', 'shift_pool.manage'),
    ('system_supervisor', 'time.view'),
    ('system_supervisor', 'time.manage'),
    ('system_supervisor', 'directory.view'),
    ('system_supervisor', 'directory.edit_basic'),
    ('system_supervisor', 'directory.edit_credentials'),
    ('system_supervisor', 'availability.view'),
    ('system_supervisor', 'availability.manage'),
    ('system_supervisor', 'sites.view'),
    ('system_supervisor', 'sites.manage'),
    ('system_supervisor', 'patrol.view'),
    ('system_supervisor', 'patrol.manage'),
    ('system_supervisor', 'requests.view'),
    ('system_supervisor', 'requests.manage'),
    ('system_supervisor', 'announcements.view'),
    ('system_supervisor', 'announcements.send'),
    ('system_supervisor', 'notifications.view'),
    ('system_supervisor', 'notifications.manage'),
    ('system_supervisor', 'reports.view'),
    ('system_supervisor', 'reports.export')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, seed.permission_code, true
from role_permissions_seed seed
join public.access_roles access_role on access_role.code = seed.role_code
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, permission.code, true
from public.access_roles access_role
cross join public.permission_catalog permission
where access_role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, legacy.permission, legacy.enabled
from public.role_permissions legacy
join public.access_roles access_role on access_role.base_app_role = legacy.role and access_role.system_role
join public.permission_catalog permission on permission.code = legacy.permission
on conflict (role_id, permission_code) do update
set enabled = excluded.enabled,
    updated_at = now();

create or replace function private.employee_effective_permissions(target_employee_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with employee_record as (
    select employee.id, employee.role
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
    limit 1
  ),
  base_roles as (
    select access_role.id
    from public.access_roles access_role
    join employee_record employee on access_role.base_app_role = employee.role
    where access_role.system_role
      and access_role.active
  ),
  assigned_roles as (
    select access_role.id
    from public.employee_access_roles assignment
    join public.access_roles access_role on access_role.id = assignment.role_id
    join employee_record employee on employee.id = assignment.employee_id
    where access_role.active
  ),
  role_grants as (
    select permission.permission_code
    from public.access_role_permissions permission
    join (
      select id from base_roles
      union
      select id from assigned_roles
    ) role_scope on role_scope.id = permission.role_id
    join public.permission_catalog catalog on catalog.code = permission.permission_code
    where permission.enabled
      and catalog.active
  ),
  direct_grants as (
    select override.permission_code
    from public.employee_permission_overrides override
    join public.permission_catalog catalog on catalog.code = override.permission_code
    where override.employee_id = target_employee_id
      and override.active
      and override.effect = 'grant'
      and catalog.active
  ),
  direct_denies as (
    select override.permission_code
    from public.employee_permission_overrides override
    where override.employee_id = target_employee_id
      and override.active
      and override.effect = 'deny'
  )
  select coalesce(array_agg(distinct permission_code order by permission_code), array[]::text[])
  from (
    select permission_code from role_grants
    union
    select permission_code from direct_grants
  ) granted_permissions
  where not exists (
    select 1
    from direct_denies
    where direct_denies.permission_code = granted_permissions.permission_code
  )
$$;

create or replace function public.get_effective_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(permission_code order by permission_code), array[]::text[])
  from unnest(private.employee_effective_permissions(private.current_employee_id())) permission_code
  join public.permission_catalog catalog on catalog.code = permission_code
  where catalog.active
    and (not catalog.requires_mfa or public.has_mfa())
$$;

create or replace function public.has_effective_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(required_permission = any(public.get_effective_permissions()), false)
$$;

create or replace function public.has_role_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission(required_permission)
$$;

drop function if exists public.get_session_context();

create function public.get_session_context()
returns table (
  employee_id uuid,
  username text,
  display_name text,
  role public.app_role,
  must_change_password boolean,
  password_changed_at timestamptz,
  mfa_enrolled_at timestamptz,
  mfa_required boolean,
  has_mfa boolean,
  permissions text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise insufficient_privilege
      using message = 'A signed-in SygShift account is required.';
  end if;

  return query
  select
    employee.id,
    employee.username,
    coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
    employee.role,
    account.must_change_password,
    account.password_changed_at,
    account.mfa_enrolled_at,
    (
      employee.role in ('dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
      or exists (
        select 1
        from public.access_roles access_role
        join public.employee_access_roles assignment on assignment.role_id = access_role.id
        where assignment.employee_id = employee.id
          and access_role.mfa_required
          and access_role.active
      )
      or exists (
        select 1
        from public.employee_permission_overrides override
        join public.permission_catalog catalog on catalog.code = override.permission_code
        where override.employee_id = employee.id
          and override.active
          and override.effect = 'grant'
          and catalog.requires_mfa
          and catalog.active
      )
    ) as mfa_required,
    public.has_mfa(),
    public.get_effective_permissions()
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;
end
$$;

create or replace function private.require_access_control_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to manage roles and permissions.';
  end if;

  if not public.has_effective_permission('admin.roles.manage') then
    raise insufficient_privilege using message = 'Role and permission administration access is required.';
  end if;

  return actor_id;
end
$$;

create or replace function public.get_access_control_center()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
begin
  return jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM'),
    'permissions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', permission.code,
        'category', permission.category,
        'name', permission.name,
        'description', permission.description,
        'riskLevel', permission.risk_level,
        'requiresMfa', permission.requires_mfa,
        'locked', permission.locked,
        'active', permission.active
      ) order by permission.category, permission.name), '[]'::jsonb)
      from public.permission_catalog permission
      where permission.active
    ),
    'roles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', access_role.id,
        'code', access_role.code,
        'name', access_role.name,
        'description', access_role.description,
        'baseAppRole', access_role.base_app_role,
        'systemRole', access_role.system_role,
        'protected', access_role.protected,
        'mfaRequired', access_role.mfa_required,
        'active', access_role.active,
        'permissionCodes', coalesce(role_permissions.permission_codes, array[]::text[]),
        'assignedCount', coalesce(assignments.assigned_count, 0)
      ) order by access_role.system_role desc, access_role.name), '[]'::jsonb)
      from public.access_roles access_role
      left join lateral (
        select array_agg(permission.permission_code order by permission.permission_code) as permission_codes
        from public.access_role_permissions permission
        where permission.role_id = access_role.id
          and permission.enabled
      ) role_permissions on true
      left join lateral (
        select count(*)::integer as assigned_count
        from public.employee_access_roles assignment
        where assignment.role_id = access_role.id
      ) assignments on true
      where access_role.active
    ),
    'users', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'displayName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'username', employee.username,
        'primaryRole', employee.role,
        'jobTitle', employee.job_title,
        'status', employee.status,
        'assignedRoleIds', coalesce(assigned_roles.role_ids, array[]::uuid[]),
        'overrides', coalesce(overrides.records, '[]'::jsonb),
        'effectivePermissionCodes', private.employee_effective_permissions(employee.id)
      ) order by employee.last_name, employee.first_name), '[]'::jsonb)
      from public.employees employee
      left join lateral (
        select array_agg(assignment.role_id order by access_role.name) as role_ids
        from public.employee_access_roles assignment
        join public.access_roles access_role on access_role.id = assignment.role_id
        where assignment.employee_id = employee.id
          and access_role.active
      ) assigned_roles on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'id', override.id,
          'permissionCode', override.permission_code,
          'effect', override.effect,
          'reason', override.reason,
          'createdAt', to_char(override.created_at at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM')
        ) order by override.permission_code) as records
        from public.employee_permission_overrides override
        where override.employee_id = employee.id
          and override.active
      ) overrides on true
      where employee.status = 'active'
    )
  );
end
$$;

create or replace function public.upsert_access_role(
  target_role_id uuid default null,
  target_name text default null,
  target_description text default null,
  target_mfa_required boolean default true,
  target_active boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  clean_name text := btrim(coalesce(target_name, ''));
  clean_description text := nullif(btrim(coalesce(target_description, '')), '');
  existing_role public.access_roles%rowtype;
  saved_role_id uuid;
  role_code text;
begin
  if clean_name = '' then
    raise check_violation using message = 'Role name is required.';
  end if;

  if target_role_id is not null then
    select * into existing_role
    from public.access_roles
    where id = target_role_id;

    if not found then
      raise no_data_found using message = 'The selected role no longer exists.';
    end if;

    if existing_role.protected then
      raise insufficient_privilege using message = 'Protected system roles cannot be renamed or disabled.';
    end if;

    update public.access_roles
    set name = clean_name,
        description = clean_description,
        mfa_required = coalesce(target_mfa_required, true),
        active = coalesce(target_active, true),
        updated_at = now()
    where id = target_role_id
    returning id into saved_role_id;
  else
    role_code := 'custom_' || regexp_replace(lower(clean_name), '[^a-z0-9]+', '_', 'g');
    role_code := regexp_replace(role_code, '_+', '_', 'g');
    role_code := regexp_replace(role_code, '_$', '');
    if role_code = 'custom_' then
      role_code := 'custom_role';
    end if;

    while exists (select 1 from public.access_roles where code = role_code) loop
      role_code := role_code || '_' || floor(random() * 9000 + 1000)::integer::text;
    end loop;

    insert into public.access_roles (code, name, description, system_role, protected, mfa_required, active)
    values (role_code, clean_name, clean_description, false, false, coalesce(target_mfa_required, true), coalesce(target_active, true))
    returning id into saved_role_id;
  end if;

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'access_roles', case when target_role_id is null then 'INSERT' else 'UPDATE' end, saved_role_id::text, jsonb_build_object('name', clean_name));

  return public.get_access_control_center();
end
$$;

create or replace function public.set_access_role_permissions(
  target_role_id uuid,
  target_permission_codes text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  target_role public.access_roles%rowtype;
  clean_permissions text[] := coalesce(target_permission_codes, array[]::text[]);
begin
  select * into target_role
  from public.access_roles
  where id = target_role_id;

  if not found then
    raise no_data_found using message = 'The selected role no longer exists.';
  end if;

  if target_role.protected
    and target_role.code = 'system_admin'
    and (
      not ('admin.roles.manage' = any(clean_permissions))
      or not ('admin.users.manage' = any(clean_permissions))
      or not ('admin.security.manage' = any(clean_permissions))
    )
  then
    raise insufficient_privilege using message = 'Protected Admin permissions cannot be removed.';
  end if;

  if exists (
    select 1
    from unnest(clean_permissions) requested_permission(code)
    left join public.permission_catalog catalog on catalog.code = requested_permission.code and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'One or more selected permissions are not available.';
  end if;

  update public.access_role_permissions
  set enabled = false,
      updated_at = now()
  where role_id = target_role_id;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select target_role_id, requested_permission.code, true
  from unnest(clean_permissions) requested_permission(code)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = now();

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'access_role_permissions', 'UPDATE', target_role_id::text, jsonb_build_object('permissionCodes', clean_permissions));

  return public.get_access_control_center();
end
$$;

create or replace function public.set_employee_access_roles(
  target_employee_id uuid,
  target_role_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  clean_role_ids uuid[] := coalesce(target_role_ids, array[]::uuid[]);
begin
  if not exists (select 1 from public.employees where id = target_employee_id and status = 'active') then
    raise no_data_found using message = 'The selected employee is not active.';
  end if;

  if exists (
    select 1
    from unnest(clean_role_ids) requested_role(id)
    left join public.access_roles access_role on access_role.id = requested_role.id and access_role.active
    where access_role.id is null
  ) then
    raise check_violation using message = 'One or more selected roles are not available.';
  end if;

  delete from public.employee_access_roles
  where employee_id = target_employee_id
    and not (role_id = any(clean_role_ids));

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  select target_employee_id, requested_role.id, actor_id
  from unnest(clean_role_ids) requested_role(id)
  on conflict (employee_id, role_id) do update
  set assigned_by = excluded.assigned_by,
      assigned_at = now();

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'employee_access_roles', 'UPDATE', target_employee_id::text, jsonb_build_object('roleIds', clean_role_ids));

  return public.get_access_control_center();
end
$$;

create or replace function public.set_employee_permission_override(
  target_employee_id uuid,
  target_permission_code text,
  target_effect text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if target_effect not in ('grant', 'deny') then
    raise check_violation using message = 'Permission override must be grant or deny.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A reason is required for individual permission overrides.';
  end if;

  if not exists (select 1 from public.employees where id = target_employee_id and status = 'active') then
    raise no_data_found using message = 'The selected employee is not active.';
  end if;

  if not exists (select 1 from public.permission_catalog where code = target_permission_code and active) then
    raise no_data_found using message = 'The selected permission is not available.';
  end if;

  if target_effect = 'deny'
    and target_permission_code in ('admin.roles.manage', 'admin.users.manage', 'admin.security.manage')
    and target_employee_id = actor_id
  then
    raise insufficient_privilege using message = 'You cannot remove your own critical admin access.';
  end if;

  insert into public.employee_permission_overrides (employee_id, permission_code, effect, reason, created_by)
  values (target_employee_id, target_permission_code, target_effect, clean_reason, actor_id)
  on conflict (employee_id, permission_code) where active do update
  set effect = excluded.effect,
      reason = excluded.reason,
      created_by = excluded.created_by,
      updated_at = now();

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'employee_permission_overrides', 'UPSERT', target_employee_id::text, jsonb_build_object('permissionCode', target_permission_code, 'effect', target_effect));

  return public.get_access_control_center();
end
$$;

create or replace function public.clear_employee_permission_override(target_override_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  override_record public.employee_permission_overrides%rowtype;
begin
  select * into override_record
  from public.employee_permission_overrides
  where id = target_override_id
    and active;

  if not found then
    raise no_data_found using message = 'The selected override no longer exists.';
  end if;

  update public.employee_permission_overrides
  set active = false,
      updated_at = now()
  where id = target_override_id;

  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record)
  values ((select auth.uid()), actor_id, 'public', 'employee_permission_overrides', 'DELETE', target_override_id::text, to_jsonb(override_record));

  return public.get_access_control_center();
end
$$;

revoke all on table public.permission_catalog from public, anon;
revoke all on table public.access_roles from public, anon;
revoke all on table public.access_role_permissions from public, anon;
revoke all on table public.employee_access_roles from public, anon;
revoke all on table public.employee_permission_overrides from public, anon;

revoke all on function public.get_effective_permissions() from public, anon;
revoke all on function public.has_effective_permission(text) from public, anon;
revoke all on function public.get_access_control_center() from public, anon;
revoke all on function public.upsert_access_role(uuid, text, text, boolean, boolean) from public, anon;
revoke all on function public.set_access_role_permissions(uuid, text[]) from public, anon;
revoke all on function public.set_employee_access_roles(uuid, uuid[]) from public, anon;
revoke all on function public.set_employee_permission_override(uuid, text, text, text) from public, anon;
revoke all on function public.clear_employee_permission_override(uuid) from public, anon;
revoke all on function private.employee_effective_permissions(uuid) from public, anon, authenticated;
revoke all on function private.require_access_control_admin() from public, anon, authenticated;

grant execute on function public.get_effective_permissions() to authenticated;
grant execute on function public.has_effective_permission(text) to authenticated;
grant execute on function public.get_access_control_center() to authenticated;
grant execute on function public.upsert_access_role(uuid, text, text, boolean, boolean) to authenticated;
grant execute on function public.set_access_role_permissions(uuid, text[]) to authenticated;
grant execute on function public.set_employee_access_roles(uuid, uuid[]) to authenticated;
grant execute on function public.set_employee_permission_override(uuid, text, text, text) to authenticated;
grant execute on function public.clear_employee_permission_override(uuid) to authenticated;

commit;

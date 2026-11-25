create schema private;
create schema auth;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.employees (
  id uuid primary key,
  preferred_name text,
  first_name text not null,
  last_name text not null,
  role text not null,
  status text not null default 'active',
  permissions text[] not null
);
create table private.employee_accounts (
  employee_id uuid primary key,
  disabled_at timestamptz
);
create table public.permission_catalog (code text primary key);
create table public.access_roles (id uuid primary key, active boolean, code text);
create table public.employee_access_roles (employee_id uuid, role_id uuid);
create table public.employee_notifications (
  source_type text, recipient_employee_id uuid, read_at timestamptz, dismissed_at timestamptz
);
create table private.audit_events (
  auth_user_id uuid, employee_id uuid, schema_name text, table_name text, operation text,
  row_id text, old_record jsonb, new_record jsonb
);
create function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('fixture.actor', true), '')::uuid
$$;
create function private.current_employee_id() returns uuid language sql stable set search_path = '' as $$
  select employee.id from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id and account.disabled_at is null
  where employee.id = nullif(current_setting('fixture.actor', true), '')::uuid and employee.status = 'active'
$$;
create function public.current_app_role() returns text language sql stable set search_path = '' as $$
  select role from public.employees where id = private.current_employee_id()
$$;
create function public.has_mfa() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('fixture.aal2', true) = 'true', false)
$$;
create function private.employee_effective_permissions(employee_id uuid) returns text[] language sql stable set search_path = '' as $$
  select permissions from public.employees where id = employee_id
$$;
create function public.has_effective_permission(required text) returns boolean language sql stable set search_path = '' as $$
  select coalesce(
    required = any(private.employee_effective_permissions(private.current_employee_id()))
    and (required not in ('support.tickets.view','support.tickets.manage') or public.has_mfa()), false)
$$;
create function public.get_effective_permissions() returns text[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(grant_code), '{}'::text[])
  from unnest(private.employee_effective_permissions(private.current_employee_id())) as grant_list(grant_code)
  where public.has_effective_permission(grant_code)
$$;
insert into public.permission_catalog values
  ('admin.maintenance.manage'), ('admin.users.manage'), ('admin.security.manage'), ('hr.people.manage'),
  ('schedule.manage'), ('time.manage'), ('time.export_payroll'), ('hr.leave.manage'), ('hr.learning.manage'),
  ('sites.manage'), ('hr.assets.manage'), ('hr.safety.manage'), ('clients.manage'), ('notifications.manage');
insert into public.employees values
  ('10000000-0000-4000-8000-000000000001', null, 'Sample', 'Requester', 'guard', 'active',
    array['apps.sygilant.access','apps.sygshift.access']),
  ('10000000-0000-4000-8000-000000000002', null, 'Second', 'Requester', 'guard', 'active',
    array['apps.sygilant.access','apps.sygshift.access']),
  ('10000000-0000-4000-8000-000000000003', null, 'IT', 'Manager', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage','sygcurit.workspace.view',
      'admin.users.manage','admin.maintenance.manage','schedule.manage']),
  ('10000000-0000-4000-8000-000000000004', null, 'IT', 'Reader', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','sygcurit.workspace.view','admin.maintenance.manage']),
  ('10000000-0000-4000-8000-000000000005', null, 'System', 'Admin', 'admin', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage',
      'admin.users.view','admin.users.manage','sygcurit.workspace.view']),
  ('10000000-0000-4000-8000-000000000006', null, 'Disabled', 'Account', 'guard', 'active',
    array['apps.sygilant.access','apps.sygshift.access']),
  ('10000000-0000-4000-8000-000000000007', null, 'HR', 'Manager', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage',
      'hr.people.manage','hr.leave.manage','schedule.manage']),
  ('10000000-0000-4000-8000-000000000008', null, 'Finance', 'Manager', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage','time.export_payroll']),
  ('10000000-0000-4000-8000-000000000009', null, 'Site', 'Manager', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage','sites.manage']),
  ('10000000-0000-4000-8000-000000000010', null, 'Timekeeping', 'Manager', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage','time.manage']),
  ('10000000-0000-4000-8000-000000000011', null, 'IT', 'Handler', 'supervisor', 'active',
    array['apps.sygilant.access','apps.sygshift.access','support.tickets.view','support.tickets.manage','sygcurit.workspace.view',
      'admin.maintenance.manage','notifications.manage']);
insert into private.employee_accounts select id, case when first_name = 'Disabled' then now() else null end from public.employees;

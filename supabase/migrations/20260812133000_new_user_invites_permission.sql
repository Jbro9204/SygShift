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
  'admin.users.invite',
  'Administration',
  'New User Invites',
  'Send approved SygShift welcome emails and login instruction emails to active employees.',
  'sensitive',
  true,
  false,
  true
)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = excluded.active,
  updated_at = now();

update public.permission_catalog
set
  description = 'Create or reset login accounts, disable accounts, reset MFA, and revoke remembered devices.',
  updated_at = now()
where code = 'admin.users.manage';

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'admin.users.invite', true
from public.access_roles role
where role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set
  enabled = true,
  updated_at = now();

create or replace function public.get_admin_user_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  records jsonb;
begin
  actor_id := private.require_any_user_admin_permission(
    array[
      'admin.users.view',
      'admin.users.basic',
      'admin.users.manage',
      'admin.users.invite',
      'admin.users.separate',
      'admin.users.delete'
    ],
    false
  );

  select coalesce(jsonb_agg(private.admin_user_record(employee.id) order by employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into records
  from public.employees employee
  where not exists (
    select 1
    from private.removed_employee_records removed
    where removed.employee_id = employee.id
  );

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'users', records
  );
end
$$;

revoke all on function public.get_admin_user_directory() from public;
grant execute on function public.get_admin_user_directory() to authenticated;

begin;

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
  values (
    (select auth.uid()),
    actor_id,
    'public',
    'access_role_permissions',
    'UPDATE',
    target_role_id::text,
    jsonb_build_object('permissionCodes', clean_permissions)
  );

  return public.get_access_control_center();
end
$$;

revoke all on function public.set_access_role_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_access_role_permissions(uuid, text[]) to authenticated;

commit;

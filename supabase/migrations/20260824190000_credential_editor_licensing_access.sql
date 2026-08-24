begin;

-- Credential editors need the Licensing Center worklist to exercise the
-- credential permission they already hold. Other Licensing Center actions
-- remain independently permission-gated.
create or replace function private.require_licensing_mfa(required_permission text default 'licensing.view')
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  permitted boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  permitted := case
    when required_permission = 'licensing.view' then
      public.has_any_effective_permission(array['licensing.view', 'directory.edit_credentials'])
    else
      public.has_effective_permission(required_permission)
  end;

  if not permitted then
    raise insufficient_privilege using message = 'The required Licensing Center permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

revoke all on function private.require_licensing_mfa(text) from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from public.access_role_permissions permission
    join public.access_roles role on role.id = permission.role_id
    where role.code in ('system_scheduler', 'system_supervisor')
      and permission.permission_code = 'directory.edit_credentials'
      and permission.enabled
  ) then
    raise exception 'Scheduler/Supervisor credential-editor permission baseline is missing.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions permission
    join public.access_roles role on role.id = permission.role_id
    where role.code = 'system_guard'
      and permission.permission_code in ('directory.edit_credentials', 'licensing.view', 'licensing.manage')
      and permission.enabled
  ) then
    raise exception 'Guard role unexpectedly has Licensing Center access.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

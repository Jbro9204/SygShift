begin;

-- Administrators receive every Patrol permission through the role catalog. Do
-- not bypass the catalog here: sensitive Patrol permissions must still honor
-- their recent-MFA requirement for Administrators and every other manager.
create or replace function private.patrol_can_manage()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('patrol.manage')
    or public.has_effective_permission('patrol.routes.manage')
$$;

revoke all on function private.patrol_can_manage() from public, anon, authenticated;
grant execute on function private.patrol_can_manage() to service_role;

commit;

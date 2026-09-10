begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('private.employee_effective_permissions(uuid)') is null
     or to_regprocedure('private.employee_requires_mfa(uuid)') is null
     or to_regprocedure('private.current_employee_id()') is null
     or to_regprocedure('public.has_mfa()') is null then
    raise check_violation
      using message = 'The protected SygShift access-control functions must exist before the Guard launcher projection repair is applied.';
  end if;

  if not exists (
    select 1
    from public.permission_catalog catalog
    where catalog.code = 'apps.sygilant.access'
      and catalog.risk_level = 'critical'
      and catalog.requires_mfa
      and catalog.locked
      and catalog.active
  ) then
    raise check_violation
      using message = 'The protected Sygilant launcher permission is unavailable or its safeguards changed.';
  end if;

  if not exists (
    select 1
    from public.access_roles access_role
    join public.access_role_permissions role_permission
      on role_permission.role_id = access_role.id
     and role_permission.permission_code = 'apps.sygilant.access'
     and role_permission.enabled
    where access_role.code = 'system_guard'
      and access_role.base_app_role = 'guard'
      and access_role.system_role
      and access_role.protected
      and not access_role.mfa_required
      and access_role.active
  ) then
    raise check_violation
      using message = 'The protected Guard launcher role mapping must exist before its session projection is repaired.';
  end if;
end
$$;

-- The Sygilant launch ledger and Worker already enforce the canonical Guard-only
-- AAL1 exception. Project exactly that one permission into the authenticated
-- session so the existing launcher can reach those server-side controls.
-- All other MFA-sensitive permissions retain the original MFA filter. The
-- underlying permission calculation remains authoritative, including direct
-- employee denials.
create or replace function public.get_effective_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select
      employee.id as employee_id,
      employee.role,
      private.employee_requires_mfa(employee.id) as requires_mfa,
      public.has_mfa() as has_mfa
    from public.employees employee
    where employee.id = private.current_employee_id()
      and employee.status = 'active'
    limit 1
  )
  select coalesce(array_agg(granted.permission_code order by granted.permission_code), array[]::text[])
  from actor
  cross join lateral unnest(private.employee_effective_permissions(actor.employee_id)) as granted(permission_code)
  join public.permission_catalog catalog on catalog.code = granted.permission_code
  where catalog.active
    and (
      not catalog.requires_mfa
      or actor.has_mfa
      or (
        granted.permission_code = 'apps.sygilant.access'
        and actor.role = 'guard'
        and not actor.requires_mfa
      )
    )
$$;

comment on function public.get_effective_permissions() is
  'Returns the current active employee effective permissions after MFA projection. The sole AAL1 exception is apps.sygilant.access for a canonical Guard whose complete access profile does not require MFA; direct denials remain authoritative.';

revoke all on function public.get_effective_permissions() from public, anon;
grant execute on function public.get_effective_permissions() to authenticated;

notify pgrst, 'reload schema';
commit;

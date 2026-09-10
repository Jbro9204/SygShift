begin;

do $$
declare
  eligible_guard_auth_user_id uuid;
begin
  select account.auth_user_id
  into eligible_guard_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = 'guard'
    and account.disabled_at is null
    and not private.employee_requires_mfa(employee.id)
    and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  if eligible_guard_auth_user_id is null then
    raise exception 'Guard launcher preflight requires an active eligible canonical Guard without exposing that identity.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', eligible_guard_auth_user_id::text, 'aal', 'aal1', 'role', 'authenticated')::text,
    true
  );

  if 'apps.sygilant.access' = any(public.get_effective_permissions()) then
    raise exception 'The Guard AAL1 launcher projection defect is not present; stop before applying this repair.';
  end if;

  if exists (
    select 1
    from unnest(public.get_effective_permissions()) projected(permission_code)
    join public.permission_catalog catalog on catalog.code = projected.permission_code
    where catalog.requires_mfa
  ) then
    raise exception 'The preflight found an unexpected MFA-sensitive permission in an AAL1 session.';
  end if;
end
$$;

rollback;

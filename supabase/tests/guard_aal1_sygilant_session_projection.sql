begin;

do $$
declare
  eligible_guard_auth_user_id uuid;
  mfa_required_auth_user_id uuid;
  session_context_record record;
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

  select account.auth_user_id
  into mfa_required_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and private.employee_requires_mfa(employee.id)
    and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  if eligible_guard_auth_user_id is null or mfa_required_auth_user_id is null then
    raise exception 'Guard launcher projection verification requires eligible Guard and MFA-required launch subjects.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', eligible_guard_auth_user_id::text, 'aal', 'aal1', 'role', 'authenticated')::text,
    true
  );

  if not ('apps.sygilant.access' = any(public.get_effective_permissions())) then
    raise exception 'An eligible canonical Guard did not receive the Sygilant launcher permission at AAL1.';
  end if;

  if exists (
    select 1
    from unnest(public.get_effective_permissions()) projected(permission_code)
    join public.permission_catalog catalog on catalog.code = projected.permission_code
    where catalog.requires_mfa
      and projected.permission_code <> 'apps.sygilant.access'
  ) then
    raise exception 'The Guard launcher exception projected an unrelated MFA-sensitive permission.';
  end if;

  select *
  into session_context_record
  from public.get_session_context();

  if session_context_record.role <> 'guard'
     or session_context_record.mfa_required
     or session_context_record.has_mfa
     or not ('apps.sygilant.access' = any(session_context_record.permissions)) then
    raise exception 'The Guard AAL1 session context did not expose only the approved launcher exception.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', mfa_required_auth_user_id::text, 'aal', 'aal1', 'role', 'authenticated')::text,
    true
  );

  if 'apps.sygilant.access' = any(public.get_effective_permissions()) then
    raise exception 'An MFA-required employee received the Sygilant launcher permission at AAL1.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', mfa_required_auth_user_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );

  if not ('apps.sygilant.access' = any(public.get_effective_permissions())) then
    raise exception 'An approved MFA-required employee lost the Sygilant launcher permission after MFA.';
  end if;
end
$$;

rollback;

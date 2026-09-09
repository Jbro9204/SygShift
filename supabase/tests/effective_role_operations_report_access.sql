begin;

do $$
declare
  authorized_user_id uuid;
  unauthorized_user_id uuid;
  denied_without_permission boolean := false;
  denied_without_mfa boolean := false;
begin
  select account.auth_user_id
  into authorized_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.role not in ('supervisor', 'admin')
    and 'reports.view' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  select account.auth_user_id
  into unauthorized_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and not ('reports.view' = any(private.employee_effective_permissions(employee.id)))
  order by employee.id
  limit 1;

  if authorized_user_id is null or unauthorized_user_id is null then
    raise exception 'Effective-role report verification requires authorized and unauthorized active test subjects.';
  end if;

  if not has_function_privilege('authenticated', 'public.get_operations_report()', 'EXECUTE') then
    raise exception 'Authenticated employees cannot execute get_operations_report.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', authorized_user_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );
  perform public.get_operations_report();

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', unauthorized_user_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.get_operations_report();
  exception
    when insufficient_privilege then
      denied_without_permission := true;
  end;

  if not denied_without_permission then
    raise exception 'Operations report opened without effective reports.view.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', authorized_user_id::text, 'aal', 'aal1', 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.get_operations_report();
  exception
    when insufficient_privilege then
      denied_without_mfa := true;
  end;

  if not denied_without_mfa then
    raise exception 'MFA-sensitive Reports access opened without verified MFA.';
  end if;
end
$$;

rollback;

set search_path = '';

create or replace function public.mark_password_changed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_auth_user_id uuid := (select auth.uid());
begin
  if current_auth_user_id is null then
    raise insufficient_privilege
      using message = 'A signed-in SygShift account is required.';
  end if;

  update private.employee_accounts account
  set
    must_change_password = false,
    password_changed_at = coalesce(account.password_changed_at, clock_timestamp()),
    activated_at = coalesce(account.activated_at, clock_timestamp()),
    updated_at = clock_timestamp()
  from public.employees employee
  where employee.id = account.employee_id
    and account.auth_user_id = current_auth_user_id
    and account.disabled_at is null
    and employee.status = 'active';

  if not found then
    raise insufficient_privilege
      using message = 'A linked active SygShift account is required.';
  end if;
end
$$;

revoke all on function public.mark_password_changed() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;

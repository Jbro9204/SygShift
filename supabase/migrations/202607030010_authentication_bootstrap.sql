begin;

alter table private.employee_accounts
  add column if not exists must_change_password boolean not null default false,
  add column if not exists password_changed_at timestamptz,
  add column if not exists mfa_enrolled_at timestamptz,
  add column if not exists is_bootstrap_admin boolean not null default false;

create table if not exists private.system_bootstrap (
  id boolean primary key default true,
  employee_id uuid not null unique references public.employees(id) on delete restrict,
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  completed_at timestamptz not null default clock_timestamp(),
  completed_by text not null default 'system-bootstrap',
  constraint system_bootstrap_singleton check (id)
);

create or replace function public.get_session_context()
returns table (
  employee_id uuid,
  username text,
  display_name text,
  role public.app_role,
  must_change_password boolean,
  password_changed_at timestamptz,
  mfa_enrolled_at timestamptz,
  mfa_required boolean,
  has_mfa boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise insufficient_privilege
      using message = 'A signed-in SygShift account is required.';
  end if;

  return query
  select
    employee.id,
    employee.username,
    coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
    employee.role,
    account.must_change_password,
    account.password_changed_at,
    account.mfa_enrolled_at,
    employee.role in ('supervisor', 'admin') as mfa_required,
    public.has_mfa()
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;
end
$$;

create or replace function public.mark_password_changed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.employee_accounts account
  set
    must_change_password = false,
    password_changed_at = clock_timestamp(),
    activated_at = coalesce(account.activated_at, clock_timestamp()),
    updated_at = clock_timestamp()
  where account.employee_id = private.current_employee_id()
    and account.disabled_at is null;

  if not found then
    raise insufficient_privilege
      using message = 'A linked active SygShift account is required.';
  end if;
end
$$;

create or replace function public.mark_mfa_enrolled()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_mfa() then
    raise insufficient_privilege
      using message = 'An MFA-verified session is required.';
  end if;

  update private.employee_accounts account
  set
    mfa_enrolled_at = coalesce(account.mfa_enrolled_at, clock_timestamp()),
    activated_at = coalesce(account.activated_at, clock_timestamp()),
    updated_at = clock_timestamp()
  where account.employee_id = private.current_employee_id()
    and account.disabled_at is null;

  if not found then
    raise insufficient_privilege
      using message = 'A linked active SygShift account is required.';
  end if;
end
$$;

create or replace function public.register_bootstrap_admin(
  p_auth_user_id uuid,
  p_first_name text default 'Jordan',
  p_last_name text default 'Brown',
  p_requested_username text default 'jbrown'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_employee_id uuid := gen_random_uuid();
  generated_username text;
  requested_username text := lower(btrim(p_requested_username));
  first_name text := nullif(btrim(p_first_name), '');
  last_name text := nullif(btrim(p_last_name), '');
begin
  if exists (select 1 from private.system_bootstrap) then
    raise exception 'The initial SygShift administrator has already been registered.'
      using errcode = '23505';
  end if;

  if p_auth_user_id is null then
    raise invalid_parameter_value using message = 'An auth user id is required.';
  end if;

  if first_name is null or last_name is null then
    raise invalid_parameter_value using message = 'The administrator first and last name are required.';
  end if;

  if requested_username !~ '^[a-z][a-z0-9]{1,62}$' then
    raise invalid_parameter_value using message = 'The requested username is not valid.';
  end if;

  if not exists (select 1 from auth.users auth_user where auth_user.id = p_auth_user_id) then
    raise foreign_key_violation using message = 'The Supabase auth user does not exist.';
  end if;

  insert into public.employees (
    id,
    first_name,
    last_name,
    role,
    employment_type,
    status
  ) values (
    new_employee_id,
    first_name,
    last_name,
    'admin',
    'salary',
    'active'
  )
  returning username into generated_username;

  if generated_username <> requested_username then
    raise unique_violation
      using message = 'The requested bootstrap username is not available.';
  end if;

  insert into private.employee_accounts (
    employee_id,
    auth_user_id,
    invited_at,
    activated_at,
    must_change_password,
    is_bootstrap_admin
  ) values (
    new_employee_id,
    p_auth_user_id,
    clock_timestamp(),
    clock_timestamp(),
    true,
    true
  );

  insert into private.system_bootstrap (
    employee_id,
    auth_user_id
  ) values (
    new_employee_id,
    p_auth_user_id
  );

  return new_employee_id;
end
$$;

revoke all on function public.get_session_context() from public, anon;
revoke all on function public.mark_password_changed() from public, anon;
revoke all on function public.mark_mfa_enrolled() from public, anon;
revoke all on function public.register_bootstrap_admin(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.get_session_context() to authenticated;
grant execute on function public.mark_password_changed() to authenticated;
grant execute on function public.mark_mfa_enrolled() to authenticated;
grant execute on function public.register_bootstrap_admin(uuid, text, text, text) to service_role;

commit;

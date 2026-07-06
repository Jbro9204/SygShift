begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists private.trusted_devices (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  token_hash text not null unique,
  device_label text,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.employees(id),
  last_seen_at timestamptz
);

create index if not exists trusted_devices_employee_active_idx
on private.trusted_devices (employee_id, expires_at)
where revoked_at is null;

alter table private.trusted_devices enable row level security;

create or replace function private.request_header(header_name text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  headers jsonb;
  normalized_header_name text := lower(header_name);
begin
  headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  return nullif(headers ->> normalized_header_name, '');
exception
  when others then
    return null;
end
$$;

create or replace function private.has_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
$$;

create or replace function public.has_trusted_device()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  trusted_token text := private.request_header('x-sygshift-trusted-device');
  trusted_hash text;
begin
  if actor_id is null or trusted_token is null then
    return false;
  end if;

  if length(trusted_token) < 48 or length(trusted_token) > 160 then
    return false;
  end if;

  trusted_hash := encode(extensions.digest(trusted_token, 'sha256'), 'hex');

  return exists (
    select 1
    from private.trusted_devices trusted_device
    where trusted_device.employee_id = actor_id
      and trusted_device.token_hash = trusted_hash
      and trusted_device.revoked_at is null
      and trusted_device.expires_at > now()
  );
end
$$;

create or replace function public.has_mfa()
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.has_aal2() or public.has_trusted_device()
$$;

create or replace function public.register_trusted_device(
  trusted_token text,
  trusted_days integer default 14,
  trusted_device_label text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_token text := btrim(coalesce(trusted_token, ''));
  clean_label text := nullif(left(btrim(coalesce(trusted_device_label, '')), 120), '');
  safe_days integer := least(greatest(coalesce(trusted_days, 14), 1), 30);
  trusted_id uuid;
  trusted_expires_at timestamptz := clock_timestamp() + make_interval(days => safe_days);
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not private.has_aal2() then
    raise insufficient_privilege using message = 'A fresh authenticator verification is required before remembering this device.';
  end if;

  if clean_token !~ '^[A-Za-z0-9_-]{48,160}$' then
    raise check_violation using message = 'The trusted-device token was not valid.';
  end if;

  insert into private.trusted_devices (
    employee_id,
    token_hash,
    device_label,
    expires_at,
    last_seen_at
  )
  values (
    actor_id,
    encode(extensions.digest(clean_token, 'sha256'), 'hex'),
    clean_label,
    trusted_expires_at,
    clock_timestamp()
  )
  on conflict (token_hash) do update
  set
    employee_id = excluded.employee_id,
    device_label = excluded.device_label,
    expires_at = excluded.expires_at,
    revoked_at = null,
    revoked_by = null,
    last_seen_at = clock_timestamp()
  returning id into trusted_id;

  return jsonb_build_object(
    'id', trusted_id,
    'expiresAt', trusted_expires_at,
    'days', safe_days
  );
end
$$;

create or replace function public.get_current_trusted_devices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', trusted_device.id,
      'deviceLabel', trusted_device.device_label,
      'createdAt', trusted_device.created_at,
      'expiresAt', trusted_device.expires_at,
      'lastSeenAt', trusted_device.last_seen_at,
      'isCurrentDevice', trusted_device.token_hash = encode(extensions.digest(coalesce(private.request_header('x-sygshift-trusted-device'), ''), 'sha256'), 'hex')
    ) order by trusted_device.expires_at desc)
    from private.trusted_devices trusted_device
    where trusted_device.employee_id = actor_id
      and trusted_device.revoked_at is null
      and trusted_device.expires_at > now()
  ), '[]'::jsonb);
end
$$;

create or replace function public.revoke_current_trusted_device(target_trusted_device_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  update private.trusted_devices trusted_device
  set
    revoked_at = clock_timestamp(),
    revoked_by = actor_id
  where trusted_device.id = target_trusted_device_id
    and trusted_device.employee_id = actor_id
    and trusted_device.revoked_at is null;
end
$$;

create or replace function public.admin_revoke_employee_trusted_devices(target_employee_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  revoked_count integer;
begin
  actor_id := private.require_admin_mfa();

  update private.trusted_devices trusted_device
  set
    revoked_at = clock_timestamp(),
    revoked_by = actor_id
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null
    and trusted_device.expires_at > now();

  get diagnostics revoked_count = row_count;
  return revoked_count;
end
$$;

create or replace function public.mark_mfa_enrolled()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_aal2() then
    raise insufficient_privilege using message = 'Authenticator verification is required before MFA can be recorded.';
  end if;

  update private.employee_accounts account
  set mfa_enrolled_at = coalesce(account.mfa_enrolled_at, clock_timestamp())
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null;

  if not found then
    raise insufficient_privilege using message = 'No active account was found for this user.';
  end if;
end
$$;

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

create or replace function private.admin_user_record(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', employee.id,
    'employeeNumber', employee.employee_number,
    'jobTitle', employee.job_title,
    'username', employee.username,
    'firstName', employee.first_name,
    'middleName', employee.middle_name,
    'lastName', employee.last_name,
    'preferredName', employee.preferred_name,
    'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'status', employee.status,
    'photoPath', employee.photo_path,
    'hiredOn', employee.hired_on,
    'separatedOn', employee.separated_on,
    'personalEmail', contact.personal_email,
    'companyEmail', contact.company_email,
    'mobilePhone', contact.mobile_phone,
    'account', case when account.employee_id is null then null else jsonb_build_object(
      'authUserId', account.auth_user_id,
      'invitedAt', account.invited_at,
      'activatedAt', account.activated_at,
      'disabledAt', account.disabled_at,
      'lastSignInAt', account.last_sign_in_at,
      'mustChangePassword', account.must_change_password,
      'passwordChangedAt', account.password_changed_at,
      'mfaEnrolledAt', account.mfa_enrolled_at,
      'isBootstrapAdmin', account.is_bootstrap_admin,
      'status', case when account.disabled_at is not null then 'disabled' else 'active' end,
      'trustedDeviceCount', (
        select count(*)::integer
        from private.trusted_devices trusted_device
        where trusted_device.employee_id = employee.id
          and trusted_device.revoked_at is null
          and trusted_device.expires_at > now()
      )
    ) end,
    'accountStatus', case
      when account.employee_id is null then 'not_created'
      when account.disabled_at is not null then 'disabled'
      else 'active'
    end,
    'credentials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', credential.id,
        'kind', credential.kind,
        'status', credential.status,
        'credentialNumber', credential.credential_number,
        'validFrom', credential.valid_from,
        'expiresOn', credential.expires_on,
        'notes', credential.notes
      ) order by credential.kind, credential.expires_on nulls last)
      from public.employee_credentials credential
      where credential.employee_id = employee.id
    ), '[]'::jsonb)
  )
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_accounts account on account.employee_id = employee.id
  where employee.id = target_employee_id
$$;

revoke all on table private.trusted_devices from public, anon, authenticated;
revoke all on function private.request_header(text) from public, anon, authenticated;
revoke all on function private.has_aal2() from public, anon, authenticated;
revoke all on function public.has_trusted_device() from public, anon;
revoke all on function public.register_trusted_device(text, integer, text) from public, anon;
revoke all on function public.get_current_trusted_devices() from public, anon;
revoke all on function public.revoke_current_trusted_device(uuid) from public, anon;
revoke all on function public.admin_revoke_employee_trusted_devices(uuid) from public, anon;
revoke all on function public.mark_mfa_enrolled() from public, anon;
revoke all on function public.get_session_context() from public, anon;

grant execute on function public.has_trusted_device() to authenticated;
grant execute on function public.register_trusted_device(text, integer, text) to authenticated;
grant execute on function public.get_current_trusted_devices() to authenticated;
grant execute on function public.revoke_current_trusted_device(uuid) to authenticated;
grant execute on function public.admin_revoke_employee_trusted_devices(uuid) to authenticated;
grant execute on function public.mark_mfa_enrolled() to authenticated;
grant execute on function public.get_session_context() to authenticated;

commit;

begin;

create or replace function public.sygilant_register_trusted_device_after_security_key(
  target_employee_id uuid,
  target_auth_session_id uuid,
  target_security_key_session_id uuid,
  target_trusted_token text,
  target_device_label text default null,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_token text := btrim(coalesce(target_trusted_token, ''));
  clean_label text := nullif(left(btrim(coalesce(target_device_label, '')), 120), '');
  trusted_id uuid;
  trusted_expires_at timestamptz := clock_timestamp() + interval '14 days';
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if target_employee_id is null or target_auth_session_id is null or target_security_key_session_id is null then
    raise check_violation using message = 'The verified security-key identity was incomplete.';
  end if;

  if clean_token !~ '^[A-Za-z0-9_-]{48,160}$' then
    raise check_violation using message = 'The trusted-device token was not valid.';
  end if;

  if not exists (
    select 1
    from private.security_key_sessions security_session
    join private.employee_accounts account
      on account.employee_id = security_session.employee_id
     and account.disabled_at is null
    join auth.sessions auth_session
      on auth_session.id = security_session.auth_session_id
     and auth_session.user_id = account.auth_user_id
     and (auth_session.not_after is null or auth_session.not_after > now())
    join public.employees employee
      on employee.id = security_session.employee_id
     and employee.status::text = 'active'
    where security_session.id = target_security_key_session_id
      and security_session.employee_id = target_employee_id
      and security_session.auth_session_id = target_auth_session_id
      and security_session.revoked_at is null
      and security_session.expires_at > now()
  ) then
    raise insufficient_privilege using message = 'A current verified security-key session is required.';
  end if;

  insert into private.trusted_devices (
    employee_id,
    token_hash,
    device_label,
    expires_at,
    last_seen_at
  ) values (
    target_employee_id,
    encode(extensions.digest(clean_token, 'sha256'), 'hex'),
    clean_label,
    trusted_expires_at,
    clock_timestamp()
  )
  returning id into trusted_id;

  insert into private.audit_events (
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'trusted_devices',
    'SECURITY_KEY_REMEMBER',
    trusted_id::text,
    jsonb_build_object(
      'authSessionId', target_auth_session_id,
      'deviceLabel', clean_label,
      'expiresAt', trusted_expires_at,
      'securityKeySessionId', target_security_key_session_id
    )
  );

  return jsonb_build_object(
    'id', trusted_id,
    'expiresAt', trusted_expires_at,
    'days', 14
  );
end
$$;

revoke all on function public.sygilant_register_trusted_device_after_security_key(uuid, uuid, uuid, text, text, text)
from public, anon, authenticated;

grant execute on function public.sygilant_register_trusted_device_after_security_key(uuid, uuid, uuid, text, text, text)
to service_role;

comment on function public.sygilant_register_trusted_device_after_security_key(uuid, uuid, uuid, text, text, text) is
'Issues a revocable 14-day SygShift trusted-device record only after a service-verified, active security-key session.';

commit;

;

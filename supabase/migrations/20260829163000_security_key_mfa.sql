begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists private.webauthn_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  signature_counter bigint not null default 0 check (signature_counter >= 0),
  transports text[] not null default '{}'::text[],
  device_type text,
  backed_up boolean not null default false,
  label text not null,
  webauthn_user_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.employees(id) on delete restrict,
  constraint webauthn_credentials_label_present check (btrim(label) <> ''),
  constraint webauthn_credentials_label_length check (char_length(label) <= 60)
);

create index if not exists webauthn_credentials_employee_active_idx
on private.webauthn_credentials (employee_id, created_at desc)
where revoked_at is null;

create table if not exists private.webauthn_challenges (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  purpose text not null check (purpose in ('registration', 'authentication')),
  challenge text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists webauthn_challenges_lookup_idx
on private.webauthn_challenges (employee_id, purpose, expires_at desc)
where consumed_at is null;

create table if not exists private.security_key_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  auth_session_id uuid not null,
  token_hash text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.employees(id) on delete restrict
);

create index if not exists security_key_sessions_employee_active_idx
on private.security_key_sessions (employee_id, auth_session_id, expires_at)
where revoked_at is null;

alter table private.webauthn_credentials enable row level security;
alter table private.webauthn_challenges enable row level security;
alter table private.security_key_sessions enable row level security;

create or replace function public.has_security_key_session()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  session_token text := private.request_header('x-sygshift-security-key');
  jwt_session_id_text text := (select auth.jwt() ->> 'session_id');
  jwt_session_id uuid;
begin
  if actor_id is null or session_token is null or jwt_session_id_text is null then
    return false;
  end if;

  if session_token !~ '^[A-Za-z0-9_-]{40,180}$' then
    return false;
  end if;

  begin
    jwt_session_id := jwt_session_id_text::uuid;
  exception when others then
    return false;
  end;

  return exists (
    select 1
    from private.security_key_sessions security_session
    where security_session.employee_id = actor_id
      and security_session.auth_session_id = jwt_session_id
      and security_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
      and security_session.revoked_at is null
      and security_session.expires_at > now()
  );
end
$$;

create or replace function public.has_mfa()
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.has_aal2()
    or public.has_trusted_device()
    or public.has_security_key_session()
$$;

create or replace function public.service_list_webauthn_credentials(target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', credential.id,
      'credentialId', credential.credential_id,
      'publicKey', credential.public_key,
      'counter', credential.signature_counter,
      'transports', credential.transports,
      'deviceType', credential.device_type,
      'backedUp', credential.backed_up,
      'label', credential.label,
      'createdAt', credential.created_at,
      'lastUsedAt', credential.last_used_at
    ) order by credential.created_at desc)
    from private.webauthn_credentials credential
    where credential.employee_id = target_employee_id
      and credential.revoked_at is null
  ), '[]'::jsonb);
end
$$;

create or replace function public.service_store_webauthn_challenge(
  target_employee_id uuid,
  target_purpose text,
  target_challenge text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  challenge_id uuid;
  challenge_expires_at timestamptz := clock_timestamp() + interval '5 minutes';
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_purpose not in ('registration', 'authentication') then
    raise check_violation using message = 'Unsupported WebAuthn challenge purpose.';
  end if;
  if btrim(coalesce(target_challenge, '')) = '' then
    raise check_violation using message = 'A WebAuthn challenge is required.';
  end if;

  delete from private.webauthn_challenges challenge
  where challenge.employee_id = target_employee_id
    and (challenge.expires_at <= now() or challenge.consumed_at is not null);

  insert into private.webauthn_challenges (employee_id, purpose, challenge, expires_at)
  values (target_employee_id, target_purpose, target_challenge, challenge_expires_at)
  returning id into challenge_id;

  return jsonb_build_object('id', challenge_id, 'expiresAt', challenge_expires_at);
end
$$;

create or replace function public.service_consume_webauthn_challenge(
  target_employee_id uuid,
  target_challenge_id uuid,
  target_purpose text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  consumed_challenge private.webauthn_challenges%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  update private.webauthn_challenges challenge
  set consumed_at = clock_timestamp()
  where challenge.id = target_challenge_id
    and challenge.employee_id = target_employee_id
    and challenge.purpose = target_purpose
    and challenge.consumed_at is null
    and challenge.expires_at > now()
  returning * into consumed_challenge;

  if consumed_challenge.id is null then
    raise check_violation using message = 'The security key request expired or was already used.';
  end if;

  return jsonb_build_object(
    'id', consumed_challenge.id,
    'challenge', consumed_challenge.challenge,
    'expiresAt', consumed_challenge.expires_at
  );
end
$$;

create or replace function public.service_store_webauthn_credential(
  target_employee_id uuid,
  target_credential_id text,
  target_public_key text,
  target_counter bigint,
  target_transports text[],
  target_device_type text,
  target_backed_up boolean,
  target_label text,
  target_webauthn_user_id text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_record private.webauthn_credentials%rowtype;
  active_count integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select count(*)::integer into active_count
  from private.webauthn_credentials credential
  where credential.employee_id = target_employee_id and credential.revoked_at is null;

  if active_count >= 5 then
    raise check_violation using message = 'A maximum of five active security keys is allowed.';
  end if;

  insert into private.webauthn_credentials (
    employee_id, credential_id, public_key, signature_counter, transports,
    device_type, backed_up, label, webauthn_user_id
  ) values (
    target_employee_id,
    target_credential_id,
    target_public_key,
    greatest(coalesce(target_counter, 0), 0),
    coalesce(target_transports, '{}'::text[]),
    nullif(btrim(coalesce(target_device_type, '')), ''),
    coalesce(target_backed_up, false),
    left(btrim(target_label), 60),
    target_webauthn_user_id
  )
  returning * into credential_record;

  update private.employee_accounts account
  set mfa_enrolled_at = coalesce(account.mfa_enrolled_at, clock_timestamp())
  where account.employee_id = target_employee_id and account.disabled_at is null;

  insert into private.audit_events (
    employee_id, request_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'webauthn_credentials',
    'REGISTER',
    credential_record.id::text,
    jsonb_build_object('label', credential_record.label, 'credentialId', credential_record.credential_id)
  );

  return jsonb_build_object(
    'id', credential_record.id,
    'label', credential_record.label,
    'createdAt', credential_record.created_at
  );
end
$$;

create or replace function public.service_update_webauthn_counter(
  target_employee_id uuid,
  target_credential_id text,
  target_counter bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_counter bigint;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if target_counter is null or target_counter < 0 then
    raise check_violation using message = 'The security-key signature counter was invalid.';
  end if;

  select credential.signature_counter into current_counter
  from private.webauthn_credentials credential
  where credential.employee_id = target_employee_id
    and credential.credential_id = target_credential_id
    and credential.revoked_at is null
  for update;

  if current_counter is null then
    raise no_data_found using message = 'The security key is no longer registered.';
  end if;

  if current_counter > 0 and target_counter <= current_counter then
    raise check_violation using message = 'The security-key signature counter did not advance.';
  end if;

  update private.webauthn_credentials credential
  set signature_counter = target_counter,
      last_used_at = clock_timestamp()
  where credential.employee_id = target_employee_id
    and credential.credential_id = target_credential_id
    and credential.revoked_at is null;
end
$$;

create or replace function public.service_issue_security_key_session(
  target_employee_id uuid,
  target_auth_session_id uuid,
  target_token_hash text,
  target_expires_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  security_session_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_expires_at <= now() or target_expires_at > now() + interval '12 hours 5 minutes' then
    raise check_violation using message = 'The security-key session expiration was invalid.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The security-key session token was invalid.';
  end if;

  update private.security_key_sessions security_session
  set revoked_at = clock_timestamp(), revoked_by = target_employee_id
  where security_session.employee_id = target_employee_id
    and security_session.auth_session_id = target_auth_session_id
    and security_session.revoked_at is null;

  insert into private.security_key_sessions (
    employee_id, auth_session_id, token_hash, expires_at, last_seen_at
  ) values (
    target_employee_id, target_auth_session_id, target_token_hash, target_expires_at, clock_timestamp()
  ) returning id into security_session_id;

  insert into private.audit_events (
    employee_id, request_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'security_key_sessions',
    'VERIFY',
    security_session_id::text,
    jsonb_build_object('authSessionId', target_auth_session_id, 'expiresAt', target_expires_at)
  );

  return jsonb_build_object('id', security_session_id, 'expiresAt', target_expires_at);
end
$$;

create or replace function public.service_revoke_webauthn_credential(
  target_employee_id uuid,
  target_credential_record_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_record private.webauthn_credentials%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  update private.webauthn_credentials credential
  set revoked_at = clock_timestamp(), revoked_by = target_employee_id
  where credential.id = target_credential_record_id
    and credential.employee_id = target_employee_id
    and credential.revoked_at is null
  returning * into credential_record;

  if credential_record.id is null then
    raise no_data_found using message = 'The security key was not found.';
  end if;

  update private.security_key_sessions security_session
  set revoked_at = clock_timestamp(), revoked_by = target_employee_id
  where security_session.employee_id = target_employee_id and security_session.revoked_at is null;

  insert into private.audit_events (
    employee_id, request_id, schema_name, table_name, operation, row_id, old_record
  ) values (
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'webauthn_credentials',
    'REVOKE',
    credential_record.id::text,
    jsonb_build_object('label', credential_record.label, 'credentialId', credential_record.credential_id)
  );

  return jsonb_build_object('id', credential_record.id, 'revoked', true);
end
$$;

create or replace function public.service_record_employee_mfa_reset(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_factor_count integer,
  target_actor_employee_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  expected_auth_user_id uuid;
  trusted_revoked_count integer := 0;
  keys_revoked_count integer := 0;
  sessions_revoked_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_factor_count is null or target_factor_count < 0 then
    raise check_violation using message = 'Factor count must be zero or greater.';
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.id = target_actor_employee_id and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The reset operator was not an active employee.';
  end if;

  select account.auth_user_id into expected_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_employee_id;

  if expected_auth_user_id is null or expected_auth_user_id <> target_auth_user_id then
    raise check_violation using message = 'The employee login account did not match the reset request.';
  end if;

  update private.trusted_devices trusted_device
  set revoked_at = clock_timestamp(), revoked_by = target_actor_employee_id
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null and trusted_device.expires_at > now();
  get diagnostics trusted_revoked_count = row_count;

  update private.webauthn_credentials credential
  set revoked_at = clock_timestamp(), revoked_by = target_actor_employee_id
  where credential.employee_id = target_employee_id and credential.revoked_at is null;
  get diagnostics keys_revoked_count = row_count;

  update private.security_key_sessions security_session
  set revoked_at = clock_timestamp(), revoked_by = target_actor_employee_id
  where security_session.employee_id = target_employee_id and security_session.revoked_at is null;
  get diagnostics sessions_revoked_count = row_count;

  update private.employee_accounts account
  set mfa_enrolled_at = null
  where account.employee_id = target_employee_id;

  insert into private.employee_mfa_reset_events (
    employee_id, auth_user_id, factors_removed, trusted_devices_revoked,
    reset_by, request_id
  ) values (
    target_employee_id, target_auth_user_id, target_factor_count,
    trusted_revoked_count, target_actor_employee_id, nullif(btrim(target_request_id), '')
  );

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'factorsRemoved', target_factor_count,
    'trustedDevicesRevoked', trusted_revoked_count,
    'securityKeysRevoked', keys_revoked_count,
    'securityKeySessionsRevoked', sessions_revoked_count,
    'resetBy', target_actor_employee_id
  );
end
$$;

revoke all on table private.webauthn_credentials from public, anon, authenticated;
revoke all on table private.webauthn_challenges from public, anon, authenticated;
revoke all on table private.security_key_sessions from public, anon, authenticated;
revoke all on function public.has_security_key_session() from public, anon;
revoke all on function public.service_list_webauthn_credentials(uuid) from public, anon, authenticated;
revoke all on function public.service_store_webauthn_challenge(uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_consume_webauthn_challenge(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_store_webauthn_credential(uuid, text, text, bigint, text[], text, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.service_update_webauthn_counter(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.service_issue_security_key_session(uuid, uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.service_revoke_webauthn_credential(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_record_employee_mfa_reset(uuid, uuid, integer, uuid, text) from public, anon, authenticated;

grant execute on function public.has_security_key_session() to authenticated;
grant execute on function public.service_list_webauthn_credentials(uuid) to service_role;
grant execute on function public.service_store_webauthn_challenge(uuid, text, text) to service_role;
grant execute on function public.service_consume_webauthn_challenge(uuid, uuid, text) to service_role;
grant execute on function public.service_store_webauthn_credential(uuid, text, text, bigint, text[], text, boolean, text, text, text) to service_role;
grant execute on function public.service_update_webauthn_counter(uuid, text, bigint) to service_role;
grant execute on function public.service_issue_security_key_session(uuid, uuid, text, timestamptz, text) to service_role;
grant execute on function public.service_revoke_webauthn_credential(uuid, uuid, text) to service_role;
grant execute on function public.service_record_employee_mfa_reset(uuid, uuid, integer, uuid, text) to service_role;

commit;

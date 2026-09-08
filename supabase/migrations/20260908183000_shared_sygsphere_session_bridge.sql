begin;
set local lock_timeout = '5s';

create table if not exists private.shared_identity_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id uuid not null,
  launch_request_id uuid not null unique,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  assurance_level text not null check (assurance_level in ('aal2', 'security_key', 'trusted_device', 'external_mfa')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  constraint shared_identity_session_expiration check (expires_at > created_at)
);

create index if not exists shared_identity_sessions_employee_active_idx
on private.shared_identity_sessions(employee_id, auth_session_id, expires_at)
where revoked_at is null;

alter table private.shared_identity_sessions enable row level security;
alter table private.shared_identity_sessions force row level security;
revoke all on private.shared_identity_sessions from public, anon, authenticated;

create or replace function public.has_shared_identity_session()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  session_token text := private.request_header('x-sygshift-shared-identity');
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
    from private.shared_identity_sessions shared_session
    where shared_session.employee_id = actor_id
      and shared_session.auth_session_id = jwt_session_id
      and shared_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
      and shared_session.revoked_at is null
      and shared_session.expires_at > now()
  );
end
$$;

create or replace function public.service_issue_shared_identity_session(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_auth_session_id uuid,
  target_launch_request_id uuid,
  target_token_hash text,
  target_assurance_level text,
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
  shared_session_id uuid;
  maximum_expiration interval;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_assurance_level not in ('aal2', 'security_key', 'trusted_device', 'external_mfa') then
    raise check_violation using message = 'The shared assurance level was invalid.';
  end if;
  maximum_expiration := case
    when target_assurance_level = 'trusted_device' then interval '14 days 5 minutes'
    else interval '12 hours 5 minutes'
  end;
  if target_expires_at <= now() or target_expires_at > now() + maximum_expiration then
    raise check_violation using message = 'The shared session expiration was invalid.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The shared session token was invalid.';
  end if;
  if not exists (
    select 1
    from private.employee_accounts account
    join public.employees employee on employee.id = account.employee_id
    where account.employee_id = target_employee_id
      and account.auth_user_id = target_auth_user_id
      and account.disabled_at is null
      and employee.status = 'active'
  ) then
    raise insufficient_privilege using message = 'The shared identity is not linked to an active SygShift account.';
  end if;

  update private.shared_identity_sessions shared_session
  set revoked_at = clock_timestamp()
  where shared_session.employee_id = target_employee_id
    and shared_session.auth_session_id = target_auth_session_id
    and shared_session.revoked_at is null;

  insert into private.shared_identity_sessions (
    employee_id,
    auth_user_id,
    auth_session_id,
    launch_request_id,
    token_hash,
    assurance_level,
    expires_at,
    last_seen_at
  ) values (
    target_employee_id,
    target_auth_user_id,
    target_auth_session_id,
    target_launch_request_id,
    target_token_hash,
    target_assurance_level,
    target_expires_at,
    clock_timestamp()
  ) returning id into shared_session_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    target_auth_user_id,
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'shared_identity_sessions',
    'VERIFY',
    shared_session_id::text,
    jsonb_build_object(
      'assuranceLevel', target_assurance_level,
      'authSessionId', target_auth_session_id,
      'expiresAt', target_expires_at,
      'launchRequestId', target_launch_request_id
    )
  );

  return jsonb_build_object('id', shared_session_id, 'expiresAt', target_expires_at);
exception
  when unique_violation then
    raise insufficient_privilege using message = 'The shared launch request has already been finalized.';
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
    or public.has_shared_identity_session()
$$;

revoke all on function public.has_shared_identity_session() from public, anon;
grant execute on function public.has_shared_identity_session() to authenticated;
revoke all on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text) to service_role;

commit;

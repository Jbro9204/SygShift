begin;
set local lock_timeout = '5s';

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values (
  'apps.sygshift.access',
  'Connected Applications',
  'Open SygShift workforce platform',
  'Use the protected, single-use shared identity handoff to enter SygShift from Sygilant.',
  'critical',
  true,
  true,
  true
)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = clock_timestamp();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'apps.sygshift.access', true
from public.access_roles access_role
where access_role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = excluded.enabled,
    updated_at = clock_timestamp();

alter table private.shared_identity_sessions
  add column scope text;

update private.shared_identity_sessions
set scope = 'sygsphere'
where scope is null;

alter table private.shared_identity_sessions
  alter column scope set default 'sygsphere',
  alter column scope set not null,
  add constraint shared_identity_sessions_scope_check
    check (scope in ('platform', 'sygsphere'));

create index shared_identity_sessions_scope_active_idx
on private.shared_identity_sessions(employee_id, auth_session_id, scope, expires_at)
where revoked_at is null;

create or replace function public.has_scoped_shared_identity_session(target_scope text)
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
  if target_scope not in ('platform', 'sygsphere')
    or actor_id is null
    or (select auth.uid()) is null
    or session_token is null
    or jwt_session_id_text is null
    or session_token !~ '^[A-Za-z0-9_-]{40,180}$' then
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
    join private.employee_accounts account
      on account.employee_id = shared_session.employee_id
     and account.auth_user_id = shared_session.auth_user_id
    join public.employees employee
      on employee.id = account.employee_id
    join auth.sessions auth_session
      on auth_session.id = shared_session.auth_session_id
     and auth_session.user_id = shared_session.auth_user_id
     and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
    where shared_session.employee_id = actor_id
      and shared_session.auth_user_id = (select auth.uid())
      and shared_session.auth_session_id = jwt_session_id
      and shared_session.scope = target_scope
      and shared_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
      and shared_session.revoked_at is null
      and shared_session.expires_at > clock_timestamp()
      and account.disabled_at is null
      and not account.must_change_password
      and employee.status = 'active'
  );
end
$$;

create or replace function public.has_shared_identity_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_scoped_shared_identity_session('platform')
    or public.has_scoped_shared_identity_session('sygsphere')
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
    or public.has_scoped_shared_identity_session('platform')
$$;

create or replace function public.service_issue_shared_identity_session(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_auth_session_id uuid,
  target_launch_request_id uuid,
  target_token_hash text,
  target_assurance_level text,
  target_expires_at timestamptz,
  target_scope text,
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
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_scope not in ('platform', 'sygsphere') then
    raise check_violation using message = 'The shared session scope was invalid.';
  end if;
  if target_assurance_level not in ('aal2', 'security_key', 'trusted_device', 'external_mfa') then
    raise check_violation using message = 'The shared assurance level was invalid.';
  end if;

  maximum_expiration := case
    when target_assurance_level = 'trusted_device' then interval '14 days 5 minutes'
    else interval '12 hours 5 minutes'
  end;
  if target_expires_at <= clock_timestamp()
    or target_expires_at > clock_timestamp() + maximum_expiration then
    raise check_violation using message = 'The shared session expiration was invalid.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The shared session token was invalid.';
  end if;
  if not exists (
    select 1
    from private.employee_accounts account
    join public.employees employee on employee.id = account.employee_id
    join auth.sessions auth_session
      on auth_session.id = target_auth_session_id
     and auth_session.user_id = account.auth_user_id
     and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
    where account.employee_id = target_employee_id
      and account.auth_user_id = target_auth_user_id
      and account.disabled_at is null
      and not account.must_change_password
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
    scope,
    expires_at,
    last_seen_at
  ) values (
    target_employee_id,
    target_auth_user_id,
    target_auth_session_id,
    target_launch_request_id,
    target_token_hash,
    target_assurance_level,
    target_scope,
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
      'launchRequestId', target_launch_request_id,
      'scope', target_scope
    )
  );

  return jsonb_build_object(
    'id', shared_session_id,
    'expiresAt', target_expires_at,
    'scope', target_scope
  );
exception
  when unique_violation then
    raise insufficient_privilege using message = 'The shared launch request has already been finalized.';
end
$$;

-- Preserve the deployed eight-argument receiver during the rolling release,
-- but confine it permanently to the established SygSphere scope.
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
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  return public.service_issue_shared_identity_session(
    target_employee_id,
    target_auth_user_id,
    target_auth_session_id,
    target_launch_request_id,
    target_token_hash,
    target_assurance_level,
    target_expires_at,
    'sygsphere',
    target_request_id
  );
end
$$;

alter table private.employee_sign_in_completions
  drop constraint if exists employee_sign_in_completions_completion_source_check,
  add constraint employee_sign_in_completions_completion_source_check
    check (completion_source in ('native', 'platform', 'sygsphere'));

create or replace function public.platform_record_completed_sign_in()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  jwt_session_id uuid;
  shared_token text := private.request_header('x-sygshift-shared-identity');
  shared_token_hash text;
  recorded_at timestamptz;
  inserted_completion boolean := false;
  account_admitted boolean := false;
  updated_account_count integer := 0;
begin
  if actor_id is null or (select auth.uid()) is null then
    raise insufficient_privilege using message = 'An active SygShift account is required.';
  end if;

  begin
    jwt_session_id := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when others then
    raise insufficient_privilege using message = 'A valid shared SygShift session is required.';
  end;

  if jwt_session_id is null
    or shared_token is null
    or shared_token !~ '^[A-Za-z0-9_-]{40,180}$'
    or not public.has_scoped_shared_identity_session('platform') then
    raise insufficient_privilege using message = 'A valid shared SygShift platform session is required.';
  end if;

  shared_token_hash := encode(extensions.digest(shared_token, 'sha256'), 'hex');

  select true
  into account_admitted
  from private.shared_identity_sessions shared_session
  join private.employee_accounts account
    on account.employee_id = shared_session.employee_id
   and account.auth_user_id = shared_session.auth_user_id
  join public.employees employee on employee.id = account.employee_id
  join auth.sessions auth_session
    on auth_session.id = jwt_session_id
   and auth_session.user_id = account.auth_user_id
   and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  where shared_session.employee_id = actor_id
    and shared_session.auth_user_id = (select auth.uid())
    and shared_session.auth_session_id = jwt_session_id
    and shared_session.scope = 'platform'
    and shared_session.token_hash = shared_token_hash
    and shared_session.revoked_at is null
    and shared_session.expires_at > clock_timestamp()
    and account.disabled_at is null
    and not account.must_change_password
    and employee.status = 'active'
  for update of shared_session, account, employee, auth_session;

  if account_admitted is not true then
    raise insufficient_privilege using message = 'A valid shared SygShift platform session is required.';
  end if;

  insert into private.employee_sign_in_completions (
    auth_session_id,
    employee_id,
    auth_user_id,
    completion_source
  ) values (
    jwt_session_id,
    actor_id,
    (select auth.uid()),
    'platform'
  )
  on conflict (auth_session_id) do nothing
  returning completed_at into recorded_at;

  inserted_completion := recorded_at is not null;

  if recorded_at is null then
    select completion.completed_at
    into recorded_at
    from private.employee_sign_in_completions completion
    where completion.auth_session_id = jwt_session_id
      and completion.employee_id = actor_id
      and completion.auth_user_id = (select auth.uid());
  end if;

  if recorded_at is null then
    raise insufficient_privilege using message = 'The shared authentication session could not be recorded safely.';
  end if;

  if inserted_completion then
    update private.employee_accounts account
    set
      last_sign_in_at = greatest(coalesce(account.last_sign_in_at, recorded_at), recorded_at),
      updated_at = greatest(coalesce(account.updated_at, recorded_at), recorded_at)
    where account.employee_id = actor_id
      and account.auth_user_id = (select auth.uid())
      and account.disabled_at is null;

    get diagnostics updated_account_count = row_count;
    if updated_account_count <> 1 then
      raise insufficient_privilege using message = 'The completed shared sign-in could not be attached to one active account.';
    end if;
  end if;

  return recorded_at;
end
$$;

revoke all on function public.has_scoped_shared_identity_session(text) from public, anon;
revoke all on function public.has_shared_identity_session() from public, anon;
revoke all on function public.platform_record_completed_sign_in() from public, anon;
grant execute on function public.has_scoped_shared_identity_session(text) to authenticated;
grant execute on function public.has_shared_identity_session() to authenticated;
grant execute on function public.platform_record_completed_sign_in() to authenticated;

revoke all on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text, text) to service_role;
grant execute on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
commit;

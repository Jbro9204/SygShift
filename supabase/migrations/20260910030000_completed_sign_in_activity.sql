begin;
set local lock_timeout = '5s';

-- Supabase advances auth.users.last_sign_in_at as soon as the primary
-- credential succeeds. SygShift must not call that a completed login while a
-- required password change or MFA checkpoint is still outstanding. Keep an
-- application-owned, immutable completion row for each admitted auth session
-- so concurrent browser sessions cannot overwrite one another's idempotency
-- marker or move Last Activity backwards.
create table private.employee_sign_in_completions (
  auth_session_id uuid primary key,
  employee_id uuid not null references public.employees(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  completion_source text not null check (completion_source in ('native', 'sygsphere')),
  completed_at timestamptz not null default clock_timestamp()
);

create index employee_sign_in_completions_employee_time_idx
on private.employee_sign_in_completions(employee_id, completed_at desc);

alter table private.employee_sign_in_completions enable row level security;
alter table private.employee_sign_in_completions force row level security;
revoke all on private.employee_sign_in_completions from public, anon, authenticated;

create or replace function public.record_completed_sign_in()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  jwt_payload jsonb := (select auth.jwt());
  jwt_session_id uuid;
  recorded_at timestamptz;
  inserted_completion boolean := false;
  has_password_proof boolean := false;
  account_admitted boolean := false;
  updated_account_count integer := 0;
begin
  if actor_id is null or (select auth.uid()) is null then
    raise insufficient_privilege using message = 'An active SygShift account is required.';
  end if;

  begin
    jwt_session_id := nullif(jwt_payload ->> 'session_id', '')::uuid;
  exception when others then
    raise insufficient_privilege using message = 'A valid SygShift authentication session is required.';
  end;

  if jwt_session_id is null then
    raise insufficient_privilege using message = 'A valid SygShift authentication session is required.';
  end if;

  if jsonb_typeof(jwt_payload -> 'amr') = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(jwt_payload -> 'amr') authentication_method
      where authentication_method ->> 'method' = 'password'
    ) into has_password_proof;
  end if;

  -- Recovery, invite, magic-link, and service-created sessions are not a
  -- completed employee login. A current password proof is mandatory.
  if not has_password_proof then
    raise insufficient_privilege using message = 'A completed password sign-in is required.';
  end if;

  select true
  into account_admitted
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  join auth.sessions auth_session
    on auth_session.id = jwt_session_id
   and auth_session.user_id = account.auth_user_id
   and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
  where account.employee_id = actor_id
    and account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
    and not account.must_change_password
  for update of account, employee, auth_session;

  if account_admitted is not true then
    raise insufficient_privilege using message = 'The account and its required password checkpoint must be active.';
  end if;

  if private.employee_requires_mfa(actor_id) and not public.has_mfa() then
    raise insufficient_privilege using message = 'Required MFA must be completed first.';
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
    'native'
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
    raise insufficient_privilege using message = 'The authentication session could not be recorded safely.';
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
      raise insufficient_privilege using message = 'The completed sign-in could not be attached to one active account.';
    end if;
  end if;

  return recorded_at;
end
$$;

-- A shared SygSphere launch carries an upstream password/MFA assertion and a
-- separate bound token. It may count only for that validated shared session;
-- the header is attached exclusively to SygSphere RPC calls by the client.
create or replace function public.sygsphere_record_completed_sign_in()
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
    raise insufficient_privilege using message = 'A valid shared SygSphere session is required.';
  end;

  if jwt_session_id is null
    or shared_token is null
    or shared_token !~ '^[A-Za-z0-9_-]{40,180}$'
    or not public.has_shared_identity_session() then
    raise insufficient_privilege using message = 'A valid shared SygSphere session is required.';
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
    and shared_session.token_hash = shared_token_hash
    and shared_session.revoked_at is null
    and shared_session.expires_at > clock_timestamp()
    and account.disabled_at is null
    and not account.must_change_password
    and employee.status = 'active'
  for update of shared_session, account, employee, auth_session;

  if account_admitted is not true then
    raise insufficient_privilege using message = 'A valid shared SygSphere session is required.';
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
    'sygsphere'
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

-- Preserve the latest remote admin-directory implementation and change only
-- the provider-derived Last Activity expression. Account activation has a
-- separate existing lifecycle and is deliberately left unchanged.
do $migration$
declare
  function_definition text;
  provider_activity_expression text := 'coalesce(auth_user.last_sign_in_at, account.last_sign_in_at)';
begin
  select pg_get_functiondef('private.admin_user_record(uuid)'::regprocedure)
  into function_definition;

  if function_definition is null then
    raise exception 'The admin account activity source could not be corrected safely.';
  end if;

  if position(provider_activity_expression in function_definition) > 0 then
    function_definition := replace(function_definition, provider_activity_expression, 'account.last_sign_in_at');
  elsif position('''lastSignInAt'', account.last_sign_in_at' in function_definition) = 0 then
    raise exception 'The admin account activity source could not be corrected safely.';
  end if;

  execute function_definition;
end
$migration$;

revoke all on function public.record_completed_sign_in() from public, anon;
revoke all on function public.sygsphere_record_completed_sign_in() from public, anon;
grant execute on function public.record_completed_sign_in() to authenticated;
grant execute on function public.sygsphere_record_completed_sign_in() to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

set local lock_timeout = '5s';

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
  jwt_session_id_text text := nullif((select auth.jwt() ->> 'session_id'), '');
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
     and (auth_session.not_after is null or auth_session.not_after > statement_timestamp())
    where shared_session.employee_id = actor_id
      and shared_session.auth_user_id = (select auth.uid())
      and shared_session.auth_session_id = jwt_session_id
      and shared_session.scope = target_scope
      and shared_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
      and shared_session.revoked_at is null
      and shared_session.expires_at > statement_timestamp()
      and account.disabled_at is null
      and not account.must_change_password
      and employee.status = 'active'
      and private.shared_identity_session_assurance_allowed(shared_session.employee_id, shared_session.assurance_level)
  );
end
$$;

create or replace function private.has_high_assurance_shared_identity_session(target_scope text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  session_token text := private.request_header('x-sygshift-shared-identity');
  jwt_session_id uuid;
begin
  begin
    jwt_session_id := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  exception when others then
    return false;
  end;

  return public.has_scoped_shared_identity_session(target_scope)
    and exists (
      select 1
      from private.shared_identity_sessions shared_session
      where shared_session.employee_id = actor_id
        and shared_session.auth_user_id = (select auth.uid())
        and shared_session.auth_session_id = jwt_session_id
        and shared_session.scope = target_scope
        and shared_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
        and shared_session.assurance_level in ('aal2', 'security_key', 'trusted_device', 'external_mfa')
        and shared_session.revoked_at is null
        and shared_session.expires_at > statement_timestamp()
    );
end
$$;

revoke all on function public.has_scoped_shared_identity_session(text) from public, anon;
grant execute on function public.has_scoped_shared_identity_session(text) to authenticated;
revoke all on function private.has_high_assurance_shared_identity_session(text) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

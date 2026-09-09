begin;
set local lock_timeout = '5s';

-- Shared SygSphere assurance is intentionally not a platform-wide MFA method.
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

-- Keep the inherited assertion confined to the existing SygSphere gate without
-- restating the large messaging function and accidentally discarding later fixes.
do $migration$
declare
  function_definition text;
  original_condition text := '((session_context->>''mfa_required'')::boolean and not (session_context->>''has_mfa'')::boolean)';
  scoped_condition text := '((session_context->>''mfa_required'')::boolean and not ((session_context->>''has_mfa'')::boolean or public.has_shared_identity_session()))';
begin
  select pg_get_functiondef('private.sygsphere_request(text,jsonb)'::regprocedure)
  into function_definition;

  if function_definition is null then
    raise exception 'The SygSphere assurance gate could not be hardened safely.';
  end if;
  if position(scoped_condition in function_definition) > 0 then
    null;
  elsif position(original_condition in function_definition) > 0 then
    execute replace(function_definition, original_condition, scoped_condition);
  else
    raise exception 'The SygSphere assurance gate could not be hardened safely.';
  end if;
end
$migration$;

create or replace function public.sygsphere_can_read_avatar(target_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := private.current_employee_id();
  session_context jsonb;
begin
  if actor is null or not exists(select 1 from private.sygsphere_gate where enabled) then
    return false;
  end if;
  select to_jsonb(context) into session_context from public.get_session_context() context;
  if coalesce((session_context->>'must_change_password')::boolean, true)
    or (
      (session_context->>'mfa_required')::boolean
      and not ((session_context->>'has_mfa')::boolean or public.has_shared_identity_session())
    ) then
    return false;
  end if;
  return exists(
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.photo_path = target_path
      and employee.status = 'active'
      and account.disabled_at is null
  );
end
$$;

create or replace function public.service_revoke_shared_identity_session(
  target_token_hash text,
  target_request_id text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  shared_session private.shared_identity_sessions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The shared session token was invalid.';
  end if;

  update private.shared_identity_sessions current_session
  set revoked_at = clock_timestamp()
  where current_session.token_hash = target_token_hash
    and current_session.revoked_at is null
  returning * into shared_session;

  if shared_session.id is null then
    return false;
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    shared_session.auth_user_id,
    shared_session.employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'shared_identity_sessions',
    'REVOKE',
    shared_session.id::text,
    jsonb_build_object('expiresAt', shared_session.expires_at),
    jsonb_build_object('revokedAt', shared_session.revoked_at)
  );

  return true;
end
$$;

revoke all on function public.service_revoke_shared_identity_session(text, text) from public, anon, authenticated;
grant execute on function public.service_revoke_shared_identity_session(text, text) to service_role;

notify pgrst, 'reload schema';
commit;

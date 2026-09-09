begin;
set local lock_timeout = '5s';

create or replace function private.bind_sygilant_session_to_sygsphere()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bound_session_id uuid;
begin
  if new.status = 'active'
    and new.session_token_hash is not null
    and new.auth_session_id is not null
    and new.session_expires_at > clock_timestamp()
    and (
      old.status is distinct from new.status
      or old.session_token_hash is distinct from new.session_token_hash
      or old.session_expires_at is distinct from new.session_expires_at
    ) then
    update private.shared_identity_sessions shared_session
    set revoked_at = clock_timestamp()
    where shared_session.employee_id = new.employee_id
      and shared_session.auth_session_id = new.auth_session_id
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
      new.employee_id,
      new.auth_user_id,
      new.auth_session_id,
      new.provider_request_id,
      new.session_token_hash,
      new.assurance_level,
      'sygsphere',
      new.session_expires_at,
      clock_timestamp()
    )
    returning id into bound_session_id;

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
      new.auth_user_id,
      new.employee_id,
      nullif(btrim(new.activation_request_id), ''),
      'private',
      'shared_identity_sessions',
      'VERIFY',
      bound_session_id::text,
      jsonb_build_object(
        'assuranceLevel', new.assurance_level,
        'authSessionId', new.auth_session_id,
        'expiresAt', new.session_expires_at,
        'launchRequestId', new.provider_request_id,
        'scope', 'sygsphere',
        'source', 'sygilant'
      )
    );
  elsif new.status in ('revoked', 'expired')
    and new.session_token_hash is not null
    and old.status is distinct from new.status then
    update private.shared_identity_sessions shared_session
    set revoked_at = coalesce(new.revoked_at, clock_timestamp())
    where shared_session.token_hash = new.session_token_hash
      and shared_session.scope = 'sygsphere'
      and shared_session.revoked_at is null;
  end if;

  return new;
end
$$;

revoke all on function private.bind_sygilant_session_to_sygsphere() from public, anon, authenticated;

drop trigger if exists bind_sygilant_session_to_sygsphere
on public.sygilant_shared_identity_sessions;

create trigger bind_sygilant_session_to_sygsphere
after update of status, session_token_hash, session_expires_at
on public.sygilant_shared_identity_sessions
for each row
execute function private.bind_sygilant_session_to_sygsphere();

update private.shared_identity_sessions shared_session
set revoked_at = clock_timestamp()
where shared_session.revoked_at is null
  and exists (
    select 1
    from public.sygilant_shared_identity_sessions sygilant_session
    where sygilant_session.status = 'active'
      and sygilant_session.session_expires_at > clock_timestamp()
      and sygilant_session.employee_id = shared_session.employee_id
      and sygilant_session.auth_session_id = shared_session.auth_session_id
      and sygilant_session.session_token_hash <> shared_session.token_hash
  );

insert into private.shared_identity_sessions (
  employee_id,
  auth_user_id,
  auth_session_id,
  launch_request_id,
  token_hash,
  assurance_level,
  scope,
  created_at,
  expires_at,
  last_seen_at
)
select
  sygilant_session.employee_id,
  sygilant_session.auth_user_id,
  sygilant_session.auth_session_id,
  sygilant_session.provider_request_id,
  sygilant_session.session_token_hash,
  sygilant_session.assurance_level,
  'sygsphere',
  coalesce(sygilant_session.activated_at, sygilant_session.claimed_at),
  sygilant_session.session_expires_at,
  clock_timestamp()
from public.sygilant_shared_identity_sessions sygilant_session
join auth.sessions auth_session
  on auth_session.id = sygilant_session.auth_session_id
 and auth_session.user_id = sygilant_session.auth_user_id
 and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
where sygilant_session.status = 'active'
  and sygilant_session.session_token_hash is not null
  and sygilant_session.session_expires_at > clock_timestamp()
on conflict (launch_request_id) do update
set token_hash = excluded.token_hash,
    assurance_level = excluded.assurance_level,
    scope = 'sygsphere',
    expires_at = excluded.expires_at,
    last_seen_at = clock_timestamp(),
    revoked_at = null;

notify pgrst, 'reload schema';
commit;

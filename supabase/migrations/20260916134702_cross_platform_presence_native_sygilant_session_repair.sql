-- Allow both native Sygilant sessions and SygShift-to-Sygilant handoff sessions
-- to publish the same approximate availability signal. Application is a display
-- source label, never an authorization, timekeeping, payroll, or attendance fact.

create or replace function public.record_platform_presence(
  target_client_instance_id uuid,
  target_application text,
  target_state text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_auth_user_id uuid := auth.uid();
  actor_auth_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  heartbeat_at timestamptz := clock_timestamp();
begin
  if actor_id is null or actor_auth_user_id is null or actor_auth_session_id is null then
    raise insufficient_privilege using message = 'An active employee session is required.';
  end if;

  if target_client_instance_id is null then
    raise check_violation using message = 'A client instance is required.';
  end if;

  if target_application not in ('sygshift', 'sygilant') then
    raise check_violation using message = 'The application is invalid.';
  end if;

  if target_state not in ('active', 'away') then
    raise check_violation using message = 'The presence state is invalid.';
  end if;

  if not exists (
    select 1
    from auth.sessions session
    where session.id = actor_auth_session_id
      and session.user_id = actor_auth_user_id
      and (session.not_after is null or session.not_after > heartbeat_at)
  ) then
    raise insufficient_privilege using message = 'The authenticated session is no longer active.';
  end if;

  insert into private.platform_presence_sessions (
    auth_session_id,
    client_instance_id,
    application,
    employee_id,
    auth_user_id,
    state,
    last_heartbeat_at,
    last_active_at,
    expires_at
  ) values (
    actor_auth_session_id,
    target_client_instance_id,
    target_application,
    actor_id,
    actor_auth_user_id,
    target_state,
    heartbeat_at,
    heartbeat_at,
    heartbeat_at + interval '2 minutes'
  )
  on conflict (auth_session_id, client_instance_id, application) do update
  set employee_id = excluded.employee_id,
      auth_user_id = excluded.auth_user_id,
      state = excluded.state,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_active_at = case
        when excluded.state = 'active' then excluded.last_heartbeat_at
        else private.platform_presence_sessions.last_active_at
      end,
      expires_at = excluded.expires_at;

  delete from private.platform_presence_sessions session
  where session.employee_id = actor_id
    and session.expires_at < heartbeat_at - interval '30 days';

  return private.platform_presence_for(actor_id);
end
$$;

revoke all on function public.record_platform_presence(uuid, text, text) from public, anon;
grant execute on function public.record_platform_presence(uuid, text, text) to authenticated;

comment on function public.record_platform_presence(uuid, text, text) is
  'Records an approximate per-tab SygShift or Sygilant availability heartbeat for a current authenticated employee session; not attendance or timekeeping evidence.';

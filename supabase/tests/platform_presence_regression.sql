begin;

do $$
declare
  actor_employee_id uuid;
  actor_auth_user_id uuid;
  actor_auth_session_id uuid;
  active_client_id uuid := gen_random_uuid();
  away_client_id uuid := gen_random_uuid();
  sygilant_client_id uuid := gen_random_uuid();
  no_account_employee_id uuid := gen_random_uuid();
  payload jsonb;
begin
  select account.employee_id, account.auth_user_id, session.id
  into actor_employee_id, actor_auth_user_id, actor_auth_session_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  join auth.sessions session on session.user_id = account.auth_user_id
  where employee.status = 'active'
    and account.disabled_at is null
    and (session.not_after is null or session.not_after > clock_timestamp())
  order by session.updated_at desc nulls last
  limit 1;

  if actor_auth_session_id is null then
    raise exception 'An active linked authentication session is required for the rollback-only presence test.';
  end if;

  if pg_get_functiondef('public.sygsphere_people(text,jsonb)'::regprocedure)
    like '%private.sygsphere_request(''presence''%' then
    raise exception 'SygSphere people reads must not generate a duplicate legacy presence write.';
  end if;
  if pg_get_functiondef('private.sygsphere_message_json(private.sygsphere_messages,uuid)'::regprocedure)
    not like '%case when target_message.author_id=actor then%' then
    raise exception 'Reader identities and exact read times must be limited to the message author.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', actor_auth_user_id,
      'role', 'authenticated',
      'session_id', actor_auth_session_id
    )::text,
    true
  );

  perform public.record_platform_presence(active_client_id, 'sygshift', 'active');
  perform public.record_platform_presence(away_client_id, 'sygshift', 'away');
  perform public.record_platform_presence(sygilant_client_id, 'sygilant', 'away');
  payload := private.platform_presence_for(actor_employee_id);

  if payload->>'status' <> 'active' then
    raise exception 'Any active client must win cross-device presence aggregation.';
  end if;
  if payload->'applications' <> '["sygilant", "sygshift"]'::jsonb then
    raise exception 'Native and handoff application sources were not aggregated safely.';
  end if;

  update private.platform_presence_sessions
  set state = 'away'
  where employee_id = actor_employee_id;
  payload := private.platform_presence_for(actor_employee_id);
  if payload->>'status' <> 'away' then
    raise exception 'Current away sessions did not aggregate to Away.';
  end if;

  update private.platform_presence_sessions
  set last_heartbeat_at = clock_timestamp() - interval '3 minutes',
      expires_at = clock_timestamp() - interval '1 second'
  where employee_id = actor_employee_id;
  payload := private.platform_presence_for(actor_employee_id);
  if payload->>'status' <> 'offline' then
    raise exception 'Expired sessions must aggregate to Offline.';
  end if;
  if payload->>'lastActiveAt' is null then
    raise exception 'Last active time must remain available after heartbeat expiry.';
  end if;

  delete from private.platform_presence_sessions
  where employee_id = actor_employee_id
    and client_instance_id in (active_client_id, away_client_id, sygilant_client_id);
  payload := private.platform_presence_for(actor_employee_id);
  if payload->>'status' <> 'offline' or payload->>'lastActiveAt' is null then
    raise exception 'Durable activity history must survive per-tab heartbeat cleanup.';
  end if;

  update private.employee_accounts
  set disabled_at = clock_timestamp()
  where employee_id = actor_employee_id;
  payload := private.platform_presence_for(actor_employee_id);
  if payload->>'status' <> 'offline' or coalesce((payload->>'accountEnabled')::boolean, true) then
    raise exception 'Disabled accounts must be unavailable regardless of session history.';
  end if;

  insert into public.employees (id, username, first_name, last_name, status)
  values (no_account_employee_id, 'presence-regression-' || no_account_employee_id::text, 'Presence', 'Regression', 'active');
  payload := private.platform_presence_for(no_account_employee_id);
  if payload->>'status' <> 'offline' or coalesce((payload->>'accountEnabled')::boolean, true) then
    raise exception 'An employee without a linked login account must remain Offline.';
  end if;
end
$$;

rollback;

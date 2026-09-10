begin;

do $$
declare
  actor_auth_user_id uuid;
  selected_task_id uuid;
  payload jsonb;
begin
  select account.auth_user_id, task.id
  into actor_auth_user_id, selected_task_id
  from private.sygtasks_tasks task
  join private.sygtasks_boards board on board.id = task.board_id
  join private.employee_accounts account on account.employee_id = board.owner_employee_id
  join public.employees employee on employee.id = account.employee_id
  where account.disabled_at is null
    and employee.status = 'active'
    and exists (
      select 1
      from private.sygtasks_activity activity
      where activity.task_id = task.id
    )
  order by task.created_at, task.id
  limit 1;

  if actor_auth_user_id is null or selected_task_id is null then
    raise exception 'Detailed activity regression requires one active task owner with activity.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  payload := public.get_sygtasks_task_activity(selected_task_id, null, 20);

  if payload->>'taskId' <> selected_task_id::text then
    raise exception 'Detailed activity returned the wrong task identifier.';
  end if;
  if jsonb_typeof(payload->'events') <> 'array' or jsonb_array_length(payload->'events') < 1 then
    raise exception 'Detailed activity did not return its immutable event history.';
  end if;
  if jsonb_typeof(payload->'page') <> 'object'
     or (payload->'page'->>'size')::integer <> 20
     or jsonb_array_length(payload->'events') > 20
  then
    raise exception 'Detailed activity did not enforce its bounded page contract.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(payload->'events') event
    where event->>'actorName' is null
      or event->>'actorSource' <> 'employee'
      or event->>'createdAt' is null
      or jsonb_typeof(event->'details') <> 'object'
  ) then
    raise exception 'Detailed activity omitted an actor, source, timestamp, or detail object.';
  end if;

  if has_function_privilege('anon', 'public.get_sygtasks_task_activity(uuid,bigint,integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_sygtasks_task_activity(uuid,bigint,integer)', 'execute')
  then
    raise exception 'Detailed activity execution grants are unsafe.';
  end if;
end
$$;

rollback;

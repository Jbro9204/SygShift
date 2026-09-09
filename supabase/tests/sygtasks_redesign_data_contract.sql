-- Run only after 20260910100000 inside this file's outer transaction.
-- Every fixture, notification, audit record, and idempotency record is rolled back.
begin;

do $$
<<sygtasks_contract>>
declare
  actor_auth_id uuid;
  actor_employee_id uuid;
  second_manager_auth_id uuid;
  second_manager_employee_id uuid;
  other_auth_id uuid;
  other_employee_id uuid;
  personal_board_id uuid := gen_random_uuid();
  team_board_id uuid := gen_random_uuid();
  first_task_id uuid;
  label_id uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  failed_request_id uuid := gen_random_uuid();
  invalid_assignee_id uuid := gen_random_uuid();
  token text := 'contract-' || gen_random_uuid()::text;
  payload jsonb;
  first_result jsonb;
  replay_result jsonb;
  created_task_id uuid;
  task_count_before bigint;
  activity_count_before bigint;
  audit_count_before bigint;
  notification_count_before bigint;
  denied_personal boolean := false;
  denied_manager_personal boolean := false;
  denied_inactive boolean := false;
  denied_failed_assignment boolean := false;
  denied_reused_request boolean := false;
  actor_status public.employees.status%type;
begin
  if not has_function_privilege(
    'authenticated',
    'public.get_sygtasks_worklist(text,uuid,text,text,text,integer,integer,boolean)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.create_sygtasks_task(jsonb,uuid)',
    'EXECUTE'
  ) then
    raise exception 'Authenticated employees cannot execute the SygTasks redesign RPCs.';
  end if;

  if has_function_privilege(
    'anon',
    'public.get_sygtasks_worklist(text,uuid,text,text,text,integer,integer,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.create_sygtasks_task(jsonb,uuid)',
    'EXECUTE'
  ) then
    raise exception 'Anonymous access remains on a SygTasks redesign RPC.';
  end if;

  select account.auth_user_id, employee.id, employee.status
  into actor_auth_id, actor_employee_id, actor_status
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  select account.auth_user_id, employee.id
  into second_manager_auth_id, second_manager_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.id <> actor_employee_id
    and 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  select account.auth_user_id, employee.id
  into other_auth_id, other_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.id <> actor_employee_id
    and 'tasks.view' = any(private.employee_effective_permissions(employee.id))
    and not ('tasks.manage' = any(private.employee_effective_permissions(employee.id)))
  order by employee.id
  limit 1;

  if actor_auth_id is null or second_manager_auth_id is null or other_auth_id is null then
    raise exception 'SygTasks regression requires two active managers and one active non-manager account.';
  end if;

  insert into private.sygtasks_boards (
    id, name, description, scope, owner_employee_id, created_by, updated_by
  ) values
    (personal_board_id, 'Private ' || left(token, 50), 'Owner-only regression board.', 'personal', actor_employee_id, actor_employee_id, actor_employee_id),
    (team_board_id, 'Team ' || left(token, 53), 'Authorized regression board.', 'team', actor_employee_id, actor_employee_id, actor_employee_id);

  insert into private.sygtasks_board_memberships (
    board_id, employee_id, member_role, added_by
  ) values
    (personal_board_id, actor_employee_id, 'owner', actor_employee_id),
    (team_board_id, actor_employee_id, 'owner', actor_employee_id),
    (team_board_id, other_employee_id, 'viewer', actor_employee_id);

  for index_value in 1..6 loop
    insert into private.sygtasks_tasks (
      board_id, title, description, status, priority, due_at,
      created_by, updated_by
    ) values (
      team_board_id,
      token || ' task ' || index_value,
      'Exact server-filter regression fixture.',
      case when index_value % 2 = 0 then 'in_progress' else 'ready' end,
      'high',
      statement_timestamp() + make_interval(hours => index_value),
      actor_employee_id,
      actor_employee_id
    )
    returning id into first_task_id;

    if index_value = 1 then
      exit;
    end if;
  end loop;

  -- Add the remaining five rows after retaining a stable first task for label search.
  insert into private.sygtasks_tasks (
    board_id, title, description, status, priority, due_at,
    created_by, updated_by
  )
  select
    team_board_id,
    token || ' task ' || index_value,
    'Exact server-filter regression fixture.',
    case when index_value % 2 = 0 then 'in_progress' else 'ready' end,
    'high',
    statement_timestamp() + make_interval(hours => index_value),
    actor_employee_id,
    actor_employee_id
  from generate_series(2, 6) as index_value;

  insert into private.sygtasks_labels (
    id, board_id, name, color, created_by, updated_by
  ) values (
    label_id, team_board_id, left(token || '-label', 50), '#E3AD3B', actor_employee_id, actor_employee_id
  );
  insert into private.sygtasks_task_labels (task_id, label_id, added_by)
  values (first_task_id, label_id, actor_employee_id);

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );

  payload := public.get_sygtasks_worklist(
    'board', team_board_id, token, null, 'high', 1, 5, false
  );

  if (payload #>> '{page,total}')::integer <> 6
     or (payload #>> '{page,totalPages}')::integer <> 2
     or (payload #>> '{page,hasMore}')::boolean is not true
     or jsonb_array_length(payload->'tasks') <> 5
     or (payload #>> '{counts,status,ready}')::integer <> 3
     or (payload #>> '{counts,status,in_progress}')::integer <> 3
     or (payload #>> '{counts,priority,high}')::integer <> 6
  then
    raise exception 'SygTasks server search, counts, or first-page metadata is not exact: %', payload;
  end if;

  payload := public.get_sygtasks_worklist(
    'board', team_board_id, token, null, 'high', 2, 5, false
  );
  if jsonb_array_length(payload->'tasks') <> 1
     or (payload #>> '{page,hasPrevious}')::boolean is not true
     or (payload #>> '{page,hasMore}')::boolean is not false
  then
    raise exception 'SygTasks second-page metadata is not exact: %', payload;
  end if;

  payload := public.get_sygtasks_worklist(
    'board', team_board_id, left(token || '-label', 50), null, null, 1, 5, false
  );
  if (payload #>> '{page,total}')::integer <> 1
     or (payload->'tasks'->0->>'id')::uuid <> first_task_id
  then
    raise exception 'SygTasks label search did not return the one matching task: %', payload;
  end if;

  payload := public.get_sygtasks_worklist(
    'my_work', null, '', null, null, 1, 5, false
  );
  if payload #>> '{summary,timezone}' <> 'America/Denver'
     or nullif(payload #>> '{summary,asOf}', '') is null
     or not exists (
       select 1
       from jsonb_array_elements(payload->'boards') board
       where (board->>'id')::uuid = personal_board_id
     )
     or not exists (
       select 1
       from jsonb_array_elements(payload->'boards') board
       where (board->>'id')::uuid = team_board_id
     )
  then
    raise exception 'SygTasks summary or full authorized board payload is incomplete: %', payload;
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', other_auth_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.get_sygtasks_worklist('board', personal_board_id, '', null, null, 1, 5, false);
  exception
    when insufficient_privilege then
      denied_personal := true;
  end;
  if not denied_personal then
    raise exception 'A non-manager opened another employee''s personal board.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', second_manager_auth_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );
  payload := public.get_sygtasks_worklist('my_work', null, '', null, null, 1, 5, false);
  begin
    perform public.get_sygtasks_worklist('board', personal_board_id, '', null, null, 1, 5, false);
  exception
    when insufficient_privilege then
      denied_manager_personal := true;
  end;
  if not denied_manager_personal or exists (
    select 1
    from jsonb_array_elements(payload->'boards') board
    where (board->>'id')::uuid = personal_board_id
  ) then
    raise exception 'A different SygTasks manager discovered or opened another employee''s personal board.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_id::text, 'aal', 'aal2', 'role', 'authenticated')::text,
    true
  );

  select count(*) into task_count_before
  from private.sygtasks_tasks task
  where task.board_id = team_board_id;

  begin
    perform public.create_sygtasks_task(
      jsonb_build_object(
        'boardId', team_board_id,
        'title', token || ' failed atomic assignment',
        'description', '',
        'status', 'ready',
        'priority', 'routine',
        'dueAt', null,
        'assigneeId', invalid_assignee_id
      ),
      failed_request_id
    );
  exception
    when check_violation then
      denied_failed_assignment := true;
  end;
  if not denied_failed_assignment
     or (select count(*) from private.sygtasks_tasks task where task.board_id = team_board_id) <> task_count_before
     or exists (
       select 1 from private.sygtasks_action_requests request
       where request.actor_employee_id = sygtasks_contract.actor_employee_id
         and request.client_request_id in (
           failed_request_id,
           md5(failed_request_id::text || ':create')::uuid,
           md5(failed_request_id::text || ':assign')::uuid
         )
     )
     or exists (
       select 1 from private.sygtasks_activity activity
       where activity.client_request_id in (
         md5(failed_request_id::text || ':create')::uuid,
         md5(failed_request_id::text || ':assign')::uuid
       )
     )
     or exists (
       select 1 from private.audit_events event
       where event.request_id in (
         md5(failed_request_id::text || ':create')::uuid::text,
         md5(failed_request_id::text || ':assign')::uuid::text
       )
     )
     or exists (
       select 1 from public.employee_notifications notification
       where notification.source_key in (
         concat('sygtasks:', actor_employee_id, ':', md5(failed_request_id::text || ':create')::uuid, ':', invalid_assignee_id),
         concat('sygtasks:', actor_employee_id, ':', md5(failed_request_id::text || ':assign')::uuid, ':', invalid_assignee_id)
       )
     )
  then
    raise exception 'A failed assignment left a partial SygTasks task or request record.';
  end if;

  payload := jsonb_build_object(
    'boardId', team_board_id,
    'title', token || ' atomic task',
    'description', 'Created and assigned as one command.',
    'status', 'ready',
    'priority', 'urgent',
    'dueAt', null,
    'assigneeId', other_employee_id
  );
  first_result := public.create_sygtasks_task(payload, sygtasks_contract.request_id);
  created_task_id := (first_result->>'taskId')::uuid;
  activity_count_before := (
    select count(*) from private.sygtasks_activity activity where activity.task_id = created_task_id
  );
  audit_count_before := (
    select count(*)
    from private.audit_events event
    where event.employee_id = actor_employee_id
      and event.request_id in (
        md5(sygtasks_contract.request_id::text || ':create')::uuid::text,
        md5(sygtasks_contract.request_id::text || ':assign')::uuid::text
      )
  );
  notification_count_before := (
    select count(*)
    from public.employee_notifications notification
    where notification.source_type = 'sygtasks'
      and notification.source_id = created_task_id
      and notification.recipient_employee_id = other_employee_id
      and notification.sender_employee_id = actor_employee_id
  );
  replay_result := public.create_sygtasks_task(payload, sygtasks_contract.request_id);

  if replay_result <> first_result
     or (replay_result->>'taskId')::uuid <> created_task_id
     or (select count(*) from private.sygtasks_tasks task where task.id = created_task_id) <> 1
     or (select count(*) from private.sygtasks_task_assignees assignee where assignee.task_id = created_task_id and assignee.employee_id = other_employee_id and assignee.removed_at is null) <> 1
     or (select count(*) from private.sygtasks_activity activity where activity.task_id = created_task_id) <> activity_count_before
     or activity_count_before <> 2
     or audit_count_before <> 2
     or (select count(*) from private.audit_events event where event.employee_id = actor_employee_id and event.request_id in (md5(sygtasks_contract.request_id::text || ':create')::uuid::text, md5(sygtasks_contract.request_id::text || ':assign')::uuid::text)) <> audit_count_before
     or notification_count_before <> 1
     or (select count(*) from public.employee_notifications notification where notification.source_type = 'sygtasks' and notification.source_id = created_task_id and notification.recipient_employee_id = other_employee_id and notification.sender_employee_id = actor_employee_id) <> notification_count_before
     or (select count(*) from private.sygtasks_action_requests request where request.actor_employee_id = sygtasks_contract.actor_employee_id and request.client_request_id = sygtasks_contract.request_id and request.action = 'create_task_with_assignee') <> 1
  then
    raise exception 'Identical SygTasks create-and-assign replay was not idempotent.';
  end if;

  begin
    perform public.create_sygtasks_task(payload || jsonb_build_object('title', token || ' changed payload'), sygtasks_contract.request_id);
  exception
    when check_violation then
      denied_reused_request := true;
  end;
  if not denied_reused_request then
    raise exception 'A SygTasks request identifier was reused for a different payload.';
  end if;

  update public.employees employee
  set status = 'inactive'
  where employee.id = actor_employee_id;
  begin
    perform public.get_sygtasks_worklist('my_work', null, '', null, null, 1, 5, false);
  exception
    when insufficient_privilege then
      denied_inactive := true;
  end;
  update public.employees employee
  set status = actor_status
  where employee.id = actor_employee_id;

  if not denied_inactive then
    raise exception 'An inactive employee opened SygTasks.';
  end if;
end
$$;

rollback;

-- Run after 20260910120000_sygtasks_parent_scope_repair.sql.
-- Every board, task, relationship, notification, audit, and idempotency fixture
-- is created inside this transaction and removed by the final rollback.
begin;

do $$
<<sygtasks_parent_scope_contract>>
declare
  v_actor_auth_id uuid;
  v_actor_employee_id uuid;
  v_target_employee_id uuid;
  v_unrelated_employee_id uuid;
  v_board_a_id uuid := gen_random_uuid();
  v_board_b_id uuid := gen_random_uuid();
  v_task_a_one_id uuid := gen_random_uuid();
  v_task_a_two_id uuid := gen_random_uuid();
  v_task_b_one_id uuid := gen_random_uuid();
  v_task_b_two_id uuid := gen_random_uuid();
  v_label_a_id uuid := gen_random_uuid();
  v_request_id uuid;
  v_token text := 'scope-' || gen_random_uuid()::text;
  v_result jsonb;
  v_cross_board_dependency_denied boolean := false;
begin
  select account.auth_user_id, employee.id
  into v_actor_auth_id, v_actor_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  select employee.id
  into v_target_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.id <> v_actor_employee_id
    and (
      'tasks.view' = any(private.employee_effective_permissions(employee.id))
      or 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
    )
  order by employee.id
  limit 1;

  select employee.id
  into v_unrelated_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.id not in (v_actor_employee_id, v_target_employee_id)
    and (
      'tasks.view' = any(private.employee_effective_permissions(employee.id))
      or 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
    )
  order by employee.id
  limit 1;

  if v_actor_auth_id is null
     or v_actor_employee_id is null
     or v_target_employee_id is null
     or v_unrelated_employee_id is null
  then
    raise exception 'The SygTasks parent-scope regression requires three active eligible accounts.';
  end if;

  insert into private.sygtasks_boards (
    id,
    name,
    description,
    scope,
    owner_employee_id,
    created_by,
    updated_by
  )
  values
    (
      v_board_a_id,
      left(v_token || '-board-a', 120),
      'Parent-scope regression board A.',
      'team',
      v_actor_employee_id,
      v_actor_employee_id,
      v_actor_employee_id
    ),
    (
      v_board_b_id,
      left(v_token || '-board-b', 120),
      'Parent-scope regression board B.',
      'team',
      v_actor_employee_id,
      v_actor_employee_id,
      v_actor_employee_id
    );

  insert into private.sygtasks_board_memberships (
    board_id,
    employee_id,
    member_role,
    added_by
  )
  values
    (v_board_a_id, v_actor_employee_id, 'owner', v_actor_employee_id),
    (v_board_b_id, v_actor_employee_id, 'owner', v_actor_employee_id),
    (v_board_a_id, v_target_employee_id, 'member', v_actor_employee_id);

  insert into private.sygtasks_tasks (
    id,
    board_id,
    title,
    description,
    status,
    priority,
    created_by,
    updated_by
  )
  values
    (v_task_a_one_id, v_board_a_id, left(v_token || '-task-a-1', 240), '', 'ready', 'routine', v_actor_employee_id, v_actor_employee_id),
    (v_task_a_two_id, v_board_a_id, left(v_token || '-task-a-2', 240), '', 'ready', 'routine', v_actor_employee_id, v_actor_employee_id),
    (v_task_b_one_id, v_board_b_id, left(v_token || '-task-b-1', 240), '', 'ready', 'routine', v_actor_employee_id, v_actor_employee_id),
    (v_task_b_two_id, v_board_b_id, left(v_token || '-task-b-2', 240), '', 'ready', 'routine', v_actor_employee_id, v_actor_employee_id);

  insert into private.sygtasks_task_assignees (
    task_id,
    employee_id,
    assigned_by
  )
  values
    (v_task_a_one_id, v_target_employee_id, v_actor_employee_id),
    (v_task_a_one_id, v_unrelated_employee_id, v_actor_employee_id);

  insert into private.sygtasks_task_watchers (
    task_id,
    employee_id,
    added_by
  )
  values (v_task_a_one_id, v_actor_employee_id, v_actor_employee_id);

  insert into private.sygtasks_labels (
    id,
    board_id,
    name,
    color,
    created_by,
    updated_by
  )
  values (
    v_label_a_id,
    v_board_a_id,
    left(v_token || '-label', 50),
    '#E3AD3B',
    v_actor_employee_id,
    v_actor_employee_id
  );

  insert into private.sygtasks_task_labels (
    task_id,
    label_id,
    added_by
  )
  values (v_task_a_one_id, v_label_a_id, v_actor_employee_id);

  insert into private.sygtasks_dependencies (
    task_id,
    depends_on_task_id,
    created_by
  )
  values (v_task_a_one_id, v_task_a_two_id, v_actor_employee_id);

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor_auth_id::text,
      'aal', 'aal2',
      'role', 'authenticated'
    )::text,
    true
  );

  v_result := public.mutate_sygtasks(
    'add_board_member',
    jsonb_build_object(
      'boardId', v_board_b_id,
      'employeeId', v_target_employee_id,
      'memberRole', 'editor'
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from private.sygtasks_board_memberships membership
       where membership.board_id = v_board_b_id
         and membership.employee_id = v_target_employee_id
         and membership.removed_at is null
     )
     or not exists (
       select 1
       from private.sygtasks_board_memberships membership
       where membership.board_id = v_board_a_id
         and membership.employee_id = v_target_employee_id
         and membership.removed_at is null
     )
  then
    raise exception 'Adding an employee to a second board did not preserve exact membership scope: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'remove_board_member',
    jsonb_build_object(
      'boardId', v_board_b_id,
      'employeeId', v_target_employee_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or exists (
       select 1
       from private.sygtasks_board_memberships membership
       where membership.board_id = v_board_b_id
         and membership.employee_id = v_target_employee_id
         and membership.removed_at is null
     )
     or not exists (
       select 1
       from private.sygtasks_board_memberships membership
       where membership.board_id = v_board_a_id
         and membership.employee_id = v_target_employee_id
         and membership.removed_at is null
     )
  then
    raise exception 'Removing a second-board membership changed the wrong board: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'assign_task',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'employeeId', v_target_employee_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from private.sygtasks_task_assignees assignee
       where assignee.task_id = v_task_b_one_id
         and assignee.employee_id = v_target_employee_id
         and assignee.removed_at is null
     )
  then
    raise exception 'Assigning an employee to a second task failed: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'unassign_task',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'employeeId', v_target_employee_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from private.sygtasks_task_assignees assignee
       where assignee.task_id = v_task_a_one_id
         and assignee.employee_id = v_target_employee_id
         and assignee.removed_at is null
     )
  then
    raise exception 'Unassigning a second task changed the first task: %', v_result;
  end if;

  perform public.mutate_sygtasks(
    'assign_task',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'employeeId', v_target_employee_id
    ),
    gen_random_uuid(),
    null
  );

  v_result := public.mutate_sygtasks(
    'watch_task',
    jsonb_build_object('taskId', v_task_b_one_id),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true then
    raise exception 'Watching a second task failed: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'unwatch_task',
    jsonb_build_object('taskId', v_task_b_one_id),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from private.sygtasks_task_watchers watcher
       where watcher.task_id = v_task_a_one_id
         and watcher.employee_id = v_actor_employee_id
         and watcher.removed_at is null
     )
  then
    raise exception 'Unwatching a second task changed the first task: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'apply_label',
    jsonb_build_object(
      'taskId', v_task_a_two_id,
      'labelId', v_label_a_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true then
    raise exception 'Applying one label to a second task failed: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'remove_label',
    jsonb_build_object(
      'taskId', v_task_a_two_id,
      'labelId', v_label_a_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from private.sygtasks_task_labels task_label
       where task_label.task_id = v_task_a_one_id
         and task_label.label_id = v_label_a_id
         and task_label.removed_at is null
     )
  then
    raise exception 'Removing a second task-label pair changed the first pair: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'add_dependency',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'dependsOnTaskId', v_task_b_two_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true then
    raise exception 'Adding an independent dependency failed: %', v_result;
  end if;

  v_result := public.mutate_sygtasks(
    'remove_dependency',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'dependsOnTaskId', v_task_b_two_id
    ),
    gen_random_uuid(),
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from private.sygtasks_dependencies dependency
       where dependency.task_id = v_task_a_one_id
         and dependency.depends_on_task_id = v_task_a_two_id
         and dependency.removed_at is null
     )
  then
    raise exception 'Removing a second dependency changed the first relationship: %', v_result;
  end if;

  begin
    perform public.mutate_sygtasks(
      'add_dependency',
      jsonb_build_object(
        'taskId', v_task_b_one_id,
        'dependsOnTaskId', v_task_a_one_id
      ),
      gen_random_uuid(),
      null
    );
  exception
    when check_violation then
      v_cross_board_dependency_denied := true;
  end;

  if not v_cross_board_dependency_denied then
    raise exception 'A cross-board dependency was accepted.';
  end if;

  v_request_id := gen_random_uuid();
  v_result := public.mutate_sygtasks(
    'update_task',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'status', 'in_progress'
    ),
    v_request_id,
    1
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from public.employee_notifications notification
       where notification.source_key = concat(
         'sygtasks:',
         v_actor_employee_id,
         ':',
         v_request_id,
         ':',
         v_target_employee_id
       )
     )
     or exists (
       select 1
       from public.employee_notifications notification
       where notification.source_key = concat(
         'sygtasks:',
         v_actor_employee_id,
         ':',
         v_request_id,
         ':',
         v_unrelated_employee_id
       )
     )
  then
    raise exception 'Task-update notifications crossed task boundaries: %', v_result;
  end if;

  v_request_id := gen_random_uuid();
  v_result := public.mutate_sygtasks(
    'add_comment',
    jsonb_build_object(
      'taskId', v_task_b_one_id,
      'body', 'Parent-scoped notification regression.'
    ),
    v_request_id,
    null
  );

  if (v_result->>'changed')::boolean is not true
     or not exists (
       select 1
       from public.employee_notifications notification
       where notification.source_key = concat(
         'sygtasks:',
         v_actor_employee_id,
         ':',
         v_request_id,
         ':',
         v_target_employee_id
       )
     )
     or exists (
       select 1
       from public.employee_notifications notification
       where notification.source_key = concat(
         'sygtasks:',
         v_actor_employee_id,
         ':',
         v_request_id,
         ':',
         v_unrelated_employee_id
       )
     )
  then
    raise exception 'Comment notifications crossed task boundaries: %', v_result;
  end if;
end
$$;

rollback;

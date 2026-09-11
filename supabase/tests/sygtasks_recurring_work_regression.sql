-- Run after 20260912160000_sygtasks_recurring_work.sql. Everything created by
-- this test is removed by the final rollback.
begin;

do $$
<<recurrence_contract>>
declare
  actor_auth_id uuid;
  actor_employee_id uuid;
  board_id uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid();
  result jsonb;
  replay jsonb;
  payload jsonb;
  series_id uuid;
  first_task_id uuid;
  first_task_version integer;
  first_due_local text;
  series_version integer;
  task_count_before_controls integer;
begin
  if not has_function_privilege('authenticated', 'public.create_sygtasks_recurring_series(jsonb,uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_sygtasks_recurring_series(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.manage_sygtasks_recurring_series(uuid,text,jsonb,uuid,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_sygtasks_recurring_series(jsonb,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_process_due_sygtasks_recurring_series(integer,integer)', 'EXECUTE')
  then
    raise exception 'Recurring SygTasks RPC grants are not least-privilege.';
  end if;

  select account.auth_user_id, employee.id
  into actor_auth_id, actor_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;
  if actor_auth_id is null then raise exception 'Recurring SygTasks regression requires one active task manager.'; end if;

  insert into private.sygtasks_boards (
    id, name, description, scope, owner_employee_id, created_by, updated_by
  ) values (
    board_id, 'Recurrence regression ' || left(gen_random_uuid()::text, 8),
    'Transactional recurrence contract.', 'personal', actor_employee_id,
    actor_employee_id, actor_employee_id
  );
  insert into private.sygtasks_board_memberships (board_id, employee_id, member_role, added_by)
  values (board_id, actor_employee_id, 'owner', actor_employee_id);

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id::text, 'aal', 'aal2', 'role', 'authenticated'
  )::text, true);
  first_due_local := to_char(((clock_timestamp() at time zone 'America/Denver')::date + 1) + time '09:00', 'YYYY-MM-DD"T"HH24:MI');
  payload := jsonb_build_object(
    'boardId', board_id,
    'title', 'Weekly recurrence regression',
    'description', 'Each occurrence must stay independent.',
    'status', 'ready',
    'priority', 'high',
    'assigneeId', actor_employee_id,
    'firstDueLocal', first_due_local,
    'timeZone', 'America/Denver',
    'frequency', 'weekly',
    'intervalCount', 1,
    'endsOn', null,
    'maxOccurrences', 10,
    'reminderKind', 'alarm',
    'reminderOffsetMinutes', 60,
    'reminderEmailEnabled', false
  );
  result := public.create_sygtasks_recurring_series(payload, request_id);
  replay := public.create_sygtasks_recurring_series(payload, request_id);
  series_id := (result->>'seriesId')::uuid;
  first_task_id := (result->>'taskId')::uuid;

  if series_id is null or first_task_id is null or replay <> result then
    raise exception 'Recurring series creation is not atomic and idempotent: %, %', result, replay;
  end if;
  if (select count(*) from private.sygtasks_recurring_occurrences occurrence where occurrence.series_id = recurrence_contract.series_id) <> 1
     or (select count(*) from private.sygtasks_tasks task where task.id = recurrence_contract.first_task_id) <> 1
     or (select count(*) from private.sygtasks_task_reminders reminder where reminder.task_id = recurrence_contract.first_task_id) <> 1
  then raise exception 'The first recurring occurrence, task, or alarm was not created exactly once.'; end if;

  result := public.get_sygtasks_recurring_series(first_task_id);
  if result->'series'->>'frequency' <> 'weekly'
     or (result->'series'->>'generatedCount')::integer <> 1
  then raise exception 'The recurring series workspace is incomplete: %', result; end if;

  select task.version into first_task_version from private.sygtasks_tasks task where task.id = recurrence_contract.first_task_id;
  perform public.mutate_sygtasks('update_task', jsonb_build_object('taskId', first_task_id, 'status', 'done'), gen_random_uuid(), first_task_version);
  if (select status from private.sygtasks_recurring_series series where series.id = recurrence_contract.series_id) <> 'active' then
    raise exception 'Completing one occurrence changed the series lifecycle.';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  result := public.service_process_due_sygtasks_recurring_series(10, 8);
  if (result->>'created')::integer <> 1
     or (select count(*) from private.sygtasks_recurring_occurrences occurrence where occurrence.series_id = recurrence_contract.series_id and occurrence.state = 'generated') <> 2
  then raise exception 'The scheduled processor did not create the next occurrence exactly once: %', result; end if;
  perform public.service_process_due_sygtasks_recurring_series(10, 8);
  if (select count(*) from private.sygtasks_recurring_occurrences occurrence where occurrence.series_id = recurrence_contract.series_id and occurrence.state = 'generated') <> 2 then
    raise exception 'Retrying the scheduled processor duplicated an occurrence.';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id::text, 'aal', 'aal2', 'role', 'authenticated'
  )::text, true);
  select series.version into series_version from private.sygtasks_recurring_series series where series.id = recurrence_contract.series_id;
  result := public.manage_sygtasks_recurring_series(series_id, 'pause', '{}'::jsonb, gen_random_uuid(), series_version);
  result := public.manage_sygtasks_recurring_series(series_id, 'resume', '{}'::jsonb, gen_random_uuid(), (result->>'version')::integer);
  result := public.manage_sygtasks_recurring_series(series_id, 'skip_next', '{}'::jsonb, gen_random_uuid(), (result->>'version')::integer);
  select count(*) into task_count_before_controls from private.sygtasks_tasks task where task.board_id = recurrence_contract.board_id;
  result := public.manage_sygtasks_recurring_series(series_id, 'cancel', '{}'::jsonb, gen_random_uuid(), (result->>'version')::integer);

  if result->>'status' <> 'canceled'
     or (select count(*) from private.sygtasks_tasks task where task.board_id = recurrence_contract.board_id) <> task_count_before_controls
     or not exists (select 1 from private.sygtasks_recurring_occurrences occurrence where occurrence.series_id = recurrence_contract.series_id and occurrence.state = 'skipped')
     or (select status from private.sygtasks_tasks task where task.id = recurrence_contract.first_task_id) <> 'done'
  then raise exception 'Pause, resume, skip, or stop rewrote occurrence history: %', result; end if;
end
$$;

rollback;

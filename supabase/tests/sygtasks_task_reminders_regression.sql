-- Run after 20260911020000_sygtasks_task_reminders.sql and the forward repair
-- 20260911021000_sygtasks_assignee_reminder_variable_repair.sql.
-- All boards, tasks, reminders, notifications, audit records, and delivery rows
-- are created inside this transaction and removed by the final rollback.
begin;

do $$
<<sygtasks_reminder_contract>>
declare
  actor_auth_id uuid;
  actor_employee_id uuid;
  assignee_employee_id uuid;
  board_id uuid := gen_random_uuid();
  task_id uuid := gen_random_uuid();
  assignment_id uuid;
  alarm_request_id uuid := gen_random_uuid();
  reminder_request_id uuid := gen_random_uuid();
  alarm_id uuid;
  alarm_occurrence_id uuid;
  assignee_reminder_id uuid;
  first_result jsonb;
  replay_result jsonb;
  payload jsonb;
  original_schedule timestamptz;
  updated_schedule timestamptz;
begin
  if not has_function_privilege('authenticated', 'public.create_sygtasks_task_reminder(jsonb,uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_my_sygtasks_alarm_state()', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_sygtasks_task_reminder(jsonb,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_process_due_sygtasks_reminders(integer)', 'EXECUTE')
  then
    raise exception 'SygTasks reminder RPC grants are not least-privilege.';
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

  select employee.id
  into assignee_employee_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and employee.id <> actor_employee_id
    and (
      'tasks.view' = any(private.employee_effective_permissions(employee.id))
      or 'tasks.manage' = any(private.employee_effective_permissions(employee.id))
    )
  order by employee.id
  limit 1;

  if actor_auth_id is null or actor_employee_id is null or assignee_employee_id is null then
    raise exception 'SygTasks reminder regression requires one manager and one other active task account.';
  end if;

  insert into private.sygtasks_boards (
    id, name, description, scope, owner_employee_id, created_by, updated_by
  ) values (
    board_id, 'Reminder regression ' || left(gen_random_uuid()::text, 8),
    'Transactional SygTasks reminder regression board.', 'team', actor_employee_id,
    actor_employee_id, actor_employee_id
  );
  insert into private.sygtasks_board_memberships (board_id, employee_id, member_role, added_by)
  values
    (board_id, actor_employee_id, 'owner', actor_employee_id),
    (board_id, assignee_employee_id, 'member', actor_employee_id);
  insert into private.sygtasks_tasks (
    id, board_id, title, description, status, priority, due_at, created_by, updated_by
  ) values (
    task_id, board_id, 'Confirm reminder delivery', '', 'ready', 'high',
    statement_timestamp() + interval '2 hours', actor_employee_id, actor_employee_id
  );
  insert into private.sygtasks_task_assignees (task_id, employee_id, assigned_by)
  values (task_id, assignee_employee_id, actor_employee_id)
  returning id into assignment_id;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id::text, 'aal', 'aal2', 'role', 'authenticated'
  )::text, true);

  first_result := public.create_sygtasks_task_reminder(jsonb_build_object(
    'taskId', task_id,
    'kind', 'alarm',
    'recipientScope', 'self',
    'timingKind', 'absolute',
    'offsetMinutes', null,
    'absoluteAt', statement_timestamp() + interval '1 hour',
    'emailEnabled', false
  ), alarm_request_id);
  replay_result := public.create_sygtasks_task_reminder(jsonb_build_object(
    'taskId', task_id,
    'kind', 'alarm',
    'recipientScope', 'self',
    'timingKind', 'absolute',
    'offsetMinutes', null,
    'absoluteAt', statement_timestamp() + interval '1 hour',
    'emailEnabled', false
  ), alarm_request_id);

  alarm_id := (first_result->>'reminderId')::uuid;
  if alarm_id is null or replay_result <> first_result
     or (select count(*) from private.sygtasks_task_reminders reminder where reminder.id = alarm_id) <> 1
  then
    raise exception 'Alarm creation is not atomic and idempotent: %, %', first_result, replay_result;
  end if;

  select occurrence.id into alarm_occurrence_id
  from private.sygtasks_task_reminder_occurrences occurrence
  where occurrence.reminder_id = alarm_id
    and occurrence.recipient_employee_id = actor_employee_id
    and occurrence.state = 'scheduled';
  if alarm_occurrence_id is null then raise exception 'Private alarm did not create its actor occurrence.'; end if;

  payload := public.create_sygtasks_task_reminder(jsonb_build_object(
    'taskId', task_id,
    'kind', 'reminder',
    'recipientScope', 'assignees',
    'timingKind', 'relative',
    'offsetMinutes', 60,
    'absoluteAt', null,
    'emailEnabled', false
  ), reminder_request_id);
  assignee_reminder_id := (payload->>'reminderId')::uuid;
  select occurrence.scheduled_for into original_schedule
  from private.sygtasks_task_reminder_occurrences occurrence
  where occurrence.reminder_id = assignee_reminder_id
    and occurrence.recipient_employee_id = assignee_employee_id
    and occurrence.state = 'scheduled';
  if original_schedule is null then raise exception 'Assignee reminder did not create the assignee occurrence.'; end if;

  update private.sygtasks_tasks task
  set due_at = task.due_at + interval '1 hour', updated_at = clock_timestamp(), version = task.version + 1
  where task.id = task_id;
  select occurrence.scheduled_for into updated_schedule
  from private.sygtasks_task_reminder_occurrences occurrence
  where occurrence.reminder_id = assignee_reminder_id
    and occurrence.recipient_employee_id = assignee_employee_id;
  if updated_schedule <> original_schedule + interval '1 hour' then
    raise exception 'Relative reminder did not follow the task due time: %, %', original_schedule, updated_schedule;
  end if;

  update private.sygtasks_task_reminder_occurrences occurrence
  set scheduled_for = statement_timestamp() - interval '1 minute'
  where occurrence.id = alarm_occurrence_id;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  payload := public.service_process_due_sygtasks_reminders(10);
  if (payload->>'triggered')::integer < 1
     or not exists (
       select 1 from private.sygtasks_task_reminder_occurrences occurrence
       where occurrence.id = alarm_occurrence_id
         and occurrence.state = 'triggered'
         and occurrence.delivery_count = 1
         and occurrence.last_notification_id is not null
     )
  then
    raise exception 'Due alarm delivery did not become active: %', payload;
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id::text, 'aal', 'aal2', 'role', 'authenticated'
  )::text, true);
  payload := public.get_my_sygtasks_alarm_state();
  if not exists (
    select 1 from jsonb_array_elements(payload->'alarms') alarm
    where (alarm->>'occurrenceId')::uuid = alarm_occurrence_id
  ) then raise exception 'Active alarm is missing from the recipient state workspace: %', payload; end if;

  perform public.manage_my_sygtasks_alarm('snooze', alarm_occurrence_id, 10, gen_random_uuid());
  if not exists (
    select 1 from private.sygtasks_task_reminder_occurrences occurrence
    where occurrence.id = alarm_occurrence_id
      and occurrence.state = 'snoozed'
      and occurrence.snoozed_until > statement_timestamp()
  ) then raise exception 'Alarm snooze did not persist server-side.'; end if;

  update private.sygtasks_task_assignees assignee
  set removed_at = clock_timestamp(), removed_by = actor_employee_id
  where assignee.id = assignment_id;
  if not exists (
    select 1 from private.sygtasks_task_reminder_occurrences occurrence
    where occurrence.reminder_id = assignee_reminder_id
      and occurrence.recipient_employee_id = assignee_employee_id
      and occurrence.state = 'cancelled'
      and occurrence.cancellation_reason = 'recipient_removed'
  ) then raise exception 'Removing the assignee did not cancel that recipient reminder.'; end if;

  update private.sygtasks_tasks task
  set status = 'done', completed_at = clock_timestamp(), updated_at = clock_timestamp(), version = task.version + 1
  where task.id = task_id;
  if not exists (
    select 1 from private.sygtasks_task_reminder_occurrences occurrence
    where occurrence.id = alarm_occurrence_id
      and occurrence.state = 'cancelled'
      and occurrence.cancellation_reason = 'task_completed'
  ) then raise exception 'Completing the task did not cancel its snoozed alarm.'; end if;
end
$$;

rollback;

begin;

-- Stage 5, run 3: service-only workspace reads, compact Action Center tasks,
-- due-date escalation, and auditable task viewing. The release gate remains off.
create temporary table hris_stage5_run3_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count;

alter table private.hr_workflow_tasks
  add column if not exists escalated_at timestamptz,
  add column if not exists escalation_count integer not null default 0;

alter table private.hr_workflow_tasks
  drop constraint if exists hr_workflow_task_escalation_count_check;
alter table private.hr_workflow_tasks
  add constraint hr_workflow_task_escalation_count_check check (escalation_count >= 0);

create unique index if not exists hr_workflow_tasks_instance_step_unique
  on private.hr_workflow_tasks(instance_id, step_key);
create index if not exists hr_workflow_tasks_due_escalation_idx
  on private.hr_workflow_tasks(due_at, escalated_at)
  where status in ('open', 'viewed') and action_center_visible;

create or replace function public.service_get_hr_automation_workspace(
  target_actor_id uuid,
  target_page_size integer default 10,
  target_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  gate_enabled boolean;
  page_size integer := greatest(5, least(coalesce(target_page_size, 10), 20));
  row_offset integer := greatest(0, coalesce(target_offset, 0));
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  perform private.hr_automation_require_actor_permission(target_actor_id, 'hr.automation.view');
  select gate.enabled into gate_enabled from private.hr_automation_release_gate gate where gate.singleton;
  if not coalesce(gate_enabled, false) then
    return jsonb_build_object(
      'enabled', false,
      'definitions', '[]'::jsonb,
      'instances', '[]'::jsonb,
      'tasks', '[]'::jsonb,
      'deadLetters', '[]'::jsonb,
      'counts', jsonb_build_object('definitions', 0, 'activeInstances', 0, 'openTasks', 0, 'deadLetters', 0)
    );
  end if;

  select jsonb_build_object(
    'enabled', true,
    'pageSize', page_size,
    'offset', row_offset,
    'definitions', coalesce((
      select jsonb_agg(item.payload order by item.updated_at desc)
      from (
        select definition.updated_at,
          jsonb_build_object(
            'id', definition.id,
            'code', definition.code,
            'name', definition.name,
            'description', definition.description,
            'status', definition.status,
            'activeVersionId', definition.active_version_id,
            'updatedAt', definition.updated_at
          ) as payload
        from private.hr_workflow_definitions definition
        order by definition.updated_at desc
        limit page_size offset row_offset
      ) item
    ), '[]'::jsonb),
    'instances', coalesce((
      select jsonb_agg(item.payload order by item.created_at desc)
      from (
        select instance.created_at,
          jsonb_build_object(
            'id', instance.id,
            'workflowName', definition.name,
            'subjectEmployeeId', instance.subject_employee_id,
            'subjectName', case when subject.id is null then null else concat_ws(' ', subject.first_name, subject.last_name) end,
            'state', instance.state,
            'currentStepKey', instance.current_step_key,
            'dueAt', instance.due_at,
            'createdAt', instance.created_at,
            'failureCode', instance.failure_code,
            'failureMessage', instance.failure_message
          ) as payload
        from private.hr_workflow_instances instance
        join private.hr_workflow_versions version on version.id = instance.workflow_version_id
        join private.hr_workflow_definitions definition on definition.id = version.definition_id
        left join public.employees subject on subject.id = instance.subject_employee_id
        order by instance.created_at desc
        limit page_size offset row_offset
      ) item
    ), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(item.payload order by item.due_at nulls last, item.created_at)
      from (
        select task.due_at, task.created_at,
          jsonb_build_object(
            'id', task.id,
            'instanceId', task.instance_id,
            'title', task.title,
            'instructions', task.instructions,
            'status', task.status,
            'assignedEmployeeId', task.assigned_employee_id,
            'assignedName', case when assignee.id is null then null else concat_ws(' ', assignee.first_name, assignee.last_name) end,
            'requiredPermission', task.required_permission,
            'dueAt', task.due_at,
            'escalatedAt', task.escalated_at,
            'escalationCount', task.escalation_count
          ) as payload
        from private.hr_workflow_tasks task
        left join public.employees assignee on assignee.id = task.assigned_employee_id
        where task.status in ('open', 'viewed')
        order by task.due_at nulls last, task.created_at
        limit page_size offset row_offset
      ) item
    ), '[]'::jsonb),
    'deadLetters', coalesce((
      select jsonb_agg(item.payload order by item.failed_at desc)
      from (
        select letter.failed_at,
          jsonb_build_object(
            'id', letter.id,
            'jobId', letter.job_id,
            'instanceId', letter.instance_id,
            'errorCode', letter.error_code,
            'errorMessage', letter.error_message,
            'failedAt', letter.failed_at,
            'replayedAt', letter.replayed_at
          ) as payload
        from private.hr_automation_dead_letters letter
        order by letter.failed_at desc
        limit page_size offset row_offset
      ) item
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'definitions', (select count(*) from private.hr_workflow_definitions),
      'activeInstances', (select count(*) from private.hr_workflow_instances where state in ('queued', 'running', 'waiting', 'paused')),
      'openTasks', (select count(*) from private.hr_workflow_tasks where status in ('open', 'viewed')),
      'deadLetters', (select count(*) from private.hr_automation_dead_letters where replayed_at is null)
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.service_get_my_hr_automation_tasks(target_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  gate_enabled boolean;
  effective_permissions text[];
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  effective_permissions := private.hr_automation_require_actor_permission(target_actor_id, 'actions.self.view');
  select gate.enabled into gate_enabled from private.hr_automation_release_gate gate where gate.singleton;
  if not coalesce(gate_enabled, false) then
    return jsonb_build_object('enabled', false, 'tasks', '[]'::jsonb, 'total', 0);
  end if;
  select jsonb_build_object(
    'enabled', true,
    'total', count(*),
    'tasks', coalesce(jsonb_agg(jsonb_build_object(
      'id', task.id,
      'instanceId', task.instance_id,
      'title', task.title,
      'instructions', task.instructions,
      'status', task.status,
      'dueAt', task.due_at,
      'escalatedAt', task.escalated_at
    ) order by task.due_at nulls last, task.created_at) filter (where task.id is not null), '[]'::jsonb)
  ) into result
  from (
    select visible_task.*
    from private.hr_workflow_tasks visible_task
    where visible_task.action_center_visible
      and visible_task.status in ('open', 'viewed')
      and (
        visible_task.assigned_employee_id = target_actor_id
        or (visible_task.required_permission is not null and visible_task.required_permission = any(effective_permissions))
      )
    order by visible_task.due_at nulls last, visible_task.created_at
    limit 10
  ) task;
  return result;
end;
$$;

create or replace function public.service_mark_hr_workflow_task_viewed(
  target_actor_id uuid,
  target_task_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  task_record private.hr_workflow_tasks%rowtype;
  effective_permissions text[];
begin
  perform private.hr_automation_require_released();
  effective_permissions := private.hr_automation_require_actor_permission(target_actor_id, 'actions.self.view');
  select * into task_record from private.hr_workflow_tasks where id = target_task_id for update;
  if task_record.id is null or task_record.status not in ('open', 'viewed') then
    raise no_data_found using message = 'The HR task is no longer open.';
  end if;
  if task_record.assigned_employee_id is distinct from target_actor_id
     and (task_record.required_permission is null or not task_record.required_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'This HR task is assigned to someone else.';
  end if;
  update private.hr_workflow_tasks
  set status = 'viewed', viewed_at = coalesce(viewed_at, clock_timestamp()), updated_at = clock_timestamp()
  where id = target_task_id and status = 'open';
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, actor_employee_id, details)
  values ('workflow_task', target_task_id, 'viewed', target_actor_id, jsonb_build_object('instanceId', task_record.instance_id));
  return jsonb_build_object('taskId', target_task_id, 'status', (select status from private.hr_workflow_tasks where id = target_task_id));
end;
$$;

create or replace function public.service_enqueue_hr_task_escalations(target_now timestamptz default clock_timestamp())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  escalated_count integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  perform private.hr_automation_require_released();
  with due_tasks as (
    select task.id, task.instance_id, task.assigned_employee_id, task.title, task.instructions, task.due_at
    from private.hr_workflow_tasks task
    where task.status in ('open', 'viewed')
      and task.action_center_visible
      and task.due_at is not null
      and task.due_at <= target_now
      and (task.escalated_at is null or task.escalated_at < target_now - interval '24 hours')
    for update skip locked
  ), queued as (
    insert into private.notification_outbox (
      message_type, aggregate_type, aggregate_id, recipient_employee_id, payload, idempotency_key
    )
    select
      'hr_task_escalation', 'hr_workflow_task', due.id, due.assigned_employee_id,
      jsonb_build_object(
        'subject', 'HR action is overdue',
        'message', due.title,
        'instructions', due.instructions,
        'dueAt', due.due_at,
        'instanceId', due.instance_id
      ),
      'hr-task-escalation:' || due.id::text || ':' || to_char(target_now at time zone 'UTC', 'YYYYMMDD')
    from due_tasks due
    where due.assigned_employee_id is not null
    on conflict (idempotency_key) do nothing
    returning aggregate_id
  )
  update private.hr_workflow_tasks task
  set escalated_at = target_now,
      escalation_count = task.escalation_count + 1,
      updated_at = clock_timestamp()
  where task.id in (select due.id from due_tasks);
  get diagnostics escalated_count = row_count;
  insert into private.hr_automation_events (aggregate_type, aggregate_id, event_type, details)
  select 'workflow_task', task.id, 'escalated', jsonb_build_object('dueAt', task.due_at, 'escalationCount', task.escalation_count)
  from private.hr_workflow_tasks task
  where task.escalated_at = target_now;
  return escalated_count;
end;
$$;

revoke all on function public.service_get_hr_automation_workspace(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.service_get_my_hr_automation_tasks(uuid) from public, anon, authenticated;
revoke all on function public.service_mark_hr_workflow_task_viewed(uuid, uuid) from public, anon, authenticated;
revoke all on function public.service_enqueue_hr_task_escalations(timestamptz) from public, anon, authenticated;
grant execute on function public.service_get_hr_automation_workspace(uuid, integer, integer) to service_role;
grant execute on function public.service_get_my_hr_automation_tasks(uuid) to service_role;
grant execute on function public.service_mark_hr_workflow_task_viewed(uuid, uuid) to service_role;
grant execute on function public.service_enqueue_hr_task_escalations(timestamptz) to service_role;

do $$
declare baseline record;
begin
  select * into baseline from hris_stage5_run3_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
     or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
     or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
     or baseline.override_count <> (select count(*) from public.employee_permission_overrides) then
    raise exception 'Stage 5 run 3 changed protected employee or access-control assignments.';
  end if;
  if exists (select 1 from private.hr_automation_release_gate where singleton and enabled) then
    raise exception 'Stage 5 automation release gate must remain disabled.';
  end if;
end;
$$;

commit;

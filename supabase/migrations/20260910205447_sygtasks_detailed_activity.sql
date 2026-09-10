create function public.get_sygtasks_task_activity(
  target_task_id uuid,
  target_before_id bigint default null,
  target_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_page_size integer := target_page_size;
  result jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if clean_page_size not in (20, 50, 100) then
    raise check_violation using message = 'Task activity page size must be 20, 50, or 100.';
  end if;

  if not private.sygtasks_can_view_task(actor_id, target_task_id) then
    raise insufficient_privilege using message = 'You do not have access to this task.';
  end if;

  with candidates as materialized (
    select activity.*
    from private.sygtasks_activity activity
    where activity.task_id = target_task_id
      and (target_before_id is null or activity.id < target_before_id)
    order by activity.id desc
    limit clean_page_size + 1
  ),
  page_rows as (
    select candidate.*
    from candidates candidate
    order by candidate.id desc
    limit clean_page_size
  )
  select jsonb_build_object(
    'taskId', target_task_id,
    'events', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', activity.id,
          'action', activity.action,
          'entityType', activity.entity_type,
          'entityId', activity.entity_id,
          'details', activity.details,
          'actorId', actor.id,
          'actorName', concat(coalesce(nullif(actor.preferred_name, ''), actor.first_name), ' ', actor.last_name),
          'actorSource', 'employee',
          'createdAt', activity.created_at,
          'subject', case when subject.id is null then null else jsonb_build_object(
            'employeeId', subject.id,
            'name', concat(coalesce(nullif(subject.preferred_name, ''), subject.first_name), ' ', subject.last_name),
            'username', subject.username
          ) end,
          'label', case when label.id is null then null else jsonb_build_object(
            'labelId', label.id,
            'name', label.name,
            'color', label.color
          ) end,
          'relatedTask', case when related_task.id is null then null else jsonb_build_object(
            'taskId', related_task.id,
            'title', related_task.title
          ) end
        ) order by activity.id desc
      )
      from page_rows activity
      join public.employees actor on actor.id = activity.actor_employee_id
      left join public.employees subject
        on subject.id::text = activity.details->>'employeeId'
      left join private.sygtasks_labels label
        on label.id::text = activity.details->>'labelId'
      left join private.sygtasks_tasks related_task
        on related_task.id::text = activity.details->>'dependsOnTaskId'
    ), '[]'::jsonb),
    'page', jsonb_build_object(
      'size', clean_page_size,
      'hasMore', (select count(*) > clean_page_size from candidates),
      'nextBeforeId', case
        when (select count(*) > clean_page_size from candidates)
          then (select min(page_row.id) from page_rows page_row)
        else null
      end
    )
  ) into result;

  return result;
end
$$;

revoke all on function public.get_sygtasks_task_activity(uuid,bigint,integer) from public, anon;
grant execute on function public.get_sygtasks_task_activity(uuid,bigint,integer) to authenticated;

comment on function public.get_sygtasks_task_activity(uuid,bigint,integer) is
  'Returns a bounded, cursor-paginated SygTasks audit timeline enriched with readable related names for employees who may view the task.';

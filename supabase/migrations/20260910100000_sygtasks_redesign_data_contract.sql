begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The redesign keeps the original SygTasks workspace and mutation contracts
-- intact. These additive RPCs provide exact, authorized work-list metrics and
-- an atomic create-and-assign command without exposing the private domain.

create index if not exists sygtasks_tasks_completed_idx
  on private.sygtasks_tasks(completed_at, id)
  where archived_at is null and status = 'done';

create function private.sygtasks_is_my_work(
  target_employee_id uuid,
  target_task_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from private.sygtasks_tasks task
    join private.sygtasks_boards board on board.id = task.board_id
    where task.id = target_task_id
      and private.sygtasks_can_view_task(target_employee_id, task.id)
      and (
        task.created_by = target_employee_id
        or board.owner_employee_id = target_employee_id
        or exists (
          select 1
          from private.sygtasks_task_assignees assignee
          where assignee.task_id = task.id
            and assignee.employee_id = target_employee_id
            and assignee.removed_at is null
        )
        or exists (
          select 1
          from private.sygtasks_task_watchers watcher
          where watcher.task_id = task.id
            and watcher.employee_id = target_employee_id
            and watcher.removed_at is null
        )
        or (
          task.status = 'review'
          and exists (
            select 1
            from private.sygtasks_board_memberships membership
            where membership.board_id = board.id
              and membership.employee_id = target_employee_id
              and membership.member_role in ('owner', 'editor')
              and membership.removed_at is null
          )
        )
      )
  ), false)
$$;

create function public.get_sygtasks_worklist(
  target_mode text default 'my_work',
  target_board_id uuid default null,
  target_search text default '',
  target_status text default null,
  target_priority text default null,
  target_page integer default 1,
  target_page_size integer default 20,
  target_include_archived boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor_id uuid := private.current_employee_id();
  clean_mode text := lower(btrim(coalesce(target_mode, 'my_work')));
  clean_search text := lower(btrim(coalesce(target_search, '')));
  clean_status text := nullif(lower(btrim(coalesce(target_status, ''))), '');
  clean_priority text := nullif(lower(btrim(coalesce(target_priority, ''))), '');
  page_number integer := coalesce(target_page, 1);
  page_size integer := coalesce(target_page_size, 20);
  include_archived boolean := coalesce(target_include_archived, false);
  denver_today date := (statement_timestamp() at time zone 'America/Denver')::date;
  day_start timestamptz;
  day_end timestamptz;
  month_start timestamptz;
  month_end timestamptz;
  board_payload jsonb := '[]'::jsonb;
  summary_payload jsonb := '{}'::jsonb;
  task_payload jsonb := '[]'::jsonb;
  status_count_payload jsonb := '{}'::jsonb;
  priority_count_payload jsonb := '{}'::jsonb;
  total_count bigint := 0;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if clean_mode not in ('my_work', 'board') then
    raise check_violation using message = 'Choose My Work or a board task list.';
  end if;
  if clean_mode = 'board' and target_board_id is null then
    raise check_violation using message = 'Choose a board.';
  end if;
  if target_board_id is not null
     and not private.sygtasks_can_view_board(actor_id, target_board_id)
  then
    raise insufficient_privilege using message = 'This board is not available to your account.';
  end if;
  if char_length(clean_search) > 200 then
    raise check_violation using message = 'Search terms are limited to 200 characters.';
  end if;
  if clean_status is not null
     and clean_status not in ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'canceled')
  then
    raise check_violation using message = 'Choose a valid task status.';
  end if;
  if clean_priority is not null
     and clean_priority not in ('low', 'routine', 'high', 'urgent')
  then
    raise check_violation using message = 'Choose a valid task priority.';
  end if;
  if page_number < 1 or page_number > 10000 then
    raise check_violation using message = 'Choose a valid task page.';
  end if;
  if page_size not in (5, 10, 20, 50) then
    raise check_violation using message = 'Choose 5, 10, 20, or 50 tasks per page.';
  end if;

  day_start := denver_today::timestamp at time zone 'America/Denver';
  day_end := (denver_today + 1)::timestamp at time zone 'America/Denver';
  month_start := date_trunc('month', denver_today::timestamp) at time zone 'America/Denver';
  month_end := (date_trunc('month', denver_today::timestamp) + interval '1 month') at time zone 'America/Denver';

  select coalesce(jsonb_agg(board_row.payload order by board_row.updated_at desc, board_row.id desc), '[]'::jsonb)
  into board_payload
  from (
    select
      board.id,
      board.updated_at,
      jsonb_build_object(
        'id', board.id,
        'name', board.name,
        'description', board.description,
        'scope', board.scope,
        'ownerEmployeeId', board.owner_employee_id,
        'ownerName', concat(coalesce(nullif(owner.preferred_name, ''), owner.first_name), ' ', owner.last_name),
        'memberRole', (
          select membership.member_role
          from private.sygtasks_board_memberships membership
          where membership.board_id = board.id
            and membership.employee_id = actor_id
            and membership.removed_at is null
          limit 1
        ),
        'version', board.version,
        'archivedAt', board.archived_at,
        'createdAt', board.created_at,
        'updatedAt', board.updated_at,
        'openTaskCount', (
          select count(*)
          from private.sygtasks_tasks task
          where task.board_id = board.id
            and task.archived_at is null
            and task.status not in ('done', 'canceled')
            and private.sygtasks_can_view_task(actor_id, task.id)
        ),
        'canManageBoard', private.sygtasks_has_permission(actor_id, 'tasks.manage')
          or (board.scope = 'personal' and board.owner_employee_id = actor_id),
        'canCreateTask', private.sygtasks_can_edit_board_tasks(actor_id, board.id)
      ) as payload
    from private.sygtasks_boards board
    join public.employees owner on owner.id = board.owner_employee_id
    where (include_archived or board.archived_at is null)
      and private.sygtasks_can_view_board(actor_id, board.id)
  ) board_row;

  select jsonb_build_object(
    'accessibleBoards', (
      select count(*)
      from private.sygtasks_boards accessible_board
      where accessible_board.archived_at is null
        and private.sygtasks_can_view_board(actor_id, accessible_board.id)
    ),
    'current', count(*) filter (where task.status not in ('done', 'canceled')),
    'dueToday', count(*) filter (
      where task.status not in ('done', 'canceled')
        and task.due_at >= day_start
        and task.due_at < day_end
    ),
    'inProgress', count(*) filter (where task.status = 'in_progress'),
    'upcoming', count(*) filter (
      where task.status not in ('done', 'canceled')
        and task.due_at >= day_end
    ),
    'completedThisMonth', count(*) filter (
      where task.status = 'done'
        and task.completed_at >= month_start
        and task.completed_at < month_end
    ),
    'timezone', 'America/Denver',
    'asOf', statement_timestamp()
  )
  into summary_payload
  from private.sygtasks_tasks task
  join private.sygtasks_boards board on board.id = task.board_id
  where task.archived_at is null
    and board.archived_at is null
    and private.sygtasks_is_my_work(actor_id, task.id);

  with authorized_tasks as (
    select task.id, task.status, task.priority, task.due_at, task.updated_at
    from private.sygtasks_tasks task
    join private.sygtasks_boards board on board.id = task.board_id
    where (include_archived or (task.archived_at is null and board.archived_at is null))
      and private.sygtasks_can_view_task(actor_id, task.id)
      and (
        (clean_mode = 'my_work' and private.sygtasks_is_my_work(actor_id, task.id))
        or (clean_mode = 'board' and task.board_id = target_board_id)
      )
      and (target_board_id is null or task.board_id = target_board_id)
      and (
        clean_search = ''
        or position(clean_search in lower(task.title)) > 0
        or position(clean_search in lower(task.description)) > 0
        or position(clean_search in lower(board.name)) > 0
        or exists (
          select 1
          from private.sygtasks_task_assignees assignee
          join public.employees employee on employee.id = assignee.employee_id
          where assignee.task_id = task.id
            and assignee.removed_at is null
            and (
              position(clean_search in lower(concat(
                coalesce(nullif(employee.preferred_name, ''), employee.first_name),
                ' ',
                employee.last_name
              ))) > 0
              or position(clean_search in lower(employee.username)) > 0
            )
        )
        or exists (
          select 1
          from private.sygtasks_task_labels task_label
          join private.sygtasks_labels label on label.id = task_label.label_id
          where task_label.task_id = task.id
            and task_label.removed_at is null
            and label.archived_at is null
            and position(clean_search in lower(label.name)) > 0
        )
      )
  ),
  filtered_tasks as (
    select authorized.id, authorized.status, authorized.priority, authorized.due_at, authorized.updated_at
    from authorized_tasks authorized
    where (
        clean_status is not null and authorized.status = clean_status
        or clean_status is null
           and (clean_mode <> 'my_work' or authorized.status not in ('done', 'canceled'))
      )
      and (clean_priority is null or authorized.priority = clean_priority)
  ),
  page_tasks as (
    select filtered.id, filtered.due_at, filtered.updated_at
    from filtered_tasks filtered
    order by
      case when filtered.due_at is null then 1 else 0 end,
      filtered.due_at,
      filtered.updated_at desc,
      filtered.id desc
    offset ((page_number - 1) * page_size)
    limit page_size
  ),
  status_scope as (
    select authorized.status
    from authorized_tasks authorized
    where (clean_priority is null or authorized.priority = clean_priority)
  ),
  priority_scope as (
    select authorized.priority
    from authorized_tasks authorized
    where (
      clean_status is not null and authorized.status = clean_status
      or clean_status is null
         and (clean_mode <> 'my_work' or authorized.status not in ('done', 'canceled'))
    )
  )
  select
    coalesce((
      select jsonb_agg(
        private.sygtasks_task_json(page_task.id, actor_id)
          || jsonb_build_object('boardName', board.name)
        order by
          case when page_task.due_at is null then 1 else 0 end,
          page_task.due_at,
          page_task.updated_at desc,
          page_task.id desc
      )
      from page_tasks page_task
      join private.sygtasks_tasks task on task.id = page_task.id
      join private.sygtasks_boards board on board.id = task.board_id
    ), '[]'::jsonb),
    (select count(*) from filtered_tasks),
    jsonb_build_object(
      'backlog', (select count(*) from status_scope scope where scope.status = 'backlog'),
      'ready', (select count(*) from status_scope scope where scope.status = 'ready'),
      'in_progress', (select count(*) from status_scope scope where scope.status = 'in_progress'),
      'blocked', (select count(*) from status_scope scope where scope.status = 'blocked'),
      'review', (select count(*) from status_scope scope where scope.status = 'review'),
      'done', (select count(*) from status_scope scope where scope.status = 'done'),
      'canceled', (select count(*) from status_scope scope where scope.status = 'canceled')
    ),
    jsonb_build_object(
      'low', (select count(*) from priority_scope scope where scope.priority = 'low'),
      'routine', (select count(*) from priority_scope scope where scope.priority = 'routine'),
      'high', (select count(*) from priority_scope scope where scope.priority = 'high'),
      'urgent', (select count(*) from priority_scope scope where scope.priority = 'urgent')
    )
  into task_payload, total_count, status_count_payload, priority_count_payload;

  return jsonb_build_object(
    'summary', summary_payload,
    'boards', board_payload,
    'tasks', task_payload,
    'counts', jsonb_build_object(
      'status', status_count_payload,
      'priority', priority_count_payload
    ),
    'filters', jsonb_build_object(
      'mode', clean_mode,
      'boardId', target_board_id,
      'search', clean_search,
      'status', clean_status,
      'priority', clean_priority,
      'includeArchived', include_archived
    ),
    'page', jsonb_build_object(
      'number', page_number,
      'size', page_size,
      'total', total_count,
      'totalPages', case
        when total_count = 0 then 0
        else ceil(total_count::numeric / page_size)::integer
      end,
      'hasPrevious', page_number > 1,
      'hasMore', (page_number::bigint * page_size::bigint) < total_count
    )
  );
end
$$;

create function public.create_sygtasks_task(
  target_payload jsonb,
  target_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor_id uuid := private.current_employee_id();
  clean_payload jsonb := coalesce(target_payload, '{}'::jsonb);
  request_fingerprint text;
  prior_request private.sygtasks_action_requests%rowtype;
  create_request_id uuid;
  assignment_request_id uuid;
  assignee_employee_id uuid;
  create_result jsonb;
  assignment_result jsonb;
  result jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if target_client_request_id is null then
    raise check_violation using message = 'A client request identifier is required.';
  end if;
  if jsonb_typeof(clean_payload) <> 'object'
     or octet_length(clean_payload::text) > 65536
  then
    raise check_violation using message = 'The SygTasks request is too large or malformed.';
  end if;
  if clean_payload - array[
    'boardId', 'title', 'description', 'status', 'priority', 'dueAt', 'sortRank', 'assigneeId'
  ]::text[] <> '{}'::jsonb then
    raise check_violation using message = 'This SygTasks action contains unsupported fields.';
  end if;

  assignee_employee_id := nullif(clean_payload->>'assigneeId', '')::uuid;
  request_fingerprint := md5('create_task_with_assignee|' || clean_payload::text);

  perform pg_advisory_xact_lock(
    hashtextextended(concat('sygtasks:', actor_id, ':', target_client_request_id), 0)
  );

  select request.* into prior_request
  from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id
    and request.client_request_id = target_client_request_id;

  if prior_request.id is not null then
    if prior_request.action <> 'create_task_with_assignee'
       or prior_request.request_hash <> request_fingerprint
    then
      raise check_violation using message = 'This request identifier was already used for a different action.';
    end if;
    return prior_request.response;
  end if;

  if (
    select count(*)
    from private.sygtasks_action_requests request
    where request.actor_employee_id = actor_id
      and request.created_at > clock_timestamp() - interval '1 minute'
  ) >= 120 then
    raise check_violation using message = 'Please wait a moment before making more task changes.';
  end if;

  create_request_id := md5(target_client_request_id::text || ':create')::uuid;
  assignment_request_id := md5(target_client_request_id::text || ':assign')::uuid;

  create_result := public.mutate_sygtasks(
    'create_task',
    clean_payload - 'assigneeId',
    create_request_id,
    null
  );

  if assignee_employee_id is not null then
    assignment_result := public.mutate_sygtasks(
      'assign_task',
      jsonb_build_object(
        'taskId', create_result->>'taskId',
        'employeeId', assignee_employee_id
      ),
      assignment_request_id,
      null
    );
  end if;

  result := create_result || jsonb_build_object(
    'action', 'create_task_with_assignee',
    'clientRequestId', target_client_request_id,
    'assignedEmployeeId', assignee_employee_id,
    'assignmentId', assignment_result->>'assigneeId',
    'assignmentChanged', coalesce((assignment_result->>'changed')::boolean, false),
    'changed', true
  );

  insert into private.sygtasks_action_requests (
    actor_employee_id,
    client_request_id,
    action,
    request_hash,
    response
  ) values (
    actor_id,
    target_client_request_id,
    'create_task_with_assignee',
    request_fingerprint,
    result
  );

  return result;
end
$$;

revoke all on function private.sygtasks_is_my_work(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_sygtasks_worklist(text, uuid, text, text, text, integer, integer, boolean) from public, anon;
revoke all on function public.create_sygtasks_task(jsonb, uuid) from public, anon;

grant execute on function public.get_sygtasks_worklist(text, uuid, text, text, text, integer, integer, boolean) to authenticated;
grant execute on function public.create_sygtasks_task(jsonb, uuid) to authenticated;

comment on function public.get_sygtasks_worklist(text, uuid, text, text, text, integer, integer, boolean) is
  'Returns an exact authorized SygTasks summary and server-filtered task page. Denver calendar boundaries keep workforce reporting consistent.';
comment on function public.create_sygtasks_task(jsonb, uuid) is
  'Atomically creates a task and optional assignment by composing the existing audited, idempotent SygTasks mutation contract.';

commit;

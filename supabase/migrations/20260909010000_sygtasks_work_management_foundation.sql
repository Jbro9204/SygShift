begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- SygTasks is an additive, private work-management domain. Browser access is
-- intentionally limited to the two authenticated RPCs installed below.

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values
  (
    'tasks.view',
    'SygTasks',
    'View SygTasks',
    'View company work and participate in team work where explicitly included.',
    'standard',
    false,
    true,
    true
  ),
  (
    'tasks.manage',
    'SygTasks',
    'Manage SygTasks',
    'Create and manage shared boards, assignments, labels, dependencies, and company work.',
    'sensitive',
    false,
    true,
    true
  )
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = true,
    updated_at = clock_timestamp();

-- Every protected system role receives the ordinary participation permission.
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'tasks.view', true
from public.access_roles role
where role.system_role
  and role.protected
  and role.active
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

-- Shared/company management is deliberately limited to the approved system roles.
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'tasks.manage', true
from public.access_roles role
where role.code in ('system_dispatcher', 'system_scheduler', 'system_supervisor', 'system_admin')
  and role.system_role
  and role.protected
  and role.active
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

create table private.sygtasks_boards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  scope text not null default 'personal',
  owner_employee_id uuid not null references public.employees(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_by uuid not null references public.employees(id) on delete restrict,
  version integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_boards_name_check check (char_length(btrim(name)) between 2 and 120),
  constraint sygtasks_boards_description_check check (char_length(description) <= 2000),
  constraint sygtasks_boards_scope_check check (scope in ('personal', 'team', 'company')),
  constraint sygtasks_boards_version_check check (version > 0)
);

create index sygtasks_boards_owner_idx
  on private.sygtasks_boards(owner_employee_id, updated_at desc);
create index sygtasks_boards_created_by_idx
  on private.sygtasks_boards(created_by, created_at desc);
create index sygtasks_boards_updated_by_idx
  on private.sygtasks_boards(updated_by, updated_at desc);
create index sygtasks_boards_active_scope_idx
  on private.sygtasks_boards(scope, updated_at desc, id desc)
  where archived_at is null;

create table private.sygtasks_board_memberships (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references private.sygtasks_boards(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  member_role text not null default 'member',
  added_by uuid not null references public.employees(id) on delete restrict,
  added_at timestamptz not null default clock_timestamp(),
  removed_by uuid references public.employees(id) on delete restrict,
  removed_at timestamptz,
  constraint sygtasks_board_memberships_role_check check (member_role in ('owner', 'editor', 'member', 'viewer')),
  constraint sygtasks_board_memberships_removal_check check (
    (removed_at is null and removed_by is null) or
    (removed_at is not null and removed_by is not null and removed_at >= added_at)
  )
);

create unique index sygtasks_board_memberships_active_unique
  on private.sygtasks_board_memberships(board_id, employee_id)
  where removed_at is null;
create index sygtasks_board_memberships_board_idx
  on private.sygtasks_board_memberships(board_id, added_at desc);
create index sygtasks_board_memberships_employee_idx
  on private.sygtasks_board_memberships(employee_id, board_id)
  where removed_at is null;
create index sygtasks_board_memberships_added_by_idx
  on private.sygtasks_board_memberships(added_by, added_at desc);
create index sygtasks_board_memberships_removed_by_idx
  on private.sygtasks_board_memberships(removed_by)
  where removed_by is not null;

create table private.sygtasks_tasks (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references private.sygtasks_boards(id) on delete restrict,
  title text not null,
  description text not null default '',
  status text not null default 'backlog',
  priority text not null default 'routine',
  due_at timestamptz,
  sort_rank bigint not null default 0,
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_by uuid not null references public.employees(id) on delete restrict,
  version integer not null default 1,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_tasks_title_check check (char_length(btrim(title)) between 1 and 240),
  constraint sygtasks_tasks_description_check check (char_length(description) <= 10000),
  constraint sygtasks_tasks_status_check check (status in ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'canceled')),
  constraint sygtasks_tasks_priority_check check (priority in ('low', 'routine', 'high', 'urgent')),
  constraint sygtasks_tasks_rank_check check (sort_rank between -1000000000 and 1000000000),
  constraint sygtasks_tasks_version_check check (version > 0),
  constraint sygtasks_tasks_completion_check check ((status = 'done') = (completed_at is not null))
);

create index sygtasks_tasks_board_page_idx
  on private.sygtasks_tasks(board_id, updated_at desc, id desc)
  where archived_at is null;
create index sygtasks_tasks_board_status_idx
  on private.sygtasks_tasks(board_id, status, due_at, id)
  where archived_at is null;
create index sygtasks_tasks_created_by_idx
  on private.sygtasks_tasks(created_by, updated_at desc);
create index sygtasks_tasks_updated_by_idx
  on private.sygtasks_tasks(updated_by, updated_at desc);
create index sygtasks_tasks_due_idx
  on private.sygtasks_tasks(due_at, id)
  where archived_at is null and status not in ('done', 'canceled');

create table private.sygtasks_task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  assigned_by uuid not null references public.employees(id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  removed_by uuid references public.employees(id) on delete restrict,
  removed_at timestamptz,
  constraint sygtasks_task_assignees_removal_check check (
    (removed_at is null and removed_by is null) or
    (removed_at is not null and removed_by is not null and removed_at >= assigned_at)
  )
);

create unique index sygtasks_task_assignees_active_unique
  on private.sygtasks_task_assignees(task_id, employee_id)
  where removed_at is null;
create index sygtasks_task_assignees_task_idx
  on private.sygtasks_task_assignees(task_id, assigned_at desc);
create index sygtasks_task_assignees_employee_idx
  on private.sygtasks_task_assignees(employee_id, task_id)
  where removed_at is null;
create index sygtasks_task_assignees_assigned_by_idx
  on private.sygtasks_task_assignees(assigned_by, assigned_at desc);
create index sygtasks_task_assignees_removed_by_idx
  on private.sygtasks_task_assignees(removed_by)
  where removed_by is not null;

create table private.sygtasks_task_watchers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  added_by uuid not null references public.employees(id) on delete restrict,
  added_at timestamptz not null default clock_timestamp(),
  removed_by uuid references public.employees(id) on delete restrict,
  removed_at timestamptz,
  constraint sygtasks_task_watchers_removal_check check (
    (removed_at is null and removed_by is null) or
    (removed_at is not null and removed_by is not null and removed_at >= added_at)
  )
);

create unique index sygtasks_task_watchers_active_unique
  on private.sygtasks_task_watchers(task_id, employee_id)
  where removed_at is null;
create index sygtasks_task_watchers_task_idx
  on private.sygtasks_task_watchers(task_id, added_at desc);
create index sygtasks_task_watchers_employee_idx
  on private.sygtasks_task_watchers(employee_id, task_id)
  where removed_at is null;
create index sygtasks_task_watchers_added_by_idx
  on private.sygtasks_task_watchers(added_by, added_at desc);
create index sygtasks_task_watchers_removed_by_idx
  on private.sygtasks_task_watchers(removed_by)
  where removed_by is not null;

create table private.sygtasks_labels (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references private.sygtasks_boards(id) on delete restrict,
  name text not null,
  color text not null default '#C9962F',
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_by uuid not null references public.employees(id) on delete restrict,
  version integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_labels_name_check check (char_length(btrim(name)) between 1 and 50),
  constraint sygtasks_labels_color_check check (color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint sygtasks_labels_version_check check (version > 0)
);

create unique index sygtasks_labels_board_name_unique
  on private.sygtasks_labels(board_id, lower(name))
  where archived_at is null;
create index sygtasks_labels_board_idx
  on private.sygtasks_labels(board_id, name)
  where archived_at is null;
create index sygtasks_labels_created_by_idx
  on private.sygtasks_labels(created_by, created_at desc);
create index sygtasks_labels_updated_by_idx
  on private.sygtasks_labels(updated_by, updated_at desc);

create table private.sygtasks_task_labels (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  label_id uuid not null references private.sygtasks_labels(id) on delete restrict,
  added_by uuid not null references public.employees(id) on delete restrict,
  added_at timestamptz not null default clock_timestamp(),
  removed_by uuid references public.employees(id) on delete restrict,
  removed_at timestamptz,
  constraint sygtasks_task_labels_removal_check check (
    (removed_at is null and removed_by is null) or
    (removed_at is not null and removed_by is not null and removed_at >= added_at)
  )
);

create unique index sygtasks_task_labels_active_unique
  on private.sygtasks_task_labels(task_id, label_id)
  where removed_at is null;
create index sygtasks_task_labels_task_idx
  on private.sygtasks_task_labels(task_id, added_at desc);
create index sygtasks_task_labels_label_idx
  on private.sygtasks_task_labels(label_id, task_id)
  where removed_at is null;
create index sygtasks_task_labels_added_by_idx
  on private.sygtasks_task_labels(added_by, added_at desc);
create index sygtasks_task_labels_removed_by_idx
  on private.sygtasks_task_labels(removed_by)
  where removed_by is not null;

create table private.sygtasks_checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  title text not null,
  sort_rank bigint not null default 0,
  completed_by uuid references public.employees(id) on delete restrict,
  completed_at timestamptz,
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_by uuid not null references public.employees(id) on delete restrict,
  version integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_checklist_items_title_check check (char_length(btrim(title)) between 1 and 500),
  constraint sygtasks_checklist_items_rank_check check (sort_rank between -1000000000 and 1000000000),
  constraint sygtasks_checklist_items_version_check check (version > 0),
  constraint sygtasks_checklist_items_completion_check check ((completed_at is null) = (completed_by is null))
);

create index sygtasks_checklist_items_task_idx
  on private.sygtasks_checklist_items(task_id, sort_rank, created_at, id)
  where archived_at is null;
create index sygtasks_checklist_items_completed_by_idx
  on private.sygtasks_checklist_items(completed_by)
  where completed_by is not null;
create index sygtasks_checklist_items_created_by_idx
  on private.sygtasks_checklist_items(created_by, created_at desc);
create index sygtasks_checklist_items_updated_by_idx
  on private.sygtasks_checklist_items(updated_by, updated_at desc);

create table private.sygtasks_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  author_employee_id uuid not null references public.employees(id) on delete restrict,
  body text not null,
  version integer not null default 1,
  edited_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_comments_body_check check (char_length(btrim(body)) between 1 and 5000),
  constraint sygtasks_comments_version_check check (version > 0)
);

create index sygtasks_comments_task_idx
  on private.sygtasks_comments(task_id, created_at desc, id desc)
  where archived_at is null;
create index sygtasks_comments_author_idx
  on private.sygtasks_comments(author_employee_id, created_at desc);

create table private.sygtasks_dependencies (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  depends_on_task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  removed_by uuid references public.employees(id) on delete restrict,
  removed_at timestamptz,
  constraint sygtasks_dependencies_distinct_check check (task_id <> depends_on_task_id),
  constraint sygtasks_dependencies_removal_check check (
    (removed_at is null and removed_by is null) or
    (removed_at is not null and removed_by is not null and removed_at >= created_at)
  )
);

create unique index sygtasks_dependencies_active_unique
  on private.sygtasks_dependencies(task_id, depends_on_task_id)
  where removed_at is null;
create index sygtasks_dependencies_task_idx
  on private.sygtasks_dependencies(task_id, created_at desc);
create index sygtasks_dependencies_parent_idx
  on private.sygtasks_dependencies(depends_on_task_id, task_id)
  where removed_at is null;
create index sygtasks_dependencies_created_by_idx
  on private.sygtasks_dependencies(created_by, created_at desc);
create index sygtasks_dependencies_removed_by_idx
  on private.sygtasks_dependencies(removed_by)
  where removed_by is not null;

create table private.sygtasks_activity (
  id bigint generated always as identity primary key,
  board_id uuid not null references private.sygtasks_boards(id) on delete restrict,
  task_id uuid references private.sygtasks_tasks(id) on delete restrict,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  client_request_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_activity_action_check check (char_length(btrim(action)) between 3 and 80),
  constraint sygtasks_activity_entity_type_check check (entity_type in ('board', 'membership', 'task', 'assignee', 'watcher', 'label', 'task_label', 'checklist', 'comment', 'dependency')),
  constraint sygtasks_activity_details_size_check check (octet_length(details::text) <= 65536)
);

create index sygtasks_activity_board_idx
  on private.sygtasks_activity(board_id, id desc);
create index sygtasks_activity_task_idx
  on private.sygtasks_activity(task_id, id desc)
  where task_id is not null;
create index sygtasks_activity_actor_idx
  on private.sygtasks_activity(actor_employee_id, id desc);
create index sygtasks_activity_request_idx
  on private.sygtasks_activity(client_request_id, id);

create table private.sygtasks_action_requests (
  id bigint generated always as identity primary key,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  client_request_id uuid not null,
  action text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_action_requests_action_check check (char_length(btrim(action)) between 3 and 80),
  constraint sygtasks_action_requests_hash_check check (request_hash ~ '^[0-9a-f]{32}$'),
  constraint sygtasks_action_requests_response_size_check check (octet_length(response::text) <= 65536),
  constraint sygtasks_action_requests_actor_request_unique unique (actor_employee_id, client_request_id)
);

create index sygtasks_action_requests_actor_idx
  on private.sygtasks_action_requests(actor_employee_id, created_at desc);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'sygtasks_boards',
    'sygtasks_board_memberships',
    'sygtasks_tasks',
    'sygtasks_task_assignees',
    'sygtasks_task_watchers',
    'sygtasks_labels',
    'sygtasks_task_labels',
    'sygtasks_checklist_items',
    'sygtasks_comments',
    'sygtasks_dependencies',
    'sygtasks_activity',
    'sygtasks_action_requests'
  ]
  loop
    execute format('alter table private.%I enable row level security', table_name);
    execute format('alter table private.%I force row level security', table_name);
    execute format('revoke all on table private.%I from public, anon, authenticated', table_name);
  end loop;
end
$$;

create function private.prevent_sygtasks_append_only_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise check_violation using message = 'SygTasks audit history is append-only.';
end
$$;

create trigger sygtasks_activity_append_only
before update or delete on private.sygtasks_activity
for each row execute function private.prevent_sygtasks_append_only_change();

create trigger sygtasks_action_requests_append_only
before update or delete on private.sygtasks_action_requests
for each row execute function private.prevent_sygtasks_append_only_change();

create function private.sygtasks_has_permission(
  target_employee_id uuid,
  target_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    target_employee_id is not null
    and target_permission = any(private.employee_effective_permissions(target_employee_id)),
    false
  )
$$;

create function private.sygtasks_can_view_board(
  target_employee_id uuid,
  target_board_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from private.sygtasks_boards board
    where board.id = target_board_id
      and (
        board.owner_employee_id = target_employee_id
        or private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
        or (
          board.scope = 'company'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
        )
        or (
          board.scope = 'team'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
          and (
            exists (
              select 1
              from private.sygtasks_board_memberships membership
              where membership.board_id = board.id
                and membership.employee_id = target_employee_id
                and membership.removed_at is null
            )
            or exists (
              select 1
              from private.sygtasks_tasks task
              join private.sygtasks_task_assignees assignee
                on assignee.task_id = task.id
               and assignee.employee_id = target_employee_id
               and assignee.removed_at is null
              where task.board_id = board.id
                and task.archived_at is null
            )
            or exists (
              select 1
              from private.sygtasks_tasks task
              join private.sygtasks_task_watchers watcher
                on watcher.task_id = task.id
               and watcher.employee_id = target_employee_id
               and watcher.removed_at is null
              where task.board_id = board.id
                and task.archived_at is null
            )
          )
        )
      )
  ), false)
$$;

create function private.sygtasks_can_view_task(
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
      and (
        board.owner_employee_id = target_employee_id
        or private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
        or (
          board.scope = 'company'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
        )
        or (
          board.scope = 'team'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
          and (
            exists (
              select 1
              from private.sygtasks_board_memberships membership
              where membership.board_id = board.id
                and membership.employee_id = target_employee_id
                and membership.removed_at is null
            )
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
          )
        )
      )
  ), false)
$$;

create function private.sygtasks_can_edit_board_tasks(
  target_employee_id uuid,
  target_board_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from private.sygtasks_boards board
    where board.id = target_board_id
      and (
        private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
        or (board.scope = 'personal' and board.owner_employee_id = target_employee_id)
        or (
          board.scope = 'team'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
          and exists (
            select 1
            from private.sygtasks_board_memberships membership
            where membership.board_id = board.id
              and membership.employee_id = target_employee_id
              and membership.member_role in ('owner', 'editor', 'member')
              and membership.removed_at is null
          )
        )
      )
  ), false)
$$;

create function private.sygtasks_can_update_task_status(
  target_employee_id uuid,
  target_task_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.sygtasks_can_edit_board_tasks(
      target_employee_id,
      (select task.board_id from private.sygtasks_tasks task where task.id = target_task_id)
    )
    or exists (
      select 1
      from private.sygtasks_task_assignees assignee
      where assignee.task_id = target_task_id
        and assignee.employee_id = target_employee_id
        and assignee.removed_at is null
    ),
    false
  )
$$;

create function private.sygtasks_record_activity(
  target_actor_employee_id uuid,
  target_board_id uuid,
  target_task_id uuid,
  target_action text,
  target_entity_type text,
  target_entity_id uuid,
  target_details jsonb,
  target_client_request_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_activity_id bigint;
begin
  insert into private.sygtasks_activity (
    board_id,
    task_id,
    actor_employee_id,
    action,
    entity_type,
    entity_id,
    details,
    client_request_id
  )
  values (
    target_board_id,
    target_task_id,
    target_actor_employee_id,
    left(btrim(target_action), 80),
    target_entity_type,
    target_entity_id,
    coalesce(target_details, '{}'::jsonb),
    target_client_request_id
  )
  returning id into created_activity_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  )
  values (
    (select auth.uid()),
    target_actor_employee_id,
    target_client_request_id::text,
    'private',
    'sygtasks_' || target_entity_type,
    upper(replace(target_action, '.', '_')),
    target_entity_id::text,
    coalesce(target_details, '{}'::jsonb)
  );

  return created_activity_id;
end
$$;

create function private.sygtasks_signal_scope(
  target_board_id uuid,
  target_task_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare recipient record;
begin
  for recipient in
    with board_record as (
      select board.id, board.scope, board.owner_employee_id
      from private.sygtasks_boards board
      where board.id = target_board_id
    ),
    recipients as (
      select board.owner_employee_id as employee_id from board_record board
      union
      select membership.employee_id
      from private.sygtasks_board_memberships membership
      where membership.board_id = target_board_id
        and membership.removed_at is null
      union
      select assignee.employee_id
      from private.sygtasks_task_assignees assignee
      join private.sygtasks_tasks task on task.id = assignee.task_id
      where task.board_id = target_board_id
        and (target_task_id is null or task.id = target_task_id)
        and assignee.removed_at is null
      union
      select watcher.employee_id
      from private.sygtasks_task_watchers watcher
      join private.sygtasks_tasks task on task.id = watcher.task_id
      where task.board_id = target_board_id
        and (target_task_id is null or task.id = target_task_id)
        and watcher.removed_at is null
      union
      select employee.id
      from public.employees employee
      where employee.status = 'active'
        and private.sygtasks_has_permission(employee.id, 'tasks.manage')
      union
      select employee.id
      from board_record board
      join public.employees employee on employee.status = 'active'
      where board.scope = 'company'
        and (
          private.sygtasks_has_permission(employee.id, 'tasks.view')
          or private.sygtasks_has_permission(employee.id, 'tasks.manage')
        )
    )
    select distinct employee.id
    from recipients recipient_scope
    join public.employees employee on employee.id = recipient_scope.employee_id
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and account.disabled_at is null
  loop
    perform private.signal_employee_update(
      recipient.id,
      jsonb_build_object(
        'kind', 'sygtasks',
        'boardId', target_board_id,
        'taskId', target_task_id
      )
    );
  end loop;
end
$$;

create function private.sygtasks_notify(
  target_recipient_employee_id uuid,
  target_actor_employee_id uuid,
  target_client_request_id uuid,
  target_board_id uuid,
  target_task_id uuid,
  target_title text,
  target_body text,
  target_priority text default 'routine'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare created_notification_id uuid;
begin
  if target_recipient_employee_id is null
     or target_recipient_employee_id = target_actor_employee_id
     or not exists (
       select 1
       from public.employees employee
       join private.employee_accounts account on account.employee_id = employee.id
       where employee.id = target_recipient_employee_id
         and employee.status = 'active'
         and account.disabled_at is null
     )
  then
    return null;
  end if;

  created_notification_id := private.create_employee_notification(
    target_recipient_employee_id,
    'sygtasks',
    coalesce(target_task_id, target_board_id),
    concat('sygtasks:', target_actor_employee_id, ':', target_client_request_id, ':', target_recipient_employee_id),
    left(btrim(target_title), 200),
    left(btrim(target_body), 5000),
    case when target_priority in ('routine', 'important', 'urgent') then target_priority else 'routine' end,
    false,
    concat(
      '/tasks?board=', target_board_id,
      case when target_task_id is null then '' else concat('&task=', target_task_id) end
    ),
    case when target_task_id is null then 'Open board' else 'Open task' end,
    target_actor_employee_id
  );

  return created_notification_id;
end
$$;

create function private.sygtasks_task_json(
  target_task_id uuid,
  target_employee_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', task.id,
    'boardId', task.board_id,
    'title', task.title,
    'description', task.description,
    'status', task.status,
    'priority', task.priority,
    'dueAt', task.due_at,
    'sortRank', task.sort_rank,
    'createdBy', task.created_by,
    'updatedBy', task.updated_by,
    'version', task.version,
    'completedAt', task.completed_at,
    'archivedAt', task.archived_at,
    'createdAt', task.created_at,
    'updatedAt', task.updated_at,
    'canEdit', private.sygtasks_can_edit_board_tasks(target_employee_id, task.board_id),
    'canUpdateStatus', private.sygtasks_can_update_task_status(target_employee_id, task.id),
    'watching', exists (
      select 1 from private.sygtasks_task_watchers watcher
      where watcher.task_id = task.id
        and watcher.employee_id = target_employee_id
        and watcher.removed_at is null
    ),
    'assignees', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', employee.id,
          'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
          'username', employee.username,
          'assignedAt', assignee.assigned_at
        ) order by employee.first_name, employee.last_name, employee.id
      )
      from private.sygtasks_task_assignees assignee
      join public.employees employee on employee.id = assignee.employee_id
      where assignee.task_id = task.id
        and assignee.removed_at is null
    ), '[]'::jsonb),
    'labels', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', label.id, 'name', label.name, 'color', label.color)
        order by label.name, label.id
      )
      from private.sygtasks_task_labels task_label
      join private.sygtasks_labels label on label.id = task_label.label_id
      where task_label.task_id = task.id
        and task_label.removed_at is null
        and label.archived_at is null
    ), '[]'::jsonb),
    'checklist', jsonb_build_object(
      'total', (select count(*) from private.sygtasks_checklist_items item where item.task_id = task.id and item.archived_at is null),
      'completed', (select count(*) from private.sygtasks_checklist_items item where item.task_id = task.id and item.archived_at is null and item.completed_at is not null)
    ),
    'watcherCount', (select count(*) from private.sygtasks_task_watchers watcher where watcher.task_id = task.id and watcher.removed_at is null),
    'commentCount', (select count(*) from private.sygtasks_comments comment where comment.task_id = task.id and comment.archived_at is null),
    'dependencyCount', (select count(*) from private.sygtasks_dependencies dependency where dependency.task_id = task.id and dependency.removed_at is null)
  )
  from private.sygtasks_tasks task
  where task.id = target_task_id
$$;

create function private.sygtasks_task_detail_json(
  target_task_id uuid,
  target_employee_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.sygtasks_task_json(target_task_id, target_employee_id) || jsonb_build_object(
    'watchers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', employee.id,
          'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
          'username', employee.username,
          'addedAt', watcher.added_at
        ) order by employee.first_name, employee.last_name, employee.id
      )
      from private.sygtasks_task_watchers watcher
      join public.employees employee on employee.id = watcher.employee_id
      where watcher.task_id = target_task_id
        and watcher.removed_at is null
    ), '[]'::jsonb),
    'checklistItems', coalesce((
      select jsonb_agg(item_row.payload order by item_row.sort_rank, item_row.created_at, item_row.id)
      from (
        select
          item.id,
          item.sort_rank,
          item.created_at,
          jsonb_build_object(
            'id', item.id,
            'title', item.title,
            'sortRank', item.sort_rank,
            'completedBy', item.completed_by,
            'completedAt', item.completed_at,
            'version', item.version,
            'createdAt', item.created_at,
            'updatedAt', item.updated_at
          ) as payload
        from private.sygtasks_checklist_items item
        where item.task_id = target_task_id
          and item.archived_at is null
        order by item.sort_rank, item.created_at, item.id
        limit 200
      ) item_row
    ), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(comment_row.payload order by comment_row.created_at)
      from (
        select
          comment.created_at,
          jsonb_build_object(
            'id', comment.id,
            'authorId', comment.author_employee_id,
            'authorName', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
            'body', comment.body,
            'version', comment.version,
            'editedAt', comment.edited_at,
            'createdAt', comment.created_at,
            'updatedAt', comment.updated_at,
            'canEdit', comment.author_employee_id = target_employee_id or private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
          ) as payload
        from private.sygtasks_comments comment
        join public.employees employee on employee.id = comment.author_employee_id
        where comment.task_id = target_task_id
          and comment.archived_at is null
        order by comment.created_at desc, comment.id desc
        limit 50
      ) comment_row
    ), '[]'::jsonb),
    'dependencies', coalesce((
      select jsonb_agg(dependency_row.payload order by dependency_row.title, dependency_row.task_id)
      from (
        select
          parent_task.id as task_id,
          parent_task.title,
          jsonb_build_object(
            'id', dependency.id,
            'taskId', parent_task.id,
            'title', parent_task.title,
            'status', parent_task.status,
            'dueAt', parent_task.due_at
          ) as payload
        from private.sygtasks_dependencies dependency
        join private.sygtasks_tasks parent_task on parent_task.id = dependency.depends_on_task_id
        where dependency.task_id = target_task_id
          and dependency.removed_at is null
        order by parent_task.title, parent_task.id
        limit 100
      ) dependency_row
    ), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(activity_row.payload order by activity_row.id desc)
      from (
        select
          activity.id,
          jsonb_build_object(
            'id', activity.id,
            'action', activity.action,
            'entityType', activity.entity_type,
            'entityId', activity.entity_id,
            'details', activity.details,
            'actorId', activity.actor_employee_id,
            'actorName', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
            'createdAt', activity.created_at
          ) as payload
        from private.sygtasks_activity activity
        join public.employees employee on employee.id = activity.actor_employee_id
        where activity.task_id = target_task_id
        order by activity.id desc
        limit 50
      ) activity_row
    ), '[]'::jsonb)
  )
$$;

create function public.get_sygtasks_workspace(
  target_board_id uuid default null,
  target_task_id uuid default null,
  target_cursor_updated_at timestamptz default null,
  target_cursor_task_id uuid default null,
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
  selected_board_id uuid := target_board_id;
  selected_task_board_id uuid;
  page_size integer;
  board_payload jsonb := '[]'::jsonb;
  selected_board_payload jsonb;
  task_payload jsonb := '[]'::jsonb;
  my_task_payload jsonb := '[]'::jsonb;
  detail_payload jsonb;
  label_payload jsonb := '[]'::jsonb;
  member_payload jsonb := '[]'::jsonb;
  available_member_payload jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor_updated_at timestamptz;
  next_cursor_task_id uuid;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if target_page_size not in (5, 10, 20, 50) then
    raise check_violation using message = 'Choose 5, 10, 20, or 50 tasks per page.';
  end if;
  page_size := target_page_size;

  if (target_cursor_updated_at is null) <> (target_cursor_task_id is null) then
    raise check_violation using message = 'The task cursor is incomplete.';
  end if;

  if target_task_id is not null then
    select task.board_id into selected_task_board_id
    from private.sygtasks_tasks task
    where task.id = target_task_id;

    if selected_task_board_id is null
       or not private.sygtasks_can_view_task(actor_id, target_task_id)
    then
      raise insufficient_privilege using message = 'This task is not available to your account.';
    end if;

    if selected_board_id is null then
      selected_board_id := selected_task_board_id;
    elsif selected_board_id <> selected_task_board_id then
      raise check_violation using message = 'The selected task does not belong to this board.';
    end if;

  end if;

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
    where (target_include_archived or board.archived_at is null)
      and private.sygtasks_can_view_board(actor_id, board.id)
    order by board.updated_at desc, board.id desc
    limit 100
  ) board_row;

  if selected_board_id is null then
    select board.id into selected_board_id
    from private.sygtasks_boards board
    where (target_include_archived or board.archived_at is null)
      and private.sygtasks_can_view_board(actor_id, board.id)
    order by
      case when board.scope = 'personal' and board.owner_employee_id = actor_id then 0 else 1 end,
      board.updated_at desc,
      board.id desc
    limit 1;
  end if;

  if selected_board_id is not null
     and not private.sygtasks_can_view_board(actor_id, selected_board_id)
  then
    raise insufficient_privilege using message = 'This board is not available to your account.';
  end if;

  if selected_board_id is not null then
    select jsonb_build_object(
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
      'canManageBoard', private.sygtasks_has_permission(actor_id, 'tasks.manage')
        or (board.scope = 'personal' and board.owner_employee_id = actor_id),
      'canCreateTask', private.sygtasks_can_edit_board_tasks(actor_id, board.id)
    )
    into selected_board_payload
    from private.sygtasks_boards board
    join public.employees owner on owner.id = board.owner_employee_id
    where board.id = selected_board_id;

    with candidate_tasks as (
      select task.id, task.updated_at
      from private.sygtasks_tasks task
      where task.board_id = selected_board_id
        and (target_include_archived or task.archived_at is null)
        and private.sygtasks_can_view_task(actor_id, task.id)
        and (
          target_cursor_updated_at is null
          or (task.updated_at, task.id) < (target_cursor_updated_at, target_cursor_task_id)
        )
      order by task.updated_at desc, task.id desc
      limit page_size + 1
    ),
    page_tasks as (
      select candidate.id, candidate.updated_at
      from candidate_tasks candidate
      order by candidate.updated_at desc, candidate.id desc
      limit page_size
    )
    select
      coalesce(jsonb_agg(private.sygtasks_task_json(page_task.id, actor_id) order by page_task.updated_at desc, page_task.id desc), '[]'::jsonb),
      (select count(*) > page_size from candidate_tasks),
      (select page_task.updated_at from page_tasks page_task order by page_task.updated_at, page_task.id limit 1),
      (select page_task.id from page_tasks page_task order by page_task.updated_at, page_task.id limit 1)
    into task_payload, has_more, next_cursor_updated_at, next_cursor_task_id
    from page_tasks page_task;

    select coalesce(jsonb_agg(label_row.payload order by label_row.name, label_row.id), '[]'::jsonb)
    into label_payload
    from (
      select
        label.id,
        label.name,
        jsonb_build_object(
          'id', label.id,
          'name', label.name,
          'color', label.color,
          'version', label.version
        ) as payload
      from private.sygtasks_labels label
      where label.board_id = selected_board_id
        and label.archived_at is null
      order by label.name, label.id
      limit 100
    ) label_row;

    select coalesce(jsonb_agg(member_row.payload order by member_row.name, member_row.employee_id), '[]'::jsonb)
    into member_payload
    from (
      select
        employee.id as employee_id,
        concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name) as name,
        jsonb_build_object(
          'membershipId', membership.id,
          'employeeId', employee.id,
          'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
          'username', employee.username,
          'role', membership.member_role,
          'addedAt', membership.added_at
        ) as payload
      from private.sygtasks_board_memberships membership
      join public.employees employee on employee.id = membership.employee_id
      where membership.board_id = selected_board_id
        and membership.removed_at is null
      order by employee.first_name, employee.last_name, employee.id
      limit 200
    ) member_row;

    if private.sygtasks_has_permission(actor_id, 'tasks.manage') then
      select coalesce(jsonb_agg(employee_row.payload order by employee_row.name, employee_row.employee_id), '[]'::jsonb)
      into available_member_payload
      from (
        select
          employee.id as employee_id,
          concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name) as name,
          jsonb_build_object(
            'employeeId', employee.id,
            'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
            'username', employee.username,
            'isMember', membership.id is not null,
            'membershipId', membership.id,
            'role', membership.member_role
          ) as payload
        from public.employees employee
        join private.employee_accounts account
          on account.employee_id = employee.id
         and account.disabled_at is null
        left join private.sygtasks_board_memberships membership
          on membership.board_id = selected_board_id
         and membership.employee_id = employee.id
         and membership.removed_at is null
        where employee.status = 'active'
          and (
            private.sygtasks_has_permission(employee.id, 'tasks.view')
            or private.sygtasks_has_permission(employee.id, 'tasks.manage')
          )
        order by employee.first_name, employee.last_name, employee.id
        limit 200
      ) employee_row;
    end if;
  end if;

  select coalesce(jsonb_agg(my_task_row.payload order by my_task_row.updated_at desc, my_task_row.id desc), '[]'::jsonb)
  into my_task_payload
  from (
    select
      task.id,
      task.updated_at,
      private.sygtasks_task_json(task.id, actor_id) || jsonb_build_object('boardName', board.name) as payload
    from private.sygtasks_tasks task
    join private.sygtasks_boards board on board.id = task.board_id
    where task.archived_at is null
      and board.archived_at is null
      and task.status not in ('done', 'canceled')
      and private.sygtasks_can_view_task(actor_id, task.id)
      and (
        task.created_by = actor_id
        or board.owner_employee_id = actor_id
        or exists (
          select 1 from private.sygtasks_task_assignees assignee
          where assignee.task_id = task.id
            and assignee.employee_id = actor_id
            and assignee.removed_at is null
        )
        or exists (
          select 1 from private.sygtasks_task_watchers watcher
          where watcher.task_id = task.id
            and watcher.employee_id = actor_id
            and watcher.removed_at is null
        )
      )
    order by task.updated_at desc, task.id desc
    limit 50
  ) my_task_row;

  if target_task_id is not null then
    detail_payload := private.sygtasks_task_detail_json(target_task_id, actor_id);
  end if;

  return jsonb_build_object(
    'employeeId', actor_id,
    'permissions', jsonb_build_object(
      'viewShared', private.sygtasks_has_permission(actor_id, 'tasks.view'),
      'manageShared', private.sygtasks_has_permission(actor_id, 'tasks.manage')
    ),
    'boards', board_payload,
    'selectedBoard', selected_board_payload,
    'tasks', task_payload,
    'myTasks', my_task_payload,
    'labels', label_payload,
    'members', member_payload,
    'availableMembers', available_member_payload,
    'taskDetail', detail_payload,
    'page', jsonb_build_object(
      'size', page_size,
      'hasMore', has_more,
      'nextCursor', case
        when has_more then jsonb_build_object('updatedAt', next_cursor_updated_at, 'taskId', next_cursor_task_id)
        else null
      end
    )
  );
end
$$;

create function public.mutate_sygtasks(
  target_action text,
  target_payload jsonb,
  target_client_request_id uuid,
  target_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  actor_id uuid := private.current_employee_id();
  clean_action text := lower(btrim(coalesce(target_action, '')));
  clean_payload jsonb := coalesce(target_payload, '{}'::jsonb);
  request_fingerprint text;
  prior_request private.sygtasks_action_requests%rowtype;
  board_id uuid;
  task_id uuid;
  target_employee_id uuid;
  label_id uuid;
  checklist_id uuid;
  comment_id uuid;
  dependency_task_id uuid;
  relationship_id uuid;
  board_record private.sygtasks_boards%rowtype;
  task_record private.sygtasks_tasks%rowtype;
  label_record private.sygtasks_labels%rowtype;
  checklist_record private.sygtasks_checklist_items%rowtype;
  comment_record private.sygtasks_comments%rowtype;
  relationship_record record;
  before_record jsonb;
  after_record jsonb;
  result jsonb := '{}'::jsonb;
  changed boolean := false;
  affected_recipient record;
  clean_scope text;
  clean_role text;
  clean_status text;
  clean_priority text;
  clean_title text;
  clean_body text;
  allowed_payload_keys text[];
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if clean_action not in (
    'create_board', 'update_board', 'archive_board',
    'add_board_member', 'remove_board_member',
    'create_task', 'update_task', 'archive_task',
    'assign_task', 'unassign_task', 'watch_task', 'unwatch_task',
    'create_label', 'update_label', 'apply_label', 'remove_label',
    'add_checklist_item', 'update_checklist_item', 'archive_checklist_item',
    'add_comment', 'edit_comment', 'archive_comment',
    'add_dependency', 'remove_dependency'
  ) then
    raise check_violation using message = 'Choose a valid SygTasks action.';
  end if;

  if target_client_request_id is null then
    raise check_violation using message = 'A client request identifier is required.';
  end if;

  if jsonb_typeof(clean_payload) <> 'object'
     or octet_length(clean_payload::text) > 65536
  then
    raise check_violation using message = 'The SygTasks request is too large or malformed.';
  end if;

  allowed_payload_keys := case clean_action
    when 'create_board' then array['name', 'description', 'scope']
    when 'update_board' then array['boardId', 'name', 'description']
    when 'archive_board' then array['boardId']
    when 'add_board_member' then array['boardId', 'employeeId', 'memberRole']
    when 'remove_board_member' then array['boardId', 'employeeId']
    when 'create_task' then array['boardId', 'title', 'description', 'status', 'priority', 'dueAt', 'sortRank']
    when 'update_task' then array['taskId', 'title', 'description', 'status', 'priority', 'dueAt', 'sortRank']
    when 'archive_task' then array['taskId']
    when 'assign_task' then array['taskId', 'employeeId']
    when 'unassign_task' then array['taskId', 'employeeId']
    when 'watch_task' then array['taskId']
    when 'unwatch_task' then array['taskId']
    when 'create_label' then array['boardId', 'name', 'color']
    when 'update_label' then array['labelId', 'name', 'color']
    when 'apply_label' then array['taskId', 'labelId']
    when 'remove_label' then array['taskId', 'labelId']
    when 'add_checklist_item' then array['taskId', 'title', 'sortRank']
    when 'update_checklist_item' then array['checklistItemId', 'title', 'sortRank', 'completed']
    when 'archive_checklist_item' then array['checklistItemId']
    when 'add_comment' then array['taskId', 'body']
    when 'edit_comment' then array['commentId', 'body']
    when 'archive_comment' then array['commentId']
    when 'add_dependency' then array['taskId', 'dependsOnTaskId']
    when 'remove_dependency' then array['taskId', 'dependsOnTaskId']
  end;

  if clean_payload - allowed_payload_keys <> '{}'::jsonb then
    raise check_violation using message = 'This SygTasks action contains unsupported fields.';
  end if;

  if target_expected_version is not null and target_expected_version < 1 then
    raise check_violation using message = 'The expected version must be positive.';
  end if;

  request_fingerprint := md5(
    clean_action || '|' || clean_payload::text || '|' || coalesce(target_expected_version::text, '')
  );

  perform pg_advisory_xact_lock(
    hashtextextended(concat('sygtasks:', actor_id, ':', target_client_request_id), 0)
  );

  select request.* into prior_request
  from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id
    and request.client_request_id = target_client_request_id;

  if prior_request.id is not null then
    if prior_request.action <> clean_action
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

  if clean_action = 'create_board' then
    clean_scope := lower(btrim(coalesce(clean_payload->>'scope', 'personal')));
    clean_title := btrim(coalesce(clean_payload->>'name', ''));

    if clean_scope not in ('personal', 'team', 'company') then
      raise check_violation using message = 'Choose a personal, team, or company board.';
    end if;
    if char_length(clean_title) not between 2 and 120 then
      raise check_violation using message = 'Board names must be between 2 and 120 characters.';
    end if;
    if char_length(coalesce(clean_payload->>'description', '')) > 2000 then
      raise check_violation using message = 'Board descriptions are limited to 2,000 characters.';
    end if;
    if clean_scope <> 'personal'
       and not private.sygtasks_has_permission(actor_id, 'tasks.manage')
    then
      raise insufficient_privilege using message = 'Shared boards require SygTasks management access.';
    end if;
    if (
      select count(*)
      from private.sygtasks_boards board
      where board.created_by = actor_id
        and board.archived_at is null
    ) >= 250 then
      raise check_violation using message = 'Archive an unused board before creating another.';
    end if;

    insert into private.sygtasks_boards (
      name, description, scope, owner_employee_id, created_by, updated_by
    )
    values (
      clean_title,
      btrim(coalesce(clean_payload->>'description', '')),
      clean_scope,
      actor_id,
      actor_id,
      actor_id
    )
    returning * into board_record;

    board_id := board_record.id;
    insert into private.sygtasks_board_memberships (
      board_id, employee_id, member_role, added_by
    )
    values (board_id, actor_id, 'owner', actor_id)
    returning id into relationship_id;

    perform private.sygtasks_record_activity(
      actor_id, board_id, null, 'board.created', 'board', board_id,
      jsonb_build_object('after', to_jsonb(board_record)), target_client_request_id
    );
    changed := true;
    result := jsonb_build_object('boardId', board_id, 'version', board_record.version);

  elsif clean_action in ('update_board', 'archive_board') then
    board_id := nullif(clean_payload->>'boardId', '')::uuid;
    if board_id is null then
      raise check_violation using message = 'Choose a board.';
    end if;

    select board.* into board_record
    from private.sygtasks_boards board
    where board.id = board_id
    for update;
    if board_record.id is null then
      raise check_violation using message = 'This board is no longer available.';
    end if;
    if board_record.archived_at is not null then
      raise check_violation using message = 'This board is already archived.';
    end if;
    if not (
      private.sygtasks_has_permission(actor_id, 'tasks.manage')
      or (board_record.scope = 'personal' and board_record.owner_employee_id = actor_id)
    ) then
      raise insufficient_privilege using message = 'You cannot change this board.';
    end if;
    if target_expected_version is null then
      raise check_violation using message = 'Refresh this board before changing it.';
    end if;

    before_record := to_jsonb(board_record);
    if clean_action = 'update_board' then
      if not (clean_payload ? 'name' or clean_payload ? 'description') then
        raise check_violation using message = 'Choose a board detail to update.';
      end if;
      clean_title := case
        when clean_payload ? 'name' then btrim(coalesce(clean_payload->>'name', ''))
        else board_record.name
      end;
      if char_length(clean_title) not between 2 and 120 then
        raise check_violation using message = 'Board names must be between 2 and 120 characters.';
      end if;
      if char_length(case when clean_payload ? 'description' then coalesce(clean_payload->>'description', '') else board_record.description end) > 2000 then
        raise check_violation using message = 'Board descriptions are limited to 2,000 characters.';
      end if;
      update private.sygtasks_boards board
      set name = clean_title,
          description = case when clean_payload ? 'description' then btrim(coalesce(clean_payload->>'description', '')) else board.description end,
          updated_by = actor_id,
          updated_at = clock_timestamp(),
          version = board.version + 1
      where board.id = board_id
        and board.version = target_expected_version
      returning * into board_record;
    else
      update private.sygtasks_boards board
      set archived_at = coalesce(board.archived_at, clock_timestamp()),
          updated_by = actor_id,
          updated_at = clock_timestamp(),
          version = board.version + 1
      where board.id = board_id
        and board.version = target_expected_version
      returning * into board_record;
    end if;

    if board_record.id is null then
      raise serialization_failure using message = 'This board changed. Refresh it and try again.';
    end if;
    after_record := to_jsonb(board_record);
    perform private.sygtasks_record_activity(
      actor_id, board_id, null,
      case when clean_action = 'update_board' then 'board.updated' else 'board.archived' end,
      'board', board_id,
      jsonb_build_object('before', before_record, 'after', after_record),
      target_client_request_id
    );
    changed := before_record is distinct from after_record;
    result := jsonb_build_object('boardId', board_id, 'version', board_record.version);

  elsif clean_action in ('add_board_member', 'remove_board_member') then
    board_id := nullif(clean_payload->>'boardId', '')::uuid;
    target_employee_id := nullif(clean_payload->>'employeeId', '')::uuid;
    if board_id is null or target_employee_id is null then
      raise check_violation using message = 'Choose a board and employee.';
    end if;

    select board.* into board_record
    from private.sygtasks_boards board
    where board.id = board_id
    for update;
    if board_record.id is null or board_record.archived_at is not null then
      raise check_violation using message = 'This active board is no longer available.';
    end if;
    if board_record.scope = 'personal' then
      raise check_violation using message = 'Personal boards cannot have additional members.';
    end if;
    if not private.sygtasks_has_permission(actor_id, 'tasks.manage') then
      raise insufficient_privilege using message = 'Board membership requires SygTasks management access.';
    end if;

    if clean_action = 'add_board_member' then
      clean_role := lower(btrim(coalesce(clean_payload->>'memberRole', 'member')));
      if clean_role not in ('owner', 'editor', 'member', 'viewer') then
        raise check_violation using message = 'Choose a valid board member role.';
      end if;
      if not exists (
        select 1
        from public.employees employee
        join private.employee_accounts account on account.employee_id = employee.id
        where employee.id = target_employee_id
          and employee.status = 'active'
          and account.disabled_at is null
          and (
            private.sygtasks_has_permission(employee.id, 'tasks.view')
            or private.sygtasks_has_permission(employee.id, 'tasks.manage')
          )
      ) then
        raise check_violation using message = 'Choose an active employee with SygTasks access.';
      end if;
      if exists (
        select 1 from private.sygtasks_board_memberships membership
        where membership.board_id = board_id
          and membership.employee_id = target_employee_id
          and membership.removed_at is null
      ) then
        result := jsonb_build_object('boardId', board_id,'changed',false);
      else
        if (
          select count(*) from private.sygtasks_board_memberships membership
          where membership.board_id = board_id and membership.removed_at is null
        ) >= 200 then
          raise check_violation using message = 'Boards support up to 200 active members.';
        end if;
        insert into private.sygtasks_board_memberships (
          board_id, employee_id, member_role, added_by
        ) values (board_id, target_employee_id, clean_role, actor_id)
        returning id into relationship_id;
        perform private.sygtasks_record_activity(
          actor_id, board_id, null, 'membership.added', 'membership', relationship_id,
          jsonb_build_object('employeeId', target_employee_id, 'role', clean_role),
          target_client_request_id
        );
        perform private.sygtasks_notify(
          target_employee_id, actor_id, target_client_request_id, board_id, null,
          'Added to a SygTasks board',
          concat('You were added to ', board_record.name, '.'),
          'routine'
        );
        changed := true;
        result := jsonb_build_object('boardId',board_id,'membershipId',relationship_id,'changed',true);
      end if;
    else
      if target_employee_id = board_record.owner_employee_id then
        raise check_violation using message = 'The board owner cannot be removed.';
      end if;
      select membership.id, membership.employee_id
      into relationship_record
      from private.sygtasks_board_memberships membership
      where membership.board_id = board_id
        and membership.employee_id = target_employee_id
        and membership.removed_at is null
      for update;
      if relationship_record.id is null then
        result := jsonb_build_object('boardId',board_id,'changed',false);
      else
        update private.sygtasks_board_memberships membership
        set removed_by = actor_id,
            removed_at = clock_timestamp()
        where membership.id = relationship_record.id;
        perform private.sygtasks_record_activity(
          actor_id, board_id, null, 'membership.removed', 'membership', relationship_record.id,
          jsonb_build_object('employeeId', target_employee_id),
          target_client_request_id
        );
        perform private.signal_employee_update(
          target_employee_id,
          jsonb_build_object('kind','sygtasks','boardId',board_id,'accessRemoved',true)
        );
        changed := true;
        result := jsonb_build_object('boardId',board_id,'changed',true);
      end if;
    end if;

  elsif clean_action = 'create_task' then
    board_id := nullif(clean_payload->>'boardId', '')::uuid;
    clean_title := btrim(coalesce(clean_payload->>'title', ''));
    clean_status := lower(btrim(coalesce(clean_payload->>'status', 'backlog')));
    clean_priority := lower(btrim(coalesce(clean_payload->>'priority', 'routine')));
    if board_id is null then raise check_violation using message = 'Choose a board.'; end if;

    select board.* into board_record
    from private.sygtasks_boards board
    where board.id = board_id
    for update;
    if board_record.id is null or board_record.archived_at is not null then
      raise check_violation using message = 'This active board is no longer available.';
    end if;
    if not private.sygtasks_can_edit_board_tasks(actor_id, board_id) then
      raise insufficient_privilege using message = 'You cannot create work on this board.';
    end if;
    if char_length(clean_title) not between 1 and 240 then
      raise check_violation using message = 'Task titles must be between 1 and 240 characters.';
    end if;
    if char_length(coalesce(clean_payload->>'description', '')) > 10000 then
      raise check_violation using message = 'Task descriptions are limited to 10,000 characters.';
    end if;
    if clean_status not in ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'canceled') then
      raise check_violation using message = 'Choose a valid task status.';
    end if;
    if clean_priority not in ('low', 'routine', 'high', 'urgent') then
      raise check_violation using message = 'Choose a valid task priority.';
    end if;
    if (
      select count(*) from private.sygtasks_tasks task
      where task.board_id = board_id and task.archived_at is null
    ) >= 5000 then
      raise check_violation using message = 'Archive completed work before adding more tasks to this board.';
    end if;

    insert into private.sygtasks_tasks (
      board_id, title, description, status, priority, due_at, sort_rank,
      created_by, updated_by, completed_at
    )
    values (
      board_id,
      clean_title,
      btrim(coalesce(clean_payload->>'description', '')),
      clean_status,
      clean_priority,
      nullif(clean_payload->>'dueAt', '')::timestamptz,
      coalesce(nullif(clean_payload->>'sortRank', '')::bigint, 0),
      actor_id,
      actor_id,
      case when clean_status = 'done' then clock_timestamp() else null end
    )
    returning * into task_record;
    task_id := task_record.id;
    perform private.sygtasks_record_activity(
      actor_id, board_id, task_id, 'task.created', 'task', task_id,
      jsonb_build_object('after', to_jsonb(task_record)), target_client_request_id
    );
    changed := true;
    result := jsonb_build_object('boardId',board_id,'taskId',task_id,'version',task_record.version);

  elsif clean_action in ('update_task', 'archive_task') then
    task_id := nullif(clean_payload->>'taskId', '')::uuid;
    if task_id is null then raise check_violation using message = 'Choose a task.'; end if;
    select task.* into task_record
    from private.sygtasks_tasks task
    where task.id = task_id
    for update;
    if task_record.id is null then raise check_violation using message = 'This task is no longer available.'; end if;
    if task_record.archived_at is not null then raise check_violation using message = 'This task is already archived.'; end if;
    board_id := task_record.board_id;
    select board.* into board_record from private.sygtasks_boards board where board.id = board_id;
    if target_expected_version is null then
      raise check_violation using message = 'Refresh this task before changing it.';
    end if;

    if clean_action = 'archive_task' then
      if not private.sygtasks_can_edit_board_tasks(actor_id, board_id) then
        raise insufficient_privilege using message = 'You cannot archive this task.';
      end if;
    elsif not private.sygtasks_can_update_task_status(actor_id, task_id) then
      raise insufficient_privilege using message = 'You cannot update this task.';
    elsif not private.sygtasks_can_edit_board_tasks(actor_id, board_id)
          and (clean_payload - array['taskId', 'status']::text[]) <> '{}'::jsonb
    then
      raise insufficient_privilege using message = 'Assignees may update task status; other task details require board editing access.';
    end if;

    before_record := to_jsonb(task_record);
    if clean_action = 'archive_task' then
      update private.sygtasks_tasks task
      set archived_at = coalesce(task.archived_at, clock_timestamp()),
          updated_by = actor_id,
          updated_at = clock_timestamp(),
          version = task.version + 1
      where task.id = task_id
        and task.version = target_expected_version
      returning * into task_record;
    else
      if not (
        clean_payload ? 'title'
        or clean_payload ? 'description'
        or clean_payload ? 'status'
        or clean_payload ? 'priority'
        or clean_payload ? 'dueAt'
        or clean_payload ? 'sortRank'
      ) then
        raise check_violation using message = 'Choose a task detail to update.';
      end if;
      clean_title := case when clean_payload ? 'title' then btrim(coalesce(clean_payload->>'title', '')) else task_record.title end;
      clean_status := case when clean_payload ? 'status' then lower(btrim(coalesce(clean_payload->>'status', ''))) else task_record.status end;
      clean_priority := case when clean_payload ? 'priority' then lower(btrim(coalesce(clean_payload->>'priority', ''))) else task_record.priority end;
      if char_length(clean_title) not between 1 and 240 then raise check_violation using message = 'Task titles must be between 1 and 240 characters.'; end if;
      if char_length(case when clean_payload ? 'description' then coalesce(clean_payload->>'description', '') else task_record.description end) > 10000 then
        raise check_violation using message = 'Task descriptions are limited to 10,000 characters.';
      end if;
      if clean_status not in ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'canceled') then raise check_violation using message = 'Choose a valid task status.'; end if;
      if clean_priority not in ('low', 'routine', 'high', 'urgent') then raise check_violation using message = 'Choose a valid task priority.'; end if;
      update private.sygtasks_tasks task
      set title = clean_title,
          description = case when clean_payload ? 'description' then btrim(coalesce(clean_payload->>'description', '')) else task.description end,
          status = clean_status,
          priority = clean_priority,
          due_at = case when clean_payload ? 'dueAt' then nullif(clean_payload->>'dueAt', '')::timestamptz else task.due_at end,
          sort_rank = case when clean_payload ? 'sortRank' then (clean_payload->>'sortRank')::bigint else task.sort_rank end,
          completed_at = case when clean_status = 'done' then coalesce(task.completed_at, clock_timestamp()) else null end,
          updated_by = actor_id,
          updated_at = clock_timestamp(),
          version = task.version + 1
      where task.id = task_id
        and task.version = target_expected_version
      returning * into task_record;
    end if;
    if task_record.id is null then
      raise serialization_failure using message = 'This task changed. Refresh it and try again.';
    end if;
    after_record := to_jsonb(task_record);
    perform private.sygtasks_record_activity(
      actor_id, board_id, task_id,
      case when clean_action = 'archive_task' then 'task.archived' else 'task.updated' end,
      'task', task_id,
      jsonb_build_object('before', before_record, 'after', after_record),
      target_client_request_id
    );
    changed := before_record is distinct from after_record;
    result := jsonb_build_object('boardId',board_id,'taskId',task_id,'version',task_record.version);

    if changed and clean_action = 'update_task' and (
      before_record->>'status' is distinct from after_record->>'status'
      or before_record->>'priority' is distinct from after_record->>'priority'
      or before_record->>'due_at' is distinct from after_record->>'due_at'
    ) then
      for affected_recipient in
        select distinct recipient_scope.employee_id
        from (
          select board_record.owner_employee_id as employee_id
          union
          select assignee.employee_id from private.sygtasks_task_assignees assignee
          where assignee.task_id = task_id and assignee.removed_at is null
          union
          select watcher.employee_id from private.sygtasks_task_watchers watcher
          where watcher.task_id = task_id and watcher.removed_at is null
        ) recipient_scope
        where recipient_scope.employee_id <> actor_id
      loop
        perform private.sygtasks_notify(
          affected_recipient.employee_id, actor_id, target_client_request_id, board_id, task_id,
          'SygTasks item updated',
          concat(task_record.title, ' is now ', replace(task_record.status, '_', ' '), '.'),
          case when task_record.priority = 'urgent' then 'urgent' when task_record.priority = 'high' then 'important' else 'routine' end
        );
      end loop;
    end if;

  elsif clean_action in ('assign_task', 'unassign_task') then
    task_id := nullif(clean_payload->>'taskId', '')::uuid;
    target_employee_id := nullif(clean_payload->>'employeeId', '')::uuid;
    if task_id is null or target_employee_id is null then
      raise check_violation using message = 'Choose a task and employee.';
    end if;
    select task.* into task_record
    from private.sygtasks_tasks task
    where task.id = task_id
    for update;
    if task_record.id is null or task_record.archived_at is not null then
      raise check_violation using message = 'This active task is no longer available.';
    end if;
    board_id := task_record.board_id;
    select board.* into board_record
    from private.sygtasks_boards board
    where board.id = board_id;

    if not private.sygtasks_has_permission(actor_id, 'tasks.manage')
       and not (
         target_employee_id = actor_id
         and private.sygtasks_can_update_task_status(actor_id, task_id)
       )
    then
      raise insufficient_privilege using message = 'Assigning another employee requires SygTasks management access.';
    end if;
    if board_record.scope = 'personal'
       and target_employee_id <> board_record.owner_employee_id
    then
      raise check_violation using message = 'Personal-board tasks can only be assigned to the board owner.';
    end if;

    if clean_action = 'assign_task' then
      if not exists (
        select 1
        from public.employees employee
        join private.employee_accounts account on account.employee_id = employee.id
        where employee.id = target_employee_id
          and employee.status = 'active'
          and account.disabled_at is null
          and (
            board_record.scope = 'personal'
            or private.sygtasks_has_permission(employee.id, 'tasks.view')
            or private.sygtasks_has_permission(employee.id, 'tasks.manage')
          )
      ) then
        raise check_violation using message = 'Choose an active employee with access to this board.';
      end if;
      if exists (
        select 1 from private.sygtasks_task_assignees assignee
        where assignee.task_id = task_id
          and assignee.employee_id = target_employee_id
          and assignee.removed_at is null
      ) then
        result := jsonb_build_object('boardId',board_id,'taskId',task_id,'changed',false);
      else
        if (
          select count(*) from private.sygtasks_task_assignees assignee
          where assignee.task_id = task_id and assignee.removed_at is null
        ) >= 100 then
          raise check_violation using message = 'Tasks support up to 100 active assignees.';
        end if;
        insert into private.sygtasks_task_assignees (task_id, employee_id, assigned_by)
        values (task_id, target_employee_id, actor_id)
        returning id into relationship_id;
        perform private.sygtasks_record_activity(
          actor_id, board_id, task_id, 'assignee.added', 'assignee', relationship_id,
          jsonb_build_object('employeeId', target_employee_id), target_client_request_id
        );
        perform private.sygtasks_notify(
          target_employee_id, actor_id, target_client_request_id, board_id, task_id,
          'New SygTasks assignment', concat('You were assigned: ', task_record.title),
          case when task_record.priority = 'urgent' then 'urgent' when task_record.priority = 'high' then 'important' else 'routine' end
        );
        changed := true;
        result := jsonb_build_object('boardId',board_id,'taskId',task_id,'assigneeId',relationship_id,'changed',true);
      end if;
    else
      select assignee.id into relationship_id
      from private.sygtasks_task_assignees assignee
      where assignee.task_id = task_id
        and assignee.employee_id = target_employee_id
        and assignee.removed_at is null
      for update;
      if relationship_id is null then
        result := jsonb_build_object('boardId',board_id,'taskId',task_id,'changed',false);
      else
        update private.sygtasks_task_assignees assignee
        set removed_by = actor_id, removed_at = clock_timestamp()
        where assignee.id = relationship_id;
        perform private.sygtasks_record_activity(
          actor_id, board_id, task_id, 'assignee.removed', 'assignee', relationship_id,
          jsonb_build_object('employeeId', target_employee_id), target_client_request_id
        );
        perform private.signal_employee_update(
          target_employee_id,
          jsonb_build_object('kind','sygtasks','boardId',board_id,'taskId',task_id,'assignmentRemoved',true)
        );
        changed := true;
        result := jsonb_build_object('boardId',board_id,'taskId',task_id,'changed',true);
      end if;
    end if;

  elsif clean_action in ('watch_task', 'unwatch_task') then
    task_id := nullif(clean_payload->>'taskId', '')::uuid;
    if task_id is null then raise check_violation using message = 'Choose a task.'; end if;
    select task.* into task_record
    from private.sygtasks_tasks task
    where task.id = task_id
    for update;
    if task_record.id is null
       or task_record.archived_at is not null
       or not private.sygtasks_can_view_task(actor_id, task_id)
    then
      raise insufficient_privilege using message = 'This task is not available to your account.';
    end if;
    board_id := task_record.board_id;

    if clean_action = 'watch_task' then
      select watcher.id into relationship_id
      from private.sygtasks_task_watchers watcher
      where watcher.task_id = task_id
        and watcher.employee_id = actor_id
        and watcher.removed_at is null;
      if relationship_id is null then
        if (
          select count(*) from private.sygtasks_task_watchers watcher
          where watcher.task_id = task_id and watcher.removed_at is null
        ) >= 200 then
          raise check_violation using message = 'This task has reached its watcher limit.';
        end if;
        insert into private.sygtasks_task_watchers (task_id, employee_id, added_by)
        values (task_id, actor_id, actor_id)
        returning id into relationship_id;
        perform private.sygtasks_record_activity(
          actor_id, board_id, task_id, 'watcher.added', 'watcher', relationship_id,
          jsonb_build_object('employeeId', actor_id), target_client_request_id
        );
        changed := true;
      end if;
      result := jsonb_build_object('boardId',board_id,'taskId',task_id,'watching',true,'changed',changed);
    else
      select watcher.id into relationship_id
      from private.sygtasks_task_watchers watcher
      where watcher.task_id = task_id
        and watcher.employee_id = actor_id
        and watcher.removed_at is null
      for update;
      if relationship_id is not null then
        update private.sygtasks_task_watchers watcher
        set removed_by = actor_id, removed_at = clock_timestamp()
        where watcher.id = relationship_id;
        perform private.sygtasks_record_activity(
          actor_id, board_id, task_id, 'watcher.removed', 'watcher', relationship_id,
          jsonb_build_object('employeeId', actor_id), target_client_request_id
        );
        changed := true;
      end if;
      result := jsonb_build_object('boardId',board_id,'taskId',task_id,'watching',false,'changed',changed);
    end if;

  elsif clean_action in ('create_label', 'update_label') then
    if clean_action = 'create_label' then
      board_id := nullif(clean_payload->>'boardId', '')::uuid;
      if board_id is null then raise check_violation using message = 'Choose a board.'; end if;
      select board.* into board_record
      from private.sygtasks_boards board where board.id = board_id for update;
      if board_record.id is null or board_record.archived_at is not null then raise check_violation using message = 'This active board is no longer available.'; end if;
      if not private.sygtasks_can_edit_board_tasks(actor_id, board_id) then raise insufficient_privilege using message = 'You cannot create labels on this board.'; end if;
      clean_title := btrim(coalesce(clean_payload->>'name', ''));
      if char_length(clean_title) not between 1 and 50 then raise check_violation using message = 'Label names must be between 1 and 50 characters.'; end if;
      if coalesce(clean_payload->>'color', '#C9962F') !~ '^#[0-9A-Fa-f]{6}$' then raise check_violation using message = 'Choose a six-digit label color.'; end if;
      if (select count(*) from private.sygtasks_labels label where label.board_id=board_id and label.archived_at is null)>=100 then
        raise check_violation using message = 'Boards support up to 100 active labels.';
      end if;
      insert into private.sygtasks_labels(board_id,name,color,created_by,updated_by)
      values(board_id,clean_title,upper(coalesce(clean_payload->>'color','#C9962F')),actor_id,actor_id)
      returning * into label_record;
      label_id:=label_record.id;
      perform private.sygtasks_record_activity(actor_id,board_id,null,'label.created','label',label_id,
        jsonb_build_object('after',to_jsonb(label_record)),target_client_request_id);
      changed:=true;
      result:=jsonb_build_object('boardId',board_id,'labelId',label_id,'version',label_record.version);
    else
      label_id:=nullif(clean_payload->>'labelId','')::uuid;
      if label_id is null then raise check_violation using message = 'Choose a label.'; end if;
      select label.* into label_record from private.sygtasks_labels label where label.id=label_id for update;
      if label_record.id is null or label_record.archived_at is not null then raise check_violation using message = 'This active label is no longer available.'; end if;
      board_id:=label_record.board_id;
      if not private.sygtasks_can_edit_board_tasks(actor_id,board_id) then raise insufficient_privilege using message = 'You cannot update this label.'; end if;
      if target_expected_version is null then raise check_violation using message = 'Refresh this label before changing it.'; end if;
      if not (clean_payload ? 'name' or clean_payload ? 'color') then
        raise check_violation using message = 'Choose a label detail to update.';
      end if;
      clean_title:=case when clean_payload?'name' then btrim(coalesce(clean_payload->>'name','')) else label_record.name end;
      if char_length(clean_title) not between 1 and 50 then raise check_violation using message = 'Label names must be between 1 and 50 characters.'; end if;
      if (case when clean_payload?'color' then coalesce(clean_payload->>'color','') else label_record.color end) !~ '^#[0-9A-Fa-f]{6}$' then
        raise check_violation using message = 'Choose a six-digit label color.';
      end if;
      before_record:=to_jsonb(label_record);
      update private.sygtasks_labels label
      set name=clean_title,
          color=upper(case when clean_payload?'color' then clean_payload->>'color' else label.color end),
          updated_by=actor_id,updated_at=clock_timestamp(),version=label.version+1
      where label.id=label_id and label.version=target_expected_version
      returning * into label_record;
      if label_record.id is null then raise serialization_failure using message = 'This label changed. Refresh it and try again.'; end if;
      perform private.sygtasks_record_activity(actor_id,board_id,null,'label.updated','label',label_id,
        jsonb_build_object('before',before_record,'after',to_jsonb(label_record)),target_client_request_id);
      changed:=true;
      result:=jsonb_build_object('boardId',board_id,'labelId',label_id,'version',label_record.version);
    end if;

  elsif clean_action in ('apply_label', 'remove_label') then
    task_id:=nullif(clean_payload->>'taskId','')::uuid;
    label_id:=nullif(clean_payload->>'labelId','')::uuid;
    if task_id is null or label_id is null then raise check_violation using message = 'Choose a task and label.'; end if;
    select task.* into task_record from private.sygtasks_tasks task where task.id=task_id for update;
    select label.* into label_record from private.sygtasks_labels label where label.id=label_id;
    if task_record.id is null or label_record.id is null or label_record.board_id<>task_record.board_id or label_record.archived_at is not null then
      raise check_violation using message = 'Choose an active label from this task board.';
    end if;
    board_id:=task_record.board_id;
    if not private.sygtasks_can_edit_board_tasks(actor_id,board_id) then raise insufficient_privilege using message = 'You cannot change labels on this task.'; end if;
    select task_label.id into relationship_id from private.sygtasks_task_labels task_label
    where task_label.task_id=task_id and task_label.label_id=label_id and task_label.removed_at is null
    for update;
    if clean_action='apply_label' and relationship_id is null then
      insert into private.sygtasks_task_labels(task_id,label_id,added_by)
      values(task_id,label_id,actor_id) returning id into relationship_id;
      perform private.sygtasks_record_activity(actor_id,board_id,task_id,'task_label.added','task_label',relationship_id,
        jsonb_build_object('labelId',label_id),target_client_request_id);
      changed:=true;
    elsif clean_action='remove_label' and relationship_id is not null then
      update private.sygtasks_task_labels task_label set removed_by=actor_id,removed_at=clock_timestamp() where task_label.id=relationship_id;
      perform private.sygtasks_record_activity(actor_id,board_id,task_id,'task_label.removed','task_label',relationship_id,
        jsonb_build_object('labelId',label_id),target_client_request_id);
      changed:=true;
    end if;
    result:=jsonb_build_object('boardId',board_id,'taskId',task_id,'labelId',label_id,'changed',changed);

  elsif clean_action in ('add_checklist_item','update_checklist_item','archive_checklist_item') then
    if clean_action='add_checklist_item' then
      task_id:=nullif(clean_payload->>'taskId','')::uuid;
      if task_id is null then raise check_violation using message = 'Choose a task.'; end if;
      select task.* into task_record from private.sygtasks_tasks task where task.id=task_id for update;
      if task_record.id is null or task_record.archived_at is not null then raise check_violation using message = 'This active task is no longer available.'; end if;
      board_id:=task_record.board_id;
      if not private.sygtasks_can_update_task_status(actor_id,task_id) then raise insufficient_privilege using message = 'You cannot update this task checklist.'; end if;
      clean_title:=btrim(coalesce(clean_payload->>'title',''));
      if char_length(clean_title) not between 1 and 500 then raise check_violation using message = 'Checklist items must be between 1 and 500 characters.'; end if;
      if (select count(*) from private.sygtasks_checklist_items item where item.task_id=task_id and item.archived_at is null)>=200 then
        raise check_violation using message = 'Tasks support up to 200 active checklist items.';
      end if;
      insert into private.sygtasks_checklist_items(task_id,title,sort_rank,created_by,updated_by)
      values(task_id,clean_title,coalesce(nullif(clean_payload->>'sortRank','')::bigint,0),actor_id,actor_id)
      returning * into checklist_record;
      checklist_id:=checklist_record.id;
      perform private.sygtasks_record_activity(actor_id,board_id,task_id,'checklist.added','checklist',checklist_id,
        jsonb_build_object('after',to_jsonb(checklist_record)),target_client_request_id);
      changed:=true;
      result:=jsonb_build_object('boardId',board_id,'taskId',task_id,'checklistItemId',checklist_id,'version',checklist_record.version);
    else
      checklist_id:=nullif(clean_payload->>'checklistItemId','')::uuid;
      if checklist_id is null then raise check_violation using message = 'Choose a checklist item.'; end if;
      select item.* into checklist_record from private.sygtasks_checklist_items item where item.id=checklist_id for update;
      if checklist_record.id is null or checklist_record.archived_at is not null then raise check_violation using message = 'This active checklist item is no longer available.'; end if;
      task_id:=checklist_record.task_id;
      select task.* into task_record from private.sygtasks_tasks task where task.id=task_id;
      board_id:=task_record.board_id;
      if target_expected_version is null then raise check_violation using message = 'Refresh this checklist item before changing it.'; end if;
      if clean_action='archive_checklist_item' then
        if not private.sygtasks_can_edit_board_tasks(actor_id,board_id) then raise insufficient_privilege using message = 'You cannot archive this checklist item.'; end if;
      elsif not private.sygtasks_can_update_task_status(actor_id,task_id) then
        raise insufficient_privilege using message = 'You cannot update this task checklist.';
      elsif not private.sygtasks_can_edit_board_tasks(actor_id,board_id)
            and (clean_payload-array['checklistItemId','completed']::text[])<>'{}'::jsonb then
        raise insufficient_privilege using message = 'Assignees may complete checklist items; editing their text requires board editing access.';
      end if;
      before_record:=to_jsonb(checklist_record);
      if clean_action='archive_checklist_item' then
        update private.sygtasks_checklist_items item
        set archived_at=coalesce(item.archived_at,clock_timestamp()),updated_by=actor_id,updated_at=clock_timestamp(),version=item.version+1
        where item.id=checklist_id and item.version=target_expected_version
        returning * into checklist_record;
      else
        if not (
          clean_payload ? 'title'
          or clean_payload ? 'sortRank'
          or clean_payload ? 'completed'
        ) then
          raise check_violation using message = 'Choose a checklist detail to update.';
        end if;
        clean_title:=case when clean_payload?'title' then btrim(coalesce(clean_payload->>'title','')) else checklist_record.title end;
        if char_length(clean_title) not between 1 and 500 then raise check_violation using message = 'Checklist items must be between 1 and 500 characters.'; end if;
        update private.sygtasks_checklist_items item
        set title=clean_title,
            sort_rank=case when clean_payload?'sortRank' then (clean_payload->>'sortRank')::bigint else item.sort_rank end,
            completed_at=case when clean_payload?'completed' then case when (clean_payload->>'completed')::boolean then coalesce(item.completed_at,clock_timestamp()) else null end else item.completed_at end,
            completed_by=case when clean_payload?'completed' then case when (clean_payload->>'completed')::boolean then coalesce(item.completed_by,actor_id) else null end else item.completed_by end,
            updated_by=actor_id,updated_at=clock_timestamp(),version=item.version+1
        where item.id=checklist_id and item.version=target_expected_version
        returning * into checklist_record;
      end if;
      if checklist_record.id is null then raise serialization_failure using message = 'This checklist item changed. Refresh it and try again.'; end if;
      perform private.sygtasks_record_activity(actor_id,board_id,task_id,
        case when clean_action='archive_checklist_item' then 'checklist.archived' else 'checklist.updated' end,
        'checklist',checklist_id,jsonb_build_object('before',before_record,'after',to_jsonb(checklist_record)),target_client_request_id);
      changed:=true;
      result:=jsonb_build_object('boardId',board_id,'taskId',task_id,'checklistItemId',checklist_id,'version',checklist_record.version);
    end if;

  elsif clean_action in ('add_comment','edit_comment','archive_comment') then
    if clean_action='add_comment' then
      task_id:=nullif(clean_payload->>'taskId','')::uuid;
      clean_body:=btrim(coalesce(clean_payload->>'body',''));
      if task_id is null then raise check_violation using message = 'Choose a task.'; end if;
      select task.* into task_record from private.sygtasks_tasks task where task.id=task_id for update;
      if task_record.id is null or task_record.archived_at is not null or not private.sygtasks_can_view_task(actor_id,task_id) then
        raise insufficient_privilege using message = 'This task is not available to your account.';
      end if;
      if char_length(clean_body) not between 1 and 5000 then raise check_violation using message = 'Comments must be between 1 and 5,000 characters.'; end if;
      board_id:=task_record.board_id;
      if (select count(*) from private.sygtasks_comments comment where comment.task_id=task_id and comment.archived_at is null)>=10000 then
        raise check_violation using message = 'This task has reached its active comment limit.';
      end if;
      insert into private.sygtasks_comments(task_id,author_employee_id,body)
      values(task_id,actor_id,clean_body)
      returning * into comment_record;
      comment_id:=comment_record.id;
      perform private.sygtasks_record_activity(actor_id,board_id,task_id,'comment.added','comment',comment_id,
        jsonb_build_object('after',to_jsonb(comment_record)),target_client_request_id);
      changed:=true;
      result:=jsonb_build_object('boardId',board_id,'taskId',task_id,'commentId',comment_id,'version',comment_record.version);

      select board.* into board_record from private.sygtasks_boards board where board.id=board_id;
      for affected_recipient in
        select distinct recipient_scope.employee_id
        from (
          select board_record.owner_employee_id as employee_id
          union
          select assignee.employee_id from private.sygtasks_task_assignees assignee where assignee.task_id=task_id and assignee.removed_at is null
          union
          select watcher.employee_id from private.sygtasks_task_watchers watcher where watcher.task_id=task_id and watcher.removed_at is null
        ) recipient_scope
        where recipient_scope.employee_id<>actor_id
      loop
        perform private.sygtasks_notify(
          affected_recipient.employee_id,actor_id,target_client_request_id,board_id,task_id,
          'New SygTasks comment',concat('A new comment was added to ',task_record.title,'.'),'routine'
        );
      end loop;
    else
      comment_id:=nullif(clean_payload->>'commentId','')::uuid;
      if comment_id is null then raise check_violation using message = 'Choose a comment.'; end if;
      select comment.* into comment_record from private.sygtasks_comments comment where comment.id=comment_id for update;
      if comment_record.id is null or comment_record.archived_at is not null then raise check_violation using message = 'This active comment is no longer available.'; end if;
      task_id:=comment_record.task_id;
      select task.* into task_record from private.sygtasks_tasks task where task.id=task_id;
      board_id:=task_record.board_id;
      if not private.sygtasks_can_view_task(actor_id,task_id) then raise insufficient_privilege using message = 'This comment is not available to your account.'; end if;
      if comment_record.author_employee_id<>actor_id and not private.sygtasks_has_permission(actor_id,'tasks.manage') then
        raise insufficient_privilege using message = 'Only the author or a SygTasks manager can change this comment.';
      end if;
      if target_expected_version is null then raise check_violation using message = 'Refresh this comment before changing it.'; end if;
      before_record:=to_jsonb(comment_record);
      if clean_action='edit_comment' then
        clean_body:=btrim(coalesce(clean_payload->>'body',''));
        if char_length(clean_body) not between 1 and 5000 then raise check_violation using message = 'Comments must be between 1 and 5,000 characters.'; end if;
        update private.sygtasks_comments comment
        set body=clean_body,edited_at=clock_timestamp(),updated_at=clock_timestamp(),version=comment.version+1
        where comment.id=comment_id and comment.version=target_expected_version
        returning * into comment_record;
      else
        update private.sygtasks_comments comment
        set archived_at=coalesce(comment.archived_at,clock_timestamp()),updated_at=clock_timestamp(),version=comment.version+1
        where comment.id=comment_id and comment.version=target_expected_version
        returning * into comment_record;
      end if;
      if comment_record.id is null then raise serialization_failure using message = 'This comment changed. Refresh it and try again.'; end if;
      perform private.sygtasks_record_activity(actor_id,board_id,task_id,
        case when clean_action='edit_comment' then 'comment.edited' else 'comment.archived' end,
        'comment',comment_id,jsonb_build_object('before',before_record,'after',to_jsonb(comment_record)),target_client_request_id);
      changed:=true;
      result:=jsonb_build_object('boardId',board_id,'taskId',task_id,'commentId',comment_id,'version',comment_record.version);
    end if;

  elsif clean_action in ('add_dependency','remove_dependency') then
    task_id:=nullif(clean_payload->>'taskId','')::uuid;
    dependency_task_id:=nullif(clean_payload->>'dependsOnTaskId','')::uuid;
    if task_id is null or dependency_task_id is null or task_id=dependency_task_id then
      raise check_violation using message = 'Choose two different tasks for the dependency.';
    end if;
    select task.* into task_record from private.sygtasks_tasks task where task.id=task_id for update;
    if task_record.id is null or task_record.archived_at is not null then raise check_violation using message = 'This active task is no longer available.'; end if;
    board_id:=task_record.board_id;
    if not exists (
      select 1 from private.sygtasks_tasks dependency_task
      where dependency_task.id=dependency_task_id
        and dependency_task.board_id=board_id
        and dependency_task.archived_at is null
    ) then
      raise check_violation using message = 'Dependencies must be active tasks on the same board.';
    end if;
    if not private.sygtasks_can_edit_board_tasks(actor_id,board_id) then
      raise insufficient_privilege using message = 'You cannot change dependencies on this task.';
    end if;

    -- Serialize dependency graph changes per board so two concurrent requests
    -- cannot each observe an acyclic graph and together introduce a cycle.
    perform pg_advisory_xact_lock(
      hashtextextended(concat('sygtasks:dependencies:', board_id), 0)
    );

    if clean_action='add_dependency' then
      if exists (
        with recursive dependency_path(id) as (
          select dependency_task_id
          union
          select dependency.depends_on_task_id
          from private.sygtasks_dependencies dependency
          join dependency_path path on dependency.task_id=path.id
          where dependency.removed_at is null
        )
        select 1 from dependency_path path where path.id=task_id
      ) then
        raise check_violation using message = 'This dependency would create a cycle.';
      end if;
      select dependency.id into relationship_id
      from private.sygtasks_dependencies dependency
      where dependency.task_id=task_id
        and dependency.depends_on_task_id=dependency_task_id
        and dependency.removed_at is null;
      if relationship_id is null then
        if (select count(*) from private.sygtasks_dependencies dependency where dependency.task_id=task_id and dependency.removed_at is null)>=100 then
          raise check_violation using message = 'Tasks support up to 100 active dependencies.';
        end if;
        insert into private.sygtasks_dependencies(task_id,depends_on_task_id,created_by)
        values(task_id,dependency_task_id,actor_id)
        returning id into relationship_id;
        perform private.sygtasks_record_activity(actor_id,board_id,task_id,'dependency.added','dependency',relationship_id,
          jsonb_build_object('dependsOnTaskId',dependency_task_id),target_client_request_id);
        changed:=true;
      end if;
    else
      select dependency.id into relationship_id
      from private.sygtasks_dependencies dependency
      where dependency.task_id=task_id
        and dependency.depends_on_task_id=dependency_task_id
        and dependency.removed_at is null
      for update;
      if relationship_id is not null then
        update private.sygtasks_dependencies dependency
        set removed_by=actor_id,removed_at=clock_timestamp()
        where dependency.id=relationship_id;
        perform private.sygtasks_record_activity(actor_id,board_id,task_id,'dependency.removed','dependency',relationship_id,
          jsonb_build_object('dependsOnTaskId',dependency_task_id),target_client_request_id);
        changed:=true;
      end if;
    end if;
    result:=jsonb_build_object('boardId',board_id,'taskId',task_id,'dependsOnTaskId',dependency_task_id,'changed',changed);
  end if;

  if changed and board_id is not null then
    update private.sygtasks_boards board
    set updated_at=clock_timestamp(),updated_by=actor_id
    where board.id=board_id;
    perform private.sygtasks_signal_scope(board_id,task_id);
  end if;

  result:=coalesce(result,'{}'::jsonb)||jsonb_build_object(
    'action',clean_action,
    'clientRequestId',target_client_request_id,
    'changed',changed
  );

  insert into private.sygtasks_action_requests(
    actor_employee_id,client_request_id,action,request_hash,response
  ) values (
    actor_id,target_client_request_id,clean_action,request_fingerprint,result
  );

  return result;
end
$$;

revoke all on function private.prevent_sygtasks_append_only_change() from public, anon, authenticated;
revoke all on function private.sygtasks_has_permission(uuid,text) from public, anon, authenticated;
revoke all on function private.sygtasks_can_view_board(uuid,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_can_view_task(uuid,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_can_edit_board_tasks(uuid,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_can_update_task_status(uuid,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_record_activity(uuid,uuid,uuid,text,text,uuid,jsonb,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_signal_scope(uuid,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_notify(uuid,uuid,uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function private.sygtasks_task_json(uuid,uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_task_detail_json(uuid,uuid) from public, anon, authenticated;

revoke all on function public.get_sygtasks_workspace(uuid,uuid,timestamptz,uuid,integer,boolean) from public, anon;
revoke all on function public.mutate_sygtasks(text,jsonb,uuid,integer) from public, anon;
grant execute on function public.get_sygtasks_workspace(uuid,uuid,timestamptz,uuid,integer,boolean) to authenticated;
grant execute on function public.mutate_sygtasks(text,jsonb,uuid,integer) to authenticated;

comment on function public.get_sygtasks_workspace(uuid,uuid,timestamptz,uuid,integer,boolean) is
  'Returns only SygTasks boards and task records the active employee may view, using bounded keyset pagination.';
comment on function public.mutate_sygtasks(text,jsonb,uuid,integer) is
  'Applies one bounded, retry-safe SygTasks action for an active employee with database-enforced participation and effective permissions.';
comment on table private.sygtasks_activity is
  'Append-only SygTasks activity. Update and delete are rejected so historical before/after evidence remains immutable.';

commit;

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Recurrence is additive. Existing boards, tasks, assignments, reminders, and
-- their audit history must remain byte-for-byte untouched by this release.
create temporary table sygtasks_recurring_release_baseline on commit drop as
select
  (select count(*) from private.sygtasks_boards) as board_count,
  (select count(*) from private.sygtasks_tasks) as task_count,
  (select count(*) from private.sygtasks_task_assignees) as assignee_count,
  (select count(*) from private.sygtasks_task_reminders) as reminder_count,
  (
    select md5(coalesce(string_agg(concat_ws(':', task.id, task.board_id, task.title, task.status, task.priority, coalesce(task.due_at::text, ''), task.version), '|' order by task.id), ''))
    from private.sygtasks_tasks task
  ) as task_fingerprint;

create table private.sygtasks_recurring_series (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references private.sygtasks_boards(id) on delete restrict,
  title text not null,
  description text not null default '',
  initial_status text not null default 'backlog',
  priority text not null default 'routine',
  assignee_employee_id uuid references public.employees(id) on delete restrict,
  frequency text not null,
  interval_count integer not null default 1,
  time_zone text not null default 'America/Denver',
  local_due_time time without time zone not null,
  starts_on date not null,
  ends_on date,
  max_occurrences integer,
  next_occurrence_on date not null,
  occurrence_count integer not null default 0,
  generated_count integer not null default 0,
  reminder_kind text,
  reminder_offset_minutes integer,
  reminder_email_enabled boolean not null default false,
  status text not null default 'active',
  status_reason text,
  created_by uuid not null references public.employees(id) on delete restrict,
  updated_by uuid not null references public.employees(id) on delete restrict,
  version integer not null default 1,
  paused_at timestamptz,
  canceled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_recurring_series_title_check check (char_length(btrim(title)) between 1 and 240),
  constraint sygtasks_recurring_series_description_check check (char_length(description) <= 10000),
  constraint sygtasks_recurring_series_initial_status_check check (initial_status in ('backlog', 'ready', 'in_progress')),
  constraint sygtasks_recurring_series_priority_check check (priority in ('low', 'routine', 'high', 'urgent')),
  constraint sygtasks_recurring_series_frequency_check check (frequency in ('daily', 'weekly', 'monthly')),
  constraint sygtasks_recurring_series_interval_check check (interval_count between 1 and 12),
  constraint sygtasks_recurring_series_time_zone_check check (time_zone in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles')),
  constraint sygtasks_recurring_series_end_date_check check (ends_on is null or ends_on >= starts_on),
  constraint sygtasks_recurring_series_max_check check (max_occurrences is null or max_occurrences between 1 and 500),
  constraint sygtasks_recurring_series_counts_check check (occurrence_count >= 0 and generated_count >= 0 and generated_count <= occurrence_count),
  constraint sygtasks_recurring_series_reminder_check check (
    (reminder_kind is null and reminder_offset_minutes is null and not reminder_email_enabled)
    or (reminder_kind in ('reminder', 'alarm') and reminder_offset_minutes between 0 and 43200)
  ),
  constraint sygtasks_recurring_series_status_check check (status in ('active', 'paused', 'canceled', 'completed')),
  constraint sygtasks_recurring_series_version_check check (version > 0),
  constraint sygtasks_recurring_series_lifecycle_check check (
    (status = 'active' and paused_at is null and canceled_at is null and completed_at is null)
    or (status = 'paused' and paused_at is not null and canceled_at is null and completed_at is null)
    or (status = 'canceled' and canceled_at is not null and completed_at is null)
    or (status = 'completed' and completed_at is not null and canceled_at is null)
  )
);

create table private.sygtasks_recurring_occurrences (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references private.sygtasks_recurring_series(id) on delete restrict,
  occurrence_on date not null,
  due_at timestamptz not null,
  state text not null,
  task_id uuid references private.sygtasks_tasks(id) on delete restrict,
  skip_reason text,
  created_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_recurring_occurrences_unique unique (series_id, occurrence_on),
  constraint sygtasks_recurring_occurrences_task_unique unique (task_id),
  constraint sygtasks_recurring_occurrences_state_check check (state in ('generated', 'skipped')),
  constraint sygtasks_recurring_occurrences_shape_check check (
    (state = 'generated' and task_id is not null and skip_reason is null)
    or (state = 'skipped' and task_id is null and char_length(btrim(skip_reason)) between 3 and 240)
  )
);

create table private.sygtasks_recurring_activity (
  id bigint generated always as identity primary key,
  series_id uuid not null references private.sygtasks_recurring_series(id) on delete restrict,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  client_request_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_recurring_activity_action_check check (char_length(btrim(action)) between 3 and 80),
  constraint sygtasks_recurring_activity_details_check check (octet_length(details::text) <= 65536)
);

create index sygtasks_recurring_series_due_idx
  on private.sygtasks_recurring_series(next_occurrence_on, id)
  where status = 'active';
create index sygtasks_recurring_series_board_idx
  on private.sygtasks_recurring_series(board_id, updated_at desc);
create index sygtasks_recurring_series_assignee_idx
  on private.sygtasks_recurring_series(assignee_employee_id, updated_at desc)
  where assignee_employee_id is not null and status in ('active', 'paused');
create index sygtasks_recurring_occurrences_series_idx
  on private.sygtasks_recurring_occurrences(series_id, occurrence_on desc);
create index sygtasks_recurring_activity_series_idx
  on private.sygtasks_recurring_activity(series_id, id desc);

alter table private.sygtasks_recurring_series enable row level security;
alter table private.sygtasks_recurring_series force row level security;
alter table private.sygtasks_recurring_occurrences enable row level security;
alter table private.sygtasks_recurring_occurrences force row level security;
alter table private.sygtasks_recurring_activity enable row level security;
alter table private.sygtasks_recurring_activity force row level security;
revoke all on table private.sygtasks_recurring_series, private.sygtasks_recurring_occurrences, private.sygtasks_recurring_activity from public, anon, authenticated;

create function private.sygtasks_next_recurrence_date(
  target_series private.sygtasks_recurring_series,
  target_occurrence_on date
)
returns date
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  candidate date;
  target_month date;
  last_day integer;
begin
  if target_series.frequency = 'daily' then
    return target_occurrence_on + target_series.interval_count;
  elsif target_series.frequency = 'weekly' then
    return target_occurrence_on + (7 * target_series.interval_count);
  end if;

  target_month := (date_trunc('month', target_occurrence_on)::date + make_interval(months => target_series.interval_count))::date;
  last_day := extract(day from (target_month + interval '1 month - 1 day'))::integer;
  candidate := target_month + (least(extract(day from target_series.starts_on)::integer, last_day) - 1);
  return candidate;
end
$$;

create function private.sygtasks_record_recurring_activity(
  target_series_id uuid,
  target_actor_employee_id uuid,
  target_action text,
  target_details jsonb,
  target_client_request_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare created_activity_id bigint;
begin
  insert into private.sygtasks_recurring_activity (
    series_id, actor_employee_id, action, details, client_request_id
  ) values (
    target_series_id,
    target_actor_employee_id,
    left(btrim(target_action), 80),
    coalesce(target_details, '{}'::jsonb),
    target_client_request_id
  ) returning id into created_activity_id;

  insert into private.audit_events (
    auth_user_id, employee_id, request_id, schema_name, table_name,
    operation, row_id, new_record
  ) values (
    (select auth.uid()),
    target_actor_employee_id,
    target_client_request_id::text,
    'private',
    'sygtasks_recurring_series',
    upper(replace(target_action, '.', '_')),
    target_series_id::text,
    coalesce(target_details, '{}'::jsonb)
  );
  return created_activity_id;
end
$$;

create function private.generate_sygtasks_recurring_occurrences(
  target_series_id uuid,
  target_horizon date,
  target_limit integer default 32
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  series_record private.sygtasks_recurring_series%rowtype;
  board_record private.sygtasks_boards%rowtype;
  task_record private.sygtasks_tasks%rowtype;
  relationship_id uuid;
  reminder_id uuid;
  request_id uuid;
  occurrence_due_at timestamptz;
  occurrence_date date;
  next_date date;
  created_count integer := 0;
  assigned_count integer := 0;
  assignee_eligible boolean := false;
  terminal boolean := false;
begin
  select series.* into series_record
  from private.sygtasks_recurring_series series
  where series.id = target_series_id
  for update;

  if series_record.id is null or series_record.status <> 'active' then
    return jsonb_build_object('seriesId', target_series_id, 'created', 0, 'status', coalesce(series_record.status, 'missing'));
  end if;

  select board.* into board_record
  from private.sygtasks_boards board
  where board.id = series_record.board_id;

  if board_record.id is null or board_record.archived_at is not null then
    update private.sygtasks_recurring_series series
    set status = 'canceled', status_reason = 'board_archived', canceled_at = clock_timestamp(),
        paused_at = null, updated_at = clock_timestamp(), version = series.version + 1,
        updated_by = series_record.created_by
    where series.id = series_record.id;
    perform private.sygtasks_record_recurring_activity(
      series_record.id, series_record.created_by, 'series.canceled',
      jsonb_build_object('reason', 'board_archived')
    );
    return jsonb_build_object('seriesId', series_record.id, 'created', 0, 'status', 'canceled');
  end if;

  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = series_record.created_by
      and employee.status = 'active'
      and account.disabled_at is null
  ) then
    update private.sygtasks_recurring_series series
    set status = 'paused', status_reason = 'owner_inactive', paused_at = clock_timestamp(),
        updated_at = clock_timestamp(), version = series.version + 1,
        updated_by = series_record.created_by
    where series.id = series_record.id;
    perform private.sygtasks_record_recurring_activity(
      series_record.id, series_record.created_by, 'series.paused',
      jsonb_build_object('reason', 'owner_inactive')
    );
    return jsonb_build_object('seriesId', series_record.id, 'created', 0, 'status', 'paused');
  end if;

  while series_record.next_occurrence_on <= target_horizon
    and created_count < least(greatest(coalesce(target_limit, 32), 1), 64)
  loop
    occurrence_date := series_record.next_occurrence_on;
    if (series_record.ends_on is not null and occurrence_date > series_record.ends_on)
       or (series_record.max_occurrences is not null and series_record.occurrence_count >= series_record.max_occurrences)
    then
      terminal := true;
      exit;
    end if;

    next_date := private.sygtasks_next_recurrence_date(series_record, occurrence_date);
    occurrence_due_at := (occurrence_date + series_record.local_due_time) at time zone series_record.time_zone;
    request_id := md5(concat(series_record.id, ':', occurrence_date, ':generate'))::uuid;

    if exists (
      select 1 from private.sygtasks_recurring_occurrences occurrence
      where occurrence.series_id = series_record.id
        and occurrence.occurrence_on = occurrence_date
    ) then
      update private.sygtasks_recurring_series series
      set next_occurrence_on = next_date,
          occurrence_count = series.occurrence_count + 1,
          updated_at = clock_timestamp()
      where series.id = series_record.id
      returning * into series_record;
      continue;
    end if;

    insert into private.sygtasks_tasks (
      board_id, title, description, status, priority, due_at, sort_rank,
      created_by, updated_by, completed_at
    ) values (
      series_record.board_id,
      series_record.title,
      series_record.description,
      series_record.initial_status,
      series_record.priority,
      occurrence_due_at,
      0,
      series_record.created_by,
      series_record.created_by,
      null
    ) returning * into task_record;

    insert into private.sygtasks_recurring_occurrences (
      series_id, occurrence_on, due_at, state, task_id
    ) values (
      series_record.id, occurrence_date, occurrence_due_at, 'generated', task_record.id
    );

    perform private.sygtasks_record_activity(
      series_record.created_by,
      series_record.board_id,
      task_record.id,
      'task.created',
      'task',
      task_record.id,
      jsonb_build_object(
        'after', to_jsonb(task_record),
        'recurrence', jsonb_build_object('seriesId', series_record.id, 'occurrenceOn', occurrence_date)
      ),
      request_id
    );

    assignee_eligible := false;
    if series_record.assignee_employee_id is not null then
      select exists (
        select 1
        from public.employees employee
        join private.employee_accounts account on account.employee_id = employee.id
        where employee.id = series_record.assignee_employee_id
          and employee.status = 'active'
          and account.disabled_at is null
          and (
            board_record.scope = 'personal'
            or private.sygtasks_has_permission(employee.id, 'tasks.view')
            or private.sygtasks_has_permission(employee.id, 'tasks.manage')
          )
          and (board_record.scope <> 'personal' or employee.id = board_record.owner_employee_id)
      ) into assignee_eligible;
    end if;

    if assignee_eligible then
      insert into private.sygtasks_task_assignees (task_id, employee_id, assigned_by)
      values (task_record.id, series_record.assignee_employee_id, series_record.created_by)
      returning id into relationship_id;
      perform private.sygtasks_record_activity(
        series_record.created_by, series_record.board_id, task_record.id,
        'assignee.added', 'assignee', relationship_id,
        jsonb_build_object('employeeId', series_record.assignee_employee_id, 'recurringSeriesId', series_record.id),
        md5(concat(request_id, ':assign'))::uuid
      );
      perform private.sygtasks_notify(
        series_record.assignee_employee_id, series_record.created_by,
        md5(concat(request_id, ':notify'))::uuid,
        series_record.board_id, task_record.id,
        'New recurring SygTasks assignment',
        concat('A recurring task is ready: ', task_record.title),
        case when task_record.priority = 'urgent' then 'urgent' when task_record.priority = 'high' then 'important' else 'routine' end
      );
      assigned_count := assigned_count + 1;
    end if;

    if series_record.reminder_kind is not null then
      insert into private.sygtasks_task_reminders (
        task_id, created_by, kind, recipient_scope, timing_kind,
        offset_minutes, absolute_at, email_enabled, required_acknowledgement
      ) values (
        task_record.id,
        series_record.created_by,
        series_record.reminder_kind,
        case when assignee_eligible then 'assignees' else 'self' end,
        'relative',
        series_record.reminder_offset_minutes,
        null,
        series_record.reminder_email_enabled,
        series_record.reminder_kind = 'alarm'
      ) returning id into reminder_id;
      perform private.reconcile_sygtasks_reminder(reminder_id);
    end if;

    perform private.sygtasks_record_recurring_activity(
      series_record.id,
      series_record.created_by,
      'occurrence.generated',
      jsonb_build_object(
        'occurrenceOn', occurrence_date,
        'taskId', task_record.id,
        'dueAt', occurrence_due_at,
        'assigneeApplied', assignee_eligible,
        'reminderCreated', reminder_id is not null
      ),
      request_id
    );

    update private.sygtasks_recurring_series series
    set next_occurrence_on = next_date,
        occurrence_count = series.occurrence_count + 1,
        generated_count = series.generated_count + 1,
        updated_at = clock_timestamp()
    where series.id = series_record.id
    returning * into series_record;

    perform private.sygtasks_signal_scope(series_record.board_id, task_record.id);
    reminder_id := null;
    relationship_id := null;
    created_count := created_count + 1;
  end loop;

  if terminal
     or (series_record.max_occurrences is not null and series_record.occurrence_count >= series_record.max_occurrences)
     or (series_record.ends_on is not null and series_record.next_occurrence_on > series_record.ends_on)
  then
    update private.sygtasks_recurring_series series
    set status = 'completed', status_reason = 'schedule_complete', completed_at = clock_timestamp(),
        paused_at = null, updated_at = clock_timestamp(), version = series.version + 1,
        updated_by = series_record.created_by
    where series.id = series_record.id
      and series.status = 'active'
    returning * into series_record;
    if found then
      perform private.sygtasks_record_recurring_activity(
        series_record.id, series_record.created_by, 'series.completed',
        jsonb_build_object('occurrenceCount', series_record.occurrence_count, 'generatedCount', series_record.generated_count)
      );
    end if;
  end if;

  return jsonb_build_object(
    'seriesId', series_record.id,
    'created', created_count,
    'assigned', assigned_count,
    'status', series_record.status,
    'nextOccurrenceOn', series_record.next_occurrence_on
  );
end
$$;

create function public.create_sygtasks_recurring_series(
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
  prior_request private.sygtasks_action_requests%rowtype;
  board_record private.sygtasks_boards%rowtype;
  series_record private.sygtasks_recurring_series%rowtype;
  first_occurrence private.sygtasks_recurring_occurrences%rowtype;
  request_fingerprint text;
  first_due_local timestamp without time zone;
  first_due_at timestamptz;
  clean_zone text;
  clean_frequency text;
  clean_status text;
  clean_priority text;
  clean_reminder text;
  assignee_id uuid;
  clean_interval integer;
  clean_max integer;
  clean_ends_on date;
  clean_offset integer;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_client_request_id is null then raise check_violation using message = 'A client request identifier is required.'; end if;
  if jsonb_typeof(clean_payload) <> 'object' or octet_length(clean_payload::text) > 65536 then
    raise check_violation using message = 'The recurring task request is too large or malformed.';
  end if;
  if clean_payload - array[
    'boardId', 'title', 'description', 'status', 'priority', 'assigneeId',
    'firstDueLocal', 'timeZone', 'frequency', 'intervalCount', 'endsOn',
    'maxOccurrences', 'reminderKind', 'reminderOffsetMinutes', 'reminderEmailEnabled'
  ]::text[] <> '{}'::jsonb then
    raise check_violation using message = 'This recurring task request contains unsupported fields.';
  end if;

  request_fingerprint := md5('create_recurring_series|' || clean_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(concat('sygtasks:', actor_id, ':', target_client_request_id), 0));
  select request.* into prior_request
  from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id
    and request.client_request_id = target_client_request_id;
  if prior_request.id is not null then
    if prior_request.action <> 'create_recurring_series' or prior_request.request_hash <> request_fingerprint then
      raise check_violation using message = 'This request identifier was already used for a different action.';
    end if;
    return prior_request.response;
  end if;

  begin
    select board.* into board_record
    from private.sygtasks_boards board
    where board.id = (clean_payload->>'boardId')::uuid
    for update;
  exception when others then
    raise check_violation using message = 'Choose a valid board.';
  end;
  if board_record.id is null or board_record.archived_at is not null then
    raise check_violation using message = 'This active board is no longer available.';
  end if;
  if not private.sygtasks_can_edit_board_tasks(actor_id, board_record.id) then
    raise insufficient_privilege using message = 'You cannot create recurring work on this board.';
  end if;
  if char_length(btrim(coalesce(clean_payload->>'title', ''))) not between 1 and 240 then
    raise check_violation using message = 'Task titles must be between 1 and 240 characters.';
  end if;
  if char_length(coalesce(clean_payload->>'description', '')) > 10000 then
    raise check_violation using message = 'Task descriptions are limited to 10,000 characters.';
  end if;

  clean_status := lower(btrim(coalesce(clean_payload->>'status', 'backlog')));
  clean_priority := lower(btrim(coalesce(clean_payload->>'priority', 'routine')));
  clean_frequency := lower(btrim(coalesce(clean_payload->>'frequency', 'weekly')));
  clean_zone := btrim(coalesce(clean_payload->>'timeZone', 'America/Denver'));
  clean_reminder := nullif(lower(btrim(coalesce(clean_payload->>'reminderKind', ''))), 'none');
  begin
    clean_interval := coalesce((clean_payload->>'intervalCount')::integer, 1);
    clean_max := nullif(clean_payload->>'maxOccurrences', '')::integer;
    clean_ends_on := nullif(clean_payload->>'endsOn', '')::date;
    clean_offset := case when clean_reminder is null then null else coalesce((clean_payload->>'reminderOffsetMinutes')::integer, 60) end;
    assignee_id := nullif(clean_payload->>'assigneeId', '')::uuid;
    first_due_local := (clean_payload->>'firstDueLocal')::timestamp without time zone;
  exception when others then
    raise check_violation using message = 'Review the recurrence dates and choices, then try again.';
  end;

  if clean_status not in ('backlog', 'ready', 'in_progress') then raise check_violation using message = 'Choose Backlog, Ready, or In progress as the starting status.'; end if;
  if clean_priority not in ('low', 'routine', 'high', 'urgent') then raise check_violation using message = 'Choose a valid priority.'; end if;
  if clean_frequency not in ('daily', 'weekly', 'monthly') then raise check_violation using message = 'Choose Daily, Weekly, or Monthly.'; end if;
  if clean_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles') then raise check_violation using message = 'Choose an approved U.S. time zone.'; end if;
  if clean_interval not between 1 and 12 then raise check_violation using message = 'Repeat intervals must be between 1 and 12.'; end if;
  if first_due_local is null then raise check_violation using message = 'Choose the first due date and time.'; end if;
  first_due_at := first_due_local at time zone clean_zone;
  if to_char(first_due_at at time zone clean_zone, 'YYYY-MM-DD"T"HH24:MI') <> to_char(first_due_local, 'YYYY-MM-DD"T"HH24:MI') then
    raise check_violation using message = 'That local time does not exist because of daylight saving time. Choose another time.';
  end if;
  if clean_ends_on is not null and clean_ends_on < first_due_local::date then raise check_violation using message = 'The series end date cannot be before the first task.'; end if;
  if clean_max is not null and clean_max not between 1 and 500 then raise check_violation using message = 'Choose between 1 and 500 occurrences.'; end if;
  if clean_reminder is not null and clean_reminder not in ('reminder', 'alarm') then raise check_violation using message = 'Choose Reminder, Alarm, or no alert.'; end if;
  if clean_offset is not null and clean_offset not between 0 and 43200 then raise check_violation using message = 'Choose an alert within 30 days of the due time.'; end if;
  if coalesce((clean_payload->>'reminderEmailEnabled')::boolean, false) and clean_reminder is null then raise check_violation using message = 'Choose a reminder or alarm before enabling email.'; end if;

  if assignee_id is not null and not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = assignee_id
      and employee.status = 'active'
      and account.disabled_at is null
      and (
        board_record.scope = 'personal'
        or private.sygtasks_has_permission(employee.id, 'tasks.view')
        or private.sygtasks_has_permission(employee.id, 'tasks.manage')
      )
      and (board_record.scope <> 'personal' or employee.id = board_record.owner_employee_id)
  ) then raise check_violation using message = 'Choose an active employee with access to this board.'; end if;
  if assignee_id is not null and assignee_id <> actor_id and not private.sygtasks_has_permission(actor_id, 'tasks.manage') then
    raise insufficient_privilege using message = 'Assigning another employee requires SygTasks management access.';
  end if;

  insert into private.sygtasks_recurring_series (
    board_id, title, description, initial_status, priority, assignee_employee_id,
    frequency, interval_count, time_zone, local_due_time, starts_on, ends_on,
    max_occurrences, next_occurrence_on, reminder_kind, reminder_offset_minutes,
    reminder_email_enabled, created_by, updated_by
  ) values (
    board_record.id,
    btrim(clean_payload->>'title'),
    btrim(coalesce(clean_payload->>'description', '')),
    clean_status,
    clean_priority,
    assignee_id,
    clean_frequency,
    clean_interval,
    clean_zone,
    first_due_local::time,
    first_due_local::date,
    clean_ends_on,
    clean_max,
    first_due_local::date,
    clean_reminder,
    clean_offset,
    case when clean_reminder is null then false else coalesce((clean_payload->>'reminderEmailEnabled')::boolean, false) end,
    actor_id,
    actor_id
  ) returning * into series_record;

  perform private.sygtasks_record_recurring_activity(
    series_record.id, actor_id, 'series.created',
    jsonb_build_object('after', to_jsonb(series_record)), target_client_request_id
  );
  perform private.generate_sygtasks_recurring_occurrences(series_record.id, series_record.starts_on, 1);
  select occurrence.* into first_occurrence
  from private.sygtasks_recurring_occurrences occurrence
  where occurrence.series_id = series_record.id
    and occurrence.occurrence_on = series_record.starts_on;

  result := jsonb_build_object(
    'action', 'create_recurring_series',
    'seriesId', series_record.id,
    'boardId', series_record.board_id,
    'taskId', first_occurrence.task_id,
    'version', series_record.version,
    'clientRequestId', target_client_request_id,
    'changed', true
  );
  insert into private.sygtasks_action_requests (
    actor_employee_id, client_request_id, action, request_hash, response
  ) values (
    actor_id, target_client_request_id, 'create_recurring_series', request_fingerprint, result
  );
  return result;
end
$$;

create function public.get_sygtasks_recurring_series(target_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  series_record private.sygtasks_recurring_series%rowtype;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if not private.sygtasks_can_view_task(actor_id, target_task_id) then raise insufficient_privilege using message = 'You do not have access to this task.'; end if;

  select series.* into series_record
  from private.sygtasks_recurring_occurrences occurrence
  join private.sygtasks_recurring_series series on series.id = occurrence.series_id
  where occurrence.task_id = target_task_id;
  if series_record.id is null then return jsonb_build_object('taskId', target_task_id, 'series', null); end if;

  select jsonb_build_object(
    'taskId', target_task_id,
    'series', jsonb_build_object(
      'id', series_record.id,
      'boardId', series_record.board_id,
      'title', series_record.title,
      'description', series_record.description,
      'initialStatus', series_record.initial_status,
      'priority', series_record.priority,
      'assigneeEmployeeId', series_record.assignee_employee_id,
      'assigneeName', private.sygtasks_employee_name(series_record.assignee_employee_id),
      'frequency', series_record.frequency,
      'intervalCount', series_record.interval_count,
      'timeZone', series_record.time_zone,
      'localDueTime', to_char(series_record.local_due_time, 'HH24:MI'),
      'startsOn', series_record.starts_on,
      'endsOn', series_record.ends_on,
      'maxOccurrences', series_record.max_occurrences,
      'nextOccurrenceOn', series_record.next_occurrence_on,
      'occurrenceCount', series_record.occurrence_count,
      'generatedCount', series_record.generated_count,
      'reminderKind', series_record.reminder_kind,
      'reminderOffsetMinutes', series_record.reminder_offset_minutes,
      'reminderEmailEnabled', series_record.reminder_email_enabled,
      'status', series_record.status,
      'statusReason', series_record.status_reason,
      'version', series_record.version,
      'canManage', private.sygtasks_can_edit_board_tasks(actor_id, series_record.board_id),
      'createdAt', series_record.created_at,
      'updatedAt', series_record.updated_at,
      'occurrences', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', occurrence.id,
          'occurrenceOn', occurrence.occurrence_on,
          'dueAt', occurrence.due_at,
          'state', occurrence.state,
          'taskId', occurrence.task_id,
          'skipReason', occurrence.skip_reason,
          'createdAt', occurrence.created_at
        ) order by occurrence.occurrence_on desc), '[]'::jsonb)
        from (
          select occurrence.*
          from private.sygtasks_recurring_occurrences occurrence
          where occurrence.series_id = series_record.id
          order by occurrence.occurrence_on desc
          limit 20
        ) occurrence
      ),
      'activity', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', activity.id,
          'action', activity.action,
          'details', activity.details,
          'actorEmployeeId', activity.actor_employee_id,
          'actorName', private.sygtasks_employee_name(activity.actor_employee_id),
          'createdAt', activity.created_at
        ) order by activity.id desc), '[]'::jsonb)
        from (
          select activity.*
          from private.sygtasks_recurring_activity activity
          where activity.series_id = series_record.id
          order by activity.id desc
          limit 30
        ) activity
      )
    )
  ) into result;
  return result;
end
$$;

create function public.manage_sygtasks_recurring_series(
  target_series_id uuid,
  target_action text,
  target_payload jsonb,
  target_client_request_id uuid,
  target_expected_version integer
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
  series_record private.sygtasks_recurring_series%rowtype;
  prior_request private.sygtasks_action_requests%rowtype;
  request_fingerprint text;
  next_date date;
  due_at timestamptz;
  clean_reminder text;
  clean_assignee uuid;
  result jsonb;
  before_record jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_series_id is null or target_client_request_id is null then raise check_violation using message = 'Choose a recurring series and provide a request identifier.'; end if;
  if target_expected_version is null or target_expected_version < 1 then raise check_violation using message = 'Refresh this recurring task before changing it.'; end if;
  if clean_action not in ('pause', 'resume', 'cancel', 'skip_next', 'update_future') then raise check_violation using message = 'Choose a valid recurring task action.'; end if;
  if jsonb_typeof(clean_payload) <> 'object' or octet_length(clean_payload::text) > 65536 then raise check_violation using message = 'The recurring task change is malformed.'; end if;
  if clean_action = 'update_future' then
    if clean_payload - array['title', 'description', 'status', 'priority', 'assigneeId', 'reminderKind', 'reminderOffsetMinutes', 'reminderEmailEnabled']::text[] <> '{}'::jsonb then
      raise check_violation using message = 'This future-task change contains unsupported fields.';
    end if;
  elsif clean_payload <> '{}'::jsonb then
    raise check_violation using message = 'This recurring task action does not accept extra fields.';
  end if;

  request_fingerprint := md5(concat('manage_recurring_series|', target_series_id, '|', clean_action, '|', clean_payload::text, '|', target_expected_version));
  perform pg_advisory_xact_lock(hashtextextended(concat('sygtasks:', actor_id, ':', target_client_request_id), 0));
  select request.* into prior_request from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id and request.client_request_id = target_client_request_id;
  if prior_request.id is not null then
    if prior_request.action <> 'manage_recurring_series' or prior_request.request_hash <> request_fingerprint then
      raise check_violation using message = 'This request identifier was already used for a different action.';
    end if;
    return prior_request.response;
  end if;

  select series.* into series_record
  from private.sygtasks_recurring_series series
  where series.id = target_series_id
  for update;
  if series_record.id is null then raise no_data_found using message = 'This recurring task no longer exists.'; end if;
  if series_record.version <> target_expected_version then raise serialization_failure using message = 'This recurring task changed. Refresh it and try again.'; end if;
  if not private.sygtasks_can_edit_board_tasks(actor_id, series_record.board_id) then raise insufficient_privilege using message = 'You cannot manage this recurring task.'; end if;
  before_record := to_jsonb(series_record);

  if clean_action = 'pause' then
    if series_record.status <> 'active' then raise check_violation using message = 'Only an active series can be paused.'; end if;
    update private.sygtasks_recurring_series series
    set status = 'paused', status_reason = 'paused_by_user', paused_at = clock_timestamp(),
        updated_by = actor_id, updated_at = clock_timestamp(), version = series.version + 1
    where series.id = target_series_id returning * into series_record;
  elsif clean_action = 'resume' then
    if series_record.status <> 'paused' then raise check_violation using message = 'Only a paused series can be resumed.'; end if;
    if not exists (select 1 from private.sygtasks_boards board where board.id = series_record.board_id and board.archived_at is null) then raise check_violation using message = 'An archived board cannot resume recurring work.'; end if;
    update private.sygtasks_recurring_series series
    set status = 'active', status_reason = null, paused_at = null,
        updated_by = actor_id, updated_at = clock_timestamp(), version = series.version + 1
    where series.id = target_series_id returning * into series_record;
  elsif clean_action = 'cancel' then
    if series_record.status in ('canceled', 'completed') then raise check_violation using message = 'This series is already finished.'; end if;
    update private.sygtasks_recurring_series series
    set status = 'canceled', status_reason = 'canceled_by_user', canceled_at = clock_timestamp(), paused_at = null,
        updated_by = actor_id, updated_at = clock_timestamp(), version = series.version + 1
    where series.id = target_series_id returning * into series_record;
  elsif clean_action = 'skip_next' then
    if series_record.status <> 'active' then raise check_violation using message = 'Resume this series before skipping an occurrence.'; end if;
    if exists (
      select 1 from private.sygtasks_recurring_occurrences occurrence
      where occurrence.series_id = series_record.id and occurrence.occurrence_on = series_record.next_occurrence_on
    ) then raise check_violation using message = 'The next occurrence was already created. Open that task to cancel or change it.'; end if;
    due_at := (series_record.next_occurrence_on + series_record.local_due_time) at time zone series_record.time_zone;
    insert into private.sygtasks_recurring_occurrences (series_id, occurrence_on, due_at, state, skip_reason)
    values (series_record.id, series_record.next_occurrence_on, due_at, 'skipped', 'Skipped by an authorized user.');
    next_date := private.sygtasks_next_recurrence_date(series_record, series_record.next_occurrence_on);
    update private.sygtasks_recurring_series series
    set next_occurrence_on = next_date, occurrence_count = series.occurrence_count + 1,
        updated_by = actor_id, updated_at = clock_timestamp(), version = series.version + 1
    where series.id = target_series_id returning * into series_record;
  else
    if series_record.status in ('canceled', 'completed') then raise check_violation using message = 'Finished series cannot create more future work.'; end if;
    if not (clean_payload ? 'title' or clean_payload ? 'description' or clean_payload ? 'status' or clean_payload ? 'priority' or clean_payload ? 'assigneeId' or clean_payload ? 'reminderKind' or clean_payload ? 'reminderOffsetMinutes' or clean_payload ? 'reminderEmailEnabled') then
      raise check_violation using message = 'Choose at least one future-task detail to change.';
    end if;
    if clean_payload ? 'title' and char_length(btrim(coalesce(clean_payload->>'title', ''))) not between 1 and 240 then raise check_violation using message = 'Task titles must be between 1 and 240 characters.'; end if;
    if clean_payload ? 'description' and char_length(coalesce(clean_payload->>'description', '')) > 10000 then raise check_violation using message = 'Task descriptions are limited to 10,000 characters.'; end if;
    if clean_payload ? 'status' and lower(btrim(clean_payload->>'status')) not in ('backlog', 'ready', 'in_progress') then raise check_violation using message = 'Choose Backlog, Ready, or In progress as the starting status.'; end if;
    if clean_payload ? 'priority' and lower(btrim(clean_payload->>'priority')) not in ('low', 'routine', 'high', 'urgent') then raise check_violation using message = 'Choose a valid priority.'; end if;
    begin clean_assignee := nullif(clean_payload->>'assigneeId', '')::uuid; exception when others then raise check_violation using message = 'Choose a valid future assignee.'; end;
    if clean_payload ? 'assigneeId' and clean_assignee is not null and not exists (
      select 1 from public.employees employee
      join private.employee_accounts account on account.employee_id = employee.id
      join private.sygtasks_boards board on board.id = series_record.board_id
      where employee.id = clean_assignee and employee.status = 'active' and account.disabled_at is null
        and (board.scope = 'personal' or private.sygtasks_has_permission(employee.id, 'tasks.view') or private.sygtasks_has_permission(employee.id, 'tasks.manage'))
        and (board.scope <> 'personal' or employee.id = board.owner_employee_id)
    ) then raise check_violation using message = 'Choose an active employee with access to this board.'; end if;
    if clean_payload ? 'assigneeId' and clean_assignee is not null and clean_assignee <> actor_id and not private.sygtasks_has_permission(actor_id, 'tasks.manage') then raise insufficient_privilege using message = 'Assigning another employee requires SygTasks management access.'; end if;

    clean_reminder := case when clean_payload ? 'reminderKind' then nullif(lower(btrim(coalesce(clean_payload->>'reminderKind', ''))), 'none') else series_record.reminder_kind end;
    if clean_reminder is not null and clean_reminder not in ('reminder', 'alarm') then raise check_violation using message = 'Choose Reminder, Alarm, or no alert.'; end if;
    if clean_reminder is not null and clean_payload ? 'reminderOffsetMinutes' and (clean_payload->>'reminderOffsetMinutes')::integer not between 0 and 43200 then raise check_violation using message = 'Choose an alert within 30 days of the due time.'; end if;

    update private.sygtasks_recurring_series series
    set title = case when clean_payload ? 'title' then btrim(clean_payload->>'title') else series.title end,
        description = case when clean_payload ? 'description' then btrim(coalesce(clean_payload->>'description', '')) else series.description end,
        initial_status = case when clean_payload ? 'status' then lower(btrim(clean_payload->>'status')) else series.initial_status end,
        priority = case when clean_payload ? 'priority' then lower(btrim(clean_payload->>'priority')) else series.priority end,
        assignee_employee_id = case when clean_payload ? 'assigneeId' then clean_assignee else series.assignee_employee_id end,
        reminder_kind = clean_reminder,
        reminder_offset_minutes = case when clean_reminder is null then null when clean_payload ? 'reminderOffsetMinutes' then (clean_payload->>'reminderOffsetMinutes')::integer else coalesce(series.reminder_offset_minutes, 60) end,
        reminder_email_enabled = case when clean_reminder is null then false when clean_payload ? 'reminderEmailEnabled' then coalesce((clean_payload->>'reminderEmailEnabled')::boolean, false) else series.reminder_email_enabled end,
        updated_by = actor_id, updated_at = clock_timestamp(), version = series.version + 1
    where series.id = target_series_id returning * into series_record;
  end if;

  perform private.sygtasks_record_recurring_activity(
    series_record.id, actor_id, 'series.' || clean_action,
    jsonb_build_object('before', before_record, 'after', to_jsonb(series_record)), target_client_request_id
  );
  perform private.sygtasks_signal_scope(series_record.board_id, null);
  result := jsonb_build_object('seriesId', series_record.id, 'action', clean_action, 'status', series_record.status, 'version', series_record.version, 'changed', true);
  insert into private.sygtasks_action_requests (actor_employee_id, client_request_id, action, request_hash, response)
  values (actor_id, target_client_request_id, 'manage_recurring_series', request_fingerprint, result);
  return result;
end
$$;

create function public.service_process_due_sygtasks_recurring_series(
  target_limit integer default 50,
  target_horizon_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  generated jsonb;
  processed_count integer := 0;
  created_count integer := 0;
  paused_count integer := 0;
  canceled_count integer := 0;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  if coalesce(target_horizon_days, 7) not between 0 and 31 then raise check_violation using message = 'The recurrence horizon must be between 0 and 31 days.'; end if;

  for candidate in
    select series.id
    from private.sygtasks_recurring_series series
    where series.status = 'active'
      and series.next_occurrence_on <= ((clock_timestamp() at time zone series.time_zone)::date + coalesce(target_horizon_days, 7))
    order by series.next_occurrence_on, series.id
    limit least(greatest(coalesce(target_limit, 50), 1), 100)
    for update skip locked
  loop
    generated := private.generate_sygtasks_recurring_occurrences(
      candidate.id,
      (
        select (clock_timestamp() at time zone series.time_zone)::date + coalesce(target_horizon_days, 7)
        from private.sygtasks_recurring_series series where series.id = candidate.id
      ),
      32
    );
    processed_count := processed_count + 1;
    created_count := created_count + coalesce((generated->>'created')::integer, 0);
    paused_count := paused_count + case when generated->>'status' = 'paused' then 1 else 0 end;
    canceled_count := canceled_count + case when generated->>'status' = 'canceled' then 1 else 0 end;
  end loop;

  return jsonb_build_object('processed', processed_count, 'created', created_count, 'paused', paused_count, 'canceled', canceled_count);
end
$$;

create function private.stop_sygtasks_series_when_board_archived()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare series_record record;
begin
  if old.archived_at is null and new.archived_at is not null then
    for series_record in
      update private.sygtasks_recurring_series series
      set status = 'canceled', status_reason = 'board_archived', canceled_at = clock_timestamp(), paused_at = null,
          updated_by = new.updated_by, updated_at = clock_timestamp(), version = series.version + 1
      where series.board_id = new.id and series.status in ('active', 'paused')
      returning series.id
    loop
      perform private.sygtasks_record_recurring_activity(series_record.id, new.updated_by, 'series.canceled', jsonb_build_object('reason', 'board_archived'));
    end loop;
  end if;
  return new;
end
$$;

create trigger sygtasks_recurring_board_archive
after update of archived_at on private.sygtasks_boards
for each row execute function private.stop_sygtasks_series_when_board_archived();

revoke all on function private.sygtasks_next_recurrence_date(private.sygtasks_recurring_series, date), private.sygtasks_record_recurring_activity(uuid, uuid, text, jsonb, uuid), private.generate_sygtasks_recurring_occurrences(uuid, date, integer), private.stop_sygtasks_series_when_board_archived() from public, anon, authenticated;
revoke all on function public.create_sygtasks_recurring_series(jsonb, uuid), public.get_sygtasks_recurring_series(uuid), public.manage_sygtasks_recurring_series(uuid, text, jsonb, uuid, integer), public.service_process_due_sygtasks_recurring_series(integer, integer) from public, anon, authenticated;
grant execute on function public.create_sygtasks_recurring_series(jsonb, uuid), public.get_sygtasks_recurring_series(uuid), public.manage_sygtasks_recurring_series(uuid, text, jsonb, uuid, integer) to authenticated;
grant execute on function public.service_process_due_sygtasks_recurring_series(integer, integer) to service_role;

comment on function public.create_sygtasks_recurring_series(jsonb, uuid) is 'Creates one recurrence template and its first independent task with idempotent retry protection.';
comment on function public.manage_sygtasks_recurring_series(uuid, text, jsonb, uuid, integer) is 'Pauses, resumes, stops, skips, or changes only future occurrences; generated task history remains independent.';
comment on function public.service_process_due_sygtasks_recurring_series(integer, integer) is 'Bounded, retry-safe service processor for due recurring task occurrences.';

do $$
declare baseline sygtasks_recurring_release_baseline%rowtype;
declare current_fingerprint text;
begin
  select * into baseline from sygtasks_recurring_release_baseline;
  select md5(coalesce(string_agg(concat_ws(':', task.id, task.board_id, task.title, task.status, task.priority, coalesce(task.due_at::text, ''), task.version), '|' order by task.id), ''))
  into current_fingerprint from private.sygtasks_tasks task;
  if baseline.board_count <> (select count(*) from private.sygtasks_boards)
     or baseline.task_count <> (select count(*) from private.sygtasks_tasks)
     or baseline.assignee_count <> (select count(*) from private.sygtasks_task_assignees)
     or baseline.reminder_count <> (select count(*) from private.sygtasks_task_reminders)
     or baseline.task_fingerprint is distinct from current_fingerprint
  then raise exception 'Recurring SygTasks release changed existing operational work.'; end if;
end
$$;

notify pgrst, 'reload schema';
commit;

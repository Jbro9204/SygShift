begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Task reminders are definitions. Occurrences are the exact per-employee
-- delivery and acknowledgement records. Keeping them separate lets due-date
-- and assignment changes reconcile without losing notification history.
create table private.sygtasks_task_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.sygtasks_tasks(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  kind text not null,
  recipient_scope text not null,
  timing_kind text not null,
  offset_minutes integer,
  absolute_at timestamptz,
  email_enabled boolean not null default false,
  required_acknowledgement boolean not null default false,
  version integer not null default 1,
  cancelled_by uuid references public.employees(id) on delete restrict,
  cancelled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_task_reminders_kind_check check (kind in ('reminder', 'alarm')),
  constraint sygtasks_task_reminders_recipient_scope_check check (recipient_scope in ('self', 'assignees')),
  constraint sygtasks_task_reminders_timing_kind_check check (timing_kind in ('relative', 'absolute')),
  constraint sygtasks_task_reminders_timing_check check (
    (timing_kind = 'relative' and offset_minutes between 0 and 43200 and absolute_at is null)
    or (timing_kind = 'absolute' and offset_minutes is null and absolute_at is not null)
  ),
  constraint sygtasks_task_reminders_ack_check check (
    (kind = 'alarm' and required_acknowledgement)
    or (kind = 'reminder' and not required_acknowledgement)
  ),
  constraint sygtasks_task_reminders_version_check check (version > 0),
  constraint sygtasks_task_reminders_cancel_check check (
    (cancelled_at is null and cancelled_by is null)
    or (cancelled_at is not null and cancelled_by is not null and cancelled_at >= created_at)
  )
);

create table private.sygtasks_task_reminder_occurrences (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references private.sygtasks_task_reminders(id) on delete restrict,
  recipient_employee_id uuid not null references public.employees(id) on delete restrict,
  scheduled_for timestamptz not null,
  state text not null default 'scheduled',
  delivery_count integer not null default 0,
  last_notification_id uuid references public.employee_notifications(id) on delete restrict,
  triggered_at timestamptz,
  snoozed_until timestamptz,
  acknowledged_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygtasks_task_reminder_occurrences_unique unique (reminder_id, recipient_employee_id),
  constraint sygtasks_task_reminder_occurrences_state_check check (state in ('scheduled', 'triggered', 'snoozed', 'acknowledged', 'cancelled')),
  constraint sygtasks_task_reminder_occurrences_delivery_check check (delivery_count >= 0),
  constraint sygtasks_task_reminder_occurrences_version_check check (version > 0),
  constraint sygtasks_task_reminder_occurrences_snooze_check check (
    (state = 'snoozed' and snoozed_until is not null)
    or state <> 'snoozed'
  ),
  constraint sygtasks_task_reminder_occurrences_ack_check check (
    (state = 'acknowledged' and acknowledged_at is not null)
    or state <> 'acknowledged'
  ),
  constraint sygtasks_task_reminder_occurrences_cancel_check check (
    (state = 'cancelled' and cancelled_at is not null and cancellation_reason is not null)
    or state <> 'cancelled'
  )
);

create index sygtasks_task_reminders_task_idx
  on private.sygtasks_task_reminders(task_id, created_at desc)
  where cancelled_at is null;
create index sygtasks_task_reminders_creator_idx
  on private.sygtasks_task_reminders(created_by, created_at desc);
create index sygtasks_reminder_occurrences_scheduled_idx
  on private.sygtasks_task_reminder_occurrences(scheduled_for, id)
  where state = 'scheduled';
create index sygtasks_reminder_occurrences_snoozed_idx
  on private.sygtasks_task_reminder_occurrences(snoozed_until, id)
  where state = 'snoozed';
create index sygtasks_reminder_occurrences_recipient_idx
  on private.sygtasks_task_reminder_occurrences(recipient_employee_id, state, updated_at desc);
create index sygtasks_reminder_occurrences_notification_idx
  on private.sygtasks_task_reminder_occurrences(last_notification_id)
  where last_notification_id is not null;

alter table private.sygtasks_task_reminders enable row level security;
alter table private.sygtasks_task_reminders force row level security;
alter table private.sygtasks_task_reminder_occurrences enable row level security;
alter table private.sygtasks_task_reminder_occurrences force row level security;
revoke all on table private.sygtasks_task_reminders, private.sygtasks_task_reminder_occurrences from public, anon, authenticated;

create function private.sygtasks_employee_name(target_employee_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name)
  from public.employees employee
  where employee.id = target_employee_id
$$;

create function private.sygtasks_reminder_scheduled_for(
  target_reminder private.sygtasks_task_reminders,
  target_task private.sygtasks_tasks
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case target_reminder.timing_kind
    when 'absolute' then target_reminder.absolute_at
    else target_task.due_at - make_interval(mins => target_reminder.offset_minutes)
  end
$$;

create function private.reconcile_sygtasks_reminder(target_reminder_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reminder_record private.sygtasks_task_reminders%rowtype;
  task_record private.sygtasks_tasks%rowtype;
  effective_time timestamptz;
  terminal_reason text;
  recipient record;
begin
  select reminder.* into reminder_record
  from private.sygtasks_task_reminders reminder
  where reminder.id = target_reminder_id
  for update;

  if reminder_record.id is null then return; end if;

  select task.* into task_record
  from private.sygtasks_tasks task
  where task.id = reminder_record.task_id;

  terminal_reason := case
    when reminder_record.cancelled_at is not null then 'reminder_cancelled'
    when task_record.archived_at is not null then 'task_archived'
    when task_record.status = 'done' then 'task_completed'
    when task_record.status = 'canceled' then 'task_canceled'
    when reminder_record.timing_kind = 'relative' and task_record.due_at is null then 'due_removed'
    else null
  end;

  if terminal_reason is not null then
    update private.sygtasks_task_reminder_occurrences occurrence
    set state = 'cancelled',
        cancelled_at = coalesce(occurrence.cancelled_at, clock_timestamp()),
        cancellation_reason = terminal_reason,
        snoozed_until = null,
        version = occurrence.version + 1,
        updated_at = clock_timestamp()
    where occurrence.reminder_id = reminder_record.id
      and occurrence.state in ('scheduled', 'triggered', 'snoozed');

    update public.employee_notifications notification
    set read_at = coalesce(notification.read_at, clock_timestamp()),
        dismissed_at = coalesce(notification.dismissed_at, clock_timestamp())
    where notification.id in (
      select occurrence.last_notification_id
      from private.sygtasks_task_reminder_occurrences occurrence
      where occurrence.reminder_id = reminder_record.id
        and occurrence.last_notification_id is not null
    );

    for recipient in
      select distinct occurrence.recipient_employee_id as employee_id
      from private.sygtasks_task_reminder_occurrences occurrence
      where occurrence.reminder_id = reminder_record.id
    loop
      perform private.signal_employee_update(recipient.employee_id, jsonb_build_object(
        'kind', 'sygtasks_alarm',
        'taskId', task_record.id,
        'isNew', false
      ));
    end loop;

    perform private.sygtasks_signal_scope(task_record.board_id, task_record.id);
    return;
  end if;

  effective_time := private.sygtasks_reminder_scheduled_for(reminder_record, task_record);

  for recipient in
    select candidate.employee_id
    from (
      select reminder_record.created_by as employee_id
      where reminder_record.recipient_scope = 'self'
      union all
      select assignee.employee_id
      from private.sygtasks_task_assignees assignee
      where reminder_record.recipient_scope = 'assignees'
        and assignee.task_id = reminder_record.task_id
        and assignee.removed_at is null
    ) candidate
  loop
    insert into private.sygtasks_task_reminder_occurrences (
      reminder_id,
      recipient_employee_id,
      scheduled_for
    ) values (
      reminder_record.id,
      recipient.employee_id,
      effective_time
    )
    on conflict (reminder_id, recipient_employee_id) do update
    set scheduled_for = case
          when private.sygtasks_task_reminder_occurrences.state = 'scheduled'
            or (
              private.sygtasks_task_reminder_occurrences.state = 'cancelled'
              and private.sygtasks_task_reminder_occurrences.cancellation_reason = 'recipient_removed'
            )
          then excluded.scheduled_for
          else private.sygtasks_task_reminder_occurrences.scheduled_for
        end,
        state = case
          when private.sygtasks_task_reminder_occurrences.state = 'cancelled'
            and private.sygtasks_task_reminder_occurrences.cancellation_reason = 'recipient_removed'
          then 'scheduled'
          else private.sygtasks_task_reminder_occurrences.state
        end,
        cancelled_at = case
          when private.sygtasks_task_reminder_occurrences.state = 'cancelled'
            and private.sygtasks_task_reminder_occurrences.cancellation_reason = 'recipient_removed'
          then null
          else private.sygtasks_task_reminder_occurrences.cancelled_at
        end,
        cancellation_reason = case
          when private.sygtasks_task_reminder_occurrences.state = 'cancelled'
            and private.sygtasks_task_reminder_occurrences.cancellation_reason = 'recipient_removed'
          then null
          else private.sygtasks_task_reminder_occurrences.cancellation_reason
        end,
        version = private.sygtasks_task_reminder_occurrences.version + 1,
        updated_at = clock_timestamp();
  end loop;

  update private.sygtasks_task_reminder_occurrences occurrence
  set state = 'cancelled',
      cancelled_at = clock_timestamp(),
      cancellation_reason = 'recipient_removed',
      snoozed_until = null,
      version = occurrence.version + 1,
      updated_at = clock_timestamp()
  where occurrence.reminder_id = reminder_record.id
    and occurrence.state in ('scheduled', 'triggered', 'snoozed')
    and not exists (
      select 1
      from (
        select reminder_record.created_by as employee_id
        where reminder_record.recipient_scope = 'self'
        union all
        select assignee.employee_id
        from private.sygtasks_task_assignees assignee
        where reminder_record.recipient_scope = 'assignees'
          and assignee.task_id = reminder_record.task_id
          and assignee.removed_at is null
      ) expected
      where expected.employee_id = occurrence.recipient_employee_id
    );

  update public.employee_notifications notification
  set read_at = coalesce(notification.read_at, clock_timestamp()),
      dismissed_at = coalesce(notification.dismissed_at, clock_timestamp())
  where notification.id in (
    select occurrence.last_notification_id
    from private.sygtasks_task_reminder_occurrences occurrence
    where occurrence.reminder_id = reminder_record.id
      and occurrence.state = 'cancelled'
      and occurrence.cancellation_reason = 'recipient_removed'
      and occurrence.last_notification_id is not null
  );

  for recipient in
    select distinct occurrence.recipient_employee_id as employee_id
    from private.sygtasks_task_reminder_occurrences occurrence
    where occurrence.reminder_id = reminder_record.id
      and occurrence.state = 'cancelled'
      and occurrence.cancellation_reason = 'recipient_removed'
  loop
    perform private.signal_employee_update(recipient.employee_id, jsonb_build_object(
      'kind', 'sygtasks_alarm',
      'taskId', task_record.id,
      'isNew', false
    ));
  end loop;

  perform private.sygtasks_signal_scope(task_record.board_id, task_record.id);
end
$$;

create function private.reconcile_sygtasks_task_reminders_from_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare reminder_record record;
begin
  for reminder_record in
    select reminder.id
    from private.sygtasks_task_reminders reminder
    where reminder.task_id = new.id
      and reminder.cancelled_at is null
  loop
    perform private.reconcile_sygtasks_reminder(reminder_record.id);
  end loop;
  return new;
end
$$;

create trigger sygtasks_task_reminder_task_reconcile
after update of due_at, status, archived_at on private.sygtasks_tasks
for each row
when (
  old.due_at is distinct from new.due_at
  or old.status is distinct from new.status
  or old.archived_at is distinct from new.archived_at
)
execute function private.reconcile_sygtasks_task_reminders_from_task();

create function private.reconcile_sygtasks_task_reminders_from_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_task_id uuid := coalesce(new.task_id, old.task_id);
  reminder_record record;
begin
  for reminder_record in
    select reminder.id
    from private.sygtasks_task_reminders reminder
    where reminder.task_id = affected_task_id
      and reminder.recipient_scope = 'assignees'
      and reminder.cancelled_at is null
  loop
    perform private.reconcile_sygtasks_reminder(reminder_record.id);
  end loop;
  return new;
end
$$;

create trigger sygtasks_task_reminder_assignee_reconcile
after insert or update of removed_at on private.sygtasks_task_assignees
for each row execute function private.reconcile_sygtasks_task_reminders_from_assignee();

create function public.get_sygtasks_task_reminders(target_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_manage boolean;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if not private.sygtasks_can_view_task(actor_id, target_task_id) then
    raise insufficient_privilege using message = 'You do not have access to this task.';
  end if;

  select private.sygtasks_can_edit_board_tasks(actor_id, task.board_id)
  into can_manage
  from private.sygtasks_tasks task
  where task.id = target_task_id;

  select jsonb_build_object(
    'taskId', target_task_id,
    'canCreateForAssignees', coalesce(can_manage, false),
    'reminders', coalesce(jsonb_agg(jsonb_build_object(
      'id', reminder.id,
      'kind', reminder.kind,
      'recipientScope', reminder.recipient_scope,
      'timingKind', reminder.timing_kind,
      'offsetMinutes', reminder.offset_minutes,
      'absoluteAt', reminder.absolute_at,
      'emailEnabled', reminder.email_enabled,
      'requiredAcknowledgement', reminder.required_acknowledgement,
      'createdBy', reminder.created_by,
      'createdByName', private.sygtasks_employee_name(reminder.created_by),
      'createdAt', reminder.created_at,
      'canCancel', reminder.created_by = actor_id or coalesce(can_manage, false),
      'occurrences', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', occurrence.id,
          'recipientEmployeeId', occurrence.recipient_employee_id,
          'recipientName', private.sygtasks_employee_name(occurrence.recipient_employee_id),
          'scheduledFor', occurrence.scheduled_for,
          'state', occurrence.state,
          'snoozedUntil', occurrence.snoozed_until,
          'triggeredAt', occurrence.triggered_at,
          'acknowledgedAt', occurrence.acknowledged_at,
          'cancelledAt', occurrence.cancelled_at,
          'cancellationReason', occurrence.cancellation_reason
        ) order by private.sygtasks_employee_name(occurrence.recipient_employee_id)), '[]'::jsonb)
        from private.sygtasks_task_reminder_occurrences occurrence
        where occurrence.reminder_id = reminder.id
          and (coalesce(can_manage, false) or occurrence.recipient_employee_id = actor_id)
      )
    ) order by reminder.created_at desc) filter (where reminder.id is not null), '[]'::jsonb)
  ) into result
  from private.sygtasks_task_reminders reminder
  where reminder.task_id = target_task_id
    and reminder.cancelled_at is null
    and (
      reminder.created_by = actor_id
      or coalesce(can_manage, false)
      or exists (
        select 1
        from private.sygtasks_task_reminder_occurrences occurrence
        where occurrence.reminder_id = reminder.id
          and occurrence.recipient_employee_id = actor_id
      )
    );

  return result;
end
$$;

create function public.create_sygtasks_task_reminder(
  target_payload jsonb,
  target_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_payload jsonb := coalesce(target_payload, '{}'::jsonb);
  request_fingerprint text;
  prior_request private.sygtasks_action_requests%rowtype;
  task_id uuid;
  task_record private.sygtasks_tasks%rowtype;
  clean_kind text;
  clean_scope text;
  clean_timing text;
  clean_offset integer;
  clean_absolute timestamptz;
  clean_email boolean;
  reminder_record private.sygtasks_task_reminders%rowtype;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_client_request_id is null then raise check_violation using message = 'A client request identifier is required.'; end if;
  if jsonb_typeof(clean_payload) <> 'object' or octet_length(clean_payload::text) > 8192 then
    raise check_violation using message = 'The reminder request is malformed.';
  end if;
  if exists (
    select 1 from jsonb_object_keys(clean_payload) as field(key)
    where field.key <> all(array['taskId', 'kind', 'recipientScope', 'timingKind', 'offsetMinutes', 'absoluteAt', 'emailEnabled'])
  ) then raise check_violation using message = 'The reminder request contains an unsupported field.'; end if;

  begin task_id := (clean_payload ->> 'taskId')::uuid;
  exception when others then raise check_violation using message = 'Choose a valid task.'; end;
  clean_kind := lower(btrim(coalesce(clean_payload ->> 'kind', 'reminder')));
  clean_scope := lower(btrim(coalesce(clean_payload ->> 'recipientScope', 'self')));
  clean_timing := lower(btrim(coalesce(clean_payload ->> 'timingKind', 'relative')));
  clean_email := coalesce((clean_payload ->> 'emailEnabled')::boolean, false);

  if clean_kind not in ('reminder', 'alarm') then raise check_violation using message = 'Choose Reminder or Alarm.'; end if;
  if clean_scope not in ('self', 'assignees') then raise check_violation using message = 'Choose who should receive this reminder.'; end if;
  if clean_timing not in ('relative', 'absolute') then raise check_violation using message = 'Choose when this reminder should occur.'; end if;

  if clean_timing = 'relative' then
    begin clean_offset := coalesce((clean_payload ->> 'offsetMinutes')::integer, 0);
    exception when others then raise check_violation using message = 'Choose a valid reminder lead time.'; end;
    if clean_offset < 0 or clean_offset > 43200 then raise check_violation using message = 'Choose a reminder time within 30 days of the due time.'; end if;
    clean_absolute := null;
  else
    clean_offset := null;
    begin clean_absolute := (clean_payload ->> 'absoluteAt')::timestamptz;
    exception when others then raise check_violation using message = 'Choose a valid reminder date and time.'; end;
    if clean_absolute is null or clean_absolute <= clock_timestamp() then
      raise check_violation using message = 'Choose a reminder time in the future.';
    end if;
  end if;

  select task.* into task_record
  from private.sygtasks_tasks task
  where task.id = task_id
  for share;
  if task_record.id is null or not private.sygtasks_can_view_task(actor_id, task_id) then
    raise insufficient_privilege using message = 'You do not have access to this task.';
  end if;
  if task_record.archived_at is not null or task_record.status in ('done', 'canceled') then
    raise check_violation using message = 'Completed, canceled, or archived tasks cannot receive a new reminder.';
  end if;
  if clean_timing = 'relative' and task_record.due_at is null then
    raise check_violation using message = 'Add a task due date before using a relative reminder.';
  end if;
  if clean_scope = 'assignees' and not private.sygtasks_can_edit_board_tasks(actor_id, task_record.board_id) then
    raise insufficient_privilege using message = 'Only an authorized task manager can remind all assignees.';
  end if;
  if clean_scope = 'assignees' and not exists (
    select 1 from private.sygtasks_task_assignees assignee
    where assignee.task_id = task_id and assignee.removed_at is null
  ) then raise check_violation using message = 'Assign at least one employee before creating an assignee reminder.'; end if;

  request_fingerprint := md5(concat('create_reminder:', clean_payload::text));
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || target_client_request_id::text, 0));
  select request.* into prior_request
  from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id
    and request.client_request_id = target_client_request_id;
  if prior_request.id is not null then
    if prior_request.action <> 'create_reminder' or prior_request.request_hash <> request_fingerprint then
      raise unique_violation using message = 'This reminder retry does not match the original request.';
    end if;
    return prior_request.response;
  end if;

  insert into private.sygtasks_task_reminders (
    task_id, created_by, kind, recipient_scope, timing_kind, offset_minutes,
    absolute_at, email_enabled, required_acknowledgement
  ) values (
    task_id, actor_id, clean_kind, clean_scope, clean_timing, clean_offset,
    clean_absolute, clean_email, clean_kind = 'alarm'
  ) returning * into reminder_record;

  perform private.reconcile_sygtasks_reminder(reminder_record.id);
  perform private.sygtasks_record_activity(
    actor_id, task_record.board_id, task_id, 'reminder.created', 'task', task_id,
    jsonb_build_object(
      'reminderId', reminder_record.id,
      'kind', clean_kind,
      'recipientScope', clean_scope,
      'timingKind', clean_timing,
      'offsetMinutes', clean_offset,
      'absoluteAt', clean_absolute,
      'emailEnabled', clean_email
    ),
    target_client_request_id
  );

  result := jsonb_build_object(
    'reminderId', reminder_record.id,
    'taskId', task_id,
    'kind', clean_kind,
    'recipientScope', clean_scope,
    'changed', true
  );
  insert into private.sygtasks_action_requests(actor_employee_id, client_request_id, action, request_hash, response)
  values (actor_id, target_client_request_id, 'create_reminder', request_fingerprint, result);
  return result;
end
$$;

create function public.cancel_sygtasks_task_reminder(
  target_reminder_id uuid,
  target_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  reminder_record private.sygtasks_task_reminders%rowtype;
  task_record private.sygtasks_tasks%rowtype;
  request_fingerprint text := md5(concat('cancel_reminder:', target_reminder_id));
  prior_request private.sygtasks_action_requests%rowtype;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_client_request_id is null then raise check_violation using message = 'A client request identifier is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || target_client_request_id::text, 0));
  select request.* into prior_request from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id and request.client_request_id = target_client_request_id;
  if prior_request.id is not null then
    if prior_request.action <> 'cancel_reminder' or prior_request.request_hash <> request_fingerprint then
      raise unique_violation using message = 'This reminder retry does not match the original request.';
    end if;
    return prior_request.response;
  end if;

  select reminder.* into reminder_record from private.sygtasks_task_reminders reminder
  where reminder.id = target_reminder_id for update;
  if reminder_record.id is null then raise no_data_found using message = 'This reminder no longer exists.'; end if;
  select task.* into task_record from private.sygtasks_tasks task where task.id = reminder_record.task_id;
  if reminder_record.created_by <> actor_id
     and not private.sygtasks_can_edit_board_tasks(actor_id, task_record.board_id)
  then raise insufficient_privilege using message = 'You cannot cancel this reminder.'; end if;

  if reminder_record.cancelled_at is null then
    update private.sygtasks_task_reminders reminder
    set cancelled_at = clock_timestamp(), cancelled_by = actor_id,
        version = reminder.version + 1, updated_at = clock_timestamp()
    where reminder.id = reminder_record.id;
    perform private.reconcile_sygtasks_reminder(reminder_record.id);
    perform private.sygtasks_record_activity(
      actor_id, task_record.board_id, task_record.id, 'reminder.cancelled', 'task', task_record.id,
      jsonb_build_object('reminderId', reminder_record.id), target_client_request_id
    );
  end if;

  result := jsonb_build_object('reminderId', reminder_record.id, 'taskId', task_record.id, 'changed', reminder_record.cancelled_at is null);
  insert into private.sygtasks_action_requests(actor_employee_id, client_request_id, action, request_hash, response)
  values (actor_id, target_client_request_id, 'cancel_reminder', request_fingerprint, result);
  return result;
end
$$;

create function public.manage_my_sygtasks_alarm(
  target_action text,
  target_occurrence_id uuid,
  target_snooze_minutes integer,
  target_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_action text := lower(btrim(coalesce(target_action, '')));
  occurrence_record private.sygtasks_task_reminder_occurrences%rowtype;
  reminder_record private.sygtasks_task_reminders%rowtype;
  task_record private.sygtasks_tasks%rowtype;
  prior_request private.sygtasks_action_requests%rowtype;
  request_fingerprint text;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if target_client_request_id is null then raise check_violation using message = 'A client request identifier is required.'; end if;
  if clean_action not in ('acknowledge', 'snooze') then raise check_violation using message = 'Choose Stop or Snooze.'; end if;
  if clean_action = 'snooze' and (target_snooze_minutes is null or target_snooze_minutes not in (5, 10, 15, 30, 60)) then
    raise check_violation using message = 'Choose a 5, 10, 15, 30, or 60 minute snooze.';
  end if;

  request_fingerprint := md5(concat(clean_action, ':', target_occurrence_id, ':', coalesce(target_snooze_minutes, 0)));
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text || ':' || target_client_request_id::text, 0));
  select request.* into prior_request from private.sygtasks_action_requests request
  where request.actor_employee_id = actor_id and request.client_request_id = target_client_request_id;
  if prior_request.id is not null then
    if prior_request.action <> ('alarm_' || clean_action) or prior_request.request_hash <> request_fingerprint then
      raise unique_violation using message = 'This alarm retry does not match the original request.';
    end if;
    return prior_request.response;
  end if;

  select occurrence.* into occurrence_record
  from private.sygtasks_task_reminder_occurrences occurrence
  where occurrence.id = target_occurrence_id
    and occurrence.recipient_employee_id = actor_id
  for update;
  if occurrence_record.id is null then raise insufficient_privilege using message = 'This alarm is not available to this account.'; end if;
  select reminder.* into reminder_record from private.sygtasks_task_reminders reminder where reminder.id = occurrence_record.reminder_id;
  select task.* into task_record from private.sygtasks_tasks task where task.id = reminder_record.task_id;
  if reminder_record.kind <> 'alarm' then raise check_violation using message = 'Only task alarms can be stopped or snoozed.'; end if;

  if clean_action = 'snooze' then
    if occurrence_record.state <> 'triggered' then raise check_violation using message = 'Only an active alarm can be snoozed.'; end if;
    update private.sygtasks_task_reminder_occurrences occurrence
    set state = 'snoozed', snoozed_until = clock_timestamp() + make_interval(mins => target_snooze_minutes),
        version = occurrence.version + 1, updated_at = clock_timestamp()
    where occurrence.id = occurrence_record.id;
    update public.employee_notifications notification
    set read_at = coalesce(notification.read_at, clock_timestamp()),
        dismissed_at = coalesce(notification.dismissed_at, clock_timestamp())
    where notification.id = occurrence_record.last_notification_id;
  else
    if occurrence_record.state not in ('triggered', 'snoozed') then
      raise check_violation using message = 'This alarm is no longer active.';
    end if;
    update private.sygtasks_task_reminder_occurrences occurrence
    set state = 'acknowledged', acknowledged_at = clock_timestamp(), snoozed_until = null,
        version = occurrence.version + 1, updated_at = clock_timestamp()
    where occurrence.id = occurrence_record.id;
    update public.employee_notifications notification
    set read_at = coalesce(notification.read_at, clock_timestamp()),
        acknowledged_at = coalesce(notification.acknowledged_at, clock_timestamp()),
        dismissed_at = coalesce(notification.dismissed_at, clock_timestamp())
    where notification.id = occurrence_record.last_notification_id;
  end if;

  perform private.sygtasks_record_activity(
    actor_id, task_record.board_id, task_record.id, 'alarm.' || clean_action, 'task', task_record.id,
    jsonb_build_object('reminderId', reminder_record.id, 'occurrenceId', occurrence_record.id, 'snoozeMinutes', target_snooze_minutes),
    target_client_request_id
  );
  perform private.signal_employee_update(actor_id, jsonb_build_object('kind', 'sygtasks_alarm', 'taskId', task_record.id, 'isNew', false));

  result := jsonb_build_object(
    'occurrenceId', occurrence_record.id,
    'taskId', task_record.id,
    'state', case when clean_action = 'snooze' then 'snoozed' else 'acknowledged' end,
    'snoozedUntil', case when clean_action = 'snooze' then clock_timestamp() + make_interval(mins => target_snooze_minutes) else null end,
    'changed', true
  );
  insert into private.sygtasks_action_requests(actor_employee_id, client_request_id, action, request_hash, response)
  values (actor_id, target_client_request_id, 'alarm_' || clean_action, request_fingerprint, result);
  return result;
end
$$;

create function public.get_my_sygtasks_alarm_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select jsonb_build_object(
    'serverTime', statement_timestamp(),
    'alarms', coalesce(jsonb_agg(jsonb_build_object(
      'occurrenceId', occurrence.id,
      'reminderId', reminder.id,
      'taskId', task.id,
      'boardId', task.board_id,
      'title', task.title,
      'priority', task.priority,
      'dueAt', task.due_at,
      'scheduledFor', occurrence.scheduled_for,
      'triggeredAt', occurrence.triggered_at,
      'deliveryCount', occurrence.delivery_count,
      'taskVersion', task.version,
      'canComplete', private.sygtasks_can_update_task_status(actor_id, task.id)
    ) order by occurrence.triggered_at, occurrence.id) filter (where occurrence.id is not null), '[]'::jsonb)
  ) into result
  from private.sygtasks_task_reminder_occurrences occurrence
  join private.sygtasks_task_reminders reminder on reminder.id = occurrence.reminder_id
  join private.sygtasks_tasks task on task.id = reminder.task_id
  where occurrence.recipient_employee_id = actor_id
    and occurrence.state = 'triggered'
    and reminder.kind = 'alarm'
    and reminder.cancelled_at is null
    and task.archived_at is null
    and task.status not in ('done', 'canceled');
  return result;
end
$$;

create function public.get_my_sygtasks_badge()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  unread_count integer;
  active_alarm_count integer;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select count(*)::integer into active_alarm_count
  from private.sygtasks_task_reminder_occurrences occurrence
  join private.sygtasks_task_reminders reminder on reminder.id = occurrence.reminder_id
  join private.sygtasks_tasks task on task.id = reminder.task_id
  where occurrence.recipient_employee_id = actor_id
    and occurrence.state = 'triggered'
    and reminder.kind = 'alarm'
    and reminder.cancelled_at is null
    and task.archived_at is null
    and task.status not in ('done', 'canceled');

  select count(*)::integer into unread_count
  from public.employee_notifications notification
  where notification.recipient_employee_id = actor_id
    and notification.source_type = 'sygtasks'
    and notification.read_at is null
    and notification.dismissed_at is null
    and not exists (
      select 1
      from private.sygtasks_task_reminder_occurrences occurrence
      where occurrence.last_notification_id = notification.id
        and occurrence.state = 'triggered'
        and occurrence.recipient_employee_id = actor_id
    );

  return jsonb_build_object(
    'count', unread_count + active_alarm_count,
    'unreadCount', unread_count,
    'activeAlarmCount', active_alarm_count
  );
end
$$;

create function public.service_process_due_sygtasks_reminders(target_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  due_record record;
  notification_id uuid;
  delivery_number integer;
  triggered_count integer := 0;
  cancelled_count integer := 0;
  notification_priority text;
  notification_title text;
  notification_body text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  for due_record in
    select
      occurrence.id as occurrence_id,
      occurrence.recipient_employee_id,
      occurrence.delivery_count,
      reminder.id as reminder_id,
      reminder.kind,
      reminder.email_enabled,
      reminder.required_acknowledgement,
      reminder.created_by,
      reminder.recipient_scope,
      task.id as task_id,
      task.board_id,
      task.title,
      task.priority,
      task.due_at
    from private.sygtasks_task_reminder_occurrences occurrence
    join private.sygtasks_task_reminders reminder on reminder.id = occurrence.reminder_id
    join private.sygtasks_tasks task on task.id = reminder.task_id
    where (
      (occurrence.state = 'scheduled' and occurrence.scheduled_for <= clock_timestamp())
      or (occurrence.state = 'snoozed' and occurrence.snoozed_until <= clock_timestamp())
    )
    order by coalesce(occurrence.snoozed_until, occurrence.scheduled_for), occurrence.id
    limit least(greatest(coalesce(target_limit, 100), 1), 250)
    for update of occurrence skip locked
  loop
    if not exists (
      select 1
      from public.employees employee
      join private.employee_accounts account on account.employee_id = employee.id
      where employee.id = due_record.recipient_employee_id
        and employee.status = 'active'
        and account.disabled_at is null
    )
    or not private.sygtasks_can_view_task(due_record.recipient_employee_id, due_record.task_id)
    or (due_record.recipient_scope = 'assignees' and not exists (
      select 1 from private.sygtasks_task_assignees assignee
      where assignee.task_id = due_record.task_id
        and assignee.employee_id = due_record.recipient_employee_id
        and assignee.removed_at is null
    ))
    then
      update private.sygtasks_task_reminder_occurrences occurrence
      set state = 'cancelled', cancelled_at = clock_timestamp(), cancellation_reason = 'recipient_ineligible',
          snoozed_until = null, version = occurrence.version + 1, updated_at = clock_timestamp()
      where occurrence.id = due_record.occurrence_id;
      perform private.signal_employee_update(
        due_record.recipient_employee_id,
        jsonb_build_object('kind', 'sygtasks_alarm', 'taskId', due_record.task_id, 'isNew', false)
      );
      cancelled_count := cancelled_count + 1;
      continue;
    end if;

    delivery_number := due_record.delivery_count + 1;
    notification_priority := case due_record.priority when 'urgent' then 'urgent' when 'high' then 'important' else 'routine' end;
    notification_title := case due_record.kind when 'alarm' then 'Task alarm: ' else 'Task reminder: ' end || due_record.title;
    notification_body := concat(
      case due_record.kind when 'alarm' then 'This task alarm needs your attention.' else 'This task reminder is ready.' end,
      case when due_record.due_at is null then '' else concat(
        E'\n\nTask due: ',
        to_char(due_record.due_at at time zone 'America/Denver', 'MM/DD/YYYY FMHH12:MI AM'),
        ' (', to_char(due_record.due_at at time zone 'America/Denver', 'HH24:MI'), ') Mountain Time.'
      ) end
    );

    notification_id := private.create_employee_notification(
      due_record.recipient_employee_id,
      'sygtasks',
      due_record.task_id,
      concat('sygtasks-reminder:', due_record.occurrence_id, ':', delivery_number),
      notification_title,
      notification_body,
      notification_priority,
      due_record.required_acknowledgement,
      concat('/tasks?board=', due_record.board_id, '&task=', due_record.task_id),
      'Open task',
      due_record.created_by
    );

    if due_record.email_enabled and notification_id is not null then
      insert into public.employee_notification_email_deliveries(notification_id, recipient_employee_id, subject, body)
      values (
        notification_id,
        due_record.recipient_employee_id,
        concat('[SygShift SygTasks] ', notification_title),
        concat(notification_body, E'\n\nOpen SygTasks: https://app.sygilant.us/tasks?board=', due_record.board_id, '&task=', due_record.task_id)
      );
    end if;

    update private.sygtasks_task_reminder_occurrences occurrence
    set state = 'triggered', delivery_count = delivery_number,
        last_notification_id = coalesce(notification_id, occurrence.last_notification_id),
        triggered_at = clock_timestamp(), snoozed_until = null,
        version = occurrence.version + 1, updated_at = clock_timestamp()
    where occurrence.id = due_record.occurrence_id;
    perform private.signal_employee_update(
      due_record.recipient_employee_id,
      jsonb_build_object('kind', case due_record.kind when 'alarm' then 'sygtasks_alarm' else 'sygtasks_reminder' end, 'taskId', due_record.task_id, 'isNew', true)
    );
    triggered_count := triggered_count + 1;
  end loop;

  return jsonb_build_object(
    'processed', triggered_count + cancelled_count,
    'triggered', triggered_count,
    'cancelled', cancelled_count
  );
end
$$;

revoke all on function private.sygtasks_employee_name(uuid), private.sygtasks_reminder_scheduled_for(private.sygtasks_task_reminders, private.sygtasks_tasks), private.reconcile_sygtasks_reminder(uuid), private.reconcile_sygtasks_task_reminders_from_task(), private.reconcile_sygtasks_task_reminders_from_assignee() from public, anon, authenticated;
revoke all on function public.get_sygtasks_task_reminders(uuid), public.create_sygtasks_task_reminder(jsonb, uuid), public.cancel_sygtasks_task_reminder(uuid, uuid), public.manage_my_sygtasks_alarm(text, uuid, integer, uuid), public.get_my_sygtasks_alarm_state(), public.get_my_sygtasks_badge(), public.service_process_due_sygtasks_reminders(integer) from public, anon, authenticated;
grant execute on function public.get_sygtasks_task_reminders(uuid), public.create_sygtasks_task_reminder(jsonb, uuid), public.cancel_sygtasks_task_reminder(uuid, uuid), public.manage_my_sygtasks_alarm(text, uuid, integer, uuid), public.get_my_sygtasks_alarm_state(), public.get_my_sygtasks_badge() to authenticated;
grant execute on function public.service_process_due_sygtasks_reminders(integer) to service_role;

notify pgrst, 'reload schema';
commit;

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.create_sygtasks_task_reminder(
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
  selected_task_id uuid;
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

  begin selected_task_id := (clean_payload ->> 'taskId')::uuid;
  exception when others then raise check_violation using message = 'Choose a valid task.'; end;
  clean_kind := lower(btrim(coalesce(clean_payload ->> 'kind', 'reminder')));
  clean_scope := lower(btrim(coalesce(clean_payload ->> 'recipientScope', 'self')));
  clean_timing := lower(btrim(coalesce(clean_payload ->> 'timingKind', 'relative')));
  begin clean_email := coalesce((clean_payload ->> 'emailEnabled')::boolean, false);
  exception when others then raise check_violation using message = 'Choose whether email delivery is enabled.'; end;

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
  where task.id = selected_task_id
  for share;
  if task_record.id is null or not private.sygtasks_can_view_task(actor_id, selected_task_id) then
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
    where assignee.task_id = selected_task_id and assignee.removed_at is null
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
    selected_task_id, actor_id, clean_kind, clean_scope, clean_timing, clean_offset,
    clean_absolute, clean_email, clean_kind = 'alarm'
  ) returning * into reminder_record;

  perform private.reconcile_sygtasks_reminder(reminder_record.id);
  perform private.sygtasks_record_activity(
    actor_id, task_record.board_id, selected_task_id, 'reminder.created', 'task', selected_task_id,
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
    'taskId', selected_task_id,
    'kind', clean_kind,
    'recipientScope', clean_scope,
    'changed', true
  );
  insert into private.sygtasks_action_requests(actor_employee_id, client_request_id, action, request_hash, response)
  values (actor_id, target_client_request_id, 'create_reminder', request_fingerprint, result);
  return result;
end
$$;

revoke all on function public.create_sygtasks_task_reminder(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_sygtasks_task_reminder(jsonb, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

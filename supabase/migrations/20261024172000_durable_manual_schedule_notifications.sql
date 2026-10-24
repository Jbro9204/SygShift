begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The legacy minute-bucket key can change while an HTTP response is in
-- flight, allowing a retry to enqueue a second company-wide notice. Require a
-- client operation UUID and bind its first schedule/actor/note manifest to the
-- outbox row. The outbox is already the durable delivery authority, so no
-- parallel operation table is needed.
drop function if exists public.queue_schedule_published_notification(uuid, text);

create function private.schedule_notification_delivery_snapshot(target_schedule_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  schedule_record public.schedules%rowtype;
  recipient_snapshot jsonb;
  assigned_shift_count integer;
  open_slot_count integer;
begin
  select schedule.* into schedule_record
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if schedule_record.id is null or schedule_record.status <> 'published' then
    raise check_violation using message = 'Publish the schedule before sending a schedule notification.';
  end if;

  select coalesce(jsonb_agg(candidate.email order by candidate.email), '[]'::jsonb)
  into recipient_snapshot
  from (
    select distinct private.preferred_delivery_email(contact.personal_email, contact.company_email) as email
    from public.employees employee
    join private.employee_contacts contact on contact.employee_id = employee.id
    left join private.employee_notification_preferences preference on preference.employee_id = employee.id
    where employee.status = 'active'
      and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
      and coalesce(preference.schedule_published, true)
      and (
        employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
        or exists (
          select 1
          from public.shift_assignments assignment
          join public.shifts shift on shift.id = assignment.shift_id
          where shift.schedule_id = schedule_record.id
            and shift.canceled_at is null
            and assignment.employee_id = employee.id
            and assignment.status <> 'canceled'
        )
      )
  ) candidate;

  if jsonb_array_length(recipient_snapshot) > 500 then
    raise check_violation using message = 'A schedule notice cannot target more than 500 unique email recipients.';
  end if;

  select count(*)::integer into assigned_shift_count
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  where shift.schedule_id = schedule_record.id
    and shift.canceled_at is null
    and assignment.status <> 'canceled';

  select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)::integer
  into open_slot_count
  from public.shifts shift
  left join lateral (
    select count(*)::integer as active_assignments
    from public.shift_assignments assignment
    where assignment.shift_id = shift.id
      and assignment.status <> 'canceled'
  ) assignment_counts on true
  where shift.schedule_id = schedule_record.id
    and shift.canceled_at is null;

  return jsonb_build_object(
    'recipients', recipient_snapshot,
    'message', jsonb_build_object(
      'subject', concat('SygShift schedule updated: ', to_char(schedule_record.week_starts_on, 'MM/DD/YYYY'), ' week'),
      'text', concat(
        'The SygShift schedule for ',
        to_char(schedule_record.week_starts_on, 'MM/DD/YYYY'),
        ' through ',
        to_char(schedule_record.week_starts_on + 6, 'MM/DD/YYYY'),
        ' has been published.',
        E'\n\nOpen SygShift to review your assigned shifts, open coverage, and any changes that affect your week.',
        E'\n\nRevision: ', schedule_record.revision,
        E'\nAssigned shifts: ', assigned_shift_count,
        E'\nOpen slots: ', open_slot_count
      ),
      'html', concat(
        '<p>The SygShift schedule for <strong>',
        to_char(schedule_record.week_starts_on, 'MM/DD/YYYY'),
        ' through ',
        to_char(schedule_record.week_starts_on + 6, 'MM/DD/YYYY'),
        '</strong> has been published.</p>',
        '<p>Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.</p>',
        '<ul><li><strong>Revision:</strong> ', schedule_record.revision, '</li>',
        '<li><strong>Assigned shifts:</strong> ', assigned_shift_count, '</li>',
        '<li><strong>Open slots:</strong> ', open_slot_count, '</li></ul>'
      )
    )
  );
end
$$;

create function public.queue_schedule_published_notification(
  target_schedule_id uuid,
  target_operation_id uuid,
  notification_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  published_schedule public.schedules%rowtype;
  queued_notification private.notification_outbox%rowtype;
  clean_note text := nullif(btrim(coalesce(notification_note, '')), '');
  delivery_snapshot jsonb;
  idempotency text;
  inserted_new boolean := false;
begin
  if actor_id is null
    or not private.can_manage_schedule_drafts()
    or not public.has_effective_permission('announcements.send')
  then
    raise insufficient_privilege using message = 'MFA-verified schedule and announcement-send access is required to send schedule notifications.';
  end if;
  if target_schedule_id is null then
    raise check_violation using message = 'A published schedule is required.';
  end if;
  if target_operation_id is null then
    raise check_violation using message = 'A schedule notification operation is required.';
  end if;
  if clean_note is not null and char_length(clean_note) > 2000 then
    raise check_violation using message = 'Schedule notification notes must be 2,000 characters or fewer.';
  end if;

  idempotency := 'schedule-published-manual-operation:' || target_operation_id::text;

  -- Replay the first committed manifest before consulting mutable schedule
  -- state. A response-loss retry remains valid even if a newer draft/publish
  -- action has happened since the original notice was queued.
  select outbox.* into queued_notification
  from private.notification_outbox outbox
  where outbox.idempotency_key = idempotency;

  if not found then
    select schedule.* into published_schedule
    from public.schedules schedule
    where schedule.id = target_schedule_id;

    if published_schedule.id is null or published_schedule.status <> 'published' then
      raise check_violation using message = 'Publish the schedule before sending a schedule notification.';
    end if;

    delivery_snapshot := private.schedule_notification_delivery_snapshot(target_schedule_id);

    insert into private.notification_outbox (
      message_type,
      aggregate_type,
      aggregate_id,
      payload,
      idempotency_key
    ) values (
      'schedule_published',
      'schedule',
      target_schedule_id,
      jsonb_build_object(
        'weekStartsOn', published_schedule.week_starts_on,
        'weekEndsOn', published_schedule.week_starts_on + 6,
        'revision', published_schedule.revision,
        'publishedBy', published_schedule.published_by,
        'notificationRequestedBy', actor_id,
        'notificationNote', clean_note,
        'notificationOperationId', target_operation_id,
        'recipientManifestFrozen', true,
        'deliveryRecipients', delivery_snapshot -> 'recipients',
        'deliveryMessage', delivery_snapshot -> 'message'
      ),
      idempotency
    )
    on conflict (idempotency_key) do nothing
    returning * into queued_notification;
    inserted_new := found;

    if not inserted_new then
      select outbox.* into queued_notification
      from private.notification_outbox outbox
      where outbox.idempotency_key = idempotency;
    end if;
  end if;

  if queued_notification.id is null
    or queued_notification.message_type <> 'schedule_published'
    or queued_notification.aggregate_type <> 'schedule'
    or queued_notification.aggregate_id is distinct from target_schedule_id
    or queued_notification.payload ->> 'notificationOperationId' is distinct from target_operation_id::text
    or queued_notification.payload ->> 'notificationRequestedBy' is distinct from actor_id::text
    or coalesce(queued_notification.payload ->> 'notificationNote', '') is distinct from coalesce(clean_note, '')
  then
    raise check_violation using message = 'schedule_notification_operation_conflict';
  end if;

  if inserted_new then
    insert into private.audit_events (
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      old_record,
      new_record
    ) values (
      auth.uid(),
      actor_id,
      'private',
      'notification_outbox',
      'queue_schedule_notification',
      queued_notification.id::text,
      null,
      jsonb_build_object(
        'operation_id', target_operation_id,
        'schedule_id', target_schedule_id,
        'week_starts_on', queued_notification.payload ->> 'weekStartsOn',
        'revision', (queued_notification.payload ->> 'revision')::integer,
        'notification_id', queued_notification.id
      )
    );
  end if;

  return jsonb_build_object(
    'operationId', target_operation_id,
    'notificationId', queued_notification.id,
    'scheduleId', queued_notification.aggregate_id,
    'weekStartsOn', queued_notification.payload ->> 'weekStartsOn',
    'weekEndsOn', queued_notification.payload ->> 'weekEndsOn',
    'revision', (queued_notification.payload ->> 'revision')::integer,
    'deliveryState', case
      when exists (
        select 1 from private.email_recipient_dispatches dispatch
        where dispatch.source_kind = 'notification_outbox'
          and dispatch.source_id = queued_notification.id
          and dispatch.state in ('dispatching', 'uncertain', 'retry_approved')
      ) then 'unresolved'
      when exists (
        select 1 from private.email_recipient_dispatches dispatch
        where dispatch.source_kind = 'notification_outbox'
          and dispatch.source_id = queued_notification.id
          and dispatch.state = 'accepted'
      ) and not exists (
        select 1 from private.email_recipient_dispatches dispatch
        where dispatch.source_kind = 'notification_outbox'
          and dispatch.source_id = queued_notification.id
          and dispatch.state not in ('accepted', 'suppressed')
      ) then 'delivered'
      when exists (
        select 1 from private.email_recipient_dispatches dispatch
        where dispatch.source_kind = 'notification_outbox'
          and dispatch.source_id = queued_notification.id
      ) and not exists (
        select 1 from private.email_recipient_dispatches dispatch
        where dispatch.source_kind = 'notification_outbox'
          and dispatch.source_id = queued_notification.id
          and dispatch.state <> 'suppressed'
      ) then 'suppressed'
      when queued_notification.delivered_at is not null then 'delivered'
      when queued_notification.failed_at is not null
        and queued_notification.last_error ilike 'Suppressed%'
        then 'suppressed'
      when queued_notification.failed_at is not null then 'failed'
      else 'pending'
    end,
    'attemptCount', queued_notification.attempt_count,
    'deliveredAt', queued_notification.delivered_at,
    'failedAt', queued_notification.failed_at
  );
end
$$;

-- Freeze the exact recipients and rendered schedule facts at queue time. The
-- ordinary batch lane and the targeted interactive lane both consume this
-- snapshot; neither re-resolves contacts, preferences, assignments, or counts.
alter function public.service_claim_notification_batch(integer)
  rename to service_claim_notification_batch_pre_schedule_snapshot;

create function public.service_claim_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  legacy_jobs jsonb;
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  legacy_jobs := public.service_claim_notification_batch_pre_schedule_snapshot(target_limit);
  select coalesce(jsonb_agg(
    case
      when job.value ->> 'messageType' = 'schedule_published'
        and outbox.payload -> 'recipientManifestFrozen' = 'true'::jsonb
      then (job.value - 'recipients' - 'message') || jsonb_build_object(
        'recipients', outbox.payload -> 'deliveryRecipients',
        'message', outbox.payload -> 'deliveryMessage',
        'recipientManifestFrozen', true
      )
      else job.value || jsonb_build_object('recipientManifestFrozen', false)
    end
    order by job.ordinality
  ), '[]'::jsonb)
  into claimed
  from jsonb_array_elements(legacy_jobs) with ordinality job(value, ordinality)
  left join private.notification_outbox outbox
    on outbox.id = (job.value ->> 'id')::uuid;

  return claimed;
end
$$;

create or replace function public.service_claim_notification_by_id(target_notification_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  outbox_record private.notification_outbox%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null then
    raise check_violation using message = 'Notification id is required.';
  end if;

  select * into outbox_record
  from private.notification_outbox outbox
  where outbox.id = target_notification_id
    and outbox.delivered_at is null
    and outbox.failed_at is null
    and outbox.available_at <= clock_timestamp()
    and outbox.attempt_count < 5
  for update skip locked;

  if outbox_record.id is null then
    return '[]'::jsonb;
  end if;
  if outbox_record.message_type <> 'schedule_published'
    or outbox_record.aggregate_type <> 'schedule'
    or outbox_record.payload -> 'recipientManifestFrozen' is distinct from 'true'::jsonb
    or jsonb_typeof(outbox_record.payload -> 'deliveryRecipients') <> 'array'
    or jsonb_typeof(outbox_record.payload -> 'deliveryMessage') <> 'object'
  then
    raise check_violation using message = 'Targeted delivery requires a queued schedule notification with a frozen manifest.';
  end if;

  update private.notification_outbox
  set attempted_at = clock_timestamp(),
      attempt_count = attempt_count + 1,
      last_error = null
  where id = outbox_record.id
  returning * into outbox_record;

  return jsonb_build_array(jsonb_build_object(
    'id', outbox_record.id,
    'messageType', outbox_record.message_type,
    'aggregateType', outbox_record.aggregate_type,
    'aggregateId', outbox_record.aggregate_id,
    'attemptCount', outbox_record.attempt_count,
    'recipients', outbox_record.payload -> 'deliveryRecipients',
    'message', outbox_record.payload -> 'deliveryMessage',
    'recipientManifestFrozen', true
  ));
end
$$;

revoke all on function public.queue_schedule_published_notification(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.queue_schedule_published_notification(uuid, uuid, text)
  to authenticated;
revoke all on function private.schedule_notification_delivery_snapshot(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.service_claim_notification_batch_pre_schedule_snapshot(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_notification_batch(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_notification_by_id(uuid)
  from public, anon, authenticated;
grant execute on function public.service_claim_notification_batch_pre_schedule_snapshot(integer)
  to service_role;
grant execute on function public.service_claim_notification_batch(integer)
  to service_role;
grant execute on function public.service_claim_notification_by_id(uuid)
  to service_role;

comment on function public.queue_schedule_published_notification(uuid, uuid, text) is
  'Queues or replays one manual schedule notice using a client-persisted operation UUID and immutable first-writer manifest.';

notify pgrst, 'reload schema';

commit;

set search_path = '';

create or replace function public.remove_schedule_draft_shift(
  target_shift_id uuid,
  removal_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  clean_note text := nullif(btrim(coalesce(removal_note, '')), '');
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified scheduler access is required to remove schedule shifts.';
  end if;

  if clean_note is not null and char_length(clean_note) > 2000 then
    raise check_violation using message = 'Removal notes must be 2,000 characters or fewer.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  if target_shift.canceled_at is not null then
    raise check_violation using message = 'This shift has already been removed.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Open a schedule draft before removing this shift.';
  end if;

  update public.shift_requests
  set
    status = 'canceled',
    decision_note = coalesce(clean_note, 'Removed from schedule draft.'),
    decided_by = actor_id,
    decided_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where shift_id = target_shift_id
    and status = 'pending';

  update public.shift_assignments
  set
    status = 'canceled',
    canceled_at = clock_timestamp(),
    cancellation_reason = coalesce(clean_note, 'Removed from schedule draft.'),
    updated_at = clock_timestamp()
  where shift_id = target_shift_id
    and status <> 'canceled';

  update public.shifts
  set
    is_open = false,
    canceled_at = clock_timestamp(),
    canceled_by = actor_id,
    cancellation_reason = coalesce(clean_note, 'Removed from schedule draft.'),
    updated_at = clock_timestamp()
  where id = target_shift_id;

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
    'public',
    'shifts',
    'soft_delete',
    target_shift_id::text,
    to_jsonb(target_shift),
    jsonb_build_object(
      'canceled_at', clock_timestamp(),
      'canceled_by', actor_id,
      'cancellation_reason', coalesce(clean_note, 'Removed from schedule draft.'),
      'schedule_id', target_schedule.id,
      'week_starts_on', target_schedule.week_starts_on
    )
  );

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end;
$$;

revoke all on function public.remove_schedule_draft_shift(uuid, text) from public, anon;
grant execute on function public.remove_schedule_draft_shift(uuid, text) to authenticated;

create or replace function public.publish_schedule_draft(target_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  draft_schedule public.schedules%rowtype;
  latest_published_id uuid;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to publish schedule drafts.';
  end if;

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if not found or draft_schedule.status <> 'draft' then
    raise check_violation using message = 'Only draft schedules can be published.';
  end if;

  select schedule.id into latest_published_id
  from public.schedules schedule
  where schedule.week_starts_on = draft_schedule.week_starts_on
    and schedule.status = 'published'
  order by schedule.revision desc
  limit 1;

  if latest_published_id is not null then
    update public.schedules
    set status = 'superseded'
    where id = latest_published_id;
  end if;

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id
  where id = target_schedule_id;

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
      'weekStartsOn', draft_schedule.week_starts_on,
      'weekEndsOn', draft_schedule.week_starts_on + 6,
      'revision', draft_schedule.revision,
      'publishedBy', actor_id
    ),
    'schedule-published:' || target_schedule_id::text
  )
  on conflict (idempotency_key) do nothing;

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
    'public',
    'schedules',
    'publish',
    target_schedule_id::text,
    to_jsonb(draft_schedule),
    jsonb_build_object(
      'status', 'published',
      'published_by', actor_id,
      'notification_queued', true,
      'previous_published_schedule_id', latest_published_id
    )
  );

  return public.get_weekly_schedule_payload(draft_schedule.week_starts_on);
end;
$$;

revoke all on function public.publish_schedule_draft(uuid) from public, anon;
grant execute on function public.publish_schedule_draft(uuid) to authenticated;

create or replace function public.service_claim_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(target_limit, 10), 1), 25);
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Only the service role can claim notification deliveries.';
  end if;

  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.delivered_at is null
      and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp()
      and outbox.attempt_count < 5
    order by outbox.available_at, outbox.created_at
    limit clean_limit
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set
      attempted_at = clock_timestamp(),
      attempt_count = outbox.attempt_count + 1,
      last_error = null
    from pending
    where outbox.id = pending.id
    returning outbox.*
  ), expanded as (
    select
      outbox.id,
      outbox.message_type,
      outbox.aggregate_type,
      outbox.aggregate_id,
      outbox.attempt_count,
      case
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select jsonb_build_object(
            'subject', 'Call-off reported',
            'text', concat(
              coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              ' reported a call-off. Open SygShift Requests to review and publish replacement coverage.'
            ),
            'html', concat(
              '<p><strong>', coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              '</strong> reported a call-off.</p><p>Open SygShift Requests to review and publish replacement coverage.</p>'
            )
          )
          from public.call_off_reports report
          join public.employees employee on employee.id = report.employee_id
          where report.id = outbox.aggregate_id
        )
        when outbox.message_type = 'announcement_published' then (
          select jsonb_build_object(
            'subject', announcement.title,
            'text', announcement.body,
            'html', concat('<p>', replace(announcement.body, E'\n', '<br>'), '</p>')
          )
          from public.announcements announcement
          where announcement.id = outbox.aggregate_id
        )
        when outbox.message_type = 'schedule_published' then (
          select jsonb_build_object(
            'subject', concat('SygShift schedule updated: ', to_char(schedule.week_starts_on, 'MM/DD/YYYY'), ' week'),
            'text', concat(
              'The SygShift schedule for ',
              to_char(schedule.week_starts_on, 'MM/DD/YYYY'),
              ' through ',
              to_char(schedule.week_starts_on + 6, 'MM/DD/YYYY'),
              ' has been published.',
              E'\n\n',
              'Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.',
              E'\n\n',
              'Revision: ', schedule.revision,
              E'\n',
              'Assigned shifts: ', (
                select count(*)
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
                  and assignment.status <> 'canceled'
              ),
              E'\n',
              'Open slots: ', (
                select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
                from public.shifts shift
                left join lateral (
                  select count(*)::integer as active_assignments
                  from public.shift_assignments assignment
                  where assignment.shift_id = shift.id
                    and assignment.status <> 'canceled'
                ) assignment_counts on true
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
              )
            ),
            'html', concat(
              '<p>The SygShift schedule for <strong>',
              to_char(schedule.week_starts_on, 'MM/DD/YYYY'),
              ' through ',
              to_char(schedule.week_starts_on + 6, 'MM/DD/YYYY'),
              '</strong> has been published.</p>',
              '<p>Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.</p>',
              '<ul>',
              '<li><strong>Revision:</strong> ', schedule.revision, '</li>',
              '<li><strong>Assigned shifts:</strong> ', (
                select count(*)
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
                  and assignment.status <> 'canceled'
              ), '</li>',
              '<li><strong>Open slots:</strong> ', (
                select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
                from public.shifts shift
                left join lateral (
                  select count(*)::integer as active_assignments
                  from public.shift_assignments assignment
                  where assignment.shift_id = shift.id
                    and assignment.status <> 'canceled'
                ) assignment_counts on true
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
              ), '</li>',
              '</ul>'
            )
          )
          from public.schedules schedule
          where schedule.id = outbox.aggregate_id
        )
        else jsonb_build_object(
          'subject', 'SygShift notification',
          'text', 'Open SygShift for details.',
          'html', '<p>Open SygShift for details.</p>'
        )
      end as message,
      case
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select coalesce(jsonb_agg(distinct coalesce(contact.company_email, contact.personal_email)), '[]'::jsonb)
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and employee.role in ('supervisor', 'admin')
            and coalesce(contact.company_email, contact.personal_email) is not null
        )
        when outbox.message_type = 'announcement_published' then (
          select coalesce(jsonb_agg(distinct coalesce(contact.company_email, contact.personal_email)), '[]'::jsonb)
          from public.announcements announcement
          left join public.shifts shift on shift.id = announcement.shift_id
          join public.employees employee on employee.status = 'active'
          join private.employee_contacts contact on contact.employee_id = employee.id
          where announcement.id = outbox.aggregate_id
            and employee.role in ('guard', 'supervisor', 'admin')
            and coalesce(contact.company_email, contact.personal_email) is not null
            and (
              coalesce(shift.requires_armed, announcement.kind = 'event' and exists (
                select 1 from public.events event where event.id = announcement.event_id and event.requires_armed
              )) is false
              or public.has_valid_credential(employee.id, 'armed_guard', current_date)
            )
        )
        when outbox.message_type = 'schedule_published' then (
          select coalesce(jsonb_agg(distinct coalesce(contact.company_email, contact.personal_email)), '[]'::jsonb)
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and coalesce(contact.company_email, contact.personal_email) is not null
            and (
              employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
              or exists (
                select 1
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = outbox.aggregate_id
                  and shift.canceled_at is null
                  and assignment.employee_id = employee.id
                  and assignment.status <> 'canceled'
              )
            )
        )
        else '[]'::jsonb
      end as recipients
    from touched outbox
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'messageType', message_type,
        'aggregateType', aggregate_type,
        'aggregateId', aggregate_id,
        'attemptCount', attempt_count,
        'recipients', recipients,
        'message', message
      )
      order by id
    ),
    '[]'::jsonb
  )
  into claimed
  from expanded;

  return claimed;
end
$$;

revoke all on function public.service_claim_notification_batch(integer) from public, anon, authenticated;
grant execute on function public.service_claim_notification_batch(integer) to service_role;

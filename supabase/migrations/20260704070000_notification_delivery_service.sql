begin;

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

create or replace function public.service_mark_notification_result(
  target_notification_id uuid,
  delivered boolean,
  delivery_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Only the service role can mark notification deliveries.';
  end if;

  if target_notification_id is null then
    raise exception 'Notification id is required.';
  end if;

  if delivered then
    update private.notification_outbox
    set
      delivered_at = clock_timestamp(),
      failed_at = null,
      last_error = null
    where id = target_notification_id
      and delivered_at is null;
  else
    update private.notification_outbox
    set
      failed_at = case when attempt_count >= 5 then clock_timestamp() else null end,
      last_error = left(coalesce(nullif(btrim(delivery_error), ''), 'Delivery failed.'), 1000),
      available_at = clock_timestamp() + interval '15 minutes'
    where id = target_notification_id
      and delivered_at is null;
  end if;
end
$$;

revoke all on function public.service_claim_notification_batch(integer) from public, anon, authenticated;
revoke all on function public.service_mark_notification_result(uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.service_claim_notification_batch(integer) to service_role;
grant execute on function public.service_mark_notification_result(uuid, boolean, text) to service_role;

commit;

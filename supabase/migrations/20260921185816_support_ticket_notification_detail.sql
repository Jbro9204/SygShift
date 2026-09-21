begin;

-- Administrators and every active handler who is explicitly authorized for a
-- ticket route must receive the work. The prior fallback-only Admin branch
-- made a ticket silently disappear from an Administrator's notification and
-- email queues whenever any non-Admin handler happened to qualify.
create or replace function private.support_notification_recipients(
  target_route_permission text
)
returns table (employee_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select employee.id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  where employee.status = 'active'
    and (
      employee.role = 'admin'
      or exists (
        select 1
        from public.employee_access_roles assignment
        join public.access_roles access_role
          on access_role.id = assignment.role_id
         and access_role.active
         and access_role.code = 'system_admin'
        where assignment.employee_id = employee.id
      )
      or (
        'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
        and 'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))
        and target_route_permission = any(private.employee_effective_permissions(employee.id))
      )
    )
$$;

-- Keep the in-app notification center aligned with the protected ticket email
-- without changing ticket routing, access, delivery, or workflow state. This
-- routine writes useful, privacy-aware context into the existing notification
-- record and deliberately preserves read, acknowledgement, and dismissal state.
create or replace function private.sync_support_ticket_notification_to_inbox(
  target_notification_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ticket_notification public.support_ticket_notifications%rowtype;
  ticket public.support_tickets%rowtype;
  submitter public.employees%rowtype;
  sender_employee_id uuid;
  route_label text;
  event_label text;
  display_subject text;
  preview text;
  impact_summary text;
  inbox_title text;
  inbox_body text;
  inbox_priority text;
begin
  select notification.*
  into ticket_notification
  from public.support_ticket_notifications notification
  where notification.id = target_notification_id;

  if not found then
    return;
  end if;

  select target.*
  into ticket
  from public.support_tickets target
  where target.id = ticket_notification.ticket_id;

  if not found
    or not private.support_employee_can_view(ticket_notification.recipient_employee_id, ticket)
  then
    return;
  end if;

  select employee.*
  into submitter
  from public.employees employee
  where employee.id = ticket.submitted_by;

  select coalesce(event.actor_id, ticket.submitted_by)
  into sender_employee_id
  from (select 1) seed
  left join public.support_ticket_events event
    on event.id = ticket_notification.event_id;

  select coalesce(permission.name, initcap(replace(ticket.route_permission, '.', ' ')))
  into route_label
  from (select 1) seed
  left join public.permission_catalog permission
    on permission.code = ticket.route_permission;

  event_label := case ticket_notification.message_type
    when 'support_ticket_opened' then case
      when ticket_notification.recipient_employee_id = ticket.submitted_by then 'Ticket opened'
      else 'New ticket'
    end
    when 'support_ticket_message' then 'New reply'
    when 'support_ticket_status' then 'Status updated'
    when 'support_ticket_assigned' then 'Assigned to you'
    else 'Ticket updated'
  end;

  display_subject := case
    when ticket.confidential then 'Private HR or workplace concern'
    else ticket.subject
  end;

  preview := case
    when ticket.confidential then 'Protected details are available only inside the authorized Support Tickets workspace.'
    when ticket_notification.message_type = 'support_ticket_message'
      then left(split_part(ticket_notification.body, E'\n\n', 1), 900)
    else left(ticket.description, 900)
  end;

  impact_summary := case
    when ticket.confidential then null
    else nullif(array_to_string(array_remove(array[
      case when ticket.impact ->> 'immediateSafety' = 'true' then 'Immediate safety concern' end,
      case when ticket.impact ->> 'unableToWork' = 'true' then 'Unable to work' end,
      case when ticket.impact ->> 'upcomingShiftAffected' = 'true' then 'Upcoming shift affected' end,
      case when ticket.impact ->> 'payAffected' = 'true' then 'Pay may be affected' end,
      case
        when coalesce(ticket.impact ->> 'affectedPeople', '') ~ '^[0-9]+$'
          then concat(ticket.impact ->> 'affectedPeople', ' ', case when ticket.impact ->> 'affectedPeople' = '1' then 'person affected' else 'people affected' end)
      end,
      case when nullif(ticket.impact ->> 'deadline', '') is not null then concat('Deadline ', ticket.impact ->> 'deadline') end
    ], null), ' · '), '')
  end;

  inbox_title := left(concat(
    'TKT-', lpad(ticket.ticket_number::text, 6, '0'),
    ' · ', event_label,
    ' · ', display_subject
  ), 200);

  inbox_body := left(concat(
    'Submitted by: ', btrim(concat(coalesce(submitter.preferred_name, submitter.first_name), ' ', submitter.last_name)),
    case when submitter.employee_number is null then '' else concat(' (', submitter.employee_number, ')') end,
    E'\nPriority: ', initcap(ticket.priority),
    ' · Status: ', initcap(replace(ticket.status, '_', ' ')),
    E'\nCategory: ', initcap(replace(ticket.category, '_', ' ')),
    ' · ', initcap(replace(ticket.subcategory, '_', ' ')),
    E'\nRouted to: ', route_label,
    case when impact_summary is null then '' else concat(E'\nImpact: ', impact_summary) end,
    E'\n\nSummary: ', preview
  ), 5000);

  inbox_priority := case ticket.priority
    when 'urgent' then 'urgent'
    when 'high' then 'important'
    else 'routine'
  end;

  insert into public.employee_notifications (
    recipient_employee_id,
    sender_employee_id,
    source_type,
    source_id,
    source_key,
    title,
    body,
    priority,
    requires_acknowledgement,
    action_path,
    action_label
  ) values (
    ticket_notification.recipient_employee_id,
    sender_employee_id,
    'support_ticket',
    ticket.id,
    concat('support-inbox:', ticket_notification.idempotency_key),
    inbox_title,
    inbox_body,
    inbox_priority,
    false,
    concat('/support?ticket=', ticket.id),
    'Open ticket'
  )
  on conflict (source_key) do update
  set
    sender_employee_id = excluded.sender_employee_id,
    title = excluded.title,
    body = excluded.body,
    priority = excluded.priority,
    action_path = excluded.action_path,
    action_label = excluded.action_label;
end
$$;

create or replace function private.mirror_support_ticket_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_support_ticket_notification_to_inbox(new.id);
  return new;
end
$$;

-- Restore a bounded set of currently actionable tickets that missed an
-- authorized queue recipient under the fallback-only routing rule. Existing
-- event-recipient rows are never duplicated.
do $$
declare
  target record;
  submitted_event_id bigint;
begin
  for target in
    select ticket.id as ticket_id, ticket.ticket_number, ticket.subject,
      ticket.description, recipient.employee_id as recipient_id
    from public.support_tickets ticket
    cross join lateral private.support_notification_recipients(ticket.route_permission) recipient
    where ticket.created_at >= clock_timestamp() - interval '14 days'
      and ticket.status not in ('resolved', 'closed')
      and recipient.employee_id <> ticket.submitted_by
      and not exists (
        select 1
        from public.support_ticket_notifications notification
        where notification.ticket_id = ticket.id
          and notification.recipient_employee_id = recipient.employee_id
          and notification.message_type = 'support_ticket_opened'
      )
  loop
    select event.id
    into submitted_event_id
    from public.support_ticket_events event
    where event.ticket_id = target.ticket_id
      and event.event_type = 'submitted'
    order by event.created_at, event.id
    limit 1;

    perform private.queue_support_ticket_notification(
      target.ticket_id,
      submitted_event_id,
      target.recipient_id,
      'support_ticket_opened',
      concat('[SygShift Ticket TKT-', lpad(target.ticket_number::text, 6, '0'), '] Ticket opened'),
      concat(
        E'A support ticket requires review in your authorized queue.\n\n',
        target.subject,
        E'\n\n',
        left(target.description, 900),
        E'\n\nOpen the Support Tickets workspace: https://app.sygilant.us/support?ticket=',
        target.ticket_id
      ),
      concat('support:routing-repair:', target.ticket_id, ':recipient:', target.recipient_id)
    );
  end loop;
end
$$;

-- Refresh only ticket notifications that are still present in a user's inbox.
-- Recent missing mirrors are restored, while older dismissed items remain
-- untouched and are not recreated.
do $$
declare
  notification_id uuid;
begin
  for notification_id in
    select ticket_notification.id
    from public.support_ticket_notifications ticket_notification
    join public.support_tickets ticket on ticket.id = ticket_notification.ticket_id
    where private.support_employee_can_view(ticket_notification.recipient_employee_id, ticket)
      and (
        ticket.created_at >= clock_timestamp() - interval '14 days'
        or exists (
          select 1
          from public.employee_notifications inbox_notification
          where inbox_notification.source_key = concat('support-inbox:', ticket_notification.idempotency_key)
            and inbox_notification.dismissed_at is null
        )
      )
  loop
    perform private.sync_support_ticket_notification_to_inbox(notification_id);
  end loop;
end
$$;

revoke all on function private.support_notification_recipients(text)
from public, anon, authenticated;
revoke all on function private.sync_support_ticket_notification_to_inbox(uuid)
from public, anon, authenticated;
revoke all on function private.mirror_support_ticket_notification()
from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

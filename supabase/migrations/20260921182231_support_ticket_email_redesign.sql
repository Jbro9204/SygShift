begin;

-- Enrich the existing protected support-ticket delivery contract. Recipient
-- routing, authorization, idempotency, delivery history, and retry behavior
-- remain unchanged; the Worker receives structured, privacy-aware context for
-- a useful mobile email instead of only a generic title and body.
create or replace function public.service_claim_support_ticket_notification_batch(
  target_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  update public.support_ticket_notifications notification
  set
    failed_at = clock_timestamp(),
    last_error = 'Recipient no longer has access to this support ticket.'
  from public.support_tickets ticket
  where ticket.id = notification.ticket_id
    and notification.delivered_at is null
    and notification.failed_at is null
    and not private.support_employee_can_view(notification.recipient_employee_id, ticket);

  with pending as (
    select notification.*
    from public.support_ticket_notifications notification
    join public.support_tickets ticket on ticket.id = notification.ticket_id
    where notification.delivered_at is null
      and notification.failed_at is null
      and notification.available_at <= clock_timestamp()
      and notification.attempt_count < 5
      and private.support_employee_can_view(notification.recipient_employee_id, ticket)
    order by notification.available_at, notification.created_at
    limit least(greatest(coalesce(target_limit, 25), 1), 50)
    for update of notification skip locked
  ), touched as (
    update public.support_ticket_notifications notification
    set
      attempted_at = clock_timestamp(),
      attempt_count = notification.attempt_count + 1,
      last_error = null,
      available_at = clock_timestamp() + interval '15 minutes'
    from pending
    where notification.id = pending.id
    returning notification.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', notification.id,
    'messageType', notification.message_type,
    'aggregateType', 'support_ticket',
    'aggregateId', notification.ticket_id,
    'attemptCount', notification.attempt_count,
    'recipients', case
      when private.preferred_delivery_email(contact.personal_email, contact.company_email) is null
        then '[]'::jsonb
      else jsonb_build_array(
        private.preferred_delivery_email(contact.personal_email, contact.company_email)
      )
    end,
    'message', jsonb_build_object(
      'subject', concat(
        '[TKT-', lpad(ticket.ticket_number::text, 6, '0'), '] ',
        case notification.message_type
          when 'support_ticket_opened' then 'New ticket'
          when 'support_ticket_message' then 'New reply'
          when 'support_ticket_status' then 'Status updated'
          when 'support_ticket_assigned' then 'Assigned to you'
          else 'Ticket updated'
        end,
        ' · ', initcap(ticket.priority),
        ' · ',
        case when ticket.confidential then 'Private HR or workplace concern' else ticket.subject end
      ),
      'text', concat(
        case notification.message_type
          when 'support_ticket_opened' then 'A new support ticket requires review.'
          when 'support_ticket_message' then 'A new reply was added to this support ticket.'
          when 'support_ticket_status' then 'The support ticket status changed.'
          when 'support_ticket_assigned' then 'This support ticket is assigned to you.'
          else 'This support ticket was updated.'
        end,
        E'\n\nTicket: TKT-', lpad(ticket.ticket_number::text, 6, '0'),
        E'\nSubject: ', case when ticket.confidential then 'Private HR or workplace concern' else ticket.subject end,
        E'\nSubmitted by: ', btrim(concat(coalesce(submitter.preferred_name, submitter.first_name), ' ', submitter.last_name)),
        case when submitter.employee_number is null then '' else concat(' (', submitter.employee_number, ')') end,
        E'\nPriority: ', initcap(ticket.priority),
        E'\nCategory: ', initcap(replace(ticket.category, '_', ' ')),
        E'\nStatus: ', initcap(replace(ticket.status, '_', ' ')),
        E'\nCreated: ', to_char(timezone('America/Denver', ticket.created_at), 'MM/DD/YYYY FMHH12:MI AM'), ' MT',
        E'\nRouted to: ', coalesce(permission.name, initcap(replace(ticket.route_permission, '.', ' '))),
        E'\n\nSummary:\n',
        case
          when ticket.confidential then 'Protected details are available only inside SygShift.'
          when notification.message_type = 'support_ticket_message'
            then left(split_part(notification.body, E'\n\n', 1), 700)
          else left(ticket.description, 700)
        end,
        E'\n\nOpen the ticket: https://app.sygilant.us/support?ticket=', ticket.id
      ),
      'supportTicket', jsonb_build_object(
        'ticketNumber', concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')),
        'eventLabel', case notification.message_type
          when 'support_ticket_opened' then 'New support ticket'
          when 'support_ticket_message' then 'New ticket reply'
          when 'support_ticket_status' then 'Ticket status changed'
          when 'support_ticket_assigned' then 'Ticket assigned'
          else 'Ticket updated'
        end,
        'subject', case when ticket.confidential then 'Private HR or workplace concern' else ticket.subject end,
        'preview', case
          when ticket.confidential then 'Protected details are available only inside SygShift.'
          when notification.message_type = 'support_ticket_message'
            then left(split_part(notification.body, E'\n\n', 1), 700)
          else left(ticket.description, 700)
        end,
        'submittedBy', btrim(concat(coalesce(submitter.preferred_name, submitter.first_name), ' ', submitter.last_name)),
        'employeeNumber', submitter.employee_number,
        'category', ticket.category,
        'subcategory', ticket.subcategory,
        'priority', ticket.priority,
        'status', ticket.status,
        'createdAt', ticket.created_at,
        'confidential', ticket.confidential,
        'routeLabel', coalesce(permission.name, initcap(replace(ticket.route_permission, '.', ' '))),
        'impact', case when ticket.confidential then '{}'::jsonb else ticket.impact end,
        'sourcePath', case when ticket.confidential then null else ticket.source_path end,
        'technicalContext', case
          when ticket.confidential or ticket.category <> 'technical' then '{}'::jsonb
          else ticket.technical_context
        end
      )
    )
  ) order by notification.created_at), '[]'::jsonb)
  into claimed
  from touched notification
  join public.support_tickets ticket on ticket.id = notification.ticket_id
  join public.employees submitter on submitter.id = ticket.submitted_by
  left join public.permission_catalog permission on permission.code = ticket.route_permission
  left join private.employee_contacts contact
    on contact.employee_id = notification.recipient_employee_id;

  return claimed;
end
$$;

revoke all on function public.service_claim_support_ticket_notification_batch(integer)
from public, anon, authenticated;
grant execute on function public.service_claim_support_ticket_notification_batch(integer) to service_role;

notify pgrst, 'reload schema';

commit;

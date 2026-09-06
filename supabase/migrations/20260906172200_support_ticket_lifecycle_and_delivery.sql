begin;

-- Keep the original closure timestamp and audit evidence; Resolved is the only
-- completion state going forward. This does not queue lifecycle emails.
with prior as materialized (
  select * from public.support_tickets where status = 'closed'
), changed as (
  update public.support_tickets ticket set status = 'resolved'
  from prior where ticket.id = prior.id returning ticket.*
)
insert into private.audit_events(schema_name, table_name, operation, row_id, old_record, new_record)
select 'public', 'support_tickets', 'NORMALIZE_COMPLETION_STATUS', changed.id::text, to_jsonb(prior), to_jsonb(changed)
from changed join prior on prior.id = changed.id;

alter table public.support_tickets drop constraint support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'reopened'));
alter table public.support_tickets add column submission_key uuid;
create unique index support_tickets_submission_key_idx on public.support_tickets(submitted_by, submission_key) where submission_key is not null;

create or replace function private.queue_support_ticket_notification(
  target_ticket_id uuid,
  target_event_id bigint,
  target_recipient_id uuid,
  target_message_type text,
  target_subject text,
  target_body text,
  target_idempotency_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.support_ticket_notifications (
    ticket_id, event_id, recipient_employee_id, message_type, subject, body, idempotency_key
  ) values (
    target_ticket_id, target_event_id, target_recipient_id, target_message_type,
    left(btrim(target_subject), 200), left(btrim(target_body), 5000),
    case when target_event_id is not null then concat('support:event:', target_event_id, ':recipient:', target_recipient_id) else target_idempotency_key end
  ) on conflict (idempotency_key) do nothing;
end
$$;

create or replace function public.submit_support_ticket(target_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  created_ticket public.support_tickets%rowtype;
  created_event_id bigint;
  clean_category text := nullif(btrim(target_input ->> 'category'), '');
  clean_subject text := nullif(btrim(target_input ->> 'subject'), '');
  clean_description text := nullif(btrim(target_input ->> 'description'), '');
  private_request boolean := coalesce((target_input ->> 'confidential')::boolean, false);
  route_code text;
  computed_priority text;
  handler record;
  receipt_body text;
  request_key uuid := nullif(target_input ->> 'requestId', '')::uuid;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if clean_category is null or clean_subject is null or clean_description is null then
    raise check_violation using message = 'Category, subject, and a complete description are required.';
  end if;
  if request_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(concat('support-submit:', actor_id, ':', request_key), 0));
    select * into created_ticket from public.support_tickets where submitted_by = actor_id and submission_key = request_key;
    if found then
      return jsonb_build_object('id', created_ticket.id, 'ticketNumber', concat('TKT-', lpad(created_ticket.ticket_number::text, 6, '0')), 'status', created_ticket.status, 'priority', created_ticket.priority);
    end if;
  end if;
  route_code := private.support_route_permission(clean_category, private_request);
  computed_priority := private.support_priority(clean_category, coalesce(target_input -> 'impact', '{}'::jsonb));

  insert into public.support_tickets (
    submission_key, submitted_by, subject, category, subcategory, description, occurred_on, still_happening,
    impact, related_context, source_path, technical_context, confidential, route_permission, priority
  ) values (
    request_key, actor_id, clean_subject, clean_category, coalesce(nullif(btrim(target_input ->> 'subcategory'), ''), 'other'), clean_description,
    nullif(target_input ->> 'occurredOn', '')::date, coalesce((target_input ->> 'stillHappening')::boolean, true),
    coalesce(target_input -> 'impact', '{}'::jsonb), coalesce(target_input -> 'relatedContext', '{}'::jsonb),
    nullif(btrim(target_input ->> 'sourcePath'), ''), coalesce(target_input -> 'technicalContext', '{}'::jsonb),
    private_request, route_code, computed_priority
  ) returning * into created_ticket;

  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (created_ticket.id, actor_id, 'submitted', jsonb_build_object('routePermission', route_code, 'priority', computed_priority, 'confidential', private_request))
  returning id into created_event_id;

  receipt_body := concat(
    'We received your support request TKT-', lpad(created_ticket.ticket_number::text, 6, '0'), E'.\n\n',
    created_ticket.subject, E'\n\n',
    E'Status: New\n',
    'Open SygShift to review updates: https://app.sygilant.us/support?ticket=', created_ticket.id
  );
  perform private.queue_support_ticket_notification(
    created_ticket.id, created_event_id, actor_id, 'support_ticket_opened',
    concat('[SygShift Ticket TKT-', lpad(created_ticket.ticket_number::text, 6, '0'), '] Ticket opened'),
    receipt_body, concat('support:', created_ticket.id, ':submitted:requester')
  );

  for handler in
    select employee.id
    from public.employees employee
    where employee.status = 'active'
      and employee.id <> actor_id
      and (
        employee.role = 'admin'
        or (
          'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
          and route_code = any(private.employee_effective_permissions(employee.id))
        )
      )
  loop
    perform private.queue_support_ticket_notification(
      created_ticket.id, created_event_id, handler.id, 'support_ticket_opened',
      concat('[SygShift Ticket TKT-', lpad(created_ticket.ticket_number::text, 6, '0'), '] Ticket opened'),
      concat(E'A support ticket has opened in your authorized queue.\n\n', clean_subject, E'\n\nOpen the Support Tickets workspace: https://app.sygilant.us/support?ticket=', created_ticket.id),
      concat('support:', created_ticket.id, ':submitted:handler:', handler.id)
    );
  end loop;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'support_tickets', 'SUBMIT', created_ticket.id::text,
    jsonb_build_object('ticketNumber', created_ticket.ticket_number, 'category', clean_category, 'routePermission', route_code, 'priority', computed_priority, 'confidential', private_request));

  return jsonb_build_object('id', created_ticket.id, 'ticketNumber', concat('TKT-', lpad(created_ticket.ticket_number::text, 6, '0')), 'status', created_ticket.status, 'priority', created_ticket.priority);
end
$$;

create or replace function public.get_support_workspace(target_input jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_page integer := least(greatest(coalesce((target_input ->> 'page')::integer, 1), 1), 100000);
  clean_size integer := case when coalesce((target_input ->> 'pageSize')::integer, 10) in (5, 10, 20) then coalesce((target_input ->> 'pageSize')::integer, 10) else 10 end;
  clean_status text := coalesce(nullif(target_input ->> 'status', ''), 'open');
  clean_search text := left(btrim(coalesce(target_input ->> 'search', '')), 120);
  total_rows bigint;
  rows_json jsonb;
  staff_access boolean;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if clean_status = 'closed' then clean_status := 'resolved'; end if;
  staff_access := public.current_app_role() = 'admin' or public.has_effective_permission('support.tickets.view');

  with visible as (
    select ticket.*
    from public.support_tickets ticket
    where private.support_can_view(ticket)
      and (clean_status = 'all' or (clean_status = 'open' and ticket.status not in ('resolved', 'closed')) or ticket.status = clean_status)
      and (clean_search = '' or ticket.subject ilike '%' || clean_search || '%' or concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')) ilike '%' || clean_search || '%')
  )
  select count(*) into total_rows from visible;

  with visible as (
    select ticket.*
    from public.support_tickets ticket
    where private.support_can_view(ticket)
      and (clean_status = 'all' or (clean_status = 'open' and ticket.status not in ('resolved', 'closed')) or ticket.status = clean_status)
      and (clean_search = '' or ticket.subject ilike '%' || clean_search || '%' or concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')) ilike '%' || clean_search || '%')
    order by case ticket.priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end, ticket.updated_at desc
    limit clean_size offset (clean_page - 1) * clean_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ticket.id, 'ticketNumber', concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')),
    'subject', ticket.subject, 'category', ticket.category, 'subcategory', ticket.subcategory,
    'status', ticket.status, 'priority', ticket.priority, 'confidential', ticket.confidential,
    'submittedBy', jsonb_build_object('id', submitter.id, 'name', concat(coalesce(nullif(submitter.preferred_name, ''), submitter.first_name), ' ', submitter.last_name)),
    'assignedTo', case when assignee.id is null then null else jsonb_build_object('id', assignee.id, 'name', concat(coalesce(nullif(assignee.preferred_name, ''), assignee.first_name), ' ', assignee.last_name)) end,
    'createdAt', ticket.created_at, 'updatedAt', ticket.updated_at
  ) order by case ticket.priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end, ticket.updated_at desc), '[]'::jsonb)
  into rows_json
  from visible ticket
  join public.employees submitter on submitter.id = ticket.submitted_by
  left join public.employees assignee on assignee.id = ticket.assigned_to;

  return jsonb_build_object(
    'tickets', rows_json,
    'page', jsonb_build_object('number', clean_page, 'size', clean_size, 'total', total_rows, 'totalPages', greatest(1, ceil(total_rows::numeric / clean_size)::integer)),
    'permissions', jsonb_build_object('staffAccess', staff_access, 'canManage', public.current_app_role() = 'admin' or public.has_effective_permission('support.tickets.manage'), 'isAdmin', public.current_app_role() = 'admin'),
    'unreadNotifications', (select count(*) from public.employee_notifications notification where notification.source_type = 'support_ticket' and notification.recipient_employee_id = actor_id and notification.read_at is null and notification.dismissed_at is null)
  );
end
$$;

create or replace function public.add_support_ticket_message(target_ticket_id uuid, target_body text, target_internal boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  ticket public.support_tickets%rowtype;
  message_id bigint;
  event_id bigint;
  previous_status text;
  recipient record;
  clean_body text := nullif(btrim(target_body), '');
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select * into ticket from public.support_tickets where id = target_ticket_id for update;
  if not found or not private.support_can_view(ticket) then raise insufficient_privilege using message = 'This support ticket is not available to your account.'; end if;
  if target_internal and not private.support_can_manage(ticket) then raise insufficient_privilege using message = 'Internal notes require ticket-management permission.'; end if;
  if clean_body is null then raise check_violation using message = 'Enter a message before sending.'; end if;

  insert into public.support_ticket_messages(ticket_id, author_id, visibility, body, email_requester)
  values (ticket.id, actor_id, case when target_internal then 'internal' else 'public' end, clean_body, not target_internal)
  returning id into message_id;
  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (ticket.id, actor_id, case when target_internal then 'internal_note_added' else 'message_added' end, jsonb_build_object('messageId', message_id)) returning id into event_id;

  previous_status := ticket.status;
  if not target_internal then
    update public.support_tickets set
      first_response_at = case when actor_id <> submitted_by then coalesce(first_response_at, clock_timestamp()) else first_response_at end,
      status = case when actor_id = submitted_by and status in ('waiting_on_employee', 'resolved', 'closed') then 'reopened' when actor_id <> submitted_by and status in ('new', 'assigned', 'reopened') then 'in_progress' else status end,
      resolved_at = case when actor_id = submitted_by and status in ('resolved', 'closed') then null else resolved_at end,
      updated_at = clock_timestamp()
    where id = ticket.id returning * into ticket;

    update public.support_ticket_events set detail = detail || jsonb_build_object('previousStatus', previous_status, 'status', ticket.status) where id = event_id;

    for recipient in
      select distinct employee.id
      from public.employees employee
      where employee.status = 'active' and employee.id <> actor_id and (
        employee.id = ticket.submitted_by
        or employee.role = 'admin'
        or ('support.tickets.view' = any(private.employee_effective_permissions(employee.id)) and ticket.route_permission = any(private.employee_effective_permissions(employee.id)))
      )
    loop
      perform private.queue_support_ticket_notification(
        ticket.id, event_id, recipient.id, 'support_ticket_message',
        concat('[SygShift Ticket TKT-', lpad(ticket.ticket_number::text, 6, '0'), '] ', ticket.subject),
        concat(clean_body, case when ticket.status is distinct from previous_status then concat(E'\n\nStatus: ', initcap(replace(ticket.status, '_', ' '))) else '' end, E'\n\nView and respond in SygShift: https://app.sygilant.us/support?ticket=', ticket.id),
        concat('support:', ticket.id, ':message:', message_id, ':recipient:', recipient.id)
      );
    end loop;
  else
    update public.support_tickets set updated_at = clock_timestamp() where id = ticket.id;
  end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'support_ticket_messages', case when target_internal then 'INTERNAL_NOTE' else 'PUBLIC_REPLY' end, message_id::text, jsonb_build_object('ticketId', ticket.id));
  return message_id;
end
$$;

create or replace function public.update_support_ticket(target_ticket_id uuid, target_changes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  ticket public.support_tickets%rowtype;
  old_record jsonb;
  new_status text;
  new_priority text;
  new_assignee uuid;
  event_id bigint;
  recipient record;
  status_changed boolean;
  assignment_changed boolean;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select * into ticket from public.support_tickets where id = target_ticket_id for update;
  if not found or not private.support_can_manage(ticket) then raise insufficient_privilege using message = 'Ticket-management permission is required.'; end if;
  old_record := to_jsonb(ticket);
  new_status := coalesce(nullif(target_changes ->> 'status', ''), ticket.status);
  if new_status = 'closed' then new_status := 'resolved'; end if;
  new_priority := coalesce(nullif(target_changes ->> 'priority', ''), ticket.priority);
  new_assignee := case when target_changes ? 'assignedTo' then nullif(target_changes ->> 'assignedTo', '')::uuid else ticket.assigned_to end;
  if new_status not in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'closed', 'reopened') then raise check_violation using message = 'Choose a valid ticket status.'; end if;
  if new_priority not in ('low', 'normal', 'high', 'urgent') then raise check_violation using message = 'Choose a valid ticket priority.'; end if;
  if new_assignee is not null and not exists (select 1 from public.employees employee where employee.id = new_assignee and employee.status = 'active' and (employee.role = 'admin' or (ticket.route_permission = any(private.employee_effective_permissions(employee.id)) and 'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))))) then
    raise check_violation using message = 'The selected employee is not authorized for this ticket queue.';
  end if;
  status_changed := new_status is distinct from ticket.status;
  assignment_changed := new_assignee is distinct from ticket.assigned_to;
  if not status_changed and not assignment_changed and new_priority = ticket.priority then return; end if;
  update public.support_tickets set
    status = new_status, priority = new_priority, assigned_to = new_assignee,
    resolved_at = case when new_status in ('resolved', 'closed') then coalesce(resolved_at, clock_timestamp()) else null end,
    updated_at = clock_timestamp()
  where id = ticket.id returning * into ticket;
  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (ticket.id, actor_id, 'ticket_updated', jsonb_build_object('status', ticket.status, 'previousStatus', old_record ->> 'status', 'priority', ticket.priority, 'assignedTo', ticket.assigned_to)) returning id into event_id;
  -- One action is one event, even when the requester is also the new assignee.
  for recipient in
    select employee.id from public.employees employee
    where employee.status = 'active' and employee.id <> actor_id
      and ((status_changed and employee.id = ticket.submitted_by)
        or (assignment_changed and employee.id = new_assignee))
  loop
    perform private.queue_support_ticket_notification(
      ticket.id, event_id, recipient.id,
      case when status_changed then 'support_ticket_status' else 'support_ticket_assigned' end,
      concat('[SygShift Ticket TKT-', lpad(ticket.ticket_number::text, 6, '0'), '] ',
        case when status_changed then concat('Ticket ', lower(replace(ticket.status, '_', ' '))) else 'Assigned to you' end),
      concat(ticket.subject,
        case when status_changed then concat(E'\n\nStatus: ', initcap(replace(ticket.status, '_', ' '))) else '' end,
        case when assignment_changed and recipient.id = new_assignee then E'\n\nThis ticket is assigned to you.' else '' end,
        E'\n\nView the ticket: https://app.sygilant.us/support?ticket=', ticket.id),
      concat('support:', ticket.id, ':update:', event_id, ':recipient:', recipient.id)
    );
  end loop;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values ((select auth.uid()), actor_id, 'public', 'support_tickets', 'UPDATE', ticket.id::text, old_record, to_jsonb(ticket));
end
$$;

create or replace function public.service_claim_support_ticket_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  with pending as (
    select notification.* from public.support_ticket_notifications notification
    where notification.delivered_at is null and notification.failed_at is null and notification.available_at <= clock_timestamp() and notification.attempt_count < 5
    order by notification.available_at, notification.created_at limit least(greatest(coalesce(target_limit, 25), 1), 50) for update skip locked
  ), touched as (
    update public.support_ticket_notifications notification set attempted_at = clock_timestamp(), attempt_count = notification.attempt_count + 1, last_error = null,
      available_at = clock_timestamp() + interval '15 minutes'
    from pending where notification.id = pending.id returning notification.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', notification.id, 'messageType', notification.message_type, 'aggregateType', 'support_ticket', 'aggregateId', notification.ticket_id,
    'attemptCount', notification.attempt_count,
    'recipients', case when private.preferred_delivery_email(contact.personal_email, contact.company_email) is null then '[]'::jsonb else jsonb_build_array(private.preferred_delivery_email(contact.personal_email, contact.company_email)) end,
    'message', jsonb_build_object('subject', notification.subject, 'text', notification.body)
  ) order by notification.created_at), '[]'::jsonb) into claimed
  from touched notification left join private.employee_contacts contact on contact.employee_id = notification.recipient_employee_id;
  return claimed;
end
$$;

create or replace function public.get_support_ticket(target_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  ticket public.support_tickets%rowtype;
  result jsonb;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select * into ticket from public.support_tickets where id = target_ticket_id;
  if not found or not private.support_can_view(ticket) then raise insufficient_privilege using message = 'This support ticket is not available to your account.'; end if;

  update public.support_ticket_notifications set read_at = coalesce(read_at, clock_timestamp()) where ticket_id = target_ticket_id and recipient_employee_id = actor_id and read_at is null;

  update public.employee_notifications set read_at = coalesce(read_at, clock_timestamp())
  where source_type = 'support_ticket' and source_id = target_ticket_id and recipient_employee_id = actor_id and read_at is null;

  select jsonb_build_object(
    'id', ticket.id, 'ticketNumber', concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')),
    'subject', ticket.subject, 'category', ticket.category, 'subcategory', ticket.subcategory, 'description', ticket.description,
    'occurredOn', ticket.occurred_on, 'stillHappening', ticket.still_happening, 'impact', ticket.impact,
    'relatedContext', ticket.related_context, 'sourcePath', ticket.source_path, 'confidential', ticket.confidential,
    'status', ticket.status, 'priority', ticket.priority, 'routePermission', ticket.route_permission,
    'submittedBy', jsonb_build_object('id', submitter.id, 'name', concat(coalesce(nullif(submitter.preferred_name, ''), submitter.first_name), ' ', submitter.last_name)),
    'assignedTo', case when assignee.id is null then null else jsonb_build_object('id', assignee.id, 'name', concat(coalesce(nullif(assignee.preferred_name, ''), assignee.first_name), ' ', assignee.last_name)) end,
    'createdAt', ticket.created_at, 'updatedAt', ticket.updated_at,
    'canManage', private.support_can_manage(ticket),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.id, 'body', message.body, 'visibility', message.visibility, 'createdAt', message.created_at,
        'author', jsonb_build_object('id', author.id, 'name', concat(coalesce(nullif(author.preferred_name, ''), author.first_name), ' ', author.last_name))
      ) order by message.created_at, message.id)
      from public.support_ticket_messages message
      join public.employees author on author.id = message.author_id
      where message.ticket_id = ticket.id and (message.visibility = 'public' or private.support_can_manage(ticket))
    ), '[]'::jsonb),
    'events', case when private.support_can_manage(ticket) then coalesce((
      select jsonb_agg(jsonb_build_object('id', event.id, 'type', event.event_type, 'detail', event.detail, 'createdAt', event.created_at, 'actorName', concat(coalesce(nullif(actor.preferred_name, ''), actor.first_name), ' ', actor.last_name)) order by event.created_at, event.id)
      from public.support_ticket_events event join public.employees actor on actor.id = event.actor_id where event.ticket_id = ticket.id
    ), '[]'::jsonb) else '[]'::jsonb end
  ) into result
  from public.employees submitter
  left join public.employees assignee on assignee.id = ticket.assigned_to
  where submitter.id = ticket.submitted_by;
  return result;
end
$$;

notify pgrst, 'reload schema';
commit;

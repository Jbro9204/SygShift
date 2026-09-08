begin;
set local lock_timeout = '5s';

-- Resolved is the single completed state shown to employees and handlers.
-- Normalize the brief legacy "closed" state before narrowing the constraint;
-- the update service below still accepts an old client value and maps it to
-- resolved so a cached browser cannot fail during rollout.
update public.support_tickets
set status = 'resolved'
where status = 'closed';

alter table public.support_tickets
  drop constraint if exists support_tickets_status_check;
alter table public.support_tickets
  add constraint support_tickets_status_check
  check (status in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'reopened'));

-- Dispatcher already participates in the additive role system through the
-- protected system role. Keep the operational role in place because Schedule,
-- Timekeeping, and Payroll still use it for operational defaults.
do $$
begin
  if not exists (
    select 1
    from public.access_roles access_role
    where access_role.code = 'system_dispatcher'
      and access_role.base_app_role = 'dispatcher'
      and access_role.system_role
      and access_role.protected
      and access_role.mfa_required
      and access_role.active
  ) then
    raise check_violation
      using message = 'The protected Dispatcher access-role mapping must exist before this migration can continue.';
  end if;
end
$$;

-- One policy calculation governs protected primary roles (including
-- Dispatcher) and additive roles. This removes the hard-coded role list from
-- session creation without changing any employee role or permission row.
create or replace function private.employee_requires_mfa(target_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and (
        exists (
          select 1
          from public.access_roles access_role
          where access_role.system_role
            and access_role.base_app_role = employee.role
            and access_role.active
            and access_role.mfa_required
        )
        or exists (
          select 1
          from public.employee_access_roles assignment
          join public.access_roles access_role on access_role.id = assignment.role_id
          where assignment.employee_id = employee.id
            and access_role.active
            and access_role.mfa_required
        )
        or exists (
          select 1
          from public.employee_permission_overrides permission_override
          join public.permission_catalog catalog on catalog.code = permission_override.permission_code
          where permission_override.employee_id = employee.id
            and permission_override.active
            and permission_override.effect = 'grant'
            and catalog.active
            and catalog.requires_mfa
        )
      )
  ), false)
$$;

create or replace function public.get_session_context()
returns table (
  employee_id uuid,
  username text,
  display_name text,
  role public.app_role,
  must_change_password boolean,
  password_changed_at timestamptz,
  mfa_enrolled_at timestamptz,
  mfa_required boolean,
  has_mfa boolean,
  permissions text[],
  time_zone text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise insufficient_privilege using message = 'A signed-in SygShift account is required.';
  end if;

  return query
  select
    employee.id,
    employee.username,
    coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
    employee.role,
    account.must_change_password,
    account.password_changed_at,
    account.mfa_enrolled_at,
    private.employee_requires_mfa(employee.id),
    public.has_mfa(),
    public.get_effective_permissions(),
    employee.time_zone
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;
end
$$;

-- Viewing every queue is an authorization capability; it is not an automatic
-- subscription to every ticket email. Operational handlers receive routed
-- work. Admins retain full access and are the safety fallback only when no
-- active non-Admin handler owns a route.
create or replace function private.support_employee_can_view(
  target_employee_id uuid,
  target_ticket public.support_tickets
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.employees employee
    join private.employee_accounts account
      on account.employee_id = employee.id
     and account.disabled_at is null
    where employee.id = target_employee_id
      and employee.status = 'active'
      and (
        employee.id = target_ticket.submitted_by
        or employee.role = 'admin'
        or (
          'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
          and target_ticket.route_permission = any(private.employee_effective_permissions(employee.id))
        )
      )
  ), false)
$$;

create or replace function private.support_employee_can_handle(
  target_employee_id uuid,
  target_route_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.employees employee
    join private.employee_accounts account
      on account.employee_id = employee.id
     and account.disabled_at is null
    where employee.id = target_employee_id
      and employee.status = 'active'
      and (
        employee.role = 'admin'
        or (
          'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
          and 'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))
          and target_route_permission = any(private.employee_effective_permissions(employee.id))
        )
      )
  ), false)
$$;

create or replace function private.support_notification_recipients(target_route_permission text)
returns table (employee_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with operational_handlers as materialized (
    select employee.id
    from public.employees employee
    join private.employee_accounts account
      on account.employee_id = employee.id
     and account.disabled_at is null
    where employee.status = 'active'
      and employee.role <> 'admin'
      and 'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
      and 'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))
      and target_route_permission = any(private.employee_effective_permissions(employee.id))
  )
  select handler.id from operational_handlers handler
  union all
  select employee.id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  where employee.status = 'active'
    and employee.role = 'admin'
    and not exists (select 1 from operational_handlers)
$$;

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
    case
      when target_event_id is not null
        then concat('support:event:', target_event_id, ':recipient:', target_recipient_id)
      else target_idempotency_key
    end
  ) on conflict do nothing;
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
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if clean_category is null or clean_subject is null or clean_description is null then
    raise check_violation using message = 'Category, subject, and a complete description are required.';
  end if;

  if request_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(concat('support-submit:', actor_id, ':', request_key), 0));
    select * into created_ticket
    from public.support_tickets
    where submitted_by = actor_id and submission_key = request_key;
    if found then
      return jsonb_build_object(
        'id', created_ticket.id,
        'ticketNumber', concat('TKT-', lpad(created_ticket.ticket_number::text, 6, '0')),
        'status', created_ticket.status,
        'priority', created_ticket.priority
      );
    end if;
  end if;

  route_code := private.support_route_permission(clean_category, private_request);
  computed_priority := private.support_priority(
    clean_category,
    coalesce(target_input -> 'impact', '{}'::jsonb)
  );

  insert into public.support_tickets (
    submission_key, submitted_by, subject, category, subcategory, description,
    occurred_on, still_happening, impact, related_context, source_path,
    technical_context, confidential, route_permission, priority
  ) values (
    request_key,
    actor_id,
    clean_subject,
    clean_category,
    coalesce(nullif(btrim(target_input ->> 'subcategory'), ''), 'other'),
    clean_description,
    nullif(target_input ->> 'occurredOn', '')::date,
    coalesce((target_input ->> 'stillHappening')::boolean, true),
    coalesce(target_input -> 'impact', '{}'::jsonb),
    coalesce(target_input -> 'relatedContext', '{}'::jsonb),
    nullif(btrim(target_input ->> 'sourcePath'), ''),
    coalesce(target_input -> 'technicalContext', '{}'::jsonb),
    private_request,
    route_code,
    computed_priority
  ) returning * into created_ticket;

  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (
    created_ticket.id,
    actor_id,
    'submitted',
    jsonb_build_object(
      'routePermission', route_code,
      'priority', computed_priority,
      'confidential', private_request
    )
  ) returning id into created_event_id;

  receipt_body := concat(
    'We received your support request TKT-',
    lpad(created_ticket.ticket_number::text, 6, '0'),
    E'.\n\n',
    created_ticket.subject,
    E'\n\nStatus: New\n',
    'Open SygShift to review updates: https://app.sygilant.us/support?ticket=',
    created_ticket.id
  );

  -- The requester receives one receipt for the opened event.
  perform private.queue_support_ticket_notification(
    created_ticket.id,
    created_event_id,
    actor_id,
    'support_ticket_opened',
    concat(
      '[SygShift Ticket TKT-',
      lpad(created_ticket.ticket_number::text, 6, '0'),
      '] Ticket opened'
    ),
    receipt_body,
    concat('support:', created_ticket.id, ':submitted:requester')
  );

  -- Only operational handlers for this permission route are alerted. Admin is
  -- a fallback route, not a duplicate recipient group.
  for handler in
    select recipient.employee_id as id
    from private.support_notification_recipients(route_code) recipient
    where recipient.employee_id <> actor_id
  loop
    perform private.queue_support_ticket_notification(
      created_ticket.id,
      created_event_id,
      handler.id,
      'support_ticket_opened',
      concat(
        '[SygShift Ticket TKT-',
        lpad(created_ticket.ticket_number::text, 6, '0'),
        '] Ticket opened'
      ),
      concat(
        E'A support ticket has opened in your authorized queue.\n\n',
        clean_subject,
        E'\n\nOpen the Support Tickets workspace: https://app.sygilant.us/support?ticket=',
        created_ticket.id
      ),
      concat('support:', created_ticket.id, ':submitted:handler:', handler.id)
    );
  end loop;

  insert into private.audit_events(
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'support_tickets',
    'SUBMIT',
    created_ticket.id::text,
    jsonb_build_object(
      'ticketNumber', created_ticket.ticket_number,
      'category', clean_category,
      'routePermission', route_code,
      'priority', computed_priority,
      'confidential', private_request
    )
  );

  return jsonb_build_object(
    'id', created_ticket.id,
    'ticketNumber', concat('TKT-', lpad(created_ticket.ticket_number::text, 6, '0')),
    'status', created_ticket.status,
    'priority', created_ticket.priority
  );
end
$$;

create or replace function public.add_support_ticket_message(
  target_ticket_id uuid,
  target_body text,
  target_internal boolean default false
)
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
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into ticket
  from public.support_tickets
  where id = target_ticket_id
  for update;

  if not found or not private.support_can_view(ticket) then
    raise insufficient_privilege using message = 'This support ticket is not available to your account.';
  end if;
  if target_internal and not private.support_can_manage(ticket) then
    raise insufficient_privilege using message = 'Internal notes require ticket-management permission.';
  end if;
  if clean_body is null then
    raise check_violation using message = 'Enter a message before sending.';
  end if;

  insert into public.support_ticket_messages(
    ticket_id, author_id, visibility, body, email_requester
  ) values (
    ticket.id,
    actor_id,
    case when target_internal then 'internal' else 'public' end,
    clean_body,
    not target_internal
  ) returning id into message_id;

  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (
    ticket.id,
    actor_id,
    case when target_internal then 'internal_note_added' else 'message_added' end,
    jsonb_build_object('messageId', message_id)
  ) returning id into event_id;

  previous_status := ticket.status;
  if not target_internal then
    update public.support_tickets
    set
      first_response_at = case
        when actor_id <> submitted_by then coalesce(first_response_at, clock_timestamp())
        else first_response_at
      end,
      status = case
        when actor_id = submitted_by and status in ('waiting_on_employee', 'resolved', 'closed') then 'reopened'
        when actor_id <> submitted_by and status in ('new', 'assigned', 'reopened') then 'in_progress'
        else status
      end,
      resolved_at = case
        when actor_id = submitted_by and status in ('resolved', 'closed') then null
        else resolved_at
      end,
      updated_at = clock_timestamp()
    where id = ticket.id
    returning * into ticket;

    update public.support_ticket_events
    set detail = detail || jsonb_build_object(
      'previousStatus', previous_status,
      'status', ticket.status
    )
    where id = event_id;

    if actor_id = ticket.submitted_by then
      -- Employee replies go to the assigned handler. If the ticket has not yet
      -- been assigned, its exact routed queue receives the update.
      if ticket.assigned_to is not null
        and ticket.assigned_to <> actor_id
        and private.support_employee_can_handle(ticket.assigned_to, ticket.route_permission)
      then
        perform private.queue_support_ticket_notification(
          ticket.id,
          event_id,
          ticket.assigned_to,
          'support_ticket_message',
          concat(
            '[SygShift Ticket TKT-',
            lpad(ticket.ticket_number::text, 6, '0'),
            '] ',
            ticket.subject
          ),
          concat(
            clean_body,
            case
              when ticket.status is distinct from previous_status
                then concat(E'\n\nStatus: ', initcap(replace(ticket.status, '_', ' ')))
              else ''
            end,
            E'\n\nView and respond in SygShift: https://app.sygilant.us/support?ticket=',
            ticket.id
          ),
          concat('support:', ticket.id, ':message:', message_id, ':recipient:', ticket.assigned_to)
        );
      else
        for recipient in
          select routed.employee_id as id
          from private.support_notification_recipients(ticket.route_permission) routed
          where routed.employee_id <> actor_id
        loop
          perform private.queue_support_ticket_notification(
            ticket.id,
            event_id,
            recipient.id,
            'support_ticket_message',
            concat(
              '[SygShift Ticket TKT-',
              lpad(ticket.ticket_number::text, 6, '0'),
              '] ',
              ticket.subject
            ),
            concat(
              clean_body,
              case
                when ticket.status is distinct from previous_status
                  then concat(E'\n\nStatus: ', initcap(replace(ticket.status, '_', ' ')))
                else ''
              end,
              E'\n\nView and respond in SygShift: https://app.sygilant.us/support?ticket=',
              ticket.id
            ),
            concat('support:', ticket.id, ':message:', message_id, ':recipient:', recipient.id)
          );
        end loop;
      end if;
    elsif ticket.submitted_by <> actor_id then
      -- Handler replies alert the requester only. Other queue viewers retain
      -- live access but are not emailed for a conversation they do not own.
      perform private.queue_support_ticket_notification(
        ticket.id,
        event_id,
        ticket.submitted_by,
        'support_ticket_message',
        concat(
          '[SygShift Ticket TKT-',
          lpad(ticket.ticket_number::text, 6, '0'),
          '] ',
          ticket.subject
        ),
        concat(
          clean_body,
          case
            when ticket.status is distinct from previous_status
              then concat(E'\n\nStatus: ', initcap(replace(ticket.status, '_', ' ')))
            else ''
          end,
          E'\n\nView and respond in SygShift: https://app.sygilant.us/support?ticket=',
          ticket.id
        ),
        concat('support:', ticket.id, ':message:', message_id, ':recipient:', ticket.submitted_by)
      );
    end if;
  else
    update public.support_tickets
    set updated_at = clock_timestamp()
    where id = ticket.id;
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'support_ticket_messages',
    case when target_internal then 'INTERNAL_NOTE' else 'PUBLIC_REPLY' end,
    message_id::text,
    jsonb_build_object('ticketId', ticket.id)
  );

  return message_id;
end
$$;

create or replace function public.get_support_ticket_assignees(target_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare ticket public.support_tickets%rowtype;
begin
  select * into ticket
  from public.support_tickets
  where id = target_ticket_id;

  if not found or not private.support_can_manage(ticket) then
    raise insufficient_privilege using message = 'Ticket-management permission is required.';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', employee.id,
        'name', concat(
          coalesce(nullif(employee.preferred_name, ''), employee.first_name),
          ' ',
          employee.last_name
        )
      )
      order by employee.last_name, employee.first_name
    )
    from public.employees employee
    where private.support_employee_can_handle(employee.id, ticket.route_permission)
  ), '[]'::jsonb);
end
$$;

create or replace function public.update_support_ticket(
  target_ticket_id uuid,
  target_changes jsonb
)
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
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into ticket
  from public.support_tickets
  where id = target_ticket_id
  for update;

  if not found or not private.support_can_manage(ticket) then
    raise insufficient_privilege using message = 'Ticket-management permission is required.';
  end if;

  old_record := to_jsonb(ticket);
  new_status := coalesce(nullif(target_changes ->> 'status', ''), ticket.status);
  if new_status = 'closed' then new_status := 'resolved'; end if;
  new_priority := coalesce(nullif(target_changes ->> 'priority', ''), ticket.priority);
  new_assignee := case
    when target_changes ? 'assignedTo' then nullif(target_changes ->> 'assignedTo', '')::uuid
    else ticket.assigned_to
  end;

  if new_status not in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'closed', 'reopened') then
    raise check_violation using message = 'Choose a valid ticket status.';
  end if;
  if new_priority not in ('low', 'normal', 'high', 'urgent') then
    raise check_violation using message = 'Choose a valid ticket priority.';
  end if;
  if new_assignee is not null
    and not private.support_employee_can_handle(new_assignee, ticket.route_permission)
  then
    raise check_violation using message = 'The selected employee is not authorized for this ticket queue.';
  end if;

  status_changed := new_status is distinct from ticket.status;
  assignment_changed := new_assignee is distinct from ticket.assigned_to;
  if not status_changed and not assignment_changed and new_priority = ticket.priority then
    return;
  end if;

  update public.support_tickets
  set
    status = new_status,
    priority = new_priority,
    assigned_to = new_assignee,
    resolved_at = case
      when new_status in ('resolved', 'closed') then coalesce(resolved_at, clock_timestamp())
      else null
    end,
    updated_at = clock_timestamp()
  where id = ticket.id
  returning * into ticket;

  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (
    ticket.id,
    actor_id,
    'ticket_updated',
    jsonb_build_object(
      'status', ticket.status,
      'previousStatus', old_record ->> 'status',
      'priority', ticket.priority,
      'assignedTo', ticket.assigned_to
    )
  ) returning id into event_id;

  -- Status changes alert the requester; assignment changes alert the assignee.
  -- A person matching both conditions receives one event-scoped notification.
  for recipient in
    select employee.id
    from public.employees employee
    where employee.id <> actor_id
      and (
        (
          status_changed
          and employee.id = ticket.submitted_by
          and private.support_employee_can_view(employee.id, ticket)
        )
        or (
          assignment_changed
          and employee.id = new_assignee
          and private.support_employee_can_handle(employee.id, ticket.route_permission)
        )
      )
  loop
    perform private.queue_support_ticket_notification(
      ticket.id,
      event_id,
      recipient.id,
      case when status_changed then 'support_ticket_status' else 'support_ticket_assigned' end,
      concat(
        '[SygShift Ticket TKT-',
        lpad(ticket.ticket_number::text, 6, '0'),
        '] ',
        case
          when status_changed then concat('Ticket ', lower(replace(ticket.status, '_', ' ')))
          else 'Assigned to you'
        end
      ),
      concat(
        ticket.subject,
        case
          when status_changed then concat(E'\n\nStatus: ', initcap(replace(ticket.status, '_', ' ')))
          else ''
        end,
        case
          when assignment_changed and recipient.id = new_assignee
            then E'\n\nThis ticket is assigned to you.'
          else ''
        end,
        E'\n\nView the ticket: https://app.sygilant.us/support?ticket=',
        ticket.id
      ),
      concat('support:', ticket.id, ':update:', event_id, ':recipient:', recipient.id)
    );
  end loop;

  insert into private.audit_events(
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'support_tickets',
    'UPDATE',
    ticket.id::text,
    old_record,
    to_jsonb(ticket)
  );
end
$$;


-- Ticket changes remain visible in real time to every person who may open the
-- ticket. This access/invalidation audience is intentionally broader than the
-- much smaller email-notification audience above.
create or replace function private.signal_support_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare recipient record;
begin
  for recipient in
    select employee.id
    from public.employees employee
    where private.support_employee_can_view(employee.id, new)
  loop
    perform private.signal_employee_update(
      recipient.id,
      jsonb_build_object('kind', 'support', 'id', new.id)
    );
  end loop;
  return new;
exception when others then
  raise warning 'Support live update deferred; SQLSTATE %', sqlstate;
  return new;
end
$$;

-- Bulk inbox operations suppress row-by-row broadcasts and send one recipient
-- invalidation after the transaction-safe update completes.
create or replace function private.signal_notification_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('sygshift.suppress_notification_signal', true), '') <> 'yes' then
    perform private.signal_employee_update(
      new.recipient_employee_id,
      jsonb_build_object(
        'kind', 'notification',
        'id', new.id,
        'isNew', tg_op = 'INSERT'
      )
    );
  end if;
  return new;
end
$$;

create or replace function public.clear_my_notifications()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clear_time timestamptz := clock_timestamp();
  prior_signal_setting text := current_setting('sygshift.suppress_notification_signal', true);
  marked_read_count integer := 0;
  dismissed_count integer := 0;
  remaining_required_count integer := 0;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(concat('notification-clear:', actor_id), 0));
  perform set_config('sygshift.suppress_notification_signal', 'yes', true);

  with candidates as materialized (
    select
      notification.id,
      notification.read_at is null as was_unread,
      (
        not notification.requires_acknowledgement
        or notification.acknowledged_at is not null
      ) as can_dismiss
    from public.employee_notifications notification
    where notification.recipient_employee_id = actor_id
      and notification.dismissed_at is null
      and (notification.expires_at is null or notification.expires_at > clear_time)
      and (
        notification.read_at is null
        or not notification.requires_acknowledgement
        or notification.acknowledged_at is not null
      )
    for update
  ), changed as (
    update public.employee_notifications notification
    set
      read_at = coalesce(notification.read_at, clear_time),
      dismissed_at = case
        when candidate.can_dismiss then coalesce(notification.dismissed_at, clear_time)
        else notification.dismissed_at
      end
    from candidates candidate
    where notification.id = candidate.id
    returning candidate.was_unread, candidate.can_dismiss
  )
  select
    (count(*) filter (where changed.was_unread))::integer,
    (count(*) filter (where changed.can_dismiss))::integer
  into marked_read_count, dismissed_count
  from changed;

  -- Keep the legacy ticket read ledger synchronized with its unified-inbox
  -- mirror without deleting either record or delivery history.
  update public.support_ticket_notifications ticket_notification
  set read_at = coalesce(ticket_notification.read_at, clear_time)
  where ticket_notification.recipient_employee_id = actor_id
    and ticket_notification.read_at is null
    and exists (
      select 1
      from public.employee_notifications notification
      where notification.recipient_employee_id = actor_id
        and notification.source_type = 'support_ticket'
        and notification.source_id = ticket_notification.ticket_id
        and notification.read_at is not null
    );

  select count(*)::integer
  into remaining_required_count
  from public.employee_notifications notification
  where notification.recipient_employee_id = actor_id
    and notification.dismissed_at is null
    and notification.requires_acknowledgement
    and notification.acknowledged_at is null
    and (notification.expires_at is null or notification.expires_at > clear_time);

  perform set_config(
    'sygshift.suppress_notification_signal',
    coalesce(prior_signal_setting, ''),
    true
  );

  if marked_read_count > 0 or dismissed_count > 0 then
    insert into private.audit_events(
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      (select auth.uid()),
      actor_id,
      'public',
      'employee_notifications',
      'CLEAR_ALL',
      actor_id::text,
      jsonb_build_object(
        'markedRead', marked_read_count,
        'dismissed', dismissed_count,
        'remainingRequired', remaining_required_count
      )
    );

    perform private.signal_employee_update(
      actor_id,
      jsonb_build_object('kind', 'notification', 'operation', 'clear_all')
    );
  end if;

  return jsonb_build_object(
    'markedRead', marked_read_count,
    'dismissed', dismissed_count,
    'remainingRequired', remaining_required_count
  );
end
$$;

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

  -- Do not release ticket content after an employee account is disabled or its
  -- routed access is removed. Preserve the outbox row as delivery evidence.
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
      'subject', notification.subject,
      'text', notification.body
    )
  ) order by notification.created_at), '[]'::jsonb)
  into claimed
  from touched notification
  left join private.employee_contacts contact
    on contact.employee_id = notification.recipient_employee_id;

  return claimed;
end
$$;

revoke all on function private.employee_requires_mfa(uuid) from public, anon, authenticated;
revoke all on function private.support_employee_can_view(uuid, public.support_tickets) from public, anon, authenticated;
revoke all on function private.support_employee_can_handle(uuid, text) from public, anon, authenticated;
revoke all on function private.support_notification_recipients(text) from public, anon, authenticated;
revoke all on function private.queue_support_ticket_notification(uuid, bigint, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function private.signal_support_update() from public, anon, authenticated;
revoke all on function private.signal_notification_update() from public, anon, authenticated;

revoke all on function public.get_session_context() from public, anon;
revoke all on function public.submit_support_ticket(jsonb) from public, anon;
revoke all on function public.add_support_ticket_message(uuid, text, boolean) from public, anon;
revoke all on function public.update_support_ticket(uuid, jsonb) from public, anon;
revoke all on function public.get_support_ticket_assignees(uuid) from public, anon;
revoke all on function public.clear_my_notifications() from public, anon;
revoke all on function public.service_claim_support_ticket_notification_batch(integer) from public, anon, authenticated;

grant execute on function public.get_session_context() to authenticated;
grant execute on function public.submit_support_ticket(jsonb) to authenticated;
grant execute on function public.add_support_ticket_message(uuid, text, boolean) to authenticated;
grant execute on function public.update_support_ticket(uuid, jsonb) to authenticated;
grant execute on function public.get_support_ticket_assignees(uuid) to authenticated;
grant execute on function public.clear_my_notifications() to authenticated;
grant execute on function public.service_claim_support_ticket_notification_batch(integer) to service_role;

notify pgrst, 'reload schema';
commit;

begin;

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('support.tickets.view', 'Administration', 'View support tickets', 'View support tickets routed to departments covered by the employee’s effective permissions.', 'sensitive', true, false, true),
  ('support.tickets.manage', 'Administration', 'Manage support tickets', 'Assign, reply to, and resolve support tickets routed to departments covered by the employee’s effective permissions.', 'sensitive', true, false, true)
on conflict (code) do update set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  active = true,
  updated_at = now();

with handler_permissions(permission_code) as (
  values
    ('schedule.manage'), ('time.manage'), ('time.export_payroll'), ('hr.people.manage'),
    ('hr.leave.manage'), ('hr.learning.manage'), ('hr.safety.manage'), ('hr.assets.manage'),
    ('sites.manage'), ('admin.users.manage'), ('admin.maintenance.manage'), ('clients.manage'),
    ('notifications.manage')
), handler_roles as (
  select distinct role_permission.role_id
  from public.access_role_permissions role_permission
  join handler_permissions handler on handler.permission_code = role_permission.permission_code
  where role_permission.enabled
  union
  select id from public.access_roles where code = 'system_admin'
), support_permissions(permission_code) as (
  values ('support.tickets.view'), ('support.tickets.manage')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select handler_role.role_id, support_permission.permission_code, true
from handler_roles handler_role
cross join support_permissions support_permission
on conflict (role_id, permission_code) do update set enabled = true, updated_at = now();

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number bigint generated always as identity unique,
  submitted_by uuid not null references public.employees(id) on delete restrict,
  subject text not null,
  category text not null,
  subcategory text not null,
  description text not null,
  occurred_on date,
  still_happening boolean not null default true,
  impact jsonb not null default '{}'::jsonb,
  related_context jsonb not null default '{}'::jsonb,
  source_path text,
  technical_context jsonb not null default '{}'::jsonb,
  confidential boolean not null default false,
  route_permission text not null references public.permission_catalog(code) on delete restrict,
  status text not null default 'new',
  priority text not null default 'normal',
  assigned_to uuid references public.employees(id) on delete restrict,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint support_tickets_subject_present check (char_length(btrim(subject)) between 5 and 160),
  constraint support_tickets_description_present check (char_length(btrim(description)) between 20 and 5000),
  constraint support_tickets_category_check check (category in ('schedule', 'timekeeping', 'payroll', 'human_resources', 'benefits_leave', 'training_compliance', 'site_post', 'equipment', 'safety', 'account_access', 'technical', 'client_request', 'other')),
  constraint support_tickets_status_check check (status in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'closed', 'reopened')),
  constraint support_tickets_priority_check check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint support_tickets_source_path_check check (source_path is null or (source_path like '/%' and char_length(source_path) <= 500)),
  constraint support_tickets_resolution_state_check check (
    (status not in ('resolved', 'closed') or resolved_at is not null)
    and (status <> 'closed' or closed_at is not null)
  )
);

create table public.support_ticket_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id) on delete restrict,
  author_id uuid not null references public.employees(id) on delete restrict,
  visibility text not null default 'public',
  body text not null,
  email_requester boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  constraint support_ticket_messages_visibility_check check (visibility in ('public', 'internal')),
  constraint support_ticket_messages_body_present check (char_length(btrim(body)) between 1 and 5000),
  constraint support_ticket_messages_internal_email_check check (visibility = 'public' or not email_requester)
);

create table public.support_ticket_events (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id) on delete restrict,
  actor_id uuid not null references public.employees(id) on delete restrict,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create table public.support_ticket_notifications (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete restrict,
  event_id bigint references public.support_ticket_events(id) on delete restrict,
  recipient_employee_id uuid not null references public.employees(id) on delete restrict,
  message_type text not null,
  subject text not null,
  body text not null,
  idempotency_key text not null unique,
  available_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint support_ticket_notifications_attempts_nonnegative check (attempt_count >= 0)
);

create index support_tickets_submitter_created_idx on public.support_tickets(submitted_by, created_at desc);
create index support_tickets_queue_idx on public.support_tickets(route_permission, status, updated_at desc);
create index support_tickets_assignee_open_idx on public.support_tickets(assigned_to, updated_at desc) where status not in ('closed');
create index support_ticket_messages_ticket_created_idx on public.support_ticket_messages(ticket_id, created_at);
create index support_ticket_events_ticket_created_idx on public.support_ticket_events(ticket_id, created_at);
create index support_ticket_notifications_recipient_idx on public.support_ticket_notifications(recipient_employee_id, read_at, created_at desc);
create index support_ticket_notifications_delivery_idx on public.support_ticket_notifications(available_at, created_at) where delivered_at is null and failed_at is null;

alter table public.support_tickets enable row level security;
alter table public.support_tickets force row level security;
alter table public.support_ticket_messages enable row level security;
alter table public.support_ticket_messages force row level security;
alter table public.support_ticket_events enable row level security;
alter table public.support_ticket_events force row level security;
alter table public.support_ticket_notifications enable row level security;
alter table public.support_ticket_notifications force row level security;

revoke all on table public.support_tickets, public.support_ticket_messages, public.support_ticket_events, public.support_ticket_notifications from public, anon, authenticated;
revoke all on sequence public.support_tickets_ticket_number_seq, public.support_ticket_messages_id_seq, public.support_ticket_events_id_seq from public, anon, authenticated;

create or replace function private.support_route_permission(target_category text, target_confidential boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when target_confidential or target_category = 'human_resources' then 'hr.people.manage'
    when target_category = 'schedule' then 'schedule.manage'
    when target_category = 'timekeeping' then 'time.manage'
    when target_category = 'payroll' then 'time.export_payroll'
    when target_category = 'benefits_leave' then 'hr.leave.manage'
    when target_category = 'training_compliance' then 'hr.learning.manage'
    when target_category = 'site_post' then 'sites.manage'
    when target_category = 'equipment' then 'hr.assets.manage'
    when target_category = 'safety' then 'hr.safety.manage'
    when target_category = 'account_access' then 'admin.users.manage'
    when target_category = 'technical' then 'admin.maintenance.manage'
    when target_category = 'client_request' then 'clients.manage'
    else 'notifications.manage'
  end
$$;

create or replace function private.support_priority(target_category text, target_impact jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce((target_impact ->> 'immediateSafety')::boolean, false) then 'urgent'
    when coalesce((target_impact ->> 'unableToWork')::boolean, false)
      or coalesce((target_impact ->> 'payAffected')::boolean, false)
      or coalesce((target_impact ->> 'upcomingShiftAffected')::boolean, false) then 'high'
    when target_category in ('payroll', 'safety', 'account_access') then 'high'
    else 'normal'
  end
$$;

create or replace function private.support_can_view(target_ticket public.support_tickets)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.current_employee_id() is not null
    and (
      target_ticket.submitted_by = private.current_employee_id()
      or public.current_app_role() = 'admin'
      or (
        public.has_effective_permission('support.tickets.view')
        and public.has_effective_permission(target_ticket.route_permission)
      )
    ),
    false
  )
$$;

create or replace function private.support_can_manage(target_ticket public.support_tickets)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.current_employee_id() is not null
    and (
      public.current_app_role() = 'admin'
      or (
        public.has_effective_permission('support.tickets.manage')
        and public.has_effective_permission(target_ticket.route_permission)
      )
    ),
    false
  )
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
    left(btrim(target_subject), 200), left(btrim(target_body), 5000), target_idempotency_key
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
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if clean_category is null or clean_subject is null or clean_description is null then
    raise check_violation using message = 'Category, subject, and a complete description are required.';
  end if;
  route_code := private.support_route_permission(clean_category, private_request);
  computed_priority := private.support_priority(clean_category, coalesce(target_input -> 'impact', '{}'::jsonb));

  insert into public.support_tickets (
    submitted_by, subject, category, subcategory, description, occurred_on, still_happening,
    impact, related_context, source_path, technical_context, confidential, route_permission, priority
  ) values (
    actor_id, clean_subject, clean_category, coalesce(nullif(btrim(target_input ->> 'subcategory'), ''), 'other'), clean_description,
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
    'Status: New\n',
    'Open SygShift to review updates: https://app.sygilant.us/support?ticket=', created_ticket.id
  );
  perform private.queue_support_ticket_notification(
    created_ticket.id, created_event_id, actor_id, 'support_ticket_received',
    concat('[SygShift Ticket TKT-', lpad(created_ticket.ticket_number::text, 6, '0'), '] Request received'),
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
      created_ticket.id, created_event_id, handler.id, 'support_ticket_queue_alert',
      concat('[SygShift Ticket TKT-', lpad(created_ticket.ticket_number::text, 6, '0'), '] New ', replace(clean_category, '_', ' '), ' request'),
      concat('A new support ticket requires your role.\n\n', clean_subject, E'\n\nOpen the Support Tickets workspace: https://app.sygilant.us/support?ticket=', created_ticket.id),
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
  staff_access := public.current_app_role() = 'admin' or public.has_effective_permission('support.tickets.view');

  with visible as (
    select ticket.*
    from public.support_tickets ticket
    where private.support_can_view(ticket)
      and (clean_status = 'all' or (clean_status = 'open' and ticket.status <> 'closed') or ticket.status = clean_status)
      and (clean_search = '' or ticket.subject ilike '%' || clean_search || '%' or concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')) ilike '%' || clean_search || '%')
  )
  select count(*) into total_rows from visible;

  with visible as (
    select ticket.*
    from public.support_tickets ticket
    where private.support_can_view(ticket)
      and (clean_status = 'all' or (clean_status = 'open' and ticket.status <> 'closed') or ticket.status = clean_status)
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
    'unreadNotifications', (select count(*) from public.support_ticket_notifications notification where notification.recipient_employee_id = actor_id and notification.read_at is null)
  );
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

  if not target_internal then
    update public.support_tickets set
      first_response_at = case when actor_id <> submitted_by then coalesce(first_response_at, clock_timestamp()) else first_response_at end,
      status = case when actor_id = submitted_by and status in ('waiting_on_employee', 'resolved', 'closed') then 'reopened' when actor_id <> submitted_by and status in ('new', 'assigned', 'reopened') then 'in_progress' else status end,
      resolved_at = case when actor_id = submitted_by and status in ('resolved', 'closed') then null else resolved_at end,
      closed_at = case when actor_id = submitted_by and status = 'closed' then null else closed_at end,
      updated_at = clock_timestamp()
    where id = ticket.id returning * into ticket;

    for recipient in
      select distinct employee.id
      from public.employees employee
      where employee.status = 'active' and employee.id <> actor_id and (
        employee.id = ticket.submitted_by
        or employee.id = ticket.assigned_to
        or employee.role = 'admin'
        or ('support.tickets.view' = any(private.employee_effective_permissions(employee.id)) and ticket.route_permission = any(private.employee_effective_permissions(employee.id)))
      )
    loop
      perform private.queue_support_ticket_notification(
        ticket.id, event_id, recipient.id, 'support_ticket_message',
        concat('[SygShift Ticket TKT-', lpad(ticket.ticket_number::text, 6, '0'), '] ', ticket.subject),
        concat(clean_body, E'\n\nView and respond in SygShift: https://app.sygilant.us/support?ticket=', ticket.id),
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
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select * into ticket from public.support_tickets where id = target_ticket_id for update;
  if not found or not private.support_can_manage(ticket) then raise insufficient_privilege using message = 'Ticket-management permission is required.'; end if;
  old_record := to_jsonb(ticket);
  new_status := coalesce(nullif(target_changes ->> 'status', ''), ticket.status);
  new_priority := coalesce(nullif(target_changes ->> 'priority', ''), ticket.priority);
  new_assignee := case when target_changes ? 'assignedTo' then nullif(target_changes ->> 'assignedTo', '')::uuid else ticket.assigned_to end;
  if new_status not in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'closed', 'reopened') then raise check_violation using message = 'Choose a valid ticket status.'; end if;
  if new_priority not in ('low', 'normal', 'high', 'urgent') then raise check_violation using message = 'Choose a valid ticket priority.'; end if;
  if new_assignee is not null and not exists (select 1 from public.employees employee where employee.id = new_assignee and employee.status = 'active' and (employee.role = 'admin' or (ticket.route_permission = any(private.employee_effective_permissions(employee.id)) and 'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))))) then
    raise check_violation using message = 'The selected employee is not authorized for this ticket queue.';
  end if;
  update public.support_tickets set
    status = new_status, priority = new_priority, assigned_to = new_assignee,
    resolved_at = case when new_status in ('resolved', 'closed') then coalesce(resolved_at, clock_timestamp()) else null end,
    closed_at = case when new_status = 'closed' then coalesce(closed_at, clock_timestamp()) else null end,
    updated_at = clock_timestamp()
  where id = ticket.id returning * into ticket;
  insert into public.support_ticket_events(ticket_id, actor_id, event_type, detail)
  values (ticket.id, actor_id, 'ticket_updated', jsonb_build_object('status', ticket.status, 'priority', ticket.priority, 'assignedTo', ticket.assigned_to)) returning id into event_id;
  perform private.queue_support_ticket_notification(
    ticket.id, event_id, ticket.submitted_by, 'support_ticket_status',
    concat('[SygShift Ticket TKT-', lpad(ticket.ticket_number::text, 6, '0'), '] Status updated'),
    concat('Your support ticket status is now ', replace(ticket.status, '_', ' '), E'.\n\n', ticket.subject, E'\n\nView the ticket: https://app.sygilant.us/support?ticket=', ticket.id),
    concat('support:', ticket.id, ':update:', event_id, ':requester')
  );
  if new_assignee is not null and new_assignee is distinct from (old_record ->> 'assigned_to')::uuid then
    perform private.queue_support_ticket_notification(ticket.id, event_id, new_assignee, 'support_ticket_assigned', concat('[SygShift Ticket TKT-', lpad(ticket.ticket_number::text, 6, '0'), '] Assigned to you'), concat(ticket.subject, E'\n\nOpen the ticket: https://app.sygilant.us/support?ticket=', ticket.id), concat('support:', ticket.id, ':assigned:', event_id, ':', new_assignee));
  end if;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values ((select auth.uid()), actor_id, 'public', 'support_tickets', 'UPDATE', ticket.id::text, old_record, to_jsonb(ticket));
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
  select * into ticket from public.support_tickets where id = target_ticket_id;
  if not found or not private.support_can_manage(ticket) then raise insufficient_privilege using message = 'Ticket-management permission is required.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', employee.id, 'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name)) order by employee.last_name, employee.first_name)
    from public.employees employee where employee.status = 'active' and (employee.role = 'admin' or (ticket.route_permission = any(private.employee_effective_permissions(employee.id)) and 'support.tickets.manage' = any(private.employee_effective_permissions(employee.id))))), '[]'::jsonb);
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
    update public.support_ticket_notifications notification set attempted_at = clock_timestamp(), attempt_count = notification.attempt_count + 1, last_error = null
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

create or replace function public.service_mark_support_ticket_notification_result(target_notification_id uuid, delivered boolean, delivery_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  update public.support_ticket_notifications set
    delivered_at = case when delivered then clock_timestamp() else delivered_at end,
    failed_at = case when not delivered and attempt_count >= 5 then clock_timestamp() else null end,
    last_error = case when delivered then null else left(coalesce(nullif(btrim(delivery_error), ''), 'Delivery failed.'), 1000) end,
    available_at = case when delivered then available_at else clock_timestamp() + interval '15 minutes' end
  where id = target_notification_id and delivered_at is null;
end
$$;

revoke all on function private.support_route_permission(text, boolean), private.support_priority(text, jsonb), private.support_can_view(public.support_tickets), private.support_can_manage(public.support_tickets), private.queue_support_ticket_notification(uuid, bigint, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_support_ticket(jsonb), public.get_support_workspace(jsonb), public.get_support_ticket(uuid), public.add_support_ticket_message(uuid, text, boolean), public.update_support_ticket(uuid, jsonb), public.get_support_ticket_assignees(uuid), public.service_claim_support_ticket_notification_batch(integer), public.service_mark_support_ticket_notification_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.submit_support_ticket(jsonb), public.get_support_workspace(jsonb), public.get_support_ticket(uuid), public.add_support_ticket_message(uuid, text, boolean), public.update_support_ticket(uuid, jsonb), public.get_support_ticket_assignees(uuid) to authenticated;
grant execute on function public.service_claim_support_ticket_notification_batch(integer), public.service_mark_support_ticket_notification_result(uuid, boolean, text) to service_role;

notify pgrst, 'reload schema';
commit;

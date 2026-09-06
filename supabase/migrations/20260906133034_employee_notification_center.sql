begin;

create table public.employee_notification_campaigns (
  id uuid primary key default gen_random_uuid(),
  sent_by uuid not null references public.employees(id) on delete restrict,
  title text not null,
  body text not null,
  priority text not null default 'routine',
  requires_acknowledgement boolean not null default false,
  email_enabled boolean not null default true,
  audience jsonb not null default '{}'::jsonb,
  recipient_count integer not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint employee_notification_campaigns_title_check check (char_length(btrim(title)) between 5 and 160),
  constraint employee_notification_campaigns_body_check check (char_length(btrim(body)) between 10 and 5000),
  constraint employee_notification_campaigns_priority_check check (priority in ('routine', 'important', 'urgent')),
  constraint employee_notification_campaigns_recipient_count_check check (recipient_count between 1 and 10000)
);

create table public.employee_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_employee_id uuid not null references public.employees(id) on delete restrict,
  campaign_id uuid references public.employee_notification_campaigns(id) on delete restrict,
  sender_employee_id uuid references public.employees(id) on delete restrict,
  source_type text not null,
  source_id uuid,
  source_key text not null unique,
  title text not null,
  body text not null,
  priority text not null default 'routine',
  requires_acknowledgement boolean not null default false,
  action_path text,
  action_label text,
  expires_at timestamptz,
  read_at timestamptz,
  acknowledged_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint employee_notifications_title_check check (char_length(btrim(title)) between 1 and 200),
  constraint employee_notifications_body_check check (char_length(btrim(body)) between 1 and 5000),
  constraint employee_notifications_priority_check check (priority in ('routine', 'important', 'urgent')),
  constraint employee_notifications_action_path_check check (action_path is null or (action_path like '/%' and char_length(action_path) <= 500)),
  constraint employee_notifications_action_label_check check (action_label is null or char_length(btrim(action_label)) between 1 and 80),
  constraint employee_notifications_ack_check check (acknowledged_at is null or read_at is not null)
);

create table public.employee_notification_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null unique references public.employee_notifications(id) on delete restrict,
  recipient_employee_id uuid not null references public.employees(id) on delete restrict,
  subject text not null,
  body text not null,
  available_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  constraint employee_notification_email_attempts_check check (attempt_count >= 0)
);

create index employee_notifications_inbox_idx
  on public.employee_notifications(recipient_employee_id, created_at desc)
  where dismissed_at is null;
create index employee_notifications_unread_idx
  on public.employee_notifications(recipient_employee_id, created_at desc)
  where read_at is null and dismissed_at is null;
create index employee_notifications_action_idx
  on public.employee_notifications(recipient_employee_id, created_at desc)
  where requires_acknowledgement and acknowledged_at is null and dismissed_at is null;
create index employee_notification_email_delivery_idx
  on public.employee_notification_email_deliveries(available_at, created_at)
  where delivered_at is null and failed_at is null;

alter table public.employee_notification_campaigns enable row level security;
alter table public.employee_notification_campaigns force row level security;
alter table public.employee_notifications enable row level security;
alter table public.employee_notifications force row level security;
alter table public.employee_notification_email_deliveries enable row level security;
alter table public.employee_notification_email_deliveries force row level security;

revoke all on table public.employee_notification_campaigns, public.employee_notifications, public.employee_notification_email_deliveries from public, anon, authenticated;

create or replace function private.create_employee_notification(
  target_recipient_employee_id uuid,
  target_source_type text,
  target_source_id uuid,
  target_source_key text,
  target_title text,
  target_body text,
  target_priority text default 'routine',
  target_requires_acknowledgement boolean default false,
  target_action_path text default null,
  target_action_label text default null,
  target_sender_employee_id uuid default null,
  target_campaign_id uuid default null,
  target_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare created_id uuid;
begin
  if target_priority not in ('routine', 'important', 'urgent') then
    raise check_violation using message = 'Choose a valid notification priority.';
  end if;
  insert into public.employee_notifications (
    recipient_employee_id, campaign_id, sender_employee_id, source_type, source_id, source_key,
    title, body, priority, requires_acknowledgement, action_path, action_label, expires_at
  ) values (
    target_recipient_employee_id, target_campaign_id, target_sender_employee_id, left(btrim(target_source_type), 80),
    target_source_id, left(btrim(target_source_key), 500), left(btrim(target_title), 200), left(btrim(target_body), 5000),
    target_priority, target_requires_acknowledgement, nullif(btrim(target_action_path), ''),
    nullif(btrim(target_action_label), ''), target_expires_at
  )
  on conflict (source_key) do nothing
  returning id into created_id;
  return created_id;
end
$$;

create or replace function private.mirror_support_ticket_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare inbox_priority text;
begin
  select case ticket.priority when 'urgent' then 'urgent' when 'high' then 'important' else 'routine' end
  into inbox_priority
  from public.support_tickets ticket
  where ticket.id = new.ticket_id;

  perform private.create_employee_notification(
    new.recipient_employee_id,
    'support_ticket',
    new.ticket_id,
    concat('support-inbox:', new.idempotency_key),
    new.subject,
    new.body,
    coalesce(inbox_priority, 'routine'),
    false,
    concat('/support?ticket=', new.ticket_id),
    'Open ticket'
  );
  return new;
end
$$;

create trigger mirror_support_ticket_notification_to_inbox
after insert on public.support_ticket_notifications
for each row execute function private.mirror_support_ticket_notification();

insert into public.employee_notifications (
  recipient_employee_id, source_type, source_id, source_key, title, body, priority,
  requires_acknowledgement, action_path, action_label, read_at, created_at
)
select
  notification.recipient_employee_id,
  'support_ticket',
  notification.ticket_id,
  concat('support-inbox:', notification.idempotency_key),
  notification.subject,
  notification.body,
  case ticket.priority when 'urgent' then 'urgent' when 'high' then 'important' else 'routine' end,
  false,
  concat('/support?ticket=', notification.ticket_id),
  'Open ticket',
  notification.read_at,
  notification.created_at
from public.support_ticket_notifications notification
join public.support_tickets ticket on ticket.id = notification.ticket_id
on conflict (source_key) do nothing;

create or replace function public.get_my_notification_badge()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  return (
    select jsonb_build_object(
      'unread', count(*) filter (where notification.read_at is null),
      'requiresAction', count(*) filter (where notification.requires_acknowledgement and notification.acknowledged_at is null),
      'urgent', count(*) filter (where notification.priority = 'urgent' and notification.read_at is null)
    )
    from public.employee_notifications notification
    where notification.recipient_employee_id = actor_id
      and notification.dismissed_at is null
      and (notification.expires_at is null or notification.expires_at > clock_timestamp())
  );
end
$$;

create or replace function public.get_my_notifications(
  target_filter text default 'all',
  target_category text default 'all',
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_filter text := case when target_filter in ('all', 'unread', 'action') then target_filter else 'all' end;
  clean_category text := coalesce(nullif(btrim(target_category), ''), 'all');
  clean_page integer := greatest(coalesce(target_page, 1), 1);
  clean_size integer := case when coalesce(target_page_size, 10) in (5, 10, 20) then coalesce(target_page_size, 10) else 10 end;
  total_rows bigint;
  can_send boolean;
  can_manage_delivery boolean;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  can_send := public.current_app_role() = 'admin' or public.has_effective_permission('notifications.manage');
  can_manage_delivery := public.has_effective_permission('notifications.manage') and public.has_mfa();

  select count(*) into total_rows
  from public.employee_notifications notification
  where notification.recipient_employee_id = actor_id
    and notification.dismissed_at is null
    and (notification.expires_at is null or notification.expires_at > clock_timestamp())
    and (clean_filter = 'all' or (clean_filter = 'unread' and notification.read_at is null) or (clean_filter = 'action' and notification.requires_acknowledgement and notification.acknowledged_at is null))
    and (clean_category = 'all' or notification.source_type = clean_category);

  return jsonb_build_object(
    'summary', public.get_my_notification_badge(),
    'permissions', jsonb_build_object('canSend', can_send, 'canManageDelivery', can_manage_delivery),
    'page', jsonb_build_object('number', clean_page, 'size', clean_size, 'total', total_rows, 'totalPages', greatest(1, ceil(total_rows::numeric / clean_size)::integer)),
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', notification.id,
        'title', notification.title,
        'body', notification.body,
        'priority', notification.priority,
        'sourceType', notification.source_type,
        'sourceId', notification.source_id,
        'requiresAcknowledgement', notification.requires_acknowledgement,
        'readAt', notification.read_at,
        'acknowledgedAt', notification.acknowledged_at,
        'createdAt', notification.created_at,
        'expiresAt', notification.expires_at,
        'actionPath', notification.action_path,
        'actionLabel', notification.action_label,
        'senderName', case when sender.id is null then 'SygShift System' else concat(coalesce(nullif(sender.preferred_name, ''), sender.first_name), ' ', sender.last_name) end
      ) order by notification.created_at desc)
      from (
        select item.*
        from public.employee_notifications item
        where item.recipient_employee_id = actor_id
          and item.dismissed_at is null
          and (item.expires_at is null or item.expires_at > clock_timestamp())
          and (clean_filter = 'all' or (clean_filter = 'unread' and item.read_at is null) or (clean_filter = 'action' and item.requires_acknowledgement and item.acknowledged_at is null))
          and (clean_category = 'all' or item.source_type = clean_category)
        order by item.created_at desc
        limit clean_size offset (clean_page - 1) * clean_size
      ) notification
      left join public.employees sender on sender.id = notification.sender_employee_id
    ), '[]'::jsonb)
  );
end
$$;

create or replace function public.mark_my_notification_read(target_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  update public.employee_notifications notification
  set read_at = coalesce(notification.read_at, clock_timestamp())
  where notification.id = target_notification_id and notification.recipient_employee_id = actor_id and notification.dismissed_at is null;
  get diagnostics affected = row_count;
  if affected = 0 then raise insufficient_privilege using message = 'This notification is not available to your account.'; end if;
end
$$;

create or replace function public.acknowledge_my_notification(target_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  update public.employee_notifications notification
  set read_at = coalesce(notification.read_at, clock_timestamp()), acknowledged_at = coalesce(notification.acknowledged_at, clock_timestamp())
  where notification.id = target_notification_id and notification.recipient_employee_id = actor_id
    and notification.requires_acknowledgement and notification.dismissed_at is null;
  get diagnostics affected = row_count;
  if affected = 0 then raise insufficient_privilege using message = 'This notification does not require acknowledgment or is not available.'; end if;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id)
  values ((select auth.uid()), actor_id, 'public', 'employee_notifications', 'ACKNOWLEDGE', target_notification_id::text);
end
$$;

create or replace function public.dismiss_my_notification(target_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  update public.employee_notifications notification
  set read_at = coalesce(notification.read_at, clock_timestamp()), dismissed_at = clock_timestamp()
  where notification.id = target_notification_id and notification.recipient_employee_id = actor_id
    and (not notification.requires_acknowledgement or notification.acknowledged_at is not null);
  get diagnostics affected = row_count;
  if affected = 0 then raise check_violation using message = 'A required notification must be acknowledged before it can be dismissed.'; end if;
end
$$;

create or replace function public.get_notification_composer_options(target_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); clean_search text := left(btrim(coalesce(target_search, '')), 120);
begin
  if actor_id is null or not (public.current_app_role() = 'admin' or public.has_effective_permission('notifications.manage')) or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  return jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object(
      'id', employee.id,
      'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
      'role', employee.role::text,
      'title', employee.title
    ) order by employee.last_name, employee.first_name)
      from (select * from public.employees employee where employee.status = 'active'
        and (clean_search = '' or concat_ws(' ', employee.first_name, employee.preferred_name, employee.last_name, employee.username, employee.employee_number) ilike '%' || clean_search || '%')
        order by employee.last_name, employee.first_name limit 100) employee), '[]'::jsonb),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('code', role_name, 'label', initcap(replace(role_name, '_', ' ')), 'count', role_count) order by role_name)
      from (select employee.role::text role_name, count(*)::integer role_count from public.employees employee where employee.status = 'active' group by employee.role::text) role_counts), '[]'::jsonb),
    'canSendEveryone', public.current_app_role() = 'admin'
  );
end
$$;

create or replace function public.send_employee_notification(target_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_title text := nullif(btrim(target_input ->> 'title'), '');
  clean_body text := nullif(btrim(target_input ->> 'body'), '');
  clean_priority text := coalesce(nullif(target_input ->> 'priority', ''), 'routine');
  clean_requires_ack boolean := coalesce((target_input ->> 'requiresAcknowledgement')::boolean, false);
  clean_email boolean := coalesce((target_input ->> 'emailEnabled')::boolean, true);
  clean_everyone boolean := coalesce((target_input ->> 'everyone')::boolean, false);
  clean_action_path text := nullif(btrim(target_input ->> 'actionPath'), '');
  clean_action_label text := nullif(btrim(target_input ->> 'actionLabel'), '');
  campaign public.employee_notification_campaigns%rowtype;
  recipient record;
  recipient_total integer;
  created_notification_id uuid;
begin
  if actor_id is null or not (public.current_app_role() = 'admin' or public.has_effective_permission('notifications.manage')) or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  if clean_everyone and public.current_app_role() <> 'admin' then
    raise insufficient_privilege using message = 'Only an Administrator can notify every active employee.';
  end if;
  if clean_title is null or char_length(clean_title) not between 5 and 160 then raise check_violation using message = 'Enter a notification title between 5 and 160 characters.'; end if;
  if clean_body is null or char_length(clean_body) not between 10 and 5000 then raise check_violation using message = 'Enter a complete message between 10 and 5,000 characters.'; end if;
  if clean_priority not in ('routine', 'important', 'urgent') then raise check_violation using message = 'Choose a valid notification priority.'; end if;
  if clean_action_path is not null and (clean_action_path not like '/%' or char_length(clean_action_path) > 500) then raise check_violation using message = 'The related SygShift path must begin with /.'; end if;

  with selected_recipients as (
    select employee.id
    from public.employees employee
    where employee.status = 'active' and (
      clean_everyone
      or employee.id::text in (select value from jsonb_array_elements_text(coalesce(target_input -> 'employeeIds', '[]'::jsonb)))
      or employee.role::text in (select value from jsonb_array_elements_text(coalesce(target_input -> 'roles', '[]'::jsonb)))
    )
  ) select count(*)::integer into recipient_total from selected_recipients;
  if recipient_total = 0 then raise check_violation using message = 'Choose at least one active recipient.'; end if;

  insert into public.employee_notification_campaigns(sent_by, title, body, priority, requires_acknowledgement, email_enabled, audience, recipient_count)
  values (actor_id, clean_title, clean_body, clean_priority, clean_requires_ack, clean_email,
    jsonb_build_object('employeeIds', coalesce(target_input -> 'employeeIds', '[]'::jsonb), 'roles', coalesce(target_input -> 'roles', '[]'::jsonb), 'everyone', clean_everyone), recipient_total)
  returning * into campaign;

  for recipient in
    select employee.id
    from public.employees employee
    where employee.status = 'active' and (
      clean_everyone
      or employee.id::text in (select value from jsonb_array_elements_text(coalesce(target_input -> 'employeeIds', '[]'::jsonb)))
      or employee.role::text in (select value from jsonb_array_elements_text(coalesce(target_input -> 'roles', '[]'::jsonb)))
    )
  loop
    created_notification_id := private.create_employee_notification(
      recipient.id, 'direct', campaign.id, concat('direct:', campaign.id, ':', recipient.id),
      clean_title, clean_body, clean_priority, clean_requires_ack, clean_action_path,
      coalesce(clean_action_label, case when clean_action_path is null then null else 'Open related item' end), actor_id, campaign.id
    );
    if clean_email and created_notification_id is not null then
      insert into public.employee_notification_email_deliveries(notification_id, recipient_employee_id, subject, body)
      values (created_notification_id, recipient.id, concat('[SygShift] ', clean_title), concat(clean_body,
        case when clean_action_path is null then '' else concat(E'\n\nOpen SygShift: https://app.sygilant.us', clean_action_path) end));
    end if;
  end loop;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'employee_notification_campaigns', 'SEND', campaign.id::text,
    jsonb_build_object('priority', clean_priority, 'requiresAcknowledgement', clean_requires_ack, 'emailEnabled', clean_email, 'recipientCount', recipient_total, 'everyone', clean_everyone));
  return jsonb_build_object('campaignId', campaign.id, 'recipientCount', recipient_total, 'emailEnabled', clean_email);
end
$$;

create or replace function public.service_claim_employee_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare claimed jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  with pending as (
    select delivery.* from public.employee_notification_email_deliveries delivery
    where delivery.delivered_at is null and delivery.failed_at is null and delivery.available_at <= clock_timestamp() and delivery.attempt_count < 5
    order by delivery.available_at, delivery.created_at
    limit least(greatest(coalesce(target_limit, 25), 1), 50) for update skip locked
  ), touched as (
    update public.employee_notification_email_deliveries delivery
    set attempted_at = clock_timestamp(), attempt_count = delivery.attempt_count + 1, last_error = null
    from pending where delivery.id = pending.id returning delivery.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id,
    'messageType', 'direct_employee_notification',
    'aggregateType', 'employee_notification',
    'aggregateId', delivery.notification_id,
    'attemptCount', delivery.attempt_count,
    'recipients', case when private.preferred_delivery_email(contact.personal_email, contact.company_email) is null then '[]'::jsonb else jsonb_build_array(private.preferred_delivery_email(contact.personal_email, contact.company_email)) end,
    'message', jsonb_build_object('subject', delivery.subject, 'text', delivery.body)
  ) order by delivery.created_at), '[]'::jsonb) into claimed
  from touched delivery
  left join private.employee_contacts contact on contact.employee_id = delivery.recipient_employee_id;
  return claimed;
end
$$;

create or replace function public.service_mark_employee_notification_result(target_delivery_id uuid, delivered boolean, delivery_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  update public.employee_notification_email_deliveries delivery set
    delivered_at = case when delivered then clock_timestamp() else delivery.delivered_at end,
    failed_at = case when not delivered and delivery.attempt_count >= 5 then clock_timestamp() else null end,
    last_error = case when delivered then null else left(coalesce(nullif(btrim(delivery_error), ''), 'Delivery failed.'), 1000) end,
    available_at = case when delivered then delivery.available_at else clock_timestamp() + interval '15 minutes' end
  where delivery.id = target_delivery_id and delivery.delivered_at is null;
end
$$;

revoke all on function private.create_employee_notification(uuid, text, uuid, text, text, text, text, boolean, text, text, uuid, uuid, timestamptz), private.mirror_support_ticket_notification() from public, anon, authenticated;
revoke all on function public.get_my_notification_badge(), public.get_my_notifications(text, text, integer, integer), public.mark_my_notification_read(uuid), public.acknowledge_my_notification(uuid), public.dismiss_my_notification(uuid), public.get_notification_composer_options(text), public.send_employee_notification(jsonb), public.service_claim_employee_notification_batch(integer), public.service_mark_employee_notification_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.get_my_notification_badge(), public.get_my_notifications(text, text, integer, integer), public.mark_my_notification_read(uuid), public.acknowledge_my_notification(uuid), public.dismiss_my_notification(uuid), public.get_notification_composer_options(text), public.send_employee_notification(jsonb) to authenticated;
grant execute on function public.service_claim_employee_notification_batch(integer), public.service_mark_employee_notification_result(uuid, boolean, text) to service_role;

notify pgrst, 'reload schema';
commit;

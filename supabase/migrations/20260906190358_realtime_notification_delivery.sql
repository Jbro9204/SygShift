begin;
set local lock_timeout = '5s';

-- Only recipient-specific invalidations travel over Realtime, never ticket content.
create policy employee_private_updates on realtime.messages for select to authenticated
using (realtime.topic() = 'employee:' || (select auth.uid())::text and topic = 'employee:' || (select auth.uid())::text);

create function private.signal_employee_update(target_employee_id uuid, target_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare account_id uuid;
begin
  select account.auth_user_id into account_id from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.employee_id = target_employee_id and account.disabled_at is null and employee.status = 'active';
  if account_id is not null then
    perform realtime.send(target_payload, 'changed', 'employee:' || account_id::text, true);
  end if;
exception when others then
  -- Transport trouble must not roll back an otherwise valid operational transaction.
  raise warning 'Employee live update deferred; SQLSTATE %', sqlstate;
end
$$;

create function private.signal_support_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare recipient record;
begin
  for recipient in
    select employee.id from public.employees employee
    where employee.status = 'active' and (
      employee.id = new.submitted_by or employee.role = 'admin' or (
        'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
        and new.route_permission = any(private.employee_effective_permissions(employee.id))
      )
    )
  loop
    perform private.signal_employee_update(recipient.id, jsonb_build_object('kind', 'support', 'id', new.id));
  end loop;
  return new;
exception when others then
  raise warning 'Support live update deferred; SQLSTATE %', sqlstate;
  return new;
end
$$;
create trigger support_live_update after insert or update on public.support_tickets
for each row execute function private.signal_support_update();

create function private.signal_notification_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.signal_employee_update(new.recipient_employee_id,
    jsonb_build_object('kind', 'notification', 'id', new.id, 'isNew', tg_op = 'INSERT'));
  return new;
end
$$;
create trigger employee_notification_live_update after insert or update on public.employee_notifications
for each row execute function private.signal_notification_update();

-- This bounded read is also the reconnect/polling fallback. Initial history is silent.
create function public.get_my_live_notifications(target_since timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); result jsonb; read_time timestamptz := clock_timestamp();
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  select jsonb_build_object('serverTime', read_time, 'notifications', coalesce(jsonb_agg(item.payload order by item.created_at), '[]'::jsonb)) into result
  from (
    select notification.created_at, jsonb_build_object(
      'id', notification.id, 'title', notification.title, 'priority', notification.priority,
      'createdAt', notification.created_at, 'actionPath', notification.action_path,
      'sourceType', notification.source_type, 'sourceId', notification.source_id
    ) as payload
    from public.employee_notifications notification
    where notification.recipient_employee_id = actor_id
      and notification.created_at >= greatest(coalesce(target_since, read_time), read_time - interval '2 minutes')
      and notification.created_at <= read_time and notification.read_at is null and notification.dismissed_at is null
      and (notification.expires_at is null or notification.expires_at > read_time)
      and (notification.source_type <> 'support_ticket' or exists (
        select 1 from public.support_tickets ticket where ticket.id = notification.source_id and private.support_can_view(ticket)
      ))
    order by notification.created_at desc limit 50
  ) item;
  return result;
end
$$;

create function public.mark_support_ticket_read(target_ticket_id uuid, target_through timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); ticket public.support_tickets%rowtype;
begin
  select * into ticket from public.support_tickets where id = target_ticket_id;
  if actor_id is null or not found or not private.support_can_view(ticket) then
    raise insufficient_privilege using message = 'This support ticket is not available to your account.';
  end if;
  update public.support_ticket_notifications set read_at = clock_timestamp()
  where ticket_id = target_ticket_id and recipient_employee_id = actor_id and read_at is null
    and created_at <= least(target_through, clock_timestamp());
  update public.employee_notifications set read_at = clock_timestamp()
  where source_type = 'support_ticket' and source_id = target_ticket_id and recipient_employee_id = actor_id and read_at is null
    and created_at <= least(target_through, clock_timestamp());
end
$$;

revoke all on function private.signal_employee_update(uuid,jsonb), private.signal_support_update(), private.signal_notification_update() from public, anon, authenticated;
revoke all on function public.get_my_live_notifications(timestamptz), public.mark_support_ticket_read(uuid,timestamptz) from public, anon;
grant execute on function public.get_my_live_notifications(timestamptz), public.mark_support_ticket_read(uuid,timestamptz) to authenticated;

create or replace function public.read_support_ticket(target_ticket_id uuid)
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

  select jsonb_build_object(
    'readThrough', statement_timestamp(), 'id', ticket.id, 'ticketNumber', concat('TKT-', lpad(ticket.ticket_number::text, 6, '0')),
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
revoke all on function public.read_support_ticket(uuid) from public, anon;
grant execute on function public.read_support_ticket(uuid) to authenticated;

create extension if not exists pg_net with schema extensions;
revoke all on schema net from public, anon, authenticated;

create table private.employee_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  auth_session_id uuid not null,
  endpoint text not null unique check (char_length(endpoint) between 20 and 2048),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}=?$'),
  auth_key text not null check (auth_key ~ '^[A-Za-z0-9_-]{22}={0,2}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index employee_push_subscription_owner_idx on private.employee_push_subscriptions(employee_id) where enabled;
create table private.employee_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.employee_notifications(id),
  subscription_id uuid not null references private.employee_push_subscriptions(id),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  available_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  completed_at timestamptz,
  outcome text check (outcome in ('delivered','expired','unavailable','failed')),
  unique(notification_id, subscription_id)
);
create index employee_push_delivery_pending_idx on private.employee_push_deliveries(available_at) where completed_at is null;
create index employee_push_delivery_subscription_idx on private.employee_push_deliveries(subscription_id);
alter table private.employee_push_subscriptions enable row level security;
alter table private.employee_push_subscriptions force row level security;
alter table private.employee_push_deliveries enable row level security;
alter table private.employee_push_deliveries force row level security;
revoke all on private.employee_push_subscriptions, private.employee_push_deliveries from public, anon, authenticated;

create function public.set_my_push_subscription(target_subscription jsonb, target_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := private.current_employee_id(); session_id uuid := (auth.jwt()->>'session_id')::uuid;
  endpoint_value text := target_subscription->>'endpoint'; saved_id uuid;
begin
  if actor_id is null or session_id is null then raise insufficient_privilege using message = 'Sign in before setting up device notifications.'; end if;
  if target_enabled then
    if endpoint_value !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]]+$'
      or endpoint_value is null or char_length(endpoint_value) > 2048 then
      raise check_violation using message = 'This browser push service is not supported.';
    end if;
    if (select count(*) from private.employee_push_subscriptions where employee_id = actor_id and enabled and endpoint <> endpoint_value) >= 10 then
      raise check_violation using message = 'The device notification limit has been reached. Contact support.';
    end if;
    insert into private.employee_push_subscriptions(employee_id, auth_session_id, endpoint, p256dh, auth_key)
    values (actor_id, session_id, endpoint_value, target_subscription->'keys'->>'p256dh', target_subscription->'keys'->>'auth')
    on conflict(endpoint) do update set employee_id = excluded.employee_id, auth_session_id = excluded.auth_session_id,
      p256dh = excluded.p256dh, auth_key = excluded.auth_key, enabled = true, updated_at = clock_timestamp()
    returning id into saved_id;
  else
    update private.employee_push_subscriptions set enabled = false, updated_at = clock_timestamp()
    where employee_id = actor_id and endpoint = endpoint_value returning id into saved_id;
  end if;
  if saved_id is not null then
    insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record)
    values (auth.uid(),actor_id,'private','employee_push_subscriptions','UPDATE',saved_id::text,jsonb_build_object('enabled',target_enabled));
  end if;
  return jsonb_build_object('enabled', target_enabled and saved_id is not null);
end
$$;

create function public.get_my_push_subscription(target_endpoint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  return jsonb_build_object('enabled', exists(select 1 from private.employee_push_subscriptions
    where employee_id = actor_id and endpoint = target_endpoint and enabled
      and auth_session_id = (auth.jwt()->>'session_id')::uuid));
end
$$;

create function private.queue_employee_push()
returns trigger language plpgsql security definer set search_path = '' as $$
declare queued_count integer; hook_secret text;
begin
  insert into private.employee_push_deliveries(notification_id, subscription_id)
  select new.id, subscription.id from private.employee_push_subscriptions subscription
  where subscription.employee_id = new.recipient_employee_id and subscription.enabled
  on conflict do nothing;
  get diagnostics queued_count = row_count;
  if queued_count > 0 and coalesce(current_setting('sygshift.push_kicked',true),'') <> 'yes' then
    begin
      select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'sygshift_push_hook' limit 1;
      if hook_secret is not null then
        perform net.http_post(url := 'https://app.sygilant.us/api/v1/notifications/push/dispatch',
          body := '{}'::jsonb, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || hook_secret), timeout_milliseconds := 5000);
        perform set_config('sygshift.push_kicked','yes',true);
      end if;
    exception when others then raise warning 'Push wake deferred to scheduled retry; SQLSTATE %', sqlstate;
    end;
  end if;
  return new;
exception when others then
  raise warning 'Push enqueue unavailable; SQLSTATE %', sqlstate;
  return new;
end
$$;
create trigger employee_notification_push after insert on public.employee_notifications
for each row execute function private.queue_employee_push();

create function public.service_claim_employee_push(target_limit integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise insufficient_privilege; end if;
  -- Old alerts are still in the inbox; do not send stale lock-screen alerts later.
  update private.employee_push_deliveries delivery set completed_at = clock_timestamp(), outcome = 'expired'
  from public.employee_notifications notification where notification.id = delivery.notification_id and delivery.completed_at is null
    and (notification.created_at < clock_timestamp() - interval '10 minutes' or notification.read_at is not null or notification.dismissed_at is not null
      or notification.expires_at <= clock_timestamp() or (delivery.attempt_count >= 5 and delivery.available_at <= clock_timestamp()));
  with pending as (
    select delivery.id from private.employee_push_deliveries delivery
    where delivery.completed_at is null and delivery.available_at <= clock_timestamp()
    order by delivery.available_at limit least(greatest(coalesce(target_limit,25),1),50) for update skip locked
  ), claimed as (
    update private.employee_push_deliveries delivery set attempt_count = attempt_count + 1,
      available_at = clock_timestamp() + interval '2 minutes', claim_token = gen_random_uuid()
    from pending where delivery.id = pending.id returning delivery.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id, 'claimToken', delivery.claim_token, 'notificationId', notification.id,
    'employeeId', notification.recipient_employee_id, 'createdAt', notification.created_at,
    'path', coalesce(notification.action_path,'/notifications'), 'attempt', delivery.attempt_count,
    'subscription', jsonb_build_object('endpoint',subscription.endpoint,'expirationTime',null,'keys',jsonb_build_object('p256dh',subscription.p256dh,'auth',subscription.auth_key)),
    'eligible', coalesce(subscription.enabled and subscription.employee_id = notification.recipient_employee_id
      and account.disabled_at is null and employee.status = 'active' and session.id is not null
      and (session.not_after is null or session.not_after > clock_timestamp())
      and (notification.source_type <> 'support_ticket' or exists(select 1 from public.support_tickets ticket
        where ticket.id = notification.source_id and (ticket.submitted_by = employee.id or employee.role = 'admin'
          or ('support.tickets.view' = any(private.employee_effective_permissions(employee.id)) and ticket.route_permission = any(private.employee_effective_permissions(employee.id)))))),false)
  )), '[]'::jsonb) into result
  from claimed delivery join public.employee_notifications notification on notification.id = delivery.notification_id
  join private.employee_push_subscriptions subscription on subscription.id = delivery.subscription_id
  join public.employees employee on employee.id = notification.recipient_employee_id
  left join private.employee_accounts account on account.employee_id = employee.id
  left join auth.sessions session on session.id = subscription.auth_session_id and session.user_id = account.auth_user_id;
  return result;
end
$$;

create function public.service_complete_employee_push(target_id uuid, target_claim_token uuid, target_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare subscription_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise insufficient_privilege; end if;
  if target_outcome not in ('delivered','expired','unavailable','failed','retry') then raise check_violation; end if;
  update private.employee_push_deliveries set
    completed_at = case when target_outcome = 'retry' and attempt_count < 5 then null else clock_timestamp() end,
    outcome = case when target_outcome = 'retry' then case when attempt_count >= 5 then 'failed' else null end else target_outcome end,
    available_at = clock_timestamp() + make_interval(secs => least(300, 15 * (2 ^ attempt_count)::integer))
  where id = target_id and claim_token = target_claim_token and completed_at is null
  returning employee_push_deliveries.subscription_id into subscription_id;
  if target_outcome = 'unavailable' and subscription_id is not null then
    update private.employee_push_subscriptions set enabled = false where id = subscription_id;
  end if;
end
$$;

revoke all on function private.queue_employee_push() from public, anon, authenticated;
revoke all on function public.set_my_push_subscription(jsonb,boolean), public.get_my_push_subscription(text) from public, anon;
grant execute on function public.set_my_push_subscription(jsonb,boolean), public.get_my_push_subscription(text) to authenticated;
revoke all on function public.service_claim_employee_push(integer), public.service_complete_employee_push(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.service_claim_employee_push(integer), public.service_complete_employee_push(uuid,uuid,text) to service_role;

notify pgrst, 'reload schema';
commit;

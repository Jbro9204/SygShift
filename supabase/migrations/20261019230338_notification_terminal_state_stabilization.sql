begin;

-- SygShift owns these three queues. Existing data and applied migrations remain intact.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Fail closed if the verified production contract has drifted since capture.
do $$
declare routine record; actual_hash text; actual_acl text; queue_name text;
begin
  for routine in select * from (values
    ('public.service_mark_notification_result(uuid,boolean,text)', '0bfe99992d61112ffb7d29a99e881042'),
    ('public.service_mark_notification_suppressed(uuid,text)', 'dab9de8c033a3173588b22f0ee4c45d1'),
    ('public.service_mark_support_ticket_notification_result(uuid,boolean,text)', 'e94e2c3e8d4e2f45709ff1fe3336a79b'),
    ('public.service_mark_employee_notification_result(uuid,boolean,text)', 'c00a1a0e93960bf33aa732030bc31a86')
  ) as expected(signature, definition_hash)
  loop
    select md5(pg_get_functiondef(procedure.oid)), procedure.proacl::text
    into actual_hash, actual_acl from pg_proc procedure where procedure.oid = to_regprocedure(routine.signature);
    if actual_hash is distinct from routine.definition_hash
      or actual_acl is distinct from '{postgres=X/postgres,service_role=X/postgres}' then
      raise exception 'Verified notification function or ACL drifted: %', routine.signature;
    end if;
  end loop;
  foreach queue_name in array array['private.notification_outbox', 'public.support_ticket_notifications', 'public.employee_notification_email_deliveries'] loop
    if to_regclass(queue_name) is null or exists (
      select 1 from pg_attribute where attrelid=to_regclass(queue_name) and attname='terminal_outcome' and not attisdropped
    ) or (select count(*) from pg_attribute where attrelid=to_regclass(queue_name)
      and attname in ('id','delivered_at','failed_at','attempted_at','attempt_count','available_at','last_error') and not attisdropped) <> 7 then
      raise exception 'Verified notification queue schema drifted: %', queue_name;
    end if;
  end loop;
  if to_regprocedure('public.service_mark_support_ticket_notification_suppressed(uuid,text)') is not null
    or to_regprocedure('public.service_mark_employee_notification_suppressed(uuid,text)') is not null then
    raise exception 'A notification suppression API already exists; review ownership before replacing it.';
  end if;
end;
$$;

do $$
declare routine record; actual_hash text; actual_acl text;
begin
  for routine in select * from (values
    ('public.service_log_email_delivery(text,text,uuid,text,text,text,text)', 'a9f7b920d06e324278c0628837206cd4', '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.retry_notification_job(uuid)', 'bf86cb342fe7f7109d3bb6d6644aed5c', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.retry_all_failed_notifications()', 'da7cbff083263ece9d14b84b12458a00', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.get_notification_center(text,text,date,date,integer,integer)', '1def49e00ca411d349c9445d797c4e13', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.get_notification_center()', 'e1e39a69d2eb370bfb91bc488bfad0f7', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
  ) as expected(signature, definition_hash, acl)
  loop
    select md5(pg_get_functiondef(procedure.oid)), procedure.proacl::text
    into actual_hash, actual_acl from pg_proc procedure where procedure.oid=to_regprocedure(routine.signature);
    if actual_hash is distinct from routine.definition_hash or actual_acl is distinct from routine.acl then
      raise exception 'Verified notification audit/retry/read function drifted: %', routine.signature;
    end if;
  end loop;
  if (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid='private.email_delivery_audit'::regclass and conname='email_delivery_audit_status')
    is distinct from 'CHECK ((delivery_status = ANY (ARRAY[''sent''::text, ''failed''::text, ''suppressed_blocked_domain''::text])))' then
    raise exception 'Verified email audit status contract drifted.';
  end if;
end;
$$;

create or replace function private.notification_terminal_outcome(target_error text)
returns text language sql immutable set search_path = '' as $$
  select case
    when target_error in ('Suppressed — Employee Preference', 'Suppressed — Blocked Domain', 'Suppressed — Provider Recipient')
      or starts_with(target_error, 'E_RECIPIENT_SUPPRESSED:') then 'suppressed'
    when target_error in (
      'Suppressed by call-off lifecycle reconciliation because no live coverage action remains.',
      'Suppressed because the linked call-off report is unavailable.',
      'Superseded by a newer call-off lifecycle notification generation.'
    ) or starts_with(target_error, 'Suppressed by call-off lifecycle reconciliation: ') then 'canceled'
    else 'failed'
  end;
$$;
revoke all on function private.notification_terminal_outcome(text) from public, anon, authenticated, service_role;

alter table private.notification_outbox
  add column terminal_outcome text
    check (terminal_outcome in ('failed', 'suppressed', 'canceled', 'retry_exhausted'));

-- The original timestamp/error/attempt/payload remain in place; append metadata evidence.
with prior as materialized (
  select id, failed_at, terminal_outcome, attempted_at, attempt_count, last_error
  from private.notification_outbox
  where delivered_at is null and (failed_at is not null or attempt_count >= 5)
), changed as (
  update private.notification_outbox delivery
  set terminal_outcome = case when prior.failed_at is null then 'retry_exhausted'
      else private.notification_terminal_outcome(prior.last_error) end,
    failed_at = coalesce(prior.failed_at, clock_timestamp())
  from prior where delivery.id = prior.id
  returning delivery.id, prior.failed_at as prior_failed_at, prior.terminal_outcome as prior_terminal_outcome,
    prior.attempted_at, prior.attempt_count, prior.last_error, delivery.failed_at, delivery.terminal_outcome
)
insert into private.audit_events(schema_name, table_name, operation, row_id, old_record, new_record)
select 'private', 'notification_outbox', 'UPDATE', id::text,
  jsonb_build_object('terminal_outcome', prior_terminal_outcome, 'failed_at', prior_failed_at,
    'attempted_at', attempted_at, 'attempt_count', attempt_count, 'last_error', last_error),
  jsonb_build_object('terminal_outcome', terminal_outcome, 'failed_at', failed_at,
    'attempted_at', attempted_at, 'attempt_count', attempt_count, 'last_error', last_error,
    'reason', 'Forward-only notification terminal-state stabilization; no resend.')
from changed;

alter table public.support_ticket_notifications
  add column terminal_outcome text
    check (terminal_outcome in ('failed', 'suppressed', 'canceled', 'retry_exhausted'));

-- The original timestamp/error/attempt/payload remain in place; append metadata evidence.
with prior as materialized (
  select id, failed_at, terminal_outcome, attempted_at, attempt_count, last_error
  from public.support_ticket_notifications
  where delivered_at is null and (failed_at is not null or attempt_count >= 5)
), changed as (
  update public.support_ticket_notifications delivery
  set terminal_outcome = case when prior.failed_at is null then 'retry_exhausted'
      else private.notification_terminal_outcome(prior.last_error) end,
    failed_at = coalesce(prior.failed_at, clock_timestamp())
  from prior where delivery.id = prior.id
  returning delivery.id, prior.failed_at as prior_failed_at, prior.terminal_outcome as prior_terminal_outcome,
    prior.attempted_at, prior.attempt_count, prior.last_error, delivery.failed_at, delivery.terminal_outcome
)
insert into private.audit_events(schema_name, table_name, operation, row_id, old_record, new_record)
select 'public', 'support_ticket_notifications', 'UPDATE', id::text,
  jsonb_build_object('terminal_outcome', prior_terminal_outcome, 'failed_at', prior_failed_at,
    'attempted_at', attempted_at, 'attempt_count', attempt_count, 'last_error', last_error),
  jsonb_build_object('terminal_outcome', terminal_outcome, 'failed_at', failed_at,
    'attempted_at', attempted_at, 'attempt_count', attempt_count, 'last_error', last_error,
    'reason', 'Forward-only notification terminal-state stabilization; no resend.')
from changed;

alter table public.employee_notification_email_deliveries
  add column terminal_outcome text
    check (terminal_outcome in ('failed', 'suppressed', 'canceled', 'retry_exhausted'));

-- The original timestamp/error/attempt/payload remain in place; append metadata evidence.
with prior as materialized (
  select id, failed_at, terminal_outcome, attempted_at, attempt_count, last_error
  from public.employee_notification_email_deliveries
  where delivered_at is null and (failed_at is not null or attempt_count >= 5)
), changed as (
  update public.employee_notification_email_deliveries delivery
  set terminal_outcome = case when prior.failed_at is null then 'retry_exhausted'
      else private.notification_terminal_outcome(prior.last_error) end,
    failed_at = coalesce(prior.failed_at, clock_timestamp())
  from prior where delivery.id = prior.id
  returning delivery.id, prior.failed_at as prior_failed_at, prior.terminal_outcome as prior_terminal_outcome,
    prior.attempted_at, prior.attempt_count, prior.last_error, delivery.failed_at, delivery.terminal_outcome
)
insert into private.audit_events(schema_name, table_name, operation, row_id, old_record, new_record)
select 'public', 'employee_notification_email_deliveries', 'UPDATE', id::text,
  jsonb_build_object('terminal_outcome', prior_terminal_outcome, 'failed_at', prior_failed_at,
    'attempted_at', attempted_at, 'attempt_count', attempt_count, 'last_error', last_error),
  jsonb_build_object('terminal_outcome', terminal_outcome, 'failed_at', failed_at,
    'attempted_at', attempted_at, 'attempt_count', attempt_count, 'last_error', last_error,
    'reason', 'Forward-only notification terminal-state stabilization; no resend.')
from changed;

create or replace function private.protect_notification_terminal_outcome()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (old.delivered_at is not null or old.failed_at is not null) then
    if new.delivered_at is distinct from old.delivered_at
      or new.failed_at is distinct from old.failed_at
      or new.attempted_at is distinct from old.attempted_at
      or new.attempt_count is distinct from old.attempt_count
      or new.available_at is distinct from old.available_at
      or new.last_error is distinct from old.last_error
      or new.terminal_outcome is distinct from old.terminal_outcome then
      raise exception using errcode = '55000', message = 'Terminal notification delivery evidence cannot be reopened or overwritten.';
    end if;
    return new;
  end if;
  if new.delivered_at is not null then
    new.terminal_outcome := null;
  elsif new.failed_at is not null then
    -- Alternate lifecycle writers preserve any prior retry error with COALESCE.
    -- Use current lifecycle state as well as fixed signatures for NEW closures.
    if new.terminal_outcome is null and tg_table_name = 'notification_outbox' then
      if new.message_type = 'call_off_supervisor_alert' and new.aggregate_type = 'call_off_report' and not exists (
        select 1 from public.call_off_reports report join public.shifts shift on shift.id=report.shift_id
        where report.id=new.aggregate_id and report.canceled_at is null and report.resolved_at is null
          and report.duplicate_of_call_off_report_id is null and report.replacement_needed
          and clock_timestamp() < shift.ends_at + interval '1 hour'
      ) then new.terminal_outcome := 'canceled'; end if;
    end if;
    if new.terminal_outcome is null and tg_table_name = 'employee_notification_email_deliveries' then
      if exists (
        select 1 from public.employee_notifications notification
        where notification.id=new.notification_id and (
          notification.resolved_at is not null or notification.dismissed_at is not null or notification.expires_at <= clock_timestamp()
        )
      ) then new.terminal_outcome := 'canceled'; end if;
    end if;
    new.terminal_outcome := coalesce(new.terminal_outcome, private.notification_terminal_outcome(new.last_error));
  elsif new.terminal_outcome is not null then
    raise exception using errcode = '23514', message = 'A terminal notification outcome requires a terminal timestamp.';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_notification_terminal_outcome() from public, anon, authenticated, service_role;

create or replace function private.audit_notification_terminal_outcome()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.delivered_at is distinct from old.delivered_at
    or new.failed_at is distinct from old.failed_at
    or new.terminal_outcome is distinct from old.terminal_outcome then
    insert into private.audit_events(schema_name, table_name, operation, row_id, old_record, new_record)
    values (tg_table_schema, tg_table_name, 'UPDATE', new.id::text,
      jsonb_build_object('delivered_at', old.delivered_at, 'failed_at', old.failed_at, 'terminal_outcome', old.terminal_outcome),
      jsonb_build_object('delivered_at', new.delivered_at, 'failed_at', new.failed_at, 'terminal_outcome', new.terminal_outcome));
  end if;
  return new;
end;
$$;
revoke all on function private.audit_notification_terminal_outcome() from public, anon, authenticated, service_role;

create trigger z_protect_notification_terminal_outcome before insert or update on private.notification_outbox
for each row execute function private.protect_notification_terminal_outcome();
create trigger z_audit_notification_terminal_outcome after update on private.notification_outbox
for each row execute function private.audit_notification_terminal_outcome();

create or replace function public.service_mark_notification_result(target_notification_id uuid, delivered boolean, delivery_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null or delivered is null then
    raise invalid_parameter_value using message = 'Notification identifier and delivery result are required.';
  end if;
  update private.notification_outbox delivery set
    delivered_at = case when delivered then clock_timestamp() else null end,
    failed_at = case when not delivered and delivery.attempt_count >= 5 then clock_timestamp() else null end,
    terminal_outcome = case when not delivered and delivery.attempt_count >= 5 then 'retry_exhausted' else null end,
    last_error = case when delivered then null else left(coalesce(nullif(btrim(delivery_error), ''), 'Delivery failed.'), 1000) end,
    available_at = case when delivered then delivery.available_at else clock_timestamp() + interval '15 minutes' end
  where delivery.id = target_notification_id and delivery.delivered_at is null and delivery.failed_at is null;
end;
$$;
revoke all on function public.service_mark_notification_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.service_mark_notification_result(uuid, boolean, text) to service_role;

create or replace function public.service_mark_notification_suppressed(target_notification_id uuid, target_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null then
    raise invalid_parameter_value using message = 'Notification identifier is required.';
  end if;
  update private.notification_outbox delivery
  set failed_at = clock_timestamp(), terminal_outcome = 'suppressed',
    last_error = left(coalesce(nullif(btrim(target_reason), ''), 'Suppressed — Provider Recipient'), 1000)
  where delivery.id = target_notification_id and delivery.delivered_at is null and delivery.failed_at is null;
end;
$$;
revoke all on function public.service_mark_notification_suppressed(uuid, text) from public, anon, authenticated;
grant execute on function public.service_mark_notification_suppressed(uuid, text) to service_role;

create trigger z_protect_notification_terminal_outcome before insert or update on public.support_ticket_notifications
for each row execute function private.protect_notification_terminal_outcome();
create trigger z_audit_notification_terminal_outcome after update on public.support_ticket_notifications
for each row execute function private.audit_notification_terminal_outcome();

create or replace function public.service_mark_support_ticket_notification_result(target_notification_id uuid, delivered boolean, delivery_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null or delivered is null then
    raise invalid_parameter_value using message = 'Notification identifier and delivery result are required.';
  end if;
  update public.support_ticket_notifications delivery set
    delivered_at = case when delivered then clock_timestamp() else null end,
    failed_at = case when not delivered and delivery.attempt_count >= 5 then clock_timestamp() else null end,
    terminal_outcome = case when not delivered and delivery.attempt_count >= 5 then 'retry_exhausted' else null end,
    last_error = case when delivered then null else left(coalesce(nullif(btrim(delivery_error), ''), 'Delivery failed.'), 1000) end,
    available_at = case when delivered then delivery.available_at else clock_timestamp() + interval '15 minutes' end
  where delivery.id = target_notification_id and delivery.delivered_at is null and delivery.failed_at is null;
end;
$$;
revoke all on function public.service_mark_support_ticket_notification_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.service_mark_support_ticket_notification_result(uuid, boolean, text) to service_role;

create or replace function public.service_mark_support_ticket_notification_suppressed(target_notification_id uuid, target_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null then
    raise invalid_parameter_value using message = 'Notification identifier is required.';
  end if;
  update public.support_ticket_notifications delivery
  set failed_at = clock_timestamp(), terminal_outcome = 'suppressed',
    last_error = left(coalesce(nullif(btrim(target_reason), ''), 'Suppressed — Provider Recipient'), 1000)
  where delivery.id = target_notification_id and delivery.delivered_at is null and delivery.failed_at is null;
end;
$$;
revoke all on function public.service_mark_support_ticket_notification_suppressed(uuid, text) from public, anon, authenticated;
grant execute on function public.service_mark_support_ticket_notification_suppressed(uuid, text) to service_role;

create trigger z_protect_notification_terminal_outcome before insert or update on public.employee_notification_email_deliveries
for each row execute function private.protect_notification_terminal_outcome();
create trigger z_audit_notification_terminal_outcome after update on public.employee_notification_email_deliveries
for each row execute function private.audit_notification_terminal_outcome();

create or replace function public.service_mark_employee_notification_result(target_delivery_id uuid, delivered boolean, delivery_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_delivery_id is null or delivered is null then
    raise invalid_parameter_value using message = 'Notification identifier and delivery result are required.';
  end if;
  update public.employee_notification_email_deliveries delivery set
    delivered_at = case when delivered then clock_timestamp() else null end,
    failed_at = case when not delivered and delivery.attempt_count >= 5 then clock_timestamp() else null end,
    terminal_outcome = case when not delivered and delivery.attempt_count >= 5 then 'retry_exhausted' else null end,
    last_error = case when delivered then null else left(coalesce(nullif(btrim(delivery_error), ''), 'Delivery failed.'), 1000) end,
    available_at = case when delivered then delivery.available_at else clock_timestamp() + interval '15 minutes' end
  where delivery.id = target_delivery_id and delivery.delivered_at is null and delivery.failed_at is null;
end;
$$;
revoke all on function public.service_mark_employee_notification_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.service_mark_employee_notification_result(uuid, boolean, text) to service_role;

create or replace function public.service_mark_employee_notification_suppressed(target_delivery_id uuid, target_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_delivery_id is null then
    raise invalid_parameter_value using message = 'Notification identifier is required.';
  end if;
  update public.employee_notification_email_deliveries delivery
  set failed_at = clock_timestamp(), terminal_outcome = 'suppressed',
    last_error = left(coalesce(nullif(btrim(target_reason), ''), 'Suppressed — Provider Recipient'), 1000)
  where delivery.id = target_delivery_id and delivery.delivered_at is null and delivery.failed_at is null;
end;
$$;
revoke all on function public.service_mark_employee_notification_suppressed(uuid, text) from public, anon, authenticated;
grant execute on function public.service_mark_employee_notification_suppressed(uuid, text) to service_role;

-- Preserve every existing audit record; future provider suppressions have their own status.
alter table private.email_delivery_audit drop constraint email_delivery_audit_status;
alter table private.email_delivery_audit add constraint email_delivery_audit_status
  check (delivery_status in ('sent','failed','suppressed_blocked_domain','suppressed_provider_recipient'));
do $$
declare original_definition text; updated_definition text;
begin
  select pg_get_functiondef('public.service_log_email_delivery(text,text,uuid,text,text,text,text)'::regprocedure) into original_definition;
  updated_definition := replace(original_definition, '  insert into private.email_delivery_audit (',
    E'  if target_delivery_status not in (''sent'',''failed'',''suppressed_blocked_domain'',''suppressed_provider_recipient'') then\n    raise invalid_parameter_value using message = ''Unsupported email delivery status.'';\n  end if;\n  insert into private.email_delivery_audit (');
  if updated_definition=original_definition then raise exception 'Email audit validation insertion failed.'; end if;
  execute updated_definition;
end;
$$;

-- Deliberate authorized retries create one new generation; terminal evidence never resets.
alter table private.notification_outbox add column retry_of_notification_id uuid unique references private.notification_outbox(id);

create or replace function public.retry_notification_job(target_outbox_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); parent private.notification_outbox%rowtype; affected integer;
begin
  if actor_id is null or not public.has_effective_permission('notifications.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  select * into parent from private.notification_outbox where id=target_outbox_id;
  if parent.id is null then raise no_data_found using message = 'The notification job could not be found.'; end if;
  insert into private.notification_outbox(message_type,aggregate_type,aggregate_id,recipient_employee_id,payload,idempotency_key,retry_of_notification_id)
  select delivery.message_type,delivery.aggregate_type,delivery.aggregate_id,delivery.recipient_employee_id,delivery.payload,
    'notification-retry:' || delivery.id::text,delivery.id
  from private.notification_outbox delivery
  where delivery.aggregate_type=parent.aggregate_type and delivery.aggregate_id is not distinct from parent.aggregate_id
    and delivery.message_type=parent.message_type and delivery.delivered_at is null and delivery.failed_at is not null
    and delivery.terminal_outcome in ('failed','retry_exhausted')
  on conflict (retry_of_notification_id) do nothing;
  get diagnostics affected=row_count;
  insert into private.notification_retry_events(outbox_id,aggregate_type,aggregate_id,action,affected_count,actor_id)
  values(parent.id,parent.aggregate_type,parent.aggregate_id,'retry_one',affected,actor_id);
  return jsonb_build_object('retried',affected);
end;
$$;

create or replace function public.retry_all_failed_notifications()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare actor_id uuid := private.current_employee_id(); affected integer;
begin
  if actor_id is null or not public.has_effective_permission('notifications.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  insert into private.notification_outbox(message_type,aggregate_type,aggregate_id,recipient_employee_id,payload,idempotency_key,retry_of_notification_id)
  select delivery.message_type,delivery.aggregate_type,delivery.aggregate_id,delivery.recipient_employee_id,delivery.payload,
    'notification-retry:' || delivery.id::text,delivery.id
  from private.notification_outbox delivery
  where delivery.delivered_at is null and delivery.failed_at is not null and delivery.terminal_outcome in ('failed','retry_exhausted')
  on conflict (retry_of_notification_id) do nothing;
  get diagnostics affected=row_count;
  insert into private.notification_retry_events(aggregate_type,action,affected_count,actor_id)
  values('all','retry_all',affected,actor_id);
  return jsonb_build_object('retried',affected);
end;
$$;

-- Preserve authorization, filters and pagination in the verified reader; report leaf generations.
do $$
declare original_definition text; updated_definition text;
  status_expression text := $status$case
    when bool_or(outbox.terminal_outcome='failed') then 'failed'
    when bool_or(outbox.terminal_outcome='retry_exhausted') then 'retry_exhausted'
    when bool_or(outbox.delivered_at is null and outbox.failed_at is null) then 'queued'
    when bool_or(outbox.delivered_at is not null) then 'delivered'
    when bool_or(outbox.terminal_outcome='suppressed') then 'suppressed'
    else 'canceled' end$status$;
begin
  select pg_get_functiondef('public.get_notification_center(text,text,date,date,integer,integer)'::regprocedure) into original_definition;
  updated_definition := regexp_replace(original_definition,
    'case\s+when bool_or\(outbox.failed_at is not null\) then ''failed''\s+when bool_and\(outbox.delivered_at is not null\) then ''delivered''\s+else ''queued''\s+end', status_expression, 'g');
  updated_definition := replace(updated_definition, 'from private.notification_outbox outbox',
    'from private.notification_outbox outbox where not exists (select 1 from private.notification_outbox retry where retry.retry_of_notification_id=outbox.id)');
  updated_definition := replace(updated_definition, '''failed'', count(*) filter (where status = ''failed'')',
    '''failed'', count(*) filter (where status = ''failed''), ''suppressed'', count(*) filter (where status = ''suppressed''), ''canceled'', count(*) filter (where status = ''canceled''), ''retryExhausted'', count(*) filter (where status = ''retry_exhausted'')');
  if updated_definition=original_definition or updated_definition like '%bool_or(outbox.failed_at is not null)%'
    or updated_definition not like '%''retryExhausted''%' then raise exception 'Notification reader transformation failed.'; end if;
  execute updated_definition;
end;
$$;
create or replace function public.get_notification_center()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.get_notification_center('all'::text,null::text,null::date,null::date,1,10);
$$;

notify pgrst, 'reload schema';
commit;

begin;

-- A provider send and a Postgres commit cannot be one atomic transaction.  This
-- table is the durable, per-recipient fence that is written before a provider
-- call.  A retry can finish job bookkeeping, but it must never blindly send a
-- recipient again when the provider outcome is already accepted or uncertain.
create table private.email_recipient_dispatches (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null,
  source_id uuid not null,
  intended_recipient text not null,
  notification_type text not null,
  related_record_type text,
  related_record_id uuid,
  dispatch_token uuid not null default gen_random_uuid(),
  state text not null default 'dispatching',
  provider_reference text,
  failure_detail text,
  audit_id uuid references private.email_delivery_audit(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint email_recipient_dispatch_source_kind
    check (source_kind in ('attendance_accountability_event', 'notification_outbox', 'support_ticket_notification', 'employee_notification_delivery', 'inline_email')),
  constraint email_recipient_dispatch_recipient
    check (btrim(intended_recipient) <> '' and intended_recipient = lower(btrim(intended_recipient))),
  constraint email_recipient_dispatch_notification_type check (btrim(notification_type) <> ''),
  constraint email_recipient_dispatch_state
    check (state in ('dispatching', 'accepted', 'suppressed', 'uncertain', 'retry_approved')),
  constraint email_recipient_dispatch_terminal_time
    check (
      (state in ('dispatching', 'retry_approved') and completed_at is null)
      or (state not in ('dispatching', 'retry_approved') and completed_at is not null)
    ),
  unique (source_kind, source_id, intended_recipient, notification_type),
  unique (dispatch_token)
);

create index email_recipient_dispatch_review_idx
  on private.email_recipient_dispatches(state, updated_at, id)
  where state in ('dispatching', 'uncertain');

revoke all on table private.email_recipient_dispatches from public, anon, authenticated;

-- The first complete normalized recipient set is part of the durable source
-- identity. A retry must use that exact set: accepting additions, removals, or
-- address substitutions would let a partially-completed source be relabeled as
-- delivered even though a different set of people was actually contacted.
create table private.email_recipient_dispatch_manifests (
  source_kind text not null,
  source_id uuid not null,
  intended_recipients text[] not null,
  notification_type text not null,
  related_record_type text,
  related_record_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  constraint email_recipient_dispatch_manifest_pk primary key (source_kind, source_id),
  constraint email_recipient_dispatch_manifest_source_kind
    check (source_kind in ('attendance_accountability_event', 'notification_outbox', 'support_ticket_notification', 'employee_notification_delivery', 'inline_email')),
  constraint email_recipient_dispatch_manifest_recipient_count
    check (cardinality(intended_recipients) between 1 and 500),
  constraint email_recipient_dispatch_manifest_notification_type
    check (btrim(notification_type) <> '')
);

revoke all on table private.email_recipient_dispatch_manifests from public, anon, authenticated, service_role;

create or replace function private.reject_email_recipient_dispatch_manifest_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise check_violation using message = 'Email recipient manifests are immutable.';
end
$$;

create trigger email_recipient_dispatch_manifest_immutable
before update or delete on private.email_recipient_dispatch_manifests
for each row execute function private.reject_email_recipient_dispatch_manifest_mutation();

revoke all on function private.reject_email_recipient_dispatch_manifest_mutation()
  from public, anon, authenticated, service_role;

create or replace function private.ensure_email_recipient_dispatch_manifest(
  target_source_kind text,
  target_source_id uuid,
  target_intended_recipients jsonb,
  target_notification_type text,
  target_related_record_type text default null,
  target_related_record_id uuid default null,
  target_require_exact boolean default true
)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_notification_type text := left(btrim(coalesce(target_notification_type, '')), 100);
  clean_related_record_type text := nullif(left(btrim(coalesce(target_related_record_type, '')), 100), '');
  manifest_record private.email_recipient_dispatch_manifests%rowtype;
  normalized_recipients text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_source_kind not in ('attendance_accountability_event', 'notification_outbox', 'support_ticket_notification', 'employee_notification_delivery', 'inline_email') then
    raise check_violation using message = 'Unsupported email dispatch source.';
  end if;
  if target_source_id is null then
    raise check_violation using message = 'Email dispatch source id is required.';
  end if;
  if clean_notification_type = '' then
    raise check_violation using message = 'Notification type is required.';
  end if;
  if jsonb_typeof(target_intended_recipients) <> 'array' then
    raise check_violation using message = 'Email recipients must be an array.';
  end if;

  select coalesce(array_agg(unique_recipient.recipient order by unique_recipient.recipient), array[]::text[])
  into normalized_recipients
  from (
    select distinct lower(btrim(value)) as recipient
    from jsonb_array_elements_text(target_intended_recipients)
    where btrim(value) <> ''
  ) unique_recipient;

  if cardinality(normalized_recipients) < 1 or cardinality(normalized_recipients) > 500 then
    raise check_violation using message = 'Email dispatch requires between 1 and 500 unique recipients.';
  end if;
  if exists (
    select 1
    from unnest(normalized_recipients) recipient(value)
    where length(recipient.value) > 320 or position('@' in recipient.value) <= 1
  ) then
    raise check_violation using message = 'A valid email recipient is required.';
  end if;

  -- The transaction-scoped source lock serializes the first manifest insert
  -- with every later exact retry, including concurrent attempts that arrive
  -- before any per-recipient dispatch row exists.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-recipient-manifest:' || target_source_kind || ':' || target_source_id::text,
      0
    )
  );

  select manifest.* into manifest_record
  from private.email_recipient_dispatch_manifests manifest
  where manifest.source_kind = target_source_kind
    and manifest.source_id = target_source_id
  for update;

  if not found then
    insert into private.email_recipient_dispatch_manifests (
      source_kind,
      source_id,
      intended_recipients,
      notification_type,
      related_record_type,
      related_record_id
    ) values (
      target_source_kind,
      target_source_id,
      normalized_recipients,
      clean_notification_type,
      clean_related_record_type,
      target_related_record_id
    )
    returning * into manifest_record;
  elsif manifest_record.notification_type is distinct from clean_notification_type
    or manifest_record.related_record_type is distinct from clean_related_record_type
    or manifest_record.related_record_id is distinct from target_related_record_id
  then
    raise check_violation using message = 'Email dispatch source metadata does not match its original manifest.';
  elsif coalesce(target_require_exact, true)
    and manifest_record.intended_recipients is distinct from normalized_recipients
  then
    raise check_violation using message = 'Email recipients do not match the original dispatch manifest.';
  elsif not coalesce(target_require_exact, true)
    and not normalized_recipients <@ manifest_record.intended_recipients
  then
    raise check_violation using message = 'Email recipient is not part of the original dispatch manifest.';
  end if;

  return manifest_record.intended_recipients;
end
$$;

revoke all on function private.ensure_email_recipient_dispatch_manifest(text, uuid, jsonb, text, text, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.service_prepare_email_recipient_dispatch(
  target_source_kind text,
  target_source_id uuid,
  target_intended_recipient text,
  target_notification_type text,
  target_related_record_type text default null,
  target_related_record_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  dispatch_record private.email_recipient_dispatches%rowtype;
  clean_recipient text := lower(btrim(coalesce(target_intended_recipient, '')));
  inserted boolean := false;
  send_allowed boolean := false;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_source_kind not in ('attendance_accountability_event', 'notification_outbox', 'support_ticket_notification', 'employee_notification_delivery', 'inline_email') then
    raise check_violation using message = 'Unsupported email dispatch source.';
  end if;
  if target_source_id is null then
    raise check_violation using message = 'Email dispatch source id is required.';
  end if;
  if clean_recipient = '' or length(clean_recipient) > 320 or position('@' in clean_recipient) <= 1 then
    raise check_violation using message = 'A valid email recipient is required.';
  end if;
  if nullif(btrim(target_notification_type), '') is null then
    raise check_violation using message = 'Notification type is required.';
  end if;

  -- Single-recipient callers establish a singleton manifest on first use and
  -- may only address a member of an already-established batch manifest.
  perform private.ensure_email_recipient_dispatch_manifest(
    target_source_kind,
    target_source_id,
    jsonb_build_array(clean_recipient),
    target_notification_type,
    target_related_record_type,
    target_related_record_id,
    false
  );

  insert into private.email_recipient_dispatches (
    source_kind,
    source_id,
    intended_recipient,
    notification_type,
    related_record_type,
    related_record_id
  ) values (
    target_source_kind,
    target_source_id,
    clean_recipient,
    left(btrim(target_notification_type), 100),
    nullif(left(btrim(coalesce(target_related_record_type, '')), 100), ''),
    target_related_record_id
  )
  on conflict (source_kind, source_id, intended_recipient, notification_type) do nothing
  returning * into dispatch_record;

  inserted := found;
  send_allowed := inserted;
  if not inserted then
    select * into dispatch_record
    from private.email_recipient_dispatches dispatch
    where dispatch.source_kind = target_source_kind
      and dispatch.source_id = target_source_id
      and dispatch.intended_recipient = clean_recipient
      and dispatch.notification_type = left(btrim(target_notification_type), 100)
    for update;

    if dispatch_record.state = 'retry_approved' then
      update private.email_recipient_dispatches dispatch
      set state = 'dispatching',
          dispatch_token = gen_random_uuid(),
          provider_reference = null,
          failure_detail = null,
          completed_at = null,
          updated_at = clock_timestamp()
      where dispatch.id = dispatch_record.id
      returning * into dispatch_record;
      send_allowed := true;
    end if;
  end if;

  return jsonb_build_object(
    'dispatchId', dispatch_record.id,
    'dispatchToken', dispatch_record.dispatch_token,
    'state', dispatch_record.state,
    'sendAllowed', send_allowed,
    'providerReference', dispatch_record.provider_reference,
    'requiresReview', (not send_allowed and dispatch_record.state in ('dispatching', 'uncertain'))
  );
end
$$;

-- Establish the complete recipient manifest in one transaction before the
-- first provider call. A crash can therefore leave either no fences or every
-- expected fence; review can never finalize a partially-created recipient set.
create or replace function public.service_prepare_email_recipient_dispatch_batch(
  target_source_kind text,
  target_source_id uuid,
  target_intended_recipients jsonb,
  target_notification_type text,
  target_related_record_type text default null,
  target_related_record_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  recipient text;
  decision jsonb;
  decisions jsonb := '[]'::jsonb;
  normalized_recipients text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  normalized_recipients := private.ensure_email_recipient_dispatch_manifest(
    target_source_kind,
    target_source_id,
    target_intended_recipients,
    target_notification_type,
    target_related_record_type,
    target_related_record_id,
    true
  );

  foreach recipient in array normalized_recipients
  loop
    decision := public.service_prepare_email_recipient_dispatch(
      target_source_kind,
      target_source_id,
      recipient,
      target_notification_type,
      target_related_record_type,
      target_related_record_id
    );
    decisions := decisions || jsonb_build_array(
      decision || jsonb_build_object('intendedRecipient', recipient)
    );
  end loop;

  return decisions;
end
$$;

-- Unknown provider outcomes are deliberately not guessed. This queue exposes
-- durable, stale fences for operations review without returning message bodies
-- or other content. A retry is possible only after an operator has independent
-- evidence that the provider did not accept the message.
create or replace function public.service_list_email_recipient_dispatch_review(
  target_limit integer default 50
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'dispatchId', dispatch.id,
    'sourceKind', dispatch.source_kind,
    'sourceId', dispatch.source_id,
    'intendedRecipient', dispatch.intended_recipient,
    'notificationType', dispatch.notification_type,
    'state', dispatch.state,
    'providerReference', dispatch.provider_reference,
    'failureDetail', dispatch.failure_detail,
    'createdAt', dispatch.created_at,
    'updatedAt', dispatch.updated_at
  ) order by dispatch.updated_at, dispatch.id), '[]'::jsonb)
  from (
    select item.*
    from private.email_recipient_dispatches item
    where item.state in ('dispatching', 'uncertain')
      and item.updated_at <= clock_timestamp() - interval '10 minutes'
    order by item.updated_at, item.id
    limit greatest(1, least(coalesce(target_limit, 50), 200))
  ) dispatch
  where (select auth.role()) = 'service_role'
$$;

create or replace function public.service_resolve_email_recipient_dispatch_review(
  target_dispatch_id uuid,
  target_resolution text,
  target_actor_employee_id uuid,
  target_provider_reference text default null,
  target_failure_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  dispatch_record private.email_recipient_dispatches%rowtype;
  audit_status text;
  clean_failure text := nullif(left(btrim(coalesce(target_failure_detail, '')), 500), '');
  unresolved_count integer := 0;
  accepted_count integer := 0;
  suppressed_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_resolution not in ('accepted', 'suppressed', 'retry_verified_unsent') then
    raise check_violation using message = 'Unsupported email dispatch review resolution.';
  end if;
  if target_actor_employee_id is null or not exists (
    select 1 from public.employees employee where employee.id = target_actor_employee_id
  ) then
    raise insufficient_privilege using message = 'An accountable employee is required for email dispatch review.';
  end if;

  select item.* into dispatch_record
  from private.email_recipient_dispatches item
  where item.id = target_dispatch_id
  for update;
  if not found or dispatch_record.state not in ('dispatching', 'uncertain') then
    raise check_violation using message = 'Email dispatch does not require provider review.';
  end if;

  if target_resolution = 'retry_verified_unsent' then
    update private.email_recipient_dispatches item
    set state = 'retry_approved',
        provider_reference = null,
        failure_detail = coalesce(clean_failure, 'Provider non-acceptance verified; retry approved.'),
        completed_at = null,
        updated_at = clock_timestamp()
    where item.id = dispatch_record.id
    returning * into dispatch_record;
  else
    audit_status := case when target_resolution = 'accepted' then 'sent' else 'suppressed_blocked_domain' end;
    if dispatch_record.audit_id is null then
      insert into private.email_delivery_audit (
        notification_type,
        related_record_type,
        related_record_id,
        intended_recipient,
        delivery_status,
        provider_reference,
        failure_detail
      ) values (
        dispatch_record.notification_type,
        dispatch_record.related_record_type,
        dispatch_record.related_record_id,
        dispatch_record.intended_recipient,
        audit_status,
        nullif(left(btrim(coalesce(target_provider_reference, '')), 200), ''),
        case when target_resolution = 'suppressed'
          then coalesce(clean_failure, 'Suppressed - Blocked Domain')
          else clean_failure
        end
      ) returning id into dispatch_record.audit_id;
    end if;

    update private.email_recipient_dispatches item
    set state = target_resolution,
        provider_reference = nullif(left(btrim(coalesce(target_provider_reference, '')), 200), ''),
        failure_detail = clean_failure,
        audit_id = dispatch_record.audit_id,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where item.id = dispatch_record.id
    returning * into dispatch_record;
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    null,
    target_actor_employee_id,
    'private',
    'email_recipient_dispatches',
    'EMAIL_RECIPIENT_DISPATCH_REVIEW_RESOLVED',
    dispatch_record.id::text,
    jsonb_build_object(
      'sourceKind', dispatch_record.source_kind,
      'sourceId', dispatch_record.source_id,
      'resolution', target_resolution,
      'state', dispatch_record.state,
      'providerReference', dispatch_record.provider_reference,
      'failureDetail', dispatch_record.failure_detail
    )
  );

  select
    count(*) filter (where item.state in ('dispatching', 'uncertain', 'retry_approved')),
    count(*) filter (where item.state = 'accepted'),
    count(*) filter (where item.state = 'suppressed')
  into unresolved_count, accepted_count, suppressed_count
  from private.email_recipient_dispatches item
  where item.source_kind = dispatch_record.source_kind
    and item.source_id = dispatch_record.source_id;

  -- Reconcile the source record in the same transaction. This repairs source
  -- rows that exhausted their ordinary attempt budget while the provider
  -- outcome was fenced for review. A multi-recipient source is finalized only
  -- after every recipient fence is terminal; resolving one recipient must not
  -- hide another recipient that still needs provider review.
  if target_resolution = 'retry_verified_unsent'
    and dispatch_record.source_kind = 'notification_outbox'
  then
    update private.notification_outbox source
    set delivered_at = null,
        failed_at = null,
        attempt_count = 0,
        available_at = clock_timestamp(),
        last_error = null
    where source.id = dispatch_record.source_id;
  elsif target_resolution = 'retry_verified_unsent'
    and dispatch_record.source_kind = 'support_ticket_notification'
  then
    update public.support_ticket_notifications source
    set delivered_at = null,
        failed_at = null,
        attempt_count = 0,
        available_at = clock_timestamp(),
        last_error = null
    where source.id = dispatch_record.source_id;
  elsif target_resolution = 'retry_verified_unsent'
    and dispatch_record.source_kind = 'employee_notification_delivery'
  then
    update public.employee_notification_email_deliveries source
    set delivered_at = null,
        failed_at = null,
        attempt_count = 0,
        available_at = clock_timestamp(),
        last_error = null
    where source.id = dispatch_record.source_id;
  elsif target_resolution = 'retry_verified_unsent'
    and dispatch_record.source_kind = 'attendance_accountability_event'
  then
    update public.attendance_accountability_events source
    set dispatch_notified_at = null,
        dispatch_notification_error = null,
        updated_at = clock_timestamp()
    where source.id = dispatch_record.source_id;
  elsif unresolved_count = 0 and dispatch_record.source_kind = 'notification_outbox' then
    update private.notification_outbox source
    set delivered_at = case when accepted_count > 0 then clock_timestamp() else null end,
        failed_at = case when accepted_count = 0 and suppressed_count > 0 then clock_timestamp() else null end,
        last_error = case
          when accepted_count = 0 and suppressed_count > 0
            then coalesce(clean_failure, 'Suppressed after provider review.')
          else null
        end
    where source.id = dispatch_record.source_id;
  elsif unresolved_count = 0 and dispatch_record.source_kind = 'support_ticket_notification' then
    update public.support_ticket_notifications source
    set delivered_at = case when accepted_count > 0 then clock_timestamp() else null end,
        failed_at = case when accepted_count = 0 and suppressed_count > 0 then clock_timestamp() else null end,
        last_error = case
          when accepted_count = 0 and suppressed_count > 0
            then coalesce(clean_failure, 'Suppressed after provider review.')
          else null
        end
    where source.id = dispatch_record.source_id;
  elsif unresolved_count = 0 and dispatch_record.source_kind = 'employee_notification_delivery' then
    update public.employee_notification_email_deliveries source
    set delivered_at = case when accepted_count > 0 then clock_timestamp() else null end,
        failed_at = case when accepted_count = 0 and suppressed_count > 0 then clock_timestamp() else null end,
        last_error = case
          when accepted_count = 0 and suppressed_count > 0
            then coalesce(clean_failure, 'Suppressed after provider review.')
          else null
        end
    where source.id = dispatch_record.source_id;
  elsif unresolved_count = 0 and dispatch_record.source_kind = 'attendance_accountability_event' then
    update public.attendance_accountability_events source
    set dispatch_notified_at = case when accepted_count > 0 then clock_timestamp() else null end,
        dispatch_notification_error = case
          when accepted_count = 0 and suppressed_count > 0
            then coalesce(clean_failure, 'Suppressed after provider review.')
          else null
        end,
        updated_at = clock_timestamp()
    where source.id = dispatch_record.source_id;
  end if;

  return jsonb_build_object(
    'dispatchId', dispatch_record.id,
    'sourceKind', dispatch_record.source_kind,
    'sourceId', dispatch_record.source_id,
    'state', dispatch_record.state,
    'auditId', dispatch_record.audit_id
  );
end
$$;

create or replace function public.service_complete_email_recipient_dispatch(
  target_source_kind text,
  target_source_id uuid,
  target_intended_recipient text,
  target_notification_type text,
  target_dispatch_token uuid,
  target_state text,
  target_provider_reference text default null,
  target_failure_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  dispatch_record private.email_recipient_dispatches%rowtype;
  clean_recipient text := lower(btrim(coalesce(target_intended_recipient, '')));
  audit_status text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_state not in ('accepted', 'suppressed', 'uncertain') then
    raise check_violation using message = 'Unsupported email dispatch outcome.';
  end if;

  select * into dispatch_record
  from private.email_recipient_dispatches dispatch
  where dispatch.source_kind = target_source_kind
    and dispatch.source_id = target_source_id
    and dispatch.intended_recipient = clean_recipient
    and dispatch.notification_type = left(btrim(target_notification_type), 100)
  for update;

  if dispatch_record.id is null or dispatch_record.dispatch_token <> target_dispatch_token then
    raise insufficient_privilege using message = 'Email dispatch fence was not found.';
  end if;

  if dispatch_record.state <> 'dispatching' then
    return jsonb_build_object(
      'dispatchId', dispatch_record.id,
      'dispatchToken', dispatch_record.dispatch_token,
      'state', dispatch_record.state,
      'providerReference', dispatch_record.provider_reference,
      'auditId', dispatch_record.audit_id
    );
  end if;

  if target_state in ('accepted', 'suppressed') then
    audit_status := case when target_state = 'accepted' then 'sent' else 'suppressed_blocked_domain' end;
    insert into private.email_delivery_audit (
      notification_type,
      related_record_type,
      related_record_id,
      intended_recipient,
      delivery_status,
      provider_reference,
      failure_detail
    ) values (
      dispatch_record.notification_type,
      dispatch_record.related_record_type,
      dispatch_record.related_record_id,
      dispatch_record.intended_recipient,
      audit_status,
      nullif(left(btrim(coalesce(target_provider_reference, '')), 200), ''),
      case
        when target_state = 'suppressed' then 'Suppressed - Blocked Domain'
        else null
      end
    ) returning id into dispatch_record.audit_id;
  end if;

  update private.email_recipient_dispatches
  set state = target_state,
      provider_reference = nullif(left(btrim(coalesce(target_provider_reference, '')), 200), ''),
      failure_detail = nullif(left(btrim(coalesce(target_failure_detail, '')), 500), ''),
      audit_id = dispatch_record.audit_id,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = dispatch_record.id
  returning * into dispatch_record;

  return jsonb_build_object(
    'dispatchId', dispatch_record.id,
    'dispatchToken', dispatch_record.dispatch_token,
    'state', dispatch_record.state,
    'providerReference', dispatch_record.provider_reference,
    'auditId', dispatch_record.audit_id
  );
end
$$;

-- Interactive schedule publishing must correlate its delivery result to the
-- exact outbox row it just queued.  The ordinary batch claim remains available
-- to scheduled processing; this service-only path never drains unrelated work.
create or replace function public.service_claim_notification_by_id(target_notification_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  outbox_record private.notification_outbox%rowtype;
  schedule_record public.schedules%rowtype;
  recipients jsonb;
  message jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null then
    raise check_violation using message = 'Notification id is required.';
  end if;

  select * into outbox_record
  from private.notification_outbox outbox
  where outbox.id = target_notification_id
    and outbox.delivered_at is null
    and outbox.failed_at is null
    and outbox.available_at <= clock_timestamp()
    and outbox.attempt_count < 5
  for update skip locked;

  if outbox_record.id is null then
    return '[]'::jsonb;
  end if;
  if outbox_record.message_type <> 'schedule_published' or outbox_record.aggregate_type <> 'schedule' then
    raise check_violation using message = 'Targeted delivery is limited to a queued schedule notification.';
  end if;

  update private.notification_outbox
  set attempted_at = clock_timestamp(),
      attempt_count = attempt_count + 1,
      last_error = null
  where id = outbox_record.id
  returning * into outbox_record;

  select * into schedule_record
  from public.schedules schedule
  where schedule.id = outbox_record.aggregate_id;
  if schedule_record.id is null then
    raise no_data_found using message = 'The published schedule for this notification was not found.';
  end if;

  select coalesce(
    jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
    '[]'::jsonb
  ) into recipients
  from public.employees employee
  join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.status = 'active'
    and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
    and (
      employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
      or exists (
        select 1
        from public.shift_assignments assignment
        join public.shifts shift on shift.id = assignment.shift_id
        where shift.schedule_id = schedule_record.id
          and shift.canceled_at is null
          and assignment.employee_id = employee.id
          and assignment.status <> 'canceled'
      )
    );

  message := jsonb_build_object(
    'subject', concat('SygShift schedule updated: ', to_char(schedule_record.week_starts_on, 'MM/DD/YYYY'), ' week'),
    'text', concat(
      'The SygShift schedule for ',
      to_char(schedule_record.week_starts_on, 'MM/DD/YYYY'),
      ' through ',
      to_char(schedule_record.week_starts_on + 6, 'MM/DD/YYYY'),
      ' has been published.',
      E'\n\nOpen SygShift to review your assigned shifts, open coverage, and any changes that affect your week.',
      E'\n\nRevision: ', schedule_record.revision,
      E'\nAssigned shifts: ', (
        select count(*)
        from public.shift_assignments assignment
        join public.shifts shift on shift.id = assignment.shift_id
        where shift.schedule_id = schedule_record.id
          and shift.canceled_at is null
          and assignment.status <> 'canceled'
      ),
      E'\nOpen slots: ', (
        select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
        from public.shifts shift
        left join lateral (
          select count(*)::integer as active_assignments
          from public.shift_assignments assignment
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        ) assignment_counts on true
        where shift.schedule_id = schedule_record.id
          and shift.canceled_at is null
      )
    ),
    'html', concat(
      '<p>The SygShift schedule for <strong>',
      to_char(schedule_record.week_starts_on, 'MM/DD/YYYY'),
      ' through ',
      to_char(schedule_record.week_starts_on + 6, 'MM/DD/YYYY'),
      '</strong> has been published.</p>',
      '<p>Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.</p>',
      '<ul><li><strong>Revision:</strong> ', schedule_record.revision, '</li>',
      '<li><strong>Assigned shifts:</strong> ', (
        select count(*)
        from public.shift_assignments assignment
        join public.shifts shift on shift.id = assignment.shift_id
        where shift.schedule_id = schedule_record.id
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
        where shift.schedule_id = schedule_record.id
          and shift.canceled_at is null
      ), '</li></ul>'
    )
  );

  return jsonb_build_array(jsonb_build_object(
    'id', outbox_record.id,
    'messageType', outbox_record.message_type,
    'aggregateType', outbox_record.aggregate_type,
    'aggregateId', outbox_record.aggregate_id,
    'attemptCount', outbox_record.attempt_count,
    'recipients', recipients,
    'message', message
  ));
end
$$;

revoke all on function public.service_prepare_email_recipient_dispatch(text, uuid, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.service_prepare_email_recipient_dispatch_batch(text, uuid, jsonb, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.service_complete_email_recipient_dispatch(text, uuid, text, text, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.service_claim_notification_by_id(uuid)
  from public, anon, authenticated;
revoke all on function public.service_list_email_recipient_dispatch_review(integer)
  from public, anon, authenticated;
revoke all on function public.service_resolve_email_recipient_dispatch_review(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_prepare_email_recipient_dispatch(text, uuid, text, text, text, uuid)
  to service_role;
grant execute on function public.service_prepare_email_recipient_dispatch_batch(text, uuid, jsonb, text, text, uuid)
  to service_role;
grant execute on function public.service_complete_email_recipient_dispatch(text, uuid, text, text, uuid, text, text, text)
  to service_role;
grant execute on function public.service_claim_notification_by_id(uuid)
  to service_role;
grant execute on function public.service_list_email_recipient_dispatch_review(integer)
  to service_role;
grant execute on function public.service_resolve_email_recipient_dispatch_review(uuid, text, uuid, text, text)
  to service_role;

comment on table private.email_recipient_dispatches is
  'Per-recipient at-most-once provider dispatch fences. Dispatching or uncertain rows require reconciliation and must never be blindly resent.';
comment on table private.email_recipient_dispatch_manifests is
  'Immutable first-recipient-set fence for one durable email source. Exact retries cannot add, remove, or substitute recipients.';

notify pgrst, 'reload schema';

commit;

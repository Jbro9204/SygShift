begin;

-- Claiming a queue row is only a lease. A network response can be lost after
-- this transaction commits, so attempts are consumed only by a recorded
-- processing outcome, never by the claim itself.
alter table private.notification_outbox
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz;

alter table public.support_ticket_notifications
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz;

alter table public.employee_notification_email_deliveries
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz;

alter table private.notification_outbox
  drop constraint if exists notification_outbox_claim_lease_shape,
  add constraint notification_outbox_claim_lease_shape
    check (claim_expires_at is null or claim_token is not null);

alter table public.support_ticket_notifications
  drop constraint if exists support_ticket_notification_claim_lease_shape,
  add constraint support_ticket_notification_claim_lease_shape
    check (claim_expires_at is null or claim_token is not null);

alter table public.employee_notification_email_deliveries
  drop constraint if exists employee_notification_email_claim_lease_shape,
  add constraint employee_notification_email_claim_lease_shape
    check (claim_expires_at is null or claim_token is not null);

create index if not exists notification_outbox_claim_lease_idx
  on private.notification_outbox(claim_expires_at, id)
  where delivered_at is null and failed_at is null;
create index if not exists support_ticket_notification_claim_lease_idx
  on public.support_ticket_notifications(claim_expires_at, id)
  where delivered_at is null and failed_at is null;
create index if not exists employee_notification_email_claim_lease_idx
  on public.employee_notification_email_deliveries(claim_expires_at, id)
  where delivered_at is null and failed_at is null;

create table private.email_job_claim_results (
  source_kind text not null,
  source_id uuid not null,
  claim_token uuid not null,
  outcome text not null,
  failure_detail text,
  result jsonb not null,
  resolved_at timestamptz not null default clock_timestamp(),
  constraint email_job_claim_results_pk primary key (source_kind, source_id, claim_token),
  constraint email_job_claim_results_token_unique unique (claim_token),
  constraint email_job_claim_results_source_kind
    check (source_kind in ('notification_outbox', 'support_ticket_notification', 'employee_notification_delivery')),
  constraint email_job_claim_results_outcome
    check (outcome in ('delivered', 'failed', 'suppressed')),
  constraint email_job_claim_results_object check (jsonb_typeof(result) = 'object')
);

revoke all on table private.email_job_claim_results
  from public, anon, authenticated, service_role;

-- Manual review is itself an externally retried write. Bind one caller
-- operation to one dispatch generation and immutable evidence.
create table private.email_dispatch_review_operations (
  operation_id uuid primary key,
  dispatch_id uuid not null references private.email_recipient_dispatches(id) on delete restrict,
  dispatch_token uuid not null,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  resolution text not null,
  provider_reference text,
  failure_detail text,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint email_dispatch_review_operation_resolution
    check (resolution in ('accepted', 'suppressed', 'retry_verified_unsent', 'failed_verified_unsent')),
  constraint email_dispatch_review_operation_result check (jsonb_typeof(result) = 'object')
);

revoke all on table private.email_dispatch_review_operations
  from public, anon, authenticated, service_role;

create or replace function private.reject_email_durability_ledger_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise check_violation using message = 'Email durability ledgers are immutable.';
end
$$;

create trigger email_job_claim_results_immutable
before update or delete on private.email_job_claim_results
for each row execute function private.reject_email_durability_ledger_mutation();

create trigger email_dispatch_review_operations_immutable
before update or delete on private.email_dispatch_review_operations
for each row execute function private.reject_email_durability_ledger_mutation();

revoke all on function private.reject_email_durability_ledger_mutation()
  from public, anon, authenticated, service_role;

-- A verified-unsent review is a truthful terminal failure when the source has
-- no replayable queue. It is distinct from suppression and from uncertainty.
alter table private.email_recipient_dispatches
  drop constraint if exists email_recipient_dispatch_state,
  drop constraint if exists email_recipient_dispatch_terminal_time;

alter table private.email_recipient_dispatches
  add constraint email_recipient_dispatch_state
    check (state in ('dispatching', 'accepted', 'suppressed', 'uncertain', 'retry_approved', 'failed')),
  add constraint email_recipient_dispatch_terminal_time
    check (
      (state in ('dispatching', 'retry_approved') and completed_at is null)
      or (state not in ('dispatching', 'retry_approved') and completed_at is not null)
    );

create or replace function private.reconcile_terminal_email_dispatch_source(
  target_source_kind text,
  target_source_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  unresolved_count integer;
  accepted_count integer;
  suppressed_count integer;
  failed_count integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_source_kind not in (
    'notification_outbox',
    'support_ticket_notification',
    'employee_notification_delivery',
    'attendance_accountability_event',
    'inline_email'
  ) or target_source_id is null then
    raise check_violation using message = 'A supported email source is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:' || target_source_kind || ':' || target_source_id::text,
      0
    )
  );

  select
    count(*) filter (where item.state in ('dispatching', 'uncertain', 'retry_approved')),
    count(*) filter (where item.state = 'accepted'),
    count(*) filter (where item.state = 'suppressed'),
    count(*) filter (where item.state = 'failed')
  into unresolved_count, accepted_count, suppressed_count, failed_count
  from private.email_recipient_dispatches item
  where item.source_kind = target_source_kind
    and item.source_id = target_source_id;

  if unresolved_count > 0 or accepted_count + suppressed_count + failed_count = 0 then
    return jsonb_build_object('reconciled', false, 'unresolvedCount', unresolved_count);
  end if;

  if target_source_kind = 'notification_outbox' then
    update private.notification_outbox source
    set delivered_at = case when accepted_count > 0 then coalesce(source.delivered_at, clock_timestamp()) else null end,
        failed_at = case when accepted_count = 0 then coalesce(source.failed_at, clock_timestamp()) else null end,
        last_error = case when accepted_count = 0
          then coalesce(source.last_error, 'No recipient delivery was accepted.')
          else null
        end,
        claim_expires_at = null
    where source.id = target_source_id;
  elsif target_source_kind = 'support_ticket_notification' then
    update public.support_ticket_notifications source
    set delivered_at = case when accepted_count > 0 then coalesce(source.delivered_at, clock_timestamp()) else null end,
        failed_at = case when accepted_count = 0 then coalesce(source.failed_at, clock_timestamp()) else null end,
        last_error = case when accepted_count = 0
          then coalesce(source.last_error, 'No recipient delivery was accepted.')
          else null
        end,
        claim_expires_at = null
    where source.id = target_source_id;
  elsif target_source_kind = 'employee_notification_delivery' then
    update public.employee_notification_email_deliveries source
    set delivered_at = case when accepted_count > 0 then coalesce(source.delivered_at, clock_timestamp()) else null end,
        failed_at = case when accepted_count = 0 then coalesce(source.failed_at, clock_timestamp()) else null end,
        last_error = case when accepted_count = 0
          then coalesce(source.last_error, 'No recipient delivery was accepted.')
          else null
        end,
        claim_expires_at = null
    where source.id = target_source_id;
  elsif target_source_kind = 'attendance_accountability_event' then
    update public.attendance_accountability_events source
    set dispatch_notified_at = case when accepted_count > 0
          then coalesce(source.dispatch_notified_at, clock_timestamp())
          else null
        end,
        dispatch_notification_error = case when accepted_count = 0
          then coalesce(source.dispatch_notification_error, 'No recipient delivery was accepted.')
          else null
        end,
        updated_at = clock_timestamp()
    where source.id = target_source_id;
  end if;

  return jsonb_build_object(
    'reconciled', true,
    'acceptedCount', accepted_count,
    'suppressedCount', suppressed_count,
    'failedCount', failed_count
  );
end
$$;

revoke all on function private.reconcile_terminal_email_dispatch_source(text, uuid)
  from public, anon, authenticated, service_role;

-- Attendance delivery bookkeeping is derived from the durable recipient fence
-- whenever one exists. A lost completion response must not let a later
-- best-effort "failed" mark overwrite an already accepted terminal outcome.
create or replace function public.service_mark_attendance_accountability_dispatch_result(
  target_event_id uuid,
  delivered boolean,
  delivery_error text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reconciliation jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_event_id is null then
    raise check_violation using message = 'Attendance event id is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:attendance_accountability_event:' || target_event_id::text,
      0
    )
  );
  reconciliation := private.reconcile_terminal_email_dispatch_source(
    'attendance_accountability_event',
    target_event_id
  );

  if coalesce((reconciliation ->> 'reconciled')::boolean, false) then
    return exists (
      select 1 from public.attendance_accountability_events event where event.id = target_event_id
    );
  end if;

  update public.attendance_accountability_events event
  set dispatch_notified_at = case when delivered
        then coalesce(event.dispatch_notified_at, clock_timestamp())
        else event.dispatch_notified_at
      end,
      dispatch_notification_error = case when delivered
        then null
        else left(coalesce(nullif(btrim(delivery_error), ''), 'Email delivery failed.'), 500)
      end,
      updated_at = clock_timestamp()
  where event.id = target_event_id;

  return found;
end
$$;

revoke all on function public.service_mark_attendance_accountability_dispatch_result(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.service_mark_attendance_accountability_dispatch_result(uuid, boolean, text)
  to service_role;

create or replace function private.apply_email_job_claim_lease(
  target_source_kind text,
  target_jobs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_record record;
  job_id uuid;
  leased_token uuid;
  stored_attempt_count integer;
  stored_payload jsonb;
  leased_jobs jsonb := '[]'::jsonb;
  lease_until timestamptz;
  leased_job jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_source_kind not in ('notification_outbox', 'support_ticket_notification', 'employee_notification_delivery') then
    raise check_violation using message = 'Unsupported email queue source.';
  end if;
  if jsonb_typeof(coalesce(target_jobs, '[]'::jsonb)) <> 'array' then
    raise check_violation using message = 'Claimed jobs must be an array.';
  end if;

  for job_record in
    select item.value as job, item.ordinality
    from jsonb_array_elements(coalesce(target_jobs, '[]'::jsonb))
      with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    begin
      job_id := (job_record.job ->> 'id')::uuid;
    exception when others then
      raise check_violation using message = 'A claimed email job has an invalid id.';
    end;
    lease_until := clock_timestamp() + interval '5 minutes';
    leased_token := gen_random_uuid();
    stored_payload := null;

    if target_source_kind = 'notification_outbox' then
      update private.notification_outbox source
      set claim_token = leased_token,
          claim_expires_at = lease_until,
          attempted_at = clock_timestamp(),
          available_at = lease_until,
          attempt_count = greatest(source.attempt_count - 1, 0),
          last_error = null
      where source.id = job_id
        and source.delivered_at is null
        and source.failed_at is null
      returning source.attempt_count, source.payload
      into stored_attempt_count, stored_payload;
    elsif target_source_kind = 'support_ticket_notification' then
      update public.support_ticket_notifications source
      set claim_token = leased_token,
          claim_expires_at = lease_until,
          attempted_at = clock_timestamp(),
          available_at = lease_until,
          attempt_count = greatest(source.attempt_count - 1, 0),
          last_error = null
      where source.id = job_id
        and source.delivered_at is null
        and source.failed_at is null
      returning source.attempt_count into stored_attempt_count;
    else
      update public.employee_notification_email_deliveries source
      set claim_token = leased_token,
          claim_expires_at = lease_until,
          attempted_at = clock_timestamp(),
          available_at = lease_until,
          attempt_count = greatest(source.attempt_count - 1, 0),
          last_error = null
      where source.id = job_id
        and source.delivered_at is null
        and source.failed_at is null
      returning source.attempt_count into stored_attempt_count;
    end if;

    if not found then
      continue;
    end if;

    leased_job := job_record.job || jsonb_build_object(
      'claimToken', leased_token,
      'attemptCount', stored_attempt_count + 1
    );
    if target_source_kind = 'notification_outbox'
      and stored_payload -> 'recipientManifestFrozen' = 'true'::jsonb
      and jsonb_typeof(stored_payload -> 'deliveryRecipients') = 'array'
      and jsonb_typeof(stored_payload -> 'deliveryMessage') = 'object'
    then
      leased_job := (leased_job - 'recipients' - 'message') || jsonb_build_object(
        'recipients', stored_payload -> 'deliveryRecipients',
        'message', stored_payload -> 'deliveryMessage',
        'recipientManifestFrozen', true
      );
    else
      leased_job := leased_job || jsonb_build_object(
        'recipientManifestFrozen', coalesce((leased_job ->> 'recipientManifestFrozen')::boolean, false)
      );
    end if;

    leased_jobs := leased_jobs || jsonb_build_array(leased_job);
  end loop;

  return leased_jobs;
end
$$;

revoke all on function private.apply_email_job_claim_lease(text, jsonb)
  from public, anon, authenticated, service_role;

-- Preserve the existing rendering and lifecycle filters behind private
-- functions, then wrap every queue lane with the same durable lease contract.
alter function public.service_claim_notification_batch(integer)
  rename to service_claim_notification_batch_pre_durable_lease;
alter function public.service_claim_notification_batch_pre_durable_lease(integer)
  set schema private;

alter function public.service_claim_timekeeping_notification_batch(integer)
  rename to service_claim_timekeeping_notification_batch_pre_durable_lease;
alter function public.service_claim_timekeeping_notification_batch_pre_durable_lease(integer)
  set schema private;

alter function public.service_claim_time_off_notification_batch(integer)
  rename to service_claim_time_off_notification_batch_pre_durable_lease;
alter function public.service_claim_time_off_notification_batch_pre_durable_lease(integer)
  set schema private;

alter function public.service_claim_support_ticket_notification_batch(integer)
  rename to service_claim_support_ticket_notification_batch_pre_durable_lease;
alter function public.service_claim_support_ticket_notification_batch_pre_durable_lease(integer)
  set schema private;

alter function public.service_claim_employee_notification_batch(integer)
  rename to service_claim_employee_notification_batch_pre_durable_lease;
alter function public.service_claim_employee_notification_batch_pre_durable_lease(integer)
  set schema private;

alter function public.service_claim_notification_by_id(uuid)
  rename to service_claim_notification_by_id_pre_durable_lease;
alter function public.service_claim_notification_by_id_pre_durable_lease(uuid)
  set schema private;

revoke all on function private.service_claim_notification_batch_pre_durable_lease(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.service_claim_timekeeping_notification_batch_pre_durable_lease(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.service_claim_time_off_notification_batch_pre_durable_lease(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.service_claim_support_ticket_notification_batch_pre_durable_lease(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.service_claim_employee_notification_batch_pre_durable_lease(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.service_claim_notification_by_id_pre_durable_lease(uuid)
  from public, anon, authenticated, service_role;

create function public.service_claim_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(target_limit, 10), 1), 25);
  frozen_jobs jsonb := '[]'::jsonb;
  jobs jsonb := '[]'::jsonb;
  remaining_limit integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  -- Security-key mutations freeze their exact recipient and rendered content in
  -- the same transaction as the credential change. Claim those durable payloads
  -- explicitly because the legacy renderer predates these message types.
  with pending as (
    select outbox.id
    from private.notification_outbox outbox
    where outbox.message_type in ('security_key_added', 'security_key_removed')
      and outbox.delivered_at is null
      and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp()
      and outbox.attempt_count < 5
      and outbox.payload -> 'recipientManifestFrozen' = 'true'::jsonb
      and jsonb_typeof(outbox.payload -> 'deliveryRecipients') = 'array'
      and jsonb_typeof(outbox.payload -> 'deliveryMessage') = 'object'
    order by outbox.available_at, outbox.created_at, outbox.id
    limit clean_limit
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set attempted_at = clock_timestamp(),
        attempt_count = outbox.attempt_count + 1,
        last_error = null
    from pending
    where outbox.id = pending.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', outbox.id,
    'messageType', outbox.message_type,
    'aggregateType', outbox.aggregate_type,
    'aggregateId', outbox.aggregate_id,
    'attemptCount', outbox.attempt_count,
    'recipients', outbox.payload -> 'deliveryRecipients',
    'message', outbox.payload -> 'deliveryMessage',
    'recipientManifestFrozen', true
  ) order by outbox.created_at, outbox.id), '[]'::jsonb)
  into frozen_jobs
  from touched outbox;

  remaining_limit := clean_limit - jsonb_array_length(frozen_jobs);
  if remaining_limit > 0 then
    jobs := private.service_claim_notification_batch_pre_durable_lease(remaining_limit);
  end if;
  return private.apply_email_job_claim_lease(
    'notification_outbox',
    frozen_jobs || coalesce(jobs, '[]'::jsonb)
  );
end
$$;

create function public.service_claim_timekeeping_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare jobs jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  jobs := private.service_claim_timekeeping_notification_batch_pre_durable_lease(target_limit);
  return private.apply_email_job_claim_lease('notification_outbox', jobs);
end
$$;

create function public.service_claim_time_off_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare jobs jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  jobs := private.service_claim_time_off_notification_batch_pre_durable_lease(target_limit);
  return private.apply_email_job_claim_lease('notification_outbox', jobs);
end
$$;

create function public.service_claim_support_ticket_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare jobs jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  jobs := private.service_claim_support_ticket_notification_batch_pre_durable_lease(target_limit);
  return private.apply_email_job_claim_lease('support_ticket_notification', jobs);
end
$$;

create function public.service_claim_employee_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare jobs jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  jobs := private.service_claim_employee_notification_batch_pre_durable_lease(target_limit);
  return private.apply_email_job_claim_lease('employee_notification_delivery', jobs);
end
$$;

create function public.service_claim_notification_by_id(target_notification_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare jobs jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_notification_id is null then
    raise check_violation using message = 'Notification id is required.';
  end if;
  -- A targeted interactive retry must serialize with recipient completion and
  -- operator review for this exact source. Without the source lock, it could
  -- inspect a pre-completion snapshot and reclaim work while the accepted
  -- recipient result is being projected back to the outbox.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:notification_outbox:' || target_notification_id::text,
      0
    )
  );
  perform private.reconcile_terminal_email_dispatch_source(
    'notification_outbox',
    target_notification_id
  );
  jobs := private.service_claim_notification_by_id_pre_durable_lease(target_notification_id);
  return private.apply_email_job_claim_lease('notification_outbox', jobs);
end
$$;

create or replace function private.resolve_email_job_claim(
  target_source_kind text,
  target_source_id uuid,
  target_claim_token uuid,
  target_outcome text,
  target_failure_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  prior_result private.email_job_claim_results%rowtype;
  current_claim_token uuid;
  current_attempt_count integer;
  clean_failure text := case when target_outcome = 'delivered' then null
    else left(coalesce(nullif(btrim(target_failure_detail), ''), 'Delivery failed.'), 1000)
  end;
  reconciliation jsonb;
  source_reconciled boolean := false;
  effective_outcome text;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_source_kind not in ('notification_outbox', 'support_ticket_notification', 'employee_notification_delivery')
    or target_source_id is null or target_claim_token is null
    or target_outcome not in ('delivered', 'failed', 'suppressed')
  then
    raise check_violation using message = 'A valid claimed email outcome is required.';
  end if;

  select ledger.* into prior_result
  from private.email_job_claim_results ledger
  where ledger.source_kind = target_source_kind
    and ledger.source_id = target_source_id
    and ledger.claim_token = target_claim_token;
  if found then
    if prior_result.outcome is distinct from target_outcome
      or prior_result.failure_detail is distinct from clean_failure
    then
      raise check_violation using message = 'Email claim result replay does not match the committed outcome.';
    end if;
    return prior_result.result;
  end if;

  -- Serialize every source projection with completion and manual review. If
  -- all recipient fences are already terminal, those fences are authoritative:
  -- reconcile them and record this exact caller result without overwriting the
  -- accepted/suppressed truth or consuming a failure attempt.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:' || target_source_kind || ':' || target_source_id::text,
      0
    )
  );
  reconciliation := private.reconcile_terminal_email_dispatch_source(
    target_source_kind,
    target_source_id
  );
  source_reconciled := coalesce((reconciliation ->> 'reconciled')::boolean, false);
  effective_outcome := case
    when source_reconciled and coalesce((reconciliation ->> 'acceptedCount')::integer, 0) > 0
      then 'delivered'
    when source_reconciled then 'failed'
    else target_outcome
  end;

  if target_source_kind = 'notification_outbox' then
    select source.claim_token, source.attempt_count
    into current_claim_token, current_attempt_count
    from private.notification_outbox source
    where source.id = target_source_id
    for update;
  elsif target_source_kind = 'support_ticket_notification' then
    select source.claim_token, source.attempt_count
    into current_claim_token, current_attempt_count
    from public.support_ticket_notifications source
    where source.id = target_source_id
    for update;
  else
    select source.claim_token, source.attempt_count
    into current_claim_token, current_attempt_count
    from public.employee_notification_email_deliveries source
    where source.id = target_source_id
    for update;
  end if;

  if not found or current_claim_token is distinct from target_claim_token then
    raise insufficient_privilege using message = 'The email job claim token is stale or invalid.';
  end if;

  -- A second caller may have waited on the source-row lock. Recheck the
  -- immutable ledger after acquiring it so concurrent exact retries converge.
  select ledger.* into prior_result
  from private.email_job_claim_results ledger
  where ledger.source_kind = target_source_kind
    and ledger.source_id = target_source_id
    and ledger.claim_token = target_claim_token;
  if found then
    if prior_result.outcome is distinct from target_outcome
      or prior_result.failure_detail is distinct from clean_failure
    then
      raise check_violation using message = 'Email claim result replay does not match the committed outcome.';
    end if;
    return prior_result.result;
  end if;

  if not source_reconciled and target_source_kind = 'notification_outbox' then
    update private.notification_outbox source
    set delivered_at = case when target_outcome = 'delivered' then clock_timestamp() else null end,
        failed_at = case
          when target_outcome = 'suppressed' then clock_timestamp()
          when target_outcome = 'failed' and source.attempt_count + 1 >= 5 then clock_timestamp()
          else null
        end,
        attempt_count = source.attempt_count + case when target_outcome = 'failed' then 1 else 0 end,
        last_error = case when target_outcome = 'delivered' then null else clean_failure end,
        available_at = case when target_outcome = 'failed'
          then clock_timestamp() + interval '15 minutes'
          else source.available_at
        end,
        claim_expires_at = null
    where source.id = target_source_id;
  elsif not source_reconciled and target_source_kind = 'support_ticket_notification' then
    update public.support_ticket_notifications source
    set delivered_at = case when target_outcome = 'delivered' then clock_timestamp() else null end,
        failed_at = case
          when target_outcome = 'suppressed' then clock_timestamp()
          when target_outcome = 'failed' and source.attempt_count + 1 >= 5 then clock_timestamp()
          else null
        end,
        attempt_count = source.attempt_count + case when target_outcome = 'failed' then 1 else 0 end,
        last_error = case when target_outcome = 'delivered' then null else clean_failure end,
        available_at = case when target_outcome = 'failed'
          then clock_timestamp() + interval '15 minutes'
          else source.available_at
        end,
        claim_expires_at = null
    where source.id = target_source_id;
  elsif not source_reconciled then
    update public.employee_notification_email_deliveries source
    set delivered_at = case when target_outcome = 'delivered' then clock_timestamp() else null end,
        failed_at = case
          when target_outcome = 'suppressed' then clock_timestamp()
          when target_outcome = 'failed' and source.attempt_count + 1 >= 5 then clock_timestamp()
          else null
        end,
        attempt_count = source.attempt_count + case when target_outcome = 'failed' then 1 else 0 end,
        last_error = case when target_outcome = 'delivered' then null else clean_failure end,
        available_at = case when target_outcome = 'failed'
          then clock_timestamp() + interval '15 minutes'
          else source.available_at
        end,
        claim_expires_at = null
    where source.id = target_source_id;
  end if;

  result := jsonb_build_object(
    'sourceKind', target_source_kind,
    'sourceId', target_source_id,
    'claimToken', target_claim_token,
    'outcome', target_outcome,
    'effectiveOutcome', effective_outcome,
    'sourceReconciled', source_reconciled,
    'attemptCount', current_attempt_count + case
      when target_outcome = 'failed' and not source_reconciled then 1 else 0
    end
  );

  insert into private.email_job_claim_results(
    source_kind,
    source_id,
    claim_token,
    outcome,
    failure_detail,
    result
  ) values (
    target_source_kind,
    target_source_id,
    target_claim_token,
    target_outcome,
    clean_failure,
    result
  );

  return result;
end
$$;

revoke all on function private.resolve_email_job_claim(text, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

create function public.service_mark_notification_result(
  target_notification_id uuid,
  target_claim_token uuid,
  delivered boolean,
  delivery_error text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.resolve_email_job_claim(
    'notification_outbox',
    target_notification_id,
    target_claim_token,
    case when delivered then 'delivered' else 'failed' end,
    delivery_error
  )
$$;

create function public.service_mark_notification_suppressed(
  target_notification_id uuid,
  target_claim_token uuid,
  target_reason text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.resolve_email_job_claim(
    'notification_outbox',
    target_notification_id,
    target_claim_token,
    'suppressed',
    target_reason
  )
$$;

create function public.service_mark_support_ticket_notification_result(
  target_notification_id uuid,
  target_claim_token uuid,
  delivered boolean,
  delivery_error text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.resolve_email_job_claim(
    'support_ticket_notification',
    target_notification_id,
    target_claim_token,
    case when delivered then 'delivered' else 'failed' end,
    delivery_error
  )
$$;

create function public.service_mark_employee_notification_result(
  target_delivery_id uuid,
  target_claim_token uuid,
  delivered boolean,
  delivery_error text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.resolve_email_job_claim(
    'employee_notification_delivery',
    target_delivery_id,
    target_claim_token,
    case when delivered then 'delivered' else 'failed' end,
    delivery_error
  )
$$;

-- The old result signatures cannot prove ownership of a claim. Retire them so
-- a stale Worker fails closed during the maintenance cutover.
drop function public.service_mark_notification_result(uuid, boolean, text);
drop function public.service_mark_notification_suppressed(uuid, text);
drop function public.service_mark_support_ticket_notification_result(uuid, boolean, text);
drop function public.service_mark_employee_notification_result(uuid, boolean, text);

create or replace function public.service_get_email_recipient_dispatch_manifest(
  target_source_kind text,
  target_source_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when manifest.source_id is null then null else jsonb_build_object(
    'sourceKind', manifest.source_kind,
    'sourceId', manifest.source_id,
    'intendedRecipients', to_jsonb(manifest.intended_recipients),
    'notificationType', manifest.notification_type,
    'relatedRecordType', manifest.related_record_type,
    'relatedRecordId', manifest.related_record_id
  ) end
  from (select 1) seed
  left join private.email_recipient_dispatch_manifests manifest
    on manifest.source_kind = target_source_kind
   and manifest.source_id = target_source_id
  where coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
$$;

-- Completion is compare-and-swap against the exact dispatch generation. An
-- exact response-loss retry succeeds; a late completion after review or a new
-- retry generation is rejected instead of overwriting the operator decision.
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
  clean_provider_reference text := nullif(left(btrim(coalesce(target_provider_reference, '')), 200), '');
  clean_failure text := nullif(left(btrim(coalesce(target_failure_detail, '')), 500), '');
  audit_status text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_source_kind not in (
    'notification_outbox',
    'support_ticket_notification',
    'employee_notification_delivery',
    'attendance_accountability_event',
    'inline_email'
  ) or target_source_id is null or target_dispatch_token is null then
    raise check_violation using message = 'A supported email dispatch source and generation are required.';
  end if;
  if target_state not in ('accepted', 'suppressed', 'uncertain') then
    raise check_violation using message = 'Unsupported email dispatch outcome.';
  end if;

  -- Keep the source-level lock order identical to manual review and result
  -- reconciliation: source advisory lock first, then recipient row lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:' || target_source_kind || ':' || target_source_id::text,
      0
    )
  );

  select dispatch.* into dispatch_record
  from private.email_recipient_dispatches dispatch
  where dispatch.source_kind = target_source_kind
    and dispatch.source_id = target_source_id
    and dispatch.intended_recipient = clean_recipient
    and dispatch.notification_type = left(btrim(target_notification_type), 100)
  for update;

  if not found or dispatch_record.dispatch_token is distinct from target_dispatch_token then
    raise insufficient_privilege using message = 'Email dispatch generation is stale or invalid.';
  end if;
  if dispatch_record.state <> 'dispatching' then
    if dispatch_record.state is distinct from target_state
      or dispatch_record.provider_reference is distinct from clean_provider_reference
      or dispatch_record.failure_detail is distinct from clean_failure
    then
      raise check_violation using message = 'Email dispatch outcome conflicts with the committed generation state.';
    end if;
    perform private.reconcile_terminal_email_dispatch_source(
      dispatch_record.source_kind,
      dispatch_record.source_id
    );
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
    insert into private.email_delivery_audit(
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
      clean_provider_reference,
      case when target_state = 'suppressed' then 'Suppressed - Blocked Domain' else null end
    ) returning id into dispatch_record.audit_id;
  end if;

  update private.email_recipient_dispatches dispatch
  set state = target_state,
      provider_reference = clean_provider_reference,
      failure_detail = clean_failure,
      audit_id = dispatch_record.audit_id,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where dispatch.id = dispatch_record.id
    and dispatch.dispatch_token = target_dispatch_token
    and dispatch.state = 'dispatching'
  returning dispatch.* into dispatch_record;

  if not found then
    raise serialization_failure using message = 'Email dispatch state changed before completion.';
  end if;

  perform private.reconcile_terminal_email_dispatch_source(
    dispatch_record.source_kind,
    dispatch_record.source_id
  );

  return jsonb_build_object(
    'dispatchId', dispatch_record.id,
    'dispatchToken', dispatch_record.dispatch_token,
    'state', dispatch_record.state,
    'providerReference', dispatch_record.provider_reference,
    'auditId', dispatch_record.audit_id
  );
end
$$;

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
    'reviewToken', dispatch.dispatch_token,
    'sourceKind', dispatch.source_kind,
    'sourceId', dispatch.source_id,
    'intendedRecipient', dispatch.intended_recipient,
    'notificationType', dispatch.notification_type,
    'state', dispatch.state,
    'providerReference', dispatch.provider_reference,
    'failureDetail', dispatch.failure_detail,
    'retryAllowed', dispatch.source_kind in (
      'notification_outbox',
      'support_ticket_notification',
      'employee_notification_delivery'
    ),
    'allowedResolutions', case when dispatch.source_kind in (
      'notification_outbox',
      'support_ticket_notification',
      'employee_notification_delivery'
    ) then jsonb_build_array('accepted', 'suppressed', 'retry_verified_unsent', 'failed_verified_unsent')
      else jsonb_build_array('accepted', 'suppressed', 'failed_verified_unsent')
    end,
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
  where coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
$$;

create or replace function public.service_resolve_email_recipient_dispatch_review(
  target_dispatch_id uuid,
  target_review_token uuid,
  target_operation_id uuid,
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
  operation_record private.email_dispatch_review_operations%rowtype;
  clean_provider_reference text := nullif(left(btrim(coalesce(target_provider_reference, '')), 200), '');
  clean_failure text := nullif(left(btrim(coalesce(target_failure_detail, '')), 500), '');
  audit_status text;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_operation_id is null or target_review_token is null or target_dispatch_id is null then
    raise check_violation using message = 'Review operation, dispatch, and generation are required.';
  end if;
  if target_resolution not in ('accepted', 'suppressed', 'retry_verified_unsent', 'failed_verified_unsent') then
    raise check_violation using message = 'Unsupported email dispatch review resolution.';
  end if;
  if target_resolution in ('retry_verified_unsent', 'failed_verified_unsent')
    and (clean_failure is null or length(clean_failure) < 12)
  then
    raise check_violation using message = 'Verified-unsent review requires a concrete evidence note of at least 12 characters.';
  end if;
  if target_actor_employee_id is null or not exists (
    select 1 from public.employees employee where employee.id = target_actor_employee_id
  ) then
    raise insufficient_privilege using message = 'An accountable employee is required for email dispatch review.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email-dispatch-review-operation:' || target_operation_id::text, 0)
  );
  select operation.* into operation_record
  from private.email_dispatch_review_operations operation
  where operation.operation_id = target_operation_id;
  if found then
    if operation_record.dispatch_id is distinct from target_dispatch_id
      or operation_record.dispatch_token is distinct from target_review_token
      or operation_record.actor_employee_id is distinct from target_actor_employee_id
      or operation_record.resolution is distinct from target_resolution
      or operation_record.provider_reference is distinct from clean_provider_reference
      or operation_record.failure_detail is distinct from clean_failure
    then
      raise check_violation using message = 'Email dispatch review operation conflicts with its committed request.';
    end if;
    return operation_record.result;
  end if;

  select item.* into dispatch_record
  from private.email_recipient_dispatches item
  where item.id = target_dispatch_id;
  if not found then
    raise check_violation using message = 'Email dispatch review target was not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:' || dispatch_record.source_kind || ':' || dispatch_record.source_id::text,
      0
    )
  );

  select item.* into dispatch_record
  from private.email_recipient_dispatches item
  where item.id = target_dispatch_id
  for update;
  if dispatch_record.dispatch_token is distinct from target_review_token then
    raise insufficient_privilege using message = 'Email dispatch review generation is stale.';
  end if;
  if dispatch_record.state not in ('dispatching', 'uncertain') then
    raise check_violation using message = 'Email dispatch does not require provider review.';
  end if;
  if target_resolution = 'retry_verified_unsent'
    and dispatch_record.source_kind not in (
      'notification_outbox',
      'support_ticket_notification',
      'employee_notification_delivery'
    )
  then
    raise check_violation using message = 'This email source has no durable replay queue.';
  end if;

  if target_resolution = 'retry_verified_unsent' then
    update private.email_recipient_dispatches item
    set state = 'retry_approved',
        provider_reference = null,
        failure_detail = clean_failure,
        completed_at = null,
        updated_at = clock_timestamp()
    where item.id = dispatch_record.id
      and item.dispatch_token = target_review_token
      and item.state in ('dispatching', 'uncertain')
    returning item.* into dispatch_record;
  else
    audit_status := case target_resolution
      when 'accepted' then 'sent'
      when 'suppressed' then 'suppressed_blocked_domain'
      else 'failed'
    end;
    if dispatch_record.audit_id is null then
      insert into private.email_delivery_audit(
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
        clean_provider_reference,
        case
          when target_resolution = 'suppressed'
            then coalesce(clean_failure, 'Suppressed - Blocked Domain')
          when target_resolution = 'failed_verified_unsent'
            then clean_failure
          else clean_failure
        end
      ) returning id into dispatch_record.audit_id;
    end if;

    update private.email_recipient_dispatches item
    set state = case when target_resolution = 'failed_verified_unsent' then 'failed' else target_resolution end,
        provider_reference = clean_provider_reference,
        failure_detail = case
          when target_resolution = 'failed_verified_unsent'
            then clean_failure
          else clean_failure
        end,
        audit_id = dispatch_record.audit_id,
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where item.id = dispatch_record.id
      and item.dispatch_token = target_review_token
      and item.state in ('dispatching', 'uncertain')
    returning item.* into dispatch_record;
  end if;

  if not found then
    raise serialization_failure using message = 'Email dispatch review state changed before resolution.';
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
      'operationId', target_operation_id,
      'reviewToken', target_review_token,
      'sourceKind', dispatch_record.source_kind,
      'sourceId', dispatch_record.source_id,
      'resolution', target_resolution,
      'state', dispatch_record.state,
      'providerReference', dispatch_record.provider_reference,
      'failureDetail', dispatch_record.failure_detail
    )
  );

  if target_resolution = 'retry_verified_unsent' then
    if dispatch_record.source_kind = 'notification_outbox' then
      update private.notification_outbox source
      set delivered_at = null,
          failed_at = null,
          available_at = clock_timestamp(),
          last_error = null,
          claim_expires_at = null
      where source.id = dispatch_record.source_id;
    elsif dispatch_record.source_kind = 'support_ticket_notification' then
      update public.support_ticket_notifications source
      set delivered_at = null,
          failed_at = null,
          available_at = clock_timestamp(),
          last_error = null,
          claim_expires_at = null
      where source.id = dispatch_record.source_id;
    else
      update public.employee_notification_email_deliveries source
      set delivered_at = null,
          failed_at = null,
          available_at = clock_timestamp(),
          last_error = null,
          claim_expires_at = null
      where source.id = dispatch_record.source_id;
    end if;
  else
    perform private.reconcile_terminal_email_dispatch_source(
      dispatch_record.source_kind,
      dispatch_record.source_id
    );
  end if;

  result := jsonb_build_object(
    'operationId', target_operation_id,
    'dispatchId', dispatch_record.id,
    'reviewToken', dispatch_record.dispatch_token,
    'sourceKind', dispatch_record.source_kind,
    'sourceId', dispatch_record.source_id,
    'state', dispatch_record.state,
    'auditId', dispatch_record.audit_id
  );

  insert into private.email_dispatch_review_operations(
    operation_id,
    dispatch_id,
    dispatch_token,
    actor_employee_id,
    resolution,
    provider_reference,
    failure_detail,
    result
  ) values (
    target_operation_id,
    target_dispatch_id,
    target_review_token,
    target_actor_employee_id,
    target_resolution,
    clean_provider_reference,
    clean_failure,
    result
  );

  return result;
end
$$;

-- Known-unsent release is not a human provider review. It is allowed only for
-- the exact pre-provider dispatch generation and records a system-truthful
-- nullable initiator instead of attributing signed-out recovery to the target.
create or replace function public.service_release_known_unsent_email_dispatch(
  target_dispatch_id uuid,
  target_dispatch_token uuid,
  target_initiator_employee_id uuid default null,
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
  clean_failure text := left(
    coalesce(nullif(btrim(target_failure_detail), ''), 'No provider call occurred; dispatch released for safe retry.'),
    500
  );
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_dispatch_id is null or target_dispatch_token is null then
    raise check_violation using message = 'Dispatch id and generation token are required.';
  end if;
  if target_initiator_employee_id is not null and not exists (
    select 1 from public.employees employee where employee.id = target_initiator_employee_id
  ) then
    raise check_violation using message = 'Known-unsent initiator is invalid.';
  end if;

  select item.* into dispatch_record
  from private.email_recipient_dispatches item
  where item.id = target_dispatch_id;
  if not found or dispatch_record.dispatch_token is distinct from target_dispatch_token then
    raise insufficient_privilege using message = 'Email dispatch generation is stale or invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-dispatch-source:' || dispatch_record.source_kind || ':' || dispatch_record.source_id::text,
      0
    )
  );
  select item.* into dispatch_record
  from private.email_recipient_dispatches item
  where item.id = target_dispatch_id
  for update;
  if dispatch_record.dispatch_token is distinct from target_dispatch_token then
    raise insufficient_privilege using message = 'Email dispatch generation is stale or invalid.';
  end if;
  if dispatch_record.state = 'retry_approved' then
    if dispatch_record.failure_detail is distinct from clean_failure then
      raise check_violation using message = 'Known-unsent release does not match the committed evidence.';
    end if;
    return jsonb_build_object(
      'dispatchId', dispatch_record.id,
      'dispatchToken', dispatch_record.dispatch_token,
      'state', dispatch_record.state,
      'sourceKind', dispatch_record.source_kind,
      'sourceId', dispatch_record.source_id
    );
  end if;
  if dispatch_record.state <> 'dispatching' then
    raise check_violation using message = 'Only a pre-provider dispatch can be released as known unsent.';
  end if;

  update private.email_recipient_dispatches item
  set state = 'retry_approved',
      provider_reference = null,
      failure_detail = clean_failure,
      completed_at = null,
      updated_at = clock_timestamp()
  where item.id = target_dispatch_id
    and item.dispatch_token = target_dispatch_token
    and item.state = 'dispatching'
  returning item.* into dispatch_record;

  if not found then
    raise serialization_failure using message = 'Email dispatch state changed before known-unsent release.';
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    null,
    target_initiator_employee_id,
    'private',
    'email_recipient_dispatches',
    'EMAIL_RECIPIENT_DISPATCH_KNOWN_UNSENT_RELEASED',
    dispatch_record.id::text,
    jsonb_build_object(
      'dispatchToken', dispatch_record.dispatch_token,
      'sourceKind', dispatch_record.source_kind,
      'sourceId', dispatch_record.source_id,
      'initiatorEmployeeId', target_initiator_employee_id,
      'actorKind', case when target_initiator_employee_id is null then 'system_or_signed_out' else 'authenticated_employee' end,
      'failureDetail', dispatch_record.failure_detail
    )
  );

  return jsonb_build_object(
    'dispatchId', dispatch_record.id,
    'dispatchToken', dispatch_record.dispatch_token,
    'state', dispatch_record.state,
    'sourceKind', dispatch_record.source_kind,
    'sourceId', dispatch_record.source_id
  );
end
$$;

-- Security-key mutations and their notice intent now commit atomically. The
-- outbox payload freezes the recipient and rendered message; it contains no
-- credential id, public key, challenge, or authenticator secret.
create or replace function private.queue_security_key_change_notice()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  action text;
  recipient text;
  display_name text;
  message_subject text;
  message_text text;
begin
  if tg_op = 'INSERT' then
    action := 'added';
  elsif tg_op = 'UPDATE' and old.revoked_at is null and new.revoked_at is not null then
    action := 'removed';
  else
    return new;
  end if;

  select
    btrim(concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name)),
    private.preferred_delivery_email(contact.personal_email, contact.company_email)
  into display_name, recipient
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.id = new.employee_id;

  message_subject := case when action = 'added'
    then 'Security key added to your SygShift account'
    else 'Security key removed from your SygShift account'
  end;
  message_text := concat(
    'Hello ', coalesce(nullif(display_name, ''), 'SygShift user'), ',', E'\n\n',
    'The security key “', coalesce(nullif(btrim(new.label), ''), 'Security key'), '” was ',
    case when action = 'added' then 'added to' else 'removed from' end,
    ' your SygShift account.', E'\n\n',
    'If you made this change, no action is needed.', E'\n',
    'If you did not make this change, contact an administrator immediately and reset your password.', E'\n\n',
    'Review your account security: https://app.sygilant.us/my-account?tab=security'
  );

  insert into private.notification_outbox(
    message_type,
    aggregate_type,
    aggregate_id,
    recipient_employee_id,
    payload,
    idempotency_key
  ) values (
    'security_key_' || action,
    'security_key',
    new.id,
    new.employee_id,
    jsonb_build_object(
      'recipientManifestFrozen', true,
      'deliveryRecipients', case when recipient is null
        then '[]'::jsonb
        else jsonb_build_array(recipient)
      end,
      'deliveryMessage', jsonb_build_object(
        'subject', message_subject,
        'text', message_text
      )
    ),
    'security-key-change:' || action || ':' || new.id::text
  ) on conflict (idempotency_key) do nothing;

  return new;
end
$$;

drop trigger if exists webauthn_credentials_queue_change_notice
  on private.webauthn_credentials;
create trigger webauthn_credentials_queue_change_notice
after insert or update of revoked_at on private.webauthn_credentials
for each row execute function private.queue_security_key_change_notice();

revoke all on function private.queue_security_key_change_notice()
  from public, anon, authenticated, service_role;

-- Retire the response-loss-unsafe manual resolver signature.
drop function public.service_resolve_email_recipient_dispatch_review(uuid, text, uuid, text, text);

revoke all on function public.service_claim_notification_batch(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_timekeeping_notification_batch(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_time_off_notification_batch(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_support_ticket_notification_batch(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_employee_notification_batch(integer)
  from public, anon, authenticated;
revoke all on function public.service_claim_notification_by_id(uuid)
  from public, anon, authenticated;
revoke all on function public.service_mark_notification_result(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.service_mark_notification_suppressed(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_mark_support_ticket_notification_result(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.service_mark_employee_notification_result(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.service_get_email_recipient_dispatch_manifest(text, uuid)
  from public, anon, authenticated;
revoke all on function public.service_complete_email_recipient_dispatch(text, uuid, text, text, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.service_list_email_recipient_dispatch_review(integer)
  from public, anon, authenticated;
revoke all on function public.service_resolve_email_recipient_dispatch_review(uuid, uuid, uuid, text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_release_known_unsent_email_dispatch(uuid, uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.service_claim_notification_batch(integer) to service_role;
grant execute on function public.service_claim_timekeeping_notification_batch(integer) to service_role;
grant execute on function public.service_claim_time_off_notification_batch(integer) to service_role;
grant execute on function public.service_claim_support_ticket_notification_batch(integer) to service_role;
grant execute on function public.service_claim_employee_notification_batch(integer) to service_role;
grant execute on function public.service_claim_notification_by_id(uuid) to service_role;
grant execute on function public.service_mark_notification_result(uuid, uuid, boolean, text) to service_role;
grant execute on function public.service_mark_notification_suppressed(uuid, uuid, text) to service_role;
grant execute on function public.service_mark_support_ticket_notification_result(uuid, uuid, boolean, text) to service_role;
grant execute on function public.service_mark_employee_notification_result(uuid, uuid, boolean, text) to service_role;
grant execute on function public.service_get_email_recipient_dispatch_manifest(text, uuid) to service_role;
grant execute on function public.service_complete_email_recipient_dispatch(text, uuid, text, text, uuid, text, text, text) to service_role;
grant execute on function public.service_list_email_recipient_dispatch_review(integer) to service_role;
grant execute on function public.service_resolve_email_recipient_dispatch_review(uuid, uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.service_release_known_unsent_email_dispatch(uuid, uuid, uuid, text) to service_role;

comment on table private.email_job_claim_results is
  'Immutable result receipts for leased email queue claims. Exact retries replay; stale or drifted tokens fail closed.';
comment on table private.email_dispatch_review_operations is
  'Immutable manual review operation receipts bound to one dispatch generation, actor, resolution, and evidence.';

notify pgrst, 'reload schema';

commit;

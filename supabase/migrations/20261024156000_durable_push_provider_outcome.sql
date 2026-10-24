begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table private.employee_push_deliveries
  add column if not exists provider_state text,
  add column if not exists provider_attempt_id uuid,
  add column if not exists provider_state_changed_at timestamptz,
  add column if not exists provider_outcome text;

-- The previous queue format did not record whether a claimed row had reached
-- the push provider.  Treat every unfinished row with a claim token as
-- uncertain during the upgrade.  Defaulting those rows to pending would allow
-- an accepted legacy request to be sent a second time as soon as this
-- migration installs the new claim function.
create or replace function private.classify_legacy_push_provider_state(
  target_completed_at timestamptz,
  target_claim_token uuid
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when target_completed_at is not null then 'resolved'
    when target_claim_token is not null then 'uncertain'
    else 'pending'
  end
$$;

revoke all on function private.classify_legacy_push_provider_state(timestamptz, uuid)
  from public, anon, authenticated;

update private.employee_push_deliveries delivery
set provider_state = private.classify_legacy_push_provider_state(
      delivery.completed_at,
      delivery.claim_token
    ),
    provider_attempt_id = case
      when delivery.completed_at is null and delivery.claim_token is not null
        then delivery.claim_token
      else null
    end,
    provider_state_changed_at = coalesce(delivery.completed_at, clock_timestamp()),
    provider_outcome = case
      when delivery.completed_at is not null then coalesce(delivery.outcome, 'failed')
      else null
    end,
    outcome = case
      when delivery.completed_at is not null then coalesce(delivery.outcome, 'failed')
      else delivery.outcome
    end
where delivery.provider_state is null
   or (
     delivery.completed_at is not null
     and delivery.provider_outcome is null
   )
   or (
     delivery.completed_at is null
     and delivery.claim_token is not null
     and delivery.provider_state = 'pending'
     and delivery.provider_attempt_id is null
   );

alter table private.employee_push_deliveries
  alter column provider_state set default 'pending',
  alter column provider_state set not null,
  alter column provider_state_changed_at set default clock_timestamp();

update private.employee_push_deliveries delivery
set provider_state_changed_at = clock_timestamp()
where delivery.provider_state_changed_at is null;

alter table private.employee_push_deliveries
  alter column provider_state_changed_at set not null;

alter table private.employee_push_deliveries
  drop constraint if exists employee_push_delivery_provider_state_check;
alter table private.employee_push_deliveries
  add constraint employee_push_delivery_provider_state_check
  check (
    (provider_state in ('pending', 'request_started', 'uncertain') and provider_outcome is null)
    or (provider_state = 'accepted' and provider_outcome = 'delivered')
    or (provider_state = 'resolved' and provider_outcome in ('delivered', 'expired', 'unavailable', 'failed'))
  );

drop index if exists private.employee_push_delivery_provider_review_idx;
create index if not exists employee_push_delivery_provider_review_idx
  on private.employee_push_deliveries(provider_state, provider_state_changed_at, id)
  where completed_at is null
    and provider_state in ('request_started', 'accepted', 'uncertain', 'resolved');

-- Keep the established eligibility and call-off retirement behavior, but place
-- a durable fence in the same claim transaction. A row whose provider outcome
-- is unknown or accepted can never be handed to the provider again.
create or replace function public.service_claim_employee_push(
  target_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claimed jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  -- Only an attempt whose provider request has definitely not started may be
  -- expired or reclaimed automatically.  request_started/accepted/uncertain
  -- rows remain fenced for explicit reconciliation even after their ordinary
  -- lease or attempt budget elapses.
  update private.employee_push_deliveries delivery
  set completed_at = coalesce(delivery.completed_at, clock_timestamp()),
      outcome = coalesce(delivery.outcome, 'expired'),
      provider_state = 'resolved',
      provider_outcome = coalesce(delivery.provider_outcome, delivery.outcome, 'expired'),
      provider_state_changed_at = clock_timestamp()
  from public.employee_notifications notification
  where notification.id = delivery.notification_id
    and delivery.completed_at is null
    and delivery.provider_state = 'pending'
    and (
      notification.created_at < clock_timestamp() - interval '10 minutes'
      or notification.read_at is not null
      or notification.dismissed_at is not null
      or notification.expires_at <= clock_timestamp()
      or (delivery.attempt_count >= 5 and delivery.available_at <= clock_timestamp())
      or notification.resolved_at is not null
      or (
        notification.source_type = 'call_off_request'
        and exists (
          select 1
          from public.call_off_reports report
          join public.shifts shift on shift.id = report.shift_id
          where report.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_coverage'
        and exists (
          select 1
          from public.shift_coverage_cases coverage
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where coverage.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
      or (
        notification.source_type = 'shift_request'
        and exists (
          select 1
          from public.shift_requests request
          join public.shift_coverage_cases coverage
            on coverage.coverage_shift_id = request.shift_id
          join public.call_off_reports report on report.id = coverage.call_off_report_id
          join public.shifts shift on shift.id = report.shift_id
          where request.id = notification.source_id
            and (
              report.canceled_at is not null
              or report.resolved_at is not null
              or report.duplicate_of_call_off_report_id is not null
              or not report.replacement_needed
              or clock_timestamp() >= shift.ends_at + interval '1 hour'
            )
        )
      )
    );

  with pending as (
    select delivery.id, gen_random_uuid() as next_claim_token
    from private.employee_push_deliveries delivery
    where delivery.completed_at is null
      and delivery.provider_state = 'pending'
      and delivery.available_at <= clock_timestamp()
    order by delivery.available_at
    limit least(greatest(coalesce(target_limit, 25), 1), 50)
    for update skip locked
  ), claimed_rows as (
    update private.employee_push_deliveries delivery
    set attempt_count = delivery.attempt_count + 1,
        available_at = clock_timestamp() + interval '2 minutes',
        claim_token = pending.next_claim_token,
        provider_state = 'request_started',
        provider_attempt_id = pending.next_claim_token,
        provider_outcome = null,
        provider_state_changed_at = clock_timestamp()
    from pending
    where delivery.id = pending.id
    returning delivery.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id,
    'claimToken', delivery.claim_token,
    'notificationId', notification.id,
    'employeeId', notification.recipient_employee_id,
    'createdAt', notification.created_at,
    'path', coalesce(notification.action_path, '/notifications'),
    'attempt', delivery.attempt_count,
    'subscription', jsonb_build_object(
      'endpoint', subscription.endpoint,
      'expirationTime', null,
      'keys', jsonb_build_object('p256dh', subscription.p256dh, 'auth', subscription.auth_key)
    ),
    'eligible', coalesce(
      subscription.enabled
      and subscription.employee_id = notification.recipient_employee_id
      and account.disabled_at is null
      and employee.status = 'active'
      and session.id is not null
      and (session.not_after is null or session.not_after > clock_timestamp())
      and (
        notification.source_type <> 'support_ticket'
        or exists (
          select 1
          from public.support_tickets ticket
          where ticket.id = notification.source_id
            and (
              ticket.submitted_by = employee.id
              or employee.role = 'admin'
              or (
                'support.tickets.view' = any(private.employee_effective_permissions(employee.id))
                and ticket.route_permission = any(private.employee_effective_permissions(employee.id))
              )
            )
        )
      ),
      false
    )
  )), '[]'::jsonb)
  into claimed
  from claimed_rows delivery
  join public.employee_notifications notification on notification.id = delivery.notification_id
  join private.employee_push_subscriptions subscription on subscription.id = delivery.subscription_id
  join public.employees employee on employee.id = notification.recipient_employee_id
  left join private.employee_accounts account on account.employee_id = employee.id
  left join auth.sessions session
    on session.id = subscription.auth_session_id
   and session.user_id = account.auth_user_id;

  return claimed;
end
$$;

-- Completion remains claim-token scoped and idempotent, but a provider state
-- that requires review is never exhausted into a synthetic terminal failure.
-- Only a definitely unsent pending attempt retains the bounded retry budget.
create or replace function public.service_complete_employee_push(
  target_id uuid,
  target_claim_token uuid,
  target_outcome text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  delivery private.employee_push_deliveries%rowtype;
  disabled_subscription_id uuid;
  effective_outcome text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_outcome is null
    or target_outcome not in ('delivered', 'expired', 'unavailable', 'failed', 'retry')
  then
    raise check_violation using message = 'Unsupported push completion outcome.';
  end if;

  select item.* into delivery
  from private.employee_push_deliveries item
  where item.id = target_id
  for update;
  if not found or delivery.claim_token is distinct from target_claim_token then
    raise insufficient_privilege using message = 'Push delivery claim was not found.';
  end if;
  if delivery.completed_at is not null then
    return;
  end if;

  if delivery.provider_state in ('request_started', 'uncertain') then
    -- The provider outcome is not safe to infer. Keep the durable fence for
    -- explicit review rather than accepting the caller's requested outcome.
    return;
  elsif delivery.provider_state = 'accepted' then
    if delivery.provider_outcome is distinct from 'delivered' or target_outcome <> 'delivered' then
      raise check_violation using message = 'Push completion conflicts with the accepted provider outcome.';
    end if;
    effective_outcome := 'delivered';
  elsif delivery.provider_state = 'resolved' then
    if delivery.provider_outcome is null then
      raise check_violation using message = 'Resolved push delivery is missing its provider outcome.';
    end if;
    if target_outcome <> delivery.provider_outcome then
      raise check_violation using message = 'Push completion conflicts with the resolved provider outcome.';
    end if;
    effective_outcome := delivery.provider_outcome;
  elsif delivery.provider_state = 'pending' and target_outcome = 'retry' and delivery.attempt_count < 5 then
    update private.employee_push_deliveries item
    set available_at = clock_timestamp() + make_interval(secs => least(300, 15 * (2 ^ item.attempt_count)::integer)),
        outcome = null,
        completed_at = null,
        provider_state = 'pending',
        provider_outcome = null,
        provider_attempt_id = null,
        claim_token = null,
        provider_state_changed_at = clock_timestamp()
    where item.id = delivery.id;
    return;
  elsif delivery.provider_state = 'pending' and target_outcome = 'retry' then
    effective_outcome := 'failed';
  else
    raise check_violation using message = 'Push completion does not match the persisted provider state.';
  end if;

  update private.employee_push_deliveries item
  set completed_at = clock_timestamp(),
      outcome = effective_outcome,
      provider_state = 'resolved',
      provider_outcome = effective_outcome,
      provider_state_changed_at = clock_timestamp()
  where item.id = delivery.id
  returning item.subscription_id into disabled_subscription_id;

  if effective_outcome = 'unavailable' and disabled_subscription_id is not null then
    update private.employee_push_subscriptions subscription
    set enabled = false
    where subscription.id = disabled_subscription_id;
  end if;
end
$$;

create or replace function public.service_mark_employee_push_provider_state(
  target_id uuid,
  target_claim_token uuid,
  target_provider_state text,
  target_provider_outcome text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  delivery private.employee_push_deliveries%rowtype;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_provider_state is null
    or target_provider_state not in ('pending', 'accepted', 'uncertain', 'resolved')
  then
    raise check_violation using message = 'Unsupported push provider state.';
  end if;
  if (
    target_provider_state in ('pending', 'uncertain')
    and target_provider_outcome is not null
  ) or (
    target_provider_state = 'accepted'
    and target_provider_outcome is distinct from 'delivered'
  ) or (
    target_provider_state = 'resolved'
    and (
      target_provider_outcome is null
      or target_provider_outcome not in ('delivered', 'expired', 'unavailable', 'failed')
    )
  ) then
    raise check_violation using message = 'Push provider state and outcome do not agree.';
  end if;

  select item.*
  into delivery
  from private.employee_push_deliveries item
  where item.id = target_id
  for update;
  if not found or delivery.claim_token is distinct from target_claim_token then
    raise insufficient_privilege using message = 'Push delivery claim was not found.';
  end if;

  if delivery.provider_attempt_id = target_claim_token
    and delivery.provider_state = 'request_started'
  then
    update private.employee_push_deliveries item
    set provider_state = target_provider_state,
        provider_outcome = target_provider_outcome,
        provider_state_changed_at = clock_timestamp()
    where item.id = delivery.id
    returning * into delivery;
  elsif delivery.provider_state is distinct from target_provider_state
    or delivery.provider_outcome is distinct from target_provider_outcome
  then
    raise check_violation using message = 'Push provider state is already terminal for this attempt.';
  end if;

  return jsonb_build_object(
    'id', delivery.id,
    'providerState', delivery.provider_state,
    'providerOutcome', delivery.provider_outcome,
    'completedAt', delivery.completed_at
  );
end
$$;

-- Finish rows whose provider result is already durable without contacting the
-- provider again.  request_started/uncertain rows remain fenced and are only
-- counted for review; this function never guesses that an ambiguous request
-- was unsent.
create or replace function public.service_reconcile_employee_push_provider_outcomes(
  target_limit integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  reconciled_count integer;
  disabled_count integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  with candidates as (
    select delivery.id
    from private.employee_push_deliveries delivery
    where delivery.completed_at is null
      and (
        (delivery.provider_state = 'accepted' and delivery.provider_outcome = 'delivered')
        or (
          delivery.provider_state = 'resolved'
          and delivery.provider_outcome in ('delivered', 'expired', 'unavailable', 'failed')
        )
      )
    order by delivery.provider_state_changed_at, delivery.id
    limit greatest(1, least(coalesce(target_limit, 100), 500))
    for update skip locked
  ), reconciled as (
    update private.employee_push_deliveries delivery
    set completed_at = clock_timestamp(),
        outcome = delivery.provider_outcome,
        provider_state = 'resolved',
        provider_state_changed_at = clock_timestamp()
    from candidates
    where delivery.id = candidates.id
    returning delivery.id, delivery.subscription_id, delivery.outcome
  ), disabled as (
    update private.employee_push_subscriptions subscription
    set enabled = false
    from reconciled
    where reconciled.subscription_id = subscription.id
      and reconciled.outcome = 'unavailable'
    returning subscription.id
  )
  select
    (select count(*) from reconciled),
    (select count(*) from disabled)
  into reconciled_count, disabled_count;

  select jsonb_build_object(
    'reconciled', reconciled_count,
    'disabledSubscriptions', disabled_count,
    'completionPending', (
      select count(*)
      from private.employee_push_deliveries delivery
      where delivery.completed_at is null
        and delivery.provider_state in ('accepted', 'resolved')
    ),
    'reviewRequired', (
      select count(*)
      from private.employee_push_deliveries delivery
      where delivery.completed_at is null
        and delivery.provider_state in ('request_started', 'uncertain')
        and delivery.provider_state_changed_at <= clock_timestamp() - interval '10 minutes'
    )
  )
  into result;

  return result;
end
$$;

create or replace function public.service_list_employee_push_provider_review(
  target_limit integer default 25
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id,
    'notificationId', delivery.notification_id,
    'subscriptionId', delivery.subscription_id,
    'providerState', delivery.provider_state,
    'providerOutcome', delivery.provider_outcome,
    'providerStateChangedAt', delivery.provider_state_changed_at,
    'attemptCount', delivery.attempt_count,
    'completedAt', delivery.completed_at,
    'outcome', delivery.outcome
  ) order by delivery.provider_state_changed_at, delivery.id), '[]'::jsonb)
  from (
    select item.*
    from private.employee_push_deliveries item
    where item.provider_state in ('request_started', 'accepted', 'uncertain', 'resolved')
      and item.completed_at is null
      and item.provider_state_changed_at <= clock_timestamp() - interval '10 minutes'
    order by item.provider_state_changed_at, item.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  ) delivery
  where coalesce((select auth.role()), '') = 'service_role'
$$;

-- This is intentionally service-only and never guesses. An operator may retry
-- only after provider evidence proves non-acceptance; otherwise resolve the row
-- as delivered or failed without issuing another provider request.
create or replace function public.service_resolve_employee_push_provider_review(
  target_id uuid,
  target_resolution text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  delivery private.employee_push_deliveries%rowtype;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_resolution is null
    or target_resolution not in ('delivered', 'failed', 'retry_verified_unsent')
  then
    raise check_violation using message = 'Unsupported push review resolution.';
  end if;

  select item.* into delivery
  from private.employee_push_deliveries item
  where item.id = target_id
  for update;
  if not found or delivery.provider_state not in ('request_started', 'accepted', 'uncertain') then
    raise check_violation using message = 'Push delivery does not require provider review.';
  end if;
  if delivery.provider_state = 'accepted' and target_resolution <> 'delivered' then
    raise check_violation using message = 'An accepted push can only be resolved as delivered.';
  end if;

  if target_resolution = 'retry_verified_unsent' then
    update private.employee_push_deliveries item
    set provider_state = 'pending',
        provider_outcome = null,
        provider_attempt_id = null,
        provider_state_changed_at = clock_timestamp(),
        attempt_count = 0,
        claim_token = null,
        completed_at = null,
        outcome = null,
        available_at = clock_timestamp()
    where item.id = delivery.id
    returning * into delivery;
  else
    update private.employee_push_deliveries item
    set provider_state = 'resolved',
        provider_outcome = target_resolution,
        provider_state_changed_at = clock_timestamp(),
        completed_at = coalesce(item.completed_at, clock_timestamp()),
        outcome = target_resolution
    where item.id = delivery.id
    returning * into delivery;
  end if;

  return jsonb_build_object(
    'id', delivery.id,
    'providerState', delivery.provider_state,
    'outcome', delivery.outcome,
    'completedAt', delivery.completed_at
  );
end
$$;

revoke all on function public.service_claim_employee_push(integer)
  from public, anon, authenticated;
revoke all on function public.service_complete_employee_push(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_mark_employee_push_provider_state(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_reconcile_employee_push_provider_outcomes(integer)
  from public, anon, authenticated;
revoke all on function public.service_list_employee_push_provider_review(integer)
  from public, anon, authenticated;
revoke all on function public.service_resolve_employee_push_provider_review(uuid, text)
  from public, anon, authenticated;

grant execute on function public.service_claim_employee_push(integer)
  to service_role;
grant execute on function public.service_complete_employee_push(uuid, uuid, text)
  to service_role;
grant execute on function public.service_mark_employee_push_provider_state(uuid, uuid, text, text)
  to service_role;
grant execute on function public.service_reconcile_employee_push_provider_outcomes(integer)
  to service_role;
grant execute on function public.service_list_employee_push_provider_review(integer)
  to service_role;
grant execute on function public.service_resolve_employee_push_provider_review(uuid, text)
  to service_role;

commit;

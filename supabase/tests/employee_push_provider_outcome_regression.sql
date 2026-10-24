-- Rollback-only regression for the durable push-provider state machine.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $push_provider_outcome$
declare
  actor_id uuid;
  target_subscription_id uuid := gen_random_uuid();
  accepted_notification_id uuid;
  uncertain_notification_id uuid;
  resolved_notification_id uuid;
  accepted_delivery_id uuid;
  uncertain_delivery_id uuid;
  resolved_delivery_id uuid;
  accepted_claim uuid := gen_random_uuid();
  uncertain_claim uuid := gen_random_uuid();
  resolved_claim uuid := gen_random_uuid();
  result jsonb;
begin
  assert private.classify_legacy_push_provider_state(null, null) = 'pending',
    'An unclaimed legacy row remains safely pending.';
  assert private.classify_legacy_push_provider_state(null, gen_random_uuid()) = 'uncertain',
    'A claimed legacy row is quarantined because provider acceptance is unknown.';
  assert private.classify_legacy_push_provider_state(clock_timestamp(), gen_random_uuid()) = 'resolved',
    'A completed legacy row remains terminal.';

  select employee.id
  into actor_id
  from public.employees employee
  where employee.status = 'active'
  order by employee.created_at, employee.id
  limit 1;
  assert actor_id is not null, 'An active employee is required for this regression.';

  insert into private.employee_push_subscriptions(
    id,
    employee_id,
    auth_session_id,
    endpoint,
    p256dh,
    auth_key
  ) values (
    target_subscription_id,
    actor_id,
    gen_random_uuid(),
    'https://fcm.googleapis.com/fcm/send/provider-regression-' || target_subscription_id::text,
    repeat('A', 87),
    repeat('B', 22)
  );

  perform set_config('sygshift.push_kicked', 'yes', true);
  accepted_notification_id := private.create_employee_notification(
    actor_id, 'direct', null, 'push-accepted:' || gen_random_uuid()::text,
    'Accepted push regression', 'Rollback-only provider acceptance fixture.'
  );
  uncertain_notification_id := private.create_employee_notification(
    actor_id, 'direct', null, 'push-uncertain:' || gen_random_uuid()::text,
    'Uncertain push regression', 'Rollback-only ambiguous provider fixture.'
  );
  resolved_notification_id := private.create_employee_notification(
    actor_id, 'direct', null, 'push-resolved:' || gen_random_uuid()::text,
    'Resolved push regression', 'Rollback-only terminal provider fixture.'
  );

  select delivery.id into accepted_delivery_id
  from private.employee_push_deliveries delivery
  where delivery.notification_id = accepted_notification_id
    and delivery.subscription_id = target_subscription_id;
  select delivery.id into uncertain_delivery_id
  from private.employee_push_deliveries delivery
  where delivery.notification_id = uncertain_notification_id
    and delivery.subscription_id = target_subscription_id;
  select delivery.id into resolved_delivery_id
  from private.employee_push_deliveries delivery
  where delivery.notification_id = resolved_notification_id
    and delivery.subscription_id = target_subscription_id;

  assert accepted_delivery_id is not null
    and uncertain_delivery_id is not null
    and resolved_delivery_id is not null,
    'Each notification creates one delivery for the fixture subscription.';

  update private.employee_push_deliveries delivery
  set attempt_count = 1,
      claim_token = case delivery.id
        when accepted_delivery_id then accepted_claim
        when uncertain_delivery_id then uncertain_claim
        else resolved_claim
      end,
      provider_state = 'request_started',
      provider_attempt_id = case delivery.id
        when accepted_delivery_id then accepted_claim
        when uncertain_delivery_id then uncertain_claim
        else resolved_claim
      end,
      provider_state_changed_at = clock_timestamp()
  where delivery.id in (accepted_delivery_id, uncertain_delivery_id, resolved_delivery_id);

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.service_mark_employee_push_provider_state(
    accepted_delivery_id, accepted_claim, 'accepted', 'delivered'
  );
  perform public.service_mark_employee_push_provider_state(
    uncertain_delivery_id, uncertain_claim, 'uncertain', null
  );
  perform public.service_mark_employee_push_provider_state(
    resolved_delivery_id, resolved_claim, 'resolved', 'unavailable'
  );
  update private.employee_push_deliveries delivery
  set provider_state_changed_at = timestamptz '2000-01-01 00:00:00+00'
  where delivery.id in (accepted_delivery_id, uncertain_delivery_id, resolved_delivery_id);

  -- Simulate a lost completion response: provider state is durable, but the
  -- ordinary completion RPC never reached the caller.
  result := public.service_reconcile_employee_push_provider_outcomes(500);
  assert (result ->> 'reconciled')::integer >= 2,
    'Accepted and terminal provider outcomes are completed without a resend.';
  assert exists (
    select 1 from private.employee_push_deliveries delivery
    where delivery.id = accepted_delivery_id
      and delivery.completed_at is not null
      and delivery.provider_state = 'resolved'
      and delivery.provider_outcome = 'delivered'
      and delivery.outcome = 'delivered'
  ), 'An accepted push becomes terminal delivered during reconciliation.';
  assert exists (
    select 1 from private.employee_push_deliveries delivery
    where delivery.id = resolved_delivery_id
      and delivery.completed_at is not null
      and delivery.provider_state = 'resolved'
      and delivery.provider_outcome = 'unavailable'
      and delivery.outcome = 'unavailable'
  ), 'A resolved incomplete push becomes terminal without provider contact.';
  assert exists (
    select 1 from private.employee_push_deliveries delivery
    where delivery.id = uncertain_delivery_id
      and delivery.completed_at is null
      and delivery.provider_state = 'uncertain'
  ), 'An uncertain provider outcome remains fenced from automatic resend.';

  perform public.service_resolve_employee_push_provider_review(
    uncertain_delivery_id,
    'retry_verified_unsent'
  );
  assert exists (
    select 1 from private.employee_push_deliveries delivery
    where delivery.id = uncertain_delivery_id
      and delivery.completed_at is null
      and delivery.provider_state = 'pending'
      and delivery.provider_outcome is null
      and delivery.claim_token is null
      and delivery.attempt_count = 0
  ), 'Only explicit verified-unsent review returns an uncertain push to pending.';
end
$push_provider_outcome$;

rollback;

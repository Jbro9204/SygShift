begin;

do $$
declare
  generic_id uuid := gen_random_uuid();
  unrelated_id uuid := gen_random_uuid();
  claimed jsonb;
begin
  insert into private.notification_outbox (
    id, message_type, aggregate_type, aggregate_id, payload, idempotency_key,
    available_at, created_at
  ) values (
    unrelated_id, 'automatic_clock_out_employee', 'regression_probe', gen_random_uuid(),
    '{}'::jsonb, 'notification-owner-unrelated:' || unrelated_id::text,
    '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'
  ), (
    generic_id, 'schedule_published', 'regression_probe', gen_random_uuid(),
    '{}'::jsonb, 'notification-owner-generic:' || generic_id::text,
    '2000-01-02 00:00:00+00', '2000-01-02 00:00:00+00'
  );

  perform set_config('request.jwt.claim.role', 'service_role', true);
  claimed := public.service_claim_notification_batch(1);

  if jsonb_array_length(claimed) <> 1
     or claimed -> 0 ->> 'id' <> generic_id::text then
    raise exception 'The generic claimant did not select exactly its owned queue row.';
  end if;

  if (select attempt_count from private.notification_outbox where id = unrelated_id) <> 0
     or (select attempted_at from private.notification_outbox where id = unrelated_id) is not null then
    raise exception 'The generic claimant stole an automatic-clock-out queue row.';
  end if;

  if (select attempt_count from private.notification_outbox where id = generic_id) <> 1
     or (select attempted_at from private.notification_outbox where id = generic_id) is null then
    raise exception 'The generic claimant did not lease its owned queue row.';
  end if;
end
$$;

rollback;

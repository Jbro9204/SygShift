-- Rollback-only regression for protected-storage cleanup claim/result durability.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $protected_storage_cleanup_claim_receipts_regression$
declare
  lost_claim_id uuid := gen_random_uuid();
  deferred_id uuid := gen_random_uuid();
  saturated_id uuid := gen_random_uuid();
  completed_id uuid := gen_random_uuid();
  claimed jsonb;
  owner text;
  index integer;
  rejected boolean;
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  insert into private.protected_storage_cleanup_jobs (
    id, cleanup_kind, storage_bucket, object_key, source_operation_id,
    status, attempt_count, available_at
  ) values (
    lost_claim_id, 'profile_photo', 'employee-photos',
    '_claim-receipt-regression/' || lost_claim_id::text || '.jpg',
    gen_random_uuid(), 'pending', 0, timestamptz '2000-01-01 00:00:00+00'
  );

  -- More than twenty committed-but-unobserved claim responses may expire and
  -- be reclaimed without consuming one real storage-cleanup failure.
  for index in 1..21 loop
    owner := 'lost-claim-response-' || index::text;
    claimed := public.service_list_protected_storage_cleanup_v2(100, owner);
    assert exists (
      select 1
      from jsonb_array_elements(claimed) item
      where item ->> 'id' = lost_claim_id::text
        and item ->> 'leaseOwner' = owner
        and (item ->> 'attemptCount')::integer = 1
    ), 'A reclaimed claim returns the truthful projected first-attempt ordinal.';
    assert (
      select cleanup.attempt_count = 0
      from private.protected_storage_cleanup_jobs cleanup
      where cleanup.id = lost_claim_id
    ), 'A claim response loss never consumes a cleanup attempt.';

    if index < 21 then
      update private.protected_storage_cleanup_jobs cleanup
      set leased_at = clock_timestamp() - interval '11 minutes'
      where cleanup.id = lost_claim_id;
    end if;
  end loop;

  assert (
    select cleanup.status = 'processing'
      and cleanup.attempt_count = 0
      and cleanup.quarantined_at is null
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = lost_claim_id
  ), 'Twenty-one lost claim responses remain reclaimable and do not quarantine.';

  rejected := false;
  begin
    perform public.service_defer_protected_storage_cleanup_v2(
      lost_claim_id,
      'lost-claim-response-1',
      'A stale owner must not consume the current lease.'
    );
  exception when check_violation then
    rejected := true;
  end;
  assert rejected, 'A stale owner result fails closed while a newer lease is active.';

  insert into private.protected_storage_cleanup_jobs (
    id, cleanup_kind, storage_bucket, object_key, source_operation_id,
    status, attempt_count, available_at
  ) values (
    deferred_id, 'profile_photo', 'employee-photos',
    '_claim-receipt-regression/' || deferred_id::text || '.jpg',
    gen_random_uuid(), 'pending', 0, timestamptz '2000-01-01 00:00:00+00'
  );

  claimed := public.service_list_protected_storage_cleanup_v2(100, 'defer-response-loss');
  assert exists (
    select 1 from jsonb_array_elements(claimed) item
    where item ->> 'id' = deferred_id::text
  ), 'The defer replay fixture receives its lease.';

  perform public.service_defer_protected_storage_cleanup_v2(
    deferred_id,
    'defer-response-loss',
    'Object verification failed.'
  );
  -- Simulate loss of the committed RPC response by sending the exact result again.
  perform public.service_defer_protected_storage_cleanup_v2(
    deferred_id,
    'defer-response-loss',
    'Object verification failed.'
  );
  assert (
    select cleanup.status = 'pending'
      and cleanup.attempt_count = 1
      and cleanup.last_result_lease_owner = 'defer-response-loss'
      and cleanup.last_result_outcome = 'deferred'
      and cleanup.last_result_at is not null
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = deferred_id
  ), 'An exact deferred-result replay records one and only one real failure.';

  rejected := false;
  begin
    perform public.service_complete_protected_storage_cleanup_v2(
      deferred_id,
      'defer-response-loss'
    );
  exception when check_violation then
    rejected := true;
  end;
  assert rejected, 'A conflicting result for a recorded defer fails closed.';

  update private.protected_storage_cleanup_jobs cleanup
  set available_at = timestamptz '2000-01-01 00:00:00+00'
  where cleanup.id = deferred_id;
  claimed := public.service_list_protected_storage_cleanup_v2(100, 'newer-defer-lease');
  assert exists (
    select 1 from jsonb_array_elements(claimed) item
    where item ->> 'id' = deferred_id::text
      and (item ->> 'attemptCount')::integer = 2
  ), 'A later lease projects the next real failure ordinal.';
  assert (
    select cleanup.last_result_lease_owner is null
      and cleanup.last_result_outcome is null
      and cleanup.last_result_at is null
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = deferred_id
  ), 'A newer lease invalidates the preceding result receipt.';

  rejected := false;
  begin
    perform public.service_defer_protected_storage_cleanup_v2(
      deferred_id,
      'defer-response-loss',
      'The superseded lease must stay rejected.'
    );
  exception when check_violation then
    rejected := true;
  end;
  assert rejected, 'An exact result from a superseded lease fails closed.';

  insert into private.protected_storage_cleanup_jobs (
    id, cleanup_kind, storage_bucket, object_key, source_operation_id,
    status, attempt_count, available_at
  ) values (
    saturated_id, 'profile_photo', 'employee-photos',
    '_claim-receipt-regression/' || saturated_id::text || '.jpg',
    gen_random_uuid(), 'pending', 0, timestamptz '2000-01-01 00:00:00+00'
  );

  for index in 1..20 loop
    owner := 'real-failure-' || index::text;
    claimed := public.service_list_protected_storage_cleanup_v2(100, owner);
    assert exists (
      select 1 from jsonb_array_elements(claimed) item
      where item ->> 'id' = saturated_id::text
        and (item ->> 'attemptCount')::integer = index
    ), 'Each claim exposes the next real failure ordinal without persisting it.';

    perform public.service_defer_protected_storage_cleanup_v2(
      saturated_id,
      owner,
      'Confirmed storage failure ' || index::text
    );
    perform public.service_defer_protected_storage_cleanup_v2(
      saturated_id,
      owner,
      'Confirmed storage failure ' || index::text
    );

    assert (
      select cleanup.attempt_count = index
      from private.protected_storage_cleanup_jobs cleanup
      where cleanup.id = saturated_id
    ), 'A real failure and its exact replay increment the counter exactly once.';

    if index < 20 then
      update private.protected_storage_cleanup_jobs cleanup
      set available_at = timestamptz '2000-01-01 00:00:00+00'
      where cleanup.id = saturated_id;
    end if;
  end loop;

  assert (
    select cleanup.status = 'quarantined'
      and cleanup.attempt_count = 20
      and cleanup.quarantined_at is not null
      and cleanup.lease_owner is null
      and cleanup.leased_at is null
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = saturated_id
  ), 'Twenty real failures, not claims, saturate the quarantine limit.';
  claimed := public.service_list_protected_storage_cleanup_v2(100, 'post-saturation');
  assert not exists (
    select 1 from jsonb_array_elements(claimed) item
    where item ->> 'id' = saturated_id::text
  ), 'A job at twenty real failures is never leased again.';

  insert into private.protected_storage_cleanup_jobs (
    id, cleanup_kind, storage_bucket, object_key, source_operation_id,
    status, attempt_count, available_at
  ) values (
    completed_id, 'profile_photo', 'employee-photos',
    '_claim-receipt-regression/' || completed_id::text || '.jpg',
    gen_random_uuid(), 'pending', 0, timestamptz '2000-01-01 00:00:00+00'
  );

  claimed := public.service_list_protected_storage_cleanup_v2(100, 'complete-response-loss');
  assert exists (
    select 1 from jsonb_array_elements(claimed) item
    where item ->> 'id' = completed_id::text
  ), 'The completion replay fixture receives its lease.';
  perform public.service_complete_protected_storage_cleanup_v2(
    completed_id,
    'complete-response-loss'
  );
  -- Simulate a committed completion whose response never reached the Worker.
  perform public.service_complete_protected_storage_cleanup_v2(
    completed_id,
    'complete-response-loss'
  );
  assert (
    select cleanup.status = 'completed'
      and cleanup.attempt_count = 0
      and cleanup.completed_at is not null
      and cleanup.last_result_lease_owner = 'complete-response-loss'
      and cleanup.last_result_outcome = 'completed'
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = completed_id
  ), 'An exact completion replay is idempotent after response loss.';

  rejected := false;
  begin
    perform public.service_complete_protected_storage_cleanup_v2(
      completed_id,
      'stale-completion-owner'
    );
  exception when check_violation then
    rejected := true;
  end;
  assert rejected, 'A different owner cannot replay a completed result.';

  rejected := false;
  begin
    perform public.service_defer_protected_storage_cleanup_v2(
      completed_id,
      'complete-response-loss',
      'Conflicting defer after completion.'
    );
  exception when check_violation then
    rejected := true;
  end;
  assert rejected, 'A conflicting defer after completion fails closed.';

  assert not exists (
    select 1
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id in (lost_claim_id, deferred_id, saturated_id)
      and cleanup.status = 'completed'
  ), 'Claims, defers, and quarantine never falsely assert protected-object deletion.';
end
$protected_storage_cleanup_claim_receipts_regression$;

rollback;

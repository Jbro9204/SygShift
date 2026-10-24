-- Rollback-only regression for cleanup retry saturation and poison-row isolation.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $protected_storage_cleanup_retry_saturation_regression$
declare
  processing_id uuid := gen_random_uuid();
  pending_id uuid := gen_random_uuid();
  claimed jsonb;
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  insert into private.protected_storage_cleanup_jobs (
    id, cleanup_kind, storage_bucket, object_key, source_operation_id,
    status, attempt_count, available_at, leased_at, lease_owner
  ) values (
    processing_id, 'profile_photo', 'hr-general',
    '_retry-regression/' || processing_id::text || '/processing.bin',
    gen_random_uuid(), 'processing', 2147483640, clock_timestamp(),
    clock_timestamp(), 'retry-saturation-regression'
  );

  perform public.service_defer_protected_storage_cleanup_v2(
    processing_id,
    'retry-saturation-regression',
    'Permanent storage verification failure.'
  );

  assert (
    select cleanup.status = 'quarantined'
      and cleanup.quarantined_at is not null
      and cleanup.lease_owner is null
      and cleanup.leased_at is null
      and cleanup.attempt_count = 2147483640
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = processing_id
  ), 'A very high attempt count quarantines without overflowing or claiming deletion.';

  insert into private.protected_storage_cleanup_jobs (
    id, cleanup_kind, storage_bucket, object_key, source_operation_id,
    status, attempt_count, available_at
  ) values (
    pending_id, 'profile_photo', 'hr-general',
    '_retry-regression/' || pending_id::text || '/pending.bin',
    gen_random_uuid(), 'pending', 20, clock_timestamp() - interval '1 minute'
  );

  claimed := public.service_list_protected_storage_cleanup_v2(25, 'retry-saturation-list');

  assert not exists (
    select 1
    from jsonb_array_elements(claimed) item
    where item ->> 'id' = pending_id::text
  ), 'A retry-exhausted pending job is never leased again.';
  assert (
    select cleanup.status = 'quarantined'
      and cleanup.quarantined_at is not null
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id = pending_id
  ), 'A retry-exhausted pending job is quarantined for review.';
  assert not exists (
    select 1
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.id in (processing_id, pending_id)
      and cleanup.status = 'completed'
  ), 'Retry quarantine never falsely records protected-object deletion.';
end
$protected_storage_cleanup_retry_saturation_regression$;

rollback;

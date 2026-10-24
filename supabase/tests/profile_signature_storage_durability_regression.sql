-- Rollback-only regression for protected profile/signature storage identity,
-- stale compare-and-set behavior, and service-only cleanup authority.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $protected_storage_durability_regression$
declare
  employee_id uuid;
  original_path text;
  first_a_prepare jsonb;
  first_a_retry jsonb;
  first_a_complete jsonb;
  b_prepare jsonb;
  b_complete jsonb;
  second_a_prepare jsonb;
  second_a_complete jsonb;
  stale_prepare jsonb;
  winner_prepare jsonb;
  winner_complete jsonb;
  stale_complete jsonb;
  stale_remove jsonb;
  exact_remove jsonb;
  retry_remove jsonb;
  checksum_a text := repeat('a', 64);
  checksum_b text := repeat('b', 64);
  checksum_stale text := repeat('c', 64);
  checksum_winner text := repeat('d', 64);
begin
  select employee.id, employee.photo_path
  into employee_id, original_path
  from public.employees employee
  order by employee.created_at, employee.id
  limit 1;

  assert employee_id is not null,
    'An employee fixture is required for the protected-storage regression.';

  assert not has_function_privilege(
    'anon',
    'public.service_prepare_employee_photo_upload_v2(uuid,text,text,text,bigint,text,text)',
    'execute'
  ), 'Anonymous callers cannot prepare protected profile uploads.';
  assert not has_function_privilege(
    'authenticated',
    'public.service_remove_employee_photo_v2(uuid,text,text)',
    'execute'
  ), 'Browser sessions cannot clear protected profile references.';
  assert has_function_privilege(
    'service_role',
    'public.service_prepare_employee_photo_upload_v2(uuid,text,text,text,bigint,text,text)',
    'execute'
  ), 'Only the service path receives profile prepare authority.';
  assert not has_function_privilege(
    'service_role',
    'public.service_prepare_employee_photo_upload(uuid,text,text,text,text)',
    'execute'
  ), 'The unsafe content-path-only profile API remains disabled.';
  assert not has_table_privilege('authenticated', 'private.protected_storage_cleanup_jobs', 'select'),
    'Browser sessions cannot inspect protected cleanup identities.';
  assert not has_function_privilege(
    'authenticated',
    'public.service_record_signature_action_v2(uuid,uuid,text,jsonb,text,timestamptz,text,text,text,text,text,text,boolean,text,text,timestamptz,text,uuid,text)',
    'execute'
  ), 'Browser sessions cannot bypass the Worker signature-appearance fence.';
  assert not has_function_privilege(
    'anon',
    'public.service_list_protected_storage_cleanup_v2(integer,text)',
    'execute'
  ), 'Anonymous callers cannot claim private-object cleanup jobs.';
  assert has_function_privilege(
    'service_role',
    'public.service_list_protected_storage_cleanup_v2(integer,text)',
    'execute'
  ), 'The protected cleanup worker retains its narrow service authority.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  first_a_prepare := public.service_prepare_employee_photo_upload_v2(
    employee_id, original_path, checksum_a, 'jpg', 512, 'image/jpeg', 'regression-a-first'
  );
  first_a_retry := public.service_prepare_employee_photo_upload_v2(
    employee_id, original_path, checksum_a, 'jpg', 512, 'image/jpeg', 'regression-a-retry'
  );
  assert first_a_retry ->> 'operationId' = first_a_prepare ->> 'operationId',
    'A process retry before completion must rediscover one prepared operation.';
  assert first_a_retry ->> 'photoPath' = first_a_prepare ->> 'photoPath',
    'A process retry must reuse the exact prepared object key.';

  first_a_complete := public.service_complete_employee_photo_upload_v2(
    (first_a_prepare ->> 'operationId')::uuid,
    employee_id,
    first_a_prepare ->> 'photoPath',
    checksum_a,
    'regression-a-complete'
  );
  assert first_a_complete ->> 'state' = 'completed',
    'The first A profile operation completes.';

  b_prepare := public.service_prepare_employee_photo_upload_v2(
    employee_id, first_a_prepare ->> 'photoPath', checksum_b, 'png', 640, 'image/png', 'regression-b'
  );
  b_complete := public.service_complete_employee_photo_upload_v2(
    (b_prepare ->> 'operationId')::uuid,
    employee_id,
    b_prepare ->> 'photoPath',
    checksum_b,
    'regression-b-complete'
  );
  assert b_complete ->> 'state' = 'completed',
    'The B profile operation completes.';

  second_a_prepare := public.service_prepare_employee_photo_upload_v2(
    employee_id, b_prepare ->> 'photoPath', checksum_a, 'jpg', 512, 'image/jpeg', 'regression-a-second'
  );
  assert second_a_prepare ->> 'operationId' <> first_a_prepare ->> 'operationId',
    'A valid A to B to A sequence receives a new operation identity.';
  assert second_a_prepare ->> 'photoPath' <> first_a_prepare ->> 'photoPath',
    'A valid A to B to A sequence never reactivates an object queued for cleanup.';
  second_a_complete := public.service_complete_employee_photo_upload_v2(
    (second_a_prepare ->> 'operationId')::uuid,
    employee_id,
    second_a_prepare ->> 'photoPath',
    checksum_a,
    'regression-a-second-complete'
  );
  assert second_a_complete ->> 'state' = 'completed',
    'The second A profile operation completes normally.';

  stale_prepare := public.service_prepare_employee_photo_upload_v2(
    employee_id, second_a_prepare ->> 'photoPath', checksum_stale, 'jpg', 700, 'image/jpeg', 'regression-stale'
  );
  winner_prepare := public.service_prepare_employee_photo_upload_v2(
    employee_id, second_a_prepare ->> 'photoPath', checksum_winner, 'png', 720, 'image/png', 'regression-winner'
  );
  winner_complete := public.service_complete_employee_photo_upload_v2(
    (winner_prepare ->> 'operationId')::uuid,
    employee_id,
    winner_prepare ->> 'photoPath',
    checksum_winner,
    'regression-winner-complete'
  );
  stale_complete := public.service_complete_employee_photo_upload_v2(
    (stale_prepare ->> 'operationId')::uuid,
    employee_id,
    stale_prepare ->> 'photoPath',
    checksum_stale,
    'regression-stale-complete'
  );
  assert winner_complete ->> 'state' = 'completed'
    and stale_complete ->> 'state' = 'conflict',
    'A serialized stale completion cannot overwrite the newer winner.';
  assert (
    select employee.photo_path
    from public.employees employee
    where employee.id = employee_id
  ) = winner_prepare ->> 'photoPath',
    'The winning photo remains authoritative after the stale retry.';
  assert exists (
    select 1
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.cleanup_kind = 'profile_photo'
      and cleanup.source_operation_id = (stale_prepare ->> 'operationId')::uuid
      and cleanup.object_key = stale_prepare ->> 'photoPath'
      and cleanup.status = 'pending'
  ), 'The exact stale candidate is durably queued for cleanup.';
  assert not exists (
    select 1
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.cleanup_kind = 'profile_photo'
      and cleanup.object_key = winner_prepare ->> 'photoPath'
      and cleanup.status in ('pending', 'processing')
  ), 'The authoritative winner is never queued for destructive cleanup.';

  stale_remove := public.service_remove_employee_photo_v2(
    employee_id,
    second_a_prepare ->> 'photoPath',
    'regression-stale-remove'
  );
  assert stale_remove ->> 'state' = 'conflict',
    'A stale DELETE cannot clear a photo installed by a concurrent PUT.';
  assert (
    select employee.photo_path
    from public.employees employee
    where employee.id = employee_id
  ) = winner_prepare ->> 'photoPath',
    'A stale DELETE preserves the newer authoritative photo.';

  exact_remove := public.service_remove_employee_photo_v2(
    employee_id,
    winner_prepare ->> 'photoPath',
    'regression-exact-remove'
  );
  retry_remove := public.service_remove_employee_photo_v2(
    employee_id,
    winner_prepare ->> 'photoPath',
    'regression-exact-remove-retry'
  );
  assert exact_remove ->> 'state' = 'removed'
    and retry_remove ->> 'state' = 'removed',
    'An exact DELETE and its lost-response retry are idempotent.';
  assert (retry_remove ->> 'idempotent')::boolean,
    'The serialized retry reports an already removed photo.';
  assert (
    select employee.photo_path is null
    from public.employees employee
    where employee.id = employee_id
  ), 'The exact DELETE clears only its locked authoritative reference.';
  assert exists (
    select 1
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.cleanup_kind = 'profile_photo'
      and cleanup.object_key = winner_prepare ->> 'photoPath'
      and cleanup.status = 'pending'
  ), 'Removal persists cleanup before the former object can be deleted.';

  -- This regression never runs the external storage worker. Database retries
  -- therefore prove that no ambiguous path destructively completes cleanup.
  assert not exists (
    select 1
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.status = 'completed'
      and (
        cleanup.id = (exact_remove ->> 'cleanupJobId')::uuid
        or cleanup.source_operation_id in (
          (first_a_prepare ->> 'operationId')::uuid,
          (b_prepare ->> 'operationId')::uuid,
          (second_a_prepare ->> 'operationId')::uuid,
          (stale_prepare ->> 'operationId')::uuid,
          (winner_prepare ->> 'operationId')::uuid
        )
      )
  ), 'Database-only reconciliation never claims external deletion succeeded.';
end
$protected_storage_durability_regression$;

rollback;

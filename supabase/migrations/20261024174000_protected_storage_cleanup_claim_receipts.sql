begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Cleanup claims are leases, not storage-delete attempts. A Worker can lose a
-- committed claim response or stop before touching storage; neither event may
-- consume the retry budget or quarantine an object. Result receipts make the
-- exact defer/complete retry safe after an unobserved database commit.
alter table private.protected_storage_cleanup_jobs
  add column if not exists last_result_lease_owner text,
  add column if not exists last_result_outcome text,
  add column if not exists last_result_at timestamptz;

alter table private.protected_storage_cleanup_jobs
  drop constraint if exists protected_storage_cleanup_jobs_last_result_check;
alter table private.protected_storage_cleanup_jobs
  add constraint protected_storage_cleanup_jobs_last_result_check
  check (
    (last_result_lease_owner is null and last_result_outcome is null and last_result_at is null)
    or (
      last_result_lease_owner is not null
      and last_result_outcome in ('deferred', 'completed')
      and last_result_at is not null
    )
  );

create or replace function public.service_list_protected_storage_cleanup_v2(
  target_limit integer default 25,
  target_lease_owner text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_owner text := nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '');
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if normalized_owner is null then
    raise check_violation using message = 'A cleanup lease owner is required.';
  end if;

  -- Reclaiming an abandoned claim does not assert that storage was contacted.
  update private.protected_storage_cleanup_jobs cleanup
  set status = case when cleanup.attempt_count >= 20 then 'quarantined' else 'pending' end,
      quarantined_at = case
        when cleanup.attempt_count >= 20 then coalesce(cleanup.quarantined_at, clock_timestamp())
        else cleanup.quarantined_at
      end,
      lease_owner = null,
      leased_at = null,
      last_error = case
        when cleanup.attempt_count >= 20 then coalesce(cleanup.last_error, 'Protected storage cleanup exceeded the automatic retry limit.')
        else cleanup.last_error
      end,
      updated_at = clock_timestamp()
  where cleanup.status = 'processing'
    and cleanup.leased_at <= clock_timestamp() - interval '10 minutes';

  -- An object that became authoritative is never deleted, including after a
  -- prior cleanup result or quarantine.
  update private.protected_storage_cleanup_jobs cleanup
  set status = 'cancelled',
      completed_at = clock_timestamp(),
      quarantined_at = null,
      lease_owner = null,
      leased_at = null,
      updated_at = clock_timestamp()
  where cleanup.status in ('pending', 'processing', 'quarantined')
    and (
      (cleanup.cleanup_kind = 'profile_photo' and exists (
        select 1 from public.employees employee
        where employee.id = cleanup.employee_id and employee.photo_path = cleanup.object_key
      ))
      or (cleanup.cleanup_kind = 'signature_appearance' and exists (
        select 1 from private.signature_events event
        where event.recipient_id = cleanup.recipient_id
          and event.appearance_bucket = cleanup.storage_bucket
          and event.appearance_object_key = cleanup.object_key
          and event.appearance_checksum = cleanup.sha256_checksum
      ))
      or (cleanup.cleanup_kind = 'signature_final_pdf' and exists (
        select 1 from private.hr_document_versions version
        where version.storage_bucket = cleanup.storage_bucket
          and version.object_key = cleanup.object_key
          and version.sha256_checksum = cleanup.sha256_checksum
      ))
      or (cleanup.cleanup_kind = 'signature_certificate' and exists (
        select 1 from private.signature_audit_certificates certificate
        where certificate.storage_bucket = cleanup.storage_bucket
          and certificate.object_key = cleanup.object_key
          and certificate.checksum = cleanup.sha256_checksum
      ))
    );

  update private.protected_storage_cleanup_jobs cleanup
  set status = 'quarantined',
      quarantined_at = coalesce(cleanup.quarantined_at, clock_timestamp()),
      lease_owner = null,
      leased_at = null,
      last_error = coalesce(cleanup.last_error, 'Protected storage cleanup exceeded the automatic retry limit.'),
      updated_at = clock_timestamp()
  where cleanup.status = 'pending'
    and cleanup.attempt_count >= 20;

  with candidates as (
    select cleanup.id
    from private.protected_storage_cleanup_jobs cleanup
    where cleanup.status = 'pending'
      and cleanup.attempt_count < 20
      and cleanup.available_at <= clock_timestamp()
    order by cleanup.available_at, cleanup.created_at, cleanup.id
    limit greatest(1, least(coalesce(target_limit, 25), 100))
    for update skip locked
  ), updated as (
    update private.protected_storage_cleanup_jobs cleanup
    set status = 'processing',
        lease_owner = normalized_owner,
        leased_at = clock_timestamp(),
        -- A newer lease invalidates the preceding result receipt. This keeps a
        -- delayed result from an older owner from looking like a current replay.
        last_result_lease_owner = null,
        last_result_outcome = null,
        last_result_at = null,
        updated_at = clock_timestamp()
    from candidates
    where cleanup.id = candidates.id
    returning cleanup.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', updated.id,
    'kind', updated.cleanup_kind,
    'bucket', updated.storage_bucket,
    'objectKey', updated.object_key,
    'sizeBytes', updated.byte_size,
    'checksum', updated.sha256_checksum,
    'leaseOwner', updated.lease_owner,
    -- This is the next real attempt ordinal for display/validation only. The
    -- persisted count advances only if service_defer records a real failure.
    'attemptCount', least(2147483647::bigint, updated.attempt_count::bigint + 1)::integer
  ) order by updated.available_at, updated.created_at, updated.id), '[]'::jsonb)
  into claimed
  from updated;

  return claimed;
end
$$;

create or replace function public.service_defer_protected_storage_cleanup_v2(
  target_cleanup_id uuid,
  target_lease_owner text,
  target_error text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleanup_record private.protected_storage_cleanup_jobs%rowtype;
  normalized_owner text := nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '');
  next_attempt integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if normalized_owner is null then
    raise check_violation using message = 'A cleanup lease owner is required.';
  end if;

  select cleanup.* into cleanup_record
  from private.protected_storage_cleanup_jobs cleanup
  where cleanup.id = target_cleanup_id
  for update;
  if not found then
    raise check_violation using message = 'The protected-storage cleanup job was not found.';
  end if;

  if cleanup_record.last_result_lease_owner = normalized_owner then
    if cleanup_record.last_result_outcome = 'deferred'
      and cleanup_record.status in ('pending', 'quarantined')
      and cleanup_record.lease_owner is null
      and cleanup_record.leased_at is null
    then
      return;
    end if;
    raise check_violation using message = 'The cleanup lease already recorded a conflicting result.';
  end if;
  if cleanup_record.status <> 'processing'
    or cleanup_record.lease_owner is distinct from normalized_owner
  then
    raise check_violation using message = 'The protected-storage cleanup lease is no longer active.';
  end if;

  next_attempt := case
    when cleanup_record.attempt_count >= 20 then cleanup_record.attempt_count
    else cleanup_record.attempt_count + 1
  end;

  update private.protected_storage_cleanup_jobs cleanup
  set status = case when next_attempt >= 20 then 'quarantined' else 'pending' end,
      attempt_count = next_attempt,
      available_at = case
        when next_attempt >= 20 then cleanup.available_at
        else clock_timestamp() + make_interval(secs => case
          when next_attempt <= 1 then 30
          when next_attempt = 2 then 60
          when next_attempt = 3 then 120
          when next_attempt = 4 then 240
          when next_attempt = 5 then 480
          when next_attempt = 6 then 960
          when next_attempt = 7 then 1920
          else 3600
        end)
      end,
      quarantined_at = case
        when next_attempt >= 20 then coalesce(cleanup.quarantined_at, clock_timestamp())
        else cleanup.quarantined_at
      end,
      lease_owner = null,
      leased_at = null,
      last_error = left(coalesce(nullif(btrim(target_error), ''), 'storage_cleanup_failed'), 500),
      last_result_lease_owner = normalized_owner,
      last_result_outcome = 'deferred',
      last_result_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where cleanup.id = cleanup_record.id;
end
$$;

create or replace function public.service_complete_protected_storage_cleanup_v2(
  target_cleanup_id uuid,
  target_lease_owner text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cleanup_record private.protected_storage_cleanup_jobs%rowtype;
  normalized_owner text := nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '');
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if normalized_owner is null then
    raise check_violation using message = 'A cleanup lease owner is required.';
  end if;

  select cleanup.* into cleanup_record
  from private.protected_storage_cleanup_jobs cleanup
  where cleanup.id = target_cleanup_id
  for update;
  if not found then
    raise check_violation using message = 'The protected-storage cleanup job was not found.';
  end if;

  if cleanup_record.last_result_lease_owner = normalized_owner then
    if cleanup_record.last_result_outcome = 'completed'
      and cleanup_record.status = 'completed'
      and cleanup_record.lease_owner is null
      and cleanup_record.leased_at is null
    then
      return;
    end if;
    raise check_violation using message = 'The cleanup lease already recorded a conflicting result.';
  end if;
  if cleanup_record.status <> 'processing'
    or cleanup_record.lease_owner is distinct from normalized_owner
  then
    raise check_violation using message = 'The protected-storage cleanup lease is no longer active.';
  end if;

  update private.protected_storage_cleanup_jobs cleanup
  set status = 'completed',
      completed_at = clock_timestamp(),
      lease_owner = null,
      leased_at = null,
      last_error = null,
      last_result_lease_owner = normalized_owner,
      last_result_outcome = 'completed',
      last_result_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where cleanup.id = cleanup_record.id;

  if cleanup_record.cleanup_kind = 'signature_appearance' then
    update private.signature_appearance_operations operation
    set status = 'cleaned',
        completed_at = coalesce(operation.completed_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where operation.id = cleanup_record.source_operation_id
      and operation.status = 'cleanup_pending';
  end if;
end
$$;

revoke all on function public.service_list_protected_storage_cleanup_v2(integer, text)
  from public, anon, authenticated;
revoke all on function public.service_defer_protected_storage_cleanup_v2(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_protected_storage_cleanup_v2(uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_list_protected_storage_cleanup_v2(integer, text) to service_role;
grant execute on function public.service_defer_protected_storage_cleanup_v2(uuid, text, text) to service_role;
grant execute on function public.service_complete_protected_storage_cleanup_v2(uuid, text) to service_role;

comment on column private.protected_storage_cleanup_jobs.last_result_lease_owner is
  'Opaque cleanup lease whose latest database result can be replayed safely after response loss.';
comment on column private.protected_storage_cleanup_jobs.last_result_outcome is
  'Idempotent latest cleanup result for one opaque lease: deferred or completed.';

notify pgrst, 'reload schema';

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Protected-object cleanup is deliberately conservative. A permanently
-- unavailable or unverifiable object must not overflow retry arithmetic or
-- repeatedly monopolize the oldest recovery slot. Quarantine preserves the
-- exact cleanup identity and error for review without claiming deletion.
alter table private.protected_storage_cleanup_jobs
  add column if not exists quarantined_at timestamptz;

alter table private.protected_storage_cleanup_jobs
  drop constraint if exists protected_storage_cleanup_jobs_status_check;
alter table private.protected_storage_cleanup_jobs
  add constraint protected_storage_cleanup_jobs_status_check
  check (status in ('pending', 'processing', 'completed', 'cancelled', 'quarantined'));

update private.protected_storage_cleanup_jobs cleanup
set status = 'quarantined',
    quarantined_at = coalesce(cleanup.quarantined_at, clock_timestamp()),
    lease_owner = null,
    leased_at = null,
    last_error = coalesce(cleanup.last_error, 'Protected storage cleanup exceeded the automatic retry limit.'),
    updated_at = clock_timestamp()
where cleanup.status = 'pending'
  and cleanup.attempt_count >= 20;

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

  -- Reclaim abandoned leases without ever incrementing an unbounded counter.
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

  -- A reference that became authoritative always wins, including after a job
  -- entered quarantine. Cancellation does not assert that storage was deleted.
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
        attempt_count = cleanup.attempt_count + 1,
        lease_owner = normalized_owner,
        leased_at = clock_timestamp(),
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
    'attemptCount', updated.attempt_count
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
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  update private.protected_storage_cleanup_jobs cleanup
  set status = case when cleanup.attempt_count >= 20 then 'quarantined' else 'pending' end,
      available_at = case
        when cleanup.attempt_count >= 20 then cleanup.available_at
        else clock_timestamp() + make_interval(secs => case
          when cleanup.attempt_count <= 1 then 30
          when cleanup.attempt_count = 2 then 60
          when cleanup.attempt_count = 3 then 120
          when cleanup.attempt_count = 4 then 240
          when cleanup.attempt_count = 5 then 480
          when cleanup.attempt_count = 6 then 960
          when cleanup.attempt_count = 7 then 1920
          else 3600
        end)
      end,
      quarantined_at = case
        when cleanup.attempt_count >= 20 then coalesce(cleanup.quarantined_at, clock_timestamp())
        else cleanup.quarantined_at
      end,
      lease_owner = null,
      leased_at = null,
      last_error = left(coalesce(nullif(btrim(target_error), ''), 'storage_cleanup_failed'), 500),
      updated_at = clock_timestamp()
  where cleanup.id = target_cleanup_id
    and cleanup.status = 'processing'
    and cleanup.lease_owner = nullif(left(btrim(coalesce(target_lease_owner, '')), 240), '');
  if not found then
    raise check_violation using message = 'The protected-storage cleanup lease is no longer active.';
  end if;
end
$$;

revoke all on function public.service_list_protected_storage_cleanup_v2(integer, text)
  from public, anon, authenticated;
revoke all on function public.service_defer_protected_storage_cleanup_v2(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_list_protected_storage_cleanup_v2(integer, text) to service_role;
grant execute on function public.service_defer_protected_storage_cleanup_v2(uuid, text, text) to service_role;

comment on column private.protected_storage_cleanup_jobs.quarantined_at is
  'When automatic deletion retries stopped without asserting that the exact protected object was deleted.';

commit;

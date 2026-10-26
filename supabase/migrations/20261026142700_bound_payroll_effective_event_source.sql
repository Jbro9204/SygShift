begin;

set local lock_timeout = '2s';
-- This is a one-time derived-row backfill budget. It does not change the
-- authenticated role's eight-second statement timeout.
set local statement_timeout = '90s';

-- This migration deliberately leaves immutable punches and every append-only
-- correction ledger untouched. It projects only the latest effective facts
-- that used to be rebuilt from the beginning of time on every payroll read.
do $guard_verified_timekeeping_sources$
declare
  effective_signature constant regprocedure :=
    'private.get_effective_time_events(uuid)'::regprocedure;
  review_signature constant regprocedure :=
    'private.get_timekeeping_review_base(date,date)'::regprocedure;
begin
  if md5(pg_get_functiondef(effective_signature)) <>
      'e4e6ab15b4a6bdca294cc4d250398396' then
    raise check_violation using message =
      'Effective-punch source differs from the verified production baseline; projection release refused.';
  end if;

  if md5(pg_get_functiondef(review_signature)) <>
      '2bf025842841d13fa8a4f9facab445e7' then
    raise check_violation using message =
      'Payroll base differs from the verified production baseline; bounded-source routing refused.';
  end if;
end
$guard_verified_timekeeping_sources$;

create table private.timekeeping_effective_event_projection (
  -- A derived projection must never add a delete/update constraint to an
  -- authoritative source table. Lifecycle consistency is trigger- and
  -- fingerprint-verified instead of enforced back toward source evidence.
  event_id uuid primary key,
  employee_id uuid not null,
  stored_shift_id uuid,
  display_shift_override_id uuid,
  explicit_occurrence_shift_id uuid,
  location_override_name text,
  location_override_time_zone text,
  effective_kind public.time_event_kind not null,
  recorded_at timestamptz not null,
  effective_at timestamptz not null,
  has_approved_correction boolean not null,
  voided boolean not null,
  pending_correction boolean not null,
  manual_entry_id uuid,
  manual_clock_in_at timestamptz,
  source_fingerprint text not null,
  refreshed_at timestamptz not null default clock_timestamp(),
  constraint timekeeping_effective_projection_fingerprint_present
    check (length(source_fingerprint) = 32)
);

revoke all on table private.timekeeping_effective_event_projection
  from public, anon, authenticated;

create index timekeeping_effective_projection_at_idx
  on private.timekeeping_effective_event_projection
    (effective_at, recorded_at, event_id, employee_id);
create index timekeeping_effective_projection_employee_at_idx
  on private.timekeeping_effective_event_projection
    (employee_id, effective_at, recorded_at, event_id);
create index timekeeping_effective_projection_open_close_idx
  on private.timekeeping_effective_event_projection
    (employee_id, effective_at, recorded_at, event_id)
  where not voided and effective_kind = 'clock_out';
create index timekeeping_effective_projection_stored_shift_idx
  on private.timekeeping_effective_event_projection
    (stored_shift_id, event_id)
  where stored_shift_id is not null;
create index timekeeping_effective_projection_occurrence_shift_idx
  on private.timekeeping_effective_event_projection
    (explicit_occurrence_shift_id, event_id)
  where explicit_occurrence_shift_id is not null;
create index timekeeping_effective_projection_manual_clock_in_idx
  on private.timekeeping_effective_event_projection
    (manual_clock_in_at, employee_id, event_id)
  where manual_clock_in_at is not null;

-- Recompute exactly one derived row. Every source join is keyed by event ID;
-- writes are serialized per event so retries and concurrent correction inserts
-- converge to one row without changing source history.
create function private.refresh_timekeeping_effective_event_projection(
  target_event_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if target_event_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('timekeeping-effective-projection:' || target_event_id::text, 0)
  );

  insert into private.timekeeping_effective_event_projection (
    event_id,
    employee_id,
    stored_shift_id,
    display_shift_override_id,
    explicit_occurrence_shift_id,
    location_override_name,
    location_override_time_zone,
    effective_kind,
    recorded_at,
    effective_at,
    has_approved_correction,
    voided,
    pending_correction,
    manual_entry_id,
    manual_clock_in_at,
    source_fingerprint,
    refreshed_at
  )
  select
    event.id,
    event.employee_id,
    event.shift_id,
    display_override.shift_id,
    occurrence_override.replacement_shift_id,
    location_override.location_name,
    location_override.time_zone,
    coalesce(kind_correction.replacement_kind, event.kind),
    event.recorded_at,
    coalesce(time_correction.replacement_time, event.recorded_at),
    coalesce(correction_flags.has_approved_correction, false),
    coalesce(correction_flags.voided, false),
    coalesce(correction_flags.pending_correction, false),
    manual.manual_entry_id,
    manual.clock_in_at,
    md5(jsonb_build_object(
      'eventId', event.id,
      'employeeId', event.employee_id,
      'storedShiftId', event.shift_id,
      'recordedAt', event.recorded_at,
      'kind', event.kind,
      'timeCorrectionId', time_correction.id,
      'timeCorrectionValue', time_correction.replacement_time,
      'kindCorrectionId', kind_correction.id,
      'kindCorrectionValue', kind_correction.replacement_kind,
      'correctionLedger', coalesce(correction_flags.ledger_fingerprint, ''),
      'displayOverrideId', display_override.id,
      'occurrenceOverrideId', occurrence_override.id,
      'locationOverrideId', location_override.id,
      'manualEntryId', manual.manual_entry_id,
      'manualClockInAt', manual.clock_in_at
    )::text),
    clock_timestamp()
  from public.time_events event
  left join lateral (
    select correction.id, correction.replacement_time
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
      and correction.approved_at is not null
      and not correction.voided
      and correction.replacement_time is not null
    order by correction.approved_at desc, correction.created_at desc,
      correction.id desc
    limit 1
  ) time_correction on true
  left join lateral (
    select correction.id, correction.replacement_kind
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
      and correction.approved_at is not null
      and correction.replacement_kind is not null
    order by correction.approved_at desc, correction.created_at desc,
      correction.id desc
    limit 1
  ) kind_correction on true
  left join lateral (
    select
      bool_or(correction.approved_at is not null) as has_approved_correction,
      bool_or(correction.approved_at is not null and correction.voided) as voided,
      bool_or(correction.approved_at is null and correction.declined_at is null)
        as pending_correction,
      md5(coalesce(jsonb_agg(jsonb_build_object(
        'id', correction.id,
        'replacementTime', correction.replacement_time,
        'replacementKind', correction.replacement_kind,
        'voided', correction.voided,
        'approvedAt', correction.approved_at,
        'declinedAt', correction.declined_at,
        'createdAt', correction.created_at
      ) order by correction.created_at, correction.id)::text, '[]'))
        as ledger_fingerprint
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
  ) correction_flags on true
  left join lateral (
    select override.id, override.shift_id
    from public.time_event_shift_overrides override
    where override.time_event_id = event.id
    order by override.created_at desc, override.id desc
    limit 1
  ) display_override on true
  left join lateral (
    select override.id, override.replacement_shift_id
    from public.time_event_occurrence_overrides override
    where override.time_event_id = event.id
    order by override.created_at desc, override.id desc
    limit 1
  ) occurrence_override on true
  left join lateral (
    select override.id, override.location_name, override.time_zone
    from public.time_event_location_overrides override
    where override.time_event_id = event.id
    order by override.created_at desc, override.id desc
    limit 1
  ) location_override on true
  left join lateral (
    select mapped.manual_entry_id, mapped.clock_in_at
    from (
      select entry.id as manual_entry_id, entry.clock_in_at, entry.created_at
      from public.manual_time_entries entry
      where entry.clock_in_event_id = event.id
      union all
      select entry.id, entry.clock_in_at, entry.created_at
      from public.manual_time_entries entry
      where entry.clock_out_event_id = event.id
    ) mapped
    order by mapped.created_at desc, mapped.manual_entry_id desc
    limit 1
  ) manual on true
  where event.id = target_event_id
  on conflict (event_id) do update set
    employee_id = excluded.employee_id,
    stored_shift_id = excluded.stored_shift_id,
    display_shift_override_id = excluded.display_shift_override_id,
    explicit_occurrence_shift_id = excluded.explicit_occurrence_shift_id,
    location_override_name = excluded.location_override_name,
    location_override_time_zone = excluded.location_override_time_zone,
    effective_kind = excluded.effective_kind,
    recorded_at = excluded.recorded_at,
    effective_at = excluded.effective_at,
    has_approved_correction = excluded.has_approved_correction,
    voided = excluded.voided,
    pending_correction = excluded.pending_correction,
    manual_entry_id = excluded.manual_entry_id,
    manual_clock_in_at = excluded.manual_clock_in_at,
    source_fingerprint = excluded.source_fingerprint,
    refreshed_at = excluded.refreshed_at;

  if not found then
    delete from private.timekeeping_effective_event_projection projection
    where projection.event_id = target_event_id;
  end if;
end
$$;

revoke all on function
  private.refresh_timekeeping_effective_event_projection(uuid)
  from public, anon, authenticated;

create function private.refresh_timekeeping_effective_event_projection_trigger()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'time_events' then
    perform private.refresh_timekeeping_effective_event_projection(new.id);
  elsif tg_table_name in (
    'time_event_corrections',
    'time_event_shift_overrides',
    'time_event_occurrence_overrides',
    'time_event_location_overrides'
  ) then
    perform private.refresh_timekeeping_effective_event_projection(new.time_event_id);
  elsif tg_table_name = 'manual_time_entries' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform private.refresh_timekeeping_effective_event_projection(old.clock_in_event_id);
      perform private.refresh_timekeeping_effective_event_projection(old.clock_out_event_id);
    end if;
    if tg_op <> 'DELETE' then
      perform private.refresh_timekeeping_effective_event_projection(new.clock_in_event_id);
      perform private.refresh_timekeeping_effective_event_projection(new.clock_out_event_id);
    end if;
  else
    raise check_violation using message =
      'Unsupported effective-event projection trigger source.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

revoke all on function
  private.refresh_timekeeping_effective_event_projection_trigger()
  from public, anon, authenticated;

create temp table projection_backfill_watermark (
  started_at timestamptz primary key
) on commit drop;
insert into projection_backfill_watermark values (clock_timestamp());

do $backfill_effective_event_projection$
declare
  target record;
begin
  for target in
    select event.id
    from public.time_events event
    order by event.recorded_at, event.id
  loop
    perform private.refresh_timekeeping_effective_event_projection(target.id);
  end loop;
end
$backfill_effective_event_projection$;

-- Install source hooks only after the long historical pass. CREATE TRIGGER
-- briefly fences source writers; the catch-up below refreshes every row that
-- changed after the watermark while that fence remains held. New writes wait
-- for commit and then execute the trigger normally.
create trigger zzz_refresh_timekeeping_effective_projection
after insert on public.time_events
for each row execute function
  private.refresh_timekeeping_effective_event_projection_trigger();

create trigger zzz_refresh_timekeeping_effective_projection
after insert or update of approved_at, declined_at
on public.time_event_corrections
for each row execute function
  private.refresh_timekeeping_effective_event_projection_trigger();

create trigger zzz_refresh_timekeeping_effective_projection
after insert on public.time_event_shift_overrides
for each row execute function
  private.refresh_timekeeping_effective_event_projection_trigger();

create trigger zzz_refresh_timekeeping_effective_projection
after insert on public.time_event_occurrence_overrides
for each row execute function
  private.refresh_timekeeping_effective_event_projection_trigger();

create trigger zzz_refresh_timekeeping_effective_projection
after insert on public.time_event_location_overrides
for each row execute function
  private.refresh_timekeeping_effective_event_projection_trigger();

create trigger zzz_refresh_timekeeping_effective_projection
after insert or delete or update of clock_in_event_id, clock_out_event_id, clock_in_at
on public.manual_time_entries
for each row execute function
  private.refresh_timekeeping_effective_event_projection_trigger();

do $catch_up_effective_event_projection$
declare
  target record;
  watermark timestamptz;
begin
  select started_at into strict watermark from projection_backfill_watermark;

  for target in
    select changed.event_id
    from (
      select event.id as event_id
      from public.time_events event
      where event.created_at >= watermark

      union

      select correction.time_event_id
      from public.time_event_corrections correction
      where correction.created_at >= watermark
        or correction.approved_at >= watermark
        or correction.declined_at >= watermark

      union

      select override.time_event_id
      from public.time_event_shift_overrides override
      where override.created_at >= watermark

      union

      select override.time_event_id
      from public.time_event_occurrence_overrides override
      where override.created_at >= watermark

      union

      select override.time_event_id
      from public.time_event_location_overrides override
      where override.created_at >= watermark

      union

      select entry.clock_in_event_id
      from public.manual_time_entries entry
      where entry.created_at >= watermark
        or entry.last_edited_at >= watermark

      union

      select entry.clock_out_event_id
      from public.manual_time_entries entry
      where entry.created_at >= watermark
        or entry.last_edited_at >= watermark
    ) changed
    where changed.event_id is not null
  loop
    perform private.refresh_timekeeping_effective_event_projection(target.event_id);
  end loop;

  if (select count(*) from private.timekeeping_effective_event_projection)
      <> (select count(*) from public.time_events)
    or exists (
      select 1
      from public.time_events event
      left join private.timekeeping_effective_event_projection projection
        on projection.event_id = event.id
      where projection.event_id is null
    ) then
    raise check_violation using message =
      'Effective-event projection catch-up did not cover every immutable punch.';
  end if;
end
$catch_up_effective_event_projection$;

-- Resolve only employees and complete chronological sessions that can affect
-- the requested range. A session with no prior or next clock-out deliberately
-- expands to the employee boundary, preserving the old incomplete-pair result
-- instead of silently treating it as complete or imposing an arbitrary cap.
create function private.get_effective_time_events_bounded(
  target_employee_id uuid,
  target_from_at timestamptz,
  target_through_at timestamptz
)
returns table (
  id uuid,
  employee_id uuid,
  original_shift_id uuid,
  shift_id uuid,
  location_override_name text,
  location_override_time_zone text,
  kind public.time_event_kind,
  recorded_at timestamptz,
  effective_at timestamptz,
  has_approved_correction boolean,
  voided boolean,
  pending_correction boolean,
  manual_entry_id uuid,
  manual_clock_in_at timestamptz,
  original_shift_starts_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
with seed_event_ids as materialized (
  select projection.event_id
  from private.timekeeping_effective_event_projection projection
  where (target_employee_id is null
      or projection.employee_id = target_employee_id)
    and projection.effective_at >= target_from_at - interval '24 hours'
    and projection.effective_at < target_through_at + interval '24 hours'

  union

  select projection.event_id
  from private.timekeeping_effective_event_projection projection
  where (target_employee_id is null
      or projection.employee_id = target_employee_id)
    and projection.manual_clock_in_at >= target_from_at
    and projection.manual_clock_in_at < target_through_at

  union

  select projection.event_id
  from public.shifts shift
  join private.timekeeping_effective_event_projection projection
    on projection.stored_shift_id = shift.id
  where (target_employee_id is null
      or projection.employee_id = target_employee_id)
    and shift.starts_at >= target_from_at
    and shift.starts_at < target_through_at

  union

  select projection.event_id
  from public.shifts shift
  join private.timekeeping_effective_event_projection projection
    on projection.explicit_occurrence_shift_id = shift.id
  where (target_employee_id is null
      or projection.employee_id = target_employee_id)
    and shift.starts_at >= target_from_at
    and shift.starts_at < target_through_at

  union

  -- An invalid stored link can be resolved to the sole assigned occurrence.
  -- Seed that exact candidate window even for an unusually long shift.
  select projection.event_id
  from public.shifts candidate
  join public.shift_assignments assignment
    on assignment.shift_id = candidate.id
   and assignment.status::text in ('assigned', 'confirmed', 'completed')
  join private.timekeeping_effective_event_projection projection
    on projection.employee_id = assignment.employee_id
   and projection.effective_at between candidate.starts_at - interval '4 hours'
     and candidate.ends_at + interval '4 hours'
  where projection.stored_shift_id is not null
    and (target_employee_id is null
      or projection.employee_id = target_employee_id)
    and candidate.canceled_at is null
    and candidate.starts_at >= target_from_at
    and candidate.starts_at < target_through_at
), seed_bounds as materialized (
  select
    projection.employee_id,
    (array_agg(projection.event_id order by
      projection.effective_at,
      projection.recorded_at,
      projection.event_id))[1] as first_seed_event_id,
    (array_agg(projection.event_id order by
      projection.effective_at desc,
      projection.recorded_at desc,
      projection.event_id desc))[1] as last_seed_event_id
  from seed_event_ids seed
  join private.timekeeping_effective_event_projection projection
    on projection.event_id = seed.event_id
  group by projection.employee_id
), session_bounds as materialized (
  select
    seed.*,
    previous_close.effective_at as previous_close_at,
    previous_close.recorded_at as previous_close_recorded_at,
    previous_close.event_id as previous_close_event_id,
    next_close.effective_at as next_close_at,
    next_close.recorded_at as next_close_recorded_at,
    next_close.event_id as next_close_event_id
  from seed_bounds seed
  join private.timekeeping_effective_event_projection first_seed
    on first_seed.event_id = seed.first_seed_event_id
  join private.timekeeping_effective_event_projection last_seed
    on last_seed.event_id = seed.last_seed_event_id
  left join lateral (
    select projection.effective_at, projection.recorded_at, projection.event_id
    from private.timekeeping_effective_event_projection projection
    where projection.employee_id = seed.employee_id
      and not projection.voided
      and projection.effective_kind = 'clock_out'
      and (projection.effective_at, projection.recorded_at, projection.event_id)
        < (first_seed.effective_at, first_seed.recorded_at, first_seed.event_id)
    order by projection.effective_at desc, projection.recorded_at desc,
      projection.event_id desc
    limit 1
  ) previous_close on true
  left join lateral (
    select projection.effective_at, projection.recorded_at, projection.event_id
    from private.timekeeping_effective_event_projection projection
    where projection.employee_id = seed.employee_id
      and not projection.voided
      and projection.effective_kind = 'clock_out'
      and (projection.effective_at, projection.recorded_at, projection.event_id)
        >= (last_seed.effective_at, last_seed.recorded_at, last_seed.event_id)
    order by projection.effective_at, projection.recorded_at, projection.event_id
    limit 1
  ) next_close on true
), source_events as materialized (
  select projection.*
  from session_bounds boundary
  join private.timekeeping_effective_event_projection projection
    on projection.employee_id = boundary.employee_id
   and (projection.effective_at, projection.recorded_at, projection.event_id) > (
     coalesce(boundary.previous_close_at, '-infinity'::timestamptz),
     coalesce(boundary.previous_close_recorded_at, '-infinity'::timestamptz),
     coalesce(boundary.previous_close_event_id,
       '00000000-0000-0000-0000-000000000000'::uuid)
   )
   and (projection.effective_at, projection.recorded_at, projection.event_id) <= (
     coalesce(boundary.next_close_at, 'infinity'::timestamptz),
     coalesce(boundary.next_close_recorded_at, 'infinity'::timestamptz),
     coalesce(boundary.next_close_event_id,
       'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
   )
), corrected as materialized (
  select
    event.event_id as id,
    event.employee_id,
    event.stored_shift_id,
    event.display_shift_override_id,
    event.explicit_occurrence_shift_id,
    event.location_override_name,
    event.location_override_time_zone,
    event.effective_kind as kind,
    event.recorded_at,
    event.effective_at,
    event.has_approved_correction,
    event.voided,
    event.pending_correction,
    event.manual_entry_id,
    event.manual_clock_in_at,
    case
      when stored_shift.id is not null
        and event.effective_at between stored_shift.starts_at - interval '4 hours'
          and stored_shift.ends_at + interval '4 hours'
      then event.stored_shift_id
      else null
    end as valid_stored_shift_id
  from source_events event
  left join public.shifts stored_shift on stored_shift.id = event.stored_shift_id
), candidate_rows as materialized (
  select distinct
    event.id as time_event_id,
    candidate.id as shift_id,
    case schedule.status::text
      when 'published' then 3
      when 'archived' then 2
      when 'superseded' then 1
      else 0
    end as schedule_priority
  from corrected event
  join public.shift_assignments assignment
    on assignment.employee_id = event.employee_id
   and assignment.status::text in ('assigned', 'confirmed', 'completed')
  join public.shifts candidate
    on candidate.id = assignment.shift_id
   and candidate.canceled_at is null
   and event.effective_at between candidate.starts_at - interval '4 hours'
     and candidate.ends_at + interval '4 hours'
  join public.schedules schedule
    on schedule.id = candidate.schedule_id
   and schedule.status::text in ('published', 'archived', 'superseded')
  where event.stored_shift_id is not null
    and event.valid_stored_shift_id is null
    and event.explicit_occurrence_shift_id is null
), best_priority as materialized (
  select time_event_id, max(schedule_priority) as schedule_priority
  from candidate_rows
  group by time_event_id
), unique_candidate as (
  select
    candidate.time_event_id,
    min(candidate.shift_id::text)::uuid as shift_id
  from candidate_rows candidate
  join best_priority priority
    on priority.time_event_id = candidate.time_event_id
   and priority.schedule_priority = candidate.schedule_priority
  group by candidate.time_event_id
  having count(distinct candidate.shift_id) = 1
), direct_resolution as materialized (
  select
    event.*,
    coalesce(
      event.explicit_occurrence_shift_id,
      event.valid_stored_shift_id,
      candidate.shift_id
    ) as direct_occurrence_shift_id
  from corrected event
  left join unique_candidate candidate on candidate.time_event_id = event.id
), active_ordered as materialized (
  select
    event.*,
    coalesce(sum(case when event.kind = 'clock_out' then 1 else 0 end) over (
      partition by event.employee_id
      order by event.effective_at, event.recorded_at, event.id
      rows between unbounded preceding and 1 preceding
    ), 0)::bigint as session_number
  from direct_resolution event
  where not event.voided
), session_starts as materialized (
  select
    event.employee_id,
    event.session_number,
    (array_agg(event.id order by event.effective_at, event.recorded_at, event.id)
      filter (where event.kind = 'clock_in'))[1] as clock_in_event_id
  from active_ordered event
  group by event.employee_id, event.session_number
), resolved as materialized (
  select
    event.*,
    case
      when event.explicit_occurrence_shift_id is not null
        then event.explicit_occurrence_shift_id
      when event.kind = 'clock_in'
        then event.direct_occurrence_shift_id
      when session.clock_in_event_id is not null
        then session_clock_in.direct_occurrence_shift_id
      else event.direct_occurrence_shift_id
    end as resolved_occurrence_shift_id
  from direct_resolution event
  left join active_ordered membership on membership.id = event.id
  left join session_starts session
    on session.employee_id = membership.employee_id
   and session.session_number = membership.session_number
  left join direct_resolution session_clock_in
    on session_clock_in.id = session.clock_in_event_id
)
select
  event.id,
  event.employee_id,
  event.resolved_occurrence_shift_id as original_shift_id,
  coalesce(
    event.display_shift_override_id,
    event.resolved_occurrence_shift_id,
    event.stored_shift_id
  ) as shift_id,
  event.location_override_name,
  event.location_override_time_zone,
  event.kind,
  event.recorded_at,
  event.effective_at,
  event.has_approved_correction,
  event.voided,
  event.pending_correction,
  event.manual_entry_id,
  event.manual_clock_in_at,
  occurrence_shift.starts_at as original_shift_starts_at
from resolved event
left join public.shifts occurrence_shift
  on occurrence_shift.id = event.resolved_occurrence_shift_id
$$;

revoke all on function private.get_effective_time_events_bounded(
  uuid,
  timestamptz,
  timestamptz
) from public, anon, authenticated;

-- Route only the payroll review base. Operational live-clock readers continue
-- to use the mature unbounded resolver until separately verified.
do $route_payroll_base_through_bounded_events$
declare
  signature constant regprocedure :=
    'private.get_timekeeping_review_base(date,date)'::regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  revised_sql text;
  original_token text := 'from private.get_effective_time_events() event';
  revised_token text := $bounded_call$from private.get_effective_time_events_bounded(
      null,
      target_from_date::timestamp at time zone rules.time_zone,
      (target_through_date + 1)::timestamp at time zone rules.time_zone
    ) event$bounded_call$;
begin
  select * into strict original_function
  from pg_catalog.pg_proc
  where oid = signature;
  original_sql := pg_get_functiondef(signature);

  if md5(original_sql) <> '2bf025842841d13fa8a4f9facab445e7'
    or cardinality(string_to_array(original_sql, original_token)) <> 2 then
    raise check_violation using message =
      'Payroll base differs from the verified production baseline; bounded-source routing refused.';
  end if;

  revised_sql := replace(original_sql, original_token, revised_token);
  execute revised_sql;

  select * into strict revised_function
  from pg_catalog.pg_proc
  where oid = signature;
  if pg_get_functiondef(signature) <> revised_sql
    or revised_function.proowner is distinct from original_function.proowner
    or revised_function.proacl is distinct from original_function.proacl
    or revised_function.proconfig is distinct from original_function.proconfig
    or revised_function.prosecdef is distinct from original_function.prosecdef
    or revised_function.provolatile is distinct from original_function.provolatile
    or revised_function.proargdefaults is distinct from original_function.proargdefaults then
    raise check_violation using message =
      'Bounded payroll routing changed the verified function boundary.';
  end if;
end
$route_payroll_base_through_bounded_events$;

comment on table private.timekeeping_effective_event_projection is
  'Derived, trigger-maintained effective punch facts. Source punches and append-only correction ledgers remain authoritative.';
comment on function private.get_effective_time_events_bounded(uuid, timestamptz, timestamptz) is
  'Reads indexed effective facts and expands exact employee session boundaries for a requested payroll range.';

commit;

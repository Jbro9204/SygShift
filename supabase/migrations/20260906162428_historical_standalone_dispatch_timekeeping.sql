begin;

-- Historical standalone Dispatch classifications only. Existing punch and
-- payroll records retain their original schedule-revision references.
lock table public.shifts in share row exclusive mode;
alter table public.shifts disable trigger shifts_published_immutable;

update public.shifts dispatch_shift
set assignment_type = 'standard',
    updated_at = clock_timestamp()
from public.schedules schedule,
     public.posts dispatch_post,
     public.sites dispatch_site
where schedule.id = dispatch_shift.schedule_id
  and dispatch_post.id = dispatch_shift.post_id
  and dispatch_site.id = dispatch_post.site_id
  and dispatch_site.supports_dispatch_phone_duty
  and schedule.status in ('draft', 'published')
  and (dispatch_shift.starts_at at time zone dispatch_shift.time_zone)::date between date '2026-08-09' and date '2026-09-05'
  and dispatch_shift.canceled_at is null
  and dispatch_shift.assignment_type = 'dispatch_phone_duty'
  and not exists (
    select 1
    from public.shift_assignments dispatch_assignment
    join public.shift_assignments other_assignment
      on other_assignment.employee_id = dispatch_assignment.employee_id
     and other_assignment.status in ('assigned', 'confirmed', 'completed')
     and other_assignment.canceled_at is null
    join public.shifts other_shift
      on other_shift.id = other_assignment.shift_id
     and other_shift.id <> dispatch_shift.id
     and other_shift.schedule_id = dispatch_shift.schedule_id
     and other_shift.canceled_at is null
     and tstzrange(other_shift.starts_at, other_shift.ends_at, '[)')
       && tstzrange(dispatch_shift.starts_at, dispatch_shift.ends_at, '[)')
    left join public.posts other_post on other_post.id = other_shift.post_id
    left join public.sites other_site on other_site.id = other_post.site_id
    where dispatch_assignment.shift_id = dispatch_shift.id
      and dispatch_assignment.status in ('assigned', 'confirmed', 'completed')
      and dispatch_assignment.canceled_at is null
      and private.shift_assignment_type(other_shift.id) = 'standard'
      and other_shift.work_type = 'post'
      and not coalesce(other_site.supports_dispatch_phone_duty, false)
  );

alter table public.shifts enable trigger shifts_published_immutable;


-- A schedule republication changes shift IDs, not the underlying worked time.
create or replace function private.same_scheduled_occurrence(first_shift_id uuid, second_shift_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select first_shift_id = second_shift_id or exists (
    select 1 from public.shifts a join public.shifts b on b.id = second_shift_id
    join public.schedules sa on sa.id = a.schedule_id join public.schedules sb on sb.id = b.schedule_id
    where a.id = first_shift_id and a.schedule_id <> b.schedule_id and sa.week_starts_on = sb.week_starts_on
      and a.post_id is not distinct from b.post_id and a.event_id is not distinct from b.event_id
      and a.starts_at = b.starts_at and a.ends_at = b.ends_at
  )
$$;
revoke all on function private.same_scheduled_occurrence(uuid,uuid) from public, anon, authenticated;

-- Reject a second clock-in on an equivalent revision; use correction workflows
-- on the original punch instead. True concurrent phone duty remains non-payable.
create or replace function private.prevent_duplicate_revision_clock_in()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> 'clock_in' or new.shift_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('revision-time-entry:' || new.employee_id::text, 0));
  if exists (
    select 1 from public.time_events existing
    cross join lateral private.current_effective_time_event(existing.id) effective
    where existing.employee_id = new.employee_id
      and existing.shift_id <> new.shift_id
      and existing.idempotency_key is distinct from new.idempotency_key
      and private.current_effective_time_event_kind(existing.id) = 'clock_in'
      and not effective.voided
      and private.same_scheduled_occurrence(existing.shift_id, new.shift_id)
  ) then
    raise check_violation using message = 'This shift already has a clock-in on an earlier schedule revision. Open the existing timecard and correct that punch; do not add a second paid shift.';
  end if;
  return new;
end
$$;
revoke all on function private.prevent_duplicate_revision_clock_in() from public, anon, authenticated;
create trigger time_events_prevent_duplicate_revision_clock_in before insert on public.time_events
for each row execute function private.prevent_duplicate_revision_clock_in();

-- Missed-punch monitoring must recognize the same preserved revision history.
-- Automatic clock-out still closes the exact original clock-in shift ID.
do $revision_aware_monitor$
declare definition text;
  old_missing text := 'and event.shift_id = shift.id
          and event.kind = ''clock_in''';
  old_resolve text := 'where event.shift_id = exception.shift_id
            and event.employee_id = exception.employee_id';
begin
  definition := pg_get_functiondef('public.service_run_timekeeping_automation(uuid)'::regprocedure);
  if position(old_missing in definition) = 0 or position(old_resolve in definition) = 0 then
    raise exception 'Timekeeping automation structure changed; review required.';
  end if;
  definition := replace(definition, old_missing, 'and private.same_scheduled_occurrence(event.shift_id, shift.id)
          and private.current_effective_time_event_kind(event.id) = ''clock_in''');
  definition := replace(definition, old_resolve, 'where private.same_scheduled_occurrence(event.shift_id, exception.shift_id)
            and event.employee_id = exception.employee_id');
  execute definition;
end
$revision_aware_monitor$;

notify pgrst, 'reload schema';
commit;

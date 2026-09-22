begin;

alter table public.attendance_accountability_events
  add column if not exists reported_late_minutes integer,
  add column if not exists expected_arrival_at timestamptz,
  add column if not exists actual_arrival_at timestamptz,
  add column if not exists operational_alert_id uuid references public.operational_alerts(id) on delete restrict;

alter table public.attendance_accountability_events
  drop constraint if exists attendance_accountability_late_minutes_check;
alter table public.attendance_accountability_events
  add constraint attendance_accountability_late_minutes_check
  check (reported_late_minutes is null or reported_late_minutes between 1 and 1440);

create index if not exists attendance_accountability_open_late_idx
  on public.attendance_accountability_events(employee_id, shift_id, expected_arrival_at)
  where event_type = 'late_arrival' and actual_arrival_at is null and status <> 'voided';

create or replace function public.create_attendance_accountability_event_v2(
  target_employee_id uuid,
  target_shift_id uuid default null,
  target_event_type text default 'other',
  target_operational_date date default null,
  target_note text default null,
  target_reported_late_minutes integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  event_id uuid;
  event_record public.attendance_accountability_events%rowtype;
  employee_name text;
  alert_id uuid;
begin
  if target_event_type = 'late_arrival'
     and (target_reported_late_minutes is null or target_reported_late_minutes not between 1 and 1440) then
    raise check_violation using message = 'Enter the employee''s expected delay in minutes.';
  end if;
  if target_event_type <> 'late_arrival' and target_reported_late_minutes is not null then
    raise check_violation using message = 'A late-arrival delay can only be used for a late-arrival occurrence.';
  end if;

  result := public.create_attendance_accountability_event(
    target_employee_id,
    target_shift_id,
    target_event_type,
    target_operational_date,
    target_note
  );
  event_id := (result ->> 'id')::uuid;

  if target_event_type = 'late_arrival' then
    update public.attendance_accountability_events event
    set reported_late_minutes = target_reported_late_minutes,
        expected_arrival_at = event.starts_at + make_interval(mins => target_reported_late_minutes),
        actual_arrival_at = (
          select min(time_event.recorded_at)
          from public.time_events time_event
          where time_event.employee_id = event.employee_id
            and time_event.kind = 'clock_in'
            and time_event.shift_id is not null
            and private.same_scheduled_occurrence(time_event.shift_id, event.shift_id)
            and time_event.recorded_at >= event.starts_at - interval '4 hours'
            and time_event.recorded_at <= event.ends_at + interval '4 hours'
        ),
        updated_at = clock_timestamp()
    where event.id = event_id
    returning * into event_record;

    select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
    into employee_name
    from public.employees employee
    where employee.id = event_record.employee_id;

    if event_record.actual_arrival_at is null then
      insert into public.operational_alerts (
        alert_type, priority, title, summary, employee_id, shift_id,
        related_record_type, related_record_id, audience_roles, direct_path,
        deduplication_key, active, lifecycle_state, live_until_at, occurrence_key
      ) values (
        'reported_late_arrival', 'high', 'Employee running late',
        format('%s reported %s minutes late. Expected arrival: %s.', employee_name, target_reported_late_minutes,
          to_char(event_record.expected_arrival_at at time zone coalesce((select shift.time_zone from public.shifts shift where shift.id = event_record.shift_id), 'America/Denver'), 'FMHH12:MI AM')),
        event_record.employee_id, event_record.shift_id,
        'attendance_accountability_event', event_record.id,
        array['dispatcher'::public.app_role, 'scheduler'::public.app_role, 'supervisor'::public.app_role, 'admin'::public.app_role],
        '/time/accountability?event=' || event_record.id::text,
        'late-arrival:' || event_record.id::text, true, 'active_operations', event_record.ends_at + interval '4 hours',
        'late-arrival:' || event_record.id::text
      )
      on conflict (deduplication_key) do update
      set active = true,
          lifecycle_state = 'active_operations',
          summary = excluded.summary,
          live_until_at = excluded.live_until_at,
          cleared_at = null,
          cleared_by = null,
          clear_source = null,
          cleared_reason = null
      returning id into alert_id;

      update public.attendance_accountability_events
      set operational_alert_id = alert_id, updated_at = clock_timestamp()
      where id = event_id;
    end if;
  end if;

  return result || jsonb_build_object(
    'reportedLateMinutes', target_reported_late_minutes,
    'expectedArrivalAt', event_record.expected_arrival_at,
    'actualArrivalAt', event_record.actual_arrival_at
  );
end
$$;

revoke all on function public.create_attendance_accountability_event_v2(uuid, uuid, text, date, text, integer) from public, anon;
grant execute on function public.create_attendance_accountability_event_v2(uuid, uuid, text, date, text, integer) to authenticated;

create or replace function public.get_accountability_workspace_v2(target_from_date date, target_through_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb := public.get_accountability_workspace(target_from_date, target_through_date);
  events_payload jsonb;
begin
  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      'reportedLateMinutes', event.reported_late_minutes,
      'expectedArrivalAt', event.expected_arrival_at,
      'actualArrivalAt', event.actual_arrival_at
    ) order by item.ordinality
  ), '[]'::jsonb)
  into events_payload
  from jsonb_array_elements(coalesce(payload -> 'events', '[]'::jsonb)) with ordinality item(value, ordinality)
  left join public.attendance_accountability_events event
    on item.value ->> 'sourceTable' = 'attendance_accountability_events'
   and event.id = (item.value ->> 'id')::uuid;

  return jsonb_set(payload, '{events}', events_payload, true);
end
$$;

revoke all on function public.get_accountability_workspace_v2(date, date) from public, anon;
grant execute on function public.get_accountability_workspace_v2(date, date) to authenticated;

create or replace function private.resolve_reported_late_arrival()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  late_event public.attendance_accountability_events%rowtype;
begin
  if new.kind <> 'clock_in' or new.shift_id is null then
    return new;
  end if;

  for late_event in
    select event.*
    from public.attendance_accountability_events event
    where event.employee_id = new.employee_id
      and event.event_type = 'late_arrival'
      and event.status <> 'voided'
      and event.actual_arrival_at is null
      and event.shift_id is not null
      and private.same_scheduled_occurrence(event.shift_id, new.shift_id)
      and new.recorded_at between event.starts_at - interval '4 hours' and event.ends_at + interval '4 hours'
    for update
  loop
    update public.attendance_accountability_events
    set actual_arrival_at = new.recorded_at,
        updated_at = clock_timestamp()
    where id = late_event.id;

    update public.operational_alerts
    set active = false,
        lifecycle_state = 'resolved',
        cleared_at = clock_timestamp(),
        clear_source = 'automatic_resolution',
        cleared_reason = 'The employee clocked in.'
    where id = late_event.operational_alert_id
      and active;
  end loop;
  return new;
end
$$;

drop trigger if exists resolve_reported_late_arrival on public.time_events;
create trigger resolve_reported_late_arrival
after insert on public.time_events
for each row execute function private.resolve_reported_late_arrival();

create or replace function private.prevent_absent_employee_clock_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'clock_in'
     and new.shift_id is not null
     and exists (
       select 1
       from public.shift_coverage_cases coverage
       where coverage.absent_employee_id = new.employee_id
         and coverage.status <> 'canceled'
         and private.same_scheduled_occurrence(coverage.source_shift_id, new.shift_id)
     ) then
    raise check_violation using message = 'This employee is recorded as called off for the selected shift. Use the replacement coverage shift.';
  end if;
  return new;
end
$$;

drop trigger if exists prevent_absent_employee_clock_in on public.time_events;
create trigger prevent_absent_employee_clock_in
before insert on public.time_events
for each row execute function private.prevent_absent_employee_clock_in();

create or replace function public.get_shift_coverage_status_map(target_week_starts_on date)
returns table (
  "shiftId" uuid,
  "marker" text,
  "coverageCaseId" uuid,
  "coverageStatus" text,
  "absentEmployeeId" uuid,
  "absentEmployeeName" text,
  "replacementEmployeeId" uuid,
  "replacementEmployeeName" text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_view_team boolean := false;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  can_view_team := public.has_any_effective_permission(array['schedule.view', 'scheduler.view', 'scheduler.manage', 'schedule.manage']);

  return query
  with selected_schedule as (
    select schedule.id
    from public.schedules schedule
    where schedule.week_starts_on = target_week_starts_on
      and schedule.status in ('draft', 'published')
    order by (schedule.status = 'draft') desc, schedule.revision desc
    limit 1
  )
  select
    shift.id,
    case when shift.coverage_source_shift_id is not null then 'coverage' else 'call_off' end,
    coverage.id,
    coverage.status,
    coverage.absent_employee_id,
    btrim(coalesce(absent.preferred_name, absent.first_name) || ' ' || absent.last_name),
    coverage.replacement_employee_id,
    case when replacement.id is null then null else btrim(coalesce(replacement.preferred_name, replacement.first_name) || ' ' || replacement.last_name) end
  from selected_schedule
  join public.shifts shift on shift.schedule_id = selected_schedule.id and shift.canceled_at is null
  join lateral (
    select candidate.*
    from public.shift_coverage_cases candidate
    where candidate.status <> 'canceled'
      and (
        (shift.coverage_source_shift_id is not null and private.same_scheduled_occurrence(candidate.source_shift_id, shift.coverage_source_shift_id))
        or
        (shift.coverage_source_shift_id is null and private.same_scheduled_occurrence(candidate.source_shift_id, shift.id))
      )
    order by candidate.updated_at desc, candidate.id desc
    limit 1
  ) coverage on true
  join public.employees absent on absent.id = coverage.absent_employee_id
  left join public.employees replacement on replacement.id = coverage.replacement_employee_id
  where can_view_team
     or coverage.absent_employee_id = actor_id
     or coverage.replacement_employee_id = actor_id
     or exists (
       select 1 from public.shift_assignments assignment
       where assignment.shift_id = shift.id
         and assignment.employee_id = actor_id
         and assignment.status in ('assigned', 'confirmed', 'completed')
     );
end
$$;

revoke all on function public.get_shift_coverage_status_map(date) from public, anon;
grant execute on function public.get_shift_coverage_status_map(date) to authenticated;

commit;

begin;

create temporary table concurrent_dispatch_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.shift_assignments) as assignment_count,
  (select count(*) from public.time_events) as time_event_count,
  (select md5(coalesce(string_agg(concat_ws(':', event.id::text, event.employee_id::text, coalesce(event.shift_id::text, ''), event.kind::text, event.recorded_at::text), '|' order by event.id), '')) from public.time_events event) as time_event_fingerprint;

alter table public.sites
  add column if not exists supports_dispatch_phone_duty boolean not null default false;

alter table public.shifts
  add column if not exists assignment_type text not null default 'standard';

alter table public.shifts
  drop constraint if exists shifts_assignment_type_check;

alter table public.shifts
  add constraint shifts_assignment_type_check
  check (assignment_type in ('standard', 'dispatch_phone_duty'));

update public.sites site
set supports_dispatch_phone_duty = true,
    updated_at = clock_timestamp()
where site.name = 'Dispatch Phone Coverage'
  and not site.supports_dispatch_phone_duty;

update public.shifts shift
set assignment_type = 'dispatch_phone_duty',
    updated_at = clock_timestamp()
from public.posts post
join public.sites site on site.id = post.site_id
cross join public.schedules schedule
where shift.post_id = post.id
  and schedule.id = shift.schedule_id
  and site.supports_dispatch_phone_duty
  and schedule.status = 'draft'
  and shift.assignment_type is distinct from 'dispatch_phone_duty';

create or replace function private.set_shift_assignment_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatch_phone_duty boolean := false;
begin
  if new.post_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_phone_duty
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = new.post_id;
  elsif new.event_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_phone_duty
    from public.events event
    left join public.sites site on site.id = event.site_id
    where event.id = new.event_id;
  end if;

  new.assignment_type := case when coalesce(dispatch_phone_duty, false)
    then 'dispatch_phone_duty' else 'standard' end;
  return new;
end
$$;

drop trigger if exists shifts_set_assignment_type on public.shifts;
create trigger shifts_set_assignment_type
before insert or update of post_id, event_id on public.shifts
for each row execute function private.set_shift_assignment_type();

revoke all on function private.set_shift_assignment_type() from public, anon, authenticated;

create or replace function private.shift_assignment_type(target_shift_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce(post_site.supports_dispatch_phone_duty, event_site.supports_dispatch_phone_duty, false)
      then 'dispatch_phone_duty'
    else shift.assignment_type
  end
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.id = target_shift_id
$$;

revoke all on function private.shift_assignment_type(uuid) from public, anon, authenticated;

create or replace function private.assignment_overlap_conflict(
  target_assignment_id uuid,
  target_shift_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  conflict_record record;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null;

  if target_shift.id is null then return null; end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then return null; end if;

  select
    assignment.id as assignment_id,
    shift.id as shift_id,
    schedule.id as schedule_id,
    schedule.week_starts_on,
    schedule.revision,
    schedule.status,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    private.shift_assignment_type(shift.id) as assignment_type,
    coalesce(site.name || ' / ' || post.name, event.location_name, event.name, 'Unlabeled shift') as location_label,
    btrim(concat_ws(' ', employee.first_name, employee.last_name)) as employee_name
  into conflict_record
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  join public.employees employee on employee.id = assignment.employee_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where assignment.employee_id = target_employee_id
    and assignment.id is distinct from target_assignment_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and shift.id <> target_shift_id
    and shift.canceled_at is null
    and not (
      schedule.id = target_schedule.id
      and shift.post_id is not distinct from target_shift.post_id
      and shift.event_id is not distinct from target_shift.event_id
      and shift.starts_at = target_shift.starts_at
      and shift.ends_at = target_shift.ends_at
      and shift.time_zone = target_shift.time_zone
      and shift.requires_armed = target_shift.requires_armed
    )
    and (
      schedule.id = target_schedule.id
      or (
        schedule.status = 'published'
        and schedule.id is distinct from target_schedule.previous_revision_id
        and not (target_schedule.status = 'draft' and schedule.week_starts_on = target_schedule.week_starts_on)
      )
    )
    and tstzrange(shift.starts_at, shift.ends_at, '[)') && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
    and not (
      (private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty' and private.shift_assignment_type(shift.id) = 'standard' and shift.work_type = 'post')
      or (private.shift_assignment_type(shift.id) = 'dispatch_phone_duty' and private.shift_assignment_type(target_shift.id) = 'standard' and target_shift.work_type = 'post')
    )
  order by shift.starts_at, shift.ends_at, schedule.week_starts_on, schedule.revision desc, assignment.id
  limit 1;

  if conflict_record.assignment_id is null then return null; end if;

  return jsonb_build_object(
    'assignmentId', conflict_record.assignment_id,
    'shiftId', conflict_record.shift_id,
    'scheduleId', conflict_record.schedule_id,
    'weekStartsOn', conflict_record.week_starts_on,
    'revision', conflict_record.revision,
    'status', conflict_record.status,
    'employeeName', conflict_record.employee_name,
    'location', conflict_record.location_label,
    'date', to_char((conflict_record.starts_at at time zone conflict_record.time_zone)::date, 'MM/DD/YYYY'),
    'startsAt', to_char(conflict_record.starts_at at time zone conflict_record.time_zone, 'FMHH12:MI AM'),
    'endsAt', to_char(conflict_record.ends_at at time zone conflict_record.time_zone, 'FMHH12:MI AM'),
    'timeZone', conflict_record.time_zone,
    'assignmentType', conflict_record.assignment_type
  );
end
$$;

comment on function private.assignment_overlap_conflict(uuid, uuid, uuid) is
  'Blocks real assignment conflicts while permitting exactly one explicit Dispatch phone-duty assignment to overlap one standard Post Time responsibility.';

create or replace function private.audit_concurrent_dispatch_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  overlapping_shift_id uuid;
begin
  if new.status not in ('assigned', 'confirmed', 'completed') then return new; end if;

  select * into target_shift from public.shifts where id = new.shift_id;
  if private.shift_assignment_type(target_shift.id) <> 'dispatch_phone_duty' then return new; end if;

  select shift.id into overlapping_shift_id
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  where assignment.employee_id = new.employee_id
    and assignment.id <> new.id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and private.shift_assignment_type(shift.id) = 'standard'
    and shift.work_type = 'post'
    and shift.canceled_at is null
    and tstzrange(shift.starts_at, shift.ends_at, '[)') && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  order by shift.starts_at, shift.id
  limit 1;

  if overlapping_shift_id is not null then
    insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
    values (
      auth.uid(), coalesce(new.assigned_by, private.current_employee_id()), 'public', 'shift_assignments',
      'ASSIGN_CONCURRENT_DISPATCH_PHONE_DUTY', new.id::text,
      jsonb_build_object(
        'assignedEmployeeId', new.employee_id,
        'dispatchShiftId', new.shift_id,
        'overlappingShiftId', overlapping_shift_id,
        'assignedBy', new.assigned_by,
        'assignedAt', new.assigned_at,
        'responsibility', target_shift.notes,
        'payableMinutesAdded', 0
      )
    );
  end if;
  return new;
end
$$;

drop trigger if exists shift_assignments_audit_concurrent_dispatch on public.shift_assignments;
create trigger shift_assignments_audit_concurrent_dispatch
after insert or update of status on public.shift_assignments
for each row execute function private.audit_concurrent_dispatch_assignment();

revoke all on function private.audit_concurrent_dispatch_assignment() from public, anon, authenticated;

create or replace function public.get_timekeeping_dashboard(target_operational_date date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  target_date date := coalesce(target_operational_date, (clock_timestamp() at time zone 'America/Denver')::date);
  server_now timestamptz := clock_timestamp();
  employee_record record;
  last_event jsonb;
  eligible_shifts jsonb;
  recent_events jsonb;
  pending_correction_count integer;
begin
  if viewer_employee_id is null then raise insufficient_privilege using message = 'An active employee account is required for timekeeping.'; end if;
  if not (public.has_effective_permission('time.self.view') or public.has_effective_permission('time.punch') or public.has_effective_permission('time.view') or public.has_effective_permission('time.manage') or public.has_effective_permission('time.export_payroll')) then
    raise insufficient_privilege using message = 'Time clock access is required for timekeeping.';
  end if;

  select employee.id, employee.username, employee.first_name, employee.last_name, employee.preferred_name,
         employee.role, employee.employment_type, employee.time_zone
  into employee_record from public.employees employee where employee.id = viewer_employee_id;

  select jsonb_build_object(
    'id', event.id, 'kind', event.kind, 'shiftId', event.shift_id, 'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((select correction.replacement_time from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and not correction.voided and correction.replacement_time is not null order by correction.approved_at desc limit 1), event.recorded_at),
    'source', event.source
  ) into last_event
  from public.time_events event
  where event.employee_id = viewer_employee_id
    and not exists (select 1 from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and correction.voided)
  order by coalesce((select correction.replacement_time from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and not correction.voided and correction.replacement_time is not null order by correction.approved_at desc limit 1), event.recorded_at) desc, event.created_at desc
  limit 1;

  with ranked_eligible_shifts as (
    select assignment.id assignment_id, assignment.status, shift.id shift_id, shift.starts_at, shift.ends_at,
      shift.time_zone, shift.requires_armed, shift.is_overtime, shift.work_type, shift.assignment_type,
      post.name post_name, site.name site_name, site.code site_code, event.name event_name,
      coalesce(event.location_name, site.name, post.name, event.name) location_name,
      row_number() over (partition by coalesce(shift.post_id, shift.event_id), shift.starts_at, shift.ends_at, shift.time_zone, shift.requires_armed, shift.is_overtime order by case assignment.status when 'confirmed' then 0 else 1 end, assignment.assigned_at, assignment.id) duplicate_rank
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where assignment.employee_id = viewer_employee_id
      and assignment.status in ('assigned', 'confirmed')
      and schedule.status = 'published'
      and shift.canceled_at is null
      and private.shift_assignment_type(shift.id) = 'standard'
      and shift.starts_at <= server_now + interval '12 hours'
      and shift.ends_at >= server_now - interval '6 hours'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', shift.assignment_id, 'shiftId', shift.shift_id, 'status', shift.status,
    'startsAt', shift.starts_at, 'endsAt', shift.ends_at, 'timeZone', shift.time_zone,
    'requiresArmed', shift.requires_armed, 'isOvertime', shift.is_overtime, 'workType', shift.work_type,
    'assignmentType', shift.assignment_type, 'postName', shift.post_name, 'siteName', shift.site_name,
    'siteCode', shift.site_code, 'eventName', shift.event_name, 'locationName', shift.location_name
  ) order by shift.starts_at), '[]'::jsonb) into eligible_shifts
  from ranked_eligible_shifts shift where shift.duplicate_rank = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id, 'kind', event.kind, 'shiftId', event.shift_id, 'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((select correction.replacement_time from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and not correction.voided and correction.replacement_time is not null order by correction.approved_at desc limit 1), event.recorded_at),
    'clientRecordedAt', event.client_recorded_at, 'source', event.source,
    'voided', exists (select 1 from public.time_event_corrections correction where correction.time_event_id = event.id and correction.approved_at is not null and correction.voided)
  ) order by event.recorded_at desc), '[]'::jsonb) into recent_events
  from public.time_events event
  where event.employee_id = viewer_employee_id and (event.recorded_at at time zone 'America/Denver')::date = target_date;

  select count(*)::integer into pending_correction_count
  from public.time_event_corrections correction join public.time_events event on event.id = correction.time_event_id
  where event.employee_id = viewer_employee_id and correction.approved_at is null;

  return jsonb_build_object(
    'serverTimestamp', server_now, 'operationalDate', target_date, 'operationalTimeZone', 'America/Denver',
    'employee', jsonb_build_object('id', employee_record.id, 'username', employee_record.username,
      'displayName', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
      'role', employee_record.role, 'employmentType', employee_record.employment_type, 'timeZone', employee_record.time_zone),
    'lastEvent', last_event, 'eligibleShifts', eligible_shifts, 'recentEvents', recent_events,
    'pendingCorrectionCount', pending_correction_count
  );
end
$$;

revoke all on function public.get_timekeeping_dashboard(date) from public, anon;
grant execute on function public.get_timekeeping_dashboard(date) to authenticated;

create or replace function private.prevent_dispatch_phone_time_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shift_id is not null and exists (
    select 1 from public.shifts shift
    where shift.id = new.shift_id and private.shift_assignment_type(shift.id) = 'dispatch_phone_duty'
  ) then
    raise check_violation using message = 'Dispatch phone duty is a concurrent responsibility and does not create a separate time-clock session.';
  end if;
  return new;
end
$$;

drop trigger if exists time_events_prevent_dispatch_phone_session on public.time_events;
create trigger time_events_prevent_dispatch_phone_session
before insert or update of shift_id on public.time_events
for each row execute function private.prevent_dispatch_phone_time_event();

revoke all on function private.prevent_dispatch_phone_time_event() from public, anon, authenticated;

create or replace function private.prevent_dispatch_phone_missing_clock_exception()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.exception_code = 'missing_clock_in'
    and (tg_op = 'INSERT' or new.status = 'unresolved')
    and exists (
    select 1 from public.shifts shift where shift.id = new.shift_id and private.shift_assignment_type(shift.id) = 'dispatch_phone_duty'
  ) then return null; end if;
  return new;
end
$$;

drop trigger if exists prevent_dispatch_phone_missing_clock_exception on public.timekeeping_operational_exceptions;
create trigger prevent_dispatch_phone_missing_clock_exception
before insert or update on public.timekeeping_operational_exceptions
for each row execute function private.prevent_dispatch_phone_missing_clock_exception();

revoke all on function private.prevent_dispatch_phone_missing_clock_exception() from public, anon, authenticated;

update public.timekeeping_operational_exceptions exception
set status = 'resolved', resolution_method = 'dispatch_phone_duty',
    resolution_note = 'Resolved automatically because Dispatch phone duty does not require a separate time-clock session.',
    resolved_at = coalesce(exception.resolved_at, clock_timestamp()), updated_at = clock_timestamp()
from public.shifts shift
where shift.id = exception.shift_id
  and private.shift_assignment_type(shift.id) = 'dispatch_phone_duty'
  and exception.exception_code = 'missing_clock_in'
  and exception.status = 'unresolved';

update public.operational_alerts alert
set active = false, lifecycle_state = 'resolved', cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
    clear_source = 'automatic_resolution',
    cleared_reason = 'Dispatch phone duty does not require a separate time-clock session.'
from public.timekeeping_operational_exceptions exception
join public.shifts shift on shift.id = exception.shift_id
where alert.related_record_type = 'timekeeping_operational_exception'
  and alert.related_record_id = exception.id
  and private.shift_assignment_type(shift.id) = 'dispatch_phone_duty'
  and alert.active;

create or replace function public.get_shift_assignment_type_map(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  selected_schedule_id uuid;
  can_view_all boolean;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  can_view_all := public.has_any_effective_permission(array['schedule.view', 'scheduler.view', 'scheduler.manage', 'schedule.manage', 'schedule.publish']);

  select schedule.id into selected_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (schedule.status = 'published' or (schedule.status = 'draft' and can_view_all))
  order by case when can_view_all and schedule.status = 'draft' then 0 when schedule.status = 'published' then 1 else 2 end, schedule.revision desc
  limit 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object('shiftId', shift.id, 'assignmentType', private.shift_assignment_type(shift.id)) order by shift.starts_at, shift.id)
    from public.shifts shift
    where shift.schedule_id = selected_schedule_id and shift.canceled_at is null
      and (can_view_all or exists (
        select 1 from public.shift_assignments assignment
        where assignment.shift_id = shift.id and assignment.employee_id = actor_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
      ))
  ), '[]'::jsonb);
end
$$;

revoke all on function public.get_shift_assignment_type_map(date) from public, anon;
grant execute on function public.get_shift_assignment_type_map(date) to authenticated;

create or replace function private.scheduled_overtime_preview(target_shift_id uuid, target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  local_shift_date date;
  week_start date;
  week_end date;
  current_minutes integer := 0;
  proposed_minutes integer := 0;
  resulting_minutes integer := 0;
begin
  if target_shift_id is null or target_employee_id is null then raise check_violation using message = 'Choose a shift and an employee before calculating scheduled overtime.'; end if;
  select * into target_shift from public.shifts where id = target_shift_id and canceled_at is null;
  if target_shift.id is null then raise check_violation using message = 'The selected shift could not be found.'; end if;
  select * into target_schedule from public.schedules where id = target_shift.schedule_id;
  if not exists (select 1 from public.employees where id = target_employee_id and status = 'active') then raise check_violation using message = 'The selected employee is not active.'; end if;

  local_shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;
  week_start := local_shift_date - extract(dow from local_shift_date)::integer;
  week_end := week_start + 6;
  proposed_minutes := case when private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty' then 0 else greatest(0, round(extract(epoch from (target_shift.ends_at - target_shift.starts_at)) / 60.0)::integer) end;

  select coalesce(sum(greatest(0, round(extract(epoch from (shift.ends_at - shift.starts_at)) / 60.0)::integer)), 0)::integer
  into current_minutes
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  where assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed') and assignment.canceled_at is null
    and shift.schedule_id = target_schedule.id and shift.id <> target_shift.id and shift.canceled_at is null
    and private.shift_assignment_type(shift.id) = 'standard'
    and (shift.starts_at at time zone shift.time_zone)::date between week_start and week_end;

  resulting_minutes := current_minutes + proposed_minutes;
  return jsonb_build_object('employeeId', target_employee_id, 'shiftId', target_shift.id,
    'weekStartsOn', week_start::text, 'weekEndsOn', week_end::text,
    'currentMinutes', current_minutes, 'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes, 'overtimeMinutes', greatest(0, resulting_minutes - 2400),
    'requiresOverride', resulting_minutes > 2400, 'concurrentDispatchDuty', private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty');
end
$$;

create or replace function private.scheduled_overtime_update_preview(
  target_shift_id uuid, target_employee_id uuid, shift_operational_date date,
  shift_start_time time, shift_end_time time
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  proposed_starts_at timestamptz;
  proposed_ends_at timestamptz;
  week_start date;
  week_end date;
  current_minutes integer := 0;
  proposed_minutes integer := 0;
  resulting_minutes integer := 0;
  approval_carried_forward boolean := false;
begin
  if target_shift_id is null or target_employee_id is null or shift_operational_date is null or shift_start_time is null or shift_end_time is null then raise check_violation using message = 'Choose a valid shift, employee, date, start time, and end time.'; end if;
  select * into target_shift from public.shifts where id = target_shift_id and canceled_at is null;
  if target_shift.id is null then raise check_violation using message = 'The selected shift could not be found.'; end if;
  select * into target_schedule from public.schedules where id = target_shift.schedule_id;
  if not exists (select 1 from public.employees where id = target_employee_id and status = 'active') then raise check_violation using message = 'The selected employee is not active.'; end if;

  proposed_starts_at := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
  proposed_ends_at := ((case when shift_end_time <= shift_start_time then shift_operational_date + 1 else shift_operational_date end) + shift_end_time) at time zone target_shift.time_zone;
  week_start := shift_operational_date - extract(dow from shift_operational_date)::integer;
  week_end := week_start + 6;
  proposed_minutes := case when private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty' then 0 else greatest(0, round(extract(epoch from (proposed_ends_at - proposed_starts_at)) / 60.0)::integer) end;

  select coalesce(sum(greatest(0, round(extract(epoch from (shift.ends_at - shift.starts_at)) / 60.0)::integer)), 0)::integer
  into current_minutes
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  where assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed') and assignment.canceled_at is null
    and shift.schedule_id = target_schedule.id and shift.id <> target_shift.id and shift.canceled_at is null
    and private.shift_assignment_type(shift.id) = 'standard'
    and (shift.starts_at at time zone shift.time_zone)::date between week_start and week_end;

  resulting_minutes := current_minutes + proposed_minutes;
  approval_carried_forward := private.shift_assignment_type(target_shift.id) = 'standard' and target_shift.starts_at = proposed_starts_at and target_shift.ends_at = proposed_ends_at
    and exists (select 1 from public.shift_assignments where shift_id = target_shift.id and employee_id = target_employee_id and status in ('assigned', 'confirmed', 'completed') and canceled_at is null)
    and exists (select 1 from public.schedule_assignment_overrides where shift_id = target_shift.id and employee_id = target_employee_id and override_kind = 'scheduled_overtime');

  return jsonb_build_object('employeeId', target_employee_id, 'shiftId', target_shift.id,
    'weekStartsOn', week_start::text, 'weekEndsOn', week_end::text,
    'currentMinutes', current_minutes, 'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes, 'overtimeMinutes', greatest(0, resulting_minutes - 2400),
    'requiresOverride', resulting_minutes > 2400 and not approval_carried_forward,
    'approvalCarriedForward', approval_carried_forward, 'concurrentDispatchDuty', private.shift_assignment_type(target_shift.id) = 'dispatch_phone_duty');
end
$$;

create or replace function private.scheduled_overtime_create_preview(
  target_week_starts_on date, target_employee_id uuid, target_post_id uuid, event_time_zone text,
  shift_operational_dates date[], shift_start_time time, shift_end_time time, use_employee_time_zone boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_schedule public.schedules%rowtype;
  employee_time_zone text;
  proposed_time_zone text;
  week_start date := target_week_starts_on;
  week_end date := target_week_starts_on + 6;
  current_minutes integer := 0;
  proposed_minutes integer := 0;
  resulting_minutes integer := 0;
  counted_shifts jsonb := '[]'::jsonb;
  proposed_dispatch_duty boolean := false;
begin
  if target_week_starts_on is null or target_employee_id is null or shift_operational_dates is null or cardinality(shift_operational_dates) = 0 or shift_start_time is null or shift_end_time is null then raise check_violation using message = 'Choose a week, employee, dates, start time, and end time.'; end if;
  select time_zone into employee_time_zone from public.employees where id = target_employee_id and status = 'active';
  if employee_time_zone is null then raise check_violation using message = 'The selected employee is not active or does not have a supported time zone.'; end if;

  if target_post_id is not null then
    select site.time_zone, site.supports_dispatch_phone_duty into proposed_time_zone, proposed_dispatch_duty
    from public.posts post join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  else proposed_time_zone := nullif(btrim(coalesce(event_time_zone, '')), ''); end if;
  if coalesce(use_employee_time_zone, false) then proposed_time_zone := employee_time_zone; end if;
  if proposed_time_zone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = proposed_time_zone) then raise check_violation using message = 'The schedule time zone could not be determined.'; end if;
  if exists (select 1 from unnest(shift_operational_dates) proposed_date where proposed_date is null or proposed_date not between week_start and week_end) then raise check_violation using message = 'Every proposed shift date must be inside the selected Sunday–Saturday week.'; end if;

  select * into target_schedule from public.schedules
  where week_starts_on = target_week_starts_on
  order by case status when 'draft' then 0 when 'published' then 1 when 'superseded' then 2 else 3 end, revision desc limit 1;

  if target_schedule.id is not null then
    select coalesce(sum(counted.minutes), 0)::integer,
      coalesce(jsonb_agg(jsonb_build_object('shiftId', counted.shift_id, 'startsAt', counted.starts_at,
        'endsAt', counted.ends_at, 'timeZone', counted.time_zone, 'location', counted.location,
        'minutes', counted.minutes) order by counted.starts_at, counted.shift_id), '[]'::jsonb)
    into current_minutes, counted_shifts
    from (
      select distinct shift.id shift_id, shift.starts_at, shift.ends_at, shift.time_zone,
        coalesce(site.name || ' / ' || post.name, nullif(event.location_name, ''), event.name, 'Scheduled shift') location,
        greatest(0, round(extract(epoch from (shift.ends_at - shift.starts_at)) / 60.0)::integer) minutes
      from public.shift_assignments assignment join public.shifts shift on shift.id = assignment.shift_id
      left join public.posts post on post.id = shift.post_id left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where assignment.employee_id = target_employee_id and assignment.status in ('assigned', 'confirmed', 'completed')
        and assignment.canceled_at is null and shift.schedule_id = target_schedule.id and shift.canceled_at is null
        and private.shift_assignment_type(shift.id) = 'standard'
        and (shift.starts_at at time zone shift.time_zone)::date between week_start and week_end
    ) counted;
  end if;

  if not proposed_dispatch_duty then
    select coalesce(sum(greatest(0, round(extract(epoch from ((((proposed_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone proposed_time_zone) - ((proposed_date + shift_start_time) at time zone proposed_time_zone))) / 60.0)::integer)), 0)::integer
    into proposed_minutes from (select distinct unnest(shift_operational_dates) proposed_date) dates;
  end if;
  resulting_minutes := current_minutes + proposed_minutes;

  return jsonb_build_object('employeeId', target_employee_id, 'weekStartsOn', week_start::text, 'weekEndsOn', week_end::text,
    'currentMinutes', current_minutes, 'proposedMinutes', proposed_minutes, 'resultingMinutes', resulting_minutes,
    'overtimeMinutes', greatest(0, resulting_minutes - 2400), 'requiresOverride', resulting_minutes > 2400,
    'countedShifts', counted_shifts, 'concurrentDispatchDuty', proposed_dispatch_duty);
end
$$;

revoke all on function private.scheduled_overtime_preview(uuid, uuid) from public, anon, authenticated;
revoke all on function private.scheduled_overtime_update_preview(uuid, uuid, date, time, time) from public, anon, authenticated;
revoke all on function private.scheduled_overtime_create_preview(date, uuid, uuid, text, date[], time, time, boolean) from public, anon, authenticated;

do $$
declare baseline concurrent_dispatch_release_baseline%rowtype;
begin
  select * into baseline from concurrent_dispatch_release_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.shift_count <> (select count(*) from public.shifts)
    or baseline.assignment_count <> (select count(*) from public.shift_assignments)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.time_event_fingerprint <> (select md5(coalesce(string_agg(concat_ws(':', event.id::text, event.employee_id::text, coalesce(event.shift_id::text, ''), event.kind::text, event.recorded_at::text), '|' order by event.id), '')) from public.time_events event)
  then raise exception 'Concurrent Dispatch release altered protected employee, shift, assignment, or time-event history.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

begin;

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
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required for timekeeping.';
  end if;

  if not (
    public.has_effective_permission('time.self.view')
    or public.has_effective_permission('time.punch')
    or public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
  ) then
    raise insufficient_privilege using message = 'Time clock access is required for timekeeping.';
  end if;

  select
    employee.id,
    employee.username,
    employee.first_name,
    employee.last_name,
    employee.preferred_name,
    employee.role,
    employee.employment_type
  into employee_record
  from public.employees employee
  where employee.id = viewer_employee_id;

  select jsonb_build_object(
    'id', event.id,
    'kind', event.kind,
    'shiftId', event.shift_id,
    'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided = false
        and correction.replacement_time is not null
      order by correction.approved_at desc
      limit 1
    ), event.recorded_at),
    'source', event.source
  )
  into last_event
  from public.time_events event
  where event.employee_id = viewer_employee_id
    and not exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided
    )
  order by coalesce((
    select correction.replacement_time
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
      and correction.approved_at is not null
      and correction.voided = false
      and correction.replacement_time is not null
    order by correction.approved_at desc
    limit 1
  ), event.recorded_at) desc, event.created_at desc
  limit 1;

  with ranked_eligible_shifts as (
    select
      assignment.id as assignment_id,
      assignment.status,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.is_overtime,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, event.name) as location_name,
      row_number() over (
        partition by
          coalesce(shift.post_id, shift.event_id),
          shift.starts_at,
          shift.ends_at,
          shift.time_zone,
          shift.requires_armed,
          shift.is_overtime
        order by
          case assignment.status when 'confirmed' then 0 else 1 end,
          assignment.assigned_at,
          assignment.id
      ) as duplicate_rank
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where assignment.employee_id = viewer_employee_id
      and assignment.status in ('assigned', 'confirmed')
      and schedule.status = 'published'
      and shift.starts_at <= server_now + interval '12 hours'
      and shift.ends_at >= server_now - interval '6 hours'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', shift.assignment_id,
    'shiftId', shift.shift_id,
    'status', shift.status,
    'startsAt', shift.starts_at,
    'endsAt', shift.ends_at,
    'timeZone', shift.time_zone,
    'requiresArmed', shift.requires_armed,
    'isOvertime', shift.is_overtime,
    'postName', shift.post_name,
    'siteName', shift.site_name,
    'siteCode', shift.site_code,
    'eventName', shift.event_name,
    'locationName', shift.location_name
  ) order by shift.starts_at), '[]'::jsonb)
  into eligible_shifts
  from ranked_eligible_shifts shift
  where shift.duplicate_rank = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id,
    'kind', event.kind,
    'shiftId', event.shift_id,
    'recordedAt', event.recorded_at,
    'effectiveAt', coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided = false
        and correction.replacement_time is not null
      order by correction.approved_at desc
      limit 1
    ), event.recorded_at),
    'clientRecordedAt', event.client_recorded_at,
    'source', event.source,
    'voided', exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided
    )
  ) order by event.recorded_at desc), '[]'::jsonb)
  into recent_events
  from public.time_events event
  where event.employee_id = viewer_employee_id
    and (event.recorded_at at time zone 'America/Denver')::date = target_date;

  select count(*)::integer
  into pending_correction_count
  from public.time_event_corrections correction
  join public.time_events event on event.id = correction.time_event_id
  where event.employee_id = viewer_employee_id
    and correction.approved_at is null;

  return jsonb_build_object(
    'serverTimestamp', server_now,
    'operationalDate', target_date,
    'operationalTimeZone', 'America/Denver',
    'employee', jsonb_build_object(
      'id', employee_record.id,
      'username', employee_record.username,
      'displayName', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
      'role', employee_record.role,
      'employmentType', employee_record.employment_type
    ),
    'lastEvent', last_event,
    'eligibleShifts', eligible_shifts,
    'recentEvents', recent_events,
    'pendingCorrectionCount', pending_correction_count
  );
end;
$$;

revoke all on function public.get_timekeeping_dashboard(date) from public, anon;
grant execute on function public.get_timekeeping_dashboard(date) to authenticated;

comment on function public.get_timekeeping_dashboard(date) is
  'Returns employee time status with clock-in choices limited to published assigned shifts inside the active punch window.';

notify pgrst, 'reload schema';

commit;

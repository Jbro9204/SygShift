begin;

create or replace function public.get_time_maintenance_shift_options(
  target_from_date date,
  target_through_date date,
  target_employee_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  options_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Time maintenance access with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time maintenance shift option ranges are limited to 46 days.';
  end if;

  with assigned_summary as (
    select
      assignment.shift_id,
      coalesce(jsonb_agg(
        jsonb_build_object(
          'employeeId', employee.id,
          'name', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
          'username', employee.username
        )
        order by employee.last_name, employee.first_name
      ) filter (where assignment.id is not null), '[]'::jsonb) as assigned_employees,
      bool_or(assignment.employee_id = target_employee_id and assignment.status in ('assigned', 'confirmed', 'completed')) as selected_employee_assigned
    from public.shift_assignments assignment
    join public.employees employee on employee.id = assignment.employee_id
    where assignment.status in ('assigned', 'confirmed', 'completed')
    group by assignment.shift_id
  ),
  shift_rows as (
    select
      shift.id as shift_id,
      post.site_id,
      shift.post_id,
      shift.event_id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.is_overtime,
      shift.headcount_required,
      schedule.status as schedule_status,
      schedule.revision as schedule_revision,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled Location') as location_name,
      coalesce(assigned_summary.assigned_employees, '[]'::jsonb) as assigned_employees,
      coalesce(assigned_summary.selected_employee_assigned, false) as selected_employee_assigned,
      (
        ((shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date)::text
        || '|'
        || case when shift.event_id is not null then 'event' else 'post' end
        || '|'
        || lower(regexp_replace(btrim(coalesce(site.code, '')), '[^a-z0-9]+', '', 'g'))
        || '|'
        || lower(regexp_replace(btrim(coalesce(site.name, '')), '[^a-z0-9]+', '', 'g'))
        || '|'
        || lower(regexp_replace(btrim(coalesce(post.name, '')), '[^a-z0-9]+', '', 'g'))
        || '|'
        || lower(regexp_replace(btrim(coalesce(schedule_event.name, '')), '[^a-z0-9]+', '', 'g'))
        || '|'
        || lower(regexp_replace(btrim(coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, '')), '[^a-z0-9]+', '', 'g'))
        || '|'
        || shift.requires_armed::text
      ) as location_identity
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    left join assigned_summary on assigned_summary.shift_id = shift.id
    where schedule.status in ('draft', 'published')
      and (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date <= target_through_date
      and (shift.ends_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date >= target_from_date
  ),
  ranked_shift_rows as (
    select
      shift_rows.*,
      row_number() over (
        partition by shift_rows.location_identity
        order by
          case shift_rows.schedule_status when 'published' then 0 else 1 end,
          shift_rows.selected_employee_assigned desc,
          shift_rows.schedule_revision desc,
          shift_rows.starts_at,
          shift_rows.shift_id
      ) as location_rank
    from shift_rows
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shiftId', shift_id,
    'siteId', site_id,
    'postId', post_id,
    'eventId', event_id,
    'startsAt', starts_at,
    'endsAt', ends_at,
    'timeZone', time_zone,
    'requiresArmed', requires_armed,
    'isOvertime', is_overtime,
    'headcountRequired', headcount_required,
    'scheduleStatus', schedule_status,
    'scheduleRevision', schedule_revision,
    'siteName', site_name,
    'siteCode', site_code,
    'postName', post_name,
    'eventName', event_name,
    'locationName', location_name,
    'assignedEmployees', assigned_employees,
    'selectedEmployeeAssigned', selected_employee_assigned
  ) order by
    (starts_at at time zone coalesce(time_zone, 'America/Denver'))::date,
    coalesce(site_code, ''),
    coalesce(site_name, location_name),
    coalesce(post_name, event_name, location_name)
  ), '[]'::jsonb)
  into options_payload
  from ranked_shift_rows
  where location_rank = 1;

  return options_payload;
end
$$;

create or replace function public.get_team_attendance_summary(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  operational_time_zone text := 'America/Denver';
  rows_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Team Attendance permission with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Team Attendance ranges are limited to 46 days.';
  end if;

  with latest_correction as (
    select distinct on (correction.time_event_id)
      correction.time_event_id,
      correction.replacement_time,
      correction.voided,
      correction.approved_at
    from public.time_event_corrections correction
    where correction.approved_at is not null
    order by correction.time_event_id, correction.approved_at desc, correction.id desc
  ),
  latest_shift_override as (
    select distinct on (shift_override.time_event_id)
      shift_override.time_event_id,
      shift_override.shift_id
    from public.time_event_shift_overrides shift_override
    order by shift_override.time_event_id, shift_override.created_at desc, shift_override.id desc
  ),
  effective_events as (
    select
      time_event.id,
      time_event.employee_id,
      coalesce(latest_shift_override.shift_id, time_event.shift_id) as shift_id,
      time_event.kind,
      time_event.recorded_at,
      coalesce(latest_correction.replacement_time, time_event.recorded_at) as effective_at,
      coalesce(latest_correction.voided, false) as voided
    from public.time_events time_event
    left join latest_correction on latest_correction.time_event_id = time_event.id
    left join latest_shift_override on latest_shift_override.time_event_id = time_event.id
  ),
  range_events as (
    select *
    from effective_events time_event
    where not time_event.voided
      and (time_event.effective_at at time zone operational_time_zone)::date between target_from_date and target_through_date
  ),
  latest_event as (
    select distinct on (time_event.employee_id)
      time_event.employee_id,
      time_event.kind as latest_kind,
      time_event.effective_at as latest_effective_at,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled') as latest_location_name,
      site.name as latest_site_name,
      site.code as latest_site_code,
      post.name as latest_post_name,
      schedule_event.name as latest_event_name,
      coalesce(shift.time_zone, operational_time_zone) as latest_time_zone
    from range_events time_event
    left join public.shifts shift on shift.id = time_event.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    order by time_event.employee_id, time_event.effective_at desc, time_event.recorded_at desc, time_event.id desc
  ),
  event_rollup as (
    select
      time_event.employee_id,
      min(time_event.effective_at) filter (where time_event.kind = 'clock_in') as first_clock_in,
      max(time_event.effective_at) filter (where time_event.kind = 'clock_out') as last_clock_out,
      count(*)::integer as event_count
    from range_events time_event
    group by time_event.employee_id
  ),
  scheduled_rows as (
    select
      assignment.employee_id,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, operational_time_zone) as time_zone,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Scheduled location') as location_name,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      schedule_event.name as event_name
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where assignment.status in ('assigned', 'confirmed', 'completed')
      and schedule.status = 'published'
      and not exists (
        select 1
        from public.schedules newer_schedule
        where newer_schedule.week_starts_on = schedule.week_starts_on
          and newer_schedule.status = 'published'
          and newer_schedule.revision > schedule.revision
      )
      and (shift.starts_at at time zone coalesce(shift.time_zone, operational_time_zone))::date <= target_through_date
      and (shift.ends_at at time zone coalesce(shift.time_zone, operational_time_zone))::date >= target_from_date
  ),
  scheduled_count as (
    select
      scheduled_rows.employee_id,
      count(distinct scheduled_rows.shift_id)::integer as scheduled_shift_count
    from scheduled_rows
    group by scheduled_rows.employee_id
  ),
  scheduled_first as (
    select distinct on (scheduled_rows.employee_id)
      scheduled_rows.employee_id,
      scheduled_rows.starts_at as scheduled_starts_at,
      scheduled_rows.ends_at as scheduled_ends_at,
      scheduled_rows.location_name as scheduled_location_name,
      scheduled_rows.site_name as scheduled_site_name,
      scheduled_rows.site_code as scheduled_site_code,
      scheduled_rows.post_name as scheduled_post_name,
      scheduled_rows.event_name as scheduled_event_name,
      scheduled_rows.time_zone as scheduled_time_zone
    from scheduled_rows
    order by scheduled_rows.employee_id, scheduled_rows.starts_at, scheduled_rows.shift_id
  ),
  pending_correction_scope as (
    select distinct time_event.employee_id
    from public.time_event_corrections correction
    join public.time_events time_event on time_event.id = correction.time_event_id
    where correction.approved_at is null
      and correction.declined_at is null
      and (
        coalesce(correction.replacement_time, time_event.recorded_at) at time zone operational_time_zone
      )::date between target_from_date and target_through_date
  ),
  employees_in_scope as (
    select employee_id from event_rollup
    union
    select employee_id from scheduled_count
    union
    select employee_id from pending_correction_scope
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', employee.id,
    'username', employee.username,
    'employeeName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'latestKind', latest_event.latest_kind,
    'latestEffectiveAt', latest_event.latest_effective_at,
    'latestLocationName', latest_event.latest_location_name,
    'latestSiteName', latest_event.latest_site_name,
    'latestSiteCode', latest_event.latest_site_code,
    'latestPostName', latest_event.latest_post_name,
    'latestEventName', latest_event.latest_event_name,
    'latestTimeZone', coalesce(latest_event.latest_time_zone, operational_time_zone),
    'firstClockIn', event_rollup.first_clock_in,
    'lastClockOut', event_rollup.last_clock_out,
    'eventCount', coalesce(event_rollup.event_count, 0),
    'scheduledShiftCount', coalesce(scheduled_count.scheduled_shift_count, 0),
    'scheduledStartsAt', scheduled_first.scheduled_starts_at,
    'scheduledEndsAt', scheduled_first.scheduled_ends_at,
    'scheduledLocationName', scheduled_first.scheduled_location_name,
    'scheduledSiteName', scheduled_first.scheduled_site_name,
    'scheduledSiteCode', scheduled_first.scheduled_site_code,
    'scheduledPostName', scheduled_first.scheduled_post_name,
    'scheduledEventName', scheduled_first.scheduled_event_name,
    'scheduledTimeZone', coalesce(scheduled_first.scheduled_time_zone, operational_time_zone)
  ) order by employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into rows_payload
  from employees_in_scope scope
  join public.employees employee on employee.id = scope.employee_id
  left join latest_event on latest_event.employee_id = employee.id
  left join event_rollup on event_rollup.employee_id = employee.id
  left join scheduled_count on scheduled_count.employee_id = employee.id
  left join scheduled_first on scheduled_first.employee_id = employee.id
  where employee.status in ('active', 'leave')
    and employee.username is not null;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', operational_time_zone,
    'rows', rows_payload
  );
end
$$;

do $patch_time_maintenance_employee_scope$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_time_maintenance(date, date, uuid)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_time_maintenance(date, date, uuid) was not found.';
  end if;

  if position('where target_employee_id is not null
      and event.employee_id = target_employee_id' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      'where (target_employee_id is null or event.employee_id = target_employee_id)
      and (coalesce(latest_correction.replacement_time, event.recorded_at) at time zone ''America/Denver'')::date',
      'where target_employee_id is not null
      and event.employee_id = target_employee_id
      and (coalesce(latest_correction.replacement_time, event.recorded_at) at time zone ''America/Denver'')::date'
    );

    if position('where target_employee_id is not null
      and event.employee_id = target_employee_id' in function_sql) = 0 then
      raise check_violation using message = 'Time maintenance employee scope patch could not be applied.';
    end if;

    execute function_sql;
  end if;
end
$patch_time_maintenance_employee_scope$;

revoke all on function public.get_time_maintenance_shift_options(date, date, uuid) from public, anon;
grant execute on function public.get_time_maintenance_shift_options(date, date, uuid) to authenticated;

revoke all on function public.get_team_attendance_summary(date, date) from public, anon;
grant execute on function public.get_team_attendance_summary(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;

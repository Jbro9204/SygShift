-- Stable page payloads for Patrol and Request Center.
-- These functions keep complex schedule/request joins in the database and return
-- browser-safe JSON contracts so one relationship shape cannot break an entire page.

create or replace function public.get_patrol_coverage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  payload jsonb;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view patrol coverage.';
  end if;

  with allowed_shifts as (
    select
      shift.id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.is_open,
      shift.notes,
      post.id as post_id,
      post.name as post_name,
      site.id as site_id,
      site.code as site_code,
      site.name as site_name,
      lower(coalesce(site.name, '') || ' ' || coalesce(post.name, '') || ' ' || coalesce(shift.notes, '')) like '%patrol%' as patrol_tagged
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    where schedule.status = 'published'
      and shift.ends_at > clock_timestamp()
      and (
        viewer_role in ('supervisor', 'admin')
        or not shift.requires_armed
        or public.has_valid_credential(
          viewer_employee_id,
          'armed_guard',
          (shift.starts_at at time zone shift.time_zone)::date
        )
      )
  ),
  scoped_shifts as (
    select *
    from allowed_shifts shift
    where shift.patrol_tagged
       or not exists (select 1 from allowed_shifts tagged where tagged.patrol_tagged)
  ),
  shift_payloads as (
    select
      coalesce(shift.site_id, shift.post_id, shift.id) as route_id,
      coalesce(shift.site_name, shift.post_name, 'Patrol coverage') as route_name,
      shift.site_code as route_code,
      shift.requires_armed,
      shift.patrol_tagged,
      jsonb_build_object(
        'id', shift.id,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', shift.time_zone,
        'requiresArmed', shift.requires_armed,
        'isOpen', shift.is_open,
        'notes', shift.notes,
        'postName', coalesce(shift.post_name, 'Patrol coverage'),
        'siteName', shift.site_name,
        'assignments', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', assignment.id,
              'status', assignment.status,
              'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name
            )
            order by employee.last_name, employee.first_name
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          left join public.employees employee on employee.id = assignment.employee_id
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        )
      ) as shift_json
    from scoped_shifts shift
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', route_id,
      'name', route_name,
      'code', route_code,
      'requiresArmed', requires_armed,
      'patrolTagged', patrol_tagged,
      'upcomingShifts', shifts
    )
    order by route_name
  ), '[]'::jsonb)
  into payload
  from (
    select
      route_id,
      route_name,
      route_code,
      bool_or(requires_armed) as requires_armed,
      bool_or(patrol_tagged) as patrol_tagged,
      jsonb_agg(shift_json order by (shift_json ->> 'startsAt')) as shifts
    from shift_payloads
    group by route_id, route_name, route_code
  ) route_payloads;

  return payload;
end;
$$;

create or replace function public.get_request_center_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  privileged boolean := viewer_role in ('supervisor', 'admin');
  payload jsonb;
begin
  if viewer_employee_id is null or viewer_role is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view requests.';
  end if;

  select jsonb_build_object(
    'employeeId', viewer_employee_id,
    'role', viewer_role,
    'timeOff', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeId', request.employee_id,
        'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'startsOn', request.starts_on,
        'endsOn', request.ends_on,
        'partialDayStart', request.partial_day_start,
        'partialDayEnd', request.partial_day_end,
        'reason', request.reason,
        'status', request.status,
        'decisionNote', request.decision_note,
        'createdAt', request.created_at
      ) order by request.created_at desc), '[]'::jsonb)
      from public.time_off_requests request
      join public.employees employee on employee.id = request.employee_id
      where (privileged and request.status = 'pending')
         or (not privileged and request.employee_id = viewer_employee_id)
    ),
    'shiftRequests', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', request.id,
        'employeeId', request.employee_id,
        'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'status', request.status,
        'employeeNote', request.employee_note,
        'decisionNote', request.decision_note,
        'createdAt', request.created_at,
        'shift', jsonb_build_object(
          'id', shift.id,
          'startsAt', shift.starts_at,
          'endsAt', shift.ends_at,
          'timeZone', shift.time_zone,
          'title', coalesce(event.name, post.name, 'Assigned shift'),
          'location', coalesce(site.name, event.location_name, 'Location pending')
        )
      ) order by request.created_at desc), '[]'::jsonb)
      from public.shift_requests request
      join public.employees employee on employee.id = request.employee_id
      join public.shifts shift on shift.id = request.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where (privileged and request.status = 'pending')
         or (not privileged and request.employee_id = viewer_employee_id)
    ),
    'callOffs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', report.id,
        'employeeId', report.employee_id,
        'employeeName', coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
        'reason', report.reason,
        'reportedAt', report.reported_at,
        'acknowledgedAt', report.acknowledged_at,
        'announcementId', report.announcement_id,
        'resolvedAt', report.resolved_at,
        'shift', jsonb_build_object(
          'id', shift.id,
          'startsAt', shift.starts_at,
          'endsAt', shift.ends_at,
          'timeZone', shift.time_zone,
          'title', coalesce(event.name, post.name, 'Assigned shift'),
          'location', coalesce(site.name, event.location_name, 'Location pending')
        )
      ) order by report.reported_at desc), '[]'::jsonb)
      from public.call_off_reports report
      join public.employees employee on employee.id = report.employee_id
      join public.shifts shift on shift.id = report.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where (privileged and report.announcement_id is null and report.resolved_at is null)
         or (not privileged and report.employee_id = viewer_employee_id)
    ),
    'upcomingAssignments', (
      select case
        when privileged then '[]'::jsonb
        else coalesce(jsonb_agg(jsonb_build_object(
          'id', assignment.id,
          'status', assignment.status,
          'shift', jsonb_build_object(
            'id', shift.id,
            'startsAt', shift.starts_at,
            'endsAt', shift.ends_at,
            'timeZone', shift.time_zone,
            'title', coalesce(event.name, post.name, 'Assigned shift'),
            'location', coalesce(site.name, event.location_name, 'Location pending')
          )
        ) order by shift.starts_at), '[]'::jsonb)
      end
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      where not privileged
        and assignment.employee_id = viewer_employee_id
        and assignment.status in ('assigned', 'confirmed')
        and shift.ends_at > clock_timestamp()
    )
  )
  into payload;

  return payload;
end;
$$;

revoke all on function public.get_patrol_coverage() from public, anon;
revoke all on function public.get_request_center_payload() from public, anon;
grant execute on function public.get_patrol_coverage() to authenticated;
grant execute on function public.get_request_center_payload() to authenticated;

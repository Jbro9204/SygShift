begin;

set local lock_timeout = '5s';

-- PostgreSQL boolean comparisons against a null latest event return null.
-- The workspace contract requires a concrete boolean so the browser can render
-- every unconfirmed shift, including shifts that have never had an event.
create or replace function public.get_salaried_shift_workspace(
  range_starts_on date default null,
  range_ends_on date default null,
  requested_employee_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_record public.employees%rowtype;
  local_today date;
  target_starts_on date;
  target_ends_on date;
begin
  if actor_id is null
    or not public.has_effective_permission('schedule.salary_shifts.manage')
  then
    raise insufficient_privilege using message = 'MFA-verified salaried shift access is required.';
  end if;

  select employee.* into actor_record
  from public.employees employee
  where employee.id = actor_id;

  if actor_record.id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  local_today := (clock_timestamp() at time zone actor_record.time_zone)::date;
  target_starts_on := coalesce(range_starts_on, local_today - 30);
  target_ends_on := coalesce(range_ends_on, local_today);

  if target_ends_on < target_starts_on then
    raise check_violation using message = 'The end date must be on or after the start date.';
  end if;
  if target_ends_on - target_starts_on > 92 then
    raise check_violation using message = 'Choose a date range of 93 days or fewer.';
  end if;
  if requested_employee_id is not null and not exists (
    select 1
    from public.employees employee
    where employee.id = requested_employee_id
      and employee.employment_type = 'salary'
  ) then
    raise check_violation using message = 'Choose a salaried employee.';
  end if;

  return (
    with current_assignments as (
      select distinct on (
        assignment.employee_id,
        schedule.week_starts_on,
        shift.post_id,
        shift.event_id,
        shift.starts_at,
        shift.ends_at
      )
        assignment.id as assignment_id,
        assignment.employee_id,
        assignment.status as assignment_status,
        assignment.updated_at as assignment_updated_at,
        shift.id as shift_id,
        shift.starts_at,
        shift.ends_at,
        shift.time_zone as shift_time_zone,
        schedule.week_starts_on,
        schedule.status as schedule_status,
        employee.employee_number,
        btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) as employee_name,
        employee.time_zone as employee_time_zone,
        post_site.code as site_code,
        coalesce(post_site.name, event_site.name) as site_name,
        post.name as post_name,
        event.name as event_name,
        coalesce(post_site.name, event_site.name, event.location_name, 'Location pending') as location,
        case
          when coalesce(post_site.supports_dispatch_phone_duty, event_site.supports_dispatch_phone_duty, false)
            then 'dispatch_primary'
          else 'standard'
        end as assignment_type
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      join public.employees employee on employee.id = assignment.employee_id
      left join public.posts post on post.id = shift.post_id
      left join public.sites post_site on post_site.id = post.site_id
      left join public.events event on event.id = shift.event_id
      left join public.sites event_site on event_site.id = event.site_id
      where schedule.status = 'published'
        and assignment.status in ('assigned', 'confirmed', 'completed')
        and assignment.canceled_at is null
        and shift.canceled_at is null
        and employee.employment_type = 'salary'
        and private.shift_assignment_type(shift.id) <> 'dispatch_phone_duty'
        and (shift.starts_at at time zone shift.time_zone)::date
          between target_starts_on and target_ends_on
        and (requested_employee_id is null or assignment.employee_id = requested_employee_id)
        and not private.salaried_shift_assignment_is_absent(assignment.id)
        and not private.salaried_shift_assignment_has_approved_time_off(assignment.id)
      order by
        assignment.employee_id,
        schedule.week_starts_on,
        shift.post_id,
        shift.event_id,
        shift.starts_at,
        shift.ends_at,
        schedule.revision desc,
        assignment.id
    ), assignment_rows as (
      select
        current_assignment.*,
        latest_event.id as latest_event_id,
        latest_event.action as latest_action,
        latest_event.note as latest_note,
        latest_event.created_at as latest_created_at,
        latest_event.actor_employee_id,
        latest_event.actor_name,
        coalesce(history.events, '[]'::jsonb) as history
      from current_assignments current_assignment
      left join lateral (
        select
          event.id,
          event.action,
          event.note,
          event.actor_employee_id,
          event.created_at,
          btrim(coalesce(nullif(actor.preferred_name, ''), actor.first_name) || ' ' || actor.last_name) as actor_name
        from private.salaried_shift_presence_events event
        join private.salaried_shift_equivalent_assignments(current_assignment.assignment_id) equivalent
          on equivalent.assignment_id = event.shift_assignment_id
        join public.employees actor on actor.id = event.actor_employee_id
        order by event.created_at desc, event.id desc
        limit 1
      ) latest_event on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'id', event.id,
          'action', event.action,
          'note', event.note,
          'actor', jsonb_build_object(
            'id', actor.id,
            'displayName', btrim(coalesce(nullif(actor.preferred_name, ''), actor.first_name) || ' ' || actor.last_name)
          ),
          'recordedAt', event.created_at
        ) order by event.created_at, event.id) as events
        from private.salaried_shift_presence_events event
        join private.salaried_shift_equivalent_assignments(current_assignment.assignment_id) equivalent
          on equivalent.assignment_id = event.shift_assignment_id
        join public.employees actor on actor.id = event.actor_employee_id
      ) history on true
    )
    select jsonb_build_object(
      'generatedAt', clock_timestamp(),
      'range', jsonb_build_object(
        'startsOn', target_starts_on,
        'endsOn', target_ends_on
      ),
      'viewer', jsonb_build_object(
        'employeeId', actor_record.id,
        'timeZone', actor_record.time_zone,
        'employmentType', actor_record.employment_type::text,
        'canManage', true
      ),
      'filters', jsonb_build_object('employeeId', requested_employee_id),
      'summary', jsonb_build_object(
        'total', (select count(*) from assignment_rows row where row.ends_at <= clock_timestamp()),
        'worked', (select count(*) from assignment_rows row where row.latest_action = 'worked'),
        'unconfirmed', (
          select count(*)
          from assignment_rows row
          where row.ends_at <= clock_timestamp()
            and row.latest_action is distinct from 'worked'
        )
      ),
      'employees', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', employee.id,
          'employeeNumber', employee.employee_number,
          'displayName', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
          'timeZone', employee.time_zone
        ) order by employee.last_name, employee.first_name, employee.id)
        from public.employees employee
        where employee.employment_type = 'salary'
          and employee.status in ('active', 'leave')
      ), '[]'::jsonb),
      'assignments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'assignmentId', row.assignment_id,
          'shiftId', row.shift_id,
          'employee', jsonb_build_object(
            'id', row.employee_id,
            'employeeNumber', row.employee_number,
            'displayName', row.employee_name,
            'timeZone', row.employee_time_zone
          ),
          'startsAt', row.starts_at,
          'endsAt', row.ends_at,
          'shiftTimeZone', row.shift_time_zone,
          'employeeTimeZone', row.employee_time_zone,
          'workday', (row.starts_at at time zone row.shift_time_zone)::date,
          'scheduleStatus', row.schedule_status::text,
          'assignmentStatus', row.assignment_status::text,
          'assignmentType', row.assignment_type,
          'siteCode', row.site_code,
          'siteName', row.site_name,
          'postName', row.post_name,
          'eventName', row.event_name,
          'location', row.location,
          'presenceStatus', case when row.latest_action = 'worked' then 'worked' else 'unconfirmed' end,
          'workedAt', case when row.latest_action = 'worked' then row.latest_created_at end,
          'recordedNote', case when row.latest_action = 'worked' then row.latest_note end,
          'recordedBy', case when row.latest_action = 'worked' then jsonb_build_object(
            'id', row.actor_employee_id,
            'displayName', row.actor_name
          ) end,
          'updatedAt', row.latest_created_at,
          'canMarkWorked', row.ends_at <= clock_timestamp() and row.latest_action is distinct from 'worked',
          'canVoid', coalesce(row.latest_action = 'worked', false),
          'blockingReason', case
            when row.latest_action = 'worked' then 'already_worked'
            when row.ends_at > clock_timestamp() then 'shift_not_ended'
            else null
          end,
          'history', row.history
        ) order by row.starts_at desc, row.employee_name, row.assignment_id)
        from assignment_rows row
      ), '[]'::jsonb)
    )
  );
end
$$;

comment on function public.get_salaried_shift_workspace(date, date, uuid) is
  'Returns the permission-gated salaried shift confirmation workspace with concrete boolean action flags and no worked-time, duration, payroll, or overtime fields.';

commit;

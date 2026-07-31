begin;

create or replace function public.get_payroll_accountability_events(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role;
  events_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select employee.role into actor_role
  from public.employees employee
  where employee.id = actor_id;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'Payroll accountability review requires MFA.';
  end if;

  if not (
    actor_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
    or public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
    or public.has_effective_permission('accountability.view')
  ) then
    raise insufficient_privilege using message = 'Payroll accountability review is not available for this account.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid payroll date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Payroll accountability ranges are limited to 46 days.';
  end if;

  with accountability_rows as (
    select
      account_event.id,
      'attendance_accountability_events'::text as source_table,
      account_event.event_type,
      account_event.status,
      account_event.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
      employee.role::text as role,
      employee.employment_type::text as employment_type,
      account_event.operational_date,
      account_event.starts_at,
      account_event.ends_at,
      coalesce(shift.time_zone, 'America/Denver') as time_zone,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, 'Date-only report') as location_name,
      account_event.note,
      account_event.created_at
    from public.attendance_accountability_events account_event
    join public.employees employee on employee.id = account_event.employee_id
    left join public.shifts shift on shift.id = account_event.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where account_event.operational_date between target_from_date and target_through_date
      and account_event.status <> 'voided'
  ),
  legacy_call_off_rows as (
    select
      report.id,
      'call_off_reports'::text as source_table,
      case
        when report.reason ilike 'called in sick:%' then 'called_in_sick'
        when report.reason ilike '%sick%' then 'called_in_sick'
        else 'call_off'
      end as event_type,
      case when report.resolved_at is not null then 'resolved' else 'reported' end as status,
      report.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
      employee.role::text as role,
      employee.employment_type::text as employment_type,
      (shift.starts_at at time zone shift.time_zone)::date as operational_date,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, 'Shift') as location_name,
      coalesce(report.reason, 'Call-off reported.') as note,
      report.reported_at as created_at
    from public.call_off_reports report
    join public.employees employee on employee.id = report.employee_id
    join public.shifts shift on shift.id = report.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where (shift.starts_at at time zone shift.time_zone)::date between target_from_date and target_through_date
      and not exists (
        select 1
        from public.attendance_accountability_events account_event
        where account_event.call_off_report_id = report.id
      )
  ),
  time_off_rows as (
    select
      request.id,
      'time_off_requests'::text as source_table,
      case
        when request.reason ilike '%sick%' then 'called_in_sick'
        when request.reason ilike '%vacation%' then 'vacation'
        else 'vacation'
      end as event_type,
      request.status::text as status,
      request.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
      employee.role::text as role,
      employee.employment_type::text as employment_type,
      greatest(request.starts_on, target_from_date) as operational_date,
      null::timestamptz as starts_at,
      null::timestamptz as ends_at,
      'America/Denver'::text as time_zone,
      null::text as site_name,
      null::text as site_code,
      null::text as post_name,
      null::text as event_name,
      'Time off'::text as location_name,
      coalesce(request.reason, 'Approved time off.') as note,
      request.created_at
    from public.time_off_requests request
    join public.employees employee on employee.id = request.employee_id
    where request.status in ('pending', 'approved')
      and daterange(request.starts_on, request.ends_on, '[]') && daterange(target_from_date, target_through_date, '[]')
  ),
  combined as (
    select * from accountability_rows
    union all
    select * from legacy_call_off_rows
    union all
    select * from time_off_rows
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', combined.id,
    'sourceTable', combined.source_table,
    'eventType', combined.event_type,
    'status', combined.status,
    'employeeId', combined.employee_id,
    'employeeName', combined.employee_name,
    'username', combined.username,
    'role', combined.role,
    'employmentType', combined.employment_type,
    'operationalDate', combined.operational_date,
    'startsAt', combined.starts_at,
    'endsAt', combined.ends_at,
    'timeZone', combined.time_zone,
    'siteName', combined.site_name,
    'siteCode', combined.site_code,
    'postName', combined.post_name,
    'eventName', combined.event_name,
    'locationName', combined.location_name,
    'note', combined.note,
    'createdAt', combined.created_at
  ) order by combined.operational_date, combined.employee_name, combined.created_at), '[]'::jsonb)
  into events_payload
  from combined;

  return events_payload;
end
$$;

revoke all on function public.get_payroll_accountability_events(date, date) from public, anon;
grant execute on function public.get_payroll_accountability_events(date, date) to authenticated;

notify pgrst, 'reload schema';

commit;

begin;

create table if not exists public.attendance_accountability_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  call_off_report_id uuid references public.call_off_reports(id) on delete restrict,
  event_type text not null,
  status text not null default 'reported',
  operational_date date not null,
  starts_at timestamptz,
  ends_at timestamptz,
  source text not null default 'employee',
  note text not null,
  created_by uuid references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  decision_note text,
  dispatch_notified_at timestamptz,
  dispatch_notification_error text,
  constraint attendance_accountability_event_type_check
    check (event_type in ('called_in_sick', 'call_off', 'vacation', 'no_call_no_show', 'late_arrival', 'early_departure', 'other')),
  constraint attendance_accountability_status_check
    check (status in ('reported', 'acknowledged', 'resolved', 'voided')),
  constraint attendance_accountability_source_check
    check (source in ('employee', 'dispatcher', 'scheduler', 'supervisor', 'admin', 'system')),
  constraint attendance_accountability_note_present check (btrim(note) <> ''),
  constraint attendance_accountability_note_length check (char_length(note) <= 2000),
  constraint attendance_accountability_window_order check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index if not exists attendance_accountability_employee_date_idx
  on public.attendance_accountability_events(employee_id, operational_date desc);

create index if not exists attendance_accountability_shift_idx
  on public.attendance_accountability_events(shift_id)
  where shift_id is not null;

create index if not exists attendance_accountability_payroll_range_idx
  on public.attendance_accountability_events(operational_date, event_type, status);

alter table public.attendance_accountability_events enable row level security;

drop policy if exists attendance_accountability_self_select on public.attendance_accountability_events;
create policy attendance_accountability_self_select
on public.attendance_accountability_events
for select
to authenticated
using (
  employee_id = public.current_employee_id()
  or (
    public.has_mfa()
    and (
      public.is_supervisor_or_admin()
      or public.current_app_role() in ('dispatcher', 'scheduler', 'recruiting_licensing')
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
    )
  )
);

insert into public.permission_catalog (code, category, name, description, risk_level, requires_mfa, locked, active)
values
  ('accountability.view', 'Accountability', 'View accountability events', 'View sick, call-off, vacation, and attendance accountability items.', 'sensitive', true, true, true),
  ('accountability.create', 'Accountability', 'Create accountability events', 'Create sick, call-off, and attendance accountability items.', 'sensitive', true, true, true),
  ('accountability.manage', 'Accountability', 'Manage accountability events', 'Resolve, void, and report accountability events for payroll and operations.', 'critical', true, true, true)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = now();

with role_permissions_seed(role_code, permission_code) as (
  values
    ('system_guard', 'accountability.create'),
    ('system_dispatcher', 'accountability.view'),
    ('system_dispatcher', 'accountability.create'),
    ('system_dispatcher', 'accountability.manage'),
    ('system_scheduler', 'accountability.view'),
    ('system_scheduler', 'accountability.create'),
    ('system_scheduler', 'accountability.manage'),
    ('system_recruiting_licensing', 'accountability.view'),
    ('system_supervisor', 'accountability.view'),
    ('system_supervisor', 'accountability.create'),
    ('system_supervisor', 'accountability.manage')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, seed.permission_code, true
from role_permissions_seed seed
join public.access_roles access_role on access_role.code = seed.role_code
join public.permission_catalog permission on permission.code = seed.permission_code
on conflict (role_id, permission_code) do update
set enabled = true, updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, permission.code, true
from public.access_roles access_role
cross join public.permission_catalog permission
where access_role.code = 'system_admin'
  and permission.code in ('accountability.view', 'accountability.create', 'accountability.manage')
on conflict (role_id, permission_code) do update
set enabled = true, updated_at = now();

create or replace function public.report_attendance_accountability_event(
  target_shift_id uuid default null,
  target_event_type text default 'called_in_sick',
  target_operational_date date default null,
  target_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reporter_id uuid := private.current_employee_id();
  reporter_record public.employees%rowtype;
  clean_event_type text := btrim(coalesce(target_event_type, ''));
  clean_note text := btrim(coalesce(target_note, ''));
  operational_today date := (clock_timestamp() at time zone 'America/Denver')::date;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  shift_time_zone text := 'America/Denver';
  shift_requires_armed boolean := false;
  shift_post_name text;
  shift_site_name text;
  shift_site_code text;
  shift_event_name text;
  shift_event_location_name text;
  inserted_event public.attendance_accountability_events%rowtype;
  call_off_id uuid;
begin
  if reporter_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select *
  into reporter_record
  from public.employees employee
  where employee.id = reporter_id
    and employee.status in ('active', 'leave', 'onboarding');

  if reporter_record.id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if clean_event_type not in ('called_in_sick', 'call_off') then
    raise check_violation using message = 'Employees can report only sick or call-off attendance events.';
  end if;

  if clean_note = '' then
    raise check_violation using message = 'A short note is required.';
  end if;

  if char_length(clean_note) > 2000 then
    raise check_violation using message = 'The note exceeds 2,000 characters.';
  end if;

  if target_shift_id is not null then
    select
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      post.name,
      site.name,
      site.code,
      event.name,
      event.location_name
    into
      shift_starts_at,
      shift_ends_at,
      shift_time_zone,
      shift_requires_armed,
      shift_post_name,
      shift_site_name,
      shift_site_code,
      shift_event_name,
      shift_event_location_name
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where assignment.shift_id = target_shift_id
      and assignment.employee_id = reporter_id
      and assignment.status in ('assigned', 'confirmed')
      and shift.ends_at > clock_timestamp() - interval '2 hours'
    order by shift.starts_at
    limit 1;

    if shift_starts_at is null then
      raise check_violation using message = 'Only a current or upcoming assigned shift can be reported from this screen.';
    end if;
  elsif target_operational_date is null then
    raise check_violation using message = 'Choose a shift or date for this attendance report.';
  elsif target_operational_date < operational_today then
    raise check_violation using message = 'Employees can report sick or call-off only for today or a future date.';
  end if;

  insert into public.attendance_accountability_events (
    employee_id,
    shift_id,
    event_type,
    status,
    operational_date,
    starts_at,
    ends_at,
    source,
    note,
    created_by
  ) values (
    reporter_id,
    target_shift_id,
    clean_event_type,
    'reported',
    coalesce(target_operational_date, (shift_starts_at at time zone coalesce(shift_time_zone, 'America/Denver'))::date),
    shift_starts_at,
    shift_ends_at,
    'employee',
    clean_note,
    reporter_id
  )
  returning * into inserted_event;

  if target_shift_id is not null then
    insert into public.call_off_reports (shift_id, employee_id, reason)
    values (
      target_shift_id,
      reporter_id,
      case clean_event_type
        when 'called_in_sick' then 'Called in sick: ' || clean_note
        else clean_note
      end
    )
    on conflict (shift_id, employee_id) do update
    set
      reason = excluded.reason,
      updated_at = clock_timestamp()
    returning id into call_off_id;

    update public.attendance_accountability_events
    set call_off_report_id = call_off_id,
        updated_at = clock_timestamp()
    where id = inserted_event.id
    returning * into inserted_event;
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    reporter_id,
    'public',
    'attendance_accountability_events',
    'INSERT',
    inserted_event.id::text,
    jsonb_build_object(
      'eventType', inserted_event.event_type,
      'employeeId', inserted_event.employee_id,
      'shiftId', inserted_event.shift_id,
      'operationalDate', inserted_event.operational_date
    )
  );

  return jsonb_build_object(
    'id', inserted_event.id,
    'callOffId', call_off_id,
    'employeeId', reporter_id,
    'employeeName', btrim(coalesce(reporter_record.preferred_name, reporter_record.first_name) || ' ' || reporter_record.last_name),
    'username', reporter_record.username,
    'eventType', inserted_event.event_type,
    'status', inserted_event.status,
    'operationalDate', inserted_event.operational_date,
    'shiftId', inserted_event.shift_id,
    'startsAt', inserted_event.starts_at,
    'endsAt', inserted_event.ends_at,
    'timeZone', coalesce(shift_time_zone, 'America/Denver'),
    'siteName', shift_site_name,
    'siteCode', shift_site_code,
    'postName', shift_post_name,
    'eventName', shift_event_name,
    'locationName', coalesce(shift_event_location_name, shift_site_name, shift_post_name, 'Date-only report'),
    'note', inserted_event.note,
    'createdAt', inserted_event.created_at,
    'dispatchTo', 'dispatch@guardianshipsecurity.net'
  );
end
$$;

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
      'call_off'::text as event_type,
      case when report.resolved_at is not null then 'resolved' else 'reported' end as status,
      report.employee_id,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.username,
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

create or replace function public.service_mark_attendance_accountability_dispatch_result(
  target_event_id uuid,
  delivered boolean,
  delivery_error text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;

  update public.attendance_accountability_events
  set
    dispatch_notified_at = case when delivered then clock_timestamp() else dispatch_notified_at end,
    dispatch_notification_error = case when delivered then null else left(coalesce(delivery_error, 'Email delivery failed.'), 500) end,
    updated_at = clock_timestamp()
  where id = target_event_id;

  return found;
end
$$;

revoke all on function public.report_attendance_accountability_event(uuid, text, date, text) from public, anon;
revoke all on function public.get_payroll_accountability_events(date, date) from public, anon;
revoke all on function public.service_mark_attendance_accountability_dispatch_result(uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.report_attendance_accountability_event(uuid, text, date, text) to authenticated;
grant execute on function public.get_payroll_accountability_events(date, date) to authenticated;
grant execute on function public.service_mark_attendance_accountability_dispatch_result(uuid, boolean, text) to service_role;

notify pgrst, 'reload schema';

commit;

begin;

create temporary table supervisor_scope_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from public.employee_access_roles) as access_assignment_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee.id::text, employee.username, employee.role::text, employee.status::text, employee.employment_type::text, employee.time_zone), '|' order by employee.id)), md5('')) from public.employees employee) as employee_fingerprint,
  (select coalesce(md5(string_agg(concat_ws(':', event.id::text, event.employee_id::text, event.kind::text, event.recorded_at::text), '|' order by event.id)), md5('')) from public.time_events event) as time_event_fingerprint;

create table private.employee_supervisor_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null unique references public.employees(id) on delete restrict,
  supervisor_employee_id uuid not null references public.employees(id) on delete restrict,
  assigned_by uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  assigned_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employee_supervisor_not_self check (employee_id <> supervisor_employee_id),
  constraint employee_supervisor_reason_present check (char_length(btrim(reason)) between 8 and 1000)
);

create index employee_supervisor_assignments_supervisor_idx
  on private.employee_supervisor_assignments(supervisor_employee_id, employee_id);

create trigger set_employee_supervisor_assignments_updated_at
before update on private.employee_supervisor_assignments
for each row execute function private.set_updated_at();

alter table private.employee_supervisor_assignments enable row level security;
revoke all on table private.employee_supervisor_assignments from public, anon, authenticated;

create function private.is_supervisor_assignment_candidate(target_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status in ('active', 'leave')
      and (
        employee.role in ('supervisor', 'admin')
        or exists (
          select 1
          from public.employee_access_roles assignment
          join public.access_roles access_role on access_role.id = assignment.role_id
          where assignment.employee_id = employee.id
            and access_role.active
            and access_role.code in ('operations_manager', 'human_resources')
        )
      )
  )
$$;

revoke all on function private.is_supervisor_assignment_candidate(uuid) from public, anon, authenticated;

create function public.get_supervision_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_is_admin boolean := false;
  default_scope text := 'all';
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to view workforce supervision.';
  end if;

  if not (
    public.has_effective_permission('directory.view')
    or public.has_effective_permission('directory.edit_basic')
    or public.has_effective_permission('hr.people.view')
    or public.has_effective_permission('hr.people.manage')
  ) then
    raise insufficient_privilege using message = 'Workforce or HR People permission is required.';
  end if;

  select employee.role = 'admin' or exists (
    select 1
    from public.employee_access_roles assignment
    join public.access_roles access_role on access_role.id = assignment.role_id
    where assignment.employee_id = actor_id
      and access_role.active
      and access_role.code = 'system_admin'
  ) into actor_is_admin
  from public.employees employee
  where employee.id = actor_id;

  if not actor_is_admin and exists (
    select 1 from private.employee_supervisor_assignments assignment
    where assignment.supervisor_employee_id = actor_id
  ) then
    default_scope := 'mine';
  end if;

  return jsonb_build_object(
    'viewerEmployeeId', actor_id,
    'defaultScope', default_scope,
    'canManage', public.has_effective_permission('hr.people.manage'),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', assignment.employee_id,
        'supervisorEmployeeId', assignment.supervisor_employee_id,
        'supervisorName', concat_ws(' ', supervisor.first_name, nullif(supervisor.middle_name, ''), supervisor.last_name),
        'assignedAt', assignment.assigned_at
      ) order by employee.last_name, employee.first_name, employee.id)
      from private.employee_supervisor_assignments assignment
      join public.employees employee on employee.id = assignment.employee_id
      join public.employees supervisor on supervisor.id = assignment.supervisor_employee_id
      where employee.status in ('active', 'leave')
    ), '[]'::jsonb),
    'supervisors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', employee.id,
        'name', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
        'employeeNumber', employee.employee_number,
        'jobTitle', employee.job_title
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      where private.is_supervisor_assignment_candidate(employee.id)
    ), '[]'::jsonb)
  );
end
$$;

create function public.update_employee_supervisor_assignment(
  target_employee_id uuid,
  target_supervisor_employee_id uuid,
  target_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_editor(false);
  clean_reason text := btrim(coalesce(target_reason, ''));
  old_assignment private.employee_supervisor_assignments%rowtype;
  changed_at timestamptz := clock_timestamp();
begin
  if clean_reason = '' or char_length(clean_reason) < 8 or char_length(clean_reason) > 1000 then
    raise check_violation using message = 'A reason of 8 to 1,000 characters is required.';
  end if;

  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  select assignment.* into old_assignment
  from private.employee_supervisor_assignments assignment
  where assignment.employee_id = target_employee_id
  for update;

  if old_assignment.supervisor_employee_id is not distinct from target_supervisor_employee_id then
    raise check_violation using message = 'No supervisor assignment change was entered.';
  end if;

  if target_supervisor_employee_id is not null then
    if target_supervisor_employee_id = target_employee_id then
      raise check_violation using message = 'An employee cannot be assigned as their own supervisor.';
    end if;
    if not private.is_supervisor_assignment_candidate(target_supervisor_employee_id) then
      raise check_violation using message = 'Choose an active Supervisor, Operations Manager, Human Resources Manager, or Admin.';
    end if;

    insert into private.employee_supervisor_assignments(
      employee_id, supervisor_employee_id, assigned_by, reason, assigned_at, updated_at
    ) values (
      target_employee_id, target_supervisor_employee_id, actor_id, clean_reason, changed_at, changed_at
    )
    on conflict (employee_id) do update set
      supervisor_employee_id = excluded.supervisor_employee_id,
      assigned_by = excluded.assigned_by,
      reason = excluded.reason,
      assigned_at = excluded.assigned_at,
      updated_at = excluded.updated_at;
  else
    delete from private.employee_supervisor_assignments assignment
    where assignment.employee_id = target_employee_id;
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), actor_id, 'private', 'employee_supervisor_assignments', 'UPDATE_SUPERVISOR_ASSIGNMENT', target_employee_id::text,
    case when old_assignment.id is null then null else jsonb_build_object(
      'supervisorEmployeeId', old_assignment.supervisor_employee_id,
      'assignedAt', old_assignment.assigned_at
    ) end,
    jsonb_build_object(
      'supervisorEmployeeId', target_supervisor_employee_id,
      'reason', clean_reason,
      'changedAt', changed_at
    )
  );

  return public.get_supervision_workspace();
end
$$;

create function public.record_supervision_exception_access(
  target_employee_id uuid,
  target_source text default 'workforce'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_source text := left(coalesce(nullif(btrim(target_source), ''), 'workforce'), 80);
  actor_is_admin boolean := false;
begin
  if actor_id is null or not public.has_mfa() then
    raise insufficient_privilege using message = 'An MFA-verified employee account is required.';
  end if;
  if not (
    public.has_effective_permission('directory.view')
    or public.has_effective_permission('directory.edit_basic')
    or public.has_effective_permission('hr.people.view')
    or public.has_effective_permission('hr.people.manage')
  ) then
    raise insufficient_privilege using message = 'Workforce or HR People permission is required.';
  end if;
  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'Employee record not found.';
  end if;

  select employee.role = 'admin' or exists (
    select 1 from public.employee_access_roles assignment
    join public.access_roles access_role on access_role.id = assignment.role_id
    where assignment.employee_id = actor_id and access_role.active and access_role.code = 'system_admin'
  ) into actor_is_admin
  from public.employees employee where employee.id = actor_id;

  if actor_is_admin
    or not exists (select 1 from private.employee_supervisor_assignments assignment where assignment.supervisor_employee_id = actor_id)
    or exists (select 1 from private.employee_supervisor_assignments assignment where assignment.supervisor_employee_id = actor_id and assignment.employee_id = target_employee_id) then
    return false;
  end if;

  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values (
    (select auth.uid()), actor_id, 'public', 'employees', 'VIEW_OUTSIDE_ASSIGNED_TEAM', target_employee_id::text,
    jsonb_build_object('source', clean_source, 'viewedAt', clock_timestamp())
  );
  return true;
end
$$;

create function public.get_live_time_roster()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  server_time timestamptz := clock_timestamp();
  rows_payload jsonb;
  working_count integer;
  break_count integer;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if not public.has_mfa() or not (
    public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
  ) then
    raise insufficient_privilege using message = 'Team Time permission with MFA is required.';
  end if;

  with latest_correction as (
    select distinct on (correction.time_event_id)
      correction.time_event_id, correction.replacement_time, correction.voided
    from public.time_event_corrections correction
    where correction.approved_at is not null
    order by correction.time_event_id, correction.approved_at desc, correction.id desc
  ), latest_shift_override as (
    select distinct on (override_record.time_event_id)
      override_record.time_event_id, override_record.shift_id
    from public.time_event_shift_overrides override_record
    order by override_record.time_event_id, override_record.created_at desc, override_record.id desc
  ), effective_events as (
    select
      event.id,
      event.employee_id,
      event.kind,
      coalesce(correction.replacement_time, event.recorded_at) as effective_at,
      coalesce(shift_override.shift_id, event.shift_id) as shift_id
    from public.time_events event
    left join latest_correction correction on correction.time_event_id = event.id
    left join latest_shift_override shift_override on shift_override.time_event_id = event.id
    where not coalesce(correction.voided, false)
  ), latest_event as (
    select distinct on (event.employee_id) event.*
    from effective_events event
    order by event.employee_id, event.effective_at desc, event.id desc
  ), active_events as (
    select event.*
    from latest_event event
    where event.kind in ('clock_in', 'break_start', 'break_end')
  ), roster as (
    select
      employee.id as employee_id,
      employee.username,
      btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.role,
      employee.employment_type,
      case when active.kind = 'break_start' then 'on_break' else 'working' end as live_status,
      session_start.clocked_in_at,
      active.effective_at as status_since,
      greatest(floor(extract(epoch from (server_time - session_start.clocked_in_at)) / 60), 0)::integer as elapsed_minutes,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled') as location_name,
      site.name as site_name,
      site.code as site_code,
      post.name as post_name,
      schedule_event.name as event_name,
      coalesce(shift.time_zone, employee.time_zone, 'America/Denver') as time_zone,
      shift.ends_at as scheduled_ends_at,
      supervisor.id as supervisor_id,
      concat_ws(' ', supervisor.first_name, nullif(supervisor.middle_name, ''), supervisor.last_name) as supervisor_name
    from active_events active
    join public.employees employee on employee.id = active.employee_id
    join lateral (
      select max(candidate.effective_at) as clocked_in_at
      from effective_events candidate
      where candidate.employee_id = active.employee_id
        and candidate.kind = 'clock_in'
        and candidate.effective_at <= active.effective_at
    ) session_start on session_start.clocked_in_at is not null
    left join public.shifts shift on shift.id = active.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    left join private.employee_supervisor_assignments supervision on supervision.employee_id = employee.id
    left join public.employees supervisor on supervisor.id = supervision.supervisor_employee_id
    where employee.status in ('active', 'leave')
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employeeId', roster.employee_id,
      'username', roster.username,
      'employeeName', roster.employee_name,
      'role', roster.role,
      'employmentType', roster.employment_type,
      'status', roster.live_status,
      'clockedInAt', roster.clocked_in_at,
      'statusSince', roster.status_since,
      'elapsedMinutes', roster.elapsed_minutes,
      'locationName', roster.location_name,
      'siteName', roster.site_name,
      'siteCode', roster.site_code,
      'postName', roster.post_name,
      'eventName', roster.event_name,
      'timeZone', roster.time_zone,
      'scheduledEndsAt', roster.scheduled_ends_at,
      'assignedSupervisor', case when roster.supervisor_id is null then null else jsonb_build_object('employeeId', roster.supervisor_id, 'name', roster.supervisor_name) end
    ) order by case when roster.live_status = 'working' then 0 else 1 end, roster.employee_name, roster.employee_id), '[]'::jsonb),
    count(*) filter (where roster.live_status = 'working')::integer,
    count(*) filter (where roster.live_status = 'on_break')::integer
  into rows_payload, working_count, break_count
  from roster;

  return jsonb_build_object(
    'serverTimestamp', server_time,
    'totalCount', coalesce(working_count, 0) + coalesce(break_count, 0),
    'workingCount', coalesce(working_count, 0),
    'breakCount', coalesce(break_count, 0),
    'rows', rows_payload
  );
end
$$;

revoke all on function public.get_supervision_workspace() from public, anon;
revoke all on function public.update_employee_supervisor_assignment(uuid, uuid, text) from public, anon;
revoke all on function public.record_supervision_exception_access(uuid, text) from public, anon;
revoke all on function public.get_live_time_roster() from public, anon;

grant execute on function public.get_supervision_workspace() to authenticated;
grant execute on function public.update_employee_supervisor_assignment(uuid, uuid, text) to authenticated;
grant execute on function public.record_supervision_exception_access(uuid, text) to authenticated;
grant execute on function public.get_live_time_roster() to authenticated;

do $$
declare
  baseline supervisor_scope_release_baseline%rowtype;
begin
  select * into strict baseline from supervisor_scope_release_baseline;
  if (select count(*) from public.employees) <> baseline.employee_count
    or (select count(*) from public.shifts) <> baseline.shift_count
    or (select count(*) from public.time_events) <> baseline.time_event_count
    or (select count(*) from public.employee_access_roles) <> baseline.access_assignment_count
    or (select count(*) from public.employee_permission_overrides) <> baseline.permission_override_count
    or (select coalesce(md5(string_agg(concat_ws(':', employee.id::text, employee.username, employee.role::text, employee.status::text, employee.employment_type::text, employee.time_zone), '|' order by employee.id)), md5('')) from public.employees employee) <> baseline.employee_fingerprint
    or (select coalesce(md5(string_agg(concat_ws(':', event.id::text, event.employee_id::text, event.kind::text, event.recorded_at::text), '|' order by event.id)), md5('')) from public.time_events event) <> baseline.time_event_fingerprint then
    raise exception 'Supervisor-scope release changed protected workforce, access, schedule, or time data.';
  end if;
  if exists (select 1 from private.employee_supervisor_assignments) then
    raise exception 'Supervisor-scope release must not infer or auto-create reporting relationships.';
  end if;
end
$$;

comment on table private.employee_supervisor_assignments is
  'One explicit primary supervisor per employee. Employee-based reporting scope is intentionally independent from site/post scheduling and permission authorization.';
comment on function public.get_live_time_roster() is
  'Returns only employees whose latest effective, non-voided time event leaves an open clock session.';

notify pgrst, 'reload schema';

commit;

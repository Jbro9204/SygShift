set search_path = '';

create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin'), false)
$$;

create or replace function public.get_session_context()
returns table (
  employee_id uuid,
  username text,
  display_name text,
  role public.app_role,
  must_change_password boolean,
  password_changed_at timestamptz,
  mfa_enrolled_at timestamptz,
  mfa_required boolean,
  has_mfa boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise insufficient_privilege
      using message = 'A signed-in SygShift account is required.';
  end if;

  return query
  select
    employee.id,
    employee.username,
    coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name,
    employee.role,
    account.must_change_password,
    account.password_changed_at,
    account.mfa_enrolled_at,
    employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin') as mfa_required,
    public.has_mfa()
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;
end
$$;

create or replace function public.decide_time_off_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  request_record public.time_off_requests%rowtype;
begin
  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to decide time off.';
  end if;
  if target_decision not in ('approved', 'declined') then
    raise check_violation using message = 'Time off can only be approved or declined.';
  end if;
  if target_decision = 'declined' and btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A decline note is required.';
  end if;
  if char_length(coalesce(target_note, '')) > 2000 then
    raise check_violation using message = 'The decision note exceeds 2,000 characters.';
  end if;

  select * into request_record
  from public.time_off_requests request
  where request.id = target_request_id and request.status = 'pending'
  for update;

  if not found then
    raise check_violation using message = 'The time-off request is no longer pending.';
  end if;

  update public.time_off_requests
  set
    status = target_decision,
    decided_by = reviewer_id,
    decided_at = clock_timestamp(),
    decision_note = nullif(btrim(target_note), '')
  where id = request_record.id;

  return true;
end
$$;

create or replace function public.admin_upsert_employee_credential(
  target_employee_id uuid,
  target_kind public.credential_kind,
  target_status public.credential_status,
  target_credential_number text default null,
  target_valid_from date default null,
  target_expires_on date default null,
  target_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  credential_id uuid;
begin
  actor_id := private.require_admin_mfa();

  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'The employee record was not found.';
  end if;
  if target_expires_on is not null and target_valid_from is not null and target_expires_on < target_valid_from then
    raise check_violation using message = 'Credential expiration cannot be before the valid-from date.';
  end if;
  if target_kind = 'armed_guard'
    and target_status = 'active'
    and (nullif(btrim(coalesce(target_credential_number, '')), '') is null or target_expires_on is null or target_expires_on < current_date)
  then
    raise check_violation using message = 'An active armed credential requires a number and a current expiration date.';
  end if;

  select credential.id into credential_id
  from public.employee_credentials credential
  where credential.employee_id = target_employee_id
    and credential.kind = target_kind
  order by credential.created_at desc
  limit 1;

  if credential_id is null then
    insert into public.employee_credentials (
      employee_id,
      kind,
      status,
      credential_number,
      valid_from,
      expires_on,
      verified_at,
      verified_by,
      notes
    ) values (
      target_employee_id,
      target_kind,
      target_status,
      nullif(btrim(coalesce(target_credential_number, '')), ''),
      target_valid_from,
      target_expires_on,
      case when target_status = 'active' then clock_timestamp() else null end,
      case when target_status = 'active' then actor_id else null end,
      nullif(btrim(coalesce(target_notes, '')), '')
    );
  else
    update public.employee_credentials
    set
      status = target_status,
      credential_number = nullif(btrim(coalesce(target_credential_number, '')), ''),
      valid_from = target_valid_from,
      expires_on = target_expires_on,
      verified_at = case when target_status = 'active' then coalesce(verified_at, clock_timestamp()) else verified_at end,
      verified_by = case when target_status = 'active' then coalesce(verified_by, actor_id) else verified_by end,
      notes = nullif(btrim(coalesce(target_notes, '')), '')
    where id = credential_id;
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
    actor_id,
    'public',
    'employee_credentials',
    'ADMIN_UPSERT',
    target_employee_id::text,
    private.admin_user_record(target_employee_id)
  );

  return private.admin_user_record(target_employee_id);
end
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
  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
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
      where ((privileged and request.status = 'pending') or (not privileged and request.employee_id = viewer_employee_id))
        and shift.ends_at > clock_timestamp()
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
      where ((privileged and report.announcement_id is null and report.resolved_at is null)
         or (not privileged and report.employee_id = viewer_employee_id))
        and shift.ends_at > clock_timestamp()
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

create or replace function public.get_open_opportunities_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
  payload jsonb;
begin
  if viewer_employee_id is null or viewer_role is null then
    raise insufficient_privilege using message = 'An active employee account is required to view openings.';
  end if;

  select jsonb_build_object(
    'employeeId', viewer_employee_id,
    'role', viewer_role,
    'opportunities', coalesce(jsonb_agg(jsonb_build_object(
      'id', shift.id,
      'starts_at', shift.starts_at,
      'ends_at', shift.ends_at,
      'time_zone', shift.time_zone,
      'headcount_required', shift.headcount_required,
      'requires_armed', shift.requires_armed,
      'is_overtime', shift.is_overtime,
      'notes', shift.notes,
      'post', case when post.id is null then null else jsonb_build_object(
        'id', post.id,
        'name', post.name,
        'site', jsonb_build_object('id', site.id, 'name', site.name, 'code', site.code)
      ) end,
      'event', case when event.id is null then null else jsonb_build_object(
        'id', event.id,
        'name', event.name,
        'location_name', event.location_name,
        'site', case when event_site.id is null then null else jsonb_build_object(
          'id', event_site.id,
          'name', event_site.name,
          'code', event_site.code
        ) end
      ) end,
      'schedules', jsonb_build_object('status', schedule.status),
      'assignments', (
        select coalesce(jsonb_agg(jsonb_build_object('id', assignment.id, 'status', assignment.status)), '[]'::jsonb)
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status <> 'canceled'
      ),
      'requests', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', request.id,
          'employee_id', request.employee_id,
          'status', request.status
        )), '[]'::jsonb)
        from public.shift_requests request
        where request.shift_id = shift.id
          and (privileged or request.employee_id = viewer_employee_id)
      )
    ) order by shift.starts_at), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.is_open
    and shift.ends_at > clock_timestamp()
    and (
      privileged
      or not shift.requires_armed
      or public.has_valid_credential(
        viewer_employee_id,
        'armed_guard',
        (shift.starts_at at time zone shift.time_zone)::date
      )
    );

  return coalesce(payload, jsonb_build_object(
    'employeeId', viewer_employee_id,
    'role', viewer_role,
    'opportunities', '[]'::jsonb
  ));
end
$$;

create or replace function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  target_schedule public.schedules%rowtype;
  payload jsonb;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view the schedule.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (
      schedule.status = 'published'
      or (schedule.status = 'draft' and viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin'))
    )
  order by
    case schedule.status when 'draft' then 0 else 1 end,
    schedule.revision desc
  limit 1;

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'id', target_schedule.id,
    'week_starts_on', target_schedule.week_starts_on,
    'revision', target_schedule.revision,
    'status', target_schedule.status,
    'published_at', target_schedule.published_at,
    'shifts', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', shift.id,
        'starts_at', shift.starts_at,
        'ends_at', shift.ends_at,
        'time_zone', shift.time_zone,
        'headcount_required', shift.headcount_required,
        'requires_armed', shift.requires_armed,
        'is_open', shift.is_open,
        'is_overtime', shift.is_overtime,
        'notes', shift.notes,
        'post', case when post.id is null then null else jsonb_build_object(
          'id', post.id,
          'name', post.name,
          'site', jsonb_build_object('id', site.id, 'code', site.code, 'name', site.name)
        ) end,
        'event', case when event.id is null then null else jsonb_build_object(
          'id', event.id,
          'name', event.name,
          'location_name', event.location_name,
          'site', case when event_site.id is null then null else jsonb_build_object(
            'id', event_site.id,
            'code', event_site.code,
            'name', event_site.name
          ) end
        ) end,
        'assignments', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', assignment.id,
              'status', assignment.status,
              'employee', jsonb_build_object(
                'id', employee.id,
                'first_name', employee.first_name,
                'last_name', employee.last_name,
                'preferred_name', employee.preferred_name
              )
            )
            order by employee.last_name, employee.first_name, assignment.id
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        )
      )
      order by shift.starts_at, shift.created_at, shift.id
    ) filter (where shift.id is not null), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.schedule_id = target_schedule.id
    and (
      viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
      or not shift.requires_armed
      or public.has_valid_credential(
        viewer_employee_id,
        'armed_guard',
        (shift.starts_at at time zone shift.time_zone)::date
      )
    );

  return payload;
end;
$$;

revoke all on function public.admin_upsert_employee_credential(uuid, public.credential_kind, public.credential_status, text, date, date, text) from public, anon;
revoke all on function public.get_open_opportunities_payload() from public, anon;

grant execute on function public.admin_upsert_employee_credential(uuid, public.credential_kind, public.credential_status, text, date, date, text) to authenticated;
grant execute on function public.get_open_opportunities_payload() to authenticated;

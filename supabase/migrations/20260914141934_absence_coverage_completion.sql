begin;

-- Preserve the proven request-center implementation and add an explicit
-- permission contract for the client. The prior payload omitted this field,
-- which silently rendered managers as guards and hid the coverage action.
alter function public.get_request_center_payload()
  rename to get_request_center_payload_pre_absence_completion;
alter function public.get_request_center_payload_pre_absence_completion()
  set schema private;

revoke all on function private.get_request_center_payload_pre_absence_completion()
  from public, anon, authenticated;

create function public.get_request_center_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  viewer_role public.app_role := public.current_app_role();
begin
  payload := private.get_request_center_payload_pre_absence_completion();

  return payload || jsonb_build_object(
    'permissions', jsonb_build_object(
      'canManage', viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
    )
  );
end
$$;

revoke all on function public.get_request_center_payload() from public, anon;
grant execute on function public.get_request_center_payload() to authenticated;

-- Preserve the existing operations payload and enrich only call-off rows with
-- durable resolution state. This keeps resolved records out of the active UI
-- while leaving open-pool and patrol-review cases recoverable.
alter function public.get_timekeeping_operations_workspace(date, date)
  rename to get_timekeeping_operations_workspace_pre_absence_completion;
alter function public.get_timekeeping_operations_workspace_pre_absence_completion(date, date)
  set schema private;

revoke all on function private.get_timekeeping_operations_workspace_pre_absence_completion(date, date)
  from public, anon, authenticated;

create function public.get_timekeeping_operations_workspace(
  target_from_date date default current_date - 14,
  target_through_date date default current_date + 14
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  enriched_call_offs jsonb;
begin
  payload := private.get_timekeeping_operations_workspace_pre_absence_completion(
    target_from_date,
    target_through_date
  );

  select coalesce(
    jsonb_agg(
      call_off.item || jsonb_build_object(
        'resolvedAt', report.resolved_at,
        'coverageStatus', coverage.status
      )
      order by call_off.ordinality
    ),
    '[]'::jsonb
  )
  into enriched_call_offs
  from jsonb_array_elements(coalesce(payload -> 'callOffReports', '[]'::jsonb))
    with ordinality as call_off(item, ordinality)
  left join public.call_off_reports report
    on report.id = (call_off.item ->> 'id')::uuid
  left join public.shift_coverage_cases coverage
    on coverage.call_off_report_id = report.id;

  return jsonb_set(payload, '{callOffReports}', enriched_call_offs, true);
end
$$;

revoke all on function public.get_timekeeping_operations_workspace(date, date)
  from public, anon;
grant execute on function public.get_timekeeping_operations_workspace(date, date)
  to authenticated;

create function private.ensure_attendance_absence_call_off_report(
  target_employee_id uuid,
  target_shift_id uuid,
  target_event_type text,
  target_note text,
  target_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  report public.call_off_reports%rowtype;
  employee public.employees%rowtype;
  shift public.shifts%rowtype;
  alert_id uuid;
  created_new boolean := false;
begin
  if target_actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into employee
  from public.employees
  where id = target_employee_id and status = 'active';

  select * into shift
  from public.shifts
  where id = target_shift_id and canceled_at is null;

  if employee.id is null or shift.id is null then
    raise check_violation using message = 'Choose an active employee and scheduled shift.';
  end if;
  if not exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = shift.id
      and assignment.employee_id = employee.id
      and assignment.status <> 'canceled'
  ) then
    raise check_violation using message = 'The employee is not assigned to the selected shift.';
  end if;

  insert into public.call_off_reports (
    shift_id,
    employee_id,
    reason,
    call_received_at,
    received_by,
    reported_by,
    call_off_type,
    replacement_needed,
    operational_details
  ) values (
    shift.id,
    employee.id,
    btrim(target_note),
    clock_timestamp(),
    target_actor_id,
    target_actor_id,
    case when target_event_type = 'called_in_sick' then 'sick' else 'other' end,
    true,
    case when target_event_type = 'no_call_no_show'
      then 'Recorded as no-call / no-show in Accountability Tracker.'
      else 'Recorded as an absence in Accountability Tracker.'
    end
  )
  on conflict (shift_id, employee_id) do nothing
  returning * into report;

  created_new := report.id is not null;

  if not created_new then
    select * into report
    from public.call_off_reports existing
    where existing.shift_id = shift.id
      and existing.employee_id = employee.id
      and existing.canceled_at is null;

    if report.id is null then
      raise unique_violation using message = 'A canceled absence record already exists for this employee and shift. Maintain that record instead of creating a duplicate.';
    end if;
  end if;

  if created_new then
    insert into public.call_off_report_actions (
      call_off_report_id,
      action,
      reason,
      actor_id,
      snapshot
    ) values (
      report.id,
      'created',
      btrim(target_note),
      target_actor_id,
      to_jsonb(report)
    );
  end if;

  insert into public.operational_alerts (
    alert_type,
    priority,
    title,
    summary,
    employee_id,
    shift_id,
    related_record_type,
    related_record_id,
    audience_roles,
    direct_path,
    deduplication_key
  ) values (
    'employee_call_off',
    'urgent',
    'Employee absence — coverage review required',
    concat(
      coalesce(nullif(employee.preferred_name, ''), employee.first_name),
      ' ',
      employee.last_name,
      ' was recorded absent.'
    ),
    employee.id,
    shift.id,
    'call_off_report',
    report.id,
    array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[],
    concat('/requests?callOff=', report.id),
    concat('call-off:', report.id)
  )
  on conflict (deduplication_key) do update
    set direct_path = excluded.direct_path
  returning id into alert_id;

  return jsonb_build_object(
    'id', report.id,
    'alertId', alert_id,
    'created', created_new
  );
end
$$;

revoke all on function private.ensure_attendance_absence_call_off_report(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated;

-- Make report creation naturally idempotent by the existing shift/employee
-- unique key, route the alert into the actual coverage workspace, and return
-- the coverage requirement explicitly to the guided client.
create or replace function public.report_employee_call_off(
  target_employee_id uuid,
  target_shift_id uuid,
  target_call_off_type text,
  target_call_received_at timestamptz,
  target_reason text,
  target_notes text,
  target_replacement_needed boolean,
  target_operational_details text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('accountability.report_call_off');
  report public.call_off_reports%rowtype;
  employee public.employees%rowtype;
  shift public.shifts%rowtype;
  alert_id uuid;
  created_new boolean := false;
begin
  if target_call_off_type not in ('sick', 'other') then
    raise check_violation using message = 'Choose Sick or Other call-off.';
  end if;
  if btrim(coalesce(target_reason, '')) = '' then
    raise check_violation using message = 'A call-off reason is required.';
  end if;

  select * into employee
  from public.employees
  where id = target_employee_id and status = 'active';

  select * into shift
  from public.shifts
  where id = target_shift_id and canceled_at is null;

  if employee.id is null or shift.id is null then
    raise check_violation using message = 'Choose an active employee and scheduled shift.';
  end if;
  if not exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = shift.id
      and assignment.employee_id = employee.id
      and assignment.status <> 'canceled'
  ) then
    raise check_violation using message = 'The employee is not assigned to the selected shift.';
  end if;

  insert into public.call_off_reports (
    shift_id,
    employee_id,
    reason,
    call_received_at,
    received_by,
    reported_by,
    call_off_type,
    replacement_needed,
    operational_details
  ) values (
    shift.id,
    employee.id,
    concat(
      btrim(target_reason),
      case when btrim(coalesce(target_notes, '')) = ''
        then ''
        else E'\n\n' || btrim(target_notes)
      end
    ),
    coalesce(target_call_received_at, clock_timestamp()),
    actor_id,
    actor_id,
    target_call_off_type,
    coalesce(target_replacement_needed, true),
    nullif(btrim(coalesce(target_operational_details, '')), '')
  )
  on conflict (shift_id, employee_id) do nothing
  returning * into report;

  created_new := report.id is not null;

  if not created_new then
    select * into report
    from public.call_off_reports existing
    where existing.shift_id = shift.id
      and existing.employee_id = employee.id
      and existing.canceled_at is null;

    if report.id is null then
      raise unique_violation using message = 'A canceled call-off already exists for this employee and shift. Maintain that record instead of creating a duplicate.';
    end if;
  end if;

  if created_new then
    insert into public.call_off_report_actions (
      call_off_report_id,
      action,
      reason,
      actor_id,
      snapshot
    ) values (
      report.id,
      'created',
      btrim(target_reason),
      actor_id,
      to_jsonb(report)
    );
  end if;

  insert into public.operational_alerts (
    alert_type,
    priority,
    title,
    summary,
    employee_id,
    shift_id,
    related_record_type,
    related_record_id,
    audience_roles,
    direct_path,
    deduplication_key
  ) values (
    'employee_call_off',
    'urgent',
    'Employee call-off — coverage review required',
    concat(
      coalesce(nullif(employee.preferred_name, ''), employee.first_name),
      ' ',
      employee.last_name,
      ' reported ',
      case when target_call_off_type = 'sick' then 'sick' else 'a call-off' end,
      '.'
    ),
    employee.id,
    shift.id,
    'call_off_report',
    report.id,
    array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[],
    concat('/requests?callOff=', report.id),
    concat('call-off:', report.id)
  )
  on conflict (deduplication_key) do update
    set direct_path = excluded.direct_path
  returning id into alert_id;

  return jsonb_build_object(
    'id', report.id,
    'alertId', alert_id,
    'status', case when created_new then 'recorded' else 'already_recorded' end,
    'coverageRequired', report.replacement_needed
  );
end
$$;

revoke all on function public.report_employee_call_off(
  uuid, uuid, text, timestamptz, text, text, boolean, text
) from public, anon;
grant execute on function public.report_employee_call_off(
  uuid, uuid, text, timestamptz, text, text, boolean, text
) to authenticated;

-- Accountability is the manager-facing Attendance Tracker. An absence entered
-- there must create the same durable call-off record and then hand the UI the
-- identifier needed to finish coverage.
create or replace function public.create_attendance_accountability_event(
  target_employee_id uuid,
  target_shift_id uuid default null,
  target_event_type text default 'other',
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
  actor_id uuid := private.current_employee_id();
  actor_role text;
  employee_record public.employees%rowtype;
  clean_event_type text := btrim(coalesce(target_event_type, ''));
  clean_note text := btrim(coalesce(target_note, ''));
  shift_id_value uuid;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  shift_time_zone text := 'America/Denver';
  event_record public.attendance_accountability_events%rowtype;
  source_value text := 'authorized_user';
  call_off_result jsonb;
  call_off_id uuid;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() or not public.has_effective_permission('accountability.create') then
    raise insufficient_privilege using message = 'Accountability event creation permission with MFA is required.';
  end if;

  if target_employee_id is null then
    raise check_violation using message = 'Choose an employee.';
  end if;

  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active';

  if employee_record.id is null then
    raise check_violation using message = 'Choose an active employee.';
  end if;

  if clean_event_type not in (
    'called_in_sick',
    'call_off',
    'no_call_no_show',
    'late_arrival',
    'early_departure',
    'other'
  ) then
    raise check_violation using message = 'Choose a supported operational occurrence.';
  end if;

  if char_length(clean_note) < 4 then
    raise check_violation using message = 'Enter a brief factual note.';
  end if;

  if char_length(clean_note) > 2000 then
    raise check_violation using message = 'The note exceeds 2,000 characters.';
  end if;

  if target_shift_id is not null then
    select
      shift.id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver')
    into shift_id_value, shift_starts_at, shift_ends_at, shift_time_zone
    from public.shifts shift
    join public.schedules schedule
      on schedule.id = shift.schedule_id
     and schedule.status = 'published'
    join public.shift_assignments assignment
      on assignment.shift_id = shift.id
     and assignment.employee_id = target_employee_id
     and assignment.status in ('assigned', 'confirmed')
    where shift.id = target_shift_id
      and shift.canceled_at is null
    limit 1;

    if shift_id_value is null then
      raise check_violation using message = 'Choose a published shift assigned to this employee.';
    end if;
  elsif clean_event_type <> 'other' then
    raise check_violation using message = 'Attendance occurrences must be tied to a scheduled shift.';
  elsif target_operational_date is null then
    raise check_violation using message = 'Choose an operational date.';
  end if;

  select employee.role::text into actor_role
  from public.employees employee
  where employee.id = actor_id;

  if actor_role in ('dispatcher', 'scheduler', 'supervisor', 'admin') then
    source_value := actor_role;
  end if;

  if target_shift_id is not null
     and clean_event_type <> 'other'
     and exists (
       select 1
       from public.attendance_accountability_events existing
       where existing.employee_id = target_employee_id
         and existing.shift_id = target_shift_id
         and existing.event_type = clean_event_type
         and existing.status <> 'voided'
     ) then
    raise unique_violation using message = 'This occurrence is already recorded for the selected employee and shift.';
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
    target_employee_id,
    target_shift_id,
    clean_event_type,
    'reported',
    coalesce(target_operational_date, (shift_starts_at at time zone shift_time_zone)::date),
    shift_starts_at,
    shift_ends_at,
    source_value,
    clean_note,
    actor_id
  )
  returning * into event_record;

  if clean_event_type in ('called_in_sick', 'call_off', 'no_call_no_show') then
    call_off_result := private.ensure_attendance_absence_call_off_report(
      target_employee_id,
      target_shift_id,
      clean_event_type,
      clean_note,
      actor_id
    );
    call_off_id := (call_off_result ->> 'id')::uuid;

    update public.attendance_accountability_events
    set call_off_report_id = call_off_id,
        updated_at = clock_timestamp()
    where id = event_record.id
    returning * into event_record;
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
    auth.uid(),
    actor_id,
    'public',
    'attendance_accountability_events',
    'INSERT',
    event_record.id::text,
    jsonb_build_object(
      'employeeId', event_record.employee_id,
      'shiftId', event_record.shift_id,
      'eventType', event_record.event_type,
      'operationalDate', event_record.operational_date,
      'source', event_record.source,
      'callOffReportId', event_record.call_off_report_id
    )
  );

  return jsonb_build_object(
    'id', event_record.id,
    'employeeId', event_record.employee_id,
    'shiftId', event_record.shift_id,
    'eventType', event_record.event_type,
    'status', event_record.status,
    'operationalDate', event_record.operational_date,
    'createdAt', event_record.created_at,
    'callOffId', call_off_id,
    'coverageRequired', call_off_id is not null
  );
end
$$;

revoke all on function public.create_attendance_accountability_event(
  uuid, uuid, text, date, text
) from public, anon;
grant execute on function public.create_attendance_accountability_event(
  uuid, uuid, text, date, text
) to authenticated;

-- Correcting an older "Other" occurrence to an absence now creates the same
-- durable link. This provides a safe recovery path for Randy's already-entered
-- record without guessing or automatically altering today's schedule.
create or replace function public.reclassify_attendance_accountability_event(
  target_event_id uuid,
  target_event_type text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  before_row public.attendance_accountability_events%rowtype;
  after_row public.attendance_accountability_events%rowtype;
  call_off_result jsonb;
  call_off_id uuid;
begin
  if actor_id is null
     or not public.has_mfa()
     or not public.has_effective_permission('accountability.manage') then
    raise insufficient_privilege using message = 'Accountability management permission with MFA is required.';
  end if;
  if target_event_type is null
     or target_event_type not in (
       'called_in_sick',
       'call_off',
       'no_call_no_show',
       'late_arrival',
       'early_departure',
       'other'
     ) then
    raise check_violation using message = 'Choose a supported factual occurrence type.';
  end if;
  if coalesce(char_length(btrim(target_reason)), 0) < 8
     or char_length(target_reason) > 2000 then
    raise check_violation using message = 'Explain the classification change in 8–2,000 characters.';
  end if;

  select * into before_row
  from public.attendance_accountability_events
  where id = target_event_id
  for update;

  if not found or before_row.status = 'voided' then
    raise check_violation using message = 'Choose a non-voided attendance record.';
  end if;
  if before_row.event_type = target_event_type then
    raise check_violation using message = 'Choose a different occurrence type.';
  end if;

  update public.attendance_accountability_events
  set event_type = target_event_type,
      updated_at = clock_timestamp()
  where id = target_event_id
  returning * into after_row;

  if target_event_type in ('called_in_sick', 'call_off', 'no_call_no_show') then
    if after_row.shift_id is null then
      raise check_violation using message = 'An absence must be tied to a scheduled shift before coverage can be handled.';
    end if;

    call_off_result := private.ensure_attendance_absence_call_off_report(
      after_row.employee_id,
      after_row.shift_id,
      target_event_type,
      after_row.note,
      actor_id
    );
    call_off_id := (call_off_result ->> 'id')::uuid;

    update public.attendance_accountability_events
    set call_off_report_id = call_off_id,
        updated_at = clock_timestamp()
    where id = target_event_id
    returning * into after_row;
  else
    call_off_id := after_row.call_off_report_id;
  end if;

  insert into public.attendance_accountability_event_actions (
    event_id,
    action,
    reason,
    actor_id,
    before_record,
    after_record
  ) values (
    target_event_id,
    'reclassified',
    btrim(target_reason),
    actor_id,
    to_jsonb(before_row),
    to_jsonb(after_row)
  );

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'attendance_accountability_events',
    'RECLASSIFY',
    target_event_id::text,
    to_jsonb(before_row),
    to_jsonb(after_row)
  );

  return jsonb_build_object(
    'id', after_row.id,
    'eventType', after_row.event_type,
    'callOffId', call_off_id,
    'coverageRequired', call_off_id is not null
  );
end
$$;

revoke all on function public.reclassify_attendance_accountability_event(
  uuid, text, text
) from public, anon;
grant execute on function public.reclassify_attendance_accountability_event(
  uuid, text, text
) to authenticated;

-- Repair only active unresolved call-off alerts. This does not create or alter
-- shifts, assignments, or coverage cases, so already handled staffing remains
-- untouched.
update public.operational_alerts alert
set direct_path = concat('/requests?callOff=', alert.related_record_id)
where alert.alert_type = 'employee_call_off'
  and alert.related_record_type = 'call_off_report'
  and alert.active
  and exists (
    select 1
    from public.call_off_reports report
    where report.id = alert.related_record_id
      and report.canceled_at is null
      and report.resolved_at is null
  )
  and alert.direct_path is distinct from concat('/requests?callOff=', alert.related_record_id);

notify pgrst, 'reload schema';

commit;

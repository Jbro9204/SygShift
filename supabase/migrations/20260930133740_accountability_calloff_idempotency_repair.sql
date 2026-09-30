begin;

-- One physical shift may receive a new UUID every time its weekly schedule is
-- republished. Attendance and call-off identity must follow the scheduled
-- occurrence, not that transient UUID. Existing duplicates remain immutable
-- evidence and are linked to one canonical record rather than deleted.
alter table public.attendance_accountability_events
  add column if not exists duplicate_of_event_id uuid
    references public.attendance_accountability_events(id) on delete restrict;

alter table public.call_off_reports
  add column if not exists duplicate_of_call_off_report_id uuid
    references public.call_off_reports(id) on delete restrict;

alter table public.attendance_accountability_events
  drop constraint if exists attendance_accountability_duplicate_not_self;
alter table public.attendance_accountability_events
  add constraint attendance_accountability_duplicate_not_self
  check (duplicate_of_event_id is null or duplicate_of_event_id <> id);

alter table public.call_off_reports
  drop constraint if exists call_off_duplicate_not_self;
alter table public.call_off_reports
  add constraint call_off_duplicate_not_self
  check (duplicate_of_call_off_report_id is null or duplicate_of_call_off_report_id <> id);

create index if not exists attendance_accountability_canonical_occurrence_idx
  on public.attendance_accountability_events(employee_id, shift_id, created_at, id)
  where status <> 'voided' and duplicate_of_event_id is null;

create index if not exists attendance_accountability_duplicate_of_idx
  on public.attendance_accountability_events(duplicate_of_event_id)
  where duplicate_of_event_id is not null;

create index if not exists call_off_reports_canonical_occurrence_idx
  on public.call_off_reports(employee_id, shift_id, reported_at, id)
  where canceled_at is null and duplicate_of_call_off_report_id is null;

create index if not exists call_off_reports_duplicate_of_idx
  on public.call_off_reports(duplicate_of_call_off_report_id)
  where duplicate_of_call_off_report_id is not null;

-- A stale form may submit a shift from the immediately superseded schedule.
-- Accept it only when there is exactly one equivalent assignment on the
-- current published schedule. Removed, reassigned, edited, draft, archived,
-- or ambiguous shifts deliberately return null and are rejected atomically.
create or replace function private.resolve_published_accountability_shift(
  target_shift_id uuid,
  target_employee_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_status text;
  resolved_shift_ids uuid[];
begin
  if target_shift_id is null or target_employee_id is null then
    return null;
  end if;

  select schedule.status::text
  into source_status
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if source_status is null then
    return null;
  end if;

  if source_status = 'published' then
    if exists (
      select 1
      from public.shift_assignments assignment
      where assignment.shift_id = target_shift_id
        and assignment.employee_id = target_employee_id
        and assignment.status in ('assigned', 'confirmed')
        and assignment.canceled_at is null
    ) then
      return target_shift_id;
    end if;
    return null;
  end if;

  if source_status <> 'superseded' then
    return null;
  end if;

  select array_agg(candidate.id order by candidate.id)
  into resolved_shift_ids
  from public.shifts candidate
  join public.schedules schedule
    on schedule.id = candidate.schedule_id
   and schedule.status = 'published'
  join public.shift_assignments assignment
    on assignment.shift_id = candidate.id
   and assignment.employee_id = target_employee_id
   and assignment.status in ('assigned', 'confirmed')
   and assignment.canceled_at is null
  where candidate.canceled_at is null
    and private.same_scheduled_occurrence(target_shift_id, candidate.id);

  if coalesce(cardinality(resolved_shift_ids), 0) = 1 then
    return resolved_shift_ids[1];
  end if;
  return null;
end
$$;

revoke all on function private.resolve_published_accountability_shift(uuid, uuid)
  from public, anon, authenticated;

-- Serialize both the stale and current shift UUIDs through one logical lock.
create or replace function private.lock_attendance_scheduled_occurrence(
  target_employee_id uuid,
  target_shift_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  occurrence_key text;
begin
  select concat_ws('|',
    target_employee_id::text,
    schedule.week_starts_on::text,
    coalesce(shift.post_id::text, ''),
    coalesce(shift.event_id::text, ''),
    extract(epoch from shift.starts_at)::text,
    extract(epoch from shift.ends_at)::text
  )
  into occurrence_key
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where shift.id = target_shift_id;

  if occurrence_key is null then
    raise check_violation using message = 'The selected shift is no longer available.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('attendance-occurrence:' || occurrence_key, 0));
end
$$;

revoke all on function private.lock_attendance_scheduled_occurrence(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.canonical_attendance_accountability_event(
  target_employee_id uuid,
  target_shift_id uuid,
  target_event_type text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select event.id
  from public.attendance_accountability_events event
  where event.employee_id = target_employee_id
    and event.shift_id is not null
    and event.status <> 'voided'
    and event.duplicate_of_event_id is null
    and private.same_scheduled_occurrence(event.shift_id, target_shift_id)
    and (
      event.event_type = target_event_type
      or (
        event.event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
        and target_event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
      )
    )
  order by event.created_at, event.id
  limit 1
$$;

revoke all on function private.canonical_attendance_accountability_event(uuid, uuid, text)
  from public, anon, authenticated;

create or replace function private.canonical_attendance_call_off_report(
  target_employee_id uuid,
  target_shift_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select report.id
  from public.call_off_reports report
  where report.employee_id = target_employee_id
    and report.canceled_at is null
    and report.duplicate_of_call_off_report_id is null
    and private.same_scheduled_occurrence(report.shift_id, target_shift_id)
  order by
    case when exists (
      select 1
      from public.shift_coverage_cases coverage
      where coverage.call_off_report_id = report.id
        and coverage.status <> 'canceled'
    ) then 0 else 1 end,
    report.reported_at,
    report.id
  limit 1
$$;

revoke all on function private.canonical_attendance_call_off_report(uuid, uuid)
  from public, anon, authenticated;

-- Reuse the one logical call-off across schedule revisions. The helper keeps
-- the first factual record, never rewrites its reason, and reuses the existing
-- alert/coverage route on every retry.
create or replace function private.ensure_attendance_absence_call_off_report(
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
  published_shift_id uuid;
  canonical_report_id uuid;
  alert_id uuid;
  created_new boolean := false;
begin
  if target_actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into employee
  from public.employees
  where id = target_employee_id
    and status in ('active', 'leave', 'onboarding');

  published_shift_id := private.resolve_published_accountability_shift(
    target_shift_id,
    target_employee_id
  );

  select * into shift
  from public.shifts
  where id = published_shift_id and canceled_at is null;

  if employee.id is null or shift.id is null then
    raise check_violation using message = 'The selected shift changed. Refresh the workspace and choose the current assignment.';
  end if;

  perform private.lock_attendance_scheduled_occurrence(employee.id, shift.id);
  canonical_report_id := private.canonical_attendance_call_off_report(employee.id, shift.id);

  if canonical_report_id is not null then
    select * into report
    from public.call_off_reports existing
    where existing.id = canonical_report_id
    for update;
  else
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
      canonical_report_id := private.canonical_attendance_call_off_report(employee.id, shift.id);
      select * into report
      from public.call_off_reports existing
      where existing.id = canonical_report_id
      for update;
    end if;
  end if;

  if report.id is null then
    raise unique_violation using message = 'The existing absence record could not be reopened. Refresh and try again.';
  end if;

  if created_new then
    insert into public.call_off_report_actions (
      call_off_report_id, action, reason, actor_id, snapshot
    ) values (
      report.id, 'created', btrim(target_note), target_actor_id, to_jsonb(report)
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
      ' ', employee.last_name, ' was recorded absent.'
    ),
    employee.id,
    report.shift_id,
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
    'created', created_new,
    'coverageRequired', report.replacement_needed
  );
end
$$;

revoke all on function private.ensure_attendance_absence_call_off_report(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated;

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
  canonical_event_id uuid;
  source_value text := 'authorized_user';
  call_off_result jsonb;
  call_off_id uuid;
  coverage_required boolean := false;
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
    'called_in_sick', 'call_off', 'no_call_no_show',
    'late_arrival', 'early_departure', 'other'
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
    shift_id_value := private.resolve_published_accountability_shift(
      target_shift_id,
      target_employee_id
    );

    select
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver')
    into shift_starts_at, shift_ends_at, shift_time_zone
    from public.shifts shift
    where shift.id = shift_id_value;

    if shift_id_value is null or shift_starts_at is null then
      raise check_violation using message = 'The selected shift changed. Refresh the workspace and choose the current assignment.';
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

  if shift_id_value is not null and clean_event_type <> 'other' then
    perform private.lock_attendance_scheduled_occurrence(target_employee_id, shift_id_value);
    canonical_event_id := private.canonical_attendance_accountability_event(
      target_employee_id,
      shift_id_value,
      clean_event_type
    );

    if canonical_event_id is not null then
      select * into event_record
      from public.attendance_accountability_events event
      where event.id = canonical_event_id
      for update;

      if clean_event_type in ('called_in_sick', 'call_off', 'no_call_no_show') then
        call_off_result := private.ensure_attendance_absence_call_off_report(
          target_employee_id,
          shift_id_value,
          event_record.event_type,
          event_record.note,
          actor_id
        );
        call_off_id := (call_off_result ->> 'id')::uuid;
        coverage_required := coalesce((call_off_result ->> 'coverageRequired')::boolean, true);

        if event_record.call_off_report_id is distinct from call_off_id then
          update public.attendance_accountability_events
          set call_off_report_id = call_off_id,
              updated_at = clock_timestamp()
          where id = event_record.id
          returning * into event_record;
        end if;
      end if;

      return jsonb_build_object(
        'id', event_record.id,
        'employeeId', event_record.employee_id,
        'shiftId', event_record.shift_id,
        'eventType', event_record.event_type,
        'status', event_record.status,
        'operationalDate', event_record.operational_date,
        'createdAt', event_record.created_at,
        'callOffId', call_off_id,
        'coverageRequired', coverage_required,
        'created', false,
        'alreadyRecorded', true
      );
    end if;
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
    shift_id_value,
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
      shift_id_value,
      clean_event_type,
      clean_note,
      actor_id
    );
    call_off_id := (call_off_result ->> 'id')::uuid;
    coverage_required := coalesce((call_off_result ->> 'coverageRequired')::boolean, true);

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
    'coverageRequired', coverage_required,
    'created', true,
    'alreadyRecorded', false
  );
end
$$;

revoke all on function public.create_attendance_accountability_event(
  uuid, uuid, text, date, text
) from public, anon;
grant execute on function public.create_attendance_accountability_event(
  uuid, uuid, text, date, text
) to authenticated;

-- Preserve the structured late-arrival contract. A retry returns the original
-- delay and alert instead of silently overwriting the factual first report.
create or replace function public.create_attendance_accountability_event_v2(
  target_employee_id uuid,
  target_shift_id uuid default null,
  target_event_type text default 'other',
  target_operational_date date default null,
  target_note text default null,
  target_reported_late_minutes integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  event_id uuid;
  event_record public.attendance_accountability_events%rowtype;
  employee_name text;
  alert_id uuid;
  created_new boolean;
begin
  if target_event_type = 'late_arrival'
     and (target_reported_late_minutes is null or target_reported_late_minutes not between 1 and 1440) then
    raise check_violation using message = 'Enter the employee''s expected delay in minutes.';
  end if;
  if target_event_type <> 'late_arrival' and target_reported_late_minutes is not null then
    raise check_violation using message = 'A late-arrival delay can only be used for a late-arrival occurrence.';
  end if;

  result := public.create_attendance_accountability_event(
    target_employee_id,
    target_shift_id,
    target_event_type,
    target_operational_date,
    target_note
  );
  event_id := (result ->> 'id')::uuid;
  created_new := coalesce((result ->> 'created')::boolean, true);

  if target_event_type = 'late_arrival' and created_new then
    update public.attendance_accountability_events event
    set reported_late_minutes = target_reported_late_minutes,
        expected_arrival_at = event.starts_at + make_interval(mins => target_reported_late_minutes),
        actual_arrival_at = (
          select min(time_event.recorded_at)
          from public.time_events time_event
          where time_event.employee_id = event.employee_id
            and time_event.kind = 'clock_in'
            and time_event.shift_id is not null
            and private.same_scheduled_occurrence(time_event.shift_id, event.shift_id)
            and time_event.recorded_at >= event.starts_at - interval '4 hours'
            and time_event.recorded_at <= event.ends_at + interval '4 hours'
        ),
        updated_at = clock_timestamp()
    where event.id = event_id
    returning * into event_record;

    select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
    into employee_name
    from public.employees employee
    where employee.id = event_record.employee_id;

    if event_record.actual_arrival_at is null then
      insert into public.operational_alerts (
        alert_type, priority, title, summary, employee_id, shift_id,
        related_record_type, related_record_id, audience_roles, direct_path,
        deduplication_key, active, lifecycle_state, live_until_at, occurrence_key
      ) values (
        'reported_late_arrival', 'high', 'Employee running late',
        format('%s reported %s minutes late. Expected arrival: %s.', employee_name, target_reported_late_minutes,
          to_char(event_record.expected_arrival_at at time zone coalesce((select shift.time_zone from public.shifts shift where shift.id = event_record.shift_id), 'America/Denver'), 'FMHH12:MI AM')),
        event_record.employee_id, event_record.shift_id,
        'attendance_accountability_event', event_record.id,
        array['dispatcher'::public.app_role, 'scheduler'::public.app_role, 'supervisor'::public.app_role, 'admin'::public.app_role],
        '/time/accountability?event=' || event_record.id::text,
        'late-arrival:' || event_record.id::text, true, 'active_operations', event_record.ends_at + interval '4 hours',
        'late-arrival:' || event_record.id::text
      )
      on conflict (deduplication_key) do update
      set active = true,
          lifecycle_state = 'active_operations',
          summary = excluded.summary,
          live_until_at = excluded.live_until_at,
          cleared_at = null,
          cleared_by = null,
          clear_source = null,
          cleared_reason = null
      returning id into alert_id;

      update public.attendance_accountability_events
      set operational_alert_id = alert_id, updated_at = clock_timestamp()
      where id = event_id
      returning * into event_record;
    end if;
  elsif target_event_type = 'late_arrival' then
    select * into event_record
    from public.attendance_accountability_events event
    where event.id = event_id;
  end if;

  return result || jsonb_build_object(
    'reportedLateMinutes', event_record.reported_late_minutes,
    'expectedArrivalAt', event_record.expected_arrival_at,
    'actualArrivalAt', event_record.actual_arrival_at
  );
end
$$;

revoke all on function public.create_attendance_accountability_event_v2(
  uuid, uuid, text, date, text, integer
) from public, anon;
grant execute on function public.create_attendance_accountability_event_v2(
  uuid, uuid, text, date, text, integer
) to authenticated;

-- Employee self-reporting now uses the same logical occurrence and call-off
-- helper as Accountability. A later manager opens the existing coverage case
-- instead of creating a second absence.
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
  published_shift_id uuid;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  shift_time_zone text := 'America/Denver';
  shift_post_name text;
  shift_site_name text;
  shift_site_code text;
  shift_event_name text;
  shift_event_location_name text;
  inserted_event public.attendance_accountability_events%rowtype;
  canonical_event_id uuid;
  call_off_result jsonb;
  call_off_id uuid;
  created_new boolean := true;
begin
  if reporter_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into reporter_record
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
    published_shift_id := private.resolve_published_accountability_shift(
      target_shift_id,
      reporter_id
    );

    select
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver'),
      post.name,
      site.name,
      site.code,
      event.name,
      event.location_name
    into
      shift_starts_at,
      shift_ends_at,
      shift_time_zone,
      shift_post_name,
      shift_site_name,
      shift_site_code,
      shift_event_name,
      shift_event_location_name
    from public.shifts shift
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where shift.id = published_shift_id
      and shift.ends_at > clock_timestamp() - interval '2 hours';

    if published_shift_id is null or shift_starts_at is null then
      raise check_violation using message = 'The selected shift changed. Refresh My Time and choose the current assignment.';
    end if;

    perform private.lock_attendance_scheduled_occurrence(reporter_id, published_shift_id);
    canonical_event_id := private.canonical_attendance_accountability_event(
      reporter_id,
      published_shift_id,
      clean_event_type
    );

    if canonical_event_id is not null then
      select * into inserted_event
      from public.attendance_accountability_events event
      where event.id = canonical_event_id
      for update;
      created_new := false;
    end if;
  elsif target_operational_date is null then
    raise check_violation using message = 'Choose a shift or date for this attendance report.';
  elsif target_operational_date < operational_today then
    raise check_violation using message = 'Employees can report sick or call-off only for today or a future date.';
  end if;

  if inserted_event.id is null then
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
      published_shift_id,
      clean_event_type,
      'reported',
      coalesce(target_operational_date, (shift_starts_at at time zone shift_time_zone)::date),
      shift_starts_at,
      shift_ends_at,
      'employee',
      clean_note,
      reporter_id
    )
    returning * into inserted_event;
  end if;

  if published_shift_id is not null then
    call_off_result := private.ensure_attendance_absence_call_off_report(
      reporter_id,
      published_shift_id,
      inserted_event.event_type,
      inserted_event.note,
      reporter_id
    );
    call_off_id := (call_off_result ->> 'id')::uuid;

    if inserted_event.call_off_report_id is distinct from call_off_id then
      update public.attendance_accountability_events
      set call_off_report_id = call_off_id,
          updated_at = clock_timestamp()
      where id = inserted_event.id
      returning * into inserted_event;
    end if;
  end if;

  if created_new then
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
      reporter_id,
      'public',
      'attendance_accountability_events',
      'INSERT',
      inserted_event.id::text,
      jsonb_build_object(
        'eventType', inserted_event.event_type,
        'employeeId', inserted_event.employee_id,
        'shiftId', inserted_event.shift_id,
        'operationalDate', inserted_event.operational_date,
        'callOffReportId', call_off_id
      )
    );
  end if;

  return jsonb_build_object(
    'id', inserted_event.id,
    'callOffId', coalesce(call_off_id, inserted_event.call_off_report_id),
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
    'created', created_new,
    'alreadyRecorded', not created_new,
    'dispatchAlreadyNotified', inserted_event.dispatch_notified_at is not null,
    'dispatchTo', 'dispatch@guardianshipsecurity.net'
  );
end
$$;

revoke all on function public.report_attendance_accountability_event(uuid, text, date, text)
  from public, anon;
grant execute on function public.report_attendance_accountability_event(uuid, text, date, text)
  to authenticated;

-- Keep the original employee call-off RPC compatible while routing it through
-- the same revision-aware event and report identity used by the current UI.
create or replace function public.report_call_off(
  target_shift_id uuid,
  call_off_reason text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := public.report_attendance_accountability_event(
    target_shift_id,
    'call_off',
    null,
    call_off_reason
  );

  return (result ->> 'callOffId')::uuid;
end
$$;

revoke all on function public.report_call_off(uuid, text)
  from public, anon;
grant execute on function public.report_call_off(uuid, text)
  to authenticated;

-- The Time Operations entry path receives the same revision-aware behavior.
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
  published_shift_id uuid;
  canonical_report_id uuid;
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

  published_shift_id := private.resolve_published_accountability_shift(
    target_shift_id,
    target_employee_id
  );
  select * into shift
  from public.shifts
  where id = published_shift_id and canceled_at is null;

  if employee.id is null or shift.id is null then
    raise check_violation using message = 'The selected shift changed. Refresh and choose the current assignment.';
  end if;

  perform private.lock_attendance_scheduled_occurrence(employee.id, shift.id);
  canonical_report_id := private.canonical_attendance_call_off_report(employee.id, shift.id);

  if canonical_report_id is not null then
    select * into report
    from public.call_off_reports existing
    where existing.id = canonical_report_id
    for update;
  else
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
          then '' else E'\n\n' || btrim(target_notes) end
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
      canonical_report_id := private.canonical_attendance_call_off_report(employee.id, shift.id);
      select * into report
      from public.call_off_reports existing
      where existing.id = canonical_report_id
      for update;
    end if;
  end if;

  if report.id is null then
    raise unique_violation using message = 'The existing call-off could not be reopened. Refresh and try again.';
  end if;

  if created_new then
    insert into public.call_off_report_actions (
      call_off_report_id, action, reason, actor_id, snapshot
    ) values (
      report.id, 'created', btrim(target_reason), actor_id, to_jsonb(report)
    );
  end if;

  insert into public.operational_alerts (
    alert_type, priority, title, summary, employee_id, shift_id,
    related_record_type, related_record_id, audience_roles, direct_path,
    deduplication_key
  ) values (
    'employee_call_off', 'urgent', 'Employee call-off — coverage review required',
    concat(
      coalesce(nullif(employee.preferred_name, ''), employee.first_name),
      ' ', employee.last_name, ' reported ',
      case when report.call_off_type = 'sick' then 'sick' else 'a call-off' end,
      '.'
    ),
    employee.id, report.shift_id, 'call_off_report', report.id,
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
    'coverageRequired', report.replacement_needed,
    'created', created_new
  );
end
$$;

revoke all on function public.report_employee_call_off(
  uuid, uuid, text, timestamptz, text, text, boolean, text
) from public, anon;
grant execute on function public.report_employee_call_off(
  uuid, uuid, text, timestamptz, text, text, boolean, text
) to authenticated;

-- Reconcile pre-existing revision duplicates by linking them to the canonical
-- event/report. A coverage-bearing report remains the operational handoff,
-- while the earliest factual attendance event remains the event of record.
-- No factual row, note, decision, assignment, or punch is deleted or rewritten.
with mapped as (
  select
    report.id,
    private.canonical_attendance_call_off_report(
      report.employee_id,
      report.shift_id
    ) as canonical_id
  from public.call_off_reports report
  where report.canceled_at is null
    and report.duplicate_of_call_off_report_id is null
), changed as (
  update public.call_off_reports report
  set duplicate_of_call_off_report_id = mapped.canonical_id,
      updated_at = clock_timestamp()
  from mapped
  where report.id = mapped.id
    and mapped.canonical_id is not null
    and mapped.canonical_id <> mapped.id
    and not exists (
      select 1
      from public.shift_coverage_cases coverage
      where coverage.call_off_report_id = report.id
        and coverage.status <> 'canceled'
    )
  returning report.id, report.duplicate_of_call_off_report_id
)
insert into private.audit_events (
  auth_user_id, employee_id, schema_name, table_name,
  operation, row_id, new_record
)
select
  null, null, 'public', 'call_off_reports',
  'LINK_DUPLICATE', changed.id::text,
  jsonb_build_object('duplicateOfCallOffReportId', changed.duplicate_of_call_off_report_id)
from changed;

with mapped as (
  select
    event.id,
    private.canonical_attendance_accountability_event(
      event.employee_id,
      event.shift_id,
      event.event_type
    ) as canonical_id
  from public.attendance_accountability_events event
  where event.shift_id is not null
    and event.status <> 'voided'
    and event.duplicate_of_event_id is null
    and event.event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
), changed as (
  update public.attendance_accountability_events event
  set duplicate_of_event_id = mapped.canonical_id,
      updated_at = clock_timestamp()
  from mapped
  where event.id = mapped.id
    and mapped.canonical_id is not null
    and mapped.canonical_id <> mapped.id
  returning event.id, event.duplicate_of_event_id
)
insert into private.audit_events (
  auth_user_id, employee_id, schema_name, table_name,
  operation, row_id, new_record
)
select
  null, null, 'public', 'attendance_accountability_events',
  'LINK_DUPLICATE', changed.id::text,
  jsonb_build_object('duplicateOfEventId', changed.duplicate_of_event_id)
from changed;

-- A historical first event may have pointed at the now-linked report from its
-- own revision. Normalize only the canonical event's handoff; duplicate rows
-- keep their original evidence and explicit duplicate link.
with mapped as (
  select
    event.id,
    event.call_off_report_id as previous_call_off_report_id,
    private.canonical_attendance_call_off_report(
      event.employee_id,
      event.shift_id
    ) as canonical_call_off_report_id
  from public.attendance_accountability_events event
  where event.shift_id is not null
    and event.status <> 'voided'
    and event.duplicate_of_event_id is null
    and event.event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
), changed as (
  update public.attendance_accountability_events event
  set call_off_report_id = mapped.canonical_call_off_report_id,
      updated_at = clock_timestamp()
  from mapped
  where event.id = mapped.id
    and mapped.canonical_call_off_report_id is not null
    and event.call_off_report_id is distinct from mapped.canonical_call_off_report_id
  returning
    event.id,
    mapped.previous_call_off_report_id,
    event.call_off_report_id
)
insert into private.audit_events (
  auth_user_id, employee_id, schema_name, table_name,
  operation, row_id, old_record, new_record
)
select
  null, null, 'public', 'attendance_accountability_events',
  'NORMALIZE_CALLOFF_LINK', changed.id::text,
  jsonb_build_object('callOffReportId', changed.previous_call_off_report_id),
  jsonb_build_object('callOffReportId', changed.call_off_report_id)
from changed;

-- Terminal coverage decisions close their operational alert immediately.
create or replace function private.clear_call_off_operational_alert_on_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.resolved_at is not null or new.canceled_at is not null then
    update public.operational_alerts alert
    set active = false,
        lifecycle_state = 'resolved',
        cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
        cleared_by = coalesce(new.canceled_by, new.acknowledged_by, alert.cleared_by),
        clear_source = coalesce(alert.clear_source, 'automatic_resolution'),
        cleared_reason = coalesce(
          alert.cleared_reason,
          case when new.canceled_at is not null
            then 'The call-off was canceled.'
            else 'The coverage plan was completed.'
          end
        )
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id = new.id
      and (alert.active or alert.lifecycle_state <> 'resolved');
  end if;
  return new;
end
$$;

revoke all on function private.clear_call_off_operational_alert_on_close()
  from public, anon, authenticated;

drop trigger if exists clear_call_off_operational_alert_on_close
  on public.call_off_reports;
create trigger clear_call_off_operational_alert_on_close
after insert or update of resolved_at, canceled_at on public.call_off_reports
for each row execute function private.clear_call_off_operational_alert_on_close();

update public.operational_alerts alert
set active = false,
    lifecycle_state = 'resolved',
    cleared_at = coalesce(alert.cleared_at, clock_timestamp()),
    clear_source = coalesce(
      alert.clear_source,
      case when report.duplicate_of_call_off_report_id is not null
        then 'superseded_duplicate'
        else 'automatic_resolution'
      end
    ),
    cleared_reason = coalesce(
      alert.cleared_reason,
      case when report.duplicate_of_call_off_report_id is not null
        then 'A canonical call-off is retained for this scheduled occurrence.'
        when report.canceled_at is not null then 'The call-off was canceled.'
        else 'The coverage plan was completed.'
      end
    )
from public.call_off_reports report
where alert.related_record_type = 'call_off_report'
  and alert.related_record_id = report.id
  and (
    report.resolved_at is not null
    or report.canceled_at is not null
    or report.duplicate_of_call_off_report_id is not null
  )
  and (alert.active or alert.lifecycle_state <> 'resolved');

-- Restore the operations handoff for live unresolved canonical call-offs that
-- predate the alert-producing paths. Historical and terminal rows stay quiet.
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
)
select
  'employee_call_off',
  'urgent',
  'Employee call-off — coverage review required',
  concat(
    coalesce(nullif(employee.preferred_name, ''), employee.first_name),
    ' ', employee.last_name, ' has an unresolved call-off.'
  ),
  report.employee_id,
  report.shift_id,
  'call_off_report',
  report.id,
  array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[],
  concat('/requests?callOff=', report.id),
  concat('call-off:', report.id)
from public.call_off_reports report
join public.employees employee on employee.id = report.employee_id
join public.shifts shift on shift.id = report.shift_id
where report.canceled_at is null
  and report.resolved_at is null
  and report.duplicate_of_call_off_report_id is null
  and shift.canceled_at is null
  and shift.ends_at > clock_timestamp()
  and not exists (
    select 1
    from public.operational_alerts existing_alert
    where existing_alert.related_record_type = 'call_off_report'
      and existing_alert.related_record_id = report.id
  )
on conflict (deduplication_key) do nothing;

-- The canonical list reader now returns one row per logical absence while
-- exposing the durable coverage continuation link to the UI.
alter function public.get_payroll_accountability_events(date, date)
  rename to get_payroll_accountability_events_pre_calloff_idempotency;
alter function public.get_payroll_accountability_events_pre_calloff_idempotency(date, date)
  set schema private;
revoke all on function private.get_payroll_accountability_events_pre_calloff_idempotency(date, date)
  from public, anon, authenticated;

create function public.get_payroll_accountability_events(
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
  payload jsonb;
  canonical_payload jsonb;
begin
  payload := private.get_payroll_accountability_events_pre_calloff_idempotency(
    target_from_date,
    target_through_date
  );

  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      'callOffId', coalesce(native_event.call_off_report_id, legacy_report.id),
      'coverageStatus', coverage.status
    ) order by item.ordinality
  ), '[]'::jsonb)
  into canonical_payload
  from jsonb_array_elements(coalesce(payload, '[]'::jsonb))
    with ordinality item(value, ordinality)
  left join public.attendance_accountability_events native_event
    on item.value ->> 'sourceTable' = 'attendance_accountability_events'
   and native_event.id = (item.value ->> 'id')::uuid
  left join public.call_off_reports legacy_report
    on item.value ->> 'sourceTable' = 'call_off_reports'
   and legacy_report.id = (item.value ->> 'id')::uuid
  left join public.shift_coverage_cases coverage
    on coverage.call_off_report_id = coalesce(native_event.call_off_report_id, legacy_report.id)
  where coalesce(native_event.duplicate_of_event_id is null, true)
    and coalesce(legacy_report.duplicate_of_call_off_report_id is null, true)
    and not exists (
      select 1
      from public.call_off_reports linked_report
      where linked_report.id = native_event.call_off_report_id
        and linked_report.duplicate_of_call_off_report_id is not null
    );

  return canonical_payload;
end
$$;

revoke all on function public.get_payroll_accountability_events(date, date)
  from public, anon;
grant execute on function public.get_payroll_accountability_events(date, date)
  to authenticated;

-- Filter linked historical duplicates from Time Operations while retaining
-- every underlying row for audit and direct historical lookup.
create or replace function public.get_timekeeping_operations_workspace(
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
      ) order by call_off.ordinality
    ),
    '[]'::jsonb
  )
  into enriched_call_offs
  from jsonb_array_elements(coalesce(payload -> 'callOffReports', '[]'::jsonb))
    with ordinality as call_off(item, ordinality)
  left join public.call_off_reports report
    on report.id = (call_off.item ->> 'id')::uuid
  left join public.shift_coverage_cases coverage
    on coverage.call_off_report_id = report.id
  where report.id is null or report.duplicate_of_call_off_report_id is null;

  return jsonb_set(payload, '{callOffReports}', enriched_call_offs, true);
end
$$;

revoke all on function public.get_timekeeping_operations_workspace(date, date)
  from public, anon;
grant execute on function public.get_timekeeping_operations_workspace(date, date)
  to authenticated;

-- Patch the authoritative request and report readers in place so linked
-- historical duplicates cannot reappear on another screen or export.
do $request_center_canonical_call_offs$
declare
  definition text;
  prior text := 'and report.canceled_at is null
        and shift.ends_at > clock_timestamp()';
  replacement text := 'and report.canceled_at is null
        and report.duplicate_of_call_off_report_id is null
        and shift.ends_at > clock_timestamp()';
begin
  select pg_get_functiondef('public.get_request_center_payload()'::regprocedure)
  into definition;
  if definition is null or position(prior in definition) = 0 then
    raise exception 'The Request Center call-off filter changed; canonical duplicate filtering requires review.';
  end if;
  execute replace(definition, prior, replacement);
end
$request_center_canonical_call_offs$;

do $short_notice_canonical_call_offs$
declare
  definition text;
  prior text := 'where (shift.starts_at at time zone shift.time_zone)::date
      between target_from_date and target_through_date';
  replacement text := 'where report.duplicate_of_call_off_report_id is null
      and (shift.starts_at at time zone shift.time_zone)::date
      between target_from_date and target_through_date';
begin
  select pg_get_functiondef(
    'public.get_hr_short_notice_call_out_report(date,date,boolean)'::regprocedure
  ) into definition;
  if definition is null or position(prior in definition) = 0 then
    raise exception 'The HR short-notice call-out filter changed; canonical duplicate filtering requires review.';
  end if;
  execute replace(definition, prior, replacement);
end
$short_notice_canonical_call_offs$;

do $workforce_activity_canonical_call_offs$
declare
  definition text;
  prior_current text := 'and report.canceled_at is null
      and private.same_scheduled_occurrence(report.shift_id, assignment.shift_id)';
  replacement_current text := 'and report.canceled_at is null
      and report.duplicate_of_call_off_report_id is null
      and private.same_scheduled_occurrence(report.shift_id, assignment.shift_id)';
  prior_historical text := 'where report.canceled_at is null
    and private.shift_assignment_type(source_shift.id) <> ''dispatch_phone_duty''';
  replacement_historical text := 'where report.canceled_at is null
    and report.duplicate_of_call_off_report_id is null
    and private.shift_assignment_type(source_shift.id) <> ''dispatch_phone_duty''';
begin
  select pg_get_functiondef(
    'private.get_workforce_activity_report_rows(date,date)'::regprocedure
  ) into definition;
  if definition is null
    or position(prior_current in definition) = 0
    or position(prior_historical in definition) = 0 then
    raise exception 'The Workforce Activity call-off filters changed; canonical duplicate filtering requires review.';
  end if;
  definition := replace(definition, prior_current, replacement_current);
  definition := replace(definition, prior_historical, replacement_historical);
  execute definition;
end
$workforce_activity_canonical_call_offs$;

notify pgrst, 'reload schema';

commit;

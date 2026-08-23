begin;

-- Time Maintenance must use the same occurrence anchor as payroll review. A
-- clock-out after midnight belongs to the work occurrence started the night
-- before; filtering it by its own calendar date splits a valid pair and creates
-- a false missing-punch finding at both payroll-range boundaries.
create or replace function public.get_time_maintenance(
  target_from_date date,
  target_through_date date,
  target_employee_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  employees_payload jsonb;
  events_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not public.has_effective_permission('time.manage') then
    raise insufficient_privilege using message = 'Time management permission with MFA is required for time maintenance.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time maintenance ranges are limited to 46 days.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', employee.id,
    'username', employee.username,
    'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'status', employee.status
  ) order by coalesce(nullif(employee.preferred_name, ''), employee.first_name), employee.last_name), '[]'::jsonb)
  into employees_payload
  from public.employees employee
  where employee.status in ('active', 'leave')
    and employee.username is not null;

  with latest_correction as (
    select distinct on (correction.time_event_id)
      correction.time_event_id,
      correction.replacement_time,
      correction.voided
    from public.time_event_corrections correction
    where correction.approved_at is not null
    order by correction.time_event_id, correction.approved_at desc
  ),
  pending_corrections as (
    select correction.time_event_id, count(*)::integer as pending_count
    from public.time_event_corrections correction
    where correction.approved_at is null
      and correction.declined_at is null
    group by correction.time_event_id
  ),
  note_summary as (
    select
      note.time_event_id,
      count(*)::integer as note_count,
      (array_agg(note.note order by note.created_at desc, note.id desc))[1] as latest_note,
      (array_agg(note.action order by note.created_at desc, note.id desc))[1] as latest_action
    from public.time_event_maintenance_notes note
    group by note.time_event_id
  ),
  latest_location_override as (
    select distinct on (location_override.time_event_id)
      location_override.time_event_id,
      location_override.location_name,
      location_override.time_zone
    from public.time_event_location_overrides location_override
    order by location_override.time_event_id, location_override.created_at desc, location_override.id desc
  ),
  latest_shift_override as (
    select distinct on (shift_override.time_event_id)
      shift_override.time_event_id,
      shift_override.shift_id
    from public.time_event_shift_overrides shift_override
    order by shift_override.time_event_id, shift_override.created_at desc, shift_override.id desc
  ),
  event_rows as (
    select
      event.id,
      event.employee_id,
      employee.username,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.role,
      employee.employment_type,
      coalesce(latest_shift_override.shift_id, event.shift_id) as shift_id,
      occurrence.occurrence_key,
      occurrence.assignment_anchor,
      (occurrence.assignment_anchor at time zone 'America/Denver')::date as operational_date,
      private.current_effective_time_event_kind(event.id) as kind,
      event.kind as recorded_kind,
      event.recorded_at,
      coalesce(latest_correction.replacement_time, event.recorded_at) as effective_at,
      event.client_recorded_at,
      event.source,
      event.created_by,
      btrim(coalesce(creator.preferred_name, creator.first_name) || ' ' || creator.last_name) as created_by_name,
      coalesce(latest_correction.voided, false) as voided,
      coalesce(pending_corrections.pending_count, 0) as pending_correction_count,
      coalesce(note_summary.note_count, 0) as maintenance_note_count,
      note_summary.latest_note,
      note_summary.latest_action,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      schedule_event.name as event_name,
      coalesce(latest_location_override.location_name, schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled Location') as location_name,
      coalesce(latest_location_override.time_zone, shift.time_zone, 'America/Denver') as time_zone
    from public.time_events event
    join private.get_effective_time_events_with_occurrence(target_employee_id) occurrence on occurrence.id = event.id
    join public.employees employee on employee.id = event.employee_id
    left join public.employees creator on creator.id = event.created_by
    left join latest_correction on latest_correction.time_event_id = event.id
    left join pending_corrections on pending_corrections.time_event_id = event.id
    left join note_summary on note_summary.time_event_id = event.id
    left join latest_location_override on latest_location_override.time_event_id = event.id
    left join latest_shift_override on latest_shift_override.time_event_id = event.id
    left join public.shifts shift on shift.id = coalesce(latest_shift_override.shift_id, event.shift_id)
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where target_employee_id is not null
      and event.employee_id = target_employee_id
      and (occurrence.assignment_anchor at time zone 'America/Denver')::date
        between target_from_date and target_through_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'employeeId', employee_id,
    'username', username,
    'employeeName', employee_name,
    'role', role,
    'employmentType', employment_type,
    'shiftId', shift_id,
    'occurrenceKey', occurrence_key,
    'assignmentAnchor', assignment_anchor,
    'operationalDate', operational_date,
    'kind', kind,
    'recordedKind', recorded_kind,
    'recordedAt', recorded_at,
    'effectiveAt', effective_at,
    'clientRecordedAt', client_recorded_at,
    'source', source,
    'createdBy', created_by,
    'createdByName', created_by_name,
    'voided', voided,
    'pendingCorrectionCount', pending_correction_count,
    'maintenanceNoteCount', maintenance_note_count,
    'latestNote', latest_note,
    'latestAction', latest_action,
    'siteName', site_name,
    'siteCode', site_code,
    'postName', post_name,
    'eventName', event_name,
    'locationName', location_name,
    'timeZone', time_zone
  ) order by operational_date desc, effective_at desc, employee_name), '[]'::jsonb)
  into events_payload
  from event_rows;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', 'America/Denver',
    'employees', employees_payload,
    'events', events_payload
  );
end
$$;

revoke all on function public.get_time_maintenance(date, date, uuid) from public, anon;
grant execute on function public.get_time_maintenance(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

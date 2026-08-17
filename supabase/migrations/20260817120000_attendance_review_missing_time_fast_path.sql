begin;

do $$
begin
  if to_regprocedure('private.get_attendance_reconciliation_group_snapshot_detailed(uuid)') is null then
    alter function private.get_attendance_reconciliation_group_snapshot(uuid)
      rename to get_attendance_reconciliation_group_snapshot_detailed;
  end if;
end
$$;

create or replace function private.get_attendance_reconciliation_missing_time_snapshot(
  target_shift_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with anchor_shift as (
  select
    shift.id,
    shift.schedule_id,
    shift.post_id,
    shift.event_id,
    shift.starts_at,
    shift.ends_at,
    coalesce(shift.time_zone, 'America/Denver') as time_zone,
    shift.requires_armed
  from public.shifts shift
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  where shift.id = target_shift_id
    and shift.canceled_at is null
),
member_shifts as (
  select
    member.id,
    member.schedule_id,
    member.post_id,
    member.event_id,
    member.starts_at,
    member.ends_at,
    coalesce(member.time_zone, 'America/Denver') as time_zone,
    member.headcount_required,
    member.requires_armed
  from public.shifts member
  cross join anchor_shift anchor
  where member.schedule_id = anchor.schedule_id
    and member.post_id is not distinct from anchor.post_id
    and member.event_id is not distinct from anchor.event_id
    and member.starts_at = anchor.starts_at
    and member.ends_at = anchor.ends_at
    and coalesce(member.time_zone, 'America/Denver') = anchor.time_zone
    and member.requires_armed = anchor.requires_armed
    and member.canceled_at is null
),
member_stats as (
  select
    count(*)::integer as member_count,
    (array_agg(member.id order by member.id))[1] as canonical_shift_id,
    (array_agg(member.schedule_id))[1] as schedule_id,
    (array_agg(member.post_id))[1] as post_id,
    (array_agg(member.event_id))[1] as event_id,
    max(member.starts_at) as starts_at,
    max(member.ends_at) as ends_at,
    max(member.time_zone) as time_zone,
    max(member.headcount_required)::integer as maximum_headcount_required,
    bool_or(member.requires_armed) as requires_armed,
    jsonb_agg(member.id order by member.id) as member_shift_ids
  from member_shifts member
),
scheduled_employee_rows as (
  select
    assignment.employee_id,
    assignment.status,
    btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
    employee.username
  from public.shift_assignments assignment
  join member_shifts member on member.id = assignment.shift_id
  join public.employees employee on employee.id = assignment.employee_id
  where assignment.status in ('assigned', 'confirmed', 'completed')
),
scheduled_employees as (
  select distinct on (row.employee_id)
    row.employee_id,
    row.status,
    row.employee_name,
    row.username
  from scheduled_employee_rows row
  order by row.employee_id, row.employee_name, row.status
),
scheduled_rollup as (
  select
    count(*)::integer as employee_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'employeeId', employee.employee_id,
      'employeeName', employee.employee_name,
      'username', employee.username,
      'assignmentStatus', employee.status
    ) order by employee.employee_name, employee.employee_id), '[]'::jsonb) as employees
  from scheduled_employees employee
),
occurrence as (
  select
    stats.*,
    scheduled.employee_count as scheduled_employee_count,
    scheduled.employees as scheduled_employees,
    case
      when stats.member_count = 1 then stats.maximum_headcount_required
      else greatest(stats.maximum_headcount_required, scheduled.employee_count)
    end::integer as effective_headcount,
    greatest(0, floor(extract(epoch from (stats.ends_at - stats.starts_at)) / 60)::integer) as scheduled_minutes_per_position,
    site.id as site_id,
    site.code as site_code,
    site.name as site_name,
    post.id as resolved_post_id,
    post.name as post_name,
    schedule_event.id as resolved_event_id,
    schedule_event.name as event_name,
    coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Scheduled location') as location_name
  from member_stats stats
  cross join scheduled_rollup scheduled
  left join public.posts post on post.id = stats.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events schedule_event on schedule_event.id = stats.event_id
),
classified as (
  select
    occurrence.*,
    (occurrence.scheduled_minutes_per_position * occurrence.effective_headcount)::integer as scheduled_coverage_minutes,
    array_remove(array[
      case when occurrence.scheduled_employee_count < occurrence.effective_headcount then 'planned_understaffing' end,
      'understaffed_or_uncovered',
      'missing_recorded_time',
      case when occurrence.scheduled_employee_count > 0 then 'scheduled_employee_missing' end,
      case
        when occurrence.scheduled_minutes_per_position * occurrence.effective_headcount > 15
        then 'worked_time_variance'
      end
    ]::text[], null) as discrepancy_codes
  from occurrence
),
snapshot as (
  select jsonb_build_object(
    'shiftId', classified.canonical_shift_id,
    'scheduleId', classified.schedule_id,
    'operationalDate', (classified.starts_at at time zone classified.time_zone)::date,
    'startsAt', classified.starts_at,
    'endsAt', classified.ends_at,
    'timeZone', classified.time_zone,
    'headcountRequired', classified.effective_headcount,
    'requiresArmed', classified.requires_armed,
    'scheduledMinutesPerPosition', classified.scheduled_minutes_per_position,
    'scheduledCoverageMinutes', classified.scheduled_coverage_minutes,
    'actualPaidMinutes', 0,
    'varianceMinutes', -classified.scheduled_coverage_minutes,
    'scheduledEmployeeCount', classified.scheduled_employee_count,
    'actualEmployeeCount', 0,
    'scheduledMissingCount', classified.scheduled_employee_count,
    'unexpectedActualCount', 0,
    'siteId', classified.site_id,
    'siteCode', classified.site_code,
    'siteName', classified.site_name,
    'postId', classified.resolved_post_id,
    'postName', classified.post_name,
    'eventId', classified.resolved_event_id,
    'eventName', classified.event_name,
    'locationName', classified.location_name,
    'scheduledEmployees', classified.scheduled_employees,
    'actualEmployees', '[]'::jsonb,
    'callOffs', '[]'::jsonb,
    'discrepancyCodes', to_jsonb(classified.discrepancy_codes),
    'requiresTimeCorrection', false
  ) || case
    when classified.member_count = 1 then '{}'::jsonb
    else jsonb_build_object(
      'coverageGroupSize', classified.member_count,
      'memberShiftIds', classified.member_shift_ids
    )
  end as value
  from classified
)
select snapshot.value || jsonb_build_object(
  'occurrenceFingerprint', encode(
    extensions.digest(convert_to(snapshot.value::text, 'UTF8'), 'sha256'),
    'hex'
  )
)
from snapshot
$$;

create or replace function private.get_attendance_reconciliation_group_snapshot(
  target_shift_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  has_recorded_activity boolean := false;
begin
  with anchor_shift as (
    select
      shift.schedule_id,
      shift.post_id,
      shift.event_id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver') as time_zone,
      shift.requires_armed
    from public.shifts shift
    join public.schedules schedule
      on schedule.id = shift.schedule_id
     and schedule.status = 'published'
    where shift.id = target_shift_id
      and shift.canceled_at is null
  ),
  member_shifts as (
    select member.id
    from public.shifts member
    cross join anchor_shift anchor
    where member.schedule_id = anchor.schedule_id
      and member.post_id is not distinct from anchor.post_id
      and member.event_id is not distinct from anchor.event_id
      and member.starts_at = anchor.starts_at
      and member.ends_at = anchor.ends_at
      and coalesce(member.time_zone, 'America/Denver') = anchor.time_zone
      and member.requires_armed = anchor.requires_armed
      and member.canceled_at is null
  )
  select exists (
    select 1
    from member_shifts member
    where exists (
      select 1
      from public.time_events time_event
      where time_event.shift_id = member.id
    )
    or exists (
      select 1
      from public.time_event_shift_overrides shift_override
      where shift_override.shift_id = member.id
    )
    or exists (
      select 1
      from public.attendance_accountability_events attendance
      where attendance.shift_id = member.id
    )
    or exists (
      select 1
      from public.call_off_reports call_off
      where call_off.shift_id = member.id
    )
  )
  into has_recorded_activity;

  if has_recorded_activity then
    return private.get_attendance_reconciliation_group_snapshot_detailed(target_shift_id);
  end if;

  return private.get_attendance_reconciliation_missing_time_snapshot(target_shift_id);
end
$$;

comment on function private.get_attendance_reconciliation_missing_time_snapshot(uuid) is
  'Builds the full reconciliation payload for a scheduled coverage occurrence with no recorded time or call-off activity without invoking per-employee time calculations.';

comment on function private.get_attendance_reconciliation_group_snapshot(uuid) is
  'Routes no-activity coverage occurrences through a bounded missing-time calculation and retains detailed reconciliation for occurrences with recorded activity.';

revoke all on function private.get_attendance_reconciliation_group_snapshot_detailed(uuid) from public, anon, authenticated;
revoke all on function private.get_attendance_reconciliation_missing_time_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.get_attendance_reconciliation_group_snapshot(uuid) from public, anon, authenticated;

grant execute on function private.get_attendance_reconciliation_group_snapshot_detailed(uuid) to service_role;
grant execute on function private.get_attendance_reconciliation_missing_time_snapshot(uuid) to service_role;
grant execute on function private.get_attendance_reconciliation_group_snapshot(uuid) to service_role;

commit;

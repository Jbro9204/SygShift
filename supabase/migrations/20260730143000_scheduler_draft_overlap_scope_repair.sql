begin;

create or replace function private.assignment_overlap_conflict(
  target_assignment_id uuid,
  target_shift_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  conflict_record record;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if target_shift.id is null then
    return null;
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    return null;
  end if;

  select
    assignment.id as assignment_id,
    shift.id as shift_id,
    schedule.id as schedule_id,
    schedule.week_starts_on,
    schedule.revision,
    schedule.status,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    coalesce(site.name || ' / ' || post.name, event.location_name, event.name, 'Unlabeled shift') as location_label,
    btrim(concat_ws(' ', employee.first_name, employee.last_name)) as employee_name
  into conflict_record
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  join public.employees employee on employee.id = assignment.employee_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where assignment.employee_id = target_employee_id
    and assignment.id is distinct from target_assignment_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and shift.id <> target_shift_id
    and shift.canceled_at is null
    and (
      schedule.id = target_schedule.id
      or (
        schedule.status = 'published'
        and schedule.id is distinct from target_schedule.previous_revision_id
        and not (
          target_schedule.status = 'draft'
          and schedule.week_starts_on = target_schedule.week_starts_on
        )
      )
    )
    and tstzrange(shift.starts_at, shift.ends_at, '[)')
      && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  order by shift.starts_at, shift.ends_at, schedule.week_starts_on, schedule.revision desc, assignment.id
  limit 1;

  if conflict_record.assignment_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'assignmentId', conflict_record.assignment_id,
    'shiftId', conflict_record.shift_id,
    'scheduleId', conflict_record.schedule_id,
    'weekStartsOn', conflict_record.week_starts_on,
    'revision', conflict_record.revision,
    'status', conflict_record.status,
    'employeeName', conflict_record.employee_name,
    'location', conflict_record.location_label,
    'date', to_char((conflict_record.starts_at at time zone conflict_record.time_zone)::date, 'MM/DD/YYYY'),
    'startsAt', to_char(conflict_record.starts_at at time zone conflict_record.time_zone, 'FMHH12:MI AM'),
    'endsAt', to_char(conflict_record.ends_at at time zone conflict_record.time_zone, 'FMHH12:MI AM'),
    'timeZone', conflict_record.time_zone
  );
end;
$$;

comment on function private.assignment_overlap_conflict(uuid, uuid, uuid) is
  'Finds the first real active assignment conflict for an employee. Working drafts ignore the published source schedule for the same week, while still enforcing same-draft and other-week conflicts.';

notify pgrst, 'reload schema';

commit;

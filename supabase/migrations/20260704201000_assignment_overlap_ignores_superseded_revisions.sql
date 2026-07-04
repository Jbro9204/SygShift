create or replace function private.enforce_assignment_capacity_and_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  active_assignment_count integer;
  target_start_date date;
  target_end_date date;
begin
  if new.status = 'canceled' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.shift_id::text));

  select * into target_shift
  from public.shifts shift
  where shift.id = new.shift_id;

  target_start_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;
  target_end_date := (target_shift.ends_at at time zone target_shift.time_zone)::date;

  if exists (
    select 1
    from public.time_off_requests request
    where request.employee_id = new.employee_id
      and request.status = 'approved'
      and daterange(request.starts_on, request.ends_on, '[]')
        && daterange(target_start_date, target_end_date, '[]')
  ) then
    raise exception 'The employee has approved time off during this shift.';
  end if;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = new.shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.id <> new.id;

  if active_assignment_count >= target_shift.headcount_required then
    raise exception 'The shift already has its required number of assigned employees.';
  end if;

  if exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    where assignment.employee_id = new.employee_id
      and assignment.id <> new.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and schedule.status <> 'superseded'
      and tstzrange(shift.starts_at, shift.ends_at, '[)')
        && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  ) then
    raise exception 'The employee is already assigned to an overlapping shift.';
  end if;

  return new;
end
$$;

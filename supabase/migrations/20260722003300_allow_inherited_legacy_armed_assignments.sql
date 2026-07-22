begin;

create or replace function private.enforce_shift_qualification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  shift_date date;
  inherited_assignment boolean := false;
begin
  if tg_table_name = 'shift_assignments' and new.status::text = 'canceled' then
    return new;
  end if;

  if tg_table_name = 'shift_requests'
    and new.status::text in ('withdrawn', 'canceled', 'declined')
  then
    return new;
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = new.shift_id;

  shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;

  if not target_shift.requires_armed
    or public.has_valid_credential(new.employee_id, 'armed_guard', shift_date)
  then
    return new;
  end if;

  -- A working draft is a versioned copy of the currently published schedule.
  -- Preserve an unchanged inherited assignment even when its certificate record
  -- has not been uploaded yet. New assignments and changed shift blocks still
  -- pass through the normal armed-credential requirement below.
  if tg_table_name = 'shift_assignments' then
    select schedule.* into target_schedule
    from public.schedules schedule
    where schedule.id = target_shift.schedule_id;

    if target_schedule.status = 'draft'
      and target_schedule.previous_revision_id is not null
    then
      select exists (
        select 1
        from public.shifts previous_shift
        join public.shift_assignments previous_assignment
          on previous_assignment.shift_id = previous_shift.id
        where previous_shift.schedule_id = target_schedule.previous_revision_id
          and previous_shift.post_id is not distinct from target_shift.post_id
          and previous_shift.event_id is not distinct from target_shift.event_id
          and previous_shift.starts_at = target_shift.starts_at
          and previous_shift.ends_at = target_shift.ends_at
          and previous_shift.time_zone = target_shift.time_zone
          and previous_shift.headcount_required = target_shift.headcount_required
          and previous_shift.requires_armed = target_shift.requires_armed
          and previous_assignment.employee_id = new.employee_id
          and previous_assignment.status::text = new.status::text
          and previous_assignment.status::text in ('assigned', 'confirmed', 'completed')
      ) into inherited_assignment;

      if inherited_assignment then
        return new;
      end if;
    end if;
  end if;

  raise exception 'The employee does not hold a valid armed qualification for this shift.';
end
$$;

revoke all on function private.enforce_shift_qualification() from public, anon, authenticated;

comment on function private.enforce_shift_qualification() is
  'Requires armed credentials for new assignments and requests while allowing an unchanged legacy assignment to be inherited into the next schedule draft revision.';

commit;

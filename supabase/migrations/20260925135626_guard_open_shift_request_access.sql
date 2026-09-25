begin;

-- The openings feed is deliberately privileged, while guards can select only
-- their assigned shifts. Validate the one requested shift here without
-- widening SELECT access to the entire schedule.
create or replace function public.submit_shift_request(target_shift_id uuid, request_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_employee_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  request_id uuid;
begin
  if actor_employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if char_length(coalesce(request_note, '')) > 2000 then
    raise check_violation using message = 'The request note exceeds 2,000 characters.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if not found or target_shift.canceled_at is not null or not target_shift.is_open
    or not exists (
      select 1 from public.schedules schedule
      where schedule.id = target_shift.schedule_id and schedule.status = 'published'
    )
  then
    raise check_violation using message = 'This shift is no longer open for requests.';
  end if;

  if target_shift.starts_at <= clock_timestamp() then
    raise check_violation using message = 'This shift has already started.';
  end if;

  if (
    select count(*) from public.shift_assignments assignment
    where assignment.shift_id = target_shift.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) >= target_shift.headcount_required then
    raise check_violation using message = 'All openings for this shift have been filled.';
  end if;

  if target_shift.requires_armed and not public.has_valid_credential(
    actor_employee_id,
    'armed_guard',
    (target_shift.starts_at at time zone target_shift.time_zone)::date
  ) then
    raise insufficient_privilege using message = 'An active armed qualification is required for this shift.';
  end if;

  if exists (
    select 1 from public.shift_requests request
    where request.shift_id = target_shift.id and request.employee_id = actor_employee_id
  ) then
    raise unique_violation using message = 'You already have a request for this shift.';
  end if;

  insert into public.shift_requests (shift_id, employee_id, employee_note)
  values (target_shift.id, actor_employee_id, nullif(btrim(request_note), ''))
  returning id into request_id;

  return request_id;
end
$$;

revoke all on function public.submit_shift_request(uuid, text) from public, anon;
grant execute on function public.submit_shift_request(uuid, text) to authenticated;

commit;

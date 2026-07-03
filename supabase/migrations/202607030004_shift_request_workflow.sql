begin;

alter table public.shift_requests
  add constraint shift_requests_employee_note_length
  check (employee_note is null or char_length(employee_note) <= 2000);

create function public.submit_shift_request(target_shift_id uuid, request_note text default null)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  employee_id uuid := public.current_employee_id();
  request_id uuid;
begin
  if employee_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if char_length(coalesce(request_note, '')) > 2000 then
    raise check_violation using message = 'The request note exceeds 2,000 characters.';
  end if;

  if not exists (
    select 1
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = target_shift_id
      and shift.is_open
      and shift.starts_at > clock_timestamp()
      and schedule.status = 'published'
  ) then
    raise check_violation using message = 'The shift is not available to request.';
  end if;

  insert into public.shift_requests (shift_id, employee_id, employee_note)
  values (target_shift_id, employee_id, nullif(btrim(request_note), ''))
  returning id into request_id;

  return request_id;
end
$$;

create function public.withdraw_shift_request(target_request_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.shift_requests
  set status = 'withdrawn'
  where id = target_request_id
    and employee_id = public.current_employee_id()
    and status = 'pending';

  if not found then
    raise check_violation using message = 'Only a pending request owned by this account can be withdrawn.';
  end if;

  return true;
end
$$;

revoke all on function public.submit_shift_request(uuid, text) from public, anon;
revoke all on function public.withdraw_shift_request(uuid) from public, anon;
grant execute on function public.submit_shift_request(uuid, text) to authenticated;
grant execute on function public.withdraw_shift_request(uuid) to authenticated;

commit;

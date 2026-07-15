set search_path = '';

create or replace function public.decide_time_off_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  request_record public.time_off_requests%rowtype;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to decide time off.';
  end if;

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
  where request.id = target_request_id
    and request.status = 'pending'
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

revoke all on function public.decide_time_off_request(uuid, public.request_status, text) from public, anon;
grant execute on function public.decide_time_off_request(uuid, public.request_status, text) to authenticated;

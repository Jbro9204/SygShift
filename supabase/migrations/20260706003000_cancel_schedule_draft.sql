set search_path = '';

create or replace function public.cancel_schedule_draft(target_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  draft_schedule public.schedules%rowtype;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to cancel schedule drafts.';
  end if;

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.id = target_schedule_id
  for update;

  if not found or draft_schedule.status <> 'draft' then
    raise check_violation using message = 'Only open draft schedules can be canceled.';
  end if;

  update public.schedules
  set
    status = 'archived',
    updated_at = clock_timestamp()
  where id = target_schedule_id;

  return public.get_weekly_schedule_payload(draft_schedule.week_starts_on);
end
$$;

revoke all on function public.cancel_schedule_draft(uuid) from public, anon;
grant execute on function public.cancel_schedule_draft(uuid) to authenticated;

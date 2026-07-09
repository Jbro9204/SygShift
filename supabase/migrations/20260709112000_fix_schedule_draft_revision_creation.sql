set search_path = '';

create or replace function public.ensure_schedule_draft(target_week_starts_on date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  draft_schedule public.schedules%rowtype;
  source_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  next_revision integer;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to work on schedule drafts.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || target_week_starts_on::text));

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1;

  if found then
    return public.get_weekly_schedule_payload(target_week_starts_on);
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
  order by
    case schedule.status when 'published' then 0 when 'superseded' then 1 when 'archived' then 2 else 3 end,
    schedule.revision desc
  limit 1;

  select coalesce(max(schedule.revision), 0) + 1 into next_revision
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    target_week_starts_on,
    next_revision,
    'draft',
    source_schedule.id,
    actor_id
  )
  returning id into new_schedule_id;

  if source_schedule.id is not null then
    for copied_shift in
      select *
      from public.shifts shift
      where shift.schedule_id = source_schedule.id
      order by shift.starts_at, shift.created_at, shift.id
    loop
      insert into public.shifts (
        schedule_id,
        post_id,
        event_id,
        starts_at,
        ends_at,
        headcount_required,
        is_open,
        is_overtime,
        notes,
        created_by
      ) values (
        new_schedule_id,
        copied_shift.post_id,
        copied_shift.event_id,
        copied_shift.starts_at,
        copied_shift.ends_at,
        copied_shift.headcount_required,
        copied_shift.is_open,
        copied_shift.is_overtime,
        copied_shift.notes,
        actor_id
      )
      returning id into copied_shift_id;

      insert into public.shift_assignments (
        shift_id,
        employee_id,
        status,
        assigned_by,
        assigned_at,
        confirmed_at,
        canceled_at,
        cancellation_reason
      )
      select
        copied_shift_id,
        assignment.employee_id,
        assignment.status,
        assignment.assigned_by,
        assignment.assigned_at,
        assignment.confirmed_at,
        assignment.canceled_at,
        assignment.cancellation_reason
      from public.shift_assignments assignment
      where assignment.shift_id = copied_shift.id
        and assignment.status <> 'canceled';
    end loop;
  end if;

  return public.get_weekly_schedule_payload(target_week_starts_on);
end
$$;

revoke all on function public.ensure_schedule_draft(date) from public, anon;
grant execute on function public.ensure_schedule_draft(date) to authenticated;

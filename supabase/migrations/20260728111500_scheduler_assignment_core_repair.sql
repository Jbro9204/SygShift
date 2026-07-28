begin;

create or replace function private.can_manage_schedule_drafts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.has_mfa()
    and (
      public.has_effective_permission('schedule.manage')
      or public.has_effective_permission('scheduler.manage')
      or public.is_supervisor_or_admin()
    ),
    false
  )
$$;

comment on function private.can_manage_schedule_drafts() is
  'Central MFA-protected permission check for creating and editing schedule drafts.';

create or replace function public.update_schedule_draft_shift(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_employee_id uuid default null,
  target_availability_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  shift_time_zone text;
  updated_start timestamptz;
  updated_end timestamptz;
  new_assignment_id uuid;
  availability_conflict_id uuid;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit schedule drafts.';
  end if;

  if clean_availability_override_note is not null and char_length(clean_availability_override_note) > 2000 then
    raise check_violation using message = 'Availability override notes must be 2,000 characters or fewer.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Start a schedule draft before editing this shift.';
  end if;

  if target_headcount is null or target_headcount < 1 or target_headcount > 50 then
    raise check_violation using message = 'Headcount must be between 1 and 50.';
  end if;

  shift_time_zone := target_shift.time_zone;
  updated_start := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  updated_end := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

  if target_employee_id is not null and not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  if target_employee_id is not null and target_shift.requires_armed and not public.has_valid_credential(
    target_employee_id,
    'armed_guard',
    shift_operational_date
  ) then
    raise check_violation using message = 'The selected employee does not have the armed credential required for this shift.';
  end if;

  if target_employee_id is not null then
    availability_conflict_id := private.assignment_availability_conflict(target_employee_id, updated_start, updated_end, shift_time_zone);
    if availability_conflict_id is not null and clean_availability_override_note is null then
      raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
    end if;
  end if;

  delete from public.shift_assignments assignment
  where assignment.shift_id = target_shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed');

  update public.shifts shift
  set
    starts_at = updated_start,
    ends_at = updated_end,
    headcount_required = target_headcount,
    is_open = coalesce(target_is_open, target_employee_id is null),
    is_overtime = coalesce(target_is_overtime, false),
    notes = nullif(btrim(coalesce(target_notes, '')), ''),
    updated_at = clock_timestamp()
  where shift.id = target_shift_id;

  if target_employee_id is not null then
    insert into public.shift_assignments (
      shift_id,
      employee_id,
      status,
      assigned_by
    ) values (
      target_shift_id,
      target_employee_id,
      'assigned',
      actor_id
    )
    returning id into new_assignment_id;

    if availability_conflict_id is not null then
      insert into public.schedule_assignment_overrides (
        shift_id,
        employee_id,
        override_kind,
        note,
        created_by
      ) values (
        target_shift_id,
        target_employee_id,
        'availability',
        clean_availability_override_note,
        actor_id
      );
    end if;
  end if;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

create or replace function public.update_schedule_draft_shift(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  updated_start timestamptz;
  updated_end timestamptz;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  availability_conflict_id uuid;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit schedule drafts.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  updated_start := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
  updated_end := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone target_shift.time_zone;

  if target_employee_id is null
    or not target_shift.requires_armed
    or public.has_valid_credential(target_employee_id, 'armed_guard', shift_operational_date)
  then
    return public.update_schedule_draft_shift(
      target_shift_id,
      shift_operational_date,
      shift_start_time,
      shift_end_time,
      target_headcount,
      target_is_open,
      target_is_overtime,
      target_notes,
      target_employee_id,
      target_availability_override_note
    );
  end if;

  if not private.can_override_schedule_warnings() then
    raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
  end if;

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Start a schedule draft before editing this shift.';
  end if;

  if target_headcount is null or target_headcount < 1 or target_headcount > 50 then
    raise check_violation using message = 'Headcount must be between 1 and 50.';
  end if;

  if clean_credential_override_note is null then
    raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
  end if;

  if char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  availability_conflict_id := private.assignment_availability_conflict(target_employee_id, updated_start, updated_end, target_shift.time_zone);
  if availability_conflict_id is not null and clean_availability_override_note is null then
    raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
  end if;

  perform public.update_schedule_draft_shift(
    target_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    null,
    null
  );

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by
  ) values (
    target_shift_id,
    target_employee_id,
    'armed_credential',
    clean_credential_override_note,
    actor_id
  );

  if availability_conflict_id is not null then
    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift_id,
      target_employee_id,
      'availability',
      clean_availability_override_note,
      actor_id
    );
  end if;

  insert into public.shift_assignments (
    shift_id,
    employee_id,
    status,
    assigned_by
  ) values (
    target_shift_id,
    target_employee_id,
    'assigned',
    actor_id
  );

  update public.shifts shift
  set
    is_open = coalesce(target_is_open, target_headcount > 1),
    updated_at = clock_timestamp()
  where shift.id = target_shift_id;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

revoke all on function private.can_manage_schedule_drafts() from public, anon, authenticated;
revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text) from public, anon;
revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) from public, anon;

grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text) to authenticated;
grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) to authenticated;

commit;

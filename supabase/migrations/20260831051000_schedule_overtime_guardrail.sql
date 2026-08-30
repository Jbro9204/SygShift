begin;

alter table public.schedule_assignment_overrides
  drop constraint if exists schedule_assignment_overrides_kind_check;

alter table public.schedule_assignment_overrides
  add constraint schedule_assignment_overrides_kind_check
  check (override_kind in ('availability', 'armed_credential', 'scheduled_overtime'));

alter function public.scheduler_add_draft_shift_assignment(uuid, uuid, text, text)
  rename to scheduler_add_draft_shift_assignment_core;

create or replace function private.scheduled_overtime_preview(
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
  local_shift_date date;
  week_start date;
  week_end date;
  current_minutes integer := 0;
  proposed_minutes integer := 0;
  resulting_minutes integer := 0;
  overtime_minutes integer := 0;
begin
  if target_shift_id is null or target_employee_id is null then
    raise check_violation using message = 'Choose a shift and an employee before calculating scheduled overtime.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    raise check_violation using message = 'The schedule for this shift could not be found.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  local_shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;
  week_start := local_shift_date - extract(dow from local_shift_date)::integer;
  week_end := week_start + 6;
  proposed_minutes := greatest(0, round(extract(epoch from (target_shift.ends_at - target_shift.starts_at)) / 60.0)::integer);

  select coalesce(sum(
    greatest(0, round(extract(epoch from (scheduled_shift.ends_at - scheduled_shift.starts_at)) / 60.0)::integer)
  ), 0)::integer
  into current_minutes
  from public.shift_assignments assignment
  join public.shifts scheduled_shift on scheduled_shift.id = assignment.shift_id
  where assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and scheduled_shift.schedule_id = target_schedule.id
    and scheduled_shift.id <> target_shift.id
    and scheduled_shift.canceled_at is null
    and (scheduled_shift.starts_at at time zone scheduled_shift.time_zone)::date between week_start and week_end;

  resulting_minutes := current_minutes + proposed_minutes;
  overtime_minutes := greatest(0, resulting_minutes - 2400);

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'shiftId', target_shift.id,
    'weekStartsOn', week_start::text,
    'weekEndsOn', week_end::text,
    'currentMinutes', current_minutes,
    'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes,
    'overtimeMinutes', overtime_minutes,
    'requiresOverride', resulting_minutes > 2400
  );
end
$$;

create or replace function public.get_scheduled_overtime_preview(
  target_shift_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  return private.scheduled_overtime_preview(target_shift_id, target_employee_id);
end
$$;

create or replace function public.scheduler_add_draft_shift_assignment_v2(
  target_shift_id uuid,
  target_employee_id uuid,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  overtime_preview jsonb;
  clean_overtime_note text := nullif(btrim(coalesce(target_overtime_override_note, '')), '');
  result_payload jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to add a guard.';
  end if;

  if clean_overtime_note is not null and char_length(clean_overtime_note) > 2000 then
    raise check_violation using message = 'Scheduled overtime approval notes must be 2,000 characters or fewer.';
  end if;

  if exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id
      and assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) then
    return public.scheduler_add_draft_shift_assignment_core(
      target_shift_id,
      target_employee_id,
      target_availability_override_note,
      target_credential_override_note
    );
  end if;

  overtime_preview := private.scheduled_overtime_preview(target_shift_id, target_employee_id);

  if coalesce((overtime_preview ->> 'requiresOverride')::boolean, false) then
    if not private.can_override_schedule_warnings() then
      raise insufficient_privilege using message = 'MFA-verified schedule override access is required to approve scheduled overtime.';
    end if;

    if clean_overtime_note is null then
      raise check_violation using message = format(
        'This assignment would schedule %s hours for the week, including %s overtime hours. Add an approval note to continue.',
        round(coalesce((overtime_preview ->> 'resultingMinutes')::numeric, 0) / 60.0, 2),
        round(coalesce((overtime_preview ->> 'overtimeMinutes')::numeric, 0) / 60.0, 2)
      );
    end if;

    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift_id,
      target_employee_id,
      'scheduled_overtime',
      clean_overtime_note,
      actor_id
    );
  end if;

  result_payload := public.scheduler_add_draft_shift_assignment_core(
    target_shift_id,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );

  if coalesce((overtime_preview ->> 'requiresOverride')::boolean, false) then
    insert into private.audit_events (
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      auth.uid(),
      actor_id,
      'public',
      'schedule_assignment_overrides',
      'approve_scheduled_overtime',
      target_shift_id::text,
      overtime_preview || jsonb_build_object(
        'assignedEmployeeId', target_employee_id,
        'approvalNote', clean_overtime_note
      )
    );
  end if;

  return result_payload;
end
$$;

create or replace function public.scheduler_add_draft_shift_assignment(
  target_shift_id uuid,
  target_employee_id uuid,
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
  target_shift public.shifts%rowtype;
  automatic_overtime_note text;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if target_shift.is_overtime then
    automatic_overtime_note := nullif(btrim(coalesce(target_shift.notes, '')), '');
  end if;

  return public.scheduler_add_draft_shift_assignment_v2(
    target_shift_id,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note,
    automatic_overtime_note
  );
end
$$;

create or replace function private.scheduled_overtime_update_preview(
  target_shift_id uuid,
  target_employee_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time
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
  proposed_starts_at timestamptz;
  proposed_ends_at timestamptz;
  week_start date;
  week_end date;
  current_minutes integer := 0;
  proposed_minutes integer := 0;
  resulting_minutes integer := 0;
  overtime_minutes integer := 0;
  approval_carried_forward boolean := false;
begin
  if target_shift_id is null or target_employee_id is null then
    raise check_violation using message = 'Choose a shift and an employee before calculating scheduled overtime.';
  end if;

  if shift_operational_date is null or shift_start_time is null or shift_end_time is null then
    raise check_violation using message = 'Choose a valid date, start time, and end time.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    raise check_violation using message = 'The schedule for this shift could not be found.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  proposed_starts_at := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
  proposed_ends_at := (
    (case when shift_end_time <= shift_start_time then shift_operational_date + 1 else shift_operational_date end)
    + shift_end_time
  ) at time zone target_shift.time_zone;

  week_start := shift_operational_date - extract(dow from shift_operational_date)::integer;
  week_end := week_start + 6;
  proposed_minutes := greatest(0, round(extract(epoch from (proposed_ends_at - proposed_starts_at)) / 60.0)::integer);

  select coalesce(sum(
    greatest(0, round(extract(epoch from (scheduled_shift.ends_at - scheduled_shift.starts_at)) / 60.0)::integer)
  ), 0)::integer
  into current_minutes
  from public.shift_assignments assignment
  join public.shifts scheduled_shift on scheduled_shift.id = assignment.shift_id
  where assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and scheduled_shift.schedule_id = target_schedule.id
    and scheduled_shift.id <> target_shift.id
    and scheduled_shift.canceled_at is null
    and (scheduled_shift.starts_at at time zone scheduled_shift.time_zone)::date between week_start and week_end;

  resulting_minutes := current_minutes + proposed_minutes;
  overtime_minutes := greatest(0, resulting_minutes - 2400);

  approval_carried_forward := target_shift.starts_at = proposed_starts_at
    and target_shift.ends_at = proposed_ends_at
    and exists (
      select 1
      from public.shift_assignments assignment
      where assignment.shift_id = target_shift.id
        and assignment.employee_id = target_employee_id
        and assignment.status in ('assigned', 'confirmed', 'completed')
    )
    and exists (
      select 1
      from public.schedule_assignment_overrides assignment_override
      where assignment_override.shift_id = target_shift.id
        and assignment_override.employee_id = target_employee_id
        and assignment_override.override_kind = 'scheduled_overtime'
    );

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'shiftId', target_shift.id,
    'weekStartsOn', week_start::text,
    'weekEndsOn', week_end::text,
    'currentMinutes', current_minutes,
    'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes,
    'overtimeMinutes', overtime_minutes,
    'requiresOverride', resulting_minutes > 2400 and not approval_carried_forward,
    'approvalCarriedForward', approval_carried_forward
  );
end
$$;

create or replace function public.get_scheduled_overtime_update_preview(
  target_shift_id uuid,
  target_employee_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  return private.scheduled_overtime_update_preview(
    target_shift_id,
    target_employee_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time
  );
end
$$;

create or replace function public.scheduler_update_typed_draft_shift_v2(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  overtime_preview jsonb;
  clean_overtime_note text := nullif(btrim(coalesce(target_overtime_override_note, '')), '');
  approval_carried_forward boolean := false;
  result_payload jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit a draft shift.';
  end if;

  if clean_overtime_note is not null and char_length(clean_overtime_note) > 2000 then
    raise check_violation using message = 'Scheduled overtime approval notes must be 2,000 characters or fewer.';
  end if;

  if target_employee_id is not null then
    overtime_preview := private.scheduled_overtime_update_preview(
      target_shift_id,
      target_employee_id,
      shift_operational_date,
      shift_start_time,
      shift_end_time
    );
    approval_carried_forward := coalesce((overtime_preview ->> 'approvalCarriedForward')::boolean, false);

    if coalesce((overtime_preview ->> 'requiresOverride')::boolean, false) then
      if not private.can_override_schedule_warnings() then
        raise insufficient_privilege using message = 'MFA-verified schedule override access is required to approve scheduled overtime.';
      end if;

      if clean_overtime_note is null then
        raise check_violation using message = format(
          'This change would schedule %s hours for the week, including %s overtime hours. Add an approval note to continue.',
          round(coalesce((overtime_preview ->> 'resultingMinutes')::numeric, 0) / 60.0, 2),
          round(coalesce((overtime_preview ->> 'overtimeMinutes')::numeric, 0) / 60.0, 2)
        );
      end if;
    end if;
  end if;

  if not approval_carried_forward then
    delete from public.schedule_assignment_overrides assignment_override
    where assignment_override.shift_id = target_shift_id
      and assignment_override.override_kind = 'scheduled_overtime';
  end if;

  if target_employee_id is not null
    and coalesce((overtime_preview ->> 'requiresOverride')::boolean, false)
  then
    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift_id,
      target_employee_id,
      'scheduled_overtime',
      clean_overtime_note,
      actor_id
    );
  end if;

  result_payload := public.scheduler_update_typed_draft_shift(
    target_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    target_work_type,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );

  if target_employee_id is not null
    and coalesce((overtime_preview ->> 'requiresOverride')::boolean, false)
  then
    insert into private.audit_events (
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      auth.uid(),
      actor_id,
      'public',
      'schedule_assignment_overrides',
      'approve_scheduled_overtime_edit',
      target_shift_id::text,
      overtime_preview || jsonb_build_object(
        'assignedEmployeeId', target_employee_id,
        'approvalNote', clean_overtime_note
      )
    );
  end if;

  return result_payload;
end
$$;

revoke all on function private.scheduled_overtime_preview(uuid, uuid) from public, anon, authenticated;
revoke all on function private.scheduled_overtime_update_preview(uuid, uuid, date, time, time) from public, anon, authenticated;
revoke all on function public.scheduler_add_draft_shift_assignment_core(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_scheduled_overtime_preview(uuid, uuid) from public, anon;
revoke all on function public.get_scheduled_overtime_update_preview(uuid, uuid, date, time, time) from public, anon;
revoke all on function public.scheduler_add_draft_shift_assignment_v2(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.scheduler_add_draft_shift_assignment(uuid, uuid, text, text) from public, anon;
revoke all on function public.scheduler_update_typed_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.scheduler_update_typed_draft_shift_v2(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text) from public, anon;

grant execute on function public.get_scheduled_overtime_preview(uuid, uuid) to authenticated;
grant execute on function public.get_scheduled_overtime_update_preview(uuid, uuid, date, time, time) to authenticated;
grant execute on function public.scheduler_add_draft_shift_assignment_v2(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.scheduler_add_draft_shift_assignment(uuid, uuid, text, text) to authenticated;
grant execute on function public.scheduler_update_typed_draft_shift_v2(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text) to authenticated;

comment on function public.get_scheduled_overtime_preview(uuid, uuid) is
  'Calculates Sunday-through-Saturday scheduled hours for a proposed draft assignment, including overnight shifts by their local start date.';

comment on function public.scheduler_add_draft_shift_assignment_v2(uuid, uuid, text, text, text) is
  'Adds an employee to a draft shift with credential, availability, and scheduled-overtime guardrails plus audited overrides.';

comment on function public.get_scheduled_overtime_update_preview(uuid, uuid, date, time, time) is
  'Calculates Sunday-through-Saturday scheduled hours for a proposed shift edit and carries forward an unchanged approval safely.';

comment on function public.scheduler_update_typed_draft_shift_v2(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text) is
  'Edits a typed draft shift with credential, availability, and scheduled-overtime guardrails plus audited overrides.';

notify pgrst, 'reload schema';

commit;

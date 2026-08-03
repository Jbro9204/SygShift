begin;

create or replace function public.resolve_schedule_review_shift(
  target_shift_id uuid,
  target_employee_id uuid,
  resolution_note text default null,
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
  source_shift public.shifts%rowtype;
  source_schedule public.schedules%rowtype;
  latest_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  new_revision integer;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
  resolved_shift_id uuid;
  active_assignment_count integer;
  target_already_assigned boolean := false;
  credential_override_required boolean := false;
  shift_date date;
  clean_note text := nullif(btrim(coalesce(resolution_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to resolve schedule review items.';
  end if;

  if target_shift_id is null or target_employee_id is null then
    raise check_violation using message = 'A shift and employee are required.';
  end if;

  if clean_note is not null and char_length(clean_note) > 2000 then
    raise check_violation using message = 'Resolution notes must be 2,000 characters or fewer.';
  end if;

  if clean_credential_override_note is not null and char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  select shift.* into source_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.id = source_shift.schedule_id;

  if not found then
    raise no_data_found using message = 'The selected shift is missing its schedule.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-week:' || source_schedule.week_starts_on::text));

  select schedule.* into latest_schedule
  from public.schedules schedule
  where schedule.week_starts_on = source_schedule.week_starts_on
  order by schedule.revision desc
  limit 1;

  if latest_schedule.id is distinct from source_schedule.id then
    raise check_violation using message = 'This shift is not on the latest schedule revision. Refresh the schedule before resolving it.';
  end if;

  if latest_schedule.status <> 'published' then
    raise check_violation using message = 'Only published schedule revisions can be resolved.';
  end if;

  if source_shift.notes is null
    or source_shift.notes !~* '(needs supervisor review|import skipped|guardrail)'
  then
    raise check_violation using message = 'This shift is not marked for supervisor review.';
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

  select exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = source_shift.id
      and assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) into target_already_assigned;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = source_shift.id
    and assignment.status in ('assigned', 'confirmed', 'completed');

  if not target_already_assigned and active_assignment_count >= source_shift.headcount_required then
    raise check_violation using message = 'This shift is already covered. Confirm one of the currently assigned employees, or use the shift editor to replace an assignment.';
  end if;

  shift_date := (source_shift.starts_at at time zone source_shift.time_zone)::date;

  if not target_already_assigned
    and source_shift.requires_armed
    and not public.has_valid_credential(target_employee_id, 'armed_guard', shift_date)
  then
    if not private.can_override_schedule_warnings() then
      raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
    end if;

    if clean_credential_override_note is null then
      raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
    end if;

    credential_override_required := true;
  end if;

  new_revision := latest_schedule.revision + 1;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    latest_schedule.week_starts_on,
    new_revision,
    'draft',
    latest_schedule.id,
    actor_id
  )
  returning id into new_schedule_id;

  for copied_shift in
    select shift.*
    from public.shifts shift
    where shift.schedule_id = latest_schedule.id
      and shift.canceled_at is null
    order by shift.starts_at, shift.created_at, shift.id
  loop
    copied_shift_id := private.copy_schedule_shift_block(
      copied_shift.id,
      new_schedule_id,
      actor_id,
      null,
      null
    );

    if copied_shift.id = target_shift_id then
      resolved_shift_id := copied_shift_id;
    end if;
  end loop;

  if resolved_shift_id is null then
    raise check_violation using message = 'The resolved shift could not be copied into the new revision.';
  end if;

  update public.shifts shift
  set
    notes = concat_ws(
      E'\n',
      regexp_replace(
        regexp_replace(
          coalesce(shift.notes, ''),
          E'Assignment status: needs supervisor review before payroll reliance\\.',
          case
            when target_already_assigned then 'Assignment status: supervisor reviewed; current coverage retained.'
            else 'Assignment status: supervisor reviewed and assigned.'
          end,
          'gi'
        ),
        E'Assignment import skipped by system guardrail: .*',
        'Assignment import skipped by system guardrail: resolved by supervisor revision.',
        'gi'
      ),
      case
        when target_already_assigned then 'Supervisor resolution: current coverage retained by '
        else 'Supervisor resolution: assignment completed by '
      end || actor_id::text || ' on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ'),
      case when clean_note is not null then 'Supervisor note: ' || clean_note else null end
    ),
    updated_at = clock_timestamp()
  where shift.id = resolved_shift_id;

  if not target_already_assigned then
    if credential_override_required then
      insert into public.schedule_assignment_overrides (
        shift_id,
        employee_id,
        override_kind,
        note,
        created_by
      ) values (
        resolved_shift_id,
        target_employee_id,
        'armed_credential',
        clean_credential_override_note,
        actor_id
      );

      perform set_config('app.allow_armed_credential_override', 'on', true);
    end if;

    insert into public.shift_assignments (
      shift_id,
      employee_id,
      status,
      assigned_by
    ) values (
      resolved_shift_id,
      target_employee_id,
      'assigned',
      actor_id
    );
  end if;

  update public.shifts shift
  set
    is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
    updated_at = clock_timestamp()
  where shift.id = resolved_shift_id;

  update public.schedules
  set status = 'superseded'
  where id = latest_schedule.id;

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id
  where id = new_schedule_id;

  return jsonb_build_object(
    'schedule_id', new_schedule_id,
    'schedule_revision', new_revision,
    'shift_id', resolved_shift_id,
    'employee_id', target_employee_id,
    'retained_current_assignment', target_already_assigned
  );
end
$$;

comment on function public.resolve_schedule_review_shift(uuid, uuid, text, text) is
  'Resolves imported schedule review items by retaining valid current coverage or assigning an employee into an open slot, while preserving source history.';

revoke all on function public.resolve_schedule_review_shift(uuid, uuid, text, text) from public, anon;
grant execute on function public.resolve_schedule_review_shift(uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;

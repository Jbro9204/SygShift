begin;

alter table public.schedule_assignment_overrides
  drop constraint if exists schedule_assignment_overrides_kind_check;

alter table public.schedule_assignment_overrides
  add constraint schedule_assignment_overrides_kind_check
  check (override_kind in ('availability', 'armed_credential'));

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

  if tg_table_name = 'shift_assignments'
    and (
      exists (
        select 1
        from public.schedule_assignment_overrides override_record
        where override_record.shift_id = new.shift_id
          and override_record.employee_id = new.employee_id
          and override_record.override_kind = 'armed_credential'
      )
      or (
        current_setting('app.allow_armed_credential_override', true) = 'on'
        and public.is_supervisor_or_admin()
        and public.has_mfa()
      )
    )
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
  'Requires armed credentials for assignments and requests while allowing MFA-verified schedule overrides recorded in schedule_assignment_overrides.';

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

  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to use an armed credential override.';
  end if;

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Start a schedule draft before editing this shift.';
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
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
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

  update public.shifts
  set
    is_open = coalesce(target_is_open, target_headcount > 1),
    updated_at = clock_timestamp()
  where id = target_shift_id;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) from public, anon;
grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) to authenticated;

create or replace function public.create_supervisor_open_shift(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  event_requires_armed boolean,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  publish_announcement boolean default true,
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
  shift_time_zone text;
  shift_requires_armed boolean := coalesce(event_requires_armed, false);
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  availability_conflict_id uuid;
  created_result jsonb;
  new_shift_id uuid;
  new_assignment_id uuid;
begin
  if target_post_id is not null then
    select site.time_zone, post.requires_armed
      into shift_time_zone, shift_requires_armed
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id;
  else
    shift_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
  end if;

  shift_starts_at := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  shift_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

  if target_employee_id is null
    or not shift_requires_armed
    or public.has_valid_credential(target_employee_id, 'armed_guard', (shift_starts_at at time zone shift_time_zone)::date)
  then
    return public.create_supervisor_open_shift(
      target_week_starts_on,
      target_post_id,
      event_name,
      event_location_name,
      event_site_id,
      event_time_zone,
      event_requires_armed,
      shift_operational_date,
      shift_start_time,
      shift_end_time,
      target_headcount,
      target_is_overtime,
      target_notes,
      publish_announcement,
      target_employee_id,
      target_availability_override_note
    );
  end if;

  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to use an armed credential override.';
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
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  availability_conflict_id := private.assignment_availability_conflict(target_employee_id, shift_starts_at, shift_ends_at, shift_time_zone);
  if availability_conflict_id is not null and clean_availability_override_note is null then
    raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
  end if;

  created_result := public.create_supervisor_open_shift(
    target_week_starts_on,
    target_post_id,
    event_name,
    event_location_name,
    event_site_id,
    event_time_zone,
    event_requires_armed,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_overtime,
    target_notes,
    false,
    null,
    null
  );

  new_shift_id := (created_result ->> 'shift_id')::uuid;

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by
  ) values (
    new_shift_id,
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
      new_shift_id,
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
    new_shift_id,
    target_employee_id,
    'assigned',
    actor_id
  )
  returning id into new_assignment_id;

  update public.shifts
  set
    is_open = target_headcount > 1,
    updated_at = clock_timestamp()
  where id = new_shift_id;

  return created_result || jsonb_build_object(
    'assignment_id', new_assignment_id,
    'announcement_id', null
  );
end
$$;

revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) from public, anon;
grant execute on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) to authenticated;

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
  target_shift public.shifts%rowtype;
  shift_date date;
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  resolved_result jsonb;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;

  if not target_shift.requires_armed
    or public.has_valid_credential(target_employee_id, 'armed_guard', shift_date)
  then
    return public.resolve_schedule_review_shift(target_shift_id, target_employee_id, resolution_note);
  end if;

  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to use an armed credential override.';
  end if;

  if clean_credential_override_note is null then
    raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
  end if;

  if char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  perform set_config('app.allow_armed_credential_override', 'on', true);
  resolved_result := public.resolve_schedule_review_shift(target_shift_id, target_employee_id, resolution_note);

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by
  ) values (
    (resolved_result ->> 'shift_id')::uuid,
    target_employee_id,
    'armed_credential',
    clean_credential_override_note,
    actor_id
  );

  return resolved_result;
end
$$;

revoke all on function public.resolve_schedule_review_shift(uuid, uuid, text, text) from public, anon;
grant execute on function public.resolve_schedule_review_shift(uuid, uuid, text, text) to authenticated;

commit;

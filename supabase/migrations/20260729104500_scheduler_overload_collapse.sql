begin;

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
  shift_time_zone text;
  updated_start timestamptz;
  updated_end timestamptz;
  new_assignment_id uuid;
  availability_conflict_id uuid;
  credential_override_required boolean := false;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit schedule drafts.';
  end if;

  if clean_availability_override_note is not null and char_length(clean_availability_override_note) > 2000 then
    raise check_violation using message = 'Availability override notes must be 2,000 characters or fewer.';
  end if;

  if clean_credential_override_note is not null and char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
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

  if target_employee_id is not null then
    availability_conflict_id := private.assignment_availability_conflict(target_employee_id, updated_start, updated_end, shift_time_zone);
    if availability_conflict_id is not null and clean_availability_override_note is null then
      raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
    end if;
  end if;

  if target_employee_id is not null
    and target_shift.requires_armed
    and not public.has_valid_credential(target_employee_id, 'armed_guard', shift_operational_date)
  then
    if not private.can_override_schedule_warnings() then
      raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
    end if;

    if clean_credential_override_note is null then
      raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
    end if;

    credential_override_required := true;
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
    if credential_override_required then
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

      perform set_config('app.allow_armed_credential_override', 'on', true);
    end if;

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
    )
    returning id into new_assignment_id;
  end if;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

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
  latest_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  new_revision integer := 1;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
  new_event_id uuid;
  new_shift_id uuid;
  new_assignment_id uuid;
  new_announcement_id uuid;
  shift_time_zone text;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  location_label text;
  announcement_kind public.announcement_kind;
  is_event_shift boolean := target_post_id is null;
  shift_requires_armed boolean := false;
  availability_conflict_id uuid;
  credential_override_required boolean := false;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create schedule openings.';
  end if;

  if clean_availability_override_note is not null and char_length(clean_availability_override_note) > 2000 then
    raise check_violation using message = 'Availability override notes must be 2,000 characters or fewer.';
  end if;

  if clean_credential_override_note is not null and char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  if target_week_starts_on is null
    or shift_operational_date is null
    or shift_start_time is null
    or shift_end_time is null
  then
    raise check_violation using message = 'Week, date, start time, and end time are required.';
  end if;

  if target_headcount is null or target_headcount < 1 or target_headcount > 50 then
    raise check_violation using message = 'Headcount must be between 1 and 50.';
  end if;

  if (target_post_id is null) = (nullif(btrim(coalesce(event_name, '')), '') is null) then
    raise check_violation using message = 'Choose one permanent post or enter one event name.';
  end if;

  if target_employee_id is not null and not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  if target_post_id is not null and not exists (
    select 1
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id
      and post.active
      and site.active
  ) then
    raise check_violation using message = 'The selected post is not active.';
  end if;

  select schedule.* into latest_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
  order by schedule.revision desc
  limit 1;

  if found then
    new_revision := latest_schedule.revision + 1;
  end if;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    target_week_starts_on,
    new_revision,
    'draft',
    latest_schedule.id,
    actor_id
  )
  returning id into new_schedule_id;

  if latest_schedule.id is not null then
    for copied_shift in
      select *
      from public.shifts shift
      where shift.schedule_id = latest_schedule.id
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
      where assignment.shift_id = copied_shift.id;
    end loop;
  end if;

  if is_event_shift then
    shift_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
    shift_requires_armed := coalesce(event_requires_armed, false);

    if nullif(btrim(coalesce(event_location_name, '')), '') is null and event_site_id is null then
      raise check_violation using message = 'Event location is required when no site is selected.';
    end if;

    insert into public.events (
      name,
      site_id,
      location_name,
      time_zone,
      starts_at,
      ends_at,
      requires_armed,
      created_by
    ) values (
      btrim(event_name),
      event_site_id,
      nullif(btrim(coalesce(event_location_name, '')), ''),
      shift_time_zone,
      (shift_operational_date + shift_start_time) at time zone shift_time_zone,
      ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone,
      shift_requires_armed,
      actor_id
    )
    returning id into new_event_id;

    location_label := coalesce(nullif(btrim(event_location_name), ''), btrim(event_name));
  else
    select site.time_zone, site.name || ' - ' || post.name, post.requires_armed
      into shift_time_zone, location_label, shift_requires_armed
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id;
  end if;

  shift_starts_at := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  shift_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

  if target_employee_id is not null
    and shift_requires_armed
    and not public.has_valid_credential(target_employee_id, 'armed_guard', (shift_starts_at at time zone shift_time_zone)::date)
  then
    if not private.can_override_schedule_warnings() then
      raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
    end if;

    if clean_credential_override_note is null then
      raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
    end if;

    credential_override_required := true;
  end if;

  if target_employee_id is not null then
    availability_conflict_id := private.assignment_availability_conflict(target_employee_id, shift_starts_at, shift_ends_at, shift_time_zone);
    if availability_conflict_id is not null and clean_availability_override_note is null then
      raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
    end if;
  end if;

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
    target_post_id,
    new_event_id,
    shift_starts_at,
    shift_ends_at,
    target_headcount,
    target_employee_id is null,
    coalesce(target_is_overtime, false),
    nullif(btrim(coalesce(target_notes, '')), ''),
    actor_id
  )
  returning id into new_shift_id;

  if target_employee_id is not null then
    if credential_override_required then
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

      perform set_config('app.allow_armed_credential_override', 'on', true);
    end if;

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
  end if;

  if latest_schedule.status = 'published' then
    update public.schedules
    set status = 'superseded'
    where id = latest_schedule.id;
  end if;

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id
  where id = new_schedule_id;

  if target_employee_id is null and coalesce(publish_announcement, true) then
    announcement_kind := case
      when is_event_shift then 'event'::public.announcement_kind
      when coalesce(target_is_overtime, false) then 'overtime'::public.announcement_kind
      else 'open_shift'::public.announcement_kind
    end;

    insert into public.announcements (
      kind,
      title,
      body,
      shift_id,
      event_id,
      published_at,
      expires_at,
      created_by
    ) values (
      announcement_kind,
      case
        when announcement_kind = 'event' then 'Event shift available'
        when announcement_kind = 'overtime' then 'Overtime shift available'
        else 'Open shift available'
      end,
      concat(
        location_label,
        ' needs ',
        target_headcount,
        case when target_headcount = 1 then ' guard' else ' guards' end,
        ' on ',
        to_char(shift_operational_date, 'FMMonth FMDD, YYYY'),
        ' from ',
        to_char(shift_start_time, 'FMHH12:MI AM'),
        ' to ',
        to_char(shift_end_time, 'FMHH12:MI AM'),
        '.'
      ),
      new_shift_id,
      new_event_id,
      clock_timestamp(),
      shift_ends_at,
      actor_id
    )
    returning id into new_announcement_id;
  end if;

  return jsonb_build_object(
    'schedule_id', new_schedule_id,
    'schedule_revision', new_revision,
    'shift_id', new_shift_id,
    'assignment_id', new_assignment_id,
    'event_id', new_event_id,
    'announcement_id', new_announcement_id,
    'starts_at', shift_starts_at,
    'ends_at', shift_ends_at,
    'time_zone', shift_time_zone
  );
end
$$;

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

  if clean_credential_override_note is not null and char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  select shift.* into source_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.id = source_shift.schedule_id;

  if not found then
    raise no_data_found using message = 'The selected shift is missing its schedule.';
  end if;

  shift_date := (source_shift.starts_at at time zone source_shift.time_zone)::date;

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

  if source_shift.requires_armed
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
    select *
    from public.shifts shift
    where shift.schedule_id = latest_schedule.id
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
      case when copied_shift.id = target_shift_id then false else copied_shift.is_open end,
      copied_shift.is_overtime,
      case
        when copied_shift.id = target_shift_id then concat_ws(
          E'\n',
          regexp_replace(
            regexp_replace(
              coalesce(copied_shift.notes, ''),
              E'Assignment status: needs supervisor review before payroll reliance\\.',
              'Assignment status: supervisor reviewed and assigned.',
              'gi'
            ),
            E'Assignment import skipped by system guardrail: .*',
            'Assignment import skipped by system guardrail: resolved by supervisor revision.',
            'gi'
          ),
          'Supervisor resolution: assigned by ' || actor_id::text || ' on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ'),
          case when clean_note is not null then 'Supervisor note: ' || clean_note else null end
        )
        else copied_shift.notes
      end,
      actor_id
    )
    returning id into copied_shift_id;

    if copied_shift.id = target_shift_id then
      resolved_shift_id := copied_shift_id;
    end if;

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
    where assignment.shift_id = copied_shift.id;
  end loop;

  if resolved_shift_id is null then
    raise check_violation using message = 'The resolved shift could not be copied into the new revision.';
  end if;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = resolved_shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed');

  if active_assignment_count >= source_shift.headcount_required then
    raise check_violation using message = 'The copied shift is already fully assigned.';
  end if;

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
    'employee_id', target_employee_id
  );
end
$$;

drop function if exists public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text);
drop function if exists public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean);
drop function if exists public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text);
drop function if exists public.resolve_schedule_review_shift(uuid, uuid, text);

revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) from public, anon;
revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) from public, anon;
revoke all on function public.resolve_schedule_review_shift(uuid, uuid, text, text) from public, anon;

grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) to authenticated;
grant execute on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) to authenticated;
grant execute on function public.resolve_schedule_review_shift(uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;

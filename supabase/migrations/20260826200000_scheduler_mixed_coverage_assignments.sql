begin;

-- A shift may intentionally differ from the permanent post's default armed
-- requirement. Omitted values still inherit from the post/event; explicit
-- values are preserved for mixed armed/unarmed coverage plans and copies.
alter table public.shifts
  alter column requires_armed drop default;

create or replace function private.set_shift_security_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inherited_requires_armed boolean;
  inherited_time_zone text;
  source_changed boolean := false;
begin
  if new.post_id is not null then
    select post.requires_armed, site.time_zone
      into inherited_requires_armed, inherited_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = new.post_id;
  else
    select event.requires_armed, event.time_zone
      into inherited_requires_armed, inherited_time_zone
    from public.events event
    where event.id = new.event_id;
  end if;

  if inherited_time_zone is null then
    raise check_violation using message = 'The selected Site/Post or event could not be found.';
  end if;

  if tg_op = 'UPDATE' then
    source_changed := new.post_id is distinct from old.post_id
      or new.event_id is distinct from old.event_id;
  end if;

  new.time_zone := inherited_time_zone;
  if new.requires_armed is null
    or (source_changed and new.requires_armed is not distinct from old.requires_armed)
  then
    new.requires_armed := inherited_requires_armed;
  end if;

  return new;
end
$$;

drop trigger if exists shifts_set_security_fields on public.shifts;
create trigger shifts_set_security_fields
before insert or update of post_id, event_id, requires_armed on public.shifts
for each row execute function private.set_shift_security_fields();

revoke all on function private.set_shift_security_fields() from public, anon, authenticated;

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
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  new_assignment_id uuid;
  availability_conflict_id uuid;
  clean_availability_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  shift_date date;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to add a guard.';
  end if;

  if target_shift_id is null or target_employee_id is null then
    raise check_violation using message = 'Choose a shift and an employee.';
  end if;

  if clean_availability_note is not null and char_length(clean_availability_note) > 2000 then
    raise check_violation using message = 'Availability override notes must be 2,000 characters or fewer.';
  end if;

  if clean_credential_note is not null and char_length(clean_credential_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null
  for update;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id
  for update;

  if target_schedule.id is null or target_schedule.status <> 'draft' then
    raise check_violation using message = 'Guards can only be added to the current working draft.';
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

  select assignment.id into new_assignment_id
  from public.shift_assignments assignment
  where assignment.shift_id = target_shift.id
    and assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
  order by assignment.assigned_at desc
  limit 1;

  if new_assignment_id is not null then
    return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
  end if;

  if private.active_shift_assignment_count(target_shift.id) >= target_shift.headcount_required then
    raise check_violation using message = 'Every position in this coverage block is already filled. Use Edit full block for an intentional replacement.';
  end if;

  shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;

  if target_shift.requires_armed
    and not public.has_valid_credential(target_employee_id, 'armed_guard', shift_date)
  then
    if not private.can_override_schedule_warnings() then
      raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
    end if;

    if clean_credential_note is null then
      raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
    end if;

    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift.id,
      target_employee_id,
      'armed_credential',
      clean_credential_note,
      actor_id
    );
  end if;

  availability_conflict_id := private.assignment_availability_conflict(
    target_employee_id,
    target_shift.starts_at,
    target_shift.ends_at,
    target_shift.time_zone
  );

  if availability_conflict_id is not null then
    if not private.can_override_schedule_warnings() then
      raise insufficient_privilege using message = 'MFA-verified schedule override access is required to override employee availability.';
    end if;

    if clean_availability_note is null then
      raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
    end if;

    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift.id,
      target_employee_id,
      'availability',
      clean_availability_note,
      actor_id
    );
  end if;

  insert into public.shift_assignments (
    shift_id,
    employee_id,
    status,
    assigned_by
  ) values (
    target_shift.id,
    target_employee_id,
    'assigned',
    actor_id
  )
  returning id into new_assignment_id;

  update public.shifts shift
  set
    is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
    updated_at = clock_timestamp()
  where shift.id = target_shift.id;

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
    'shift_assignments',
    'add_assignment_to_draft',
    new_assignment_id::text,
    jsonb_build_object(
      'schedule_id', target_schedule.id,
      'shift_id', target_shift.id,
      'assigned_employee_id', target_employee_id,
      'requires_armed', target_shift.requires_armed,
      'availability_override', availability_conflict_id is not null,
      'credential_override', target_shift.requires_armed and clean_credential_note is not null
    )
  );

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

create or replace function public.scheduler_create_coverage_plan(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_armed_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_assignment_requires_armed boolean default false,
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
  draft_schedule public.schedules%rowtype;
  new_event_id uuid;
  armed_shift_id uuid;
  unarmed_shift_id uuid;
  assignment_shift_id uuid;
  new_assignment_id uuid;
  new_announcement_id uuid;
  representative_shift_id uuid;
  shift_ids uuid[] := array[]::uuid[];
  shift_time_zone text;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  location_label text;
  unarmed_headcount integer;
  announcement_kind public.announcement_kind;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create coverage.';
  end if;

  if target_week_starts_on is null
    or shift_operational_date is null
    or shift_start_time is null
    or shift_end_time is null
  then
    raise check_violation using message = 'Week, date, start time, and end time are required.';
  end if;

  if target_headcount is null or target_headcount < 1 or target_headcount > 50 then
    raise check_violation using message = 'Total guards must be between 1 and 50.';
  end if;

  if target_armed_headcount is null
    or target_armed_headcount < 0
    or target_armed_headcount > target_headcount
  then
    raise check_violation using message = 'Armed positions must be between zero and the total guards needed.';
  end if;

  if target_work_type not in ('post', 'training') then
    raise check_violation using message = 'Choose Post Time or Training Time.';
  end if;

  if (target_post_id is null) = (nullif(btrim(coalesce(event_name, '')), '') is null) then
    raise check_violation using message = 'Choose one permanent post or enter one event name.';
  end if;

  if target_employee_id is not null
    and target_assignment_requires_armed
    and target_armed_headcount = 0
  then
    raise check_violation using message = 'This coverage plan does not include an armed position.';
  end if;

  if target_employee_id is not null
    and not target_assignment_requires_armed
    and target_headcount - target_armed_headcount = 0
  then
    raise check_violation using message = 'This coverage plan does not include an unarmed position.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || target_week_starts_on::text));
  perform public.ensure_schedule_draft(target_week_starts_on);

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1
  for update;

  if draft_schedule.id is null then
    raise check_violation using message = 'The working schedule draft could not be opened.';
  end if;

  if target_post_id is not null then
    select site.time_zone, site.name || ' - ' || post.name
      into shift_time_zone, location_label
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id
      and post.active
      and site.active;

    if shift_time_zone is null then
      raise check_violation using message = 'The selected Site/Post is not active.';
    end if;
  else
    shift_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
    if nullif(btrim(coalesce(event_location_name, '')), '') is null and event_site_id is null then
      raise check_violation using message = 'Event location is required when no site is selected.';
    end if;

    shift_starts_at := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
    shift_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

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
      shift_starts_at,
      shift_ends_at,
      target_armed_headcount > 0,
      actor_id
    )
    returning id into new_event_id;

    location_label := coalesce(nullif(btrim(event_location_name), ''), btrim(event_name));
  end if;

  shift_starts_at := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  shift_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;
  unarmed_headcount := target_headcount - target_armed_headcount;

  if target_armed_headcount > 0 then
    insert into public.shifts (
      schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
      headcount_required, requires_armed, is_open, is_overtime,
      notes, work_type, created_by
    ) values (
      draft_schedule.id, target_post_id, new_event_id, shift_starts_at, shift_ends_at, shift_time_zone,
      target_armed_headcount, true, true, coalesce(target_is_overtime, false),
      nullif(btrim(coalesce(target_notes, '')), ''), target_work_type, actor_id
    ) returning id into armed_shift_id;
    shift_ids := array_append(shift_ids, armed_shift_id);
  end if;

  if unarmed_headcount > 0 then
    insert into public.shifts (
      schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
      headcount_required, requires_armed, is_open, is_overtime,
      notes, work_type, created_by
    ) values (
      draft_schedule.id, target_post_id, new_event_id, shift_starts_at, shift_ends_at, shift_time_zone,
      unarmed_headcount, false, true, coalesce(target_is_overtime, false),
      nullif(btrim(coalesce(target_notes, '')), ''), target_work_type, actor_id
    ) returning id into unarmed_shift_id;
    shift_ids := array_append(shift_ids, unarmed_shift_id);
  end if;

  if target_employee_id is not null then
    assignment_shift_id := case when target_assignment_requires_armed then armed_shift_id else unarmed_shift_id end;
    perform public.scheduler_add_draft_shift_assignment(
      assignment_shift_id,
      target_employee_id,
      target_availability_override_note,
      target_credential_override_note
    );

    select assignment.id into new_assignment_id
    from public.shift_assignments assignment
    where assignment.shift_id = assignment_shift_id
      and assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
    order by assignment.assigned_at desc
    limit 1;
  end if;

  representative_shift_id := coalesce(unarmed_shift_id, armed_shift_id);

  if coalesce(publish_announcement, true)
    and exists (
      select 1
      from public.shifts shift
      where shift.id = any(shift_ids)
        and private.active_shift_assignment_count(shift.id) < shift.headcount_required
    )
  then
    announcement_kind := case
      when target_post_id is null then 'event'::public.announcement_kind
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
        when announcement_kind = 'event' then 'Event coverage available'
        when announcement_kind = 'overtime' then 'Overtime coverage available'
        else 'Open coverage available'
      end,
      concat(
        location_label,
        ' needs ', target_headcount,
        case when target_headcount = 1 then ' guard (' else ' guards (' end,
        target_armed_headcount, ' armed, ', unarmed_headcount, ' unarmed) on ',
        to_char(shift_operational_date, 'FMMonth FMDD, YYYY'),
        ' from ', to_char(shift_start_time, 'FMHH12:MI AM'),
        ' to ', to_char(shift_end_time, 'FMHH12:MI AM'), '.'
      ),
      representative_shift_id,
      new_event_id,
      null,
      shift_ends_at,
      actor_id
    ) returning id into new_announcement_id;
  end if;

  update public.schedules schedule
  set updated_at = clock_timestamp()
  where schedule.id = draft_schedule.id;

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
    'shifts',
    'create_coverage_plan',
    draft_schedule.id::text,
    jsonb_build_object(
      'shift_ids', to_jsonb(shift_ids),
      'armed_headcount', target_armed_headcount,
      'unarmed_headcount', unarmed_headcount,
      'assigned_employee_id', target_employee_id,
      'announcement_prepared', new_announcement_id is not null
    )
  );

  return jsonb_build_object(
    'schedule_id', draft_schedule.id,
    'schedule_revision', draft_schedule.revision,
    'shift_ids', to_jsonb(shift_ids),
    'armed_shift_id', armed_shift_id,
    'unarmed_shift_id', unarmed_shift_id,
    'assignment_id', new_assignment_id,
    'event_id', new_event_id,
    'announcement_id', new_announcement_id,
    'starts_at', shift_starts_at,
    'ends_at', shift_ends_at,
    'time_zone', shift_time_zone,
    'headcount', target_headcount,
    'armed_headcount', target_armed_headcount,
    'unarmed_headcount', unarmed_headcount
  );
end
$$;

revoke all on function public.scheduler_add_draft_shift_assignment(uuid, uuid, text, text) from public, anon;
grant execute on function public.scheduler_add_draft_shift_assignment(uuid, uuid, text, text) to authenticated;

revoke all on function public.scheduler_create_coverage_plan(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text) from public, anon;
grant execute on function public.scheduler_create_coverage_plan(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text) to authenticated;

comment on function public.scheduler_add_draft_shift_assignment(uuid, uuid, text, text) is
  'Adds one employee to an open position without replacing existing draft assignments.';

comment on function public.scheduler_create_coverage_plan(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text) is
  'Creates one mixed-qualification coverage plan as separate armed and unarmed draft blocks.';

notify pgrst, 'reload schema';

commit;

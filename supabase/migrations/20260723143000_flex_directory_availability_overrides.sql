alter type public.employment_type add value if not exists 'flex' after 'salary';

create table if not exists public.schedule_assignment_overrides (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,
  override_kind text not null default 'availability',
  note text not null,
  created_by uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint schedule_assignment_overrides_kind_check check (override_kind in ('availability')),
  constraint schedule_assignment_overrides_note_check check (char_length(btrim(note)) between 1 and 2000)
);

alter table public.schedule_assignment_overrides enable row level security;

drop policy if exists "Operations can read schedule assignment overrides" on public.schedule_assignment_overrides;
create policy "Operations can read schedule assignment overrides"
on public.schedule_assignment_overrides
for select
to authenticated
using (
  public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin')
  or employee_id = public.current_employee_id()
);

drop policy if exists "Operations can create schedule assignment overrides" on public.schedule_assignment_overrides;
create policy "Operations can create schedule assignment overrides"
on public.schedule_assignment_overrides
for insert
to authenticated
with check (
  public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin')
  and public.has_mfa()
);

drop trigger if exists schedule_assignment_overrides_audit on public.schedule_assignment_overrides;
create trigger schedule_assignment_overrides_audit
after insert or update or delete on public.schedule_assignment_overrides
for each row execute function private.write_audit_event();

grant select, insert on public.schedule_assignment_overrides to authenticated;

create or replace function private.assignment_availability_conflict(
  target_employee_id uuid,
  target_starts_at timestamptz,
  target_ends_at timestamptz,
  target_time_zone text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  local_date date := (target_starts_at at time zone target_time_zone)::date;
  local_dow integer := extract(dow from target_starts_at at time zone target_time_zone)::integer;
  local_start time := (target_starts_at at time zone target_time_zone)::time;
  local_end time := (target_ends_at at time zone target_time_zone)::time;
  conflict_id uuid;
begin
  select availability.id into conflict_id
  from public.employee_availability availability
  where availability.employee_id = target_employee_id
    and availability.approval_status = 'approved'
    and availability.availability_status = 'unavailable'
    and availability.starts_on <= local_date
    and availability.ends_on >= local_date
    and (availability.day_of_week is null or availability.day_of_week = local_dow)
    and (
      availability.start_time is null
      or availability.end_time is null
      or local_end <= local_start
      or (availability.start_time < local_end and availability.end_time > local_start)
    )
  order by availability.starts_on desc, availability.created_at desc
  limit 1;

  return conflict_id;
end
$$;

create or replace function public.cancel_employee_availability(
  target_availability_id uuid,
  target_note text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.current_employee_id();
begin
  if actor_id is null or public.current_app_role() not in ('dispatcher', 'scheduler', 'supervisor', 'admin') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified scheduler access is required to remove availability.';
  end if;

  update public.employee_availability
  set
    approval_status = 'canceled',
    decision_note = nullif(btrim(coalesce(target_note, '')), ''),
    decided_by = actor_id,
    decided_at = clock_timestamp()
  where id = target_availability_id
    and approval_status in ('pending', 'approved');

  if not found then
    raise no_data_found using message = 'The availability rule was not found or is already closed.';
  end if;
end
$$;

revoke all on function public.cancel_employee_availability(uuid, text) from public, anon;
grant execute on function public.cancel_employee_availability(uuid, text) to authenticated;

drop function if exists public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid);

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
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to edit schedule drafts.';
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
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
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

  delete from public.shift_assignments
  where shift_id = target_shift_id
    and status in ('assigned', 'confirmed', 'completed');

  update public.shifts
  set
    starts_at = updated_start,
    ends_at = updated_end,
    headcount_required = target_headcount,
    is_open = coalesce(target_is_open, target_employee_id is null),
    is_overtime = coalesce(target_is_overtime, false),
    notes = nullif(btrim(coalesce(target_notes, '')), ''),
    updated_at = clock_timestamp()
  where id = target_shift_id;

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

revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text) from public, anon;
grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text) to authenticated;

drop function if exists public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid);

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
  target_availability_override_note text default null
)
returns jsonb
language plpgsql
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
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
begin
  if actor_id is null or not public.is_supervisor_or_admin() then
    raise exception 'Only dispatchers, schedulers, supervisors, and admins can create schedule openings.';
  end if;

  if not public.has_mfa() then
    raise exception 'A verified MFA session is required before changing the schedule.';
  end if;

  if clean_availability_override_note is not null and char_length(clean_availability_override_note) > 2000 then
    raise exception 'Availability override notes must be 2,000 characters or fewer.';
  end if;

  if target_week_starts_on is null
    or shift_operational_date is null
    or shift_start_time is null
    or shift_end_time is null
  then
    raise exception 'Week, date, start time, and end time are required.';
  end if;

  if target_headcount is null or target_headcount < 1 or target_headcount > 50 then
    raise exception 'Headcount must be between 1 and 50.';
  end if;

  if (target_post_id is null) = (nullif(btrim(coalesce(event_name, '')), '') is null) then
    raise exception 'Choose one permanent post or enter one event name.';
  end if;

  if target_employee_id is not null and not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
  ) then
    raise exception 'The selected employee is not active.';
  end if;

  if target_post_id is not null and not exists (
    select 1
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id
      and post.active
      and site.active
  ) then
    raise exception 'The selected post is not active.';
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
      raise exception 'Event location is required when no site is selected.';
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

  if target_employee_id is not null and shift_requires_armed and not public.has_valid_credential(
    target_employee_id,
    'armed_guard',
    (shift_starts_at at time zone shift_time_zone)::date
  ) then
    raise exception 'The selected employee does not have the armed credential required for this shift.';
  end if;

  if target_employee_id is not null then
    availability_conflict_id := private.assignment_availability_conflict(target_employee_id, shift_starts_at, shift_ends_at, shift_time_zone);
    if availability_conflict_id is not null and clean_availability_override_note is null then
      raise exception 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
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
    'announcement_id', new_announcement_id
  );
end
$$;

revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text) from public, anon;
grant execute on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text) to authenticated;

create or replace function public.get_schedule_staffing_suggestions(target_schedule_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with selected_shift as (
    select
      shift.id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.headcount_required,
      (shift.starts_at at time zone shift.time_zone)::date as local_date,
      extract(dow from shift.starts_at at time zone shift.time_zone)::integer as local_dow,
      (shift.starts_at at time zone shift.time_zone)::time as local_start,
      (shift.ends_at at time zone shift.time_zone)::time as local_end,
      greatest(shift.headcount_required - count(assignment.id) filter (where assignment.status in ('assigned', 'confirmed', 'completed')), 0) open_slots
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.shift_assignments assignment on assignment.shift_id = shift.id
    where shift.schedule_id = target_schedule_id
      and schedule.status = 'draft'
      and shift.ends_at > clock_timestamp()
    group by shift.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shiftId', selected_shift.id,
    'openSlots', selected_shift.open_slots,
    'suggestions', coalesce((
      select jsonb_agg(candidate.payload order by candidate.score desc, candidate.name)
      from (
        select
          jsonb_build_object(
            'employeeId', employee.id,
            'name', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
            'role', employee.role,
            'employmentType', employee.employment_type,
            'hasArmedCredential', public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date),
            'reason', concat_ws(
              ' · ',
              case when public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date) then 'armed-qualified' else 'unarmed' end,
              case when exists (
                select 1
                from public.employee_availability availability
                where availability.employee_id = employee.id
                  and availability.approval_status = 'approved'
                  and availability.availability_status = 'available'
                  and availability.starts_on <= selected_shift.local_date
                  and availability.ends_on >= selected_shift.local_date
                  and (availability.day_of_week is null or availability.day_of_week = selected_shift.local_dow)
              ) then 'available on file' end,
              case
                when employee.employment_type::text = 'salary' then 'salary employee'
                when employee.employment_type::text = 'flex' then 'flex employee'
                else 'hourly employee'
              end,
              nullif(profile.schedule_availability, '')
            )
          ) payload,
          btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) name,
          (
            case when selected_shift.requires_armed and public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date) then 50 else 0 end
            + case when not selected_shift.requires_armed then 20 else 0 end
            + case when exists (
                select 1
                from public.employee_availability availability
                where availability.employee_id = employee.id
                  and availability.approval_status = 'approved'
                  and availability.availability_status = 'available'
                  and availability.starts_on <= selected_shift.local_date
                  and availability.ends_on >= selected_shift.local_date
                  and (availability.day_of_week is null or availability.day_of_week = selected_shift.local_dow)
              ) then 35 else 0 end
            + case when lower(coalesce(profile.schedule_availability, '')) like '%' || lower(to_char(selected_shift.starts_at at time zone selected_shift.time_zone, 'Dy')) || '%' then 15 else 0 end
            + case
                when employee.employment_type::text = 'flex' then 12
                when employee.employment_type::text = 'hourly' then 5
                else 0
              end
          ) score
        from public.employees employee
        left join private.employee_operational_profiles profile on profile.employee_id = employee.id
        where employee.status = 'active'
          and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
          and (not selected_shift.requires_armed or public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date))
          and not exists (
            select 1
            from public.employee_availability unavailable
            where unavailable.employee_id = employee.id
              and unavailable.approval_status = 'approved'
              and unavailable.availability_status = 'unavailable'
              and unavailable.starts_on <= selected_shift.local_date
              and unavailable.ends_on >= selected_shift.local_date
              and (unavailable.day_of_week is null or unavailable.day_of_week = selected_shift.local_dow)
              and (
                unavailable.start_time is null
                or unavailable.end_time is null
                or selected_shift.local_end <= selected_shift.local_start
                or (unavailable.start_time < selected_shift.local_end and unavailable.end_time > selected_shift.local_start)
              )
          )
          and not exists (
            select 1
            from public.shift_assignments assignment
            join public.shifts existing_shift on existing_shift.id = assignment.shift_id
            where assignment.employee_id = employee.id
              and assignment.status in ('assigned', 'confirmed', 'completed')
              and existing_shift.id <> selected_shift.id
              and existing_shift.starts_at < selected_shift.ends_at
              and existing_shift.ends_at > selected_shift.starts_at
          )
        order by score desc, employee.last_name, employee.first_name
        limit 5
      ) candidate
    ), '[]'::jsonb)
  ) order by selected_shift.starts_at), '[]'::jsonb)
  from selected_shift
  where selected_shift.open_slots > 0;
$$;

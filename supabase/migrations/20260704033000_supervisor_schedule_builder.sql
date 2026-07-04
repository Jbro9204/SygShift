begin;

create or replace function public.get_schedule_builder_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', post.id,
            'name', post.name,
            'requires_armed', post.requires_armed,
            'site', jsonb_build_object(
              'id', site.id,
              'code', site.code,
              'name', site.name,
              'time_zone', site.time_zone
            )
          )
          order by site.name, post.name
        )
        from public.posts post
        join public.sites site on site.id = post.site_id
        where post.active
          and site.active
      ),
      '[]'::jsonb
    )
  )
  where public.is_supervisor_or_admin()
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
  publish_announcement boolean default true
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
  new_announcement_id uuid;
  shift_time_zone text;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  location_label text;
  announcement_kind public.announcement_kind;
  is_event_shift boolean := target_post_id is null;
begin
  if actor_id is null or not public.is_supervisor_or_admin() then
    raise exception 'Only supervisors and admins can create schedule openings.';
  end if;

  if not public.has_mfa() then
    raise exception 'A verified MFA session is required before changing the schedule.';
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
      order by shift.starts_at, shift.created_at
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
      coalesce(event_requires_armed, false),
      actor_id
    )
    returning id into new_event_id;

    location_label := coalesce(nullif(btrim(event_location_name), ''), btrim(event_name));
  else
    select site.time_zone, site.name || ' - ' || post.name
      into shift_time_zone, location_label
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id;
  end if;

  shift_starts_at := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  shift_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

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
    true,
    coalesce(target_is_overtime, false),
    nullif(btrim(coalesce(target_notes, '')), ''),
    actor_id
  )
  returning id into new_shift_id;

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

  if coalesce(publish_announcement, true) then
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
    'event_id', new_event_id,
    'announcement_id', new_announcement_id,
    'starts_at', shift_starts_at,
    'ends_at', shift_ends_at,
    'time_zone', shift_time_zone
  );
end
$$;

revoke all on function public.get_schedule_builder_options() from public, anon;
revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean) from public, anon;

grant execute on function public.get_schedule_builder_options() to authenticated;
grant execute on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean) to authenticated;

commit;

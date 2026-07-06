set search_path = '';

create or replace function private.enforce_assignment_capacity_and_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  active_assignment_count integer;
  target_start_date date;
  target_end_date date;
begin
  if new.status = 'canceled' then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.shift_id::text));

  select * into target_shift
  from public.shifts shift
  where shift.id = new.shift_id;

  if target_shift.id is null then
    raise foreign_key_violation using message = 'The assigned shift does not exist.';
  end if;

  select * into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    raise foreign_key_violation using message = 'The assigned shift is not linked to a schedule.';
  end if;

  target_start_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;
  target_end_date := (target_shift.ends_at at time zone target_shift.time_zone)::date;

  if exists (
    select 1
    from public.time_off_requests request
    where request.employee_id = new.employee_id
      and request.status = 'approved'
      and daterange(request.starts_on, request.ends_on, '[]')
        && daterange(target_start_date, target_end_date, '[]')
  ) then
    raise exception 'The employee has approved time off during this shift.';
  end if;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = new.shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.id <> new.id;

  if active_assignment_count >= target_shift.headcount_required then
    raise exception 'The shift already has its required number of assigned employees.';
  end if;

  if exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id
    where assignment.employee_id = new.employee_id
      and assignment.id <> new.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and schedule.status in ('draft', 'published')
      and (
        schedule.id = target_schedule.id
        or schedule.week_starts_on <> target_schedule.week_starts_on
      )
      and tstzrange(shift.starts_at, shift.ends_at, '[)')
        && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  ) then
    raise exception 'The employee is already assigned to an overlapping shift.';
  end if;

  return new;
end
$$;

create or replace function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  target_schedule public.schedules%rowtype;
  payload jsonb;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view the schedule.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (
      schedule.status = 'published'
      or (schedule.status = 'draft' and viewer_role in ('dispatcher', 'supervisor', 'admin'))
    )
  order by
    case schedule.status when 'draft' then 0 else 1 end,
    schedule.revision desc
  limit 1;

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'id', target_schedule.id,
    'week_starts_on', target_schedule.week_starts_on,
    'revision', target_schedule.revision,
    'status', target_schedule.status,
    'published_at', target_schedule.published_at,
    'shifts', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', shift.id,
        'starts_at', shift.starts_at,
        'ends_at', shift.ends_at,
        'time_zone', shift.time_zone,
        'headcount_required', shift.headcount_required,
        'requires_armed', shift.requires_armed,
        'is_open', shift.is_open,
        'is_overtime', shift.is_overtime,
        'notes', shift.notes,
        'post', case when post.id is null then null else jsonb_build_object(
          'id', post.id,
          'name', post.name,
          'site', jsonb_build_object(
            'id', site.id,
            'code', site.code,
            'name', site.name
          )
        ) end,
        'event', case when event.id is null then null else jsonb_build_object(
          'id', event.id,
          'name', event.name,
          'location_name', event.location_name,
          'site', case when event_site.id is null then null else jsonb_build_object(
            'id', event_site.id,
            'code', event_site.code,
            'name', event_site.name
          ) end
        ) end,
        'assignments', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', assignment.id,
              'status', assignment.status,
              'employee', jsonb_build_object(
                'id', employee.id,
                'first_name', employee.first_name,
                'last_name', employee.last_name,
                'preferred_name', employee.preferred_name
              )
            )
            order by employee.last_name, employee.first_name, assignment.id
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        )
      )
      order by shift.starts_at, shift.created_at, shift.id
    ) filter (where shift.id is not null), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.schedule_id = target_schedule.id
    and (
      viewer_role in ('dispatcher', 'supervisor', 'admin')
      or not shift.requires_armed
      or public.has_valid_credential(
        viewer_employee_id,
        'armed_guard',
        (shift.starts_at at time zone shift.time_zone)::date
      )
    );

  return payload;
end;
$$;

create or replace function public.ensure_schedule_draft(target_week_starts_on date)
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
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to work on schedule drafts.';
  end if;

  select schedule.* into latest_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status in ('draft', 'published')
  order by
    case schedule.status when 'draft' then 0 else 1 end,
    schedule.revision desc
  limit 1;

  if found and latest_schedule.status = 'draft' then
    return public.get_weekly_schedule_payload(target_week_starts_on);
  end if;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    target_week_starts_on,
    coalesce(latest_schedule.revision, 0) + 1,
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
      where assignment.shift_id = copied_shift.id
        and assignment.status <> 'canceled';
    end loop;
  end if;

  return public.get_weekly_schedule_payload(target_week_starts_on);
end
$$;

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
      schedule.week_starts_on,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.headcount_required,
      greatest(shift.headcount_required - count(assignment.id) filter (where assignment.status in ('assigned', 'confirmed', 'completed')), 0) open_slots
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.shift_assignments assignment on assignment.shift_id = shift.id
    where shift.schedule_id = target_schedule_id
      and schedule.status = 'draft'
    group by shift.id, schedule.week_starts_on
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
            'name', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
            'role', employee.role,
            'employmentType', employee.employment_type,
            'hasArmedCredential', public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date),
            'reason', concat_ws(
              ' · ',
              case when public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date) then 'armed-qualified' else 'unarmed' end,
              case when employee.employment_type = 'salary' then 'salary employee' else 'hourly employee' end,
              nullif(profile.schedule_availability, '')
            )
          ) payload,
          btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) name,
          (
            case when selected_shift.requires_armed and public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date) then 50 else 0 end
            + case when not selected_shift.requires_armed then 20 else 0 end
            + case when lower(coalesce(profile.schedule_availability, '')) like '%' || lower(to_char(selected_shift.starts_at at time zone selected_shift.time_zone, 'Dy')) || '%' then 15 else 0 end
            + case when employee.employment_type = 'hourly' then 5 else 0 end
          ) score
        from public.employees employee
        left join private.employee_operational_profiles profile on profile.employee_id = employee.id
        where employee.status = 'active'
          and employee.role in ('guard', 'dispatcher', 'supervisor', 'admin')
          and (not selected_shift.requires_armed or public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date))
          and not exists (
            select 1
            from public.shift_assignments assignment
            join public.shifts existing_shift on existing_shift.id = assignment.shift_id
            join public.schedules existing_schedule on existing_schedule.id = existing_shift.schedule_id
            where assignment.employee_id = employee.id
              and assignment.status in ('assigned', 'confirmed', 'completed')
              and existing_shift.id <> selected_shift.id
              and existing_schedule.status in ('draft', 'published')
              and (
                existing_schedule.id = target_schedule_id
                or existing_schedule.week_starts_on <> selected_shift.week_starts_on
              )
              and existing_shift.starts_at < selected_shift.ends_at
              and existing_shift.ends_at > selected_shift.starts_at
          )
        order by score desc, employee.last_name, employee.first_name
        limit 5
      ) candidate
    ), '[]'::jsonb)
  ) order by selected_shift.starts_at), '[]'::jsonb)
  from selected_shift
  where selected_shift.open_slots > 0
    and public.is_supervisor_or_admin()
$$;

revoke all on function public.get_weekly_schedule_payload(date) from public, anon;
grant execute on function public.get_weekly_schedule_payload(date) to authenticated;

revoke all on function public.ensure_schedule_draft(date) from public, anon;
grant execute on function public.ensure_schedule_draft(date) to authenticated;

revoke all on function public.get_schedule_staffing_suggestions(uuid) from public, anon;
grant execute on function public.get_schedule_staffing_suggestions(uuid) to authenticated;

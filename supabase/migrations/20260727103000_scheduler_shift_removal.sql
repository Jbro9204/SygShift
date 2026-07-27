set search_path = '';

alter table public.shifts
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by uuid references public.employees(id) on delete restrict,
  add column if not exists cancellation_reason text;

create index if not exists shifts_active_schedule_idx
  on public.shifts(schedule_id, starts_at, id)
  where canceled_at is null;

create or replace function public.remove_schedule_draft_shift(
  target_shift_id uuid,
  removal_note text default null
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
  clean_note text := nullif(btrim(coalesce(removal_note, '')), '');
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified scheduler access is required to remove schedule shifts.';
  end if;

  if clean_note is not null and char_length(clean_note) > 2000 then
    raise check_violation using message = 'Removal notes must be 2,000 characters or fewer.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  if target_shift.canceled_at is not null then
    raise check_violation using message = 'This shift has already been removed.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Open a schedule draft before removing this shift.';
  end if;

  update public.shift_requests
  set
    status = 'canceled',
    decision_note = coalesce(clean_note, 'Removed from schedule draft.'),
    decided_by = actor_id,
    decided_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where shift_id = target_shift_id
    and status = 'pending';

  update public.shift_assignments
  set
    status = 'canceled',
    canceled_at = clock_timestamp(),
    cancellation_reason = coalesce(clean_note, 'Removed from schedule draft.'),
    updated_at = clock_timestamp()
  where shift_id = target_shift_id
    and status <> 'canceled';

  update public.shifts
  set
    is_open = false,
    canceled_at = clock_timestamp(),
    canceled_by = actor_id,
    cancellation_reason = coalesce(clean_note, 'Removed from schedule draft.'),
    updated_at = clock_timestamp()
  where id = target_shift_id;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end;
$$;

revoke all on function public.remove_schedule_draft_shift(uuid, text) from public, anon;
grant execute on function public.remove_schedule_draft_shift(uuid, text) to authenticated;

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
        and shift.canceled_at is null
      order by shift.starts_at, shift.created_at, shift.id
    loop
      insert into public.shifts (
        schedule_id,
        post_id,
        event_id,
        starts_at,
        ends_at,
        time_zone,
        headcount_required,
        requires_armed,
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
        copied_shift.time_zone,
        copied_shift.headcount_required,
        copied_shift.requires_armed,
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
end;
$$;

revoke all on function public.ensure_schedule_draft(date) from public, anon;
grant execute on function public.ensure_schedule_draft(date) to authenticated;

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
      or (schedule.status = 'draft' and viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin'))
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
          'site', jsonb_build_object('id', site.id, 'code', site.code, 'name', site.name)
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
    and shift.canceled_at is null
    and (
      viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
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

revoke all on function public.get_weekly_schedule_payload(date) from public, anon;
grant execute on function public.get_weekly_schedule_payload(date) to authenticated;

create or replace function public.get_open_opportunities_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
  payload jsonb;
begin
  if viewer_employee_id is null or viewer_role is null then
    raise insufficient_privilege using message = 'An active employee account is required to view openings.';
  end if;

  select jsonb_build_object(
    'employeeId', viewer_employee_id,
    'role', viewer_role,
    'opportunities', coalesce(jsonb_agg(jsonb_build_object(
      'id', shift.id,
      'starts_at', shift.starts_at,
      'ends_at', shift.ends_at,
      'time_zone', shift.time_zone,
      'headcount_required', shift.headcount_required,
      'requires_armed', shift.requires_armed,
      'is_overtime', shift.is_overtime,
      'notes', shift.notes,
      'post', case when post.id is null then null else jsonb_build_object(
        'id', post.id,
        'name', post.name,
        'site', jsonb_build_object('id', site.id, 'name', site.name, 'code', site.code)
      ) end,
      'event', case when event.id is null then null else jsonb_build_object(
        'id', event.id,
        'name', event.name,
        'location_name', event.location_name,
        'site', case when event_site.id is null then null else jsonb_build_object(
          'id', event_site.id,
          'name', event_site.name,
          'code', event_site.code
        ) end
      ) end,
      'schedules', jsonb_build_object('status', schedule.status),
      'assignments', (
        select coalesce(jsonb_agg(jsonb_build_object('id', assignment.id, 'status', assignment.status)), '[]'::jsonb)
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status <> 'canceled'
      ),
      'requests', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', request.id,
          'employee_id', request.employee_id,
          'status', request.status
        )), '[]'::jsonb)
        from public.shift_requests request
        where request.shift_id = shift.id
          and (privileged or request.employee_id = viewer_employee_id)
      )
    ) order by shift.starts_at), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.is_open
    and shift.canceled_at is null
    and shift.ends_at > clock_timestamp()
    and (
      privileged
      or not shift.requires_armed
      or public.has_valid_credential(
        viewer_employee_id,
        'armed_guard',
        (shift.starts_at at time zone shift.time_zone)::date
      )
    );

  return coalesce(payload, jsonb_build_object(
    'employeeId', viewer_employee_id,
    'role', viewer_role,
    'opportunities', '[]'::jsonb
  ));
end
$$;

revoke all on function public.get_open_opportunities_payload() from public, anon;
grant execute on function public.get_open_opportunities_payload() to authenticated;

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
      and shift.canceled_at is null
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
              and existing_shift.canceled_at is null
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

revoke all on function public.get_schedule_staffing_suggestions(uuid) from public, anon;
grant execute on function public.get_schedule_staffing_suggestions(uuid) to authenticated;

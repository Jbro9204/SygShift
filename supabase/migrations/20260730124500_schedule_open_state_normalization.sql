begin;

create or replace function private.active_shift_assignment_count(target_shift_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.shift_assignments assignment
  where assignment.shift_id = target_shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
$$;

create or replace function private.normalize_shift_open_state_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.canceled_at is not null then
    new.is_open := false;
    return new;
  end if;

  new.is_open := private.active_shift_assignment_count(new.id) < greatest(coalesce(new.headcount_required, 1), 1);
  return new;
end
$$;

drop trigger if exists shifts_normalize_open_state_before_write on public.shifts;

create trigger shifts_normalize_open_state_before_write
before insert or update of headcount_required, is_open, canceled_at on public.shifts
for each row execute function private.normalize_shift_open_state_before_write();

create or replace function private.refresh_shift_open_state_after_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_shift_id uuid := coalesce(new.shift_id, old.shift_id);
begin
  update public.shifts shift
  set
    is_open = private.active_shift_assignment_count(affected_shift_id) < shift.headcount_required,
    updated_at = clock_timestamp()
  where shift.id = affected_shift_id
    and shift.canceled_at is null
    and exists (
      select 1
      from public.schedules schedule
      where schedule.id = shift.schedule_id
        and schedule.status = 'draft'
    )
    and shift.is_open is distinct from (
      private.active_shift_assignment_count(affected_shift_id) < shift.headcount_required
    );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end
$$;

drop trigger if exists shift_assignments_refresh_open_state_after_write on public.shift_assignments;

create trigger shift_assignments_refresh_open_state_after_write
after insert or update of status, shift_id or delete on public.shift_assignments
for each row execute function private.refresh_shift_open_state_after_assignment();

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
    is_open = true,
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

create or replace function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'private'
as $function$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  can_view_all_schedule boolean := public.has_effective_permission('schedule.view')
    or viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
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
      or (schedule.status = 'draft' and can_view_all_schedule)
    )
  order by schedule.revision desc
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
        'is_open', assignment_count.active_assignments < shift.headcount_required,
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
              ),
              'overrides', coalesce(assignment_overrides.records, '[]'::jsonb)
            )
            order by employee.last_name, employee.first_name, assignment.id
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
          left join lateral (
            select jsonb_agg(jsonb_build_object(
              'kind', override_record.override_kind,
              'note', override_record.note,
              'createdAt', to_char(override_record.created_at at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM')
            ) order by override_record.created_at desc) as records
            from public.schedule_assignment_overrides override_record
            where override_record.shift_id = assignment.shift_id
              and override_record.employee_id = assignment.employee_id
          ) assignment_overrides on true
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        )
      )
      order by shift.starts_at, shift.created_at, shift.id
    ) filter (where shift.id is not null), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  left join lateral (
    select count(*)::integer as active_assignments
    from public.shift_assignments assignment
    where assignment.shift_id = shift.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) assignment_count on true
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.schedule_id = target_schedule.id
    and shift.canceled_at is null
    and (
      can_view_all_schedule
      or exists (
        select 1
        from public.shift_assignments viewer_assignment
        where viewer_assignment.shift_id = shift.id
          and viewer_assignment.employee_id = viewer_employee_id
          and viewer_assignment.status <> 'canceled'
      )
    );

  return payload;
end;
$function$;

update public.shifts shift
set
  is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
  updated_at = clock_timestamp()
from public.schedules schedule
where schedule.id = shift.schedule_id
  and schedule.status = 'draft'
  and shift.canceled_at is null
  and shift.is_open is distinct from (
    private.active_shift_assignment_count(shift.id) < shift.headcount_required
  );

comment on function private.active_shift_assignment_count(uuid) is
  'Counts active assignments that consume shift coverage capacity.';

comment on function private.normalize_shift_open_state_before_write() is
  'Keeps shifts.is_open aligned to actual assigned coverage and required headcount.';

comment on function private.refresh_shift_open_state_after_assignment() is
  'Refreshes draft shift open/covered status whenever assignments change.';

comment on function public.get_weekly_schedule_payload(date) is
  'Returns the selected weekly schedule and computes open status from live headcount and assignment counts.';

notify pgrst, 'reload schema';

commit;

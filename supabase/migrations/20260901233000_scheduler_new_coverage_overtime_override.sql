begin;

create or replace function private.scheduled_overtime_create_preview(
  target_week_starts_on date,
  target_employee_id uuid,
  target_post_id uuid,
  event_time_zone text,
  shift_operational_dates date[],
  shift_start_time time,
  shift_end_time time,
  use_employee_time_zone boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_schedule public.schedules%rowtype;
  employee_time_zone text;
  proposed_time_zone text;
  week_start date;
  week_end date;
  current_minutes integer := 0;
  proposed_minutes integer := 0;
  resulting_minutes integer := 0;
  overtime_minutes integer := 0;
  counted_shifts jsonb := '[]'::jsonb;
begin
  if target_week_starts_on is null or target_employee_id is null then
    raise check_violation using message = 'Choose a week and employee before calculating scheduled overtime.';
  end if;

  if shift_operational_dates is null or cardinality(shift_operational_dates) = 0
    or shift_start_time is null or shift_end_time is null
  then
    raise check_violation using message = 'Choose at least one valid date, start time, and end time.';
  end if;

  select employee.time_zone into employee_time_zone
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active';

  if employee_time_zone is null then
    raise check_violation using message = 'The selected employee is not active or does not have a supported time zone.';
  end if;

  if coalesce(use_employee_time_zone, false) then
    proposed_time_zone := employee_time_zone;
  elsif target_post_id is not null then
    select site.time_zone into proposed_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id
      and post.active
      and site.active;
  else
    proposed_time_zone := nullif(btrim(coalesce(event_time_zone, '')), '');
  end if;

  if proposed_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names zone where zone.name = proposed_time_zone
  ) then
    raise check_violation using message = 'The schedule time zone could not be determined.';
  end if;

  week_start := target_week_starts_on;
  week_end := week_start + 6;

  if exists (
    select 1
    from unnest(shift_operational_dates) proposed_date
    where proposed_date is null or proposed_date not between week_start and week_end
  ) then
    raise check_violation using message = 'Every proposed shift date must be inside the selected Sunday–Saturday week.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
  order by
    case schedule.status
      when 'draft' then 0
      when 'published' then 1
      when 'superseded' then 2
      when 'archived' then 3
      else 4
    end,
    schedule.revision desc
  limit 1;

  if target_schedule.id is not null then
    select
      coalesce(sum(counted.minutes), 0)::integer,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'shiftId', counted.shift_id,
            'startsAt', counted.starts_at,
            'endsAt', counted.ends_at,
            'timeZone', counted.time_zone,
            'location', counted.location,
            'minutes', counted.minutes
          ) order by counted.starts_at, counted.shift_id
        ),
        '[]'::jsonb
      )
    into current_minutes, counted_shifts
    from (
      select distinct
        scheduled_shift.id as shift_id,
        scheduled_shift.starts_at,
        scheduled_shift.ends_at,
        scheduled_shift.time_zone,
        coalesce(
          site.name || ' / ' || post.name,
          nullif(event.location_name, ''),
          event.name,
          'Scheduled shift'
        ) as location,
        greatest(0, round(extract(epoch from (scheduled_shift.ends_at - scheduled_shift.starts_at)) / 60.0)::integer) as minutes
      from public.shift_assignments assignment
      join public.shifts scheduled_shift on scheduled_shift.id = assignment.shift_id
      left join public.posts post on post.id = scheduled_shift.post_id
      left join public.sites site on site.id = post.site_id
      left join public.events event on event.id = scheduled_shift.event_id
      where assignment.employee_id = target_employee_id
        and assignment.status in ('assigned', 'confirmed', 'completed')
        and assignment.canceled_at is null
        and scheduled_shift.schedule_id = target_schedule.id
        and scheduled_shift.canceled_at is null
        and (scheduled_shift.starts_at at time zone scheduled_shift.time_zone)::date between week_start and week_end
    ) counted;
  end if;

  select coalesce(sum(
    greatest(
      0,
      round(extract(epoch from (
        ((proposed_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone proposed_time_zone
        - ((proposed_date + shift_start_time) at time zone proposed_time_zone)
      )) / 60.0)::integer
    )
  ), 0)::integer
  into proposed_minutes
  from (select distinct unnest(shift_operational_dates) as proposed_date) dates;

  resulting_minutes := current_minutes + proposed_minutes;
  overtime_minutes := greatest(0, resulting_minutes - 2400);

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'weekStartsOn', week_start::text,
    'weekEndsOn', week_end::text,
    'currentMinutes', current_minutes,
    'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes,
    'overtimeMinutes', overtime_minutes,
    'requiresOverride', resulting_minutes > 2400,
    'countedShifts', counted_shifts
  );
end
$$;

create or replace function public.get_scheduled_overtime_create_preview(
  target_week_starts_on date,
  target_employee_id uuid,
  target_post_id uuid,
  event_time_zone text,
  shift_operational_dates date[],
  shift_start_time time,
  shift_end_time time,
  use_employee_time_zone boolean
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

  return private.scheduled_overtime_create_preview(
    target_week_starts_on,
    target_employee_id,
    target_post_id,
    event_time_zone,
    shift_operational_dates,
    shift_start_time,
    shift_end_time,
    use_employee_time_zone
  );
end
$$;

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
    and assignment.canceled_at is null
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
    and assignment.canceled_at is null
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
        and assignment.canceled_at is null
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

create or replace function public.scheduler_create_coverage_plan_v2(
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
  result jsonb;
  assignment_shift_id uuid;
  new_assignment_id uuid;
begin
  if target_employee_id is null then
    return public.scheduler_create_coverage_plan(
      target_week_starts_on, target_post_id, event_name, event_location_name,
      event_site_id, event_time_zone, shift_operational_date, shift_start_time,
      shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
      target_notes, target_work_type, publish_announcement, null, false, null, null
    );
  end if;

  result := public.scheduler_create_coverage_plan(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, event_time_zone, shift_operational_date, shift_start_time,
    shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, false, null, false, null, null
  );

  assignment_shift_id := case
    when target_assignment_requires_armed then (result ->> 'armed_shift_id')::uuid
    else (result ->> 'unarmed_shift_id')::uuid
  end;

  if assignment_shift_id is null then
    raise check_violation using message = 'The selected coverage plan does not contain that guard position.';
  end if;

  perform public.scheduler_add_draft_shift_assignment_v2(
    assignment_shift_id,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note,
    target_overtime_override_note
  );

  select assignment.id into new_assignment_id
  from public.shift_assignments assignment
  where assignment.shift_id = assignment_shift_id
    and assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.canceled_at is null
  order by assignment.assigned_at desc
  limit 1;

  return result || jsonb_build_object('assignment_id', new_assignment_id);
end
$$;

create or replace function public.scheduler_create_employee_local_coverage_plan_v2(
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
  publish_announcement boolean default false,
  target_employee_id uuid default null,
  target_assignment_requires_armed boolean default false,
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
  employee_time_zone text;
  source_time_zone text;
  localized_starts_at timestamptz;
  localized_ends_at timestamptz;
  source_operational_date date;
  source_start_time time;
  source_end_time time;
  result jsonb;
  created_shift_ids uuid[];
  assignment_shift_id uuid;
  new_assignment_id uuid;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create employee-local coverage.';
  end if;

  if target_employee_id is null then
    raise check_violation using message = 'Choose an employee before using employee-local time.';
  end if;

  if target_headcount <> 1 or target_armed_headcount not in (0, 1) then
    raise check_violation using message = 'Employee-local time is limited to a one-person assigned shift. Multi-person coverage remains in the Site/Post time zone.';
  end if;

  select employee.time_zone into employee_time_zone
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active';

  if employee_time_zone is null then
    raise check_violation using message = 'The selected active employee does not have a supported time zone.';
  end if;

  if target_post_id is not null then
    select site.time_zone into source_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  else
    source_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
  end if;

  if source_time_zone is null then
    raise check_violation using message = 'The selected Site/Post or event time zone could not be found.';
  end if;

  localized_starts_at := (shift_operational_date + shift_start_time) at time zone employee_time_zone;
  localized_ends_at := (
    (shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time
  ) at time zone employee_time_zone;

  source_operational_date := (localized_starts_at at time zone source_time_zone)::date;
  source_start_time := (localized_starts_at at time zone source_time_zone)::time;
  source_end_time := (localized_ends_at at time zone source_time_zone)::time;

  result := public.scheduler_create_coverage_plan(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, source_time_zone, source_operational_date, source_start_time,
    source_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, false, null, false, null, null
  );

  select array_agg(value::uuid) into created_shift_ids
  from jsonb_array_elements_text(result -> 'shift_ids') value;

  update public.shifts shift
  set time_zone_source = 'employee',
      time_zone_employee_id = target_employee_id,
      updated_at = clock_timestamp()
  where shift.id = any(created_shift_ids);

  assignment_shift_id := case
    when target_assignment_requires_armed then (result ->> 'armed_shift_id')::uuid
    else (result ->> 'unarmed_shift_id')::uuid
  end;

  if assignment_shift_id is null then
    raise check_violation using message = 'The selected coverage plan does not contain that guard position.';
  end if;

  perform public.scheduler_add_draft_shift_assignment_v2(
    assignment_shift_id,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note,
    target_overtime_override_note
  );

  select assignment.id into new_assignment_id
  from public.shift_assignments assignment
  where assignment.shift_id = assignment_shift_id
    and assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and assignment.canceled_at is null
  order by assignment.assigned_at desc
  limit 1;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    auth.uid(), actor_id, 'public', 'shifts', 'CREATE_EMPLOYEE_LOCAL_COVERAGE',
    result ->> 'schedule_id',
    jsonb_build_object(
      'shiftIds', to_jsonb(created_shift_ids),
      'assignedEmployeeId', target_employee_id,
      'employeeTimeZone', employee_time_zone,
      'enteredDate', shift_operational_date,
      'enteredStartTime', shift_start_time,
      'enteredEndTime', shift_end_time,
      'startsAt', localized_starts_at,
      'endsAt', localized_ends_at,
      'existingRecordsChanged', false
    )
  );

  return jsonb_set(
    result || jsonb_build_object('assignment_id', new_assignment_id),
    '{time_zone}',
    to_jsonb(employee_time_zone),
    true
  );
end
$$;

revoke all on function private.scheduled_overtime_create_preview(date, uuid, uuid, text, date[], time without time zone, time without time zone, boolean) from public, anon, authenticated;
revoke all on function public.get_scheduled_overtime_create_preview(date, uuid, uuid, text, date[], time without time zone, time without time zone, boolean) from public, anon;
revoke all on function public.scheduler_create_coverage_plan_v2(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text) from public, anon;
revoke all on function public.scheduler_create_employee_local_coverage_plan_v2(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text) from public, anon;

grant execute on function public.get_scheduled_overtime_create_preview(date, uuid, uuid, text, date[], time without time zone, time without time zone, boolean) to authenticated;
grant execute on function public.scheduler_create_coverage_plan_v2(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text) to authenticated;
grant execute on function public.scheduler_create_employee_local_coverage_plan_v2(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text) to authenticated;

comment on function public.get_scheduled_overtime_create_preview(date, uuid, uuid, text, date[], time without time zone, time without time zone, boolean) is
  'Previews a proposed coverage plan against the authoritative working week and returns the exact active shifts included in the total.';
comment on function public.scheduler_create_coverage_plan_v2(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text) is
  'Atomically creates coverage and records any required scheduled-overtime approval through the guarded assignment workflow.';
comment on function public.scheduler_create_employee_local_coverage_plan_v2(date, uuid, text, text, uuid, text, date, time without time zone, time without time zone, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text) is
  'Atomically creates employee-local coverage, applies its time-zone authority before overtime evaluation, and records any required approval.';

notify pgrst, 'reload schema';

commit;

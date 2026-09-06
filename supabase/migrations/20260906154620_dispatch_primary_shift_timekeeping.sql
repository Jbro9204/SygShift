begin;

create temporary table dispatch_primary_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.shift_assignments) as assignment_count,
  (select count(*) from public.time_events) as time_event_count,
  (
    select md5(coalesce(string_agg(
      concat_ws(':', event.id::text, event.employee_id::text, coalesce(event.shift_id::text, ''), event.kind::text, event.recorded_at::text),
      '|' order by event.id
    ), ''))
    from public.time_events event
  ) as time_event_fingerprint;

-- A Dispatch location may contain either a primary paid shift or a concurrent
-- phone-duty block. Preserve the explicitly stored type instead of deriving
-- every Dispatch block from its location.
create or replace function private.set_shift_assignment_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatch_phone_location boolean := false;
begin
  if new.post_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_phone_location
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = new.post_id;
  elsif new.event_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_phone_location
    from public.events event
    left join public.sites site on site.id = event.site_id
    where event.id = new.event_id;
  end if;

  if coalesce(dispatch_phone_location, false) then
    new.assignment_type := case
      when new.assignment_type = 'dispatch_phone_duty' then 'dispatch_phone_duty'
      else 'standard'
    end;
  else
    new.assignment_type := 'standard';
  end if;

  return new;
end
$$;

drop trigger if exists shifts_set_assignment_type on public.shifts;
create trigger shifts_set_assignment_type
before insert or update of post_id, event_id on public.shifts
for each row execute function private.set_shift_assignment_type();

revoke all on function private.set_shift_assignment_type() from public, anon, authenticated;

create or replace function private.shift_assignment_type(target_shift_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select shift.assignment_type
  from public.shifts shift
  where shift.id = target_shift_id
$$;

revoke all on function private.shift_assignment_type(uuid) from public, anon, authenticated;

-- Repair active standalone Dispatch blocks without touching historical punches.
-- A Dispatch block remains concurrent only when an assigned employee also has
-- an overlapping standard physical post in the same schedule revision.
lock table public.shifts in share row exclusive mode;
alter table public.shifts disable trigger shifts_published_immutable;

update public.shifts dispatch_shift
set assignment_type = 'standard',
    updated_at = clock_timestamp()
from public.schedules schedule,
     public.posts dispatch_post,
     public.sites dispatch_site
where schedule.id = dispatch_shift.schedule_id
  and dispatch_post.id = dispatch_shift.post_id
  and dispatch_site.id = dispatch_post.site_id
  and dispatch_site.supports_dispatch_phone_duty
  and schedule.status in ('draft', 'published')
  and (dispatch_shift.starts_at at time zone dispatch_shift.time_zone)::date >= current_date
  and dispatch_shift.canceled_at is null
  and dispatch_shift.assignment_type = 'dispatch_phone_duty'
  and not exists (
    select 1
    from public.shift_assignments dispatch_assignment
    join public.shift_assignments other_assignment
      on other_assignment.employee_id = dispatch_assignment.employee_id
     and other_assignment.status in ('assigned', 'confirmed', 'completed')
     and other_assignment.canceled_at is null
    join public.shifts other_shift
      on other_shift.id = other_assignment.shift_id
     and other_shift.id <> dispatch_shift.id
     and other_shift.schedule_id = dispatch_shift.schedule_id
     and other_shift.canceled_at is null
     and tstzrange(other_shift.starts_at, other_shift.ends_at, '[)')
       && tstzrange(dispatch_shift.starts_at, dispatch_shift.ends_at, '[)')
    left join public.posts other_post on other_post.id = other_shift.post_id
    left join public.sites other_site on other_site.id = other_post.site_id
    where dispatch_assignment.shift_id = dispatch_shift.id
      and dispatch_assignment.status in ('assigned', 'confirmed', 'completed')
      and dispatch_assignment.canceled_at is null
      and private.shift_assignment_type(other_shift.id) = 'standard'
      and other_shift.work_type = 'post'
      and not coalesce(other_site.supports_dispatch_phone_duty, false)
  );

alter table public.shifts enable trigger shifts_published_immutable;

create or replace function public.get_schedule_builder_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', post.id,
        'name', post.name,
        'requires_armed', post.requires_armed,
        'site', jsonb_build_object(
          'id', site.id,
          'code', site.code,
          'name', site.name,
          'time_zone', site.time_zone,
          'supports_dispatch_phone_duty', site.supports_dispatch_phone_duty
        )
      ) order by site.name, post.name)
      from public.posts post
      join public.sites site on site.id = post.site_id
      where post.active and site.active
    ), '[]'::jsonb),
    'employees',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'first_name', employee.first_name,
        'last_name', employee.last_name,
        'preferred_name', employee.preferred_name,
        'employee_number', employee.employee_number,
        'role', employee.role,
        'employment_type', employee.employment_type,
        'time_zone', employee.time_zone,
        'has_armed_guard_credential', public.has_valid_credential(employee.id, 'armed_guard', current_date)
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      where employee.status = 'active'
        and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
    ), '[]'::jsonb)
  )
  where private.can_manage_schedule_drafts()
    or public.has_effective_permission('scheduler.view')
$$;

revoke all on function public.get_schedule_builder_options() from public, anon;
grant execute on function public.get_schedule_builder_options() to authenticated;

create or replace function public.get_shift_assignment_type_map(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  selected_schedule_id uuid;
  can_view_all boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  can_view_all := public.has_any_effective_permission(array[
    'schedule.view', 'scheduler.view', 'scheduler.manage', 'schedule.manage', 'schedule.publish'
  ]);

  select schedule.id into selected_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (schedule.status = 'published' or (schedule.status = 'draft' and can_view_all))
  order by case
    when can_view_all and schedule.status = 'draft' then 0
    when schedule.status = 'published' then 1
    else 2
  end, schedule.revision desc
  limit 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shiftId', shift.id,
      'assignmentType', case
        when private.shift_assignment_type(shift.id) = 'dispatch_phone_duty' then 'dispatch_phone_duty'
        when coalesce(post_site.supports_dispatch_phone_duty, event_site.supports_dispatch_phone_duty, false) then 'dispatch_primary'
        else 'standard'
      end
    ) order by shift.starts_at, shift.id)
    from public.shifts shift
    left join public.posts post on post.id = shift.post_id
    left join public.sites post_site on post_site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    left join public.sites event_site on event_site.id = event.site_id
    where shift.schedule_id = selected_schedule_id
      and shift.canceled_at is null
      and (can_view_all or exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.employee_id = actor_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
          and assignment.canceled_at is null
      ))
  ), '[]'::jsonb);
end
$$;

revoke all on function public.get_shift_assignment_type_map(date) from public, anon;
grant execute on function public.get_shift_assignment_type_map(date) to authenticated;

-- Preserve assignment semantics through draft creation and employee-slice publish.
create or replace function private.copy_schedule_shift_block(
  source_shift_id uuid,
  destination_schedule_id uuid,
  actor_id uuid,
  include_only_employee_id uuid default null,
  exclude_employee_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  source_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  select shift.* into source_shift
  from public.shifts shift
  where shift.id = source_shift_id and shift.canceled_at is null;

  if source_shift.id is null then return null; end if;

  insert into public.shifts (
    schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, is_overtime, notes,
    work_type, time_zone_source, time_zone_employee_id, assignment_type, created_by
  ) values (
    destination_schedule_id, source_shift.post_id, source_shift.event_id,
    source_shift.starts_at, source_shift.ends_at, source_shift.time_zone,
    source_shift.headcount_required, source_shift.requires_armed, source_shift.is_open,
    source_shift.is_overtime, source_shift.notes, source_shift.work_type,
    source_shift.time_zone_source, source_shift.time_zone_employee_id,
    source_shift.assignment_type, actor_id
  ) returning id into copied_shift_id;

  insert into public.schedule_assignment_overrides (
    shift_id, employee_id, override_kind, note, created_by, created_at
  )
  select copied_shift_id, override_record.employee_id, override_record.override_kind,
    override_record.note, override_record.created_by, override_record.created_at
  from public.schedule_assignment_overrides override_record
  where override_record.shift_id = source_shift.id
    and (include_only_employee_id is null or override_record.employee_id = include_only_employee_id)
    and (exclude_employee_id is null or override_record.employee_id <> exclude_employee_id)
    and exists (
      select 1 from public.shift_assignments source_assignment
      where source_assignment.shift_id = source_shift.id
        and source_assignment.employee_id = override_record.employee_id
        and source_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by, assigned_at,
    confirmed_at, canceled_at, cancellation_reason
  )
  select copied_shift_id, assignment.employee_id, assignment.status,
    assignment.assigned_by, assignment.assigned_at, assignment.confirmed_at,
    assignment.canceled_at, assignment.cancellation_reason
  from public.shift_assignments assignment
  where assignment.shift_id = source_shift.id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and (include_only_employee_id is null or assignment.employee_id = include_only_employee_id)
    and (exclude_employee_id is null or assignment.employee_id <> exclude_employee_id);

  delete from public.schedule_assignment_overrides override_record
  where override_record.shift_id = copied_shift_id
    and not exists (
      select 1 from public.shift_assignments copied_assignment
      where copied_assignment.shift_id = override_record.shift_id
        and copied_assignment.employee_id = override_record.employee_id
        and copied_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  update public.shifts shift
  set is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
      updated_at = clock_timestamp()
  where shift.id = copied_shift_id;

  return copied_shift_id;
end
$$;

revoke all on function private.copy_schedule_shift_block(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.replace_schedule_week_draft_with_work_types(
  source_schedule_id uuid,
  destination_week_starts_on date,
  include_assignments boolean default true,
  include_events boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  source_week date;
  destination_schedule_id uuid;
  day_offset integer;
begin
  result := public.replace_schedule_week_draft_from_revision(
    source_schedule_id, destination_week_starts_on, include_assignments, include_events
  );

  select schedule.week_starts_on into source_week
  from public.schedules schedule where schedule.id = source_schedule_id;

  destination_schedule_id := (result -> 'schedule' ->> 'id')::uuid;
  day_offset := destination_week_starts_on - source_week;

  update public.shifts destination
  set work_type = source.work_type,
      time_zone_source = source.time_zone_source,
      time_zone_employee_id = source.time_zone_employee_id,
      assignment_type = source.assignment_type,
      updated_at = clock_timestamp()
  from public.shifts source
  where destination.schedule_id = destination_schedule_id
    and destination.canceled_at is null
    and source.schedule_id = source_schedule_id
    and source.canceled_at is null
    and (include_events or source.event_id is null)
    and destination.post_id is not distinct from source.post_id
    and destination.event_id is not distinct from source.event_id
    and destination.starts_at = source.starts_at + make_interval(days => day_offset)
    and destination.ends_at = source.ends_at + make_interval(days => day_offset)
    and destination.time_zone = source.time_zone;

  return jsonb_set(result, '{schedule}', public.get_weekly_schedule_payload(destination_week_starts_on), true);
end
$$;

revoke all on function public.replace_schedule_week_draft_with_work_types(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.replace_schedule_week_draft_with_work_types(uuid, date, boolean, boolean) to authenticated;

create or replace function public.get_scheduled_overtime_create_preview_v2(
  target_week_starts_on date,
  target_employee_id uuid,
  target_post_id uuid,
  event_time_zone text,
  shift_operational_dates date[],
  shift_start_time time,
  shift_end_time time,
  use_employee_time_zone boolean,
  target_dispatch_mode text default 'primary_shift'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  employee_time_zone text;
  proposed_time_zone text;
  dispatch_location boolean := false;
  proposed_minutes integer := 0;
  current_minutes integer := 0;
  resulting_minutes integer := 0;
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  if target_dispatch_mode not in ('primary_shift', 'concurrent_duty') then
    raise check_violation using message = 'Choose whether Dispatch coverage is a primary paid shift or concurrent phone duty.';
  end if;

  result := private.scheduled_overtime_create_preview(
    target_week_starts_on, target_employee_id, target_post_id, event_time_zone,
    shift_operational_dates, shift_start_time, shift_end_time, use_employee_time_zone
  );

  if target_post_id is not null then
    select site.time_zone, site.supports_dispatch_phone_duty
    into proposed_time_zone, dispatch_location
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  else
    proposed_time_zone := nullif(btrim(coalesce(event_time_zone, '')), '');
  end if;

  if coalesce(use_employee_time_zone, false) then
    select employee.time_zone into employee_time_zone
    from public.employees employee
    where employee.id = target_employee_id and employee.status = 'active';
    proposed_time_zone := employee_time_zone;
  end if;

  if target_dispatch_mode = 'concurrent_duty' and not dispatch_location then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;

  if not dispatch_location or target_dispatch_mode = 'primary_shift' then
    select coalesce(sum(greatest(0, round(extract(epoch from (proposed.ends_at - proposed.starts_at)) / 60.0)::integer)), 0)::integer
    into proposed_minutes
    from (
      select
        ((proposed_date + shift_start_time) at time zone proposed_time_zone) as starts_at,
        (((proposed_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone proposed_time_zone) as ends_at
      from (select distinct unnest(shift_operational_dates) proposed_date) dates
    ) proposed;
  end if;

  current_minutes := coalesce((result ->> 'currentMinutes')::integer, 0);
  resulting_minutes := current_minutes + proposed_minutes;

  return result || jsonb_build_object(
    'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes,
    'overtimeMinutes', greatest(0, resulting_minutes - 2400),
    'requiresOverride', resulting_minutes > 2400,
    'concurrentDispatchDuty', dispatch_location and target_dispatch_mode = 'concurrent_duty'
  );
end
$$;

create or replace function public.get_scheduled_overtime_update_preview_v2(
  target_shift_id uuid,
  target_employee_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_dispatch_mode text default 'primary_shift'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  target_shift public.shifts%rowtype;
  dispatch_location boolean := false;
  proposed_starts_at timestamptz;
  proposed_ends_at timestamptz;
  proposed_minutes integer := 0;
  current_minutes integer := 0;
  resulting_minutes integer := 0;
  changing_mode boolean := false;
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  if target_dispatch_mode not in ('primary_shift', 'concurrent_duty') then
    raise check_violation using message = 'Choose whether Dispatch coverage is a primary paid shift or concurrent phone duty.';
  end if;

  select shift into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  select coalesce(site.supports_dispatch_phone_duty, false) into dispatch_location
  from public.posts post
  join public.sites site on site.id = post.site_id
  where post.id = target_shift.post_id;
  if target_dispatch_mode = 'concurrent_duty' and not dispatch_location then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;

  result := private.scheduled_overtime_update_preview(
    target_shift_id, target_employee_id, shift_operational_date, shift_start_time, shift_end_time
  );

  if not dispatch_location or target_dispatch_mode = 'primary_shift' then
    proposed_starts_at := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
    proposed_ends_at := ((case when shift_end_time <= shift_start_time then shift_operational_date + 1 else shift_operational_date end) + shift_end_time) at time zone target_shift.time_zone;
    proposed_minutes := greatest(0, round(extract(epoch from (proposed_ends_at - proposed_starts_at)) / 60.0)::integer);
  end if;

  changing_mode := dispatch_location and (
    (target_shift.assignment_type = 'dispatch_phone_duty') is distinct from (target_dispatch_mode = 'concurrent_duty')
  );
  current_minutes := coalesce((result ->> 'currentMinutes')::integer, 0);
  resulting_minutes := current_minutes + proposed_minutes;

  return result || jsonb_build_object(
    'proposedMinutes', proposed_minutes,
    'resultingMinutes', resulting_minutes,
    'overtimeMinutes', greatest(0, resulting_minutes - 2400),
    'requiresOverride', resulting_minutes > 2400 and (changing_mode or not coalesce((result ->> 'approvalCarriedForward')::boolean, false)),
    'approvalCarriedForward', not changing_mode and coalesce((result ->> 'approvalCarriedForward')::boolean, false),
    'concurrentDispatchDuty', dispatch_location and target_dispatch_mode = 'concurrent_duty'
  );
end
$$;

create or replace function public.scheduler_create_coverage_plan_v3(
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
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift',
  target_dispatch_overlap_acknowledged boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  result jsonb;
  created_shift_ids uuid[];
  assignment_shift_id uuid;
  new_assignment_id uuid;
  dispatch_location boolean := false;
  resolved_assignment_type text := 'standard';
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create coverage.';
  end if;
  if target_dispatch_mode not in ('primary_shift', 'concurrent_duty') then
    raise check_violation using message = 'Choose whether Dispatch coverage is a primary paid shift or concurrent phone duty.';
  end if;

  if target_post_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_location
    from public.posts post join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  elsif event_site_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_location
    from public.sites site where site.id = event_site_id and site.active;
  end if;

  if target_dispatch_mode = 'concurrent_duty' and not coalesce(dispatch_location, false) then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;
  if coalesce(dispatch_location, false) and target_dispatch_mode = 'concurrent_duty' then
    resolved_assignment_type := 'dispatch_phone_duty';
  end if;

  result := public.scheduler_create_coverage_plan_v2(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, event_time_zone, shift_operational_date, shift_start_time,
    shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, publish_announcement and target_employee_id is null,
    null, false, null, null, null
  );

  select array_agg(value::uuid) into created_shift_ids
  from jsonb_array_elements_text(result -> 'shift_ids') value;

  update public.shifts shift
  set assignment_type = resolved_assignment_type,
      updated_at = clock_timestamp()
  where shift.id = any(created_shift_ids);

  assignment_shift_id := case
    when target_assignment_requires_armed then (result ->> 'armed_shift_id')::uuid
    else (result ->> 'unarmed_shift_id')::uuid
  end;

  if target_employee_id is not null then
    if assignment_shift_id is null then
      raise check_violation using message = 'The selected coverage plan does not contain that employee position.';
    end if;

    perform public.scheduler_add_draft_shift_assignment_v3(
      assignment_shift_id, target_employee_id,
      target_availability_override_note, target_credential_override_note,
      target_overtime_override_note, target_dispatch_overlap_acknowledged
    );

    select assignment.id into new_assignment_id
    from public.shift_assignments assignment
    where assignment.shift_id = assignment_shift_id
      and assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and assignment.canceled_at is null
    order by assignment.assigned_at desc limit 1;
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    auth.uid(), actor_id, 'public', 'shifts', 'CREATE_DISPATCH_AWARE_COVERAGE',
    (result ->> 'schedule_id'),
    jsonb_build_object(
      'shiftIds', to_jsonb(created_shift_ids),
      'dispatchLocation', dispatch_location,
      'dispatchMode', case when resolved_assignment_type = 'dispatch_phone_duty' then 'concurrent_duty' else 'primary_shift' end,
      'assignmentType', resolved_assignment_type,
      'assignedEmployeeId', target_employee_id
    )
  );

  return result || jsonb_build_object('assignment_id', new_assignment_id);
end
$$;

create or replace function public.scheduler_create_employee_local_coverage_plan_v3(
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
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift',
  target_dispatch_overlap_acknowledged boolean default false
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
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create employee-local coverage.';
  end if;
  if target_employee_id is null then
    raise check_violation using message = 'Choose an employee before using employee-local time.';
  end if;
  if target_headcount <> 1 or target_armed_headcount not in (0, 1) then
    raise check_violation using message = 'Employee-local time is limited to a one-person assigned shift.';
  end if;

  select employee.time_zone into employee_time_zone
  from public.employees employee
  where employee.id = target_employee_id and employee.status = 'active';
  if employee_time_zone is null then
    raise check_violation using message = 'The selected active employee does not have a supported time zone.';
  end if;

  if target_post_id is not null then
    select site.time_zone into source_time_zone
    from public.posts post join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  else
    source_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
  end if;
  if source_time_zone is null then
    raise check_violation using message = 'The selected Site/Post time zone could not be found.';
  end if;

  localized_starts_at := (shift_operational_date + shift_start_time) at time zone employee_time_zone;
  localized_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone employee_time_zone;
  source_operational_date := (localized_starts_at at time zone source_time_zone)::date;
  source_start_time := (localized_starts_at at time zone source_time_zone)::time;
  source_end_time := (localized_ends_at at time zone source_time_zone)::time;

  result := public.scheduler_create_coverage_plan_v3(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, source_time_zone, source_operational_date, source_start_time,
    source_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, false, target_employee_id,
    target_assignment_requires_armed, target_availability_override_note,
    target_credential_override_note, target_overtime_override_note,
    target_dispatch_mode, target_dispatch_overlap_acknowledged
  );

  select array_agg(value::uuid) into created_shift_ids
  from jsonb_array_elements_text(result -> 'shift_ids') value;

  update public.shifts shift
  set time_zone_source = 'employee',
      time_zone_employee_id = target_employee_id,
      updated_at = clock_timestamp()
  where shift.id = any(created_shift_ids);

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    auth.uid(), actor_id, 'public', 'shifts', 'CREATE_EMPLOYEE_LOCAL_DISPATCH_AWARE_COVERAGE',
    (result ->> 'schedule_id'),
    jsonb_build_object(
      'shiftIds', to_jsonb(created_shift_ids), 'assignedEmployeeId', target_employee_id,
      'employeeTimeZone', employee_time_zone, 'enteredDate', shift_operational_date,
      'enteredStartTime', shift_start_time, 'enteredEndTime', shift_end_time,
      'startsAt', localized_starts_at, 'endsAt', localized_ends_at,
      'dispatchMode', target_dispatch_mode, 'existingRecordsChanged', false
    )
  );

  return jsonb_set(result, '{time_zone}', to_jsonb(employee_time_zone), true);
end
$$;

create or replace function public.scheduler_update_typed_draft_shift_v3(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift'
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
  dispatch_location boolean := false;
  old_assignment_type text;
  new_assignment_type text := 'standard';
  result jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit a draft shift.';
  end if;
  if target_dispatch_mode not in ('primary_shift', 'concurrent_duty') then
    raise check_violation using message = 'Choose whether Dispatch coverage is a primary paid shift or concurrent phone duty.';
  end if;

  select shift into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null
  for update;

  if target_shift.id is not null then
    select schedule into target_schedule
    from public.schedules schedule
    where schedule.id = target_shift.schedule_id;
  end if;

  if target_shift.id is null or target_schedule.status <> 'draft' then
    raise check_violation using message = 'Only a shift in the working schedule draft can be edited.';
  end if;

  select coalesce(site.supports_dispatch_phone_duty, false) into dispatch_location
  from public.posts post join public.sites site on site.id = post.site_id
  where post.id = target_shift.post_id;

  if target_dispatch_mode = 'concurrent_duty' and not dispatch_location then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;
  if dispatch_location and target_dispatch_mode = 'concurrent_duty' then
    new_assignment_type := 'dispatch_phone_duty';
  end if;

  old_assignment_type := target_shift.assignment_type;
  update public.shifts shift
  set assignment_type = new_assignment_type, updated_at = clock_timestamp()
  where shift.id = target_shift_id;

  result := public.scheduler_update_typed_draft_shift_v2(
    target_shift_id, shift_operational_date, shift_start_time, shift_end_time,
    target_headcount, target_is_open, target_is_overtime, target_notes,
    target_work_type, target_employee_id, target_availability_override_note,
    target_credential_override_note, target_overtime_override_note
  );

  if old_assignment_type is distinct from new_assignment_type then
    insert into private.audit_events (
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
    ) values (
      auth.uid(), actor_id, 'public', 'shifts', 'CHANGE_DISPATCH_COVERAGE_MODE', target_shift_id::text,
      jsonb_build_object('assignmentType', old_assignment_type),
      jsonb_build_object('assignmentType', new_assignment_type, 'dispatchMode', target_dispatch_mode)
    );
  end if;

  return result;
end
$$;

revoke all on function public.get_scheduled_overtime_create_preview_v2(date, uuid, uuid, text, date[], time, time, boolean, text) from public, anon;
revoke all on function public.get_scheduled_overtime_update_preview_v2(uuid, uuid, date, time, time, text) from public, anon;
revoke all on function public.scheduler_create_coverage_plan_v3(date, uuid, text, text, uuid, text, date, time, time, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean) from public, anon;
revoke all on function public.scheduler_create_employee_local_coverage_plan_v3(date, uuid, text, text, uuid, text, date, time, time, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean) from public, anon;
revoke all on function public.scheduler_update_typed_draft_shift_v3(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text) from public, anon;

grant execute on function public.get_scheduled_overtime_create_preview_v2(date, uuid, uuid, text, date[], time, time, boolean, text) to authenticated;
grant execute on function public.get_scheduled_overtime_update_preview_v2(uuid, uuid, date, time, time, text) to authenticated;
grant execute on function public.scheduler_create_coverage_plan_v3(date, uuid, text, text, uuid, text, date, time, time, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean) to authenticated;
grant execute on function public.scheduler_create_employee_local_coverage_plan_v3(date, uuid, text, text, uuid, text, date, time, time, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean) to authenticated;
grant execute on function public.scheduler_update_typed_draft_shift_v3(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text) to authenticated;

comment on function public.scheduler_create_coverage_plan_v3(date, uuid, text, text, uuid, text, date, time, time, integer, integer, boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean) is
  'Creates primary paid Dispatch shifts or explicitly concurrent phone duty while preserving assignment, overlap, and overtime guardrails.';
comment on function public.scheduler_update_typed_draft_shift_v3(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text) is
  'Edits a draft shift and changes Dispatch timekeeping mode atomically before overtime validation.';

do $$
declare baseline dispatch_primary_release_baseline%rowtype;
begin
  select * into baseline from dispatch_primary_release_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.shift_count <> (select count(*) from public.shifts)
    or baseline.assignment_count <> (select count(*) from public.shift_assignments)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.time_event_fingerprint is distinct from (
      select md5(coalesce(string_agg(
        concat_ws(':', event.id::text, event.employee_id::text, coalesce(event.shift_id::text, ''), event.kind::text, event.recorded_at::text),
        '|' order by event.id
      ), '')) from public.time_events event
    )
  then
    raise exception 'Dispatch primary-shift release changed protected employee, schedule, assignment, or time-event history.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

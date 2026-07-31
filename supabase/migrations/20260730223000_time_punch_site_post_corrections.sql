begin;

update private.payroll_rules
set
  pay_date_anchor = date '2026-07-31',
  updated_at = clock_timestamp()
where id = true;

create table if not exists public.time_event_shift_overrides (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  reason text not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint time_event_shift_overrides_reason_present check (btrim(reason) <> '')
);

create index if not exists time_event_shift_overrides_event_idx
  on public.time_event_shift_overrides (time_event_id, created_at desc, id desc);

create index if not exists time_event_shift_overrides_shift_idx
  on public.time_event_shift_overrides (shift_id, created_at desc);

create index if not exists time_event_shift_overrides_created_by_idx
  on public.time_event_shift_overrides (created_by, created_at desc);

alter table public.time_event_shift_overrides enable row level security;

drop policy if exists time_event_shift_overrides_read on public.time_event_shift_overrides;
create policy time_event_shift_overrides_read on public.time_event_shift_overrides
for select
using (
  public.is_supervisor_or_admin()
  or public.has_effective_permission('time.view')
  or public.has_effective_permission('time.manage')
  or exists (
    select 1
    from public.time_events event
    where event.id = time_event_shift_overrides.time_event_id
      and event.employee_id = public.current_employee_id()
  )
);

drop trigger if exists time_event_shift_overrides_append_only on public.time_event_shift_overrides;
create trigger time_event_shift_overrides_append_only
before update or delete on public.time_event_shift_overrides
for each row execute function private.prevent_append_only_change();

drop trigger if exists time_event_shift_overrides_audit on public.time_event_shift_overrides;
create trigger time_event_shift_overrides_audit
after insert on public.time_event_shift_overrides
for each row execute function private.write_audit_event();

alter table public.time_event_maintenance_notes
  drop constraint if exists time_event_maintenance_notes_action;

alter table public.time_event_maintenance_notes
  add constraint time_event_maintenance_notes_action
  check (action in ('manual_add', 'time_adjust', 'void', 'location_update', 'site_post_update'));

create or replace function public.get_time_maintenance_shift_options(
  target_from_date date,
  target_through_date date,
  target_employee_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  options_payload jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.view')
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Time maintenance access with MFA is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time maintenance shift option ranges are limited to 46 days.';
  end if;

  with assigned_summary as (
    select
      assignment.shift_id,
      coalesce(jsonb_agg(
        jsonb_build_object(
          'employeeId', employee.id,
          'name', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
          'username', employee.username
        )
        order by employee.last_name, employee.first_name
      ) filter (where assignment.id is not null), '[]'::jsonb) as assigned_employees,
      bool_or(assignment.employee_id = target_employee_id and assignment.status in ('assigned', 'confirmed', 'completed')) as selected_employee_assigned
    from public.shift_assignments assignment
    join public.employees employee on employee.id = assignment.employee_id
    where assignment.status in ('assigned', 'confirmed', 'completed')
    group by assignment.shift_id
  ),
  shift_rows as (
    select
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.is_overtime,
      shift.headcount_required,
      schedule.status as schedule_status,
      schedule.revision as schedule_revision,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      schedule_event.name as event_name,
      coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Unscheduled Location') as location_name,
      coalesce(assigned_summary.assigned_employees, '[]'::jsonb) as assigned_employees,
      coalesce(assigned_summary.selected_employee_assigned, false) as selected_employee_assigned
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    left join assigned_summary on assigned_summary.shift_id = shift.id
    where schedule.status in ('draft', 'published')
      and (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date <= target_through_date
      and (shift.ends_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date >= target_from_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shiftId', shift_id,
    'startsAt', starts_at,
    'endsAt', ends_at,
    'timeZone', time_zone,
    'requiresArmed', requires_armed,
    'isOvertime', is_overtime,
    'headcountRequired', headcount_required,
    'scheduleStatus', schedule_status,
    'scheduleRevision', schedule_revision,
    'siteName', site_name,
    'siteCode', site_code,
    'postName', post_name,
    'eventName', event_name,
    'locationName', location_name,
    'assignedEmployees', assigned_employees,
    'selectedEmployeeAssigned', selected_employee_assigned
  ) order by starts_at, coalesce(site_name, location_name), coalesce(post_name, event_name, location_name)), '[]'::jsonb)
  into options_payload
  from shift_rows;

  return options_payload;
end
$$;

create or replace function public.supervisor_update_time_event_site_post(
  target_time_event_id uuid,
  target_shift_id uuid,
  target_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_reason text := btrim(coalesce(target_reason, ''));
  target_event public.time_events%rowtype;
  target_shift public.shifts%rowtype;
  current_shift_id uuid;
  current_effective_at timestamptz;
  current_operational_date date;
  target_voided boolean := false;
  affected_count integer := 0;
  shift_label text;
  site_name text;
  site_code text;
  post_name text;
  event_name text;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.manage')
    ) then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;

  if target_time_event_id is null then
    raise check_violation using message = 'A time event is required.';
  end if;

  if target_shift_id is null then
    raise check_violation using message = 'A Site/Post shift is required.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  select * into target_event
  from public.time_events event
  where event.id = target_time_event_id;

  if target_event.id is null then
    raise no_data_found using message = 'The selected time event was not found.';
  end if;

  select * into target_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if target_shift.id is null then
    raise no_data_found using message = 'The selected Site/Post shift was not found.';
  end if;

  select
    coalesce((
      select shift_override.shift_id
      from public.time_event_shift_overrides shift_override
      where shift_override.time_event_id = target_event.id
      order by shift_override.created_at desc, shift_override.id desc
      limit 1
    ), target_event.shift_id),
    coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = target_event.id
        and correction.approved_at is not null
        and correction.voided = false
        and correction.replacement_time is not null
      order by correction.approved_at desc, correction.id desc
      limit 1
    ), target_event.recorded_at),
    exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = target_event.id
        and correction.approved_at is not null
        and correction.voided
    )
  into current_shift_id, current_effective_at, target_voided;

  if target_voided then
    raise check_violation using message = 'Voided punches cannot be reassigned to a Site/Post.';
  end if;

  current_operational_date := (current_effective_at at time zone coalesce(target_shift.time_zone, 'America/Denver'))::date;

  select
    coalesce(schedule_event.location_name, site.name, post.name, schedule_event.name, 'Selected Site/Post'),
    site.name,
    site.code,
    post.name,
    schedule_event.name
  into shift_label, site_name, site_code, post_name, event_name
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events schedule_event on schedule_event.id = shift.event_id
  where shift.id = target_shift.id;

  with latest_event_state as (
    select
      event.id,
      event.employee_id,
      coalesce((
        select shift_override.shift_id
        from public.time_event_shift_overrides shift_override
        where shift_override.time_event_id = event.id
        order by shift_override.created_at desc, shift_override.id desc
        limit 1
      ), event.shift_id) as effective_shift_id,
      coalesce((
        select correction.replacement_time
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
          and correction.voided = false
          and correction.replacement_time is not null
        order by correction.approved_at desc, correction.id desc
        limit 1
      ), event.recorded_at) as effective_at,
      exists (
        select 1
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
          and correction.voided
      ) as voided
    from public.time_events event
    where event.employee_id = target_event.employee_id
  ),
  affected_events as (
    select state.id
    from latest_event_state state
    where not state.voided
      and (
        (current_shift_id is not null and state.effective_shift_id = current_shift_id)
        or (
          current_shift_id is null
          and state.effective_shift_id is null
          and (state.effective_at at time zone coalesce(target_shift.time_zone, 'America/Denver'))::date = current_operational_date
        )
      )
  ),
  inserted_overrides as (
    insert into public.time_event_shift_overrides (
      time_event_id,
      shift_id,
      reason,
      created_by
    )
    select
      affected_events.id,
      target_shift.id,
      clean_reason,
      actor_id
    from affected_events
    returning time_event_id
  ),
  inserted_notes as (
    insert into public.time_event_maintenance_notes (
      time_event_id,
      action,
      note,
      created_by
    )
    select
      inserted_overrides.time_event_id,
      'site_post_update',
      clean_reason,
      actor_id
    from inserted_overrides
    returning time_event_id
  )
  select count(*)::integer into affected_count
  from inserted_notes;

  if affected_count = 0 then
    raise check_violation using message = 'No eligible punches were found for the selected Site/Post correction.';
  end if;

  return jsonb_build_object(
    'shiftId', target_shift.id,
    'timeEventId', target_event.id,
    'affectedEventCount', affected_count,
    'locationName', shift_label,
    'siteName', site_name,
    'siteCode', site_code,
    'postName', post_name,
    'eventName', event_name,
    'reason', clean_reason
  );
end
$$;

do $patch_time_maintenance$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_time_maintenance(date, date, uuid)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_time_maintenance(date, date, uuid) was not found.';
  end if;

  if position('latest_shift_override as (' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '  event_rows as (',
      '  latest_shift_override as (
    select distinct on (shift_override.time_event_id)
      shift_override.time_event_id,
      shift_override.shift_id
    from public.time_event_shift_overrides shift_override
    order by shift_override.time_event_id, shift_override.created_at desc, shift_override.id desc
  ),
  event_rows as ('
    );

    function_sql := replace(
      function_sql,
      '      employee.employment_type,
      event.shift_id,
      event.kind,',
      '      employee.employment_type,
      coalesce(latest_shift_override.shift_id, event.shift_id) as shift_id,
      event.kind,'
    );

    function_sql := replace(
      function_sql,
      '    left join note_summary on note_summary.time_event_id = event.id
    left join latest_location_override on latest_location_override.time_event_id = event.id
    left join public.shifts shift on shift.id = event.shift_id',
      '    left join note_summary on note_summary.time_event_id = event.id
    left join latest_location_override on latest_location_override.time_event_id = event.id
    left join latest_shift_override on latest_shift_override.time_event_id = event.id
    left join public.shifts shift on shift.id = coalesce(latest_shift_override.shift_id, event.shift_id)'
    );

    if position('latest_shift_override.shift_id' in function_sql) = 0 then
      raise check_violation using message = 'Site/Post override was not applied to get_time_maintenance.';
    end if;

    execute function_sql;
  end if;
end
$patch_time_maintenance$;

do $patch_time_review$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_timekeeping_review(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_timekeeping_review(date, date) was not found.';
  end if;

  if position('time_event_shift_overrides' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '      event.id,
      event.employee_id,
      event.shift_id,
      (',
      '      event.id,
      event.employee_id,
      coalesce((
        select shift_override.shift_id
        from public.time_event_shift_overrides shift_override
        where shift_override.time_event_id = event.id
        order by shift_override.created_at desc, shift_override.id desc
        limit 1
      ), event.shift_id) as shift_id,
      ('
    );

    function_sql := replace(
      function_sql,
      '''shiftId'', event.shift_id',
      '''shiftId'', coalesce((
      select shift_override.shift_id
      from public.time_event_shift_overrides shift_override
      where shift_override.time_event_id = event.id
      order by shift_override.created_at desc, shift_override.id desc
      limit 1
    ), event.shift_id)'
    );

    if position('time_event_shift_overrides shift_override' in function_sql) = 0 then
      raise check_violation using message = 'Site/Post override was not applied to get_timekeeping_review.';
    end if;

    execute function_sql;
  end if;
end
$patch_time_review$;

revoke all on function public.get_time_maintenance_shift_options(date, date, uuid) from public, anon;
grant execute on function public.get_time_maintenance_shift_options(date, date, uuid) to authenticated;

revoke all on function public.supervisor_update_time_event_site_post(uuid, uuid, text) from public, anon;
grant execute on function public.supervisor_update_time_event_site_post(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';

commit;

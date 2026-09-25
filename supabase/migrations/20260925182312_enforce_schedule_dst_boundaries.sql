begin;

-- PostgreSQL intentionally normalizes nonexistent spring-forward wall clocks
-- when `timestamp AT TIME ZONE` is used by itself. Validate the converted
-- instant by round-tripping it through the same authoritative zone before any
-- schedule row, assignment classification, override, announcement, or audit
-- record can be written.
create or replace function private.validate_schedule_wall_clock_range(
  target_operational_date date,
  target_start_time time,
  target_end_time time,
  target_time_zone text
)
returns table(starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  entered_local_start timestamp without time zone;
  entered_local_end timestamp without time zone;
begin
  if target_operational_date is null or target_start_time is null or target_end_time is null then
    raise check_violation using message = 'Choose a valid date, start time, and end time.';
  end if;
  if target_time_zone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = target_time_zone
  ) then
    raise check_violation using message = 'The shift time zone could not be verified.';
  end if;

  entered_local_start := target_operational_date + target_start_time;
  entered_local_end := (
    target_operational_date + case when target_end_time <= target_start_time then 1 else 0 end
  ) + target_end_time;
  starts_at := entered_local_start at time zone target_time_zone;
  ends_at := entered_local_end at time zone target_time_zone;

  if starts_at at time zone target_time_zone is distinct from entered_local_start then
    raise check_violation using message = format(
      'The entered start time does not exist in %s because of daylight-saving time. Choose another time.',
      target_time_zone
    );
  end if;
  if ends_at at time zone target_time_zone is distinct from entered_local_end then
    raise check_violation using message = format(
      'The entered end time does not exist in %s because of daylight-saving time. Choose another time.',
      target_time_zone
    );
  end if;
  if ends_at <= starts_at then
    raise check_violation using message = 'Shift end must be after shift start.';
  end if;

  return next;
end
$$;

create or replace function private.resolve_schedule_source_time_zone(
  target_post_id uuid,
  target_event_site_id uuid,
  target_event_time_zone text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  resolved_time_zone text;
begin
  if target_post_id is not null then
    select site.time_zone into resolved_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;

    if resolved_time_zone is null then
      raise check_violation using message = 'The selected Site/Post time zone could not be found.';
    end if;
  elsif target_event_site_id is not null then
    select site.time_zone into resolved_time_zone
    from public.sites site
    where site.id = target_event_site_id and site.active;

    if resolved_time_zone is null then
      raise check_violation using message = 'The linked event Site time zone could not be found.';
    end if;
  else
    resolved_time_zone := nullif(btrim(coalesce(target_event_time_zone, '')), '');
    if resolved_time_zone is null then
      raise check_violation using message = 'Choose the event time zone.';
    end if;
  end if;

  if resolved_time_zone not in (
    'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Phoenix', 'America/Los_Angeles'
  ) then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  return resolved_time_zone;
end
$$;

-- The row-security trigger is the final authority for every shift insert. A
-- linked event therefore has to inherit the current Site zone here too; using
-- the event's historical snapshot would silently demote a verified Site Time
-- copy to `explicit` after the copy function had validated it.
create or replace function private.set_shift_security_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inherited_requires_armed boolean;
  inherited_time_zone text;
  employee_time_zone text;
  source_changed boolean := false;
  provenance_changed boolean := false;
begin
  if new.post_id is not null then
    select post.requires_armed, site.time_zone
      into inherited_requires_armed, inherited_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = new.post_id;
  else
    select
      event.requires_armed,
      case when event.site_id is null then event.time_zone else site.time_zone end
      into inherited_requires_armed, inherited_time_zone
    from public.events event
    left join public.sites site on site.id = event.site_id
    where event.id = new.event_id;
  end if;

  if inherited_time_zone is null then
    raise check_violation using message = 'The selected Site/Post or event could not be found.';
  end if;

  if tg_op = 'UPDATE' then
    source_changed := new.post_id is distinct from old.post_id
      or new.event_id is distinct from old.event_id;
    provenance_changed := new.time_zone_source is distinct from old.time_zone_source
      or new.time_zone_employee_id is distinct from old.time_zone_employee_id;
  end if;

  if tg_op = 'UPDATE' and not source_changed and not provenance_changed then
    -- Draft edits are interpreted in the shift's recorded basis. A later
    -- employee-profile or Site correction must not rewrite that basis without
    -- also converting the edited wall clock. Explicit create/copy/source-change
    -- workflows continue through the authority-refresh branches below.
    new.time_zone := old.time_zone;
  elsif new.time_zone_source = 'employee' then
    select employee.time_zone
      into employee_time_zone
    from public.employees employee
    where employee.id = new.time_zone_employee_id;

    if employee_time_zone is null then
      raise check_violation using message = 'The employee time zone could not be found.';
    end if;

    new.time_zone := employee_time_zone;
  elsif new.time_zone_source = 'explicit' then
    new.time_zone_employee_id := null;
    if new.time_zone is null or not exists (
      select 1 from pg_catalog.pg_timezone_names zone where zone.name = new.time_zone
    ) then
      raise check_violation using message = 'Choose a valid IANA time zone.';
    end if;
  elsif tg_op = 'INSERT'
    and new.time_zone is not null
    and new.time_zone is distinct from inherited_time_zone
  then
    -- Revision workflows can carry an intentional historical explicit basis.
    new.time_zone_source := 'explicit';
    new.time_zone_employee_id := null;
  else
    new.time_zone_source := 'site';
    new.time_zone_employee_id := null;
    new.time_zone := inherited_time_zone;
  end if;

  if new.requires_armed is null
    or (source_changed and new.requires_armed is not distinct from old.requires_armed)
  then
    new.requires_armed := inherited_requires_armed;
  end if;

  return new;
end
$$;

revoke all on function private.set_shift_security_fields() from public, anon, authenticated;

create or replace function private.validate_employee_schedule_wall_clock_range(
  target_employee_id uuid,
  target_post_id uuid,
  target_event_site_id uuid,
  event_time_zone text,
  target_operational_date date,
  target_start_time time,
  target_end_time time
)
returns table(
  employee_time_zone text,
  source_time_zone text,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql
stable
set search_path = ''
as $$
declare
  source_local_start timestamp without time zone;
  source_local_end timestamp without time zone;
begin
  select employee.time_zone into employee_time_zone
  from public.employees employee
  where employee.id = target_employee_id and employee.status = 'active';

  if employee_time_zone is null then
    raise check_violation using message = 'The selected active employee does not have a supported time zone.';
  end if;

  source_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, target_event_site_id, event_time_zone
  );

  select validated.starts_at, validated.ends_at
    into starts_at, ends_at
  from private.validate_schedule_wall_clock_range(
    target_operational_date, target_start_time, target_end_time, employee_time_zone
  ) validated;

  if source_time_zone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = source_time_zone
  ) then
    raise check_violation using message = 'The selected Site/Post time zone could not be found.';
  end if;

  source_local_start := starts_at at time zone source_time_zone;
  source_local_end := ends_at at time zone source_time_zone;
  if source_local_start at time zone source_time_zone is distinct from starts_at
    or source_local_end at time zone source_time_zone is distinct from ends_at
  then
    raise check_violation using message = format(
      'That Employee Time range cannot be represented unambiguously in %s. Choose another time.',
      source_time_zone
    );
  end if;

  return next;
end
$$;

do $isolate_legacy_schedule_cores$
begin
  if to_regprocedure(
    'private.scheduler_create_coverage_plan_unvalidated(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)'
  ) is null then
    alter function public.scheduler_create_coverage_plan(
      date, uuid, text, text, uuid, text, date, time, time, integer, integer,
      boolean, text, text, boolean, uuid, boolean, text, text
    ) set schema private;
    alter function private.scheduler_create_coverage_plan(
      date, uuid, text, text, uuid, text, date, time, time, integer, integer,
      boolean, text, text, boolean, uuid, boolean, text, text
    ) rename to scheduler_create_coverage_plan_unvalidated;
  end if;

  if to_regprocedure(
    'private.scheduler_create_employee_local_coverage_plan_unvalidated(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)'
  ) is null then
    alter function public.scheduler_create_employee_local_coverage_plan(
      date, uuid, text, text, uuid, text, date, time, time, integer, integer,
      boolean, text, text, boolean, uuid, boolean, text, text
    ) set schema private;
    alter function private.scheduler_create_employee_local_coverage_plan(
      date, uuid, text, text, uuid, text, date, time, time, integer, integer,
      boolean, text, text, boolean, uuid, boolean, text, text
    ) rename to scheduler_create_employee_local_coverage_plan_unvalidated;
  end if;

  if to_regprocedure(
    'private.scheduler_create_employee_local_coverage_plan_v2_unvalidated(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)'
  ) is null then
    alter function public.scheduler_create_employee_local_coverage_plan_v2(
      date, uuid, text, text, uuid, text, date, time, time, integer, integer,
      boolean, text, text, boolean, uuid, boolean, text, text, text
    ) set schema private;
    alter function private.scheduler_create_employee_local_coverage_plan_v2(
      date, uuid, text, text, uuid, text, date, time, time, integer, integer,
      boolean, text, text, boolean, uuid, boolean, text, text, text
    ) rename to scheduler_create_employee_local_coverage_plan_v2_unvalidated;
  end if;
end
$isolate_legacy_schedule_cores$;

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
  coverage_time_zone text;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create coverage.';
  end if;

  coverage_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, event_site_id, event_time_zone
  );

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, coverage_time_zone
  );

  return private.scheduler_create_coverage_plan_unvalidated(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, coverage_time_zone, shift_operational_date, shift_start_time,
    shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, publish_announcement, target_employee_id,
    target_assignment_requires_armed, target_availability_override_note,
    target_credential_override_note
  );
end
$$;

create or replace function public.scheduler_create_employee_local_coverage_plan(
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
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  source_time_zone text;
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create employee-local coverage.';
  end if;

  select validated.source_time_zone into source_time_zone
  from private.validate_employee_schedule_wall_clock_range(
    target_employee_id, target_post_id, event_site_id, event_time_zone,
    shift_operational_date, shift_start_time, shift_end_time
  ) validated;

  return private.scheduler_create_employee_local_coverage_plan_unvalidated(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, source_time_zone, shift_operational_date, shift_start_time,
    shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, publish_announcement, target_employee_id,
    target_assignment_requires_armed, target_availability_override_note,
    target_credential_override_note
  );
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
  source_time_zone text;
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create employee-local coverage.';
  end if;

  select validated.source_time_zone into source_time_zone
  from private.validate_employee_schedule_wall_clock_range(
    target_employee_id, target_post_id, event_site_id, event_time_zone,
    shift_operational_date, shift_start_time, shift_end_time
  ) validated;

  return private.scheduler_create_employee_local_coverage_plan_v2_unvalidated(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, source_time_zone, shift_operational_date, shift_start_time,
    shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
    target_notes, target_work_type, publish_announcement, target_employee_id,
    target_assignment_requires_armed, target_availability_override_note,
    target_credential_override_note, target_overtime_override_note
  );
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
  coverage_time_zone text;
  result jsonb;
  result_schedule_id uuid;
  original_shift_id uuid;
  normalized_shift_id uuid;
  normalized_assignment_id uuid;
  original_shift public.shifts%rowtype;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create coverage.';
  end if;

  coverage_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, event_site_id, event_time_zone
  );

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, coverage_time_zone
  );

  result := private.create_supervisor_open_shift_unmerged(
    target_week_starts_on,
    target_post_id,
    event_name,
    event_location_name,
    event_site_id,
    coverage_time_zone,
    event_requires_armed,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_overtime,
    target_notes,
    publish_announcement,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );

  result_schedule_id := (result->>'schedule_id')::uuid;
  original_shift_id := (result->>'shift_id')::uuid;

  if original_shift_id is not null then
    select shift.* into original_shift
    from public.shifts shift
    where shift.id = original_shift_id;
  end if;

  perform private.normalize_schedule_duplicate_shift_blocks(result_schedule_id);

  if original_shift.id is not null then
    select shift.id into normalized_shift_id
    from public.shifts shift
    where shift.schedule_id = original_shift.schedule_id
      and shift.post_id is not distinct from original_shift.post_id
      and shift.event_id is not distinct from original_shift.event_id
      and shift.starts_at = original_shift.starts_at
      and shift.ends_at = original_shift.ends_at
      and shift.time_zone = original_shift.time_zone
      and shift.requires_armed = original_shift.requires_armed
      and shift.canceled_at is null
    order by shift.created_at, shift.id
    limit 1;

    if normalized_shift_id is not null then
      update public.announcements announcement
      set shift_id = normalized_shift_id
      where announcement.shift_id = original_shift_id
        and normalized_shift_id <> original_shift_id;

      result := jsonb_set(result, '{shift_id}', to_jsonb(normalized_shift_id), true);

      if target_employee_id is not null then
        select assignment.id into normalized_assignment_id
        from public.shift_assignments assignment
        where assignment.shift_id = normalized_shift_id
          and assignment.employee_id = target_employee_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
        order by assignment.assigned_at desc, assignment.id
        limit 1;

        if normalized_assignment_id is not null then
          result := jsonb_set(result, '{assignment_id}', to_jsonb(normalized_assignment_id), true);
        end if;
      end if;
    end if;
  end if;

  return result;
end
$$;

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
  result jsonb;
  result_schedule_id uuid;
  result_week date;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit a draft shift.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null
  for update;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, target_shift.time_zone
  );

  result := private.update_schedule_draft_shift_unmerged(
    target_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );

  result_schedule_id := (result->>'id')::uuid;
  result_week := (result->>'week_starts_on')::date;
  perform private.normalize_schedule_duplicate_shift_blocks(result_schedule_id);

  return public.get_weekly_schedule_payload(result_week);
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
declare
  employee_time_zone text;
  proposed_time_zone text;
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  if coalesce(use_employee_time_zone, false) then
    select employee.time_zone into employee_time_zone
    from public.employees employee
    where employee.id = target_employee_id and employee.status = 'active';
    proposed_time_zone := employee_time_zone;
  elsif target_post_id is not null then
    select site.time_zone into proposed_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  else
    proposed_time_zone := nullif(btrim(coalesce(event_time_zone, '')), '');
  end if;

  perform 1
  from (select distinct unnest(shift_operational_dates) proposed_date) dates
  cross join lateral private.validate_schedule_wall_clock_range(
    dates.proposed_date, shift_start_time, shift_end_time, proposed_time_zone
  ) validated;

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

  result := public.get_scheduled_overtime_create_preview(
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

create or replace function public.get_scheduled_overtime_update_preview(
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
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to calculate scheduled overtime.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, target_shift.time_zone
  );

  return private.scheduled_overtime_update_preview(
    target_shift_id, target_employee_id, shift_operational_date,
    shift_start_time, shift_end_time
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

  select shift.* into target_shift
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

  result := public.get_scheduled_overtime_update_preview(
    target_shift_id, target_employee_id, shift_operational_date,
    shift_start_time, shift_end_time
  );

  if not dispatch_location or target_dispatch_mode = 'primary_shift' then
    proposed_starts_at := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
    proposed_ends_at := (
      (case when shift_end_time <= shift_start_time then shift_operational_date + 1 else shift_operational_date end)
      + shift_end_time
    ) at time zone target_shift.time_zone;
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

-- Linked events retain Site Time authority when a week is copied. Refresh the
-- current linked Site zone just like a permanent Post; only a standalone
-- event keeps its own explicit event-zone snapshot.
create or replace function public.replace_schedule_week_draft_from_revision(
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
  actor_id uuid := private.current_employee_id();
  source_schedule public.schedules%rowtype;
  destination_schedule public.schedules%rowtype;
  source_shift public.shifts%rowtype;
  source_assignment public.shift_assignments%rowtype;
  copied_shift public.shifts%rowtype;
  new_shift_id uuid;
  source_local_start timestamp without time zone;
  source_local_end timestamp without time zone;
  destination_local_start timestamp without time zone;
  destination_local_end timestamp without time zone;
  destination_time_zone text;
  local_weekday_offset integer;
  local_end_day_offset integer;
  shifted_start timestamptz;
  shifted_end timestamptz;
  expected_shift_count integer := 0;
  expected_assignment_count integer := 0;
  copied_shift_count integer := 0;
  copied_assignment_count integer := 0;
  replaced_shift_count integer := 0;
  skipped_inactive_assignment_count integer := 0;
  carried_credential_override_count integer := 0;
  copied_site_count integer := 0;
  refreshed_time_zone_count integer := 0;
  employee_time_zone_source_count integer := 0;
  site_time_zone_source_count integer := 0;
  explicit_time_zone_source_count integer := 0;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to copy schedule weeks.';
  end if;

  if source_schedule_id is null or destination_week_starts_on is null then
    raise check_violation using message = 'A source schedule revision and destination week are required.';
  end if;

  if extract(dow from destination_week_starts_on) <> 0 then
    raise check_violation using message = 'The destination schedule week must start on Sunday.';
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.id = source_schedule_id
    and schedule.status in ('draft', 'published')
  for share;

  if source_schedule.id is null then
    raise check_violation using message = 'The selected source schedule revision is no longer available.';
  end if;

  if source_schedule.week_starts_on = destination_week_starts_on then
    raise check_violation using message = 'Choose a destination week different from the source week.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('schedule-copy:' || source_schedule.id::text || ':' || destination_week_starts_on::text)
  );

  perform public.ensure_schedule_draft(destination_week_starts_on);

  select schedule.* into destination_schedule
  from public.schedules schedule
  where schedule.week_starts_on = destination_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1
  for update;

  if destination_schedule.id is null then
    raise check_violation using message = 'A destination working draft could not be opened.';
  end if;

  select count(*)::integer into replaced_shift_count
  from public.shifts shift
  where shift.schedule_id = destination_schedule.id
    and shift.canceled_at is null;

  update public.shift_requests request
  set
    status = 'canceled',
    decision_note = 'Replaced when another schedule week was copied into this draft.',
    decided_by = actor_id,
    decided_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where request.status = 'pending'
    and exists (
      select 1
      from public.shifts shift
      where shift.id = request.shift_id
        and shift.schedule_id = destination_schedule.id
        and shift.canceled_at is null
    );

  update public.shift_assignments assignment
  set
    status = 'canceled',
    canceled_at = clock_timestamp(),
    cancellation_reason = 'Replaced when another schedule week was copied into this draft.',
    updated_at = clock_timestamp()
  where assignment.status <> 'canceled'
    and exists (
      select 1
      from public.shifts shift
      where shift.id = assignment.shift_id
        and shift.schedule_id = destination_schedule.id
        and shift.canceled_at is null
    );

  update public.shifts shift
  set
    is_open = false,
    canceled_at = clock_timestamp(),
    canceled_by = actor_id,
    cancellation_reason = 'Replaced by copied schedule revision ' || source_schedule.revision::text || '.',
    updated_at = clock_timestamp()
  where shift.schedule_id = destination_schedule.id
    and shift.canceled_at is null;

  select count(*)::integer into expected_shift_count
  from public.shifts shift
  where shift.schedule_id = source_schedule.id
    and shift.canceled_at is null
    and (include_events or shift.event_id is null);

  select count(distinct post.site_id)::integer into copied_site_count
  from public.shifts shift
  join public.posts post on post.id = shift.post_id
  where shift.schedule_id = source_schedule.id
    and shift.canceled_at is null
    and (include_events or shift.event_id is null);

  if include_assignments then
    select
      count(*) filter (where employee.status = 'active')::integer,
      count(*) filter (where employee.status <> 'active')::integer
    into expected_assignment_count, skipped_inactive_assignment_count
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.employees employee on employee.id = assignment.employee_id
    where shift.schedule_id = source_schedule.id
      and shift.canceled_at is null
      and (include_events or shift.event_id is null)
      and assignment.status in ('assigned', 'confirmed', 'completed');
  end if;

  for source_shift in
    select shift.*
    from public.shifts shift
    where shift.schedule_id = source_schedule.id
      and shift.canceled_at is null
      and (include_events or shift.event_id is null)
    order by shift.starts_at, shift.created_at, shift.id
  loop
    if source_shift.time_zone is null or not exists (
      select 1
      from pg_catalog.pg_timezone_names zone
      where zone.name = source_shift.time_zone
    ) then
      raise check_violation using message = format(
        'Shift %s has an invalid recorded time zone and cannot be copied safely.',
        source_shift.id
      );
    end if;

    source_local_start := source_shift.starts_at at time zone source_shift.time_zone;
    source_local_end := source_shift.ends_at at time zone source_shift.time_zone;
    local_weekday_offset := source_local_start::date - source_schedule.week_starts_on;
    local_end_day_offset := source_local_end::date - source_local_start::date;

    if source_shift.time_zone_source = 'employee' then
      select employee.time_zone
      into destination_time_zone
      from public.employees employee
      where employee.id = source_shift.time_zone_employee_id;

      if destination_time_zone is null then
        raise check_violation using message = format(
          'The employee time zone for shift %s could not be found.',
          source_shift.id
        );
      end if;

      employee_time_zone_source_count := employee_time_zone_source_count + 1;
    elsif source_shift.time_zone_source = 'site' then
      if source_shift.post_id is not null then
        select site.time_zone
        into destination_time_zone
        from public.posts post
        join public.sites site on site.id = post.site_id
        where post.id = source_shift.post_id;
      elsif source_shift.event_id is not null then
        select case
          when event.site_id is null then event.time_zone
          else site.time_zone
        end
        into destination_time_zone
        from public.events event
        left join public.sites site on site.id = event.site_id
        where event.id = source_shift.event_id;
      else
        destination_time_zone := null;
      end if;

      if destination_time_zone is null then
        raise check_violation using message = format(
          'The current site or event time zone for shift %s could not be found.',
          source_shift.id
        );
      end if;

      site_time_zone_source_count := site_time_zone_source_count + 1;
    elsif source_shift.time_zone_source = 'explicit' then
      destination_time_zone := source_shift.time_zone;
      explicit_time_zone_source_count := explicit_time_zone_source_count + 1;
    else
      raise check_violation using message = format(
        'Shift %s has an unsupported time-zone source and cannot be copied safely.',
        source_shift.id
      );
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_timezone_names zone
      where zone.name = destination_time_zone
    ) then
      raise check_violation using message = format(
        'Shift %s resolves to an invalid destination time zone and cannot be copied safely.',
        source_shift.id
      );
    end if;

    if destination_time_zone is distinct from source_shift.time_zone then
      refreshed_time_zone_count := refreshed_time_zone_count + 1;
    end if;

    destination_local_start := (
      destination_week_starts_on + local_weekday_offset
    ) + source_local_start::time;
    destination_local_end := (
      destination_week_starts_on + local_weekday_offset + local_end_day_offset
    ) + source_local_end::time;
    shifted_start := destination_local_start at time zone destination_time_zone;
    shifted_end := destination_local_end at time zone destination_time_zone;

    -- PostgreSQL normalizes a nonexistent spring-forward wall clock into a
    -- different local time. The round trip makes that normalization explicit
    -- and aborts the entire replacement rather than silently moving a shift.
    if shifted_start at time zone destination_time_zone is distinct from destination_local_start
      or shifted_end at time zone destination_time_zone is distinct from destination_local_end
    then
      raise check_violation using message = format(
        'Shift %s lands on a local time that does not exist in %s because of daylight-saving time. The destination draft was not changed.',
        source_shift.id,
        destination_time_zone
      );
    end if;

    if shifted_end <= shifted_start then
      raise check_violation using message = format(
        'Shift %s would not end after it starts in %s. The destination draft was not changed.',
        source_shift.id,
        destination_time_zone
      );
    end if;

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
      work_type,
      time_zone_source,
      time_zone_employee_id,
      assignment_type,
      created_by
    ) values (
      destination_schedule.id,
      source_shift.post_id,
      source_shift.event_id,
      shifted_start,
      shifted_end,
      destination_time_zone,
      source_shift.headcount_required,
      source_shift.requires_armed,
      true,
      source_shift.is_overtime,
      source_shift.notes,
      source_shift.work_type,
      source_shift.time_zone_source,
      source_shift.time_zone_employee_id,
      source_shift.assignment_type,
      actor_id
    )
    returning * into copied_shift;

    new_shift_id := copied_shift.id;

    if copied_shift.post_id is distinct from source_shift.post_id
      or copied_shift.event_id is distinct from source_shift.event_id
      or copied_shift.starts_at is distinct from shifted_start
      or copied_shift.ends_at is distinct from shifted_end
      or copied_shift.time_zone is distinct from destination_time_zone
      or copied_shift.time_zone_source is distinct from source_shift.time_zone_source
      or copied_shift.time_zone_employee_id is distinct from source_shift.time_zone_employee_id
      or copied_shift.headcount_required is distinct from source_shift.headcount_required
      or copied_shift.requires_armed is distinct from source_shift.requires_armed
      or copied_shift.is_overtime is distinct from source_shift.is_overtime
      or copied_shift.notes is distinct from source_shift.notes
      or copied_shift.work_type is distinct from source_shift.work_type
      or copied_shift.assignment_type is distinct from source_shift.assignment_type
    then
      raise data_exception using message = format(
        'The week copy was canceled because shift %s did not retain its verified schedule contract.',
        source_shift.id
      );
    end if;

    copied_shift_count := copied_shift_count + 1;

    if include_assignments then
      for source_assignment in
        select assignment.*
        from public.shift_assignments assignment
        join public.employees employee on employee.id = assignment.employee_id
        where assignment.shift_id = source_shift.id
          and assignment.status in ('assigned', 'confirmed', 'completed')
          and employee.status = 'active'
        order by assignment.assigned_at, assignment.id
      loop
        insert into public.schedule_assignment_overrides (
          shift_id,
          employee_id,
          override_kind,
          note,
          created_by,
          created_at
        )
        select
          new_shift_id,
          override_record.employee_id,
          override_record.override_kind,
          override_record.note,
          actor_id,
          clock_timestamp()
        from public.schedule_assignment_overrides override_record
        where override_record.shift_id = source_shift.id
          and override_record.employee_id = source_assignment.employee_id;

        if source_shift.requires_armed
          and not public.has_valid_credential(
            source_assignment.employee_id,
            'armed_guard',
            (shifted_start at time zone destination_time_zone)::date
          )
          and not exists (
            select 1
            from public.schedule_assignment_overrides override_record
            where override_record.shift_id = new_shift_id
              and override_record.employee_id = source_assignment.employee_id
              and override_record.override_kind = 'armed_credential'
          )
        then
          insert into public.schedule_assignment_overrides (
            shift_id,
            employee_id,
            override_kind,
            note,
            created_by,
            created_at
          ) values (
            new_shift_id,
            source_assignment.employee_id,
            'armed_credential',
            'Carried forward from source schedule revision ' || source_schedule.revision::text || ' during the confirmed week-copy workflow.',
            actor_id,
            clock_timestamp()
          );

          carried_credential_override_count := carried_credential_override_count + 1;
        end if;

        insert into public.shift_assignments (
          shift_id,
          employee_id,
          status,
          assigned_by
        ) values (
          new_shift_id,
          source_assignment.employee_id,
          'assigned',
          actor_id
        );

        copied_assignment_count := copied_assignment_count + 1;
      end loop;
    end if;

    update public.shifts shift
    set
      is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
      updated_at = clock_timestamp()
    where shift.id = new_shift_id;
  end loop;

  if copied_shift_count <> expected_shift_count then
    raise data_exception using message = format(
      'The week copy was canceled because only %s of %s shift blocks were verified.',
      copied_shift_count,
      expected_shift_count
    );
  end if;

  if include_assignments and copied_assignment_count <> expected_assignment_count then
    raise data_exception using message = format(
      'The week copy was canceled because only %s of %s active assignments were verified.',
      copied_assignment_count,
      expected_assignment_count
    );
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'schedules',
    'replace_week_draft_from_revision',
    destination_schedule.id::text,
    jsonb_build_object(
      'replaced_shift_count', replaced_shift_count,
      'destination_week_starts_on', destination_week_starts_on
    ),
    jsonb_build_object(
      'source_schedule_id', source_schedule.id,
      'source_revision', source_schedule.revision,
      'source_week_starts_on', source_schedule.week_starts_on,
      'destination_schedule_id', destination_schedule.id,
      'destination_week_starts_on', destination_week_starts_on,
      'copied_shift_count', copied_shift_count,
      'copied_assignment_count', copied_assignment_count,
      'skipped_inactive_assignment_count', skipped_inactive_assignment_count,
      'carried_credential_override_count', carried_credential_override_count,
      'copied_site_count', copied_site_count,
      'refreshed_time_zone_count', refreshed_time_zone_count,
      'employee_time_zone_source_count', employee_time_zone_source_count,
      'site_time_zone_source_count', site_time_zone_source_count,
      'explicit_time_zone_source_count', explicit_time_zone_source_count,
      'wall_clock_copy_verified', true,
      'include_assignments', include_assignments,
      'include_events', include_events
    )
  );

  return jsonb_build_object(
    'schedule', public.get_weekly_schedule_payload(destination_week_starts_on),
    'copiedCount', copied_shift_count,
    'copiedAssignmentCount', copied_assignment_count,
    'replacedCount', replaced_shift_count,
    'skippedInactiveAssignmentCount', skipped_inactive_assignment_count,
    'carriedCredentialOverrideCount', carried_credential_override_count,
    'siteCount', copied_site_count
  );
end;
$$;

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
begin
  -- The repaired replacement core now copies and verifies work type, time-basis
  -- authority, and assignment type in the same insert. Do not try to rejoin
  -- source and destination by adding a fixed UTC interval across DST.
  return public.replace_schedule_week_draft_from_revision(
    source_schedule_id,
    destination_week_starts_on,
    include_assignments,
    include_events
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
  actor_id uuid := private.current_employee_id();
  coverage_time_zone text;
  result jsonb;
  assignment_shift_id uuid;
  new_assignment_id uuid;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create coverage.';
  end if;

  coverage_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, event_site_id, event_time_zone
  );

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, coverage_time_zone
  );

  if target_employee_id is null then
    return public.scheduler_create_coverage_plan(
      target_week_starts_on, target_post_id, event_name, event_location_name,
      event_site_id, coverage_time_zone, shift_operational_date, shift_start_time,
      shift_end_time, target_headcount, target_armed_headcount, target_is_overtime,
      target_notes, target_work_type, publish_announcement, null, false, null, null
    );
  end if;

  result := public.scheduler_create_coverage_plan(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, coverage_time_zone, shift_operational_date, shift_start_time,
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
  coverage_time_zone text;
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

  coverage_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, event_site_id, event_time_zone
  );
  if target_post_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_location
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active;
  elsif event_site_id is not null then
    select site.supports_dispatch_phone_duty into dispatch_location
    from public.sites site
    where site.id = event_site_id and site.active;
  end if;

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, coverage_time_zone
  );

  if target_dispatch_mode = 'concurrent_duty' and not coalesce(dispatch_location, false) then
    raise check_violation using message = 'Concurrent phone duty can only be used with the Dispatch coverage location.';
  end if;
  if coalesce(dispatch_location, false) and target_dispatch_mode = 'concurrent_duty' then
    resolved_assignment_type := 'dispatch_phone_duty';
  end if;

  result := public.scheduler_create_coverage_plan_v2(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, coverage_time_zone, shift_operational_date, shift_start_time,
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
      'assignedEmployeeId', target_employee_id,
      'timeZone', coverage_time_zone,
      'dstRoundTripValidated', true
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
  entered_local_start timestamp without time zone;
  entered_local_end timestamp without time zone;
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
  if shift_operational_date is null or shift_start_time is null or shift_end_time is null then
    raise check_violation using message = 'Choose a valid date, start time, and end time.';
  end if;
  if target_headcount <> 1 or target_armed_headcount not in (0, 1) then
    raise check_violation using message = 'Employee-local time is limited to a one-person assigned shift.';
  end if;

  select employee.time_zone into employee_time_zone
  from public.employees employee
  where employee.id = target_employee_id and employee.status = 'active';
  if employee_time_zone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = employee_time_zone
  ) then
    raise check_violation using message = 'The selected active employee does not have a supported time zone.';
  end if;

  source_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, event_site_id, event_time_zone
  );

  entered_local_start := shift_operational_date + shift_start_time;
  entered_local_end := (
    shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end
  ) + shift_end_time;
  localized_starts_at := entered_local_start at time zone employee_time_zone;
  localized_ends_at := entered_local_end at time zone employee_time_zone;

  if localized_starts_at at time zone employee_time_zone is distinct from entered_local_start then
    raise check_violation using message = format(
      'The entered start time does not exist in %s because of daylight-saving time. Choose another time.',
      employee_time_zone
    );
  end if;
  if localized_ends_at at time zone employee_time_zone is distinct from entered_local_end then
    raise check_violation using message = format(
      'The entered end time does not exist in %s because of daylight-saving time. Choose another time.',
      employee_time_zone
    );
  end if;
  if localized_ends_at <= localized_starts_at then
    raise check_violation using message = 'Shift end must be after shift start.';
  end if;

  source_operational_date := (localized_starts_at at time zone source_time_zone)::date;
  source_start_time := (localized_starts_at at time zone source_time_zone)::time;
  source_end_time := (localized_ends_at at time zone source_time_zone)::time;

  if (source_operational_date + source_start_time) at time zone source_time_zone
      is distinct from localized_starts_at
    or (
      source_operational_date
      + case when source_end_time <= source_start_time then 1 else 0 end
      + source_end_time
    ) at time zone source_time_zone is distinct from localized_ends_at
  then
    raise check_violation using message = format(
      'That Employee Time range cannot be represented unambiguously in %s. Choose another time.',
      source_time_zone
    );
  end if;

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
      'dispatchMode', target_dispatch_mode, 'existingRecordsChanged', false,
      'dstRoundTripValidated', true
    )
  );

  return jsonb_set(result, '{time_zone}', to_jsonb(employee_time_zone), true);
end
$$;

create or replace function public.scheduler_update_typed_draft_shift_v2(
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
  target_shift public.shifts%rowtype;
  overtime_preview jsonb;
  clean_overtime_note text := nullif(btrim(coalesce(target_overtime_override_note, '')), '');
  approval_carried_forward boolean := false;
  result_payload jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to edit a draft shift.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null
  for update;

  if target_shift.id is null then
    raise check_violation using message = 'The selected shift could not be found.';
  end if;

  perform 1
  from private.validate_schedule_wall_clock_range(
    shift_operational_date, shift_start_time, shift_end_time, target_shift.time_zone
  );

  if clean_overtime_note is not null and char_length(clean_overtime_note) > 2000 then
    raise check_violation using message = 'Scheduled overtime approval notes must be 2,000 characters or fewer.';
  end if;

  if target_employee_id is not null then
    overtime_preview := private.scheduled_overtime_update_preview(
      target_shift_id,
      target_employee_id,
      shift_operational_date,
      shift_start_time,
      shift_end_time
    );
    approval_carried_forward := coalesce((overtime_preview ->> 'approvalCarriedForward')::boolean, false);

    if coalesce((overtime_preview ->> 'requiresOverride')::boolean, false) then
      if not private.can_override_schedule_warnings() then
        raise insufficient_privilege using message = 'MFA-verified schedule override access is required to approve scheduled overtime.';
      end if;

      if clean_overtime_note is null then
        raise check_violation using message = format(
          'This change would schedule %s hours for the week, including %s overtime hours. Add an approval note to continue.',
          round(coalesce((overtime_preview ->> 'resultingMinutes')::numeric, 0) / 60.0, 2),
          round(coalesce((overtime_preview ->> 'overtimeMinutes')::numeric, 0) / 60.0, 2)
        );
      end if;
    end if;
  end if;

  if not approval_carried_forward then
    delete from public.schedule_assignment_overrides assignment_override
    where assignment_override.shift_id = target_shift_id
      and assignment_override.override_kind = 'scheduled_overtime';
  end if;

  if target_employee_id is not null
    and coalesce((overtime_preview ->> 'requiresOverride')::boolean, false)
  then
    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift_id,
      target_employee_id,
      'scheduled_overtime',
      clean_overtime_note,
      actor_id
    );
  end if;

  result_payload := public.scheduler_update_typed_draft_shift(
    target_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    target_work_type,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );

  if target_employee_id is not null
    and coalesce((overtime_preview ->> 'requiresOverride')::boolean, false)
  then
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
      'schedule_assignment_overrides',
      'approve_scheduled_overtime_edit',
      target_shift_id::text,
      overtime_preview || jsonb_build_object(
        'assignedEmployeeId', target_employee_id,
        'approvalNote', clean_overtime_note,
        'dstRoundTripValidated', true
      )
    );
  end if;

  return result_payload;
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
  entered_local_start timestamp without time zone;
  entered_local_end timestamp without time zone;
  validated_starts_at timestamptz;
  validated_ends_at timestamptz;
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
  if shift_operational_date is null or shift_start_time is null or shift_end_time is null then
    raise check_violation using message = 'Choose a valid date, start time, and end time.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null
  for update;

  if target_shift.id is not null then
    select schedule.* into target_schedule
    from public.schedules schedule
    where schedule.id = target_shift.schedule_id;
  end if;

  if target_shift.id is null or target_schedule.status <> 'draft' then
    raise check_violation using message = 'Only a shift in the working schedule draft can be edited.';
  end if;
  if target_shift.time_zone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names zone
    where zone.name = target_shift.time_zone
  ) then
    raise check_violation using message = 'The shift time zone could not be verified.';
  end if;

  entered_local_start := shift_operational_date + shift_start_time;
  entered_local_end := (
    shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end
  ) + shift_end_time;
  validated_starts_at := entered_local_start at time zone target_shift.time_zone;
  validated_ends_at := entered_local_end at time zone target_shift.time_zone;

  if validated_starts_at at time zone target_shift.time_zone is distinct from entered_local_start then
    raise check_violation using message = format(
      'The entered start time does not exist in %s because of daylight-saving time. Choose another time.',
      target_shift.time_zone
    );
  end if;
  if validated_ends_at at time zone target_shift.time_zone is distinct from entered_local_end then
    raise check_violation using message = format(
      'The entered end time does not exist in %s because of daylight-saving time. Choose another time.',
      target_shift.time_zone
    );
  end if;
  if validated_ends_at <= validated_starts_at then
    raise check_violation using message = 'Shift end must be after shift start.';
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
      jsonb_build_object(
        'assignmentType', new_assignment_type,
        'dispatchMode', target_dispatch_mode,
        'dstRoundTripValidated', true
      )
    );
  end if;

  return result;
end
$$;

create or replace function public.scheduler_create_coverage_plan_batch_v1(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  shift_operational_dates date[],
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
  target_dispatch_overlap_acknowledged boolean default false,
  use_employee_time_zone boolean default false,
  expected_time_zone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  authoritative_time_zone text;
  resolved_event_time_zone text := event_time_zone;
  source_site_time_zone text;
  shift_date date;
  item jsonb;
  results jsonb := '[]'::jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to create coverage.';
  end if;
  if shift_operational_dates is null
    or cardinality(shift_operational_dates) = 0
    or cardinality(shift_operational_dates) > 31
  then
    raise check_violation using message = 'Choose between one and 31 shift dates.';
  end if;
  if exists (
    select 1
    from unnest(shift_operational_dates) proposed_date
    where proposed_date is null
      or proposed_date not between target_week_starts_on and target_week_starts_on + 6
  ) then
    raise check_violation using message = 'Every proposed shift date must be inside the selected Sunday-Saturday week.';
  end if;
  if cardinality(shift_operational_dates) <> (
    select count(distinct proposed_date)
    from unnest(shift_operational_dates) proposed_date
  ) then
    raise check_violation using message = 'Each repeated shift date must be unique.';
  end if;

  if target_post_id is not null then
    select site.time_zone into source_site_time_zone
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id and post.active and site.active
    for share of post, site;
  elsif event_site_id is not null then
    select site.time_zone into source_site_time_zone
    from public.sites site
    where site.id = event_site_id and site.active
    for share of site;
    resolved_event_time_zone := source_site_time_zone;
  else
    source_site_time_zone := nullif(btrim(coalesce(event_time_zone, '')), '');
    resolved_event_time_zone := source_site_time_zone;
  end if;

  -- Re-resolve through the common supported-zone gate while the selected
  -- Post/Site row remains share-locked for the rest of this atomic statement.
  source_site_time_zone := private.resolve_schedule_source_time_zone(
    target_post_id, event_site_id, event_time_zone
  );
  if target_post_id is null then
    resolved_event_time_zone := source_site_time_zone;
  end if;

  if coalesce(use_employee_time_zone, false) then
    if target_employee_id is null or target_headcount <> 1 then
      raise check_violation using message = 'Employee Time is limited to a one-person assigned shift.';
    end if;
    select employee.time_zone into authoritative_time_zone
    from public.employees employee
    where employee.id = target_employee_id and employee.status = 'active'
    for share of employee;
  else
    authoritative_time_zone := source_site_time_zone;
  end if;

  if authoritative_time_zone is null
    or nullif(btrim(coalesce(expected_time_zone, '')), '') is null
    or authoritative_time_zone is distinct from expected_time_zone
  then
    raise serialization_failure using message = format(
      'The schedule time zone changed before save (expected %s, current %s). Refresh and review the shift before trying again.',
      coalesce(expected_time_zone, 'unknown'),
      coalesce(authoritative_time_zone, 'unknown')
    );
  end if;

  -- Preflight every date against the locked authoritative basis before the
  -- first child mutator runs. The outer function is one database statement,
  -- so any later child failure rolls every date back atomically.
  if coalesce(use_employee_time_zone, false) then
    perform 1
    from (select distinct unnest(shift_operational_dates) proposed_date) dates
    cross join lateral private.validate_employee_schedule_wall_clock_range(
      target_employee_id,
      target_post_id,
      event_site_id,
      resolved_event_time_zone,
      dates.proposed_date,
      shift_start_time,
      shift_end_time
    ) validated;
  else
    perform 1
    from (select distinct unnest(shift_operational_dates) proposed_date) dates
    cross join lateral private.validate_schedule_wall_clock_range(
      dates.proposed_date,
      shift_start_time,
      shift_end_time,
      authoritative_time_zone
    ) validated;
  end if;

  foreach shift_date in array shift_operational_dates
  loop
    if coalesce(use_employee_time_zone, false) then
      item := public.scheduler_create_employee_local_coverage_plan_v3(
        target_week_starts_on, target_post_id, event_name, event_location_name,
        event_site_id, resolved_event_time_zone, shift_date, shift_start_time,
        shift_end_time, target_headcount, target_armed_headcount,
        target_is_overtime, target_notes, target_work_type, false,
        target_employee_id, target_assignment_requires_armed,
        target_availability_override_note, target_credential_override_note,
        target_overtime_override_note, target_dispatch_mode,
        target_dispatch_overlap_acknowledged
      );
    else
      item := public.scheduler_create_coverage_plan_v3(
        target_week_starts_on, target_post_id, event_name, event_location_name,
        event_site_id, resolved_event_time_zone, shift_date, shift_start_time,
        shift_end_time, target_headcount, target_armed_headcount,
        target_is_overtime, target_notes, target_work_type,
        publish_announcement, target_employee_id,
        target_assignment_requires_armed, target_availability_override_note,
        target_credential_override_note, target_overtime_override_note,
        target_dispatch_mode, target_dispatch_overlap_acknowledged
      );
    end if;
    results := results || jsonb_build_array(item);
  end loop;

  return jsonb_build_object(
    'results', results,
    'time_zone', authoritative_time_zone,
    'date_count', cardinality(shift_operational_dates),
    'atomic', true
  );
end
$$;

revoke all on function private.validate_schedule_wall_clock_range(date, time, time, text)
  from public, anon, authenticated;
revoke all on function private.resolve_schedule_source_time_zone(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function private.validate_employee_schedule_wall_clock_range(uuid, uuid, uuid, text, date, time, time)
  from public, anon, authenticated;
revoke all on function private.scheduler_create_coverage_plan_unvalidated(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text
) from public, anon, authenticated;
revoke all on function private.scheduler_create_employee_local_coverage_plan_unvalidated(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text
) from public, anon, authenticated;
revoke all on function private.scheduler_create_employee_local_coverage_plan_v2_unvalidated(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text
) from public, anon, authenticated;
revoke all on function private.create_supervisor_open_shift_unmerged(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, boolean, uuid, text, text
) from public, anon, authenticated;
revoke all on function private.update_schedule_draft_shift_unmerged(
  uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text
) from public, anon, authenticated;
revoke all on function private.scheduled_overtime_create_preview(
  date, uuid, uuid, text, date[], time, time, boolean
) from public, anon, authenticated;
revoke all on function private.scheduled_overtime_update_preview(
  uuid, uuid, date, time, time
) from public, anon, authenticated;

-- Schedule writes are an RPC-only boundary. Direct REST writes would bypass
-- the wall-clock source, DST, authorization, assignment, and audit contract.
revoke insert, update, delete on table public.shifts from anon, authenticated;
revoke insert, update, delete on table public.shift_assignments from anon, authenticated;
revoke insert, update, delete on table public.schedules from anon, authenticated;

revoke all on function public.copy_schedule_week_to_draft(date, date, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.replace_schedule_week_draft_with_work_types(uuid, date, boolean, boolean)
  from public, anon;
grant execute on function public.replace_schedule_week_draft_with_work_types(uuid, date, boolean, boolean)
  to authenticated;

revoke all on function public.create_supervisor_open_shift(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, boolean, uuid, text, text
) from public, anon;
grant execute on function public.create_supervisor_open_shift(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, boolean, uuid, text, text
) to authenticated;
revoke all on function public.scheduler_create_open_shift(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, boolean, uuid, text, text
) from public, anon;
grant execute on function public.scheduler_create_open_shift(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, boolean, uuid, text, text
) to authenticated;
revoke all on function public.scheduler_create_typed_open_shift(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, text, boolean, uuid, text, text
) from public, anon;
grant execute on function public.scheduler_create_typed_open_shift(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, text, boolean, uuid, text, text
) to authenticated;

revoke all on function public.scheduler_create_coverage_plan(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text
) from public, anon;
grant execute on function public.scheduler_create_coverage_plan(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text
) to authenticated;

revoke all on function public.scheduler_create_coverage_plan_v2(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text
) from public, anon;
grant execute on function public.scheduler_create_coverage_plan_v2(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text
) to authenticated;

revoke all on function public.scheduler_create_coverage_plan_v3(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean
) from public, anon;
grant execute on function public.scheduler_create_coverage_plan_v3(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean
) to authenticated;

revoke all on function public.scheduler_create_coverage_plan_batch_v1(
  date, uuid, text, text, uuid, text, date[], time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean,
  boolean, text
) from public, anon;
grant execute on function public.scheduler_create_coverage_plan_batch_v1(
  date, uuid, text, text, uuid, text, date[], time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean,
  boolean, text
) to authenticated;

revoke all on function public.scheduler_create_employee_local_coverage_plan(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text
) from public, anon;
grant execute on function public.scheduler_create_employee_local_coverage_plan(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text
) to authenticated;
revoke all on function public.scheduler_create_employee_local_coverage_plan_v2(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text
) from public, anon;
grant execute on function public.scheduler_create_employee_local_coverage_plan_v2(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text
) to authenticated;

revoke all on function public.scheduler_create_employee_local_coverage_plan_v3(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean
) from public, anon;
grant execute on function public.scheduler_create_employee_local_coverage_plan_v3(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean
) to authenticated;

revoke all on function public.update_schedule_draft_shift(
  uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text
) from public, anon;
grant execute on function public.update_schedule_draft_shift(
  uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text
) to authenticated;
revoke all on function public.scheduler_update_draft_shift(
  uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text
) from public, anon;
grant execute on function public.scheduler_update_draft_shift(
  uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text
) to authenticated;
revoke all on function public.scheduler_update_typed_draft_shift(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text
) from public, anon, authenticated;

revoke all on function public.scheduler_update_typed_draft_shift_v2(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text
) from public, anon;
grant execute on function public.scheduler_update_typed_draft_shift_v2(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text
) to authenticated;

revoke all on function public.get_scheduled_overtime_create_preview(
  date, uuid, uuid, text, date[], time, time, boolean
) from public, anon;
grant execute on function public.get_scheduled_overtime_create_preview(
  date, uuid, uuid, text, date[], time, time, boolean
) to authenticated;
revoke all on function public.get_scheduled_overtime_create_preview_v2(
  date, uuid, uuid, text, date[], time, time, boolean, text
) from public, anon;
grant execute on function public.get_scheduled_overtime_create_preview_v2(
  date, uuid, uuid, text, date[], time, time, boolean, text
) to authenticated;
revoke all on function public.get_scheduled_overtime_update_preview(
  uuid, uuid, date, time, time
) from public, anon;
grant execute on function public.get_scheduled_overtime_update_preview(
  uuid, uuid, date, time, time
) to authenticated;
revoke all on function public.get_scheduled_overtime_update_preview_v2(
  uuid, uuid, date, time, time, text
) from public, anon;
grant execute on function public.get_scheduled_overtime_update_preview_v2(
  uuid, uuid, date, time, time, text
) to authenticated;

revoke all on function public.scheduler_update_typed_draft_shift_v3(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text
) from public, anon;
grant execute on function public.scheduler_update_typed_draft_shift_v3(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text
) to authenticated;

comment on function private.validate_schedule_wall_clock_range(date, time, time, text) is
  'Validates start and end wall clocks by round-tripping PostgreSQL time-zone conversion, rejecting DST gaps before a schedule write.';

comment on function private.resolve_schedule_source_time_zone(uuid, uuid, text) is
  'Resolves authoritative Post or linked-Site time zones and requires an explicit supported zone for standalone events.';

comment on function private.set_shift_security_fields() is
  'Enforces Post, linked-event Site, standalone-event, employee, or explicit time-zone provenance on every shift write.';

comment on function public.scheduler_create_coverage_plan_v2(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text
) is
  'Creates coverage only after Site/Event wall clocks round-trip through the authoritative time zone without DST normalization.';

comment on function public.scheduler_create_coverage_plan_v3(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean
) is
  'Creates Dispatch-aware coverage only after Site/Event wall clocks round-trip through the authoritative time zone without DST normalization.';

comment on function public.scheduler_create_coverage_plan_batch_v1(
  date, uuid, text, text, uuid, text, date[], time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean,
  boolean, text
) is
  'Creates a repeated coverage series atomically after locking its authoritative zone, matching the previewed zone, and validating every wall clock before the first write.';

comment on function public.scheduler_create_employee_local_coverage_plan_v3(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text, boolean
) is
  'Creates one-person employee-local coverage after both entered wall clocks round-trip through the authoritative employee zone without DST normalization.';

comment on function public.scheduler_update_typed_draft_shift_v2(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text
) is
  'Edits a typed draft shift only after both entered wall clocks round-trip through the shift time zone without DST normalization.';

comment on function public.scheduler_update_typed_draft_shift_v3(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text, text, text
) is
  'Edits a typed draft shift and changes Dispatch mode atomically only after both entered wall clocks round-trip through the shift time zone without DST normalization.';

do $verify_schedule_dst_boundaries$
declare
  helper_definition text;
  base_create_definition text;
  create_definition text;
  employee_create_definition text;
  base_edit_definition text;
  edit_definition text;
begin
  select pg_get_functiondef(
    'private.validate_schedule_wall_clock_range(date,time without time zone,time without time zone,text)'::regprocedure
  ) into helper_definition;
  select pg_get_functiondef(
    'public.scheduler_create_coverage_plan_v2(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)'::regprocedure
  ) into base_create_definition;
  select pg_get_functiondef(
    'public.scheduler_create_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)'::regprocedure
  ) into create_definition;
  select pg_get_functiondef(
    'public.scheduler_create_employee_local_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)'::regprocedure
  ) into employee_create_definition;
  select pg_get_functiondef(
    'public.scheduler_update_typed_draft_shift_v2(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text)'::regprocedure
  ) into base_edit_definition;
  select pg_get_functiondef(
    'public.scheduler_update_typed_draft_shift_v3(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text)'::regprocedure
  ) into edit_definition;

  if helper_definition is null
    or position('starts_at at time zone target_time_zone is distinct from entered_local_start' in helper_definition) = 0
    or position('ends_at at time zone target_time_zone is distinct from entered_local_end' in helper_definition) = 0
  then
    raise check_violation using message = 'The shared schedule DST round-trip validator did not install completely.';
  end if;

  if base_create_definition is null
    or position('validate_schedule_wall_clock_range' in base_create_definition) = 0
    or position('scheduler_create_coverage_plan(' in base_create_definition) = 0
    or position('validate_schedule_wall_clock_range' in base_create_definition)
      > position('scheduler_create_coverage_plan(' in base_create_definition)
    or create_definition is null
    or position('validate_schedule_wall_clock_range' in create_definition) = 0
    or position('scheduler_create_coverage_plan_v2(' in create_definition) = 0
    or position('validate_schedule_wall_clock_range' in create_definition)
      > position('scheduler_create_coverage_plan_v2(' in create_definition)
  then
    raise check_violation using message = 'The Site/Event create DST boundary was not installed before its first write.';
  end if;

  if employee_create_definition is null
    or position('entered_local_start' in employee_create_definition) = 0
    or position('localized_starts_at at time zone employee_time_zone is distinct from entered_local_start' in employee_create_definition) = 0
    or position('localized_ends_at at time zone employee_time_zone is distinct from entered_local_end' in employee_create_definition) = 0
    or position('cannot be represented unambiguously' in employee_create_definition) = 0
    or position('dstRoundTripValidated' in employee_create_definition) = 0
  then
    raise check_violation using message = 'The employee-local create DST boundary did not install completely.';
  end if;

  if base_edit_definition is null
    or position('select shift.* into target_shift' in base_edit_definition) = 0
    or position('validate_schedule_wall_clock_range' in base_edit_definition) = 0
    or position('delete from public.schedule_assignment_overrides' in base_edit_definition) = 0
    or position('validate_schedule_wall_clock_range' in base_edit_definition)
      > position('delete from public.schedule_assignment_overrides' in base_edit_definition)
    or edit_definition is null
    or position('select shift.* into target_shift' in edit_definition) = 0
    or position('select schedule.* into target_schedule' in edit_definition) = 0
    or position('validated_starts_at at time zone target_shift.time_zone is distinct from entered_local_start' in edit_definition) = 0
    or position('validated_ends_at at time zone target_shift.time_zone is distinct from entered_local_end' in edit_definition) = 0
    or position('update public.shifts shift' in edit_definition) = 0
    or position('does not exist in %s because of daylight-saving time' in edit_definition)
      > position('update public.shifts shift' in edit_definition)
  then
    raise check_violation using message = 'The typed edit DST boundary did not install before its first write.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.scheduler_create_coverage_plan(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.scheduler_create_coverage_plan_v2(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.scheduler_create_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.scheduler_create_employee_local_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.scheduler_create_employee_local_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.scheduler_update_typed_draft_shift_v2(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.scheduler_update_typed_draft_shift_v3(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.scheduler_update_typed_draft_shift_v3(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text)',
    'EXECUTE'
  ) then
    raise insufficient_privilege using message = 'The schedule DST execution boundary was not preserved.';
  end if;
end
$verify_schedule_dst_boundaries$;

do $verify_all_authenticated_schedule_boundaries$
declare
  function_signature text;
  function_definition text;
begin
  foreach function_signature in array array[
    'public.create_supervisor_open_shift(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)',
    'public.scheduler_create_open_shift(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)',
    'public.scheduler_create_typed_open_shift(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,text,boolean,uuid,text,text)',
    'public.scheduler_create_coverage_plan(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)',
    'public.scheduler_create_coverage_plan_v2(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)',
    'public.scheduler_create_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)',
    'public.scheduler_create_coverage_plan_batch_v1(date,uuid,text,text,uuid,text,date[],time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean,boolean,text)',
    'public.scheduler_create_employee_local_coverage_plan(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)',
    'public.scheduler_create_employee_local_coverage_plan_v2(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)',
    'public.scheduler_create_employee_local_coverage_plan_v3(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean)',
    'public.update_schedule_draft_shift(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)',
    'public.scheduler_update_draft_shift(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)',
    'public.scheduler_update_typed_draft_shift_v2(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text)',
    'public.scheduler_update_typed_draft_shift_v3(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text)',
    'public.get_scheduled_overtime_create_preview(date,uuid,uuid,text,date[],time without time zone,time without time zone,boolean)',
    'public.get_scheduled_overtime_create_preview_v2(date,uuid,uuid,text,date[],time without time zone,time without time zone,boolean,text)',
    'public.get_scheduled_overtime_update_preview(uuid,uuid,date,time without time zone,time without time zone)',
    'public.get_scheduled_overtime_update_preview_v2(uuid,uuid,date,time without time zone,time without time zone,text)',
    'public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean)'
  ]
  loop
    if not has_function_privilege('authenticated', function_signature, 'EXECUTE')
      or has_function_privilege('anon', function_signature, 'EXECUTE')
    then
      raise insufficient_privilege using message = format(
        'The guarded schedule boundary privilege was not preserved for %s.',
        function_signature
      );
    end if;
  end loop;

  foreach function_signature in array array[
    'private.validate_schedule_wall_clock_range(date,time without time zone,time without time zone,text)',
    'private.resolve_schedule_source_time_zone(uuid,uuid,text)',
    'private.set_shift_security_fields()',
    'private.validate_employee_schedule_wall_clock_range(uuid,uuid,uuid,text,date,time without time zone,time without time zone)',
    'private.scheduler_create_coverage_plan_unvalidated(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)',
    'private.scheduler_create_employee_local_coverage_plan_unvalidated(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text)',
    'private.scheduler_create_employee_local_coverage_plan_v2_unvalidated(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)',
    'private.create_supervisor_open_shift_unmerged(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)',
    'private.update_schedule_draft_shift_unmerged(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)',
    'private.scheduled_overtime_create_preview(date,uuid,uuid,text,date[],time without time zone,time without time zone,boolean)',
    'private.scheduled_overtime_update_preview(uuid,uuid,date,time without time zone,time without time zone)'
  ]
  loop
    if has_function_privilege('authenticated', function_signature, 'EXECUTE')
      or has_function_privilege('anon', function_signature, 'EXECUTE')
    then
      raise insufficient_privilege using message = format(
        'An unvalidated private schedule core remains directly executable: %s.',
        function_signature
      );
    end if;
  end loop;

  if has_function_privilege(
    'authenticated',
    'public.scheduler_update_typed_draft_shift(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text)',
    'EXECUTE'
  ) then
    raise insufficient_privilege using message = 'The obsolete unversioned typed edit RPC remains executable.';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.copy_schedule_week_to_draft(date,date,boolean,boolean)',
    'EXECUTE'
  ) then
    raise insufficient_privilege using message = 'The obsolete fixed-instant week-copy RPC remains executable.';
  end if;

  if has_table_privilege('authenticated', 'public.shifts', 'INSERT')
    or has_table_privilege('authenticated', 'public.shifts', 'UPDATE')
    or has_table_privilege('authenticated', 'public.shifts', 'DELETE')
    or has_table_privilege('anon', 'public.shifts', 'INSERT')
    or has_table_privilege('anon', 'public.shifts', 'UPDATE')
    or has_table_privilege('anon', 'public.shifts', 'DELETE')
  then
    raise insufficient_privilege using message = 'Direct shift writes can bypass the schedule RPC boundary.';
  end if;

  if has_table_privilege('authenticated', 'public.shift_assignments', 'INSERT')
    or has_table_privilege('authenticated', 'public.shift_assignments', 'UPDATE')
    or has_table_privilege('authenticated', 'public.shift_assignments', 'DELETE')
    or has_table_privilege('anon', 'public.shift_assignments', 'INSERT')
    or has_table_privilege('anon', 'public.shift_assignments', 'UPDATE')
    or has_table_privilege('anon', 'public.shift_assignments', 'DELETE')
    or has_table_privilege('authenticated', 'public.schedules', 'INSERT')
    or has_table_privilege('authenticated', 'public.schedules', 'UPDATE')
    or has_table_privilege('authenticated', 'public.schedules', 'DELETE')
    or has_table_privilege('anon', 'public.schedules', 'INSERT')
    or has_table_privilege('anon', 'public.schedules', 'UPDATE')
    or has_table_privilege('anon', 'public.schedules', 'DELETE')
  then
    raise insufficient_privilege using message = 'Direct assignment or schedule writes can bypass the audited RPC boundary.';
  end if;

  select pg_get_functiondef(
    'public.create_supervisor_open_shift(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)'::regprocedure
  ) into function_definition;
  if position('validate_schedule_wall_clock_range' in function_definition) = 0
    or position('validate_schedule_wall_clock_range' in function_definition)
      > position('create_supervisor_open_shift_unmerged' in function_definition)
    or position('select shift.* into original_shift' in function_definition) = 0
  then
    raise check_violation using message = 'The compatible open-shift create boundary is not DST-safe.';
  end if;

  select pg_get_functiondef(
    'public.scheduler_create_coverage_plan_batch_v1(date,uuid,text,text,uuid,text,date[],time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text,text,boolean,boolean,text)'::regprocedure
  ) into function_definition;
  if position('for share of employee' in function_definition) = 0
    or position('authoritative_time_zone is distinct from expected_time_zone' in function_definition) = 0
    or position('resolve_schedule_source_time_zone' in function_definition) = 0
    or position('validate_schedule_wall_clock_range' in function_definition) = 0
    or position('validate_employee_schedule_wall_clock_range' in function_definition) = 0
    or position('foreach shift_date in array shift_operational_dates' in function_definition) = 0
    or position('''atomic'', true' in function_definition) = 0
    or position('validate_schedule_wall_clock_range' in function_definition)
      > position('foreach shift_date in array shift_operational_dates' in function_definition)
    or position('validate_employee_schedule_wall_clock_range' in function_definition)
      > position('foreach shift_date in array shift_operational_dates' in function_definition)
  then
    raise check_violation using message = 'The repeated coverage boundary is not zone-bound and atomic.';
  end if;

  select pg_get_functiondef(
    'public.update_schedule_draft_shift(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)'::regprocedure
  ) into function_definition;
  if position('select shift.* into target_shift' in function_definition) = 0
    or position('validate_schedule_wall_clock_range' in function_definition) = 0
    or position('validate_schedule_wall_clock_range' in function_definition)
      > position('update_schedule_draft_shift_unmerged' in function_definition)
  then
    raise check_violation using message = 'The compatible draft-edit boundary is not DST-safe.';
  end if;

  select pg_get_functiondef(
    'public.scheduler_create_employee_local_coverage_plan_v2(date,uuid,text,text,uuid,text,date,time without time zone,time without time zone,integer,integer,boolean,text,text,boolean,uuid,boolean,text,text,text)'::regprocedure
  ) into function_definition;
  if position('validate_employee_schedule_wall_clock_range' in function_definition) = 0
    or position('validate_employee_schedule_wall_clock_range' in function_definition)
      > position('scheduler_create_employee_local_coverage_plan_v2_unvalidated' in function_definition)
  then
    raise check_violation using message = 'The compatible employee-local v2 boundary is not DST-safe.';
  end if;

  select pg_get_functiondef(
    'private.resolve_schedule_source_time_zone(uuid,uuid,text)'::regprocedure
  ) into function_definition;
  if position('Choose the event time zone.' in function_definition) = 0
    or position('target_event_site_id is not null' in function_definition) = 0
    or position('America/Phoenix' in function_definition) = 0
  then
    raise check_violation using message = 'The scheduler source-zone resolver permits an implicit or unsupported event time zone.';
  end if;

  select pg_get_functiondef(
    'private.set_shift_security_fields()'::regprocedure
  ) into function_definition;
  if position('when event.site_id is null then event.time_zone' in function_definition) = 0
    or position('else site.time_zone' in function_definition) = 0
    or position('left join public.sites site on site.id = event.site_id' in function_definition) = 0
    or position('tg_op = ''UPDATE'' and not source_changed and not provenance_changed' in function_definition) = 0
    or position('new.time_zone := old.time_zone' in function_definition) = 0
  then
    raise check_violation using message = 'The shift security trigger does not preserve recorded edit basis and linked-event Site Time authority.';
  end if;

  select pg_get_functiondef(
    'public.get_scheduled_overtime_create_preview_v2(date,uuid,uuid,text,date[],time without time zone,time without time zone,boolean,text)'::regprocedure
  ) into function_definition;
  if position('get_scheduled_overtime_create_preview(' in function_definition) = 0 then
    raise check_violation using message = 'The create overtime preview bypasses wall-clock validation.';
  end if;

  select pg_get_functiondef(
    'public.get_scheduled_overtime_update_preview_v2(uuid,uuid,date,time without time zone,time without time zone,text)'::regprocedure
  ) into function_definition;
  if position('select shift.* into target_shift' in function_definition) = 0
    or position('get_scheduled_overtime_update_preview(' in function_definition) = 0
  then
    raise check_violation using message = 'The update overtime preview bypasses wall-clock validation or regressed composite loading.';
  end if;

  select pg_get_functiondef(
    'public.replace_schedule_week_draft_with_work_types(uuid,date,boolean,boolean)'::regprocedure
  ) into function_definition;
  if position('replace_schedule_week_draft_from_revision' in function_definition) = 0
    or position('make_interval' in function_definition) > 0
    or position('destination.starts_at = source.starts_at' in function_definition) > 0
  then
    raise check_violation using message = 'The current week-copy wrapper still uses fixed-duration metadata matching.';
  end if;

  select pg_get_functiondef(
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)'::regprocedure
  ) into function_definition;
  if position('when event.site_id is null then event.time_zone' in function_definition) = 0
    or position('else site.time_zone' in function_definition) = 0
    or position('left join public.sites site on site.id = event.site_id' in function_definition) = 0
  then
    raise check_violation using message = 'The week-copy core does not refresh linked-event Site Time authority.';
  end if;
end
$verify_all_authenticated_schedule_boundaries$;

notify pgrst, 'reload schema';

commit;

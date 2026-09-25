begin;
set local lock_timeout = '5s';

-- Copy schedule wall-clock intent rather than adding a duration to UTC. A UTC
-- day interval moves local shifts by an hour when source and destination weeks
-- sit on different sides of daylight-saving changes. It also preserves a stale
-- employee/site zone snapshot after the authoritative profile is corrected.
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
        select event.time_zone
        into destination_time_zone
        from public.events event
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

revoke all on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean)
from public, anon;
grant execute on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean)
to authenticated;

comment on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) is
  'Atomically replaces a destination draft by preserving each source shift wall clock, refreshing employee/site time-zone authority, rejecting nonexistent DST times, and retaining dispatch classification before assignment checks.';

do $verify_schedule_week_copy_time_basis$
declare
  installed_definition text;
begin
  select pg_get_functiondef(procedure.oid)
  into installed_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'replace_schedule_week_draft_from_revision'
    and pg_get_function_identity_arguments(procedure.oid) =
      'source_schedule_id uuid, destination_week_starts_on date, include_assignments boolean, include_events boolean';

  if installed_definition is null
    or position('source_local_start' in installed_definition) = 0
    or position('destination_local_start' in installed_definition) = 0
    or position('destination_time_zone' in installed_definition) = 0
    or position('does not exist in %s because of daylight-saving time' in installed_definition) = 0
    or position('source_shift.work_type' in installed_definition) = 0
    or position('source_shift.assignment_type' in installed_definition) = 0
  then
    raise check_violation using message =
      'The schedule week-copy time-basis repair did not install completely.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)',
    'EXECUTE'
  ) then
    raise insufficient_privilege using message =
      'The schedule week-copy execution boundary was not preserved.';
  end if;
end
$verify_schedule_week_copy_time_basis$;

notify pgrst, 'reload schema';

commit;

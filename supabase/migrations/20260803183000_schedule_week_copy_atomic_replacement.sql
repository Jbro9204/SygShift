begin;

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
  new_shift_id uuid;
  shifted_start timestamptz;
  shifted_end timestamptz;
  day_offset integer;
  expected_shift_count integer := 0;
  expected_assignment_count integer := 0;
  copied_shift_count integer := 0;
  copied_assignment_count integer := 0;
  replaced_shift_count integer := 0;
  skipped_inactive_assignment_count integer := 0;
  carried_credential_override_count integer := 0;
  copied_site_count integer := 0;
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

  day_offset := destination_week_starts_on - source_schedule.week_starts_on;

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
    shifted_start := source_shift.starts_at + make_interval(days => day_offset);
    shifted_end := source_shift.ends_at + make_interval(days => day_offset);

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
      destination_schedule.id,
      source_shift.post_id,
      source_shift.event_id,
      shifted_start,
      shifted_end,
      source_shift.time_zone,
      source_shift.headcount_required,
      source_shift.requires_armed,
      true,
      source_shift.is_overtime,
      source_shift.notes,
      actor_id
    )
    returning id into new_shift_id;

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
            (shifted_start at time zone source_shift.time_zone)::date
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

  if exists (
    select 1
    from public.shifts source
    where source.schedule_id = source_schedule.id
      and source.canceled_at is null
      and (include_events or source.event_id is null)
      and not exists (
        select 1
        from public.shifts destination
        where destination.schedule_id = destination_schedule.id
          and destination.canceled_at is null
          and destination.post_id is not distinct from source.post_id
          and destination.event_id is not distinct from source.event_id
          and destination.starts_at = source.starts_at + make_interval(days => day_offset)
          and destination.ends_at = source.ends_at + make_interval(days => day_offset)
          and destination.time_zone = source.time_zone
          and destination.headcount_required = source.headcount_required
          and destination.requires_armed = source.requires_armed
          and destination.is_overtime = source.is_overtime
          and destination.notes is not distinct from source.notes
      )
  ) then
    raise data_exception using message = 'The week copy was canceled because the destination did not match the source revision.';
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

revoke all on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) to authenticated;

comment on function public.replace_schedule_week_draft_from_revision(uuid, date, boolean, boolean) is
  'Atomically replaces a destination working draft from one exact source revision and verifies the copied schedule before commit.';

notify pgrst, 'reload schema';

commit;

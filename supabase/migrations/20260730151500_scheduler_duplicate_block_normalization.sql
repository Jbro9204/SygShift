begin;

create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_schedule_status public.schedule_status;
  duplicate_group record;
  duplicate_shift_ids uuid[];
  normalized_blocks integer := 0;
begin
  if target_schedule_id is null then
    return 0;
  end if;

  select schedule.status into target_schedule_status
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if target_schedule_status is null or target_schedule_status = 'published' then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-duplicate-normalize:' || target_schedule_id::text));

  for duplicate_group in
    with active_assignment_counts as (
      select
        assignment.shift_id,
        count(*) filter (where assignment.status in ('assigned', 'confirmed', 'completed'))::integer as active_assignments
      from public.shift_assignments assignment
      group by assignment.shift_id
    ),
    grouped_shifts as (
      select
        shift.schedule_id,
        shift.post_id,
        shift.event_id,
        shift.starts_at,
        shift.ends_at,
        shift.time_zone,
        shift.requires_armed,
        array_agg(
          shift.id
          order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id
        ) as shift_ids,
        (array_agg(
          shift.id
          order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id
        ))[1] as survivor_shift_id,
        greatest(
          max(shift.headcount_required),
          sum(coalesce(active_assignment_counts.active_assignments, 0))::integer,
          1
        ) as normalized_headcount,
        bool_or(shift.is_overtime) as normalized_is_overtime
      from public.shifts shift
      left join active_assignment_counts on active_assignment_counts.shift_id = shift.id
      where shift.schedule_id = target_schedule_id
        and shift.canceled_at is null
      group by
        shift.schedule_id,
        shift.post_id,
        shift.event_id,
        shift.starts_at,
        shift.ends_at,
        shift.time_zone,
        shift.requires_armed
      having count(*) > 1
    )
    select *
    from grouped_shifts
  loop
    duplicate_shift_ids := array_remove(duplicate_group.shift_ids, duplicate_group.survivor_shift_id);

    if duplicate_shift_ids is null or array_length(duplicate_shift_ids, 1) is null then
      continue;
    end if;

    update public.shifts shift
    set
      headcount_required = duplicate_group.normalized_headcount,
      is_overtime = coalesce(shift.is_overtime, false) or coalesce(duplicate_group.normalized_is_overtime, false),
      is_open = true,
      updated_at = clock_timestamp()
    where shift.id = duplicate_group.survivor_shift_id;

    update public.schedule_assignment_overrides override_record
    set shift_id = duplicate_group.survivor_shift_id
    where override_record.shift_id = any(duplicate_shift_ids);

    update public.shift_assignments duplicate_assignment
    set
      status = 'canceled',
      canceled_at = coalesce(duplicate_assignment.canceled_at, clock_timestamp()),
      cancellation_reason = coalesce(
        nullif(btrim(duplicate_assignment.cancellation_reason), ''),
        'Duplicate schedule block normalized.'
      ),
      updated_at = clock_timestamp()
    where duplicate_assignment.shift_id = any(duplicate_shift_ids)
      and duplicate_assignment.status in ('assigned', 'confirmed', 'completed')
      and exists (
        select 1
        from public.shift_assignments survivor_assignment
        where survivor_assignment.shift_id = duplicate_group.survivor_shift_id
          and survivor_assignment.employee_id = duplicate_assignment.employee_id
          and survivor_assignment.status in ('assigned', 'confirmed', 'completed')
      );

    update public.shift_assignments assignment
    set
      shift_id = duplicate_group.survivor_shift_id,
      updated_at = clock_timestamp()
    where assignment.shift_id = any(duplicate_shift_ids)
      and assignment.status in ('assigned', 'confirmed', 'completed');

    update public.shifts duplicate_shift
    set
      is_open = false,
      canceled_at = coalesce(duplicate_shift.canceled_at, clock_timestamp()),
      canceled_by = coalesce(actor_id, duplicate_shift.created_by),
      cancellation_reason = coalesce(
        nullif(btrim(duplicate_shift.cancellation_reason), ''),
        'Duplicate schedule block normalized into the primary block.'
      ),
      updated_at = clock_timestamp()
    where duplicate_shift.id = any(duplicate_shift_ids);

    update public.shifts survivor_shift
    set
      is_open = private.active_shift_assignment_count(survivor_shift.id) < survivor_shift.headcount_required,
      updated_at = clock_timestamp()
    where survivor_shift.id = duplicate_group.survivor_shift_id;

    normalized_blocks := normalized_blocks + 1;
  end loop;

  return normalized_blocks;
end;
$$;

create or replace function private.assignment_overlap_conflict(
  target_assignment_id uuid,
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
  conflict_record record;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if target_shift.id is null then
    return null;
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    return null;
  end if;

  select
    assignment.id as assignment_id,
    shift.id as shift_id,
    schedule.id as schedule_id,
    schedule.week_starts_on,
    schedule.revision,
    schedule.status,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    coalesce(site.name || ' / ' || post.name, event.location_name, event.name, 'Unlabeled shift') as location_label,
    btrim(concat_ws(' ', employee.first_name, employee.last_name)) as employee_name
  into conflict_record
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  join public.employees employee on employee.id = assignment.employee_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where assignment.employee_id = target_employee_id
    and assignment.id is distinct from target_assignment_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and shift.id <> target_shift_id
    and shift.canceled_at is null
    and not (
      schedule.id = target_schedule.id
      and shift.post_id is not distinct from target_shift.post_id
      and shift.event_id is not distinct from target_shift.event_id
      and shift.starts_at = target_shift.starts_at
      and shift.ends_at = target_shift.ends_at
      and shift.time_zone = target_shift.time_zone
      and shift.requires_armed = target_shift.requires_armed
    )
    and (
      schedule.id = target_schedule.id
      or (
        schedule.status = 'published'
        and schedule.id is distinct from target_schedule.previous_revision_id
        and not (
          target_schedule.status = 'draft'
          and schedule.week_starts_on = target_schedule.week_starts_on
        )
      )
    )
    and tstzrange(shift.starts_at, shift.ends_at, '[)')
      && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
  order by shift.starts_at, shift.ends_at, schedule.week_starts_on, schedule.revision desc, assignment.id
  limit 1;

  if conflict_record.assignment_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'assignmentId', conflict_record.assignment_id,
    'shiftId', conflict_record.shift_id,
    'scheduleId', conflict_record.schedule_id,
    'weekStartsOn', conflict_record.week_starts_on,
    'revision', conflict_record.revision,
    'status', conflict_record.status,
    'employeeName', conflict_record.employee_name,
    'location', conflict_record.location_label,
    'date', to_char((conflict_record.starts_at at time zone conflict_record.time_zone)::date, 'MM/DD/YYYY'),
    'startsAt', to_char(conflict_record.starts_at at time zone conflict_record.time_zone, 'FMHH12:MI AM'),
    'endsAt', to_char(conflict_record.ends_at at time zone conflict_record.time_zone, 'FMHH12:MI AM'),
    'timeZone', conflict_record.time_zone
  );
end;
$$;

do $$
begin
  if to_regprocedure('private.update_schedule_draft_shift_unmerged(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)') is null
    and to_regprocedure('public.update_schedule_draft_shift(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)') is not null
  then
    alter function public.update_schedule_draft_shift(uuid, date, time without time zone, time without time zone, integer, boolean, boolean, text, uuid, text, text) set schema private;
    alter function private.update_schedule_draft_shift(uuid, date, time without time zone, time without time zone, integer, boolean, boolean, text, uuid, text, text) rename to update_schedule_draft_shift_unmerged;
  end if;

  if to_regprocedure('private.ensure_schedule_draft_unmerged(date)') is null
    and to_regprocedure('public.ensure_schedule_draft(date)') is not null
  then
    alter function public.ensure_schedule_draft(date) set schema private;
    alter function private.ensure_schedule_draft(date) rename to ensure_schedule_draft_unmerged;
  end if;

  if to_regprocedure('private.publish_schedule_draft_unmerged(uuid)') is null
    and to_regprocedure('public.publish_schedule_draft(uuid)') is not null
  then
    alter function public.publish_schedule_draft(uuid) set schema private;
    alter function private.publish_schedule_draft(uuid) rename to publish_schedule_draft_unmerged;
  end if;

  if to_regprocedure('private.create_supervisor_open_shift_unmerged(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)') is null
    and to_regprocedure('public.create_supervisor_open_shift(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)') is not null
  then
    alter function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time without time zone, time without time zone, integer, boolean, text, boolean, uuid, text, text) set schema private;
    alter function private.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time without time zone, time without time zone, integer, boolean, text, boolean, uuid, text, text) rename to create_supervisor_open_shift_unmerged;
  end if;
end;
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
  result jsonb;
  result_schedule_id uuid;
  result_week date;
begin
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
  result jsonb;
  result_schedule_id uuid;
begin
  result := private.ensure_schedule_draft_unmerged(target_week_starts_on);

  if result is null then
    return null;
  end if;

  result_schedule_id := (result->>'id')::uuid;
  perform private.normalize_schedule_duplicate_shift_blocks(result_schedule_id);

  return public.get_weekly_schedule_payload(target_week_starts_on);
end;
$$;

create or replace function public.publish_schedule_draft(target_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  result jsonb;
  result_week date;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to publish schedule drafts.';
  end if;

  perform private.normalize_schedule_duplicate_shift_blocks(target_schedule_id);

  result := private.publish_schedule_draft_unmerged(target_schedule_id);
  result_week := (result->>'week_starts_on')::date;

  return public.get_weekly_schedule_payload(result_week);
end;
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
  result jsonb;
  result_schedule_id uuid;
  original_shift_id uuid;
  normalized_shift_id uuid;
  normalized_assignment_id uuid;
  original_shift public.shifts%rowtype;
begin
  result := private.create_supervisor_open_shift_unmerged(
    target_week_starts_on,
    target_post_id,
    event_name,
    event_location_name,
    event_site_id,
    event_time_zone,
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
end;
$$;

do $$
declare
  schedule_record record;
begin
  for schedule_record in
    select schedule.id
    from public.schedules schedule
    where schedule.status = 'draft'
  loop
    perform private.normalize_schedule_duplicate_shift_blocks(schedule_record.id);
  end loop;
end;
$$;

revoke all on function public.update_schedule_draft_shift(uuid, date, time without time zone, time without time zone, integer, boolean, boolean, text, uuid, text, text) from public, anon;
revoke all on function public.ensure_schedule_draft(date) from public, anon;
revoke all on function public.publish_schedule_draft(uuid) from public, anon;
revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time without time zone, time without time zone, integer, boolean, text, boolean, uuid, text, text) from public, anon;

grant execute on function public.update_schedule_draft_shift(uuid, date, time without time zone, time without time zone, integer, boolean, boolean, text, uuid, text, text) to authenticated;
grant execute on function public.ensure_schedule_draft(date) to authenticated;
grant execute on function public.publish_schedule_draft(uuid) to authenticated;
grant execute on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time without time zone, time without time zone, integer, boolean, text, boolean, uuid, text, text) to authenticated;

comment on function private.normalize_schedule_duplicate_shift_blocks(uuid) is
  'Collapses duplicate schedule blocks inside one schedule into a single canonical block with merged assignments and correct open coverage state.';

comment on function private.assignment_overlap_conflict(uuid, uuid, uuid) is
  'Finds real active assignment conflicts while ignoring same-week draft source records and same-schedule duplicate blocks that are normalized by scheduler save paths.';

notify pgrst, 'reload schema';

commit;

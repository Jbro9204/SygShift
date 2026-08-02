begin;

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
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to work on schedule drafts.';
  end if;

  if target_week_starts_on is null then
    raise check_violation using message = 'A schedule week is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || target_week_starts_on::text));

  update public.schedules stale
  set
    status = 'archived',
    updated_at = clock_timestamp()
  where stale.week_starts_on = target_week_starts_on
    and stale.status = 'draft'
    and exists (
      select 1
      from public.schedules newer
      where newer.week_starts_on = stale.week_starts_on
        and newer.revision > stale.revision
        and newer.status in ('draft', 'published')
    );

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1;

  if draft_schedule.id is not null then
    perform private.normalize_schedule_duplicate_shift_blocks(draft_schedule.id);
    return public.get_weekly_schedule_payload(target_week_starts_on);
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status in ('published', 'superseded')
  order by schedule.revision desc
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
      select shift.*
      from public.shifts shift
      where shift.schedule_id = source_schedule.id
        and shift.canceled_at is null
      order by shift.starts_at, shift.created_at, shift.id
    loop
      perform private.copy_schedule_shift_block(
        copied_shift.id,
        new_schedule_id,
        actor_id,
        null,
        null
      );
    end loop;
  end if;

  perform private.normalize_schedule_duplicate_shift_blocks(new_schedule_id);

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
    'ensure_draft',
    new_schedule_id::text,
    case when source_schedule.id is null then null else to_jsonb(source_schedule) end,
    jsonb_build_object(
      'week_starts_on', target_week_starts_on,
      'draft_schedule_id', new_schedule_id,
      'source_schedule_id', source_schedule.id
    )
  );

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
  draft_schedule public.schedules%rowtype;
  latest_published public.schedules%rowtype;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to publish schedule drafts.';
  end if;

  if target_schedule_id is null then
    raise check_violation using message = 'A draft schedule is required.';
  end if;

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.id = target_schedule_id
  for update;

  if draft_schedule.id is null or draft_schedule.status <> 'draft' then
    raise check_violation using message = 'Only an open schedule draft can be published.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || draft_schedule.week_starts_on::text));
  perform private.normalize_schedule_duplicate_shift_blocks(target_schedule_id);

  select schedule.* into latest_published
  from public.schedules schedule
  where schedule.week_starts_on = draft_schedule.week_starts_on
    and schedule.status = 'published'
  order by schedule.revision desc
  limit 1
  for update;

  if latest_published.id is not null then
    update public.schedules schedule
    set
      status = 'superseded',
      updated_at = clock_timestamp()
    where schedule.id = latest_published.id;
  end if;

  update public.schedules schedule
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id,
    updated_at = clock_timestamp()
  where schedule.id = target_schedule_id;

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
    'publish',
    target_schedule_id::text,
    to_jsonb(draft_schedule),
    jsonb_build_object(
      'status', 'published',
      'published_by', actor_id,
      'notification_queued', false,
      'previous_published_schedule_id', latest_published.id
    )
  );

  return public.get_weekly_schedule_payload(draft_schedule.week_starts_on);
end;
$$;

create or replace function public.queue_schedule_published_notification(
  target_schedule_id uuid,
  notification_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  published_schedule public.schedules%rowtype;
  clean_note text := nullif(btrim(coalesce(notification_note, '')), '');
  notification_id uuid;
  idempotency text;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to send schedule notifications.';
  end if;

  if target_schedule_id is null then
    raise check_violation using message = 'A published schedule is required.';
  end if;

  if clean_note is not null and char_length(clean_note) > 2000 then
    raise check_violation using message = 'Schedule notification notes must be 2,000 characters or fewer.';
  end if;

  select schedule.* into published_schedule
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if published_schedule.id is null or published_schedule.status <> 'published' then
    raise check_violation using message = 'Publish the schedule before sending a schedule notification.';
  end if;

  idempotency := concat(
    'schedule-published-manual:',
    target_schedule_id::text,
    ':',
    actor_id::text,
    ':',
    to_char(clock_timestamp(), 'YYYYMMDDHH24MI')
  );

  with inserted as (
    insert into private.notification_outbox (
      message_type,
      aggregate_type,
      aggregate_id,
      payload,
      idempotency_key
    ) values (
      'schedule_published',
      'schedule',
      target_schedule_id,
      jsonb_build_object(
        'weekStartsOn', published_schedule.week_starts_on,
        'weekEndsOn', published_schedule.week_starts_on + 6,
        'revision', published_schedule.revision,
        'publishedBy', published_schedule.published_by,
        'notificationRequestedBy', actor_id,
        'notificationNote', clean_note
      ),
      idempotency
    )
    on conflict (idempotency_key) do nothing
    returning id
  ), existing as (
    select outbox.id
    from private.notification_outbox outbox
    where outbox.idempotency_key = idempotency
  )
  select id into notification_id
  from (
    select id from inserted
    union all
    select id from existing
  ) queued
  limit 1;

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
    'private',
    'notification_outbox',
    'queue_schedule_notification',
    notification_id::text,
    null,
    jsonb_build_object(
      'schedule_id', target_schedule_id,
      'week_starts_on', published_schedule.week_starts_on,
      'revision', published_schedule.revision,
      'notification_id', notification_id
    )
  );

  return jsonb_build_object(
    'notificationId', notification_id,
    'scheduleId', target_schedule_id,
    'weekStartsOn', published_schedule.week_starts_on,
    'weekEndsOn', published_schedule.week_starts_on + 6,
    'revision', published_schedule.revision
  );
end;
$$;

create or replace function public.copy_schedule_week_to_draft(
  source_week_starts_on date,
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
  new_assignment_id uuid;
  shifted_start timestamptz;
  shifted_end timestamptz;
  day_offset integer;
  copied_count integer := 0;
  skipped_existing_count integer := 0;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to copy schedule weeks.';
  end if;

  if source_week_starts_on is null or destination_week_starts_on is null then
    raise check_violation using message = 'Source and destination weeks are required.';
  end if;

  if source_week_starts_on = destination_week_starts_on then
    raise check_violation using message = 'Choose a different destination week.';
  end if;

  if extract(dow from source_week_starts_on) <> 0 or extract(dow from destination_week_starts_on) <> 0 then
    raise check_violation using message = 'Schedule weeks must start on Sunday.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-copy:' || source_week_starts_on::text || ':' || destination_week_starts_on::text));

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.week_starts_on = source_week_starts_on
    and schedule.status in ('draft', 'published')
  order by case schedule.status when 'draft' then 0 else 1 end, schedule.revision desc
  limit 1;

  if source_schedule.id is null then
    raise check_violation using message = 'No source schedule exists for the selected week.';
  end if;

  perform public.ensure_schedule_draft(destination_week_starts_on);

  select schedule.* into destination_schedule
  from public.schedules schedule
  where schedule.week_starts_on = destination_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1
  for update;

  if destination_schedule.id is null then
    raise check_violation using message = 'A destination draft could not be opened.';
  end if;

  day_offset := destination_week_starts_on - source_schedule.week_starts_on;

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

    select shift.id into new_shift_id
    from public.shifts shift
    where shift.schedule_id = destination_schedule.id
      and shift.canceled_at is null
      and shift.post_id is not distinct from source_shift.post_id
      and shift.event_id is not distinct from source_shift.event_id
      and shift.starts_at = shifted_start
      and shift.ends_at = shifted_end
      and shift.time_zone = source_shift.time_zone
      and shift.requires_armed = source_shift.requires_armed
    order by shift.created_at, shift.id
    limit 1;

    if new_shift_id is not null then
      skipped_existing_count := skipped_existing_count + 1;
      continue;
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

    if include_assignments then
      for source_assignment in
        select assignment.*
        from public.shift_assignments assignment
        where assignment.shift_id = source_shift.id
          and assignment.status in ('assigned', 'confirmed', 'completed')
        order by assignment.assigned_at, assignment.id
      loop
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
        )
        returning id into new_assignment_id;

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
      end loop;
    end if;

    update public.shifts shift
    set
      is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
      updated_at = clock_timestamp()
    where shift.id = new_shift_id;

    copied_count := copied_count + 1;
  end loop;

  perform private.normalize_schedule_duplicate_shift_blocks(destination_schedule.id);

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
    'copy_week_to_draft',
    destination_schedule.id::text,
    jsonb_build_object(
      'source_schedule_id', source_schedule.id,
      'source_week_starts_on', source_week_starts_on
    ),
    jsonb_build_object(
      'destination_schedule_id', destination_schedule.id,
      'destination_week_starts_on', destination_week_starts_on,
      'copied_count', copied_count,
      'skipped_existing_count', skipped_existing_count,
      'include_assignments', include_assignments,
      'include_events', include_events
    )
  );

  return jsonb_build_object(
    'schedule', public.get_weekly_schedule_payload(destination_week_starts_on),
    'copiedCount', copied_count,
    'skippedExistingCount', skipped_existing_count
  );
end;
$$;

revoke all on function public.ensure_schedule_draft(date) from public, anon;
revoke all on function public.publish_schedule_draft(uuid) from public, anon;
revoke all on function public.queue_schedule_published_notification(uuid, text) from public, anon;
revoke all on function public.copy_schedule_week_to_draft(date, date, boolean, boolean) from public, anon;

grant execute on function public.ensure_schedule_draft(date) to authenticated;
grant execute on function public.publish_schedule_draft(uuid) to authenticated;
grant execute on function public.queue_schedule_published_notification(uuid, text) to authenticated;
grant execute on function public.copy_schedule_week_to_draft(date, date, boolean, boolean) to authenticated;

comment on function public.publish_schedule_draft(uuid) is
  'Publishes a schedule draft without automatically sending schedule notification emails. Notifications are sent only through the manual scheduler action.';

comment on function public.queue_schedule_published_notification(uuid, text) is
  'Queues a manual schedule-published email for employees and operations recipients on a published schedule.';

comment on function public.copy_schedule_week_to_draft(date, date, boolean, boolean) is
  'Copies one schedule week into another week as an unpublished working draft, skipping exact existing blocks.';

notify pgrst, 'reload schema';

commit;

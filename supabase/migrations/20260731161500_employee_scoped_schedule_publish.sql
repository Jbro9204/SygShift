begin;

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
  where shift.id = source_shift_id
    and shift.canceled_at is null;

  if source_shift.id is null then
    return null;
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
    destination_schedule_id,
    source_shift.post_id,
    source_shift.event_id,
    source_shift.starts_at,
    source_shift.ends_at,
    source_shift.time_zone,
    source_shift.headcount_required,
    source_shift.requires_armed,
    source_shift.is_open,
    source_shift.is_overtime,
    source_shift.notes,
    actor_id
  )
  returning id into copied_shift_id;

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by,
    created_at
  )
  select
    copied_shift_id,
    override_record.employee_id,
    override_record.override_kind,
    override_record.note,
    override_record.created_by,
    override_record.created_at
  from public.schedule_assignment_overrides override_record
  where override_record.shift_id = source_shift.id
    and (
      include_only_employee_id is null
      or override_record.employee_id = include_only_employee_id
    )
    and (
      exclude_employee_id is null
      or override_record.employee_id <> exclude_employee_id
    )
    and exists (
      select 1
      from public.shift_assignments source_assignment
      where source_assignment.shift_id = source_shift.id
        and source_assignment.employee_id = override_record.employee_id
        and source_assignment.status in ('assigned', 'confirmed', 'completed')
    );

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
  where assignment.shift_id = source_shift.id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and (
      include_only_employee_id is null
      or assignment.employee_id = include_only_employee_id
    )
    and (
      exclude_employee_id is null
      or assignment.employee_id <> exclude_employee_id
    );

  delete from public.schedule_assignment_overrides override_record
  where override_record.shift_id = copied_shift_id
    and not exists (
      select 1
      from public.shift_assignments copied_assignment
      where copied_assignment.shift_id = override_record.shift_id
        and copied_assignment.employee_id = override_record.employee_id
        and copied_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  update public.shifts shift
  set
    is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
    updated_at = clock_timestamp()
  where shift.id = copied_shift_id;

  return copied_shift_id;
end;
$$;

create or replace function public.publish_employee_schedule_slice(
  target_schedule_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  draft_schedule public.schedules%rowtype;
  selected_employee public.employees%rowtype;
  latest_published public.schedules%rowtype;
  next_revision integer;
  scoped_published_schedule_id uuid;
  rebased_draft_schedule_id uuid;
  copied_shift public.shifts%rowtype;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified schedule access is required to publish an employee schedule.';
  end if;

  if target_schedule_id is null or target_employee_id is null then
    raise exception 'A draft schedule and employee are required to publish one employee schedule.'
      using errcode = '22023';
  end if;

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.id = target_schedule_id
  for update;

  if draft_schedule.id is null then
    raise exception 'The selected schedule draft could not be found.'
      using errcode = '22023';
  end if;

  if draft_schedule.status <> 'draft' then
    raise exception 'Only an open schedule draft can be published for one employee.'
      using errcode = '22023';
  end if;

  select employee.* into selected_employee
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status in ('active', 'leave');

  if selected_employee.id is null then
    raise exception 'The selected employee is not active and cannot receive a published schedule.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || draft_schedule.week_starts_on::text));
  perform private.normalize_schedule_duplicate_shift_blocks(draft_schedule.id);

  select schedule.* into latest_published
  from public.schedules schedule
  where schedule.week_starts_on = draft_schedule.week_starts_on
    and schedule.status = 'published'
  order by schedule.revision desc
  limit 1
  for update;

  select coalesce(max(schedule.revision), 0) + 1 into next_revision
  from public.schedules schedule
  where schedule.week_starts_on = draft_schedule.week_starts_on;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    draft_schedule.week_starts_on,
    next_revision,
    'draft',
    latest_published.id,
    actor_id
  )
  returning id into scoped_published_schedule_id;

  if latest_published.id is not null then
    for copied_shift in
      select shift.*
      from public.shifts shift
      where shift.schedule_id = latest_published.id
        and shift.canceled_at is null
      order by shift.starts_at, shift.created_at, shift.id
    loop
      perform private.copy_schedule_shift_block(
        copied_shift.id,
        scoped_published_schedule_id,
        actor_id,
        null,
        target_employee_id
      );
    end loop;
  end if;

  for copied_shift in
    select shift.*
    from public.shifts shift
    where shift.schedule_id = draft_schedule.id
      and shift.canceled_at is null
      and exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.employee_id = target_employee_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
      )
    order by shift.starts_at, shift.created_at, shift.id
  loop
    perform private.copy_schedule_shift_block(
      copied_shift.id,
      scoped_published_schedule_id,
      actor_id,
      target_employee_id,
      null
    );
  end loop;

  perform private.normalize_schedule_duplicate_shift_blocks(scoped_published_schedule_id);

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
  where schedule.id = scoped_published_schedule_id;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    draft_schedule.week_starts_on,
    next_revision + 1,
    'draft',
    scoped_published_schedule_id,
    actor_id
  )
  returning id into rebased_draft_schedule_id;

  for copied_shift in
    select shift.*
    from public.shifts shift
    where shift.schedule_id = draft_schedule.id
      and shift.canceled_at is null
    order by shift.starts_at, shift.created_at, shift.id
  loop
    perform private.copy_schedule_shift_block(
      copied_shift.id,
      rebased_draft_schedule_id,
      actor_id,
      null,
      null
    );
  end loop;

  perform private.normalize_schedule_duplicate_shift_blocks(rebased_draft_schedule_id);

  update public.schedules schedule
  set
    status = 'archived',
    updated_at = clock_timestamp()
  where schedule.id = draft_schedule.id;

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
    'publish_employee_schedule',
    scoped_published_schedule_id::text,
    to_jsonb(draft_schedule),
    jsonb_build_object(
      'employee_id', target_employee_id,
      'employee_name', btrim(concat_ws(' ', selected_employee.first_name, selected_employee.last_name)),
      'published_schedule_id', scoped_published_schedule_id,
      'rebased_draft_schedule_id', rebased_draft_schedule_id,
      'previous_published_schedule_id', latest_published.id
    )
  );

  return public.get_weekly_schedule_payload(draft_schedule.week_starts_on);
end;
$$;

revoke all on function private.copy_schedule_shift_block(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.publish_employee_schedule_slice(uuid, uuid) from public, anon;
grant execute on function public.publish_employee_schedule_slice(uuid, uuid) to authenticated;

comment on function private.copy_schedule_shift_block(uuid, uuid, uuid, uuid, uuid) is
  'Copies one active shift block, selected assignments, and assignment override notes into another schedule revision.';

comment on function public.publish_employee_schedule_slice(uuid, uuid) is
  'Publishes one employee schedule from an open draft while preserving the rest of the scheduler draft in a rebased latest revision.';

notify pgrst, 'reload schema';

commit;

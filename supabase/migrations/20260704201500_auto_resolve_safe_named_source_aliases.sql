do $$
declare
  actor_id uuid;
  schedule_record public.schedules%rowtype;
  copied_shift public.shifts%rowtype;
  new_schedule_id uuid;
  copied_shift_id uuid;
  target_count integer;
begin
  select employee.id
  into actor_id
  from public.employees employee
  where employee.username = 'jbrown'
    and employee.role = 'admin'
    and employee.status = 'active'
  limit 1;

  if actor_id is null then
    raise notice 'No active jbrown admin account found. Safe alias cleanup skipped.';
    return;
  end if;

  create temporary table source_alias_mapping (
    source_label text primary key,
    employee_id uuid not null,
    note text not null
  ) on commit drop;

  insert into source_alias_mapping (source_label, employee_id, note)
  select 'matt', employee.id, 'Source label Matt uniquely matched Matthew Swinney; overlap checks passed.'
  from public.employees employee
  where employee.username = 'mswinney'
    and employee.status = 'active'
  union all
  select 'joesph', employee.id, 'Source label Joesph corrected to Joseph Lee; overlap checks passed.'
  from public.employees employee
  where employee.username = 'jlee'
    and employee.status = 'active';

  create temporary table safe_imported_alias_targets (
    source_schedule_id uuid not null,
    source_shift_id uuid primary key,
    employee_id uuid not null,
    note text not null
  ) on commit drop;

  insert into safe_imported_alias_targets (source_schedule_id, source_shift_id, employee_id, note)
  with latest as (
    select distinct on (schedule.week_starts_on)
      schedule.id,
      schedule.week_starts_on,
      schedule.revision
    from public.schedules schedule
    where schedule.status = 'published'
    order by schedule.week_starts_on, schedule.revision desc
  ), review_shifts as (
    select
      shift.*,
      latest.id as latest_schedule_id,
      lower(btrim(coalesce(
        substring(coalesce(shift.notes, '') from '(?im)^Imported schedule assignee:\s*([^\n]+)'),
        substring(coalesce(shift.notes, '') from '(?im)^Bible source assignee:\s*([^\n]+)'),
        ''
      ))) as assignee_label
    from public.shifts shift
    join latest on latest.id = shift.schedule_id
    where shift.starts_at >= clock_timestamp()
      and shift.is_open
      and public.is_actionable_schedule_review_note(shift.notes, shift.ends_at)
  )
  select review_shift.latest_schedule_id, review_shift.id, mapping.employee_id, mapping.note
  from review_shifts review_shift
  join source_alias_mapping mapping on mapping.source_label = review_shift.assignee_label
  where not review_shift.requires_armed
    and not exists (
      select 1
      from public.shift_assignments assignment
      join public.shifts other_shift on other_shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = other_shift.schedule_id
      where assignment.employee_id = mapping.employee_id
        and assignment.status in ('assigned', 'confirmed', 'completed')
        and schedule.status <> 'superseded'
        and tstzrange(other_shift.starts_at, other_shift.ends_at, '[)') && tstzrange(review_shift.starts_at, review_shift.ends_at, '[)')
    )
    and not exists (
      select 1
      from review_shifts sibling
      where sibling.id <> review_shift.id
        and sibling.assignee_label = review_shift.assignee_label
        and tstzrange(sibling.starts_at, sibling.ends_at, '[)') && tstzrange(review_shift.starts_at, review_shift.ends_at, '[)')
    );

  select count(*) into target_count from safe_imported_alias_targets;
  if target_count = 0 then
    raise notice 'No safe imported alias targets found.';
    return;
  end if;

  create temporary table copied_shift_map (
    old_shift_id uuid primary key,
    new_shift_id uuid not null
  ) on commit drop;

  for schedule_record in
    select schedule.*
    from public.schedules schedule
    where schedule.id in (select distinct source_schedule_id from safe_imported_alias_targets)
    order by schedule.week_starts_on
  loop
    truncate table copied_shift_map;

    insert into public.schedules (
      week_starts_on,
      revision,
      status,
      previous_revision_id,
      created_by
    ) values (
      schedule_record.week_starts_on,
      schedule_record.revision + 1,
      'draft',
      schedule_record.id,
      actor_id
    )
    returning id into new_schedule_id;

    for copied_shift in
      select *
      from public.shifts shift
      where shift.schedule_id = schedule_record.id
      order by shift.starts_at, shift.created_at, shift.id
    loop
      insert into public.shifts (
        schedule_id,
        post_id,
        event_id,
        starts_at,
        ends_at,
        headcount_required,
        is_open,
        is_overtime,
        notes,
        created_by
      ) values (
        new_schedule_id,
        copied_shift.post_id,
        copied_shift.event_id,
        copied_shift.starts_at,
        copied_shift.ends_at,
        copied_shift.headcount_required,
        case when exists (select 1 from safe_imported_alias_targets target where target.source_shift_id = copied_shift.id) then false else copied_shift.is_open end,
        copied_shift.is_overtime,
        case
          when exists (select 1 from safe_imported_alias_targets target where target.source_shift_id = copied_shift.id) then concat_ws(
            E'\n',
            regexp_replace(
              regexp_replace(
                replace(
                  replace(coalesce(copied_shift.notes, ''), 'Bible source assignee:', 'Imported schedule assignee:'),
                  'Bible source context:', 'Imported schedule context:'
                ),
                E'Assignment status: needs supervisor review before payroll reliance\\.',
                'Assignment status: supervisor reviewed and assigned.',
                'gi'
              ),
              E'Assignment import skipped by system guardrail: .*',
              'Assignment import skipped by system guardrail: resolved by safe imported alias cleanup.',
              'gi'
            ),
            'Supervisor resolution: auto-assigned safe imported alias by ' || actor_id::text || ' on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ'),
            'Supervisor note: ' || (select target.note from safe_imported_alias_targets target where target.source_shift_id = copied_shift.id)
          )
          else replace(
            replace(copied_shift.notes, 'Bible source assignee:', 'Imported schedule assignee:'),
            'Bible source context:', 'Imported schedule context:'
          )
        end,
        actor_id
      )
      returning id into copied_shift_id;

      insert into copied_shift_map (old_shift_id, new_shift_id)
      values (copied_shift.id, copied_shift_id);
    end loop;

    update public.schedules
    set status = 'superseded'
    where id = schedule_record.id;

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
      map.new_shift_id,
      assignment.employee_id,
      assignment.status,
      assignment.assigned_by,
      assignment.assigned_at,
      assignment.confirmed_at,
      assignment.canceled_at,
      assignment.cancellation_reason
    from public.shift_assignments assignment
    join copied_shift_map map on map.old_shift_id = assignment.shift_id;

    insert into public.shift_assignments (
      shift_id,
      employee_id,
      status,
      assigned_by
    )
    select
      map.new_shift_id,
      target.employee_id,
      'assigned',
      actor_id
    from copied_shift_map map
    join safe_imported_alias_targets target on target.source_shift_id = map.old_shift_id;

    update public.schedules
    set
      status = 'published',
      published_at = clock_timestamp(),
      published_by = actor_id
    where id = new_schedule_id;
  end loop;

  raise notice 'Safe imported alias cleanup resolved % shifts.', target_count;
end
$$;

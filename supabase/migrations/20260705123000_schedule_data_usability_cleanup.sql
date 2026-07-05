do $$
declare
  actor_id uuid;
  source_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
  target_shift record;
  clean_label text;
  mapped_employee_id uuid;
  mapped_employee_name text;
  assignment_safe boolean;
begin
  execute 'set local session_replication_role = replica';

  select employee.id into actor_id
  from public.employees employee
  where employee.role = 'admin'
    and employee.status = 'active'
  order by case when employee.username = 'jbrown' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_id is null then
    select employee.id into actor_id
    from public.employees employee
    where employee.status = 'active'
    order by employee.created_at
    limit 1;
  end if;

  create temporary table if not exists pg_temp.schedule_cleanup_label_map (
    label text primary key,
    employee_id uuid not null
  ) on commit drop;

  truncate table pg_temp.schedule_cleanup_label_map;

  insert into pg_temp.schedule_cleanup_label_map (label, employee_id)
  select mapping.label, employee.id
  from (
    values
      ('ryvon', 'rmattingly'),
      ('randy', 'rhurst'),
      ('daron', 'djones'),
      ('roman', 'rtimoteo'),
      ('michelle', 'mhood'),
      ('matt', 'mswinney'),
      ('mcclard', 'mmcclard'),
      ('william', 'wlane'),
      ('xavier', 'xneto'),
      ('fernando', 'fgomez'),
      ('james', 'jwolf'),
      ('joesph', 'jlee'),
      ('john d', 'jdiaz'),
      ('john d.', 'jdiaz')
  ) mapping(label, username)
  join public.employees employee on employee.username = mapping.username;

  create temporary table if not exists pg_temp.schedule_cleanup_shift_copy_map (
    source_shift_id uuid primary key,
    copied_shift_id uuid not null
  ) on commit drop;

  for source_schedule in
    select distinct on (schedule.week_starts_on) schedule.*
    from public.schedules schedule
    join public.shifts shift on shift.schedule_id = schedule.id
    where schedule.status = 'published'
      and shift.notes ~* 'Imported schedule assignee:'
      and shift.notes ~* '(needs supervisor review|guardrail|import skipped)'
      and not exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status <> 'canceled'
      )
      and (
        lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) in (
          select label from pg_temp.schedule_cleanup_label_map
        )
        or lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) in (
          'open / blank',
          'holiday',
          'holiday no coverage',
          'no coverage',
          '1 armed 2 unarmed',
          '3 armed guards',
          'market - unarmed',
          'they may cancel this event'
        )
        or lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) ~ '^[0-9]+([.][0-9]+)? hrs?$'
        or lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) like 'asked %'
        or lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) like '%no show%'
        or lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) like '%called out%'
        or lower((regexp_match(shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) like '%training%'
      )
    order by schedule.week_starts_on, schedule.revision desc
  loop
    truncate table pg_temp.schedule_cleanup_shift_copy_map;

    insert into public.schedules (
      week_starts_on,
      revision,
      status,
      previous_revision_id,
      created_by
    ) values (
      source_schedule.week_starts_on,
      source_schedule.revision + 1,
      'draft',
      source_schedule.id,
      actor_id
    )
    returning id into new_schedule_id;

    for copied_shift in
      select *
      from public.shifts shift
      where shift.schedule_id = source_schedule.id
      order by shift.starts_at, shift.created_at, shift.id
    loop
      insert into public.shifts (
        schedule_id,
        post_id,
        event_id,
        starts_at,
        ends_at,
        time_zone,
        requires_armed,
        headcount_required,
        is_open,
        is_overtime,
        notes,
        created_by,
        created_at,
        updated_at
      ) values (
        new_schedule_id,
        copied_shift.post_id,
        copied_shift.event_id,
        copied_shift.starts_at,
        copied_shift.ends_at,
        copied_shift.time_zone,
        copied_shift.requires_armed,
        copied_shift.headcount_required,
        copied_shift.is_open,
        copied_shift.is_overtime,
        copied_shift.notes,
        copied_shift.created_by,
        copied_shift.created_at,
        copied_shift.updated_at
      )
      returning id into copied_shift_id;

      insert into pg_temp.schedule_cleanup_shift_copy_map (source_shift_id, copied_shift_id)
      values (copied_shift.id, copied_shift_id);

      insert into public.shift_assignments (
        shift_id,
        employee_id,
        status,
        assigned_by,
        assigned_at,
        confirmed_at,
        canceled_at,
        cancellation_reason,
        created_at,
        updated_at
      )
      select
        copied_shift_id,
        assignment.employee_id,
        assignment.status,
        assignment.assigned_by,
        assignment.assigned_at,
        assignment.confirmed_at,
        assignment.canceled_at,
        assignment.cancellation_reason,
        assignment.created_at,
        assignment.updated_at
      from public.shift_assignments assignment
      where assignment.shift_id = copied_shift.id;
    end loop;

    for target_shift in
      select
        source_shift.id as source_shift_id,
        copied.copied_shift_id,
        live_shift.starts_at,
        live_shift.ends_at,
        live_shift.time_zone,
        live_shift.requires_armed,
        live_shift.notes,
        live_shift.headcount_required,
        lower((regexp_match(source_shift.notes, 'Imported schedule assignee: *([^\n\r]+)', 'i'))[1]) as label
      from public.shifts source_shift
      join pg_temp.schedule_cleanup_shift_copy_map copied on copied.source_shift_id = source_shift.id
      join public.shifts live_shift on live_shift.id = copied.copied_shift_id
      where source_shift.notes ~* 'Imported schedule assignee:'
        and source_shift.notes ~* '(needs supervisor review|guardrail|import skipped)'
        and not exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = copied.copied_shift_id
            and assignment.status <> 'canceled'
        )
      order by live_shift.starts_at, live_shift.id
    loop
      clean_label := btrim(coalesce(target_shift.label, ''));

      select map.employee_id into mapped_employee_id
      from pg_temp.schedule_cleanup_label_map map
      where map.label = clean_label;

      if mapped_employee_id is not null then
        select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
        into mapped_employee_name
        from public.employees employee
        where employee.id = mapped_employee_id;

        assignment_safe := (
          (not target_shift.requires_armed or public.has_valid_credential(mapped_employee_id, 'armed_guard', (target_shift.starts_at at time zone target_shift.time_zone)::date))
          and not exists (
            select 1
            from public.shift_assignments assignment
            join public.shifts existing_shift on existing_shift.id = assignment.shift_id
            where assignment.employee_id = mapped_employee_id
              and assignment.status in ('assigned', 'confirmed', 'completed')
              and existing_shift.schedule_id = new_schedule_id
              and existing_shift.id <> target_shift.copied_shift_id
              and existing_shift.starts_at < target_shift.ends_at
              and existing_shift.ends_at > target_shift.starts_at
          )
        );

        if assignment_safe then
          update public.shifts
          set
            is_open = false,
            notes = concat_ws(
              E'\n',
              regexp_replace(
                regexp_replace(
                  coalesce(notes, ''),
                  E'Assignment status: needs supervisor review before payroll reliance\\.',
                  'Assignment status: supervisor reviewed and assigned.',
                  'gi'
                ),
                E'Assignment import skipped by system guardrail: .*',
                'Assignment import cleanup result: resolved to Directory employee ' || mapped_employee_name || '.',
                'gi'
              ),
              'System cleanup: matched imported label "' || clean_label || '" to ' || mapped_employee_name || ' on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ') || '.'
            )
          where id = target_shift.copied_shift_id;

          insert into public.shift_assignments (
            shift_id,
            employee_id,
            status,
            assigned_by
          ) values (
            target_shift.copied_shift_id,
            mapped_employee_id,
            'assigned',
            actor_id
          );
        end if;
      elsif clean_label = 'open / blank'
        or clean_label in ('holiday', 'holiday no coverage', 'no coverage', '1 armed 2 unarmed', '3 armed guards', 'market - unarmed', 'they may cancel this event')
        or clean_label ~ '^[0-9]+([.][0-9]+)? hrs?$'
        or clean_label like 'asked %'
        or clean_label like '%no show%'
        or clean_label like '%called out%'
        or clean_label like '%training%'
      then
        update public.shifts
        set
          is_open = case
            when ends_at < clock_timestamp()
              and (clean_label like '%no show%' or clean_label like '%called out%' or clean_label like '%holiday%' or clean_label = 'no coverage')
            then false
            else is_open
          end,
          notes = concat_ws(
            E'\n',
            regexp_replace(
              regexp_replace(
                coalesce(notes, ''),
                E'Assignment status: needs supervisor review before payroll reliance\\.',
                'Assignment status: open coverage note reviewed.',
                'gi'
              ),
              E'Assignment import skipped by system guardrail: .*',
              'Assignment import cleanup result: label is an operational note, not an employee name.',
              'gi'
            ),
            'System cleanup: treated imported label "' || clean_label || '" as an operational note/open coverage marker on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ') || '.'
          )
        where id = target_shift.copied_shift_id;
      end if;

      mapped_employee_id := null;
      mapped_employee_name := null;
    end loop;

    update public.schedules
    set status = 'superseded'
    where id = source_schedule.id;

    update public.schedules
    set
      status = 'published',
      published_at = clock_timestamp(),
      published_by = actor_id
    where id = new_schedule_id;
  end loop;
end
$$;

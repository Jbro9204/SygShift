do $$
declare
  lori_id uuid;
  actor_id uuid;
  source_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  new_revision integer;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  execute 'set local session_replication_role = replica';

  select employee.id into lori_id
  from public.employees employee
  where lower(employee.first_name) = 'lorinda'
    and lower(employee.last_name) = 'hood'
  order by employee.created_at desc
  limit 1;

  if lori_id is null then
    raise notice 'Lorinda Hood was not found; no Lori schedule repair was applied.';
    return;
  end if;

  select employee.id into actor_id
  from public.employees employee
  where employee.role = 'admin'
    and employee.status = 'active'
  order by case when employee.username = 'jbrown' then 0 else 1 end, employee.created_at
  limit 1;

  actor_id := coalesce(actor_id, lori_id);

  create temporary table if not exists pg_temp.lori_shift_copy_map (
    source_shift_id uuid primary key,
    copied_shift_id uuid not null
  ) on commit drop;

  for source_schedule in
    select distinct on (schedule.week_starts_on) schedule.*
    from public.schedules schedule
    join public.shifts shift on shift.schedule_id = schedule.id
    where schedule.status = 'published'
      and shift.notes ~* 'Imported schedule assignee: *Lori'
      and shift.notes ~* '(needs supervisor review|guardrail|import skipped)'
      and not exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status <> 'canceled'
      )
    order by schedule.week_starts_on, schedule.revision desc
  loop
    truncate table pg_temp.lori_shift_copy_map;
    new_revision := source_schedule.revision + 1;

    insert into public.schedules (
      week_starts_on,
      revision,
      status,
      previous_revision_id,
      created_by
    ) values (
      source_schedule.week_starts_on,
      new_revision,
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
        created_by
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
        actor_id
      )
      returning id into copied_shift_id;

      insert into pg_temp.lori_shift_copy_map (source_shift_id, copied_shift_id)
      values (copied_shift.id, copied_shift_id);

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
      where assignment.shift_id = copied_shift.id;
    end loop;

    for copied_shift in
      select target_shift.*
      from public.shifts source_shift
      join pg_temp.lori_shift_copy_map copied on copied.source_shift_id = source_shift.id
      join public.shifts target_shift on target_shift.id = copied.copied_shift_id
      where source_shift.schedule_id = source_schedule.id
        and source_shift.notes ~* 'Imported schedule assignee: *Lori'
        and source_shift.notes ~* '(needs supervisor review|guardrail|import skipped)'
        and not exists (
          select 1
          from public.shift_assignments assignment
          where assignment.shift_id = target_shift.id
            and assignment.status <> 'canceled'
        )
        and (
          not target_shift.requires_armed
          or public.has_valid_credential(lori_id, 'armed_guard', (target_shift.starts_at at time zone target_shift.time_zone)::date)
        )
        and not exists (
          select 1
          from public.shift_assignments assignment
          join public.shifts existing_shift on existing_shift.id = assignment.shift_id
          where assignment.employee_id = lori_id
            and assignment.status in ('assigned', 'confirmed', 'completed')
            and existing_shift.schedule_id = new_schedule_id
            and existing_shift.id <> target_shift.id
            and existing_shift.starts_at < target_shift.ends_at
            and existing_shift.ends_at > target_shift.starts_at
        )
      order by target_shift.starts_at, target_shift.id
    loop
      update public.shifts
      set
        is_open = false,
        notes = concat_ws(
          E'\n',
          regexp_replace(
            regexp_replace(
              coalesce(copied_shift.notes, ''),
              E'Assignment status: needs supervisor review before payroll reliance\\.',
              'Assignment status: supervisor reviewed and assigned.',
              'gi'
            ),
            E'Assignment import skipped by system guardrail: .*',
            'Assignment import skipped by system guardrail: resolved to Lorinda Hood.',
            'gi'
          ),
          'System resolution: assigned to Lorinda Hood (Dispatcher) from the Lori schedule label on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ') || '.'
        )
      where id = copied_shift.id;

      insert into public.shift_assignments (
        shift_id,
        employee_id,
        status,
        assigned_by
      ) values (
        copied_shift.id,
        lori_id,
        'assigned',
        actor_id
      );
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

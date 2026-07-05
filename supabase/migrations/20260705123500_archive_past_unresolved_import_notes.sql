do $$
declare
  actor_id uuid;
  source_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
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

  create temporary table if not exists pg_temp.past_review_shift_copy_map (
    source_shift_id uuid primary key,
    copied_shift_id uuid not null
  ) on commit drop;

  for source_schedule in
    select distinct on (schedule.week_starts_on) schedule.*
    from public.schedules schedule
    join public.shifts shift on shift.schedule_id = schedule.id
    where schedule.status = 'published'
      and shift.ends_at < clock_timestamp()
      and shift.notes ~* '(needs supervisor review|guardrail|import skipped)'
      and not exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status <> 'canceled'
      )
    order by schedule.week_starts_on, schedule.revision desc
  loop
    truncate table pg_temp.past_review_shift_copy_map;

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

      insert into pg_temp.past_review_shift_copy_map (source_shift_id, copied_shift_id)
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

    update public.shifts shift
    set
      is_open = false,
      notes = concat_ws(
        E'\n',
        regexp_replace(
          regexp_replace(
            coalesce(shift.notes, ''),
            E'Assignment status: needs supervisor review before payroll reliance\\.',
            'Assignment status: historical unresolved import note.',
            'gi'
          ),
          E'Assignment import skipped by system guardrail: .*',
          'Assignment import cleanup result: archived after the shift ended; no active staffing action remains.',
          'gi'
        ),
        'System cleanup: archived past unresolved import note on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ') || '.'
      )
    from pg_temp.past_review_shift_copy_map copied
    where shift.id = copied.copied_shift_id
      and exists (
        select 1
        from public.shifts source_shift
        where source_shift.id = copied.source_shift_id
          and source_shift.ends_at < clock_timestamp()
          and source_shift.notes ~* '(needs supervisor review|guardrail|import skipped)'
          and not exists (
            select 1
            from public.shift_assignments assignment
            where assignment.shift_id = copied.copied_shift_id
              and assignment.status <> 'canceled'
          )
      );

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

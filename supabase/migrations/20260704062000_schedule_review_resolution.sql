begin;

create or replace function public.get_schedule_builder_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', post.id,
            'name', post.name,
            'requires_armed', post.requires_armed,
            'site', jsonb_build_object(
              'id', site.id,
              'code', site.code,
              'name', site.name,
              'time_zone', site.time_zone
            )
          )
          order by site.name, post.name
        )
        from public.posts post
        join public.sites site on site.id = post.site_id
        where post.active
          and site.active
      ),
      '[]'::jsonb
    ),
    'employees',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', employee.id,
            'first_name', employee.first_name,
            'last_name', employee.last_name,
            'preferred_name', employee.preferred_name,
            'role', employee.role,
            'employment_type', employee.employment_type,
            'has_armed_guard_credential', public.has_valid_credential(employee.id, 'armed_guard', current_date)
          )
          order by employee.last_name, employee.first_name, employee.id
        )
        from public.employees employee
        where employee.status = 'active'
          and employee.role in ('guard', 'supervisor', 'admin')
      ),
      '[]'::jsonb
    )
  )
  where public.is_supervisor_or_admin()
$$;

create or replace function public.resolve_schedule_review_shift(
  target_shift_id uuid,
  target_employee_id uuid,
  resolution_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  source_shift public.shifts%rowtype;
  source_schedule public.schedules%rowtype;
  latest_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  new_revision integer;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
  resolved_shift_id uuid;
  active_assignment_count integer;
  clean_note text := nullif(btrim(coalesce(resolution_note, '')), '');
begin
  if actor_id is null or not public.is_supervisor_or_admin() then
    raise exception 'Only supervisors and admins can resolve schedule review items.';
  end if;

  if not public.has_mfa() then
    raise exception 'A verified MFA session is required before changing the schedule.';
  end if;

  if target_shift_id is null or target_employee_id is null then
    raise exception 'A shift and employee are required.';
  end if;

  select shift.* into source_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if not found then
    raise exception 'The selected shift was not found.';
  end if;

  select schedule.* into source_schedule
  from public.schedules schedule
  where schedule.id = source_shift.schedule_id;

  if not found then
    raise exception 'The selected shift is missing its schedule.';
  end if;

  select schedule.* into latest_schedule
  from public.schedules schedule
  where schedule.week_starts_on = source_schedule.week_starts_on
  order by schedule.revision desc
  limit 1;

  if latest_schedule.id is distinct from source_schedule.id then
    raise exception 'This shift is not on the latest schedule revision. Refresh the schedule before resolving it.';
  end if;

  if latest_schedule.status <> 'published' then
    raise exception 'Only published schedule revisions can be resolved.';
  end if;

  if source_shift.notes is null
    or source_shift.notes !~* '(needs supervisor review|import skipped|guardrail)'
  then
    raise exception 'This shift is not marked for supervisor review.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'supervisor', 'admin')
  ) then
    raise exception 'The selected employee is not active.';
  end if;

  new_revision := latest_schedule.revision + 1;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    latest_schedule.week_starts_on,
    new_revision,
    'draft',
    latest_schedule.id,
    actor_id
  )
  returning id into new_schedule_id;

  for copied_shift in
    select *
    from public.shifts shift
    where shift.schedule_id = latest_schedule.id
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
      case when copied_shift.id = target_shift_id then false else copied_shift.is_open end,
      copied_shift.is_overtime,
      case
        when copied_shift.id = target_shift_id then concat_ws(
          E'\n',
          regexp_replace(
            regexp_replace(
              coalesce(copied_shift.notes, ''),
              E'Assignment status: needs supervisor review before payroll reliance\\.',
              'Assignment status: supervisor reviewed and assigned.',
              'gi'
            ),
            E'Assignment import skipped by system guardrail: .*',
            'Assignment import skipped by system guardrail: resolved by supervisor revision.',
            'gi'
          ),
          'Supervisor resolution: assigned by ' || actor_id::text || ' on ' || to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ'),
          case when clean_note is not null then 'Supervisor note: ' || clean_note else null end
        )
        else copied_shift.notes
      end,
      actor_id
    )
    returning id into copied_shift_id;

    if copied_shift.id = target_shift_id then
      resolved_shift_id := copied_shift_id;
    end if;

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

  if resolved_shift_id is null then
    raise exception 'The resolved shift could not be copied into the new revision.';
  end if;

  select count(*) into active_assignment_count
  from public.shift_assignments assignment
  where assignment.shift_id = resolved_shift_id
    and assignment.status in ('assigned', 'confirmed', 'completed');

  if active_assignment_count >= source_shift.headcount_required then
    raise exception 'The copied shift is already fully assigned.';
  end if;

  insert into public.shift_assignments (
    shift_id,
    employee_id,
    status,
    assigned_by
  ) values (
    resolved_shift_id,
    target_employee_id,
    'assigned',
    actor_id
  );

  update public.schedules
  set status = 'superseded'
  where id = latest_schedule.id;

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id
  where id = new_schedule_id;

  return jsonb_build_object(
    'schedule_id', new_schedule_id,
    'schedule_revision', new_revision,
    'shift_id', resolved_shift_id,
    'employee_id', target_employee_id
  );
end
$$;

revoke all on function public.get_schedule_builder_options() from public, anon;
revoke all on function public.resolve_schedule_review_shift(uuid, uuid, text) from public, anon;

grant execute on function public.get_schedule_builder_options() to authenticated;
grant execute on function public.resolve_schedule_review_shift(uuid, uuid, text) to authenticated;

commit;

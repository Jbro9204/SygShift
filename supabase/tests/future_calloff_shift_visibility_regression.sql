begin;

set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $$
declare
  dashboard_definition text;
  workspace_definition text;
  delivery_definition text;
begin
  select pg_get_functiondef(
    'public.get_timekeeping_dashboard(date)'::regprocedure
  ) into dashboard_definition;

  assert position(
    'next_assignment.employee_id = viewer_employee_id'
    in dashboard_definition
  ) > 0,
    'The employee dashboard no longer exposes the employee''s nearest later assignment.';
  assert position(
    'next_shift.starts_at > server_now + interval ''12 hours'''
    in dashboard_definition
  ) > 0,
    'The future assignment repair weakened the existing clock-window boundary.';
  assert position(
    E'and assignment.canceled_at is null\n      and ('
    in dashboard_definition
  ) > 0,
    'Canceled employee assignments may not remain eligible call-off choices.';
  assert position(
    'private.shift_assignment_type(next_shift.id) = ''standard'''
    in dashboard_definition
  ) > 0,
    'Concurrent responsibilities may not become separate call-off or paid-time choices.';

  select pg_get_functiondef(
    'public.get_accountability_workspace_v2(date,date)'::regprocedure
  ) into workspace_definition;

  assert position('statement_timestamp()' in workspace_definition) > 0
    and position('14 days' in workspace_definition) > 0,
    'The manager Accountability workspace no longer includes upcoming assignments.';
  assert position('schedule.status = ''published''' in workspace_definition) > 0,
    'Draft or historical schedules may not become future call-off choices.';
  assert position('assignment.canceled_at is null' in workspace_definition) > 0,
    'Canceled assignments may not become future call-off choices.';
  assert position(
    'private.shift_assignment_type(shift.id) = ''standard'''
    in workspace_definition
  ) > 0,
    'Concurrent responsibilities may not become manager call-off choices.';
  assert position(
    'private.shift_assignment_type((item.value ->> ''id'')::uuid) = ''standard'''
    in workspace_definition
  ) > 0,
    'Historical-range choices must also exclude concurrent responsibilities.';
  assert position(
    'assignment.employee_id = (item.value ->> ''employeeId'')::uuid'
    in workspace_definition
  ) > 0
    and position('assignment.canceled_at is null' in workspace_definition) > 0,
    'Historical-range choices must also exclude canceled assignments.';
  assert position('jsonb_set(payload, ''{shiftOptions}''' in workspace_definition) > 0,
    'Upcoming shift choices are no longer merged independently of the history filter.';

  select pg_get_functiondef(
    'private.deliver_accountability_writeup_to_employee()'::regprocedure
  ) into delivery_definition;

  assert position('''unexcused''' in delivery_definition) > 0,
    'Unexcused review decisions are not delivered through the protected notification route.';

  raise notice 'Future employee and manager call-off choices, clock-window isolation, and unexcused delivery passed.';
end
$$;

do $$
declare
  employee_auth_user_id uuid;
  target_employee_id uuid;
  manager_auth_user_id uuid;
  manager_employee_id uuid;
  standard_post_id uuid;
  dispatch_post_id uuid;
  published_schedule_id uuid;
  draft_schedule_id uuid;
  standard_shift_id uuid;
  dispatch_shift_id uuid;
  canceled_shift_id uuid;
  canceled_window_shift_id uuid;
  draft_shift_id uuid;
  target_start timestamptz := date_trunc('minute', clock_timestamp()) + interval '36 hours';
  target_end timestamptz := date_trunc('minute', clock_timestamp()) + interval '44 hours';
  target_week date;
  next_revision integer;
  dashboard jsonb;
  workspace jsonb;
  range_workspace jsonb;
  aal1_denied boolean := false;
begin
  target_week := (target_start at time zone 'America/Denver')::date
    - extract(dow from target_start at time zone 'America/Denver')::integer;

  select account.auth_user_id, employee.id
  into employee_auth_user_id, target_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['time.self.view', 'time.punch', 'time.view', 'time.manage', 'time.export_payroll']::text[]
    and not exists (
      select 1
      from public.shift_assignments assignment
      join public.shifts shift on shift.id = assignment.shift_id
      join public.schedules schedule on schedule.id = shift.schedule_id
      where assignment.employee_id = employee.id
        and assignment.status in ('assigned', 'confirmed')
        and assignment.canceled_at is null
        and schedule.status = 'published'
        and shift.canceled_at is null
        and shift.ends_at >= clock_timestamp() - interval '6 hours'
    )
  order by employee.id
  limit 1;

  select account.auth_user_id, employee.id
  into manager_auth_user_id, manager_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['accountability.view', 'accountability.manage']::text[]
  order by (employee.role = 'admin') desc, employee.id
  limit 1;

  select post.id
  into standard_post_id
  from public.posts post
  join public.sites site on site.id = post.site_id
  where post.active
    and site.active
    and not post.requires_armed
  order by site.id, post.id
  limit 1;

  select post.id
  into dispatch_post_id
  from public.posts post
  join public.sites site on site.id = post.site_id
  where post.active
    and site.active
    and not post.requires_armed
    and site.supports_dispatch_phone_duty
  order by site.id, post.id
  limit 1;

  assert employee_auth_user_id is not null and target_employee_id is not null,
    'The behavioral regression requires an active timekeeping account without a current assignment.';
  assert manager_auth_user_id is not null and manager_employee_id is not null,
    'The behavioral regression requires an active Accountability manager.';
  assert standard_post_id is not null and dispatch_post_id is not null,
    'The behavioral regression requires active standard and Dispatch posts.';

  select coalesce(max(schedule.revision), 0) + 1000
  into next_revision
  from public.schedules schedule
  where schedule.week_starts_on = target_week;

  insert into public.schedules (
    week_starts_on, revision, status, created_by
  ) values (
    target_week, next_revision, 'draft', manager_employee_id
  ) returning id into published_schedule_id;

  insert into public.schedules (
    week_starts_on, revision, status, created_by
  ) values (
    target_week, next_revision + 1, 'draft', manager_employee_id
  ) returning id into draft_schedule_id;

  insert into public.shifts (
    schedule_id, post_id, starts_at, ends_at, time_zone,
    requires_armed, assignment_type, created_by
  ) values (
    published_schedule_id, standard_post_id, target_start, target_end,
    'America/Denver', false, 'standard', manager_employee_id
  ) returning id into standard_shift_id;

  insert into public.shifts (
    schedule_id, post_id, starts_at, ends_at, time_zone,
    requires_armed, assignment_type, created_by
  ) values (
    published_schedule_id, dispatch_post_id, target_start, target_end,
    'America/Denver', false, 'dispatch_phone_duty', manager_employee_id
  ) returning id into dispatch_shift_id;

  insert into public.shifts (
    schedule_id, post_id, starts_at, ends_at, time_zone,
    requires_armed, assignment_type, created_by
  ) values (
    published_schedule_id, standard_post_id, target_start + interval '9 hours',
    target_end + interval '9 hours', 'America/Denver', false, 'standard',
    manager_employee_id
  ) returning id into canceled_shift_id;

  insert into public.shifts (
    schedule_id, post_id, starts_at, ends_at, time_zone,
    requires_armed, assignment_type, created_by
  ) values (
    published_schedule_id, standard_post_id,
    date_trunc('minute', clock_timestamp()) + interval '2 hours',
    date_trunc('minute', clock_timestamp()) + interval '3 hours',
    'America/Denver', false, 'standard', manager_employee_id
  ) returning id into canceled_window_shift_id;

  insert into public.shifts (
    schedule_id, post_id, starts_at, ends_at, time_zone,
    requires_armed, assignment_type, created_by
  ) values (
    draft_schedule_id, standard_post_id, target_start + interval '18 hours',
    target_end + interval '18 hours', 'America/Denver', false, 'standard',
    manager_employee_id
  ) returning id into draft_shift_id;

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by
  ) values
    (standard_shift_id, target_employee_id, 'assigned', manager_employee_id),
    (dispatch_shift_id, target_employee_id, 'assigned', manager_employee_id),
    (draft_shift_id, target_employee_id, 'assigned', manager_employee_id);

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by, canceled_at,
    cancellation_reason
  ) values
    (
      canceled_shift_id, target_employee_id, 'assigned', manager_employee_id,
      clock_timestamp(), 'Rollback-only canceled assignment fixture.'
    ),
    (
      canceled_window_shift_id, target_employee_id, 'assigned', manager_employee_id,
      clock_timestamp(), 'Rollback-only in-window canceled fixture.'
    );

  -- Preserve the one-published-schedule-per-week invariant entirely inside
  -- this rollback-only transaction. Concurrent sessions retain the committed
  -- production schedule through MVCC while the fixture is exercised.
  update public.schedules
  set status = 'superseded'
  where week_starts_on = target_week
    and status = 'published';

  update public.schedules
  set status = 'published',
      published_at = clock_timestamp(),
      published_by = manager_employee_id
  where id = published_schedule_id;

  perform set_config('request.jwt.claim.sub', employee_auth_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', employee_auth_user_id,
    'role', 'authenticated',
    'aal', 'aal1'
  )::text, true);

  dashboard := public.get_timekeeping_dashboard(null);

  assert exists (
    select 1
    from jsonb_array_elements(dashboard -> 'eligibleShifts') item(value)
    where item.value ->> 'shiftId' = standard_shift_id::text
  ), 'The nearest later standard assignment is absent from My Time.';
  assert not exists (
    select 1
    from jsonb_array_elements(dashboard -> 'eligibleShifts') item(value)
    where item.value ->> 'shiftId' in (
      dispatch_shift_id::text,
      canceled_shift_id::text,
      canceled_window_shift_id::text,
      draft_shift_id::text
    )
  ), 'My Time exposed a concurrent-duty, canceled, or draft assignment.';

  perform set_config('request.jwt.claim.sub', manager_auth_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', manager_auth_user_id,
    'role', 'authenticated',
    'aal', 'aal1'
  )::text, true);

  begin
    perform public.get_accountability_workspace_v2(
      (clock_timestamp() at time zone 'America/Denver')::date,
      (clock_timestamp() at time zone 'America/Denver')::date
    );
  exception when insufficient_privilege then
    aal1_denied := true;
  end;
  assert aal1_denied,
    'The manager Accountability workspace no longer enforces MFA.';

  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', manager_auth_user_id,
    'role', 'authenticated',
    'aal', 'aal2'
  )::text, true);

  workspace := public.get_accountability_workspace_v2(
    (clock_timestamp() at time zone 'America/Denver')::date,
    (clock_timestamp() at time zone 'America/Denver')::date
  );

  assert exists (
    select 1
    from jsonb_array_elements(workspace -> 'shiftOptions') item(value)
    where item.value ->> 'id' = standard_shift_id::text
  ), 'The manager workspace did not decouple the future shift from the review date.';
  assert not exists (
    select 1
    from jsonb_array_elements(workspace -> 'shiftOptions') item(value)
    where item.value ->> 'id' in (
      dispatch_shift_id::text,
      canceled_shift_id::text,
      canceled_window_shift_id::text,
      draft_shift_id::text
    )
  ), 'The manager workspace exposed a concurrent-duty, canceled, or draft assignment.';

  range_workspace := public.get_accountability_workspace_v2(
    (target_start at time zone 'America/Denver')::date,
    ((target_end + interval '9 hours') at time zone 'America/Denver')::date
  );

  assert exists (
    select 1
    from jsonb_array_elements(range_workspace -> 'shiftOptions') item(value)
    where item.value ->> 'id' = standard_shift_id::text
  ), 'The requested review range lost its active standard assignment.';
  assert not exists (
    select 1
    from jsonb_array_elements(range_workspace -> 'shiftOptions') item(value)
    where item.value ->> 'id' in (
      dispatch_shift_id::text,
      canceled_shift_id::text
    )
  ), 'Historical-range choices exposed a concurrent-duty or canceled assignment.';

  raise notice 'Future call-off selection behavior, MFA denial, and assignment exclusions passed.';
end
$$;

rollback;

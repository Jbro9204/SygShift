begin;

set transaction isolation level repeatable read;
set local statement_timeout = '120s';

do $contract$
declare
  function_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.link_patrol_route_shift(uuid,uuid,uuid)'::regprocedure
  ) into function_definition;

  if position(E'\n  assignment_id uuid;' in function_definition) > 0
     or position('on conflict (assignment_id, requirement_id, hit_number)' in function_definition) > 0 then
    raise exception 'Patrol assignment linking still contains the ambiguous assignment_id contract.';
  end if;

  if position('patrol_assignment_id uuid;' in function_definition) = 0
     or position('on conflict on constraint patrol_hit_obligations_unique do nothing' in function_definition) = 0 then
    raise exception 'Patrol assignment linking is missing the unambiguous obligation insert contract.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc procedure_record
    where procedure_record.oid = 'public.link_patrol_route_shift(uuid,uuid,uuid)'::regprocedure
      and procedure_record.prosecdef
      and coalesce(procedure_record.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'Patrol assignment linking lost its SECURITY DEFINER or empty search_path boundary.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.link_patrol_route_shift(uuid,uuid,uuid)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.link_patrol_route_shift(uuid,uuid,uuid)',
    'execute'
  ) then
    raise exception 'Patrol assignment linking has incorrect browser execution grants.';
  end if;
end
$contract$;

do $fixtures$
declare
  actor_id uuid := gen_random_uuid();
  second_employee_id uuid := gen_random_uuid();
  actor_auth_id uuid := gen_random_uuid();
  site_id uuid := gen_random_uuid();
  post_id uuid := gen_random_uuid();
  schedule_id uuid := gen_random_uuid();
  shift_id uuid := gen_random_uuid();
  route_id uuid := gen_random_uuid();
  route_version_id uuid := gen_random_uuid();
  stop_id uuid := gen_random_uuid();
  requirement_id uuid := gen_random_uuid();
  week_start date;
  schedule_revision integer;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  service_day smallint;
  service_date date;
  test_suffix text := substr(replace(actor_id::text, '-', ''), 1, 12);
begin
  select candidate.week_start
  into week_start
  from (
    select (
      current_date - extract(dow from current_date)::integer + (series.week_offset * 7)
    )::date as week_start
    from generate_series(52, 520) as series(week_offset)
  ) candidate
  where not exists (
    select 1
    from public.schedules schedule
    where schedule.week_starts_on = candidate.week_start
      and schedule.status = 'published'
  )
  order by candidate.week_start
  limit 1;

  if week_start is null then
    raise exception 'Could not reserve an isolated schedule week for the rollback-only Patrol assignment regression.';
  end if;

  shift_starts_at := (week_start + 1 + time '20:00') at time zone 'America/Denver';
  shift_ends_at := shift_starts_at + interval '8 hours';
  service_day := extract(dow from shift_starts_at at time zone 'America/Denver')::smallint;
  service_date := (shift_starts_at at time zone 'America/Denver')::date;

  insert into public.employees (
    id, employee_number, username, first_name, last_name, role, status
  ) values
    (
      actor_id,
      'SYG-9' || translate(test_suffix, 'abcdef', '123456'),
      'pra' || test_suffix,
      'Patrol',
      'Assignment Test',
      'admin',
      'active'
    ),
    (
      second_employee_id,
      'SYG-8' || translate(test_suffix, 'abcdef', '123456'),
      'prs' || test_suffix,
      'Patrol',
      'Second Employee',
      'guard',
      'active'
    );

  insert into auth.users (id, email)
  values (actor_auth_id, 'patrol-assignment-' || test_suffix || '@example.invalid');

  insert into private.employee_accounts (
    employee_id, auth_user_id, activated_at
  ) values (
    actor_id, actor_auth_id, clock_timestamp()
  );

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  select actor_id, access_role.id, actor_id
  from public.access_roles access_role
  where access_role.code = 'system_admin'
  on conflict (employee_id, role_id) do nothing;

  if not exists (
    select 1
    from public.employee_access_roles employee_role
    join public.access_roles access_role on access_role.id = employee_role.role_id
    where employee_role.employee_id = actor_id
      and access_role.code = 'system_admin'
  ) then
    raise exception 'The system_admin access role is required for this regression.';
  end if;

  insert into public.sites (id, code, name, time_zone)
  values (
    site_id,
    'PRA-' || upper(substr(test_suffix, 1, 8)),
    'Patrol Assignment Site ' || test_suffix,
    'America/Denver'
  );

  insert into public.posts (id, site_id, name, requires_armed)
  values (
    post_id,
    site_id,
    'Patrol Assignment Post ' || test_suffix,
    false
  );

  select coalesce(max(schedule.revision), 0) + 1000
  into schedule_revision
  from public.schedules schedule
  where schedule.week_starts_on = week_start;

  insert into public.schedules (
    id, week_starts_on, revision, status, created_by
  ) values (
    schedule_id, week_start, schedule_revision, 'draft', actor_id
  );

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, work_type, assignment_type, created_by
  ) values (
    shift_id, schedule_id, post_id, shift_starts_at, shift_ends_at, 'America/Denver',
    2, false, false, 'post', 'standard', actor_id
  );

  insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
  values
    (shift_id, actor_id, 'assigned', actor_id),
    (shift_id, second_employee_id, 'assigned', actor_id);

  update public.schedules schedule
  set status = 'published',
      published_at = clock_timestamp(),
      published_by = actor_id,
      updated_at = clock_timestamp()
  where schedule.id = schedule_id;

  insert into public.patrol_routes (
    id, code, name, requires_armed, status, time_zone, created_by, updated_by
  ) values (
    route_id,
    'pra-' || lower(test_suffix),
    'Patrol Assignment Route ' || test_suffix,
    false,
    'draft',
    'America/Denver',
    actor_id,
    actor_id
  );

  insert into public.patrol_route_versions (
    id, route_id, version_number, effective_from, change_reason, created_by
  ) values (
    route_version_id,
    route_id,
    1,
    service_date,
    'Rollback-only Patrol assignment regression',
    actor_id
  );

  update public.patrol_routes route
  set current_version_id = route_version_id,
      status = 'active',
      updated_by = actor_id,
      updated_at = clock_timestamp()
  where route.id = route_id;

  insert into public.patrol_route_stops (
    id, route_version_id, sequence_number, location_label, site_id, post_id,
    require_evidence
  ) values (
    stop_id, route_version_id, 1,
    'Patrol assignment regression stop', site_id, post_id, false
  );

  insert into public.patrol_stop_requirements (
    id, stop_id, day_of_week, requirement_label, required_hits, status,
    sequence_required
  ) values (
    requirement_id, stop_id, service_day,
    'Assignment obligation regression', 2, 'active', false
  );

  perform set_config('pra.actor_id', actor_id::text, true);
  perform set_config('pra.second_employee_id', second_employee_id::text, true);
  perform set_config('pra.actor_auth_id', actor_auth_id::text, true);
  perform set_config('pra.route_id', route_id::text, true);
  perform set_config('pra.route_version_id', route_version_id::text, true);
  perform set_config('pra.shift_id', shift_id::text, true);
  perform set_config('pra.stop_id', stop_id::text, true);
  perform set_config('pra.requirement_id', requirement_id::text, true);
  perform set_config('pra.service_date', service_date::text, true);
  perform set_config('pra.shift_starts_at', shift_starts_at::text, true);
  perform set_config('pra.shift_ends_at', shift_ends_at::text, true);
  perform set_config(
    'pra.shift_assignment_count',
    (select count(*)::text from public.shift_assignments),
    true
  );
  perform set_config(
    'pra.call_off_count',
    (select count(*)::text from public.call_off_reports),
    true
  );
  perform set_config(
    'pra.attendance_count',
    (select count(*)::text from public.attendance_accountability_events),
    true
  );
  perform set_config(
    'pra.time_event_count',
    (select count(*)::text from public.time_events),
    true
  );
end
$fixtures$;

set local role authenticated;

do $workflow$
declare
  actor_id uuid := current_setting('pra.actor_id')::uuid;
  actor_auth_id uuid := current_setting('pra.actor_auth_id')::uuid;
  route_id uuid := current_setting('pra.route_id')::uuid;
  shift_id uuid := current_setting('pra.shift_id')::uuid;
  denied_auth_id uuid := gen_random_uuid();
  denied boolean := false;
  aal1_denied boolean := false;
  first_assignment_id uuid;
  replay_assignment_id uuid;
begin
  perform set_config('request.jwt.claim.sub', denied_auth_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', denied_auth_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  begin
    perform public.link_patrol_route_shift(route_id, shift_id, actor_id);
  exception
    when insufficient_privilege then denied := true;
  end;

  if not denied then
    raise exception 'An authenticated caller without an active employee identity linked a Patrol route.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );

  begin
    perform public.link_patrol_route_shift(route_id, shift_id, actor_id);
  exception
    when insufficient_privilege then aal1_denied := true;
  end;

  if not aal1_denied then
    raise exception 'An AAL1 assignment manager linked an MFA-protected Patrol route.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  if not public.has_effective_permission('patrol.assignments.manage') then
    raise exception 'The rollback-only Patrol assignment manager lacks the expected permission.';
  end if;

  first_assignment_id := public.link_patrol_route_shift(route_id, shift_id, actor_id);
  replay_assignment_id := public.link_patrol_route_shift(route_id, shift_id, actor_id);

  if first_assignment_id is null or replay_assignment_id <> first_assignment_id then
    raise exception 'Patrol assignment linking did not return one stable assignment on retry.';
  end if;

  perform set_config('pra.assignment_id', first_assignment_id::text, true);
end
$workflow$;

reset role;

do $assertions$
declare
  expected_actor_id uuid := current_setting('pra.actor_id')::uuid;
  other_employee_id uuid := current_setting('pra.second_employee_id')::uuid;
  expected_route_id uuid := current_setting('pra.route_id')::uuid;
  expected_route_version_id uuid := current_setting('pra.route_version_id')::uuid;
  expected_shift_id uuid := current_setting('pra.shift_id')::uuid;
  expected_stop_id uuid := current_setting('pra.stop_id')::uuid;
  expected_requirement_id uuid := current_setting('pra.requirement_id')::uuid;
  expected_assignment_id uuid := current_setting('pra.assignment_id')::uuid;
  expected_service_date date := current_setting('pra.service_date')::date;
  expected_shift_starts_at timestamptz := current_setting('pra.shift_starts_at')::timestamptz;
  expected_shift_ends_at timestamptz := current_setting('pra.shift_ends_at')::timestamptz;
begin
  if (
    select count(*)
    from public.patrol_assignments assignment
    where assignment.id = expected_assignment_id
      and assignment.route_id = expected_route_id
      and assignment.route_version_id = expected_route_version_id
      and assignment.shift_id = expected_shift_id
      and assignment.employee_id = expected_actor_id
      and assignment.service_date = expected_service_date
      and assignment.status = 'active'
  ) <> 1 then
    raise exception 'Patrol assignment linking did not persist the exact active route-version assignment.';
  end if;

  if (
    select count(*)
    from public.patrol_assignments assignment
    where assignment.route_version_id = expected_route_version_id
      and assignment.shift_id = expected_shift_id
      and assignment.employee_id = expected_actor_id
  ) <> 1 then
    raise exception 'Patrol assignment retry created a duplicate assignment.';
  end if;

  if exists (
    select 1
    from public.patrol_assignments assignment
    where assignment.route_version_id = expected_route_version_id
      and assignment.shift_id = expected_shift_id
      and assignment.employee_id = other_employee_id
  ) then
    raise exception 'Patrol assignment linking selected the wrong employee from a shared shift.';
  end if;

  if (
    select count(*)
    from public.patrol_hit_obligations obligation
    where obligation.assignment_id = expected_assignment_id
      and obligation.stop_id = expected_stop_id
      and obligation.requirement_id = expected_requirement_id
      and obligation.hit_number in (1, 2)
      and obligation.due_start_at = expected_shift_starts_at
      and obligation.due_end_at = expected_shift_ends_at
      and obligation.status = 'scheduled'
  ) <> 2 then
    raise exception 'Patrol assignment linking did not create the two exact route-plan obligations.';
  end if;

  if (
    select count(*)
    from public.patrol_hit_obligations obligation
    where obligation.assignment_id = expected_assignment_id
  ) <> 2 then
    raise exception 'Patrol assignment retry created duplicate or unexpected obligations.';
  end if;

  if (
    select count(*)
    from private.audit_events audit_event
    where audit_event.table_name = 'patrol_assignments'
      and audit_event.operation = 'link_shift'
      and audit_event.row_id = expected_assignment_id::text
      and audit_event.employee_id = expected_actor_id
  ) <> 2 then
    raise exception 'Patrol assignment linking did not retain one audit event per authorized request.';
  end if;

  if (select count(*) from public.shift_assignments) <> current_setting('pra.shift_assignment_count')::bigint
     or (select count(*) from public.call_off_reports) <> current_setting('pra.call_off_count')::bigint
     or (select count(*) from public.attendance_accountability_events) <> current_setting('pra.attendance_count')::bigint
     or (select count(*) from public.time_events) <> current_setting('pra.time_event_count')::bigint then
    raise exception 'Patrol assignment linking changed protected schedule, attendance, call-off, or timekeeping records.';
  end if;
end
$assertions$;

select 'patrol_assignment_link_regression: PASS' as result;

rollback;

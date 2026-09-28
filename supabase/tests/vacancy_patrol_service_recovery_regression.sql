begin;

-- Run against a fully migrated database. All identities, schedule rows, Patrol
-- records, notifications, audit receipts, and Finance decisions roll back.
set local statement_timeout = '120s';

do $fixtures$
declare
  actor_id uuid := gen_random_uuid();
  actor_auth_id uuid := gen_random_uuid();
  regular_site_id uuid := gen_random_uuid();
  unrelated_site_id uuid := gen_random_uuid();
  regular_post_id uuid := gen_random_uuid();
  unrelated_post_id uuid := gen_random_uuid();
  schedule_id uuid := gen_random_uuid();
  ended_schedule_id uuid := gen_random_uuid();
  source_shift_id uuid := gen_random_uuid();
  closed_shift_id uuid := gen_random_uuid();
  training_shift_id uuid := gen_random_uuid();
  dispatch_shift_id uuid := gen_random_uuid();
  ended_shift_id uuid := gen_random_uuid();
  route_id uuid := gen_random_uuid();
  route_version_id uuid := gen_random_uuid();
  matching_stop_id uuid := gen_random_uuid();
  unrelated_stop_id uuid := gen_random_uuid();
  closed_request_id uuid := gen_random_uuid();
  training_request_id uuid := gen_random_uuid();
  dispatch_request_id uuid := gen_random_uuid();
  ended_request_id uuid := gen_random_uuid();
  week_start date;
  schedule_revision integer;
  source_starts_at timestamptz := clock_timestamp() - interval '90 minutes';
  source_ends_at timestamptz := clock_timestamp() + interval '3 hours';
  ended_starts_at timestamptz := clock_timestamp() - interval '2 days';
  ended_ends_at timestamptz := clock_timestamp() - interval '1 day';
  service_day smallint;
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
    raise exception 'Could not reserve an isolated schedule week for the rollback-only regression.';
  end if;

  if not exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where access_role.code in ('system_dispatcher', 'system_scheduler', 'system_admin')
      and role_permission.permission_code = 'patrol.recovery.request'
      and role_permission.enabled
    group by role_permission.permission_code
    having count(distinct access_role.code) = 3
  ) then
    raise exception 'Dispatcher, Scheduler, and Admin do not all have Patrol recovery request authority.';
  end if;

  if exists (
    select 1
    from public.permission_catalog permission
    where permission.code in (
      'patrol.recovery.request',
      'patrol.recovery.finance.view',
      'patrol.recovery.billing.review',
      'patrol.recovery.finance.export'
    )
      and (not permission.requires_mfa or not permission.active)
  ) or (
    select count(*)
    from public.permission_catalog permission
    where permission.code in (
      'patrol.recovery.request',
      'patrol.recovery.finance.view',
      'patrol.recovery.billing.review',
      'patrol.recovery.finance.export'
    )
  ) <> 4 then
    raise exception 'Patrol recovery permissions are missing or are not MFA protected.';
  end if;

  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'vacancy_patrol_recovery_requests',
        'vacancy_patrol_recovery_hit_windows',
        'vacancy_patrol_recovery_status_history'
      )
      and (not relation.relrowsecurity or not relation.relforcerowsecurity)
  ) then
    raise exception 'A Patrol recovery table is missing forced RLS.';
  end if;

  if has_table_privilege('authenticated', 'public.vacancy_patrol_recovery_requests', 'select')
     or has_table_privilege('authenticated', 'public.vacancy_patrol_recovery_hit_windows', 'select')
     or has_table_privilege('authenticated', 'public.vacancy_patrol_recovery_status_history', 'select') then
    raise exception 'Authenticated clients received direct Patrol recovery table access.';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.create_vacancy_patrol_recovery(uuid,uuid,text,jsonb,uuid)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.review_vacancy_patrol_billing(uuid,text,text,text,uuid)',
    'execute'
  ) then
    raise exception 'Focused Patrol recovery RPC execution grants are missing.';
  end if;

  insert into public.employees (
    id, employee_number, username, first_name, last_name, role, status
  ) values (
    actor_id,
    'SYG-9' || translate(test_suffix, 'abcdef', '123456'),
    'vpr' || test_suffix,
    'Vacancy',
    'Recovery Test',
    'admin',
    'active'
  );

  insert into auth.users (id, email)
  values (actor_auth_id, 'vacancy-recovery-' || test_suffix || '@example.invalid');

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

  insert into public.sites (
    id, code, name, time_zone, supports_dispatch_phone_duty
  ) values
    (
      regular_site_id,
      'VPR-' || upper(substr(test_suffix, 1, 8)),
      'Vacancy Recovery Source ' || test_suffix,
      'America/New_York',
      false
    ),
    (
      unrelated_site_id,
      'VPU-' || upper(substr(test_suffix, 1, 8)),
      'Vacancy Recovery Unrelated ' || test_suffix,
      'America/New_York',
      true
    );

  insert into public.posts (id, site_id, name, requires_armed)
  values
    (regular_post_id, regular_site_id, 'Vacant source post ' || test_suffix, false),
    (unrelated_post_id, unrelated_site_id, 'Unrelated route post ' || test_suffix, false);

  select coalesce(max(schedule.revision), 0) + 1000
  into schedule_revision
  from public.schedules schedule
  where schedule.week_starts_on = week_start;

  insert into public.schedules (
    id, week_starts_on, revision, status, created_by
  ) values (
    schedule_id, week_start, schedule_revision, 'draft', actor_id
  );

  ended_schedule_id := schedule_id;

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, work_type, assignment_type, created_by
  ) values
    (
      source_shift_id, schedule_id, regular_post_id,
      source_starts_at, source_ends_at, 'America/New_York',
      1, false, true, 'post', 'standard', actor_id
    ),
    (
      closed_shift_id, schedule_id, regular_post_id,
      source_starts_at, source_ends_at, 'America/New_York',
      1, false, false, 'post', 'standard', actor_id
    ),
    (
      training_shift_id, schedule_id, regular_post_id,
      source_starts_at, source_ends_at, 'America/New_York',
      1, false, true, 'training', 'standard', actor_id
    ),
    (
      dispatch_shift_id, schedule_id, unrelated_post_id,
      source_starts_at, source_ends_at, 'America/New_York',
      1, false, true, 'post', 'dispatch_phone_duty', actor_id
    ),
    (
      ended_shift_id, ended_schedule_id, regular_post_id,
      ended_starts_at, ended_ends_at, 'America/New_York',
      1, false, true, 'post', 'standard', actor_id
    );

  update public.schedules schedule
  set status = 'published',
      published_at = clock_timestamp(),
      published_by = actor_id,
      updated_at = clock_timestamp()
  where schedule.id = schedule_id;

  -- Pin this dedicated guard fixture closed after schedule triggers run.
  update public.shifts
  set is_open = false
  where id = closed_shift_id;

  insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
  values (closed_shift_id, actor_id, 'assigned', actor_id);

  service_day := extract(dow from source_starts_at at time zone 'America/New_York')::smallint;

  insert into public.patrol_routes (
    id, code, name, requires_armed, status, time_zone, created_by, updated_by
  ) values (
    route_id,
    'vpr-' || lower(substr(test_suffix, 1, 12)),
    'Vacancy Recovery Route ' || test_suffix,
    false,
    'draft',
    'America/New_York',
    actor_id,
    actor_id
  );

  insert into public.patrol_route_versions (
    id, route_id, version_number, effective_from, change_reason, created_by
  ) values (
    route_version_id,
    route_id,
    1,
    current_date,
    'Rollback-only vacancy recovery route',
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
  ) values
    (
      matching_stop_id, route_version_id, 1,
      'Source post recovery stop', regular_site_id, regular_post_id, false
    ),
    (
      unrelated_stop_id, route_version_id, 2,
      'Unrelated site stop', unrelated_site_id, unrelated_post_id, false
    );

  insert into public.patrol_stop_requirements (
    stop_id, day_of_week, requirement_label, required_hits, status, sequence_required
  ) values
    (matching_stop_id, service_day, 'Source location recovery', 2, 'active', false),
    (unrelated_stop_id, service_day, 'Unrelated location patrol', 2, 'active', false);

  insert into public.vacancy_patrol_recovery_requests (
    id, source_shift_id, requested_route_id, requested_route_version_id,
    reason, requested_by, idempotency_key, request_fingerprint
  ) values
    (
      closed_request_id, closed_shift_id, route_id, route_version_id,
      'Rollback-only request used to verify the acceptance open-shift guard.',
      actor_id, gen_random_uuid(), md5(closed_request_id::text)
    ),
    (
      training_request_id, training_shift_id, route_id, route_version_id,
      'Rollback-only request used to verify the acceptance training guard.',
      actor_id, gen_random_uuid(), md5(training_request_id::text)
    ),
    (
      dispatch_request_id, dispatch_shift_id, route_id, route_version_id,
      'Rollback-only request used to verify the acceptance Dispatch guard.',
      actor_id, gen_random_uuid(), md5(dispatch_request_id::text)
    ),
    (
      ended_request_id, ended_shift_id, route_id, route_version_id,
      'Rollback-only request used to verify the acceptance end-time guard.',
      actor_id, gen_random_uuid(), md5(ended_request_id::text)
    );

  insert into public.vacancy_patrol_recovery_hit_windows (
    request_id, plan_version, sequence_number, window_start_at, window_end_at,
    planned_hits, created_by
  ) values
    (closed_request_id, 1, 1, source_starts_at, source_ends_at, 1, actor_id),
    (training_request_id, 1, 1, source_starts_at, source_ends_at, 1, actor_id),
    (dispatch_request_id, 1, 1, source_starts_at, source_ends_at, 1, actor_id),
    (
      ended_request_id, 1, 1,
      ended_starts_at + interval '30 minutes',
      ended_ends_at - interval '30 minutes',
      1,
      actor_id
    );

  perform set_config('vpr.actor_id', actor_id::text, true);
  perform set_config('vpr.actor_auth_id', actor_auth_id::text, true);
  perform set_config('vpr.week_start', week_start::text, true);
  perform set_config('vpr.source_shift_id', source_shift_id::text, true);
  perform set_config('vpr.closed_shift_id', closed_shift_id::text, true);
  perform set_config('vpr.training_shift_id', training_shift_id::text, true);
  perform set_config('vpr.dispatch_shift_id', dispatch_shift_id::text, true);
  perform set_config('vpr.ended_shift_id', ended_shift_id::text, true);
  perform set_config('vpr.closed_request_id', closed_request_id::text, true);
  perform set_config('vpr.training_request_id', training_request_id::text, true);
  perform set_config('vpr.dispatch_request_id', dispatch_request_id::text, true);
  perform set_config('vpr.ended_request_id', ended_request_id::text, true);
  perform set_config('vpr.route_id', route_id::text, true);
  perform set_config('vpr.route_version_id', route_version_id::text, true);
  perform set_config('vpr.matching_stop_id', matching_stop_id::text, true);
  perform set_config('vpr.unrelated_stop_id', unrelated_stop_id::text, true);
  perform set_config('vpr.source_starts_at', source_starts_at::text, true);
  perform set_config('vpr.source_ends_at', source_ends_at::text, true);
  perform set_config('vpr.ended_starts_at', ended_starts_at::text, true);
  perform set_config('vpr.ended_ends_at', ended_ends_at::text, true);
  perform set_config(
    'vpr.shift_assignment_count',
    (select count(*)::text from public.shift_assignments),
    true
  );
  perform set_config(
    'vpr.call_off_count',
    (select count(*)::text from public.call_off_reports),
    true
  );
  perform set_config(
    'vpr.attendance_occurrence_count',
    (select count(*)::text from public.attendance_accountability_events),
    true
  );
  perform set_config(
    'vpr.time_event_count',
    (select count(*)::text from public.time_events),
    true
  );
  perform set_config(
    'vpr.payroll_export_row_count',
    (select count(*)::text from private.payroll_export_rows),
    true
  );
end
$fixtures$;

-- The recovery-request synchronization trigger refreshes source-vacancy state.
-- Restore the dedicated closed-shift guard immediately before authenticated RPC tests.
update public.shifts
set is_open = false
where id = current_setting('vpr.closed_shift_id')::uuid;

set local role authenticated;

do $workflow$
declare
  actor_id uuid := current_setting('vpr.actor_id')::uuid;
  actor_auth_id uuid := current_setting('vpr.actor_auth_id')::uuid;
  week_start date := current_setting('vpr.week_start')::date;
  source_shift_id uuid := current_setting('vpr.source_shift_id')::uuid;
  closed_shift_id uuid := current_setting('vpr.closed_shift_id')::uuid;
  training_shift_id uuid := current_setting('vpr.training_shift_id')::uuid;
  dispatch_shift_id uuid := current_setting('vpr.dispatch_shift_id')::uuid;
  ended_shift_id uuid := current_setting('vpr.ended_shift_id')::uuid;
  closed_request_id uuid := current_setting('vpr.closed_request_id')::uuid;
  training_request_id uuid := current_setting('vpr.training_request_id')::uuid;
  dispatch_request_id uuid := current_setting('vpr.dispatch_request_id')::uuid;
  ended_request_id uuid := current_setting('vpr.ended_request_id')::uuid;
  route_id uuid := current_setting('vpr.route_id')::uuid;
  matching_stop_id uuid := current_setting('vpr.matching_stop_id')::uuid;
  unrelated_stop_id uuid := current_setting('vpr.unrelated_stop_id')::uuid;
  source_starts_at timestamptz := current_setting('vpr.source_starts_at')::timestamptz;
  source_ends_at timestamptz := current_setting('vpr.source_ends_at')::timestamptz;
  ended_starts_at timestamptz := current_setting('vpr.ended_starts_at')::timestamptz;
  ended_ends_at timestamptz := current_setting('vpr.ended_ends_at')::timestamptz;
  request_key uuid := gen_random_uuid();
  plan_key uuid := gen_random_uuid();
  accept_key uuid := gen_random_uuid();
  review_key uuid := gen_random_uuid();
  bootstrap jsonb;
  created jsonb;
  replay jsonb;
  plan_receipt jsonb;
  accepted jsonb;
  worklist jsonb;
  detail jsonb;
  schedule_map jsonb;
  workspace jsonb;
  finance_report jsonb;
  review_receipt jsonb;
  export_receipt jsonb;
  assignment_payload jsonb;
  active_obligation jsonb;
  finance_row jsonb;
  request_id uuid;
  assignment_id uuid;
  service_date date := (source_starts_at at time zone 'America/New_York')::date;
  denied boolean := false;
  closed_blocked boolean := false;
  training_bootstrap_blocked boolean := false;
  training_create_blocked boolean := false;
  dispatch_blocked boolean := false;
  ended_create_blocked boolean := false;
  closed_accept_blocked boolean := false;
  training_accept_blocked boolean := false;
  dispatch_accept_blocked boolean := false;
  ended_accept_blocked boolean := false;
  direct_read_blocked boolean := false;
  reference_value text := 'VPR-ROLLBACK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
  initial_windows jsonb;
  recovery_windows jsonb;
begin
  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );

  begin
    perform public.get_vacancy_patrol_recovery_bootstrap(source_shift_id);
  exception
    when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'AAL1 was allowed to open the MFA-protected recovery bootstrap.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  bootstrap := public.get_vacancy_patrol_recovery_bootstrap(source_shift_id);
  if (bootstrap #>> '{shift,shiftId}')::uuid <> source_shift_id
     or not coalesce((bootstrap #>> '{shift,isPublished}')::boolean, false)
     or not coalesce((bootstrap #>> '{shift,isUnassigned}')::boolean, false)
     or not exists (
       select 1
       from jsonb_array_elements(bootstrap -> 'routeChoices') route_choice
       where (route_choice ->> 'routeId')::uuid = route_id
     ) then
    raise exception 'The eligible regular vacancy bootstrap is incomplete.';
  end if;

  begin
    perform public.get_vacancy_patrol_recovery_bootstrap(training_shift_id);
  exception when others then
    training_bootstrap_blocked := true;
  end;
  if not training_bootstrap_blocked then
    raise exception 'A training shift was exposed as a Patrol recovery vacancy.';
  end if;

  begin
    perform public.create_vacancy_patrol_recovery(
      training_shift_id,
      route_id,
      'Rollback-only training classification rejection.',
      jsonb_build_array(jsonb_build_object(
        'windowStartAt', source_starts_at,
        'windowEndAt', source_ends_at,
        'plannedHits', 1
      )),
      gen_random_uuid()
    );
  exception when check_violation then
    training_create_blocked := position('regular post' in sqlerrm) > 0;
  end;
  if not training_create_blocked then
    raise exception 'A training shift bypassed the regular-post creation guard.';
  end if;

  begin
    perform public.create_vacancy_patrol_recovery(
      closed_shift_id,
      route_id,
      'Rollback-only closed vacancy rejection.',
      jsonb_build_array(jsonb_build_object(
        'windowStartAt', source_starts_at,
        'windowEndAt', source_ends_at,
        'plannedHits', 1
      )),
      gen_random_uuid()
    );
  exception when check_violation then
    closed_blocked := position('open regular post' in sqlerrm) > 0;
  end;
  if not closed_blocked then
    raise exception 'A non-open shift bypassed the vacancy eligibility guard.';
  end if;

  begin
    perform public.create_vacancy_patrol_recovery(
      dispatch_shift_id,
      route_id,
      'Rollback-only Dispatch classification rejection.',
      jsonb_build_array(jsonb_build_object(
        'windowStartAt', source_starts_at,
        'windowEndAt', source_ends_at,
        'plannedHits', 1
      )),
      gen_random_uuid()
    );
  exception when check_violation then
    dispatch_blocked := position('regular post' in sqlerrm) > 0;
  end;
  if not dispatch_blocked then
    raise exception 'A Dispatch phone-duty shift bypassed the regular-post guard.';
  end if;

  begin
    perform public.create_vacancy_patrol_recovery(
      ended_shift_id,
      route_id,
      'Rollback-only ended source shift rejection.',
      jsonb_build_array(jsonb_build_object(
        'windowStartAt', ended_starts_at,
        'windowEndAt', ended_ends_at,
        'plannedHits', 1
      )),
      gen_random_uuid()
    );
  exception when check_violation then
    ended_create_blocked := position('before the source shift ends' in sqlerrm) > 0;
  end;
  if not ended_create_blocked then
    raise exception 'An ended source shift bypassed request creation.';
  end if;

  begin
    perform public.accept_vacancy_patrol_recovery(
      closed_request_id,
      route_id,
      actor_id,
      'Reject closed rollback request.',
      gen_random_uuid()
    );
  exception when object_not_in_prerequisite_state then
    closed_accept_blocked := position('open regular post' in sqlerrm) > 0;
  end;
  if not closed_accept_blocked then
    raise exception 'A non-open shift bypassed Patrol acceptance.';
  end if;

  begin
    perform public.accept_vacancy_patrol_recovery(
      training_request_id,
      route_id,
      actor_id,
      'Reject training rollback request.',
      gen_random_uuid()
    );
  exception when object_not_in_prerequisite_state then
    training_accept_blocked := position('regular post' in sqlerrm) > 0;
  end;
  if not training_accept_blocked then
    raise exception 'A training shift bypassed Patrol acceptance.';
  end if;

  begin
    perform public.accept_vacancy_patrol_recovery(
      dispatch_request_id,
      route_id,
      actor_id,
      'Reject Dispatch rollback request.',
      gen_random_uuid()
    );
  exception when object_not_in_prerequisite_state then
    dispatch_accept_blocked := position('regular post' in sqlerrm) > 0;
  end;
  if not dispatch_accept_blocked then
    raise exception 'A Dispatch phone-duty shift bypassed Patrol acceptance.';
  end if;

  begin
    perform public.accept_vacancy_patrol_recovery(
      ended_request_id,
      route_id,
      actor_id,
      'Reject ended rollback request.',
      gen_random_uuid()
    );
  exception when object_not_in_prerequisite_state then
    ended_accept_blocked := position('already ended' in sqlerrm) > 0;
  end;
  if not ended_accept_blocked then
    raise exception 'An ended source shift bypassed Patrol acceptance.';
  end if;

  initial_windows := jsonb_build_array(jsonb_build_object(
    'windowStartAt', source_starts_at,
    'windowEndAt', source_ends_at,
    'plannedHits', 1
  ));
  recovery_windows := jsonb_build_array(
    jsonb_build_object(
      'windowStartAt', source_starts_at + interval '10 minutes',
      'windowEndAt', clock_timestamp() - interval '20 minutes',
      'plannedHits', 1
    ),
    jsonb_build_object(
      'windowStartAt', clock_timestamp() - interval '10 minutes',
      'windowEndAt', clock_timestamp() + interval '2 hours',
      'plannedHits', 1
    )
  );

  created := public.create_vacancy_patrol_recovery(
    source_shift_id,
    route_id,
    'Rollback-only regular vacancy recovered through source-location Patrol hits.',
    initial_windows,
    request_key
  );
  replay := public.create_vacancy_patrol_recovery(
    source_shift_id,
    route_id,
    'Rollback-only regular vacancy recovered through source-location Patrol hits.',
    initial_windows,
    request_key
  );
  request_id := (created ->> 'requestId')::uuid;
  if request_id is null
     or created ->> 'status' <> 'requested'
     or coalesce((created ->> 'idempotentReplay')::boolean, true)
     or not coalesce((replay ->> 'idempotentReplay')::boolean, false)
     or (replay ->> 'requestId')::uuid <> request_id then
    raise exception 'Recovery request creation is not atomically idempotent.';
  end if;

  plan_receipt := public.update_vacancy_patrol_recovery(
    request_id,
    'update_plan',
    'Split the rollback plan into missed and completable windows.',
    recovery_windows,
    plan_key
  );
  replay := public.update_vacancy_patrol_recovery(
    request_id,
    'update_plan',
    'Split the rollback plan into missed and completable windows.',
    recovery_windows,
    plan_key
  );
  if (plan_receipt ->> 'plannedHits')::integer <> 2
     or not coalesce((replay ->> 'idempotentReplay')::boolean, false) then
    raise exception 'Versioned recovery-plan update or replay failed.';
  end if;

  accepted := public.accept_vacancy_patrol_recovery(
    request_id,
    route_id,
    actor_id,
    'Accept source-location rollback coverage.',
    accept_key
  );
  replay := public.accept_vacancy_patrol_recovery(
    request_id,
    route_id,
    actor_id,
    'Accept source-location rollback coverage.',
    accept_key
  );
  assignment_id := (accepted ->> 'patrolAssignmentId')::uuid;
  if assignment_id is null
     or accepted ->> 'status' <> 'patrol_planned'
     or (accepted ->> 'plannedHits')::integer <> 2
     or not coalesce((replay ->> 'idempotentReplay')::boolean, false) then
    raise exception 'Patrol acceptance or idempotent replay failed.';
  end if;

  replay := public.create_vacancy_patrol_recovery(
    source_shift_id,
    route_id,
    'Rollback-only regular vacancy recovered through source-location Patrol hits.',
    initial_windows,
    request_key
  );
  if replay ->> 'status' <> 'requested'
     or not coalesce((replay ->> 'idempotentReplay')::boolean, false)
     or (replay ->> 'requestId')::uuid <> request_id then
    raise exception 'Creation replay did not preserve the original requested receipt after acceptance.';
  end if;

  worklist := public.get_vacancy_patrol_recovery_worklist(
    service_date - 1,
    service_date + 1,
    null
  );
  if (worklist #>> '{counts,total}')::integer < 1
     or not coalesce((worklist #>> '{permissions,canAccept}')::boolean, false) then
    raise exception 'The Patrol manager worklist contract is incomplete.';
  end if;

  workspace := public.get_patrol_workspace();
  select item.value
  into assignment_payload
  from jsonb_array_elements(workspace -> 'assignments') item(value)
  where (item.value ->> 'id')::uuid = assignment_id;

  if assignment_payload is null
     or jsonb_array_length(assignment_payload -> 'obligations') <> 2
     or exists (
       select 1
       from jsonb_array_elements(assignment_payload -> 'obligations') obligation
       where (obligation ->> 'stopId')::uuid <> matching_stop_id
          or obligation ->> 'source' <> 'vacancy_recovery'
          or nullif(obligation ->> 'recoveryHitWindowId', '') is null
     )
     or exists (
       select 1
       from jsonb_array_elements(assignment_payload -> 'obligations') obligation
       where (obligation ->> 'stopId')::uuid = unrelated_stop_id
     ) then
    raise exception 'Recovery obligations escaped the vacant source post or lost My Patrol metadata.';
  end if;

  select obligation.value
  into active_obligation
  from jsonb_array_elements(assignment_payload -> 'obligations') obligation(value)
  where obligation.value ->> 'status' in ('scheduled', 'due', 'late')
  order by (obligation.value ->> 'dueEndAt')::timestamptz desc
  limit 1;

  if active_obligation is null
     or not exists (
       select 1
       from jsonb_array_elements(assignment_payload -> 'obligations') obligation
       where obligation ->> 'status' = 'missed'
     ) then
    raise exception 'The mixed terminal-outcome fixture did not produce one missed and one actionable hit.';
  end if;

  detail := public.get_vacancy_patrol_recovery(request_id);
  if detail ->> 'status' <> 'in_progress'
     or (detail ->> 'completedHits')::integer <> 0
     or (detail ->> 'missedHits')::integer <> 1 then
    raise exception 'A reconciled miss was misreported before the remaining hit completed.';
  end if;

  schedule_map := public.get_vacancy_patrol_recovery_map(week_start);
  if not exists (
    select 1
    from jsonb_array_elements(schedule_map -> 'recoveries') marker
    where (marker ->> 'requestId')::uuid = request_id
      and marker ->> 'displayStage' = 'partial'
  ) then
    raise exception 'Schedule did not persist the partial Patrol recovery marker.';
  end if;

  perform public.save_patrol_hit(
    null,
    assignment_id,
    (active_obligation ->> 'stopId')::uuid,
    (active_obligation ->> 'id')::uuid,
    null,
    'required',
    'secure',
    'Rollback test completed the remaining source location patrol hit.',
    null,
    'unavailable',
    null,
    null,
    null,
    clock_timestamp(),
    gen_random_uuid(),
    true
  );

  detail := public.get_vacancy_patrol_recovery(request_id);
  if detail ->> 'status' <> 'completed'
     or detail ->> 'displayStage' <> 'completed'
     or (detail ->> 'plannedHits')::integer <> 2
     or (detail ->> 'completedHits')::integer <> 1
     or (detail ->> 'missedHits')::integer <> 1 then
    raise exception 'Fully reconciled mixed outcomes did not become Finance-reviewable without falsifying counts.';
  end if;

  finance_report := public.get_vacancy_patrol_finance_report(
    service_date - 1,
    service_date + 1,
    null
  );
  select row_item.value
  into finance_row
  from jsonb_array_elements(finance_report -> 'rows') row_item(value)
  where (row_item.value ->> 'requestId')::uuid = request_id;

  if finance_row is null
     or finance_row ->> 'status' <> 'completed'
     or finance_row ->> 'billingDisposition' <> 'pending_review'
     or (finance_row ->> 'completedHits')::integer <> 1
     or (finance_row ->> 'missedHits')::integer <> 1
     or (finance_row ->> 'remainingHits')::integer <> 0
     or not coalesce((finance_row ->> 'canReview')::boolean, false)
     or not coalesce((finance_report #>> '{permissions,canExport}')::boolean, false) then
    raise exception 'Finance report did not preserve completed/missed service or actionability.';
  end if;

  review_receipt := public.review_vacancy_patrol_billing(
    request_id,
    'bill_separately',
    'Rollback Finance review confirmed a separate disposition without creating a charge.',
    reference_value,
    review_key
  );
  replay := public.review_vacancy_patrol_billing(
    request_id,
    'bill_separately',
    'Rollback Finance review confirmed a separate disposition without creating a charge.',
    reference_value,
    review_key
  );
  if review_receipt ->> 'billingDisposition' <> 'bill_separately'
     or review_receipt ->> 'billingReference' <> reference_value
     or (review_receipt ->> 'auditId') is null
     or not coalesce((replay ->> 'idempotentReplay')::boolean, false) then
    raise exception 'Finance review did not return an audited idempotent receipt.';
  end if;

  schedule_map := public.get_vacancy_patrol_recovery_map(week_start);
  if not exists (
    select 1
    from jsonb_array_elements(schedule_map -> 'recoveries') marker
    where (marker ->> 'requestId')::uuid = request_id
      and marker ->> 'displayStage' = 'finance_reviewed'
      and marker ->> 'billingDisposition' = 'bill_separately'
  ) then
    raise exception 'Schedule did not persist the Finance-reviewed recovery marker.';
  end if;

  export_receipt := public.authorize_vacancy_patrol_finance_export(
    service_date - 1,
    service_date + 1,
    'csv'
  );
  if export_receipt ->> 'format' <> 'csv'
     or export_receipt ->> 'auditId' is null
     or export_receipt ->> 'authorizedAt' is null then
    raise exception 'Finance export authorization did not return an audit receipt.';
  end if;

  begin
    perform request.id
    from public.vacancy_patrol_recovery_requests request
    where request.id = request_id;
  exception when insufficient_privilege then
    direct_read_blocked := true;
  end;
  if not direct_read_blocked then
    raise exception 'Authenticated SQL bypassed the focused recovery read RPCs.';
  end if;

  perform set_config('vpr.request_id', request_id::text, true);
  perform set_config('vpr.assignment_id', assignment_id::text, true);
  perform set_config('vpr.review_audit_id', review_receipt ->> 'auditId', true);
  perform set_config('vpr.export_audit_id', export_receipt ->> 'auditId', true);
  perform set_config('vpr.billing_reference', reference_value, true);
end
$workflow$;

reset role;

do $storage_checks$
declare
  v_actor_id uuid := current_setting('vpr.actor_id')::uuid;
  v_source_shift_id uuid := current_setting('vpr.source_shift_id')::uuid;
  v_request_id uuid := current_setting('vpr.request_id')::uuid;
  v_assignment_id uuid := current_setting('vpr.assignment_id')::uuid;
  v_matching_stop_id uuid := current_setting('vpr.matching_stop_id')::uuid;
  v_unrelated_stop_id uuid := current_setting('vpr.unrelated_stop_id')::uuid;
  v_billing_reference text := current_setting('vpr.billing_reference');
  history_change_blocked boolean := false;
begin
  if (select count(*) from public.shift_assignments)
       <> current_setting('vpr.shift_assignment_count')::bigint
     or (select count(*) from public.call_off_reports)
       <> current_setting('vpr.call_off_count')::bigint
     or (select count(*) from public.attendance_accountability_events)
       <> current_setting('vpr.attendance_occurrence_count')::bigint
     or (select count(*) from public.time_events)
       <> current_setting('vpr.time_event_count')::bigint
     or (select count(*) from private.payroll_export_rows)
       <> current_setting('vpr.payroll_export_row_count')::bigint then
    raise exception 'Recovery mutated regular assignments, absences, attendance, timekeeping, or payroll exports.';
  end if;

  if not exists (
    select 1
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    where shift.id = v_source_shift_id
      and schedule.status = 'published'
      and shift.canceled_at is null
      and shift.is_open
      and not exists (
        select 1
        from public.shift_assignments shift_assignment
        where shift_assignment.shift_id = shift.id
          and shift_assignment.status in ('assigned', 'confirmed', 'completed')
      )
  ) then
    raise exception 'The original published regular vacancy was not preserved unassigned.';
  end if;

  if not exists (
    select 1
    from public.vacancy_patrol_recovery_requests recovery
    where recovery.id = v_request_id
      and recovery.source_shift_id = v_source_shift_id
      and recovery.status = 'completed'
      and recovery.patrol_assignment_id = v_assignment_id
      and recovery.billing_disposition = 'bill_separately'
      and recovery.billing_reference = v_billing_reference
      and recovery.billing_reviewed_by = v_actor_id
  ) then
    raise exception 'The durable recovery or explicit Finance disposition was not stored.';
  end if;

  if (
    select count(*)
    from public.patrol_hit_obligations obligation
    where obligation.assignment_id = v_assignment_id
      and obligation.source = 'vacancy_recovery'
      and obligation.recovery_hit_window_id is not null
      and obligation.stop_id = v_matching_stop_id
  ) <> 2 or exists (
    select 1
    from public.patrol_hit_obligations obligation
    where obligation.assignment_id = v_assignment_id
      and obligation.stop_id = v_unrelated_stop_id
  ) then
    raise exception 'Stored recovery obligations were not strictly scoped to the vacant post.';
  end if;

  if (
    select count(*)
    from public.patrol_hit_obligations obligation
    where obligation.assignment_id = v_assignment_id
      and obligation.status = 'completed'
  ) <> 1 or (
    select count(*)
    from public.patrol_hit_obligations obligation
    where obligation.assignment_id = v_assignment_id
      and obligation.status = 'missed'
  ) <> 1 then
    raise exception 'Terminal obligation outcomes were overwritten or miscounted.';
  end if;

  if (
    select count(*)
    from public.vacancy_patrol_recovery_status_history history
    where history.request_id = v_request_id
      and history.action = 'billing_reviewed'
  ) <> 1 then
    raise exception 'Finance idempotency created duplicate billing-review history.';
  end if;

  begin
    update public.vacancy_patrol_recovery_status_history history
    set note = 'This append-only mutation must be rejected.'
    where history.request_id = v_request_id;
  exception when others then
    history_change_blocked := true;
  end;
  if not history_change_blocked then
    raise exception 'Recovery status history is not append-only.';
  end if;

  if not exists (
    select 1
    from private.audit_events audit
    where audit.id = current_setting('vpr.review_audit_id')::bigint
      and audit.table_name = 'vacancy_patrol_recovery_requests'
      and audit.operation = 'billing_review'
  ) or not exists (
    select 1
    from private.audit_events audit
    where audit.id = current_setting('vpr.export_audit_id')::bigint
      and audit.table_name = 'vacancy_patrol_recovery_finance'
      and audit.operation = 'export'
  ) then
    raise exception 'Finance review or export audit evidence is missing.';
  end if;

  if not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'vacancy_patrol_recovery'
      and notification.source_id = v_request_id
      and notification.action_path = '/patrol/recovery'
  ) or not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'vacancy_patrol_recovery'
      and notification.source_id = v_request_id
      and notification.recipient_employee_id = v_actor_id
      and notification.action_path = '/patrol/my-patrol'
  ) or not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'vacancy_patrol_recovery'
      and notification.source_id = v_request_id
      and notification.action_path = '/reports/vacancyPatrolFinance'
  ) then
    raise exception 'Focused Schedule, My Patrol, or Finance notification routing is missing.';
  end if;

  if not exists (
    select 1
    from pg_indexes index_record
    where index_record.schemaname = 'public'
      and index_record.indexname = 'vacancy_patrol_billing_reference_unique'
      and index_record.indexdef ilike '%unique index%'
  ) then
    raise exception 'Normalized separate-billing references are not uniqueness protected.';
  end if;
end
$storage_checks$;

select 'vacancy_patrol_service_recovery_regression: PASS' as result;

rollback;

-- Run after 20261006113000. All report fixtures and the export audit roll back.

begin;

set local statement_timeout = '90s';

-- Reproduce the production schema extension that exposed the unsafe shift.*
-- projection. The report must ignore unrelated future shift columns.
alter table public.shifts add column if not exists payroll_category text;

do $permission_contract$
begin
  assert has_function_privilege(
    'authenticated',
    'public.get_workforce_activity_report_page(date,date,text,text,uuid,uuid,uuid,uuid,text,text,integer,integer)',
    'EXECUTE'
  ), 'Authenticated sessions can call the protected workforce activity page RPC.';
  assert has_function_privilege(
    'authenticated',
    'public.export_workforce_activity_report(date,date,text,text,uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ), 'Authenticated sessions can call the protected workforce activity export RPC.';
  assert has_function_privilege(
    'authenticated',
    'public.get_workforce_activity_report_employee_options()',
    'EXECUTE'
  ), 'Authenticated sessions can load the protected workforce activity employee picker.';
  assert not has_function_privilege(
    'anon',
    'public.get_workforce_activity_report_page(date,date,text,text,uuid,uuid,uuid,uuid,text,text,integer,integer)',
    'EXECUTE'
  ), 'Anonymous sessions cannot execute the workforce activity report.';
  assert not has_function_privilege(
    'anon',
    'public.get_workforce_activity_report_employee_options()',
    'EXECUTE'
  ), 'Anonymous sessions cannot load the workforce activity employee picker.';
  assert not has_function_privilege(
    'authenticated',
    'private.get_workforce_activity_report_rows(date,date)',
    'EXECUTE'
  ), 'Authenticated clients cannot bypass the report RPC through its private row source.';
  assert not has_function_privilege(
    'authenticated',
    'private.build_workforce_activity_report(date,date,text,text,uuid,uuid,uuid,uuid,text,text,integer,integer)',
    'EXECUTE'
  ), 'Authenticated clients cannot bypass report authorization through the private renderer.';
  assert not has_schema_privilege('authenticated', 'private', 'USAGE'),
    'Authenticated clients cannot enter the private schema.';
  assert pg_catalog.pg_get_functiondef(
    'private.get_workforce_activity_report_rows(date,date)'::pg_catalog.regprocedure
  ) !~ 'current_shifts[[:space:]]+as[[:space:]]+materialized[[:space:]]*[(][[:space:]]*select[[:space:]]+shift[.][*]',
    'The report must not propagate every shift column into grouped vacancy rows.';
  assert position(
    'report.duplicate_of_call_off_report_id is null' in pg_catalog.pg_get_functiondef(
      'private.get_workforce_activity_report_rows(date,date)'::pg_catalog.regprocedure
    )
  ) > 0, 'The Workforce Activity repair must retain canonical call-off duplicate filtering.';
end
$permission_contract$;

do $workforce_activity_regression$
declare
  actor_employee constant uuid := 'fb110000-0000-4000-8000-000000000001';
  actor_auth constant uuid := 'fb120000-0000-4000-8000-000000000001';
  unauthorized_employee constant uuid := 'fb110000-0000-4000-8000-000000000002';
  unauthorized_auth constant uuid := 'fb120000-0000-4000-8000-000000000002';
  export_limited_employee constant uuid := 'fb110000-0000-4000-8000-00000000000b';
  export_limited_auth constant uuid := 'fb120000-0000-4000-8000-00000000000b';
  scheduled_worker constant uuid := 'fb110000-0000-4000-8000-000000000003';
  scheduled_only_worker constant uuid := 'fb110000-0000-4000-8000-000000000004';
  absent_worker constant uuid := 'fb110000-0000-4000-8000-000000000005';
  replacement_worker constant uuid := 'fb110000-0000-4000-8000-000000000006';
  salary_worker constant uuid := 'fb110000-0000-4000-8000-000000000007';
  unscheduled_worker constant uuid := 'fb110000-0000-4000-8000-000000000008';
  obsolete_worker constant uuid := 'fb110000-0000-4000-8000-000000000009';
  salary_legacy_punch_worker constant uuid := 'fb110000-0000-4000-8000-00000000000a';
  zero_activity_worker constant uuid := 'fb110000-0000-4000-8000-000000000010';
  location_override_worker constant uuid := 'fb110000-0000-4000-8000-00000000000c';
  same_signature_worker constant uuid := 'fb110000-0000-4000-8000-00000000000d';
  prior_revision_call_off_worker constant uuid := 'fb110000-0000-4000-8000-00000000000e';
  prior_revision_replacement_worker constant uuid := 'fb110000-0000-4000-8000-00000000000f';
  client_id constant uuid := 'fb130000-0000-4000-8000-000000000001';
  site_id constant uuid := 'fb140000-0000-4000-8000-000000000001';
  post_id constant uuid := 'fb150000-0000-4000-8000-000000000001';
  event_id constant uuid := 'fb160000-0000-4000-8000-000000000001';
  old_schedule constant uuid := 'fb170000-0000-4000-8000-000000000001';
  current_schedule constant uuid := 'fb170000-0000-4000-8000-000000000002';
  old_shift constant uuid := 'fb180000-0000-4000-8000-000000000001';
  event_shift constant uuid := 'fb180000-0000-4000-8000-000000000002';
  coverage_shift constant uuid := 'fb180000-0000-4000-8000-000000000003';
  scheduled_only_shift constant uuid := 'fb180000-0000-4000-8000-000000000004';
  open_shift constant uuid := 'fb180000-0000-4000-8000-000000000005';
  dispatch_shift constant uuid := 'fb180000-0000-4000-8000-000000000006';
  same_signature_shift constant uuid := 'fb180000-0000-4000-8000-000000000007';
  prior_revision_call_off_shift constant uuid := 'fb180000-0000-4000-8000-000000000008';
  prior_revision_replacement_shift constant uuid := 'fb180000-0000-4000-8000-000000000009';
  old_assignment constant uuid := 'fb190000-0000-4000-8000-000000000001';
  scheduled_assignment constant uuid := 'fb190000-0000-4000-8000-000000000002';
  absent_assignment constant uuid := 'fb190000-0000-4000-8000-000000000003';
  salary_assignment constant uuid := 'fb190000-0000-4000-8000-000000000004';
  replacement_assignment constant uuid := 'fb190000-0000-4000-8000-000000000005';
  scheduled_only_assignment constant uuid := 'fb190000-0000-4000-8000-000000000006';
  salary_legacy_assignment constant uuid := 'fb190000-0000-4000-8000-000000000007';
  dispatch_assignment constant uuid := 'fb190000-0000-4000-8000-000000000008';
  same_signature_assignment constant uuid := 'fb190000-0000-4000-8000-000000000009';
  prior_revision_call_off_assignment constant uuid := 'fb190000-0000-4000-8000-00000000000a';
  prior_revision_replacement_assignment constant uuid := 'fb190000-0000-4000-8000-00000000000b';
  call_off_id constant uuid := 'fba00000-0000-4000-8000-000000000001';
  prior_revision_call_off_id constant uuid := 'fba00000-0000-4000-8000-000000000002';
  coverage_case_id constant uuid := 'fba10000-0000-4000-8000-000000000001';
  salary_marker_id constant uuid := 'fba20000-0000-4000-8000-000000000001';
  salary_request_id constant uuid := 'fba30000-0000-4000-8000-000000000001';
  manual_entry_id constant uuid := 'fba40000-0000-4000-8000-000000000001';
  admin_role_id uuid;
  guard_role_id uuid;
  dispatcher_role_id uuid;
  result jsonb;
  event_result jsonb;
  note_result jsonb;
  worker_result jsonb;
  first_page jsonb;
  second_page jsonb;
  export_result jsonb;
  before_audit bigint;
  after_audit bigint;
  before_time_events bigint;
  before_presence bigint;
  denied boolean;
begin
  insert into public.employees (
    id, employee_number, username, first_name, last_name, role,
    employment_type, status, time_zone
  ) values
    (actor_employee, 'SYG-9811', 'workforceactor', 'Report', 'Administrator', 'admin', 'salary', 'active', 'America/New_York'),
    (unauthorized_employee, 'SYG-9812', 'workforceunauthorized', 'No', 'Report Access', 'guard', 'hourly', 'active', 'America/New_York'),
    (export_limited_employee, 'SYG-9821', 'workforceexportlimited', 'Page Only', 'Dispatcher', 'dispatcher', 'hourly', 'active', 'America/New_York'),
    (scheduled_worker, 'SYG-9813', 'workforcescheduled', 'Alex', 'Scheduled', 'guard', 'hourly', 'active', 'America/New_York'),
    (scheduled_only_worker, 'SYG-9814', 'workforcescheduledonly', 'Bailey', 'Scheduled Only', 'guard', 'hourly', 'active', 'America/New_York'),
    (absent_worker, 'SYG-9815', 'workforceabsent', 'Casey', 'Called Off', 'guard', 'hourly', 'active', 'America/New_York'),
    (replacement_worker, 'SYG-9816', 'workforcereplacement', 'Devon', 'Replacement', 'guard', 'hourly', 'active', 'America/New_York'),
    (salary_worker, 'SYG-9817', 'workforcesalary', 'Emery', 'Salary', 'guard', 'salary', 'active', 'America/New_York'),
    (unscheduled_worker, 'SYG-9818', 'workforceunscheduled', 'Finley', 'Unscheduled', 'guard', 'hourly', 'active', 'America/New_York'),
    (obsolete_worker, 'SYG-9819', 'workforceobsolete', 'Old', 'Revision', 'guard', 'hourly', 'active', 'America/New_York'),
    (salary_legacy_punch_worker, 'SYG-9820', 'workforcesalarylegacy', 'Gray', 'Salary Legacy', 'guard', 'salary', 'active', 'America/New_York'),
    (zero_activity_worker, 'SYG-9826', 'workforcezeroactivity', 'Kendall', 'No Activity', 'guard', 'hourly', 'active', 'America/New_York'),
    (location_override_worker, 'SYG-9822', 'workforcelocationoverride', 'Harper', 'Corrected Location', 'guard', 'hourly', 'active', 'America/New_York'),
    (same_signature_worker, 'SYG-9823', 'workforcesamesignature', 'Indigo', 'Parallel Position', 'guard', 'hourly', 'active', 'America/New_York'),
    (prior_revision_call_off_worker, 'SYG-9824', 'workforcepriorcalloff', 'Jules', 'Prior Call Off', 'guard', 'hourly', 'active', 'America/New_York'),
    (prior_revision_replacement_worker, 'SYG-9825', 'workforcepriorreplacement', 'Kai', 'Prior Replacement', 'guard', 'hourly', 'active', 'America/New_York');

  insert into auth.users(id, email)
  values
    (actor_auth, 'workforce-report-actor@example.invalid'),
    (unauthorized_auth, 'workforce-report-unauthorized@example.invalid'),
    (export_limited_auth, 'workforce-report-export-limited@example.invalid');

  insert into private.employee_accounts(employee_id, auth_user_id, activated_at)
  values
    (actor_employee, actor_auth, clock_timestamp()),
    (unauthorized_employee, unauthorized_auth, clock_timestamp()),
    (export_limited_employee, export_limited_auth, clock_timestamp());

  select role.id into admin_role_id
  from public.access_roles role where role.code = 'system_admin';
  select role.id into guard_role_id
  from public.access_roles role where role.code = 'system_guard';
  select role.id into dispatcher_role_id
  from public.access_roles role where role.code = 'system_dispatcher';
  assert admin_role_id is not null and guard_role_id is not null
    and dispatcher_role_id is not null,
    'The workforce activity regression requires the protected system roles.';

  insert into public.employee_access_roles(employee_id, role_id, assigned_by)
  values
    (actor_employee, admin_role_id, actor_employee),
    (unauthorized_employee, guard_role_id, actor_employee),
    (export_limited_employee, dispatcher_role_id, actor_employee);

  insert into public.clients (
    id, client_number, legal_name, display_name, status, time_zone,
    created_by, updated_by
  ) values (
    client_id, 'CLI-9811', 'Workforce Regression Client LLC',
    'Workforce Regression Client', 'active', 'America/New_York',
    actor_employee, actor_employee
  );

  insert into public.sites (
    id, code, name, client_id, address_line_1, city, region, postal_code,
    time_zone, supports_dispatch_phone_duty
  ) values (
    site_id, 'WF-REG', 'Workforce Regression Center', client_id,
    '100 Report Way', 'Washington', 'DC', '20001', 'America/New_York', true
  );

  insert into public.posts(id, site_id, name, requires_armed)
  values (post_id, site_id, 'Main Entrance', false);

  insert into public.events (
    id, name, site_id, client_id, time_zone, starts_at, ends_at, created_by
  ) values (
    event_id, 'Jason Crow Civic Forum', site_id, client_id, 'America/New_York',
    timestamptz '2097-04-03 00:00:00+00',
    timestamptz '2097-04-03 08:00:00+00', actor_employee
  );

  insert into public.schedules (
    id, week_starts_on, revision, status, created_by
  ) values
    (old_schedule, date '2097-04-01', 1, 'draft', actor_employee),
    (current_schedule, date '2097-04-01', 2, 'draft', actor_employee);

  insert into public.shifts (
    id, schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, notes, created_by
  ) values
    (old_shift, old_schedule, null, event_id,
      timestamptz '2097-04-02 11:00:00+00', timestamptz '2097-04-02 12:00:00+00',
      'America/New_York', 1, 'This older published revision must not appear.', actor_employee),
    (prior_revision_call_off_shift, old_schedule, post_id, null,
      timestamptz '2097-04-03 00:30:00+00', timestamptz '2097-04-03 02:30:00+00',
      'America/New_York', 1, 'Original schedule call-off evidence.', actor_employee),
    (event_shift, current_schedule, null, event_id,
      timestamptz '2097-04-03 00:00:00+00', timestamptz '2097-04-03 08:00:00+00',
      'America/New_York', 4, 'Overnight event roster.', actor_employee),
    (scheduled_only_shift, current_schedule, post_id, null,
      timestamptz '2097-04-02 13:00:00+00', timestamptz '2097-04-02 21:00:00+00',
      'America/New_York', 1, 'Crow Legacy hospitality detail; no canonical event link.', actor_employee),
    (same_signature_shift, current_schedule, post_id, null,
      timestamptz '2097-04-02 13:00:00+00', timestamptz '2097-04-02 21:00:00+00',
      'America/New_York', 1, 'Separate same-time position that must remain independently reportable.', actor_employee),
    (open_shift, current_schedule, post_id, null,
      timestamptz '2097-04-02 12:00:00+00', timestamptz '2097-04-02 16:00:00+00',
      'America/New_York', 1, 'Unfilled day position.', actor_employee),
    (dispatch_shift, current_schedule, post_id, null,
      timestamptz '2097-04-02 13:00:00+00', timestamptz '2097-04-02 21:00:00+00',
      'America/New_York', 1, 'Concurrent dispatch phone duty.', actor_employee);

  update public.shifts
  set assignment_type = 'dispatch_phone_duty'
  where id = dispatch_shift;

  insert into public.shifts (
    id, schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, coverage_source_shift_id, notes, created_by
  ) values
    (
      coverage_shift, current_schedule, null, event_id,
      timestamptz '2097-04-03 00:00:00+00', timestamptz '2097-04-03 08:00:00+00',
      'America/New_York', 1, event_shift, 'Replacement coverage block.', actor_employee
    ),
    (
      prior_revision_replacement_shift, old_schedule, post_id, null,
      timestamptz '2097-04-03 00:30:00+00', timestamptz '2097-04-03 02:30:00+00',
      'America/New_York', 1, prior_revision_call_off_shift,
      'Historical replacement coverage retained after schedule revision.', actor_employee
    );

  insert into public.shift_assignments(id, shift_id, employee_id, status, assigned_by)
  values
    (old_assignment, old_shift, obsolete_worker, 'assigned', actor_employee),
    (prior_revision_call_off_assignment, prior_revision_call_off_shift, prior_revision_call_off_worker, 'assigned', actor_employee),
    (scheduled_assignment, event_shift, scheduled_worker, 'assigned', actor_employee),
    (absent_assignment, event_shift, absent_worker, 'assigned', actor_employee),
    (salary_assignment, event_shift, salary_worker, 'assigned', actor_employee),
    (replacement_assignment, coverage_shift, replacement_worker, 'assigned', actor_employee),
    (scheduled_only_assignment, scheduled_only_shift, scheduled_only_worker, 'assigned', actor_employee),
    (salary_legacy_assignment, event_shift, salary_legacy_punch_worker, 'assigned', actor_employee),
    (dispatch_assignment, dispatch_shift, scheduled_only_worker, 'assigned', actor_employee),
    (same_signature_assignment, same_signature_shift, same_signature_worker, 'assigned', actor_employee),
    (prior_revision_replacement_assignment, prior_revision_replacement_shift, prior_revision_replacement_worker, 'assigned', actor_employee);

  update public.schedules
  set status = 'superseded'
  where id = old_schedule;

  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = actor_employee
  where id = current_schedule;

  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, reported_at, call_received_at,
    received_by, reported_by, replacement_needed
  ) values
    (
      call_off_id, event_shift, absent_worker,
      'Rollback-only workforce activity call-off fixture.',
      timestamptz '2097-04-02 20:00:00+00', timestamptz '2097-04-02 20:00:00+00',
      actor_employee, absent_worker, true
    ),
    (
      prior_revision_call_off_id, prior_revision_call_off_shift, prior_revision_call_off_worker,
      'Call-off retained after the assignment left the current published revision.',
      timestamptz '2097-04-02 21:00:00+00', timestamptz '2097-04-02 21:00:00+00',
      actor_employee, prior_revision_call_off_worker, true
    );

  insert into public.shift_coverage_cases (
    id, call_off_report_id, source_shift_id, source_assignment_id,
    coverage_shift_id, absent_employee_id, status, coverage_mode,
    replacement_employee_id, replacement_assignment_id,
    original_assignment_snapshot, last_idempotency_key, opened_by,
    resolved_by, resolved_at
  ) values (
    coverage_case_id, call_off_id, event_shift, absent_assignment,
    coverage_shift, absent_worker, 'assigned', 'assigned_guard',
    replacement_worker, replacement_assignment,
    jsonb_build_object('assignmentId', absent_assignment), gen_random_uuid(),
    actor_employee, actor_employee, clock_timestamp()
  );

  insert into public.time_events (
    id, employee_id, shift_id, kind, recorded_at, source, idempotency_key, created_by
  ) values
    ('fbb00000-0000-4000-8000-000000000001', scheduled_worker, event_shift, 'clock_in', timestamptz '2097-04-03 00:05:00+00', 'import', 'workforce-reg-scheduled-in', actor_employee),
    ('fbb00000-0000-4000-8000-000000000002', scheduled_worker, event_shift, 'break_start', timestamptz '2097-04-03 04:00:00+00', 'import', 'workforce-reg-scheduled-break-start', actor_employee),
    ('fbb00000-0000-4000-8000-000000000003', scheduled_worker, event_shift, 'break_end', timestamptz '2097-04-03 04:30:00+00', 'import', 'workforce-reg-scheduled-break-end', actor_employee),
    ('fbb00000-0000-4000-8000-000000000004', scheduled_worker, event_shift, 'clock_out', timestamptz '2097-04-03 08:00:00+00', 'import', 'workforce-reg-scheduled-out', actor_employee),
    ('fbb00000-0000-4000-8000-000000000005', replacement_worker, coverage_shift, 'clock_in', timestamptz '2097-04-03 00:00:00+00', 'import', 'workforce-reg-replacement-in', actor_employee),
    ('fbb00000-0000-4000-8000-000000000006', replacement_worker, coverage_shift, 'clock_out', timestamptz '2097-04-03 08:00:00+00', 'import', 'workforce-reg-replacement-out', actor_employee),
    ('fbb00000-0000-4000-8000-000000000007', unscheduled_worker, null, 'clock_in', timestamptz '2097-04-02 15:00:00+00', 'import', 'workforce-reg-unscheduled-in', actor_employee),
    ('fbb00000-0000-4000-8000-000000000008', unscheduled_worker, null, 'clock_out', timestamptz '2097-04-02 17:00:00+00', 'import', 'workforce-reg-unscheduled-out', actor_employee),
    ('fbb00000-0000-4000-8000-000000000009', salary_legacy_punch_worker, event_shift, 'clock_in', timestamptz '2097-04-03 00:00:00+00', 'import', 'workforce-reg-salary-legacy-in', actor_employee),
    ('fbb00000-0000-4000-8000-00000000000a', salary_legacy_punch_worker, event_shift, 'clock_out', timestamptz '2097-04-03 08:00:00+00', 'import', 'workforce-reg-salary-legacy-out', actor_employee),
    ('fbb00000-0000-4000-8000-00000000000b', location_override_worker, null, 'clock_in', timestamptz '2097-04-03 04:30:00+00', 'import', 'workforce-reg-location-in', actor_employee),
    ('fbb00000-0000-4000-8000-00000000000c', location_override_worker, null, 'clock_out', timestamptz '2097-04-03 05:30:00+00', 'import', 'workforce-reg-location-out', actor_employee),
    ('fbb00000-0000-4000-8000-00000000000d', prior_revision_replacement_worker, prior_revision_replacement_shift, 'clock_in', timestamptz '2097-04-03 00:30:00+00', 'import', 'workforce-reg-prior-replacement-in', actor_employee),
    ('fbb00000-0000-4000-8000-00000000000e', prior_revision_replacement_worker, prior_revision_replacement_shift, 'clock_out', timestamptz '2097-04-03 02:30:00+00', 'import', 'workforce-reg-prior-replacement-out', actor_employee);

  insert into public.manual_time_entries (
    id, employee_id, shift_id, post_id, clock_in_event_id, clock_out_event_id,
    work_date, clock_in_at, clock_out_at, reason, notes, approval_status,
    entry_source, created_by
  ) values (
    manual_entry_id, unscheduled_worker, null, post_id,
    'fbb00000-0000-4000-8000-000000000007',
    'fbb00000-0000-4000-8000-000000000008',
    date '2097-04-02', timestamptz '2097-04-02 15:00:00+00',
    timestamptz '2097-04-02 17:00:00+00',
    'Approved missing-shift entry at the assigned post.',
    'Manual entry location must survive into workforce activity.',
    'approved', 'operations', actor_employee
  );

  insert into public.time_event_location_overrides (
    id, time_event_id, location_name, time_zone, reason, created_by
  ) values (
    'fba50000-0000-4000-8000-000000000001',
    'fbb00000-0000-4000-8000-00000000000b',
    'Corrected Remote Venue', 'America/Chicago',
    'Approved correction for a shiftless historical occurrence.', actor_employee
  );

  insert into private.salaried_shift_presence_events (
    id, shift_assignment_id, employee_id, action, note,
    actor_employee_id, request_id, result_action
  ) values (
    salary_marker_id, salary_assignment, salary_worker, 'worked',
    'Confirmed as a whole salaried shift; minutes intentionally remain unknown.',
    actor_employee, salary_request_id, 'recorded'
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', actor_auth::text, true);

  select count(*) into before_audit from private.audit_events;
  select count(*) into before_time_events from public.time_events;
  select count(*) into before_presence from private.salaried_shift_presence_events;

  worker_result := public.get_workforce_activity_report_employee_options();
  assert exists (
    select 1
    from jsonb_array_elements(worker_result) option
    where option ->> 'id' = zero_activity_worker::text
      and option ->> 'label' = 'Kendall No Activity'
      and option ->> 'employeeNumber' = 'SYG-9826'
  ), 'An active employee without a worked row was missing from the independent report picker.';

  worker_result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'worked', 'employee',
    zero_activity_worker, null, null, null, null, null, 1, 50
  );
  assert (worker_result ->> 'totalCount')::integer = 0,
    'The selected zero-activity employee incorrectly appeared in Who Worked.';

  result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'all', 'day',
    null, client_id, null, null, null, null, 1, 200
  );

  assert result ->> 'reportKey' = 'workforceActivity',
    'The workforce activity report returned the wrong contract key.';
  assert result ->> 'groupBy' = 'day' and result ->> 'view' = 'all',
    'The requested report view and grouping were not preserved.';
  assert not exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where jsonb_typeof(row -> 'payrollReady') <> 'boolean'
      or jsonb_typeof(row -> 'notes') <> 'array'
  ), 'Every row must expose concrete payrollReady and notes contract types.';
  assert not exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = obsolete_worker::text
  ), 'An assignment removed from the latest published revision leaked into the report.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = scheduled_worker::text
      and row ->> 'eventId' = event_id::text
      and row ->> 'eventName' = 'Jason Crow Civic Forum'
      and row ->> 'outcome' = 'worked_as_scheduled'
      and row ->> 'operationalDate' = '2097-04-02'
      and (row ->> 'unpaidBreakMinutes')::integer = 30
  ), 'The overnight Jason-style event roster did not include the scheduled worker and actual break.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = scheduled_only_worker::text
      and row ->> 'outcome' = 'scheduled_no_work_record'
  ), 'A scheduled-only worker was omitted.';
  assert (
    select count(distinct row ->> 'shiftId')
    from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' in (scheduled_only_worker::text, same_signature_worker::text)
      and row ->> 'outcome' = 'scheduled_no_work_record'
  ) = 2, 'Separate same-signature shift positions in one published schedule were collapsed.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = same_signature_worker::text
      and row ->> 'shiftId' = same_signature_shift::text
      and (row ->> 'scheduledMinutes')::integer = 480
  ), 'The second same-signature employee and staffing requirement were omitted.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = absent_worker::text
      and row ->> 'outcome' = 'called_off'
  ), 'The original called-off employee was omitted.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = prior_revision_call_off_worker::text
      and row ->> 'shiftId' = prior_revision_call_off_shift::text
      and row ->> 'outcome' = 'called_off'
      and row ->> 'operationalDate' = '2097-04-02'
      and row -> 'actualStartAt' = 'null'::jsonb
      and row -> 'workedMinutes' = 'null'::jsonb
  ), 'A prior-revision call-off was not retained on the source shift local operational date.';
  assert (
    select count(*)
    from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = prior_revision_call_off_worker::text
      and row ->> 'outcome' = 'called_off'
  ) = 1, 'A retained prior-revision call-off appeared more than once.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = replacement_worker::text
      and row ->> 'outcome' = 'replacement_worked'
      and (row ->> 'workedMinutes')::integer = 480
  ), 'The replacement worker was not attributed to the coverage occurrence.';
  assert (
    select count(*)
    from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = prior_revision_replacement_worker::text
      and row ->> 'shiftId' = prior_revision_replacement_shift::text
      and row ->> 'outcome' = 'replacement_worked'
      and row ->> 'operationalDate' = '2097-04-02'
      and (row ->> 'workedMinutes')::integer = 120
  ) = 1, 'Historical replacement work lost its immutable coverage classification or appeared more than once.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = salary_worker::text
      and row ->> 'outcome' = 'salary_worked_confirmed'
      and row -> 'workedMinutes' = 'null'::jsonb
      and row -> 'actualStartAt' = 'null'::jsonb
  ), 'A salaried Worked marker must be visible without invented minutes or timestamps.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'employeeId' = salary_legacy_punch_worker::text
      and row ->> 'outcome' = 'scheduled_no_work_record'
      and row -> 'workedMinutes' = 'null'::jsonb
      and row -> 'actualStartAt' = 'null'::jsonb
      and row -> 'actualEndAt' = 'null'::jsonb
  ), 'Legacy salary punches must not become attendance or invented salary minutes.';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'outcome' = 'open_unassigned'
  ), 'An unassigned required position was omitted.';
  assert not exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'shiftId' = dispatch_shift::text
  ), 'Concurrent dispatch phone duty created a false separate activity row.';

  worker_result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'worked', 'employee',
    salary_legacy_punch_worker, null, null, null, null, null, 1, 50
  );
  assert (worker_result ->> 'totalCount')::integer = 0,
    'Legacy salary punches incorrectly placed the employee in Who Worked.';

  worker_result := public.get_workforce_activity_report_page(
    date '2097-04-03', date '2097-04-03', 'all', 'employee',
    prior_revision_call_off_worker, null, null, null, null, null, 1, 50
  );
  assert (worker_result ->> 'totalCount')::integer = 0,
    'A retained call-off was scoped by its UTC date instead of the source shift local operational date.';

  worker_result := public.get_workforce_activity_report_page(
    date '2097-04-03', date '2097-04-03', 'worked', 'employee',
    prior_revision_replacement_worker, null, null, null, null, null, 1, 50
  );
  assert (worker_result ->> 'totalCount')::integer = 0,
    'Historical replacement work was scoped by its UTC date instead of the source shift local operational date.';

  worker_result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'worked', 'employee',
    unscheduled_worker, null, null, null, null, null, 1, 50
  );
  assert jsonb_array_length(worker_result -> 'rows') = 1
    and worker_result #>> '{rows,0,outcome}' = 'worked_not_scheduled'
    and (worker_result #>> '{rows,0,workedMinutes}')::integer = 120
    and worker_result #>> '{rows,0,siteId}' = site_id::text
    and worker_result #>> '{rows,0,postId}' = post_id::text
    and worker_result #>> '{rows,0,locationLabel}' = 'Workforce Regression Center',
    'A shiftless manual entry did not retain its approved site/post attribution.';

  worker_result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'worked', 'employee',
    location_override_worker, null, null, null, null, null, 1, 50
  );
  assert jsonb_array_length(worker_result -> 'rows') = 1
    and worker_result #>> '{rows,0,operationalDate}' = '2097-04-02'
    and worker_result #>> '{rows,0,locationLabel}' = 'Corrected Remote Venue'
    and worker_result #>> '{rows,0,timeZone}' = 'America/Chicago',
    'A location-only correction did not retain its corrected label, timezone, and operational date.';

  event_result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'all', 'location',
    null, null, null, event_id, null, 'Jason Crow', 1, 50
  );
  assert (event_result ->> 'totalCount')::integer = 5,
    'The event/search filter did not return the exact current event roster.';

  note_result := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'all', 'day',
    null, null, null, null, null, 'Crow Legacy', 1, 50
  );
  assert jsonb_array_length(note_result -> 'rows') = 1
    and note_result #>> '{rows,0,employeeId}' = scheduled_only_worker::text
    and note_result #> '{rows,0,eventId}' = 'null'::jsonb,
    'Free-form shift-note search must find legacy context without inventing an event relationship.';

  first_page := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'all', 'day',
    null, client_id, null, null, null, null, 1, 2
  );
  second_page := public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02', 'all', 'day',
    null, client_id, null, null, null, null, 2, 2
  );
  assert (first_page ->> 'pageSize')::integer = 2
    and (first_page ->> 'totalPages')::integer >= 2
    and jsonb_array_length(first_page -> 'rows') = 2,
    'First-page metadata or row count is incorrect.';
  assert not exists (
    select 1
    from jsonb_array_elements(first_page -> 'rows') first_row
    join jsonb_array_elements(second_page -> 'rows') second_row
      on second_row ->> 'id' = first_row ->> 'id'
  ), 'Adjacent report pages overlapped.';

  assert (select count(*) from private.audit_events) = before_audit,
    'Reading the report unexpectedly wrote an audit record.';
  assert (select count(*) from public.time_events) = before_time_events,
    'Reading the report mutated source time events.';
  assert (select count(*) from private.salaried_shift_presence_events) = before_presence,
    'Reading the report mutated salaried Worked markers.';

  select count(*) into before_audit
  from private.audit_events audit
  where audit.table_name = 'workforce_activity_report' and audit.operation = 'EXPORT';

  export_result := public.export_workforce_activity_report(
    date '2097-04-02', date '2097-04-02', 'all', 'day',
    null, client_id, null, null, null, null
  );

  select count(*) into after_audit
  from private.audit_events audit
  where audit.table_name = 'workforce_activity_report' and audit.operation = 'EXPORT';
  assert export_result ->> 'mode' = 'export'
    and export_result ->> 'exportId' is not null
    and after_audit = before_audit + 1,
    'A protected export must return an ID and append exactly one audit event.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', export_limited_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', export_limited_auth::text, true);
  perform public.get_workforce_activity_report_page(
    date '2097-04-02', date '2097-04-02'
  );
  perform public.get_workforce_activity_report_employee_options();
  denied := false;
  begin
    perform public.export_workforce_activity_report(
      date '2097-04-02', date '2097-04-02'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied,
    'A page-authorized employee without reports.export performed an export.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  denied := false;
  begin
    perform public.get_workforce_activity_report_page(
      date '2097-04-02', date '2097-04-02'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'The report opened without MFA.';

  denied := false;
  begin
    perform public.get_workforce_activity_report_employee_options();
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'The employee picker opened without MFA.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', unauthorized_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', unauthorized_auth::text, true);
  denied := false;
  begin
    perform public.get_workforce_activity_report_page(
      date '2097-04-02', date '2097-04-02'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'An employee without time.reports.view opened the team report.';

  denied := false;
  begin
    perform public.get_workforce_activity_report_employee_options();
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'An employee without time.reports.view loaded the team report employee picker.';
end
$workforce_activity_regression$;

rollback;

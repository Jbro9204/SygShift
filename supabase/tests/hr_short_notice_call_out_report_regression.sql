-- Run only after 20260921193740 inside this outer BEGIN / ROLLBACK transaction.
-- The fixtures, generated notifications, and export audit are never committed.

begin;

do $$
declare
  hr_employee_id uuid;
  hr_auth_user_id uuid;
  non_hr_employee_id uuid;
  non_hr_auth_user_id uuid;
  fixture_employee_number text;
  fixture_employee_id constant uuid := '9a010000-0000-4000-8000-000000000001';
  fixture_site_id constant uuid := '9a020000-0000-4000-8000-000000000001';
  fixture_post_id constant uuid := '9a030000-0000-4000-8000-000000000001';
  fixture_schedule_id constant uuid := '9a040000-0000-4000-8000-000000000001';
  included_shift_id constant uuid := '9a050000-0000-4000-8000-000000000001';
  boundary_shift_id constant uuid := '9a050000-0000-4000-8000-000000000002';
  after_start_shift_id constant uuid := '9a050000-0000-4000-8000-000000000003';
  included_report_id constant uuid := '9a060000-0000-4000-8000-000000000001';
  boundary_report_id constant uuid := '9a060000-0000-4000-8000-000000000002';
  after_start_report_id constant uuid := '9a060000-0000-4000-8000-000000000003';
  result jsonb;
  export_audit_before bigint;
  export_audit_after bigint;
  denied boolean := false;
begin
  select employee.id, account.auth_user_id
  into hr_employee_id, hr_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and 'hr.reporting.view' = any(private.employee_effective_permissions(employee.id))
    and 'hr.reporting.export' = any(private.employee_effective_permissions(employee.id))
  order by employee.id
  limit 1;

  select employee.id, account.auth_user_id
  into non_hr_employee_id, non_hr_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and not ('hr.reporting.view' = any(private.employee_effective_permissions(employee.id)))
  order by employee.id
  limit 1;

  assert hr_auth_user_id is not null,
    'An active employee with HR reporting view and export permissions is required';
  assert non_hr_auth_user_id is not null,
    'An active employee without HR reporting permission is required';

  select 'SYG-' || candidate.number::text
  into fixture_employee_number
  from generate_series(9000, 9999) candidate(number)
  where not exists (
    select 1 from public.employees employee
    where employee.employee_number = 'SYG-' || candidate.number::text
  )
  order by candidate.number
  limit 1;

  assert fixture_employee_number is not null,
    'An unused rollback-only SYG employee number is required';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', hr_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  insert into public.employees (
    id, employee_number, username, first_name, last_name, role, employment_type, status
  ) values (
    fixture_employee_id, fixture_employee_number, 'shortnoticeregression',
    'Short Notice', 'Regression', 'guard', 'hourly', 'active'
  );

  insert into public.sites (id, code, name, time_zone)
  values (fixture_site_id, 'SHORT-NOTICE-REG', 'Short Notice Regression Site', 'America/Denver');

  insert into public.posts (id, site_id, name, requires_armed)
  values (fixture_post_id, fixture_site_id, 'Short Notice Regression Post', false);

  insert into public.schedules (id, week_starts_on, revision, status, created_by)
  values (fixture_schedule_id, date '2099-12-13', 97, 'draft', hr_employee_id);

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone, headcount_required, created_by
  ) values
    (included_shift_id, fixture_schedule_id, fixture_post_id, timestamptz '2099-12-14 16:00:00+00', timestamptz '2099-12-15 00:00:00+00', 'America/Denver', 1, hr_employee_id),
    (boundary_shift_id, fixture_schedule_id, fixture_post_id, timestamptz '2099-12-15 16:00:00+00', timestamptz '2099-12-16 00:00:00+00', 'America/Denver', 1, hr_employee_id),
    (after_start_shift_id, fixture_schedule_id, fixture_post_id, timestamptz '2099-12-16 16:00:00+00', timestamptz '2099-12-17 00:00:00+00', 'America/Denver', 1, hr_employee_id);

  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, reported_at, call_received_at,
    received_by, reported_by, call_off_type, replacement_needed, operational_details
  ) values
    (included_report_id, included_shift_id, fixture_employee_id, '239-minute regression event', timestamptz '2099-12-14 12:01:00+00', timestamptz '2099-12-14 12:01:00+00', hr_employee_id, fixture_employee_id, 'other', true, 'Must be included.'),
    (boundary_report_id, boundary_shift_id, fixture_employee_id, '240-minute compliant boundary', timestamptz '2099-12-15 12:00:00+00', timestamptz '2099-12-15 12:00:00+00', hr_employee_id, fixture_employee_id, 'other', true, 'Must be excluded.'),
    (after_start_report_id, after_start_shift_id, fixture_employee_id, 'No-call no-show regression event', timestamptz '2099-12-16 16:15:00+00', timestamptz '2099-12-16 16:15:00+00', hr_employee_id, fixture_employee_id, 'other', true, 'Must be severe and included.');

  insert into public.attendance_accountability_events (
    employee_id, shift_id, call_off_report_id, event_type, status, operational_date,
    starts_at, ends_at, source, note, created_by, review_outcome, reviewed_by,
    reviewed_at, decision_note
  ) values (
    fixture_employee_id, after_start_shift_id, after_start_report_id,
    'no_call_no_show', 'resolved', date '2099-12-16',
    timestamptz '2099-12-16 16:00:00+00', timestamptz '2099-12-17 00:00:00+00',
    'admin', 'Rollback-only short-notice regression.', hr_employee_id,
    'unexcused', hr_employee_id, clock_timestamp(), 'Regression review decision.'
  );

  result := public.get_hr_short_notice_call_out_report(
    date '2099-12-14', date '2099-12-16', false
  );

  assert (result #>> '{summary,shortNoticeCount}')::integer = 2,
    'Only the 239-minute and after-start records should be returned';
  assert (result #>> '{summary,afterStartCount}')::integer = 1,
    'The after-start occurrence was not counted';
  assert (result #>> '{summary,noShowCount}')::integer = 1,
    'The no-call/no-show occurrence was not classified';
  assert jsonb_array_length(result -> 'rows') = 2,
    'Short-notice detail count did not match the summary';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'id' = included_report_id::text
      and (row ->> 'noticeMinutes')::integer = 239
  ), 'The 239-minute event was not included';
  assert not exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'id' = boundary_report_id::text
  ), 'Exactly four hours must remain compliant and excluded';
  assert exists (
    select 1 from jsonb_array_elements(result -> 'rows') row
    where row ->> 'id' = after_start_report_id::text
      and row ->> 'occurrenceType' = 'no_call_no_show'
      and row ->> 'reviewOutcome' = 'unexcused'
  ), 'The severe no-call/no-show detail was incomplete';

  select count(*) into export_audit_before
  from private.audit_events audit
  where audit.row_id = 'hr-short-notice-call-outs'
    and audit.operation = 'EXPORT';

  perform public.get_hr_short_notice_call_out_report(
    date '2099-12-14', date '2099-12-16', true
  );

  select count(*) into export_audit_after
  from private.audit_events audit
  where audit.row_id = 'hr-short-notice-call-outs'
    and audit.operation = 'EXPORT';

  assert export_audit_after = export_audit_before + 1,
    'A protected report export must append one audit record';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', non_hr_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  begin
    perform public.get_hr_short_notice_call_out_report(
      date '2099-12-14', date '2099-12-16', false
    );
  exception when insufficient_privilege then
    denied := true;
  end;

  assert denied, 'A non-HR employee was able to open the protected HR report';
end
$$;

rollback;

begin;

do $time_off_v2$
declare
  scheduler_employee constant uuid := 'f9210000-0000-4000-8000-000000000001';
  scheduler_auth constant uuid := 'f9220000-0000-4000-8000-000000000001';
  employee_id constant uuid := 'f9210000-0000-4000-8000-000000000002';
  employee_auth constant uuid := 'f9220000-0000-4000-8000-000000000002';
  site_id constant uuid := 'f9230000-0000-4000-8000-000000000001';
  post_id constant uuid := 'f9240000-0000-4000-8000-000000000001';
  published_schedule_id constant uuid := 'f9250000-0000-4000-8000-000000000001';
  draft_schedule_id constant uuid := 'f9250000-0000-4000-8000-000000000002';
  superseded_schedule_id constant uuid := 'f9250000-0000-4000-8000-000000000003';
  evening_shift_id constant uuid := 'f9260000-0000-4000-8000-000000000001';
  overnight_shift_id constant uuid := 'f9260000-0000-4000-8000-000000000002';
  draft_shift_id constant uuid := 'f9260000-0000-4000-8000-000000000003';
  superseded_shift_id constant uuid := 'f9260000-0000-4000-8000-000000000004';
  morning_request_id uuid;
  evening_request_id uuid;
  overnight_request_id uuid;
  approved_before_assignment_id uuid;
  adjacent_request_one_id uuid;
  adjacent_request_two_id uuid;
  superseded_request_id uuid;
  mfa_request_id uuid;
  self_request_id uuid;
  spring_transition date;
  fall_transition date;
  context_payload jsonb;
  review_payload jsonb;
  error_message text;
  function_definition text;
  baseline_time_off_count integer;
begin
  insert into public.employees (
    id, employee_number, username, first_name, last_name, role,
    employment_type, status, time_zone
  ) values
    (scheduler_employee, 'SYG-9811', 'tov2scheduler', 'Interval', 'Scheduler', 'scheduler', 'salary', 'active', 'America/New_York'),
    (employee_id, 'SYG-9812', 'tov2employee', 'Interval', 'Employee', 'guard', 'hourly', 'active', 'America/New_York');

  insert into auth.users(id, email)
  values
    (scheduler_auth, 'time-off-v2-scheduler@example.invalid'),
    (employee_auth, 'time-off-v2-employee@example.invalid');
  insert into private.employee_accounts(employee_id, auth_user_id, activated_at)
  values
    (scheduler_employee, scheduler_auth, clock_timestamp()),
    (employee_id, employee_auth, clock_timestamp());

  insert into public.sites(id, code, name, time_zone)
  values(site_id, 'TO-V2', 'Time-off Interval Site', 'America/New_York');
  insert into public.posts(id, site_id, name)
  values(post_id, site_id, 'Time-off Interval Post');
  insert into public.schedules(id, week_starts_on, revision, status, created_by)
  values
    (published_schedule_id, date '2099-12-13', 1, 'draft', scheduler_employee),
    (draft_schedule_id, date '2099-12-20', 1, 'draft', scheduler_employee),
    (superseded_schedule_id, date '2099-10-25', 1, 'draft', scheduler_employee);

  -- Employee-local shift times:
  -- evening: 12/15 18:00-22:00; overnight: 12/19 22:00-12/20 06:00;
  -- draft: 12/25 14:00-16:00.
  insert into public.shifts(
    id, schedule_id, post_id, starts_at, ends_at, time_zone, headcount_required, created_by
  ) values
    (evening_shift_id, published_schedule_id, post_id, timestamptz '2099-12-15 23:00:00+00', timestamptz '2099-12-16 03:00:00+00', 'America/New_York', 1, scheduler_employee),
    (overnight_shift_id, published_schedule_id, post_id, timestamptz '2099-12-20 03:00:00+00', timestamptz '2099-12-20 11:00:00+00', 'America/New_York', 1, scheduler_employee),
    (draft_shift_id, draft_schedule_id, post_id, timestamptz '2099-12-25 19:00:00+00', timestamptz '2099-12-25 21:00:00+00', 'America/New_York', 1, scheduler_employee),
    (superseded_shift_id, superseded_schedule_id, post_id, timestamptz '2099-10-27 14:00:00+00', timestamptz '2099-10-27 22:00:00+00', 'America/New_York', 1, scheduler_employee);
  insert into public.shift_assignments(shift_id, employee_id, status, assigned_by)
  values
    (evening_shift_id, employee_id, 'assigned', scheduler_employee),
    (overnight_shift_id, employee_id, 'confirmed', scheduler_employee),
    (superseded_shift_id, employee_id, 'assigned', scheduler_employee);

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = scheduler_employee
  where id = published_schedule_id;

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = scheduler_employee
  where id = superseded_schedule_id;
  update public.schedules
  set status = 'superseded'
  where id = superseded_schedule_id;

  select count(*)::integer into baseline_time_off_count
  from public.time_off_requests;

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  begin
    perform public.submit_time_off_request_v2(
      'paid_vacation', date '2099-10-01', date '2099-10-01',
      time '09:00', time '10:00', date '2099-10-02', 'Hourly eligibility denial.'
    );
    raise exception 'Hourly employee submitted salary-only Paid Vacation.';
  exception
    when insufficient_privilege then null;
  end;

  context_payload := public.get_time_off_request_context_v2(
    date '2099-12-15', date '2099-12-15', time '09:00', time '12:00'
  );
  assert context_payload #>> '{employee,timeZone}' = 'America/New_York',
    'Request context states the employee-local time-zone basis.';
  assert jsonb_array_length(context_payload -> 'affectedShifts') = 0,
    'Morning partial preview excludes an evening shift on the same date.';
  assert (context_payload ->> 'requestedMinutes')::integer = 180,
    'Partial preview returns the authoritative employee-zone duration.';

  context_payload := public.get_time_off_request_context_v2(
    date '2099-12-15', date '2099-12-15', time '17:00', time '19:00'
  );
  assert jsonb_array_length(context_payload -> 'affectedShifts') = 1
    and (context_payload #>> '{affectedShifts,0,estimatedMinutes}')::integer = 60
    and (context_payload ->> 'requestedMinutes')::integer = 120,
    'Partial preview reports only the true one-hour shift intersection.';

  morning_request_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-15', date '2099-12-15',
    time '09:00', time '12:00', date '2099-12-16', 'Morning appointment.'
  );
  assert (
    select jsonb_array_length(request.affected_shifts_snapshot) = 0
      and request.requested_minutes = 180
      and request.submission_snapshot ->> 'timeZone' = 'America/New_York'
      and request.submission_snapshot ? 'requestWindowStartsAt'
      and request.submission_snapshot ? 'requestWindowEndsAt'
    from public.time_off_requests request
    where request.id = morning_request_id
  ), 'Submission snapshots the employee zone/window and excludes a non-overlapping shift.';

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform public.decide_time_off_request_v2(
    morning_request_id,
    'approved',
    'Approved because the assigned evening shift does not overlap.'
  );
  assert (
    select request.status = 'approved'
      and request.decision_note = 'Approved because the assigned evening shift does not overlap.'
      and request.decision_snapshot ->> 'timeZone' = 'America/New_York'
    from public.time_off_requests request
    where request.id = morning_request_id
  ), 'A valid note approves a truly non-overlapping partial-day request.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = morning_request_id
      and notification.recipient_employee_id = scheduler_employee
      and notification.resolved_at is not null
      and notification.action_path = concat('/time-off?tab=time-off&request=', morning_request_id)
  ), 'Approval resolves the reviewer action without losing its canonical deep link.';
  assert (
    select count(*) = 1
    from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = morning_request_id
      and notification.recipient_employee_id = employee_id
      and notification.title = 'Time request updated'
  ), 'Approval produces one employee lifecycle notification.';
  assert (
    select count(*) = 1
    from private.notification_outbox outbox
    where outbox.idempotency_key = concat('time_off_decision:', morning_request_id, ':approved')
  ), 'Approval produces one idempotent outbound decision event.';

  begin
    perform public.decide_time_off_request_v2(
      morning_request_id,
      'approved',
      'A second valid note must not duplicate the decision.'
    );
    raise exception 'A decided request was approved twice.';
  exception
    when check_violation then null;
  end;
  assert (
    select count(*) = 1
    from private.notification_outbox outbox
    where outbox.idempotency_key = concat('time_off_decision:', morning_request_id, ':approved')
  ), 'A retry cannot duplicate the outbound decision event.';

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  superseded_request_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-10-27', date '2099-10-27',
    time '11:00', time '12:00', date '2099-10-28', 'Superseded revision exclusion.'
  );
  assert (
    select jsonb_array_length(request.affected_shifts_snapshot) = 0
    from public.time_off_requests request
    where request.id = superseded_request_id
  ), 'A superseded schedule revision is not an affected active shift.';

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform public.decide_time_off_request_v2(
    superseded_request_id,
    'approved',
    'Superseded schedule assignments are not active conflicts.'
  );
  assert (
    select request.status = 'approved'
    from public.time_off_requests request
    where request.id = superseded_request_id
  ), 'Superseded revision assignments do not block approval.';

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  evening_request_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-15', date '2099-12-15',
    time '17:00', time '19:00', date '2099-12-16', 'Evening overlap check.'
  );
  assert (
    select jsonb_array_length(request.affected_shifts_snapshot) = 1
      and (request.affected_shifts_snapshot #>> '{0,shiftId}')::uuid = evening_shift_id
      and (request.affected_shifts_snapshot #>> '{0,estimatedMinutes}')::integer = 60
    from public.time_off_requests request
    where request.id = evening_request_id
  ), 'Submission records only the overlapping hour of the evening shift.';

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  review_payload := public.get_time_off_review_context(evening_request_id);
  assert review_payload #>> '{employee,timeZone}' = 'America/New_York',
    'Review context states the submitted employee-local time zone.';
  begin
    perform public.decide_time_off_request_v2(
      evening_request_id,
      'approved',
      'Valid regression note for the active-shift conflict.'
    );
    raise exception 'An overlapping active shift was approved.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Resolve assigned shifts before approving this time off.' then
        raise exception 'Unexpected active-shift approval denial: %', error_message;
      end if;
  end;
  assert (
    select request.status = 'pending'
    from public.time_off_requests request
    where request.id = evening_request_id
  ), 'Rejected approval preserves the pending request and history.';

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  overnight_request_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-20', date '2099-12-20',
    time '05:00', time '07:00', date '2099-12-21', 'Overnight shift overlap check.'
  );
  assert (
    select jsonb_array_length(request.affected_shifts_snapshot) = 1
      and (request.affected_shifts_snapshot #>> '{0,shiftId}')::uuid = overnight_shift_id
      and (request.affected_shifts_snapshot #>> '{0,estimatedMinutes}')::integer = 60
    from public.time_off_requests request
    where request.id = overnight_request_id
  ), 'A request catches the prior-day shift that continues into its morning.';

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  begin
    perform public.decide_time_off_request_v2(
      overnight_request_id,
      'approved',
      'Valid regression note for the overnight assignment conflict.'
    );
    raise exception 'An overnight active shift was approved.';
  exception
    when check_violation then null;
  end;

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  approved_before_assignment_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-25', date '2099-12-25',
    time '13:00', time '15:00', date '2099-12-26', 'Approve before assignment race fixture.'
  );

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform public.decide_time_off_request_v2(
    approved_before_assignment_id,
    'approved',
    'Approved before a scheduler attempted the conflicting assignment.'
  );
  begin
    insert into public.shift_assignments(shift_id, employee_id, status, assigned_by)
    values(draft_shift_id, employee_id, 'assigned', scheduler_employee);
    raise exception 'A shift assignment overlapping approved time off was accepted.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'The employee has approved time off during this shift.' then
        raise exception 'Unexpected assignment denial: %', error_message;
      end if;
  end;

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  adjacent_request_one_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-28', date '2099-12-28',
    time '09:00', time '11:00', date '2099-12-29', 'First adjacent interval.'
  );
  adjacent_request_two_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-28', date '2099-12-28',
    time '11:00', time '13:00', date '2099-12-29', 'Second adjacent interval.'
  );
  assert adjacent_request_one_id is not null and adjacent_request_two_id is not null,
    'Exact half-open adjacency is accepted.';
  begin
    perform public.submit_time_off_request_v2(
      'unpaid_time_off', date '2099-12-28', date '2099-12-28',
      time '10:00', time '12:00', date '2099-12-29', 'True overlap must fail.'
    );
    raise exception 'A truly overlapping partial-day request was accepted.';
  exception
    when unique_violation then null;
  end;

  perform public.withdraw_time_off_request(adjacent_request_two_id);
  assert (
    select request.status = 'withdrawn'
      and request.decision_snapshot ->> 'action' = 'withdrawn'
    from public.time_off_requests request
    where request.id = adjacent_request_two_id
  ), 'Owner withdrawal retains the request as immutable history.';
  assert exists (
    select 1
    from private.audit_events audit
    where audit.table_name = 'time_off_requests'
      and audit.row_id = adjacent_request_two_id::text
      and audit.operation = 'EMPLOYEE_WITHDRAW'
  ), 'Withdrawal is audited.';
  begin
    perform public.withdraw_time_off_request(adjacent_request_two_id);
    raise exception 'A completed withdrawal was repeated.';
  exception
    when check_violation then null;
  end;
  begin
    perform public.withdraw_time_off_request(morning_request_id);
    raise exception 'An approved request was withdrawn through the pending-only endpoint.';
  exception
    when check_violation then null;
  end;

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  begin
    perform public.withdraw_time_off_request(adjacent_request_one_id);
    raise exception 'Another employee withdrew a request they do not own.';
  exception
    when check_violation then null;
  end;

  perform set_config('request.jwt.claim.sub', employee_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', employee_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  spring_transition := make_date(extract(year from current_date)::integer + 1, 3, 8)
    + ((7 - extract(dow from make_date(extract(year from current_date)::integer + 1, 3, 8))::integer) % 7);
  fall_transition := make_date(extract(year from current_date)::integer + 1, 11, 1)
    + ((7 - extract(dow from make_date(extract(year from current_date)::integer + 1, 11, 1))::integer) % 7);

  begin
    perform public.submit_time_off_request_v2(
      'unpaid_time_off', spring_transition, spring_transition,
      time '02:15', time '03:15', spring_transition + 1, 'DST gap rejection.'
    );
    raise exception 'A nonexistent DST spring-forward time was accepted.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose a partial-day time outside the daylight-saving clock change.' then
        raise exception 'Unexpected DST-gap denial: %', error_message;
      end if;
  end;
  begin
    perform public.submit_time_off_request_v2(
      'unpaid_time_off', fall_transition, fall_transition,
      time '01:15', time '02:15', fall_transition + 1, 'DST fold rejection.'
    );
    raise exception 'An ambiguous DST fall-back time was accepted.';
  exception
    when check_violation then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Choose a partial-day time outside the daylight-saving clock change.' then
        raise exception 'Unexpected DST-fold denial: %', error_message;
      end if;
  end;

  mfa_request_id := public.submit_time_off_request_v2(
    'unpaid_time_off', date '2099-12-30', date '2099-12-30',
    time '09:00', time '10:00', date '2099-12-31', 'MFA decision fixture.'
  );
  begin
    perform public.decide_time_off_request_v2(
      mfa_request_id,
      'approved',
      'An unauthorized employee cannot approve this request.'
    );
    raise exception 'Unauthorized employee approved time off.';
  exception
    when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claim.sub', scheduler_auth::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  begin
    perform public.decide_time_off_request_v2(
      mfa_request_id,
      'approved',
      'A valid note does not replace the MFA requirement.'
    );
    raise exception 'AAL1 manager approved time off.';
  exception
    when insufficient_privilege then null;
  end;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', scheduler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform public.decide_time_off_request_v2(
    mfa_request_id,
    'approved',
    'AAL2 independent approval with a valid note.'
  );

  self_request_id := public.submit_time_off_request_v2(
    'paid_vacation', date '2099-11-01', date '2099-11-01',
    time '09:00', time '12:00', date '2099-11-02', 'Independent review fixture.'
  );
  assert (
    select request.request_type = 'paid_vacation'
      and request.employment_type_snapshot = 'salary'
      and request.pay_treatment = 'salary_paid_leave'
    from public.time_off_requests request
    where request.id = self_request_id
  ), 'Salary employee receives the explicit Paid Vacation treatment snapshot.';
  begin
    perform public.decide_time_off_request_v2(
      self_request_id,
      'approved',
      'A valid note cannot authorize a self-approval.'
    );
    raise exception 'A manager approved their own time off.';
  exception
    when insufficient_privilege then
      get stacked diagnostics error_message = message_text;
      if error_message <> 'Another authorized reviewer must decide your time-off request.' then
        raise exception 'Unexpected self-review denial: %', error_message;
      end if;
  end;
  assert (
    select request.status = 'pending'
    from public.time_off_requests request
    where request.id = self_request_id
  ), 'Self-review denial preserves the pending request.';
  assert not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = self_request_id
      and notification.recipient_employee_id = scheduler_employee
      and notification.action_required
  ), 'Requester is excluded from their own review action.';

  select pg_get_functiondef('public.submit_time_off_request_v2(text,date,date,time without time zone,time without time zone,date,text)'::regprocedure)
  into function_definition;
  assert position('private.lock_employee_schedule_time_off' in function_definition) > 0,
    'Submission participates in the employee schedule/time-off lock.';
  select pg_get_functiondef('public.decide_time_off_request_v2(uuid,public.request_status,text)'::regprocedure)
  into function_definition;
  assert position('private.lock_employee_schedule_time_off' in function_definition) > 0,
    'Decision participates in the employee schedule/time-off lock.';
  select pg_get_functiondef('private.enforce_assignment_capacity_and_overlap()'::regprocedure)
  into function_definition;
  assert position('private.lock_employee_schedule_time_off' in function_definition) > 0,
    'Assignment enforcement participates in the employee schedule/time-off lock.';

  assert (
    select count(*)::integer = baseline_time_off_count + 9
    from public.time_off_requests
  ), 'Submit, decide, and withdraw preserve every request row as history.';
end
$time_off_v2$;

rollback;

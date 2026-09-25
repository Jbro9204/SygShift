-- Run against a database migrated through 20260925182312. All fixtures,
-- schedule writes, and audit records are enclosed in this transaction.
begin;

insert into public.employees (id, username, first_name, last_name, role, time_zone)
values
  ('d5100000-0000-4000-8000-000000000001', 'dstscheduler', 'DST', 'Scheduler', 'scheduler', 'America/Denver'),
  ('d5100000-0000-4000-8000-000000000002', 'dsteastern', 'DST', 'Eastern', 'guard', 'America/New_York'),
  ('d5100000-0000-4000-8000-000000000003', 'dstmountain', 'DST', 'Mountain', 'guard', 'America/Denver');

insert into auth.users (id, email)
values ('d5200000-0000-4000-8000-000000000001', 'dst-scheduler@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  'd5100000-0000-4000-8000-000000000001',
  'd5200000-0000-4000-8000-000000000001',
  clock_timestamp()
);

insert into public.sites (id, code, name, time_zone)
values (
  'd5300000-0000-4000-8000-000000000001',
  'DST-NY',
  'DST Boundary Site',
  'America/New_York'
);

insert into public.posts (id, site_id, name, requires_armed)
values (
  'd5400000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000001',
  'DST Boundary Post',
  false
);

insert into public.employee_availability (
  id, employee_id, starts_on, ends_on, availability_status, approval_status, note
)
values (
  'd5500000-0000-4000-8000-000000000001',
  'd5100000-0000-4000-8000-000000000002',
  date '2099-03-25', date '2099-03-25',
  'unavailable', 'approved', 'Atomic repeat rollback fixture'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'd5200000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"d5200000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

do $verify_create_boundaries$
declare
  rejected boolean;
  result jsonb;
  valid_shift_id uuid;
  valid_shift public.shifts%rowtype;
begin
  rejected := false;
  begin
    perform public.scheduler_create_typed_open_shift(
      date '2099-04-05',
      null,
      'Standalone event without a zone', 'Raleigh', null, null, false,
      date '2099-04-06', time '09:00', time '17:00',
      1, false, 'Missing event zone must reject', 'post', false,
      null, null, null
    );
  exception when check_violation then
    rejected := sqlerrm = 'Choose the event time zone.';
  end;
  assert rejected, 'The active standalone-event create path defaulted a missing zone.';
  assert not exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-04-05'
  ), 'A standalone event without a time zone opened a schedule draft.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan_batch_v1(
      date '2099-04-05',
      null,
      'Standalone batch without a zone', 'Raleigh', null, null,
      array[date '2099-04-06'], time '09:00', time '17:00',
      1, 0, false, 'Missing batch event zone must reject', 'post', false,
      null, false, null, null, null, 'primary_shift', false, false,
      'America/New_York'
    );
  exception when check_violation then
    rejected := sqlerrm = 'Choose the event time zone.';
  end;
  assert rejected, 'The atomic standalone-event path defaulted a missing zone.';

  result := public.scheduler_create_coverage_plan_v3(
    date '2099-04-05',
    null,
    'Eastern standalone event', 'Raleigh', null, 'America/New_York',
    date '2099-04-06', time '09:00', time '17:00',
    1, 0, false, 'Explicit Eastern event', 'post', false,
    null, false, null, null, null, 'primary_shift', false
  );
  valid_shift_id := (result ->> 'unarmed_shift_id')::uuid;
  select shift.* into valid_shift from public.shifts shift where shift.id = valid_shift_id;
  assert valid_shift.starts_at = timestamp '2099-04-06 09:00:00' at time zone 'America/New_York'
    and valid_shift.time_zone = 'America/New_York',
    'An explicit standalone Eastern event was not stored in Eastern Time.';

  result := public.scheduler_create_coverage_plan_v3(
    date '2099-04-12',
    null,
    'Linked event', 'Linked site',
    'd5300000-0000-4000-8000-000000000001', 'America/Denver',
    date '2099-04-13', time '09:00', time '17:00',
    1, 0, false, 'Linked event site authority', 'post', false,
    null, false, null, null, null, 'primary_shift', false
  );
  valid_shift_id := (result ->> 'unarmed_shift_id')::uuid;
  select shift.* into valid_shift from public.shifts shift where shift.id = valid_shift_id;
  assert valid_shift.starts_at = timestamp '2099-04-13 09:00:00' at time zone 'America/New_York'
    and valid_shift.time_zone = 'America/New_York',
    'A linked event trusted a stale caller zone instead of the Site authority.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan_v3(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      date '2099-03-08', time '02:30', time '03:30',
      1, 0, false, 'DST gap must reject', 'post', false,
      null, false, null, null, null, 'primary_shift', false
    );
  exception when check_violation then
    rejected := sqlerrm like '%entered start time does not exist%America/New_York%';
  end;
  assert rejected, 'Site Time create accepted a nonexistent spring-forward start.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan_v2(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      date '2099-03-08', time '01:30', time '02:30',
      1, 0, false, 'DST end gap must reject', 'post', false,
      null, false, null, null, null
    );
  exception when check_violation then
    rejected := sqlerrm like '%entered end time does not exist%America/New_York%';
  end;
  assert rejected, 'Site Time v2 create accepted a nonexistent spring-forward end.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      date '2099-03-08', time '02:30', time '03:30',
      1, 0, false, 'Legacy coverage gap must reject', 'post', false,
      null, false, null, null
    );
  exception when check_violation then
    rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;
  assert rejected, 'The compatible unversioned coverage RPC bypassed DST validation.';

  rejected := false;
  begin
    perform public.scheduler_create_typed_open_shift(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null, false,
      date '2099-03-08', time '02:30', time '03:30',
      1, false, 'Compatible open shift gap must reject', 'post', false,
      null, null, null
    );
  exception when check_violation then
    rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;
  assert rejected, 'The actively used typed open-shift RPC bypassed DST validation.';

  rejected := false;
  begin
    perform public.scheduler_create_employee_local_coverage_plan_v3(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      date '2099-03-08', time '02:30', time '03:30',
      1, 0, false, 'Employee gap must reject', 'post', false,
      'd5100000-0000-4000-8000-000000000002', false,
      null, null, null, 'primary_shift', false
    );
  exception when check_violation then
    rejected := sqlerrm like '%entered start time does not exist%America/New_York%';
  end;
  assert rejected, 'Employee Time v3 create accepted a nonexistent spring-forward start.';

  rejected := false;
  begin
    perform public.scheduler_create_employee_local_coverage_plan_v2(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      date '2099-03-08', time '02:30', time '03:30',
      1, 0, false, 'Compatible employee gap must reject', 'post', false,
      'd5100000-0000-4000-8000-000000000002', false,
      null, null, null
    );
  exception when check_violation then
    rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;
  assert rejected, 'The compatible employee-local v2 RPC bypassed DST validation.';

  assert not exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-03-08'
  ), 'A rejected create opened a schedule draft before DST validation.';

  result := public.scheduler_create_employee_local_coverage_plan_v3(
    date '2099-03-15',
    'd5400000-0000-4000-8000-000000000001',
    null, null, null, null,
    date '2099-03-16', time '09:00', time '17:00',
    1, 0, false, 'Valid employee-local shift', 'post', false,
    'd5100000-0000-4000-8000-000000000002', false,
    null, null, null, 'primary_shift', false
  );
  valid_shift_id := (result ->> 'unarmed_shift_id')::uuid;

  select shift.* into valid_shift
  from public.shifts shift
  where shift.id = valid_shift_id;

  assert valid_shift.starts_at = timestamp '2099-03-16 09:00:00' at time zone 'America/New_York',
    'A valid 09:00 Employee Time create changed its actual instant.';
  assert valid_shift.ends_at = timestamp '2099-03-16 17:00:00' at time zone 'America/New_York',
    'A valid Employee Time end changed its actual instant.';
  assert valid_shift.time_zone_source = 'employee'
    and valid_shift.time_zone_employee_id = 'd5100000-0000-4000-8000-000000000002',
    'The valid Employee Time create did not retain its source authority.';

  rejected := false;
  begin
    perform public.get_scheduled_overtime_create_preview_v2(
      date '2099-03-08',
      'd5100000-0000-4000-8000-000000000002',
      'd5400000-0000-4000-8000-000000000001',
      null,
      array[date '2099-03-09', date '2099-03-08'],
      time '02:30', time '03:30', true, 'primary_shift'
    );
  exception when check_violation then
    rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;
  assert rejected, 'The repeated-date overtime preview normalized a spring gap.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan_batch_v1(
      date '2099-03-08',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      array[date '2099-03-09', date '2099-03-08'],
      time '02:30', time '03:30',
      1, 0, false, 'Batch DST gap must reject', 'post', false,
      'd5100000-0000-4000-8000-000000000002', false,
      null, null, null, 'primary_shift', false, true, 'America/New_York'
    );
  exception when check_violation then
    rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;
  assert rejected, 'The atomic repeat RPC did not preflight every date for DST gaps.';
  assert not exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-03-08'
  ), 'The atomic repeat DST preflight wrote an earlier date before rejecting a later gap.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan_batch_v1(
      date '2099-03-22',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      array[date '2099-03-24', date '2099-03-25'],
      time '09:00', time '17:00',
      1, 0, false, 'Atomic later failure must roll back', 'post', false,
      'd5100000-0000-4000-8000-000000000002', false,
      null, null, null, 'primary_shift', false, true, 'America/New_York'
    );
  exception when check_violation then
    rejected := sqlerrm like '%marked unavailable%';
  end;
  assert rejected, 'The atomic repeat fixture did not reach its later non-DST failure.';
  assert not exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-03-22'
  ), 'A later repeat failure left the earlier date committed.';

  rejected := false;
  begin
    perform public.scheduler_create_coverage_plan_batch_v1(
      date '2099-03-29',
      'd5400000-0000-4000-8000-000000000001',
      null, null, null, null,
      array[date '2099-03-30'],
      time '09:00', time '17:00',
      1, 0, false, 'Expected zone mismatch must reject', 'post', false,
      null, false, null, null, null, 'primary_shift', false, false, 'America/Denver'
    );
  exception when serialization_failure then
    rejected := sqlerrm like '%schedule time zone changed before save%';
  end;
  assert rejected, 'The atomic repeat RPC did not bind save to the previewed zone.';
  assert not exists (
    select 1 from public.schedules schedule
    where schedule.week_starts_on = date '2099-03-29'
  ), 'A stale previewed zone wrote a schedule before rejection.';
end
$verify_create_boundaries$;

do $verify_edit_boundaries$
declare
  target_shift_id uuid;
  before_shift jsonb;
  after_shift jsonb;
  rejected boolean;
begin
  select shift.id, to_jsonb(shift.*)
    into target_shift_id, before_shift
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where schedule.week_starts_on = date '2099-03-15'
    and shift.canceled_at is null
  limit 1;

  rejected := false;
  begin
    perform public.scheduler_update_typed_draft_shift_v3(
      target_shift_id,
      date '2099-03-08', time '02:30', time '03:30',
      1, false, false, 'Gap edit must reject', 'post',
      'd5100000-0000-4000-8000-000000000002',
      null, null, null, 'primary_shift'
    );
  exception when check_violation then
    rejected := sqlerrm like '%entered start time does not exist%America/New_York%';
  end;
  assert rejected, 'Typed v3 edit accepted a nonexistent spring-forward time.';

  select to_jsonb(shift.*) into after_shift
  from public.shifts shift
  where shift.id = target_shift_id;
  assert after_shift = before_shift,
    'The rejected typed v3 edit changed the shift before validation completed.';

  rejected := false;
  begin
    perform public.scheduler_update_draft_shift(
      target_shift_id,
      date '2099-03-08', time '01:30', time '02:30',
      1, false, false, 'Compatible gap edit must reject',
      'd5100000-0000-4000-8000-000000000002', null, null
    );
  exception when check_violation then
    rejected := sqlerrm like '%entered end time does not exist%America/New_York%';
  end;
  assert rejected, 'The compatible edit RPC accepted a nonexistent spring-forward end.';

  select to_jsonb(shift.*) into after_shift
  from public.shifts shift
  where shift.id = target_shift_id;
  assert after_shift = before_shift,
    'The rejected compatible edit changed the shift before validation completed.';

  rejected := false;
  begin
    perform public.get_scheduled_overtime_update_preview_v2(
      target_shift_id,
      'd5100000-0000-4000-8000-000000000002',
      date '2099-03-08', time '02:30', time '03:30', 'primary_shift'
    );
  exception when check_violation then
    rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;
  assert rejected, 'The update overtime preview normalized a spring gap.';

  -- Reassignment deliberately preserves the existing Employee Time source and
  -- exact instants; it must not silently reinterpret 09:00 as the new assignee's
  -- Mountain profile time.
  perform public.scheduler_update_typed_draft_shift_v3(
    target_shift_id,
    date '2099-03-16', time '09:00', time '17:00',
    1, false, false, 'Preserve source while reassigning', 'post',
    'd5100000-0000-4000-8000-000000000003',
    null, null, null, 'primary_shift'
  );

  assert (
    select shift.starts_at = (before_shift ->> 'starts_at')::timestamptz
      and shift.ends_at = (before_shift ->> 'ends_at')::timestamptz
      and shift.time_zone_source = 'employee'
      and shift.time_zone_employee_id = 'd5100000-0000-4000-8000-000000000002'
    from public.shifts shift
    where shift.id = target_shift_id
  ), 'Reassignment silently changed the stored Employee Time source or instant.';

  assert exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id
      and assignment.employee_id = 'd5100000-0000-4000-8000-000000000003'
      and assignment.status in ('assigned', 'confirmed', 'completed')
      and assignment.canceled_at is null
  ), 'The safe reassignment did not assign the replacement employee.';
end
$verify_edit_boundaries$;

do $verify_direct_write_boundary$
declare
  rejected boolean := false;
  target_shift_id uuid;
begin
  begin
    insert into public.shifts (
      schedule_id, post_id, starts_at, ends_at, time_zone,
      headcount_required, requires_armed, is_open, is_overtime,
      work_type, created_by
    )
    select schedule.id,
      'd5400000-0000-4000-8000-000000000001',
      now(), now() + interval '1 hour', 'America/New_York',
      1, false, true, false, 'post',
      'd5100000-0000-4000-8000-000000000001'
    from public.schedules schedule
    where schedule.week_starts_on = date '2099-03-15'
    limit 1;
  exception when insufficient_privilege then
    rejected := true;
  end;
  assert rejected, 'Authenticated direct shift INSERT can bypass the guarded RPCs.';

  select shift.id into target_shift_id
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where schedule.week_starts_on = date '2099-03-15'
  limit 1;

  rejected := false;
  begin
    insert into public.shift_assignments (shift_id, employee_id, status)
    values (
      target_shift_id,
      'd5100000-0000-4000-8000-000000000002',
      'assigned'
    );
  exception when insufficient_privilege then
    rejected := true;
  end;
  assert rejected, 'Authenticated direct assignment INSERT can bypass the source contract.';

  rejected := false;
  begin
    update public.schedules schedule
    set status = 'published'
    where schedule.week_starts_on = date '2099-03-15';
  exception when insufficient_privilege then
    rejected := true;
  end;
  assert rejected, 'Authenticated direct schedule UPDATE can bypass the audited publish RPC.';
end
$verify_direct_write_boundary$;

reset role;

do $verify_atomic_failure_audit$
begin
  assert not exists (
    select 1
    from private.audit_events audit
    join public.schedules schedule on schedule.id::text = audit.row_id
    where schedule.week_starts_on = date '2099-03-08'
  ), 'A rejected spring-gap create left an audit or schedule write behind.';

  assert exists (
    select 1
    from private.audit_events audit
    join public.schedules schedule on schedule.id::text = audit.row_id
    where schedule.week_starts_on = date '2099-03-15'
      and audit.operation = 'CREATE_EMPLOYEE_LOCAL_DISPATCH_AWARE_COVERAGE'
      and (audit.new_record ->> 'dstRoundTripValidated')::boolean
  ), 'The valid employee-local create did not record DST validation in its audit.';
end
$verify_atomic_failure_audit$;

select 'schedule_dst_boundary_regression: PASS' as result;

rollback;

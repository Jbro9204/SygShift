-- Run against a migrated database. Every fixture, copied schedule, audit row,
-- and destination replacement is enclosed in this transaction and rolled back.
begin;

insert into public.employees (id, username, first_name, last_name, role, time_zone)
values
  ('ce210000-0000-4000-8000-000000000001', 'copytzscheduler', 'Copy TZ', 'Scheduler', 'scheduler', 'America/Denver'),
  ('ce210000-0000-4000-8000-000000000002', 'copytzeastern', 'Copy TZ', 'Eastern', 'guard', 'America/New_York'),
  ('ce210000-0000-4000-8000-000000000003', 'copytzcorrected', 'Copy TZ', 'Corrected', 'guard', 'America/Denver');

insert into auth.users (id, email)
values ('ce220000-0000-4000-8000-000000000001', 'copy-time-basis-scheduler@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  'ce210000-0000-4000-8000-000000000001',
  'ce220000-0000-4000-8000-000000000001',
  clock_timestamp()
);

insert into public.sites (id, code, name, time_zone)
values (
  'ce230000-0000-4000-8000-000000000001',
  'COPY-TZ',
  'Copy Time Basis Test',
  'America/Denver'
);

insert into public.posts (id, site_id, name, requires_armed)
values (
  'ce240000-0000-4000-8000-000000000001',
  'ce230000-0000-4000-8000-000000000001',
  'Copy Time Basis Post',
  false
);

insert into public.schedules (id, week_starts_on, revision, status, created_by)
values
  ('ce250000-0000-4000-8000-000000000001', date '2099-09-06', 1, 'draft', 'ce210000-0000-4000-8000-000000000001'),
  ('ce250000-0000-4000-8000-000000000002', date '2099-10-25', 1, 'draft', 'ce210000-0000-4000-8000-000000000001'),
  ('ce250000-0000-4000-8000-000000000003', date '2099-03-01', 1, 'draft', 'ce210000-0000-4000-8000-000000000001'),
  ('ce250000-0000-4000-8000-000000000004', date '2099-03-08', 1, 'draft', 'ce210000-0000-4000-8000-000000000001'),
  ('ce250000-0000-4000-8000-000000000005', date '2099-09-20', 1, 'draft', 'ce210000-0000-4000-8000-000000000001');

insert into public.shifts (
  id,
  schedule_id,
  post_id,
  starts_at,
  ends_at,
  time_zone,
  headcount_required,
  work_type,
  time_zone_source,
  time_zone_employee_id,
  assignment_type,
  created_by
)
values
  (
    'ce260000-0000-4000-8000-000000000001',
    'ce250000-0000-4000-8000-000000000001',
    'ce240000-0000-4000-8000-000000000001',
    timestamp '2099-09-07 09:00:00' at time zone 'America/New_York',
    timestamp '2099-09-07 17:00:00' at time zone 'America/New_York',
    'America/New_York',
    1,
    'post',
    'employee',
    'ce210000-0000-4000-8000-000000000002',
    'standard',
    'ce210000-0000-4000-8000-000000000001'
  ),
  (
    'ce260000-0000-4000-8000-000000000002',
    'ce250000-0000-4000-8000-000000000002',
    'ce240000-0000-4000-8000-000000000001',
    timestamp '2099-10-26 09:00:00' at time zone 'America/New_York',
    timestamp '2099-10-26 17:00:00' at time zone 'America/New_York',
    'America/New_York',
    1,
    'post',
    'employee',
    'ce210000-0000-4000-8000-000000000002',
    'standard',
    'ce210000-0000-4000-8000-000000000001'
  ),
  (
    'ce260000-0000-4000-8000-000000000003',
    'ce250000-0000-4000-8000-000000000003',
    'ce240000-0000-4000-8000-000000000001',
    timestamp '2099-03-01 02:30:00' at time zone 'America/New_York',
    timestamp '2099-03-01 03:30:00' at time zone 'America/New_York',
    'America/New_York',
    1,
    'post',
    'employee',
    'ce210000-0000-4000-8000-000000000002',
    'standard',
    'ce210000-0000-4000-8000-000000000001'
  ),
  (
    -- Sentinel proves a rejected spring-gap copy rolls back the destination
    -- cancellations as well as every newly inserted block.
    'ce260000-0000-4000-8000-000000000004',
    'ce250000-0000-4000-8000-000000000004',
    'ce240000-0000-4000-8000-000000000001',
    timestamp '2099-03-09 09:00:00' at time zone 'America/Denver',
    timestamp '2099-03-09 17:00:00' at time zone 'America/Denver',
    'America/Denver',
    1,
    'post',
    'site',
    null,
    'standard',
    'ce210000-0000-4000-8000-000000000001'
  ),
  (
    'ce260000-0000-4000-8000-000000000005',
    'ce250000-0000-4000-8000-000000000005',
    'ce240000-0000-4000-8000-000000000001',
    timestamp '2099-09-21 09:00:00' at time zone 'America/Denver',
    timestamp '2099-09-21 17:00:00' at time zone 'America/Denver',
    'America/Denver',
    1,
    'post',
    'employee',
    'ce210000-0000-4000-8000-000000000003',
    'standard',
    'ce210000-0000-4000-8000-000000000001'
  );

-- Correcting the employee profile changes the authority for future copies,
-- but must not rewrite the historical source shift.
update public.employees
set time_zone = 'America/New_York',
    updated_at = clock_timestamp()
where id = 'ce210000-0000-4000-8000-000000000003';

set local role authenticated;
set local "request.jwt.claim.sub" = 'ce220000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"ce220000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

do $verify_wall_clock_copy$
declare
  copy_result jsonb;
  destination_schedule_id uuid;
  copied public.shifts%rowtype;
  gap_rejected boolean := false;
begin
  copy_result := public.replace_schedule_week_draft_with_work_types(
    'ce250000-0000-4000-8000-000000000001',
    date '2099-09-13',
    false,
    false
  );
  destination_schedule_id := (copy_result -> 'schedule' ->> 'id')::uuid;

  select shift.* into copied
  from public.shifts shift
  where shift.schedule_id = destination_schedule_id
    and shift.canceled_at is null;

  assert copied.starts_at = timestamp '2099-09-14 09:00:00' at time zone 'America/New_York',
    'A September 09:00 Eastern shift did not remain 09:00 Eastern.';
  assert copied.ends_at = timestamp '2099-09-14 17:00:00' at time zone 'America/New_York',
    'A September Eastern shift did not retain its local end time.';
  assert copied.time_zone = 'America/New_York'
    and copied.time_zone_source = 'employee'
    and copied.time_zone_employee_id = 'ce210000-0000-4000-8000-000000000002',
    'The September employee time basis was not retained.';

  copy_result := public.replace_schedule_week_draft_with_work_types(
    'ce250000-0000-4000-8000-000000000002',
    date '2099-11-01',
    false,
    false
  );
  destination_schedule_id := (copy_result -> 'schedule' ->> 'id')::uuid;

  select shift.* into copied
  from public.shifts shift
  where shift.schedule_id = destination_schedule_id
    and shift.canceled_at is null;

  assert copied.starts_at = timestamp '2099-11-02 09:00:00' at time zone 'America/New_York',
    'The EDT-to-EST copy moved a 09:00 wall clock.';
  assert extract(hour from copied.starts_at at time zone 'UTC') = 14,
    'The EDT-to-EST copy retained a stale UTC offset instead of 09:00 EST.';
  assert copied.starts_at - (
    timestamp '2099-10-26 09:00:00' at time zone 'America/New_York'
  ) = interval '7 days 1 hour',
    'The EDT-to-EST copy did not account for the daylight-saving offset change.';

  copy_result := public.replace_schedule_week_draft_with_work_types(
    'ce250000-0000-4000-8000-000000000005',
    date '2099-09-27',
    false,
    false
  );
  destination_schedule_id := (copy_result -> 'schedule' ->> 'id')::uuid;

  select shift.* into copied
  from public.shifts shift
  where shift.schedule_id = destination_schedule_id
    and shift.canceled_at is null;

  assert copied.starts_at = timestamp '2099-09-28 09:00:00' at time zone 'America/New_York',
    'A corrected employee profile did not produce 09:00 in the current profile zone.';
  assert copied.time_zone = 'America/New_York'
    and copied.time_zone_source = 'employee'
    and copied.time_zone_employee_id = 'ce210000-0000-4000-8000-000000000003',
    'The corrected employee time-zone authority was not refreshed.';
  assert (
    select shift.time_zone = 'America/Denver'
      and shift.starts_at = timestamp '2099-09-21 09:00:00' at time zone 'America/Denver'
    from public.shifts shift
    where shift.id = 'ce260000-0000-4000-8000-000000000005'
  ), 'The historical source shift was changed when the employee profile was corrected.';

  begin
    perform public.replace_schedule_week_draft_with_work_types(
      'ce250000-0000-4000-8000-000000000003',
      date '2099-03-08',
      false,
      false
    );
  exception when check_violation then
    gap_rejected := sqlerrm like '%does not exist%daylight-saving time%';
  end;

  assert gap_rejected,
    'A nonexistent spring-forward local time was not rejected.';
  assert (
    select count(*) = 1
    from public.shifts shift
    where shift.schedule_id = 'ce250000-0000-4000-8000-000000000004'
      and shift.canceled_at is null
      and shift.id = 'ce260000-0000-4000-8000-000000000004'
  ), 'The rejected spring-gap copy did not roll back the destination replacement atomically.';
end
$verify_wall_clock_copy$;

reset role;

do $verify_copy_audit$
begin
  assert exists (
    select 1
    from private.audit_events audit
    join public.schedules schedule on schedule.id::text = audit.row_id
    where audit.operation = 'replace_week_draft_from_revision'
      and schedule.week_starts_on = date '2099-09-27'
      and (audit.new_record ->> 'wall_clock_copy_verified')::boolean
      and (audit.new_record ->> 'refreshed_time_zone_count')::integer = 1
      and (audit.new_record ->> 'employee_time_zone_source_count')::integer = 1
  ), 'The profile-zone refresh was not recorded in the atomic copy audit.';
end
$verify_copy_audit$;

select 'schedule_week_copy_time_basis_regression: PASS' as result;

rollback;

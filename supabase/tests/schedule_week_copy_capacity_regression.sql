-- Run against a database with the schedule week-copy time-zone cache migration.
-- This is intentionally a rollback-only production-safe regression fixture: it
-- exercises a current-size week without leaving employees, schedules, shifts,
-- assignments, audit records, or destination changes behind.
begin;

insert into public.employees (id, username, first_name, last_name, role, time_zone)
values (
  'cc310000-0000-4000-8000-000000000001',
  'copycapacityscheduler',
  'Copy Capacity',
  'Scheduler',
  'scheduler',
  'America/New_York'
);

insert into public.employees (id, username, first_name, last_name, role, time_zone)
select
  ('cc320000-0000-4000-8000-' || lpad(guard_number::text, 12, '0'))::uuid,
  'copycapacityguard' || lpad(guard_number::text, 3, '0'),
  'Copy Capacity',
  'Guard ' || guard_number::text,
  'guard',
  'America/New_York'
from generate_series(1, 136) guard_number;

insert into auth.users (id, email)
values (
  'cc330000-0000-4000-8000-000000000001',
  'copy-capacity-scheduler@example.invalid'
);

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  'cc310000-0000-4000-8000-000000000001',
  'cc330000-0000-4000-8000-000000000001',
  clock_timestamp()
);

insert into public.sites (id, code, name, time_zone, supports_dispatch_phone_duty)
values
  (
    'cc340000-0000-4000-8000-000000000001',
    'COPY-CAP-DISPATCH',
    'Copy Capacity Dispatch',
    'America/New_York',
    true
  ),
  (
    'cc340000-0000-4000-8000-000000000002',
    'COPY-CAP-STANDARD',
    'Copy Capacity Standard',
    'America/New_York',
    false
  );

insert into public.posts (id, site_id, name, requires_armed)
values
  (
    'cc350000-0000-4000-8000-000000000001',
    'cc340000-0000-4000-8000-000000000001',
    'Dispatch phone duty',
    false
  ),
  (
    'cc350000-0000-4000-8000-000000000002',
    'cc340000-0000-4000-8000-000000000002',
    'Standard post',
    false
  );

-- Create both weeks as drafts so their child records can be established under
-- ordinary constraints. The source is promoted to its normal immutable
-- published state once the source fixture is complete.
insert into public.schedules (id, week_starts_on, revision, status, created_by)
values
  (
    'cc360000-0000-4000-8000-000000000001',
    date '2099-10-25',
    1,
    'draft',
    'cc310000-0000-4000-8000-000000000001'
  ),
  (
    'cc360000-0000-4000-8000-000000000002',
    date '2099-11-01',
    1,
    'draft',
    'cc310000-0000-4000-8000-000000000001'
  );

insert into public.shifts (
  id,
  schedule_id,
  post_id,
  starts_at,
  ends_at,
  time_zone,
  headcount_required,
  requires_armed,
  is_open,
  work_type,
  time_zone_source,
  assignment_type,
  created_by
)
select
  ('cc370000-0000-4000-8000-' || lpad(shift_number::text, 12, '0'))::uuid,
  'cc360000-0000-4000-8000-000000000001',
  case
    when shift_number = 1 then 'cc350000-0000-4000-8000-000000000001'::uuid
    else 'cc350000-0000-4000-8000-000000000002'::uuid
  end,
  case
    when shift_number = 1
      then timestamp '2099-10-27 18:00:00' at time zone 'America/New_York'
    when shift_number = 2
      then timestamp '2099-10-27 20:00:00' at time zone 'America/New_York'
    else timestamp '2099-10-26 09:00:00' at time zone 'America/New_York'
  end,
  case
    when shift_number = 1
      then timestamp '2099-10-28 06:00:00' at time zone 'America/New_York'
    when shift_number = 2
      then timestamp '2099-10-28 06:00:00' at time zone 'America/New_York'
    else timestamp '2099-10-26 17:00:00' at time zone 'America/New_York'
  end,
  'America/New_York',
  1,
  false,
  false,
  'post',
  'site',
  case when shift_number = 1 then 'dispatch_phone_duty' else 'standard' end,
  'cc310000-0000-4000-8000-000000000001'
from generate_series(1, 142) shift_number;

-- The first two assignments deliberately share a guard across an authorized
-- Dispatch-plus-standard overlap. The remaining 134 assignments are one per
-- standard source shift, yielding 136 active source assignments in total.
insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
select
  ('cc370000-0000-4000-8000-' || lpad(assignment_number::text, 12, '0'))::uuid,
  (
    'cc320000-0000-4000-8000-' || lpad(
      (case when assignment_number <= 2 then 1 else assignment_number - 1 end)::text,
      12,
      '0'
    )
  )::uuid,
  'assigned',
  'cc310000-0000-4000-8000-000000000001'
from generate_series(1, 136) assignment_number;

-- This existing draft record is the replacement sentinel. A successful copy
-- must cancel it and replace it with exactly the source-week content.
insert into public.shifts (
  id,
  schedule_id,
  post_id,
  starts_at,
  ends_at,
  time_zone,
  headcount_required,
  requires_armed,
  is_open,
  work_type,
  time_zone_source,
  assignment_type,
  created_by
)
values (
  'cc370000-0000-4000-8000-000000000143',
  'cc360000-0000-4000-8000-000000000002',
  'cc350000-0000-4000-8000-000000000002',
  timestamp '2099-11-02 19:00:00' at time zone 'America/New_York',
  timestamp '2099-11-03 03:00:00' at time zone 'America/New_York',
  'America/New_York',
  1,
  false,
  true,
  'post',
  'site',
  'standard',
  'cc310000-0000-4000-8000-000000000001'
);

insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
values (
  'cc370000-0000-4000-8000-000000000143',
  'cc320000-0000-4000-8000-000000000136',
  'assigned',
  'cc310000-0000-4000-8000-000000000001'
);

update public.schedules
set
  status = 'published',
  published_at = clock_timestamp(),
  published_by = 'cc310000-0000-4000-8000-000000000001',
  updated_at = clock_timestamp()
where id = 'cc360000-0000-4000-8000-000000000001';

-- The copied guard is available in the source week, but has approved leave
-- over the corresponding destination shift. A successful copy must retain the
-- shift and safely leave this one assignment open rather than canceling the
-- entire week replacement.
insert into public.time_off_requests(
  id, employee_id, starts_on, ends_on, partial_day_start, partial_day_end,
  reason, status, employment_type_snapshot, pay_treatment, requested_minutes,
  submission_snapshot, affected_shifts_snapshot
) values (
  'cc380000-0000-4000-8000-000000000001',
  'cc320000-0000-4000-8000-000000000135',
  date '2099-11-02', date '2099-11-02', time '09:00', time '17:00',
  'Approved leave for copied-week capacity coverage.', 'approved', 'hourly',
  'unpaid', 480, jsonb_build_object('timeZone', 'America/New_York'), '[]'::jsonb
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'cc330000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"cc330000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
set local statement_timeout = '7s';

do $verify_copy_capacity$
declare
  copy_result jsonb;
  destination_schedule_id uuid;
  copy_started_at timestamptz;
  copy_elapsed interval;
begin
  copy_started_at := clock_timestamp();
  copy_result := public.replace_schedule_week_draft_with_work_types(
    'cc360000-0000-4000-8000-000000000001',
    date '2099-11-01',
    true,
    false
  );
  copy_elapsed := clock_timestamp() - copy_started_at;
  destination_schedule_id := (copy_result -> 'schedule' ->> 'id')::uuid;

  assert copy_elapsed < interval '7 seconds',
    'The copied week exceeded the authenticated RPC timeout budget.';
  assert destination_schedule_id = 'cc360000-0000-4000-8000-000000000002',
    'The existing destination working draft was not returned.';
  assert (copy_result ->> 'copiedCount')::integer = 142,
    'The capacity fixture did not copy all 142 source shifts.';
  assert (copy_result ->> 'copiedAssignmentCount')::integer = 135,
    'The capacity fixture did not copy each eligible source assignment.';
  assert (copy_result ->> 'skippedApprovedTimeOffAssignmentCount')::integer = 1,
    'The approved-time-off assignment was not safely left open.';
  assert (copy_result ->> 'replacedCount')::integer = 1,
    'The destination sentinel was not counted as a replaced shift.';

  assert (
    select count(*) = 142
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
  ), 'The destination draft does not contain exactly 142 active copied shifts.';

  assert (
    select count(*) = 135
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ), 'The destination draft does not contain exactly 135 eligible copied assignments.';

  assert (
    select count(*) = 135
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and not shift.is_open
  ), 'The 135 eligible copied shifts were not marked covered.';

  assert (
    select count(*) = 7
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and shift.is_open
  ), 'The six originally open and one approved-leave shift were not left open.';

  assert not exists (
    select 1
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and assignment.employee_id = 'cc320000-0000-4000-8000-000000000135'
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ), 'An employee with approved leave was assigned in the copied destination.';

  assert (
    select count(*) = 142
    from public.shifts shift
    where shift.schedule_id = 'cc360000-0000-4000-8000-000000000001'
      and shift.canceled_at is null
  ), 'The source schedule changed during capacity copy.';

  assert (
    select count(*) = 136
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = 'cc360000-0000-4000-8000-000000000001'
      and shift.canceled_at is null
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ), 'The source assignments changed during capacity copy.';

  assert exists (
    select 1
    from public.shifts shift
    where shift.id = 'cc370000-0000-4000-8000-000000000143'
      and shift.schedule_id = destination_schedule_id
      and shift.canceled_at is not null
      and shift.cancellation_reason like 'Replaced by copied schedule revision%'
  ), 'The destination sentinel was not canceled by the atomic replacement.';

  assert exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = 'cc370000-0000-4000-8000-000000000143'
      and assignment.employee_id = 'cc320000-0000-4000-8000-000000000136'
      and assignment.status = 'canceled'
      and assignment.canceled_at is not null
  ), 'The destination sentinel assignment was not canceled by the replacement.';

  assert (
    select count(*) = 1
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and shift.assignment_type = 'dispatch_phone_duty'
  ), 'Dispatch classification was not preserved in the copied destination.';

  assert (
    select count(*) = 2
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and assignment.employee_id = 'cc320000-0000-4000-8000-000000000001'
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ), 'The authorized Dispatch-plus-standard overlap was not copied.';

  assert exists (
    select 1
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and shift.assignment_type = 'standard'
      and shift.starts_at = timestamp '2099-11-02 09:00:00' at time zone 'America/New_York'
      and shift.ends_at = timestamp '2099-11-02 17:00:00' at time zone 'America/New_York'
      and shift.time_zone = 'America/New_York'
      and shift.time_zone_source = 'site'
  ), 'The DST-crossing capacity copy did not retain the local Eastern wall clock.';
end
$verify_copy_capacity$;

reset role;

do $verify_copy_capacity_audit$
begin
  assert exists (
    select 1
    from private.audit_events audit
    where audit.operation = 'replace_week_draft_from_revision'
      and audit.row_id = 'cc360000-0000-4000-8000-000000000002'
      and audit.new_record ->> 'source_schedule_id' = 'cc360000-0000-4000-8000-000000000001'
      and (audit.new_record ->> 'copied_shift_count')::integer = 142
      and (audit.new_record ->> 'copied_assignment_count')::integer = 135
      and (audit.new_record ->> 'skipped_approved_time_off_assignment_count')::integer = 1
      and (audit.old_record ->> 'replaced_shift_count')::integer = 1
      and (audit.new_record ->> 'wall_clock_copy_verified')::boolean
  ), 'The capacity copy audit record is incomplete.';
end
$verify_copy_capacity_audit$;

select 'schedule_week_copy_capacity_regression: PASS' as result;

rollback;

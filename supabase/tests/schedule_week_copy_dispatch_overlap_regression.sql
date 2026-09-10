-- Run against a migrated database. Every fixture, copied schedule, assignment,
-- override, and audit row is enclosed in this transaction and rolled back.
\set ON_ERROR_STOP on

begin;

insert into public.employees (id, username, first_name, last_name, role)
values
  ('cd110000-0000-4000-8000-000000000001', 'copy-overlap-scheduler', 'Copy', 'Scheduler', 'scheduler'),
  ('cd110000-0000-4000-8000-000000000002', 'copy-overlap-guard', 'Copy', 'Guard', 'guard');

insert into auth.users (id, email)
values ('cd120000-0000-4000-8000-000000000001', 'copy-overlap-scheduler@example.invalid');

insert into private.employee_accounts (employee_id, auth_user_id, activated_at)
values (
  'cd110000-0000-4000-8000-000000000001',
  'cd120000-0000-4000-8000-000000000001',
  clock_timestamp()
);

insert into public.sites (id, code, name, time_zone, supports_dispatch_phone_duty)
values
  ('cd130000-0000-4000-8000-000000000001', 'COPY-DISPATCH', 'Copy Dispatch Test', 'America/Denver', true),
  ('cd130000-0000-4000-8000-000000000002', 'COPY-POST', 'Copy Standard Test', 'America/Denver', false);

insert into public.posts (id, site_id, name, requires_armed)
values
  ('cd140000-0000-4000-8000-000000000001', 'cd130000-0000-4000-8000-000000000001', 'Dispatch duty', false),
  ('cd140000-0000-4000-8000-000000000002', 'cd130000-0000-4000-8000-000000000002', 'Standard post', false);

insert into public.schedules (id, week_starts_on, revision, status, created_by)
values (
  'cd150000-0000-4000-8000-000000000001',
  date '2099-01-04',
  1,
  'draft',
  'cd110000-0000-4000-8000-000000000001'
);

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
  assignment_type,
  created_by
)
values
  (
    'cd160000-0000-4000-8000-000000000001',
    'cd150000-0000-4000-8000-000000000001',
    'cd140000-0000-4000-8000-000000000001',
    timestamptz '2099-01-06 18:00:00-07',
    timestamptz '2099-01-07 06:00:00-07',
    'America/Denver',
    1,
    'post',
    'post',
    'dispatch_phone_duty',
    'cd110000-0000-4000-8000-000000000001'
  ),
  (
    'cd160000-0000-4000-8000-000000000002',
    'cd150000-0000-4000-8000-000000000001',
    'cd140000-0000-4000-8000-000000000002',
    timestamptz '2099-01-06 20:00:00-07',
    timestamptz '2099-01-07 06:00:00-07',
    'America/Denver',
    1,
    'post',
    'post',
    'standard',
    'cd110000-0000-4000-8000-000000000001'
  );

insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
values
  ('cd160000-0000-4000-8000-000000000001', 'cd110000-0000-4000-8000-000000000002', 'assigned', 'cd110000-0000-4000-8000-000000000001'),
  ('cd160000-0000-4000-8000-000000000002', 'cd110000-0000-4000-8000-000000000002', 'assigned', 'cd110000-0000-4000-8000-000000000001');

set local role authenticated;
set local "request.jwt.claim.sub" = 'cd120000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"cd120000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

do $verify_copy$
declare
  copy_result jsonb;
  destination_schedule_id uuid;
  ordinary_overlap_blocked boolean := false;
  ordinary_overlap_shift_id uuid := 'cd160000-0000-4000-8000-000000000003';
begin
  copy_result := public.replace_schedule_week_draft_with_work_types(
    'cd150000-0000-4000-8000-000000000001',
    date '2099-01-11',
    true,
    false
  );

  destination_schedule_id := (copy_result -> 'schedule' ->> 'id')::uuid;

  assert (copy_result ->> 'copiedCount')::integer = 2,
    'The complete source week was not copied.';
  assert (copy_result ->> 'copiedAssignmentCount')::integer = 2,
    'The valid overlapping assignments were not copied.';
  assert destination_schedule_id is not null,
    'The destination working draft was not returned.';

  assert (
    select count(*) = 2
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
  ), 'The destination draft does not contain both shift blocks.';

  assert (
    select count(*) = 2
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and assignment.employee_id = 'cd110000-0000-4000-8000-000000000002'
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ), 'The destination draft does not contain both employee assignments.';

  assert (
    select count(*) = 1
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and shift.assignment_type = 'dispatch_phone_duty'
  ), 'Concurrent Dispatch classification was not present during the copy.';

  assert (
    select count(*) = 1
    from public.shifts shift
    where shift.schedule_id = destination_schedule_id
      and shift.canceled_at is null
      and shift.assignment_type = 'standard'
      and shift.work_type = 'post'
  ), 'Standard post classification was not preserved.';

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
    assignment_type,
    created_by
  ) values (
    ordinary_overlap_shift_id,
    destination_schedule_id,
    'cd140000-0000-4000-8000-000000000002',
    timestamptz '2099-01-13 21:00:00-07',
    timestamptz '2099-01-14 01:00:00-07',
    'America/Denver',
    1,
    'post',
    'post',
    'standard',
    'cd110000-0000-4000-8000-000000000001'
  );

  begin
    insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
    values (
      ordinary_overlap_shift_id,
      'cd110000-0000-4000-8000-000000000002',
      'assigned',
      'cd110000-0000-4000-8000-000000000001'
    );
  exception when others then
    ordinary_overlap_blocked := sqlerrm like '%already assigned to an overlapping shift%';
  end;

  assert ordinary_overlap_blocked,
    'A genuine standard-shift overlap was not blocked.';

  assert (
    select count(*) = 2
    from public.shifts shift
    where shift.schedule_id = 'cd150000-0000-4000-8000-000000000001'
      and shift.canceled_at is null
  ), 'The source schedule was changed by the copy.';
end
$verify_copy$;

reset role;

select 'schedule_week_copy_dispatch_overlap_regression: PASS' as result;

rollback;

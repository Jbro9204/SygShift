-- Run against a migrated database. Every fixture and audit row is rolled back.
-- This proves schedule-revision refresh, retained overnight assignments,
-- assignment removal/restoration, salary exclusion, supplemental Dispatch
-- exclusion, alert lifecycle updates, and idempotency.

begin;

insert into public.employees (id, username, first_name, last_name, employment_type)
values
  ('fa110000-0000-4000-8000-000000000001', 'attendance-refresh-revision', 'Refresh', 'Revision', 'hourly'),
  ('fa110000-0000-4000-8000-000000000002', 'attendance-refresh-retained', 'Refresh', 'Retained', 'hourly'),
  ('fa110000-0000-4000-8000-000000000003', 'attendance-refresh-restored', 'Refresh', 'Restored', 'hourly'),
  ('fa110000-0000-4000-8000-000000000004', 'attendance-refresh-salary', 'Refresh', 'Salary', 'salary'),
  ('fa110000-0000-4000-8000-000000000005', 'attendance-refresh-dispatch', 'Refresh', 'Dispatch', 'hourly');

insert into public.sites (id, code, name, time_zone, supports_dispatch_phone_duty)
values ('fa120000-0000-4000-8000-000000000001', 'ALERT-REFRESH', 'Attendance Refresh Test', 'America/Denver', true);

insert into public.posts (id, site_id, name, requires_armed)
values ('fa130000-0000-4000-8000-000000000001', 'fa120000-0000-4000-8000-000000000001', 'Attendance Refresh Post', false);

insert into public.schedules (id, week_starts_on, revision, status, created_by)
values ('fa140000-0000-4000-8000-000000000001', date '2099-01-04', 1, 'draft', 'fa110000-0000-4000-8000-000000000001');

insert into public.shifts (
  id, schedule_id, post_id, starts_at, ends_at, headcount_required, created_by
)
values (
  'fa150000-0000-4000-8000-000000000001',
  'fa140000-0000-4000-8000-000000000001',
  'fa130000-0000-4000-8000-000000000001',
  timestamptz '2026-09-09 23:00:00+00',
  timestamptz '2026-09-11 23:00:00+00',
  2,
  'fa110000-0000-4000-8000-000000000001'
);

insert into public.shift_assignments (id, shift_id, employee_id, assigned_by)
values
  ('fa160000-0000-4000-8000-000000000001', 'fa150000-0000-4000-8000-000000000001', 'fa110000-0000-4000-8000-000000000001', 'fa110000-0000-4000-8000-000000000001'),
  ('fa160000-0000-4000-8000-000000000002', 'fa150000-0000-4000-8000-000000000001', 'fa110000-0000-4000-8000-000000000002', 'fa110000-0000-4000-8000-000000000001');

update public.schedules
set status = 'published',
    published_at = clock_timestamp(),
    published_by = 'fa110000-0000-4000-8000-000000000001'
where id = 'fa140000-0000-4000-8000-000000000001';

update public.schedules
set status = 'superseded'
where id = 'fa140000-0000-4000-8000-000000000001';

insert into public.schedules (id, week_starts_on, revision, status, previous_revision_id, created_by)
values (
  'fa140000-0000-4000-8000-000000000002',
  date '2099-01-04',
  2,
  'draft',
  'fa140000-0000-4000-8000-000000000001',
  'fa110000-0000-4000-8000-000000000001'
);

insert into public.shifts (
  id, schedule_id, post_id, starts_at, ends_at, headcount_required, created_by
)
values (
  'fa150000-0000-4000-8000-000000000002',
  'fa140000-0000-4000-8000-000000000002',
  'fa130000-0000-4000-8000-000000000001',
  timestamptz '2026-09-09 23:00:00+00',
  timestamptz '2026-09-11 23:00:00+00',
  3,
  'fa110000-0000-4000-8000-000000000001'
), (
  'fa150000-0000-4000-8000-000000000003',
  'fa140000-0000-4000-8000-000000000002',
  'fa130000-0000-4000-8000-000000000001',
  timestamptz '2026-09-12 00:00:00+00',
  timestamptz '2026-09-12 08:00:00+00',
  1,
  'fa110000-0000-4000-8000-000000000001'
);

update public.shifts
set assignment_type = 'dispatch_phone_duty'
where id = 'fa150000-0000-4000-8000-000000000003';

insert into public.shift_assignments (id, shift_id, employee_id, assigned_by)
values
  ('fa160000-0000-4000-8000-000000000003', 'fa150000-0000-4000-8000-000000000002', 'fa110000-0000-4000-8000-000000000002', 'fa110000-0000-4000-8000-000000000001'),
  ('fa160000-0000-4000-8000-000000000004', 'fa150000-0000-4000-8000-000000000002', 'fa110000-0000-4000-8000-000000000003', 'fa110000-0000-4000-8000-000000000001'),
  ('fa160000-0000-4000-8000-000000000005', 'fa150000-0000-4000-8000-000000000002', 'fa110000-0000-4000-8000-000000000004', 'fa110000-0000-4000-8000-000000000001'),
  ('fa160000-0000-4000-8000-000000000006', 'fa150000-0000-4000-8000-000000000003', 'fa110000-0000-4000-8000-000000000005', 'fa110000-0000-4000-8000-000000000001');

insert into public.timekeeping_operational_exceptions (
  id, employee_id, shift_id, exception_code, scheduled_start_at, scheduled_end_at
)
values
  ('fa170000-0000-4000-8000-000000000001', 'fa110000-0000-4000-8000-000000000001', 'fa150000-0000-4000-8000-000000000001', 'missing_clock_in', '2026-09-09 23:00:00+00', '2026-09-11 23:00:00+00'),
  ('fa170000-0000-4000-8000-000000000002', 'fa110000-0000-4000-8000-000000000002', 'fa150000-0000-4000-8000-000000000001', 'missing_clock_in', '2026-09-09 23:00:00+00', '2026-09-11 23:00:00+00'),
  ('fa170000-0000-4000-8000-000000000003', 'fa110000-0000-4000-8000-000000000003', 'fa150000-0000-4000-8000-000000000002', 'missing_clock_in', '2026-09-09 23:00:00+00', '2026-09-11 23:00:00+00');

-- Both database boundaries must refuse salary and supplemental Dispatch
-- missing-clock records rather than creating alerts that later need cleanup.
insert into public.timekeeping_operational_exceptions (
  id, employee_id, shift_id, exception_code, scheduled_start_at, scheduled_end_at
)
values
  ('fa170000-0000-4000-8000-000000000004', 'fa110000-0000-4000-8000-000000000004', 'fa150000-0000-4000-8000-000000000002', 'missing_clock_in', '2026-09-09 23:00:00+00', '2026-09-11 23:00:00+00'),
  ('fa170000-0000-4000-8000-000000000005', 'fa110000-0000-4000-8000-000000000005', 'fa150000-0000-4000-8000-000000000003', 'missing_clock_in', '2026-09-12 00:00:00+00', '2026-09-12 08:00:00+00');

do $$
begin
  if exists (
    select 1 from public.timekeeping_operational_exceptions
    where id in ('fa170000-0000-4000-8000-000000000004', 'fa170000-0000-4000-8000-000000000005')
  ) then
    raise exception 'Salary or supplemental Dispatch missing-clock exception was not blocked.';
  end if;
end
$$;

insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
select id, 'created', 'Regression fixture: missing clock-in.', null, to_jsonb(exception)
from public.timekeeping_operational_exceptions exception
where id in (
  'fa170000-0000-4000-8000-000000000001',
  'fa170000-0000-4000-8000-000000000002',
  'fa170000-0000-4000-8000-000000000003'
);

insert into public.operational_alerts (
  id, alert_type, title, summary, employee_id, shift_id,
  related_record_type, related_record_id, audience_roles, direct_path, deduplication_key
)
values
  ('fa180000-0000-4000-8000-000000000001', 'missing_clock_in', 'Missing clock-in', 'Revision fixture', 'fa110000-0000-4000-8000-000000000001', 'fa150000-0000-4000-8000-000000000001', 'timekeeping_operational_exception', 'fa170000-0000-4000-8000-000000000001', array['admin']::public.app_role[], '/time/exceptions', 'attendance-refresh-revision'),
  ('fa180000-0000-4000-8000-000000000003', 'missing_clock_in', 'Missing clock-in', 'Restoration fixture', 'fa110000-0000-4000-8000-000000000003', 'fa150000-0000-4000-8000-000000000002', 'timekeeping_operational_exception', 'fa170000-0000-4000-8000-000000000003', array['admin']::public.app_role[], '/time/exceptions', 'attendance-refresh-restored');

update public.schedules
set status = 'published',
    published_at = clock_timestamp(),
    published_by = 'fa110000-0000-4000-8000-000000000001'
where id = 'fa140000-0000-4000-8000-000000000002';

set constraints all immediate;

do $$
begin
  if not exists (
    select 1
    from public.timekeeping_operational_exceptions
    where id = 'fa170000-0000-4000-8000-000000000001'
      and status = 'resolved'
      and resolution_method = 'schedule_revised'
  ) then
    raise exception 'Published revision did not resolve the removed employee occurrence.';
  end if;

  if not exists (
    select 1
    from public.timekeeping_operational_exception_actions
    where exception_id = 'fa170000-0000-4000-8000-000000000001'
      and action = 'resolved_schedule_revised'
  ) then
    raise exception 'Schedule-revision resolution was not audited.';
  end if;

  if not exists (
    select 1
    from public.operational_alerts
    where id = 'fa180000-0000-4000-8000-000000000001'
      and active = false
      and lifecycle_state = 'resolved'
  ) then
    raise exception 'Stale revision alert was not cleared.';
  end if;

  if not exists (
    select 1
    from public.timekeeping_operational_exceptions
    where id = 'fa170000-0000-4000-8000-000000000002'
      and status = 'unresolved'
  ) then
    raise exception 'Equivalent overnight assignment was incorrectly resolved.';
  end if;
end
$$;

update public.shift_assignments
set status = 'canceled', canceled_at = clock_timestamp(), cancellation_reason = 'Regression removal'
where id = 'fa160000-0000-4000-8000-000000000004';

do $$
begin
  if not exists (
    select 1
    from public.timekeeping_operational_exceptions
    where id = 'fa170000-0000-4000-8000-000000000003'
      and status = 'resolved'
      and resolution_method = 'assignment_changed'
  ) then
    raise exception 'Assignment removal did not resolve the current occurrence.';
  end if;
end
$$;

update public.shift_assignments
set status = 'assigned', canceled_at = null, cancellation_reason = null
where id = 'fa160000-0000-4000-8000-000000000004';

-- Repeated calls after the trigger-driven refresh must be state- and
-- history-idempotent.
do $$
declare
  refresh_result jsonb;
begin
  refresh_result := private.refresh_attendance_alert_schedule_state(
    date '2099-01-04',
    'fa110000-0000-4000-8000-000000000003',
    true
  );
  if (refresh_result ->> 'reopenedExceptionCount')::integer <> 0
     or (refresh_result ->> 'reactivatedAlertCount')::integer <> 0
     or (refresh_result ->> 'resolvedExceptionCount')::integer <> 0
     or (refresh_result ->> 'clearedAlertCount')::integer <> 0 then
    raise exception 'First repeated refresh changed settled state: %.', refresh_result;
  end if;

  refresh_result := private.refresh_attendance_alert_schedule_state(
    date '2099-01-04',
    'fa110000-0000-4000-8000-000000000003',
    true
  );
  if (refresh_result ->> 'reopenedExceptionCount')::integer <> 0
     or (refresh_result ->> 'reactivatedAlertCount')::integer <> 0
     or (refresh_result ->> 'resolvedExceptionCount')::integer <> 0
     or (refresh_result ->> 'clearedAlertCount')::integer <> 0 then
    raise exception 'Second repeated refresh changed settled state: %.', refresh_result;
  end if;
end
$$;

do $$
declare
  reopened_count integer;
  resolved_count integer;
begin
  if not exists (
    select 1
    from public.timekeeping_operational_exceptions
    where id = 'fa170000-0000-4000-8000-000000000003'
      and status = 'unresolved'
  ) then
    raise exception 'Restored assignment did not reopen the missing-clock occurrence.';
  end if;

  select count(*) into reopened_count
  from public.timekeeping_operational_exception_actions
  where exception_id = 'fa170000-0000-4000-8000-000000000003'
    and action = 'reopened';

  select count(*) into resolved_count
  from public.timekeeping_operational_exception_actions
  where exception_id = 'fa170000-0000-4000-8000-000000000003'
    and action = 'resolved_assignment_changed';

  if reopened_count <> 1 or resolved_count <> 1 then
    raise exception 'Repeated refresh was not idempotent (reopened %, resolved %).', reopened_count, resolved_count;
  end if;

  if not exists (
    select 1
    from public.operational_alerts
    where id = 'fa180000-0000-4000-8000-000000000003'
      and lifecycle_state <> 'resolved'
  ) then
    raise exception 'Restored assignment alert did not return to an actionable lifecycle state.';
  end if;
end
$$;

rollback;

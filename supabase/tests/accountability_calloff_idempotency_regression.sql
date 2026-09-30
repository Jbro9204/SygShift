begin;

set local statement_timeout = '45s';

do $$
declare
  manager_auth_user_id uuid;
  manager_employee_id uuid;
  employee_auth_user_id uuid;
  target_employee_id uuid;
  current_shift_id uuid;
  current_shift public.shifts%rowtype;
  current_schedule public.schedules%rowtype;
  stale_schedule_id uuid;
  stale_shift_id uuid;
  stale_revision integer;
  self_result jsonb;
  legacy_call_off_id uuid;
  manager_result jsonb;
  stale_retry_result jsonb;
  coverage_result jsonb;
  event_id uuid;
  call_off_id uuid;
  original_assignment_id uuid;
  original_note text;
begin
  select account.auth_user_id, employee.id
  into manager_auth_user_id, manager_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and 'accountability.create' = any(private.employee_effective_permissions(employee.id))
    and coalesce(private.employee_effective_permissions(employee.id), array[]::text[])
      && array['requests.manage', 'shift_pool.manage', 'announcements.send', 'schedule.manage']::text[]
  order by (employee.role = 'admin') desc, employee.created_at
  limit 1;

  select
    account.auth_user_id,
    employee.id,
    shift.id,
    assignment.id
  into
    employee_auth_user_id,
    target_employee_id,
    current_shift_id,
    original_assignment_id
  from public.shifts shift
  join public.schedules schedule
    on schedule.id = shift.schedule_id
   and schedule.status = 'published'
  join public.shift_assignments assignment
    on assignment.shift_id = shift.id
   and assignment.status in ('assigned', 'confirmed')
   and assignment.canceled_at is null
  join public.employees employee
    on employee.id = assignment.employee_id
   and employee.status = 'active'
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.auth_user_id is not null
   and account.disabled_at is null
  where shift.canceled_at is null
    and shift.ends_at > clock_timestamp() + interval '2 hours'
    and not exists (
      select 1
      from public.attendance_accountability_events event
      where event.employee_id = employee.id
        and event.shift_id is not null
        and event.status <> 'voided'
        and private.same_scheduled_occurrence(event.shift_id, shift.id)
        and event.event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
    )
    and not exists (
      select 1
      from public.call_off_reports report
      where report.employee_id = employee.id
        and report.canceled_at is null
        and private.same_scheduled_occurrence(report.shift_id, shift.id)
    )
  order by shift.starts_at
  limit 1;

  select * into current_shift
  from public.shifts shift
  where shift.id = current_shift_id;

  assert manager_auth_user_id is not null and manager_employee_id is not null,
    'The regression requires an MFA-capable coverage manager.';
  assert employee_auth_user_id is not null and current_shift.id is not null,
    'The regression requires a future assigned shift with a linked employee account.';

  select * into current_schedule
  from public.schedules schedule
  where schedule.id = current_shift.schedule_id;

  select coalesce(max(schedule.revision), 0) + 1000
  into stale_revision
  from public.schedules schedule
  where schedule.week_starts_on = current_schedule.week_starts_on;

  insert into public.schedules (
    week_starts_on, revision, status, previous_revision_id, created_by
  ) values (
    current_schedule.week_starts_on,
    stale_revision,
    'superseded',
    current_schedule.id,
    manager_employee_id
  ) returning id into stale_schedule_id;

  insert into public.shifts (
    schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, is_overtime, notes,
    created_by, work_type, assignment_type
  ) values (
    stale_schedule_id,
    current_shift.post_id,
    current_shift.event_id,
    current_shift.starts_at,
    current_shift.ends_at,
    current_shift.time_zone,
    current_shift.headcount_required,
    current_shift.requires_armed,
    current_shift.is_open,
    current_shift.is_overtime,
    current_shift.notes,
    manager_employee_id,
    current_shift.work_type,
    current_shift.assignment_type
  ) returning id into stale_shift_id;

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by
  ) values (
    stale_shift_id, target_employee_id, 'assigned', manager_employee_id
  );

  assert private.same_scheduled_occurrence(stale_shift_id, current_shift.id),
    'The rollback fixture did not create equivalent schedule revisions.';

  perform set_config('request.jwt.claim.sub', employee_auth_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', employee_auth_user_id, 'role', 'authenticated', 'aal', 'aal1'
  )::text, true);

  self_result := public.report_attendance_accountability_event(
    stale_shift_id,
    'call_off',
    null,
    'Rollback-only employee self-report retained as the original factual note.'
  );
  event_id := (self_result ->> 'id')::uuid;
  call_off_id := (self_result ->> 'callOffId')::uuid;
  original_note := self_result ->> 'note';

  assert coalesce((self_result ->> 'created')::boolean, false),
    'The first self-report was not created.';
  assert (self_result ->> 'shiftId')::uuid = current_shift.id,
    'The stale superseded shift did not canonicalize to the current published assignment.';
  assert call_off_id is not null,
    'The self-report did not create the durable call-off handoff.';

  legacy_call_off_id := public.report_call_off(
    stale_shift_id,
    'Rollback-only legacy RPC retry must reuse the original occurrence.'
  );
  assert legacy_call_off_id = call_off_id,
    'The legacy employee call-off RPC bypassed canonical idempotency.';

  perform set_config('request.jwt.claim.sub', manager_auth_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', manager_auth_user_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);

  manager_result := public.create_attendance_accountability_event_v2(
    target_employee_id,
    current_shift.id,
    'call_off',
    null,
    'Rollback-only manager retry must not replace the employee note.',
    null
  );
  stale_retry_result := public.create_attendance_accountability_event_v2(
    target_employee_id,
    stale_shift_id,
    'call_off',
    null,
    'Rollback-only stale retry must reuse the same occurrence.',
    null
  );

  assert (manager_result ->> 'id')::uuid = event_id
    and (stale_retry_result ->> 'id')::uuid = event_id,
    'Exact/current and stale-revision retries did not return the canonical event.';
  assert (manager_result ->> 'callOffId')::uuid = call_off_id
    and (stale_retry_result ->> 'callOffId')::uuid = call_off_id,
    'Retries did not return the canonical coverage handoff.';
  assert not coalesce((manager_result ->> 'created')::boolean, true)
    and not coalesce((stale_retry_result ->> 'created')::boolean, true),
    'A retry was incorrectly reported as a new occurrence.';

  assert (
    select count(*) = 1
    from public.attendance_accountability_events event
    where event.employee_id = target_employee_id
      and event.shift_id is not null
      and event.status <> 'voided'
      and event.duplicate_of_event_id is null
      and private.same_scheduled_occurrence(event.shift_id, current_shift.id)
      and event.event_type in ('called_in_sick', 'call_off', 'no_call_no_show')
  ), 'The logical absence created more than one canonical Accountability event.';

  assert (
    select count(*) = 1
    from public.call_off_reports report
    where report.employee_id = target_employee_id
      and report.canceled_at is null
      and report.duplicate_of_call_off_report_id is null
      and private.same_scheduled_occurrence(report.shift_id, current_shift.id)
  ), 'The logical absence created more than one canonical call-off report.';

  assert (
    select count(*) = 1
    from public.call_off_report_actions action
    where action.call_off_report_id = call_off_id
      and action.action = 'created'
  ), 'A retry duplicated the append-only call-off creation action.';

  assert (
    select count(*) = 1
    from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id = call_off_id
  ), 'A retry duplicated the operational coverage alert.';

  assert (
    select event.note = original_note
    from public.attendance_accountability_events event
    where event.id = event_id
  ), 'A manager retry rewrote the employee''s original factual note.';

  assert exists (
    select 1
    from public.shift_assignments assignment
    where assignment.id = original_assignment_id
      and assignment.employee_id = target_employee_id
      and assignment.shift_id = current_shift.id
      and assignment.status in ('assigned', 'confirmed')
      and assignment.canceled_at is null
  ), 'Recording or retrying the call-off changed the original assignment.';

  coverage_result := public.resolve_call_off_coverage(
    call_off_id,
    'no_replacement',
    null,
    null,
    null,
    'Rollback-only terminal coverage decision clears the operational alert.',
    false,
    gen_random_uuid()
  );

  assert coverage_result ->> 'status' = 'no_replacement',
    'The terminal coverage decision did not complete.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id = call_off_id
      and not alert.active
      and alert.lifecycle_state = 'resolved'
      and alert.clear_source = 'automatic_resolution'
  ), 'The terminal coverage decision left its operational alert active.';

  raise notice 'Call-off self-report, legacy RPC compatibility, revision canonicalization, idempotent manager retry, audit preservation, and alert cleanup passed.';
end
$$;

rollback;

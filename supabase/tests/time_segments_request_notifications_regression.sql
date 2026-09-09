-- Transaction body. Run after the migration inside one BEGIN / ROLLBACK.
do $$
declare
  admin_employee uuid := '8f100000-0000-4000-8000-000000000001';
  admin_auth uuid := '8f200000-0000-4000-8000-000000000001';
  guard_employee uuid := '8f100000-0000-4000-8000-000000000002';
  guard_auth uuid := '8f200000-0000-4000-8000-000000000002';
  site_id uuid := '8f300000-0000-4000-8000-000000000001';
  post_id uuid := '8f400000-0000-4000-8000-000000000001';
  schedule_id uuid := '8f500000-0000-4000-8000-000000000001';
  fixture_shift_id uuid := '8f600000-0000-4000-8000-000000000001';
  expired_shift_id uuid := '8f600000-0000-4000-8000-000000000002';
  request_id uuid := '8f700000-0000-4000-8000-000000000001';
  second_request_id uuid := '8f700000-0000-4000-8000-000000000002';
  result jsonb;
  action_notification_id uuid;
begin
  insert into public.employees(id, first_name, last_name, role)
  values
    (admin_employee, 'Workflow', 'Admin', 'admin'),
    (guard_employee, 'Segment', 'Guard', 'guard');

  insert into auth.users(id, email)
  values
    (admin_auth, 'workflow-admin@example.invalid'),
    (guard_auth, 'segment-guard@example.invalid');

  insert into private.employee_accounts(employee_id, auth_user_id, activated_at)
  values
    (admin_employee, admin_auth, clock_timestamp()),
    (guard_employee, guard_auth, clock_timestamp());

  insert into public.sites(id, code, name, time_zone)
  values(site_id, 'SEGMENT-TEST', 'Segment Test Site', 'America/Denver');
  insert into public.posts(id, site_id, name)
  values(post_id, site_id, 'Segment Test Post');
  insert into public.schedules(id, week_starts_on, revision, status, created_by)
  values(schedule_id, current_date + 3500, 1, 'draft', admin_employee);
  insert into public.shifts(id, schedule_id, post_id, starts_at, ends_at, time_zone, created_by)
  values
    (fixture_shift_id, schedule_id, post_id, clock_timestamp() - interval '10 hours', clock_timestamp() - interval '2 hours', 'America/Denver', admin_employee),
    (expired_shift_id, schedule_id, post_id, clock_timestamp() - interval '20 hours', clock_timestamp() - interval '12 hours', 'America/Denver', admin_employee);
  insert into public.shift_assignments(shift_id, employee_id, status, assigned_by)
  values
    (fixture_shift_id, guard_employee, 'assigned', admin_employee),
    (expired_shift_id, guard_employee, 'assigned', admin_employee);
  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = admin_employee
  where id = schedule_id;

  insert into public.time_events(employee_id, shift_id, kind, recorded_at, source, idempotency_key, created_by)
  values
    (guard_employee, fixture_shift_id, 'clock_in', clock_timestamp() - interval '10 hours', 'web', 'segment-regression-in', guard_employee),
    (guard_employee, fixture_shift_id, 'clock_out', clock_timestamp() - interval '3 hours', 'web', 'segment-regression-out', guard_employee);

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', guard_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  result := public.record_time_event('clock_in', fixture_shift_id, null, 'segment-regression-resume');
  assert result ->> 'kind' = 'clock_in', 'Same-shift return creates a new clock-in segment';
  assert (select count(*) from public.time_events event where event.employee_id = guard_employee and event.shift_id = fixture_shift_id) = 3,
    'Original punches remain and a third append-only event is added';
  assert exists(
    select 1 from public.time_events
    where employee_id = guard_employee and time_events.shift_id = fixture_shift_id and kind = 'clock_out' and idempotency_key = 'segment-regression-out'
  ), 'The appointment clock-out remains immutable';

  insert into public.time_events(employee_id, shift_id, kind, recorded_at, source, idempotency_key, created_by)
  values(guard_employee, expired_shift_id, 'clock_out', clock_timestamp() + interval '1 second', 'web', 'segment-regression-expired-out', guard_employee);
  begin
    perform public.record_time_event('clock_in', expired_shift_id, null, 'segment-regression-too-late');
    raise exception 'Resume after the six-hour reconciliation window was accepted';
  exception when check_violation then null;
  end;

  insert into public.time_off_requests(id, employee_id, starts_on, ends_on, reason)
  values(request_id, guard_employee, current_date + 30, current_date + 30, 'Rollback-only request routing fixture.');

  select notification.id into action_notification_id
  from public.employee_notifications notification
  where notification.source_type = 'time_off_request'
    and notification.source_id = request_id
    and notification.recipient_employee_id = admin_employee
    and notification.action_required
    and notification.resolved_at is null;
  assert action_notification_id is not null, 'Authorized reviewer receives an open action notification';
  assert not exists(
    select 1 from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = request_id
      and notification.recipient_employee_id = guard_employee
      and notification.action_required
  ), 'Requester is excluded from their own review action';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', admin_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  result := public.get_my_notification_badge();
  assert (result ->> 'requiresAction')::integer >= 1, 'Open workflow work appears in the notification badge';
  begin
    perform public.dismiss_my_notification(action_notification_id);
    raise exception 'Open workflow action was dismissible';
  exception when check_violation then null;
  end;

  update public.time_off_requests
  set status = 'approved', decided_by = admin_employee, decided_at = clock_timestamp(), decision_note = 'Approved regression fixture.'
  where id = request_id;
  assert exists(
    select 1 from public.employee_notifications notification
    where notification.id = action_notification_id and notification.resolved_at is not null
  ), 'Reviewer action resolves when the authoritative request is decided';
  assert exists(
    select 1 from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = request_id
      and notification.recipient_employee_id = guard_employee
      and notification.title = 'Time request updated'
      and notification.body = 'Your request status is now approved.'
  ), 'Requester receives a privacy-safe outcome notification';

  insert into public.time_off_requests(id, employee_id, starts_on, ends_on, reason)
  values(second_request_id, guard_employee, current_date + 31, current_date + 31, 'Clear-all workflow protection fixture.');
  result := public.clear_my_notifications();
  assert exists(
    select 1 from public.employee_notifications notification
    where notification.source_type = 'time_off_request'
      and notification.source_id = second_request_id
      and notification.recipient_employee_id = admin_employee
      and notification.dismissed_at is null
      and notification.resolved_at is null
  ), 'Clear all preserves unresolved workflow actions';

  assert has_function_privilege('authenticated', 'public.get_my_notifications(text,text,integer,integer)', 'EXECUTE'),
    'Authenticated employees can read their protected notification inbox';
  assert not has_function_privilege('anon', 'public.get_my_notifications(text,text,integer,integer)', 'EXECUTE'),
    'Anonymous callers cannot read employee notifications';
  assert not has_function_privilege('authenticated', 'private.notify_authorized_workflow_reviewers(text,uuid,uuid,text[],uuid,text,text,text,text,text,boolean,uuid)', 'EXECUTE'),
    'Workflow recipient routing remains private';
end
$$;

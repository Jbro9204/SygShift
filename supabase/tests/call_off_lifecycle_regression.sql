-- Run against a database with the call-off lifecycle repair installed.
-- Every synthetic employee, schedule, call-off, alert, notification, and
-- coverage record remains inside this transaction and is rolled back.

begin;

set local statement_timeout = '60s';

do $$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  target_employee_id constant uuid := 'ca110000-0000-4000-8000-000000000001';
  requester_employee_id constant uuid := 'ca110000-0000-4000-8000-000000000002';
  site_id constant uuid := 'ca120000-0000-4000-8000-000000000001';
  post_id constant uuid := 'ca130000-0000-4000-8000-000000000001';
  published_schedule_id constant uuid := 'ca140000-0000-4000-8000-000000000001';
  historical_schedule_id constant uuid := 'ca140000-0000-4000-8000-000000000002';
  future_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000001';
  no_replacement_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000002';
  resolved_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000003';
  canceled_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000004';
  grace_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000005';
  expired_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000006';
  coverage_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000007';
  overnight_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000008';
  post_cutoff_no_replacement_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000009';
  settled_no_replacement_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000010';
  unresolved_no_replacement_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000011';
  unresolved_duplicate_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000012';
  terminal_replay_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000013';
  foreign_replay_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000014';
  request_staging_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000015';
  divergence_covered_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000016';
  divergence_no_replacement_shift_id constant uuid := 'ca150000-0000-4000-8000-000000000017';
  future_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000001';
  no_replacement_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000002';
  expired_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000003';
  overnight_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000004';
  grace_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000005';
  terminal_replay_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000006';
  foreign_replay_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000007';
  divergence_covered_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000008';
  divergence_no_replacement_assignment_id constant uuid := 'ca160000-0000-4000-8000-000000000009';
  resolved_report_id constant uuid := 'ca170000-0000-4000-8000-000000000001';
  canceled_report_id constant uuid := 'ca170000-0000-4000-8000-000000000002';
  grace_report_id constant uuid := 'ca170000-0000-4000-8000-000000000003';
  expired_report_id constant uuid := 'ca170000-0000-4000-8000-000000000004';
  overnight_report_id constant uuid := 'ca170000-0000-4000-8000-000000000005';
  post_cutoff_no_replacement_report_id constant uuid := 'ca170000-0000-4000-8000-000000000006';
  duplicate_report_id constant uuid := 'ca170000-0000-4000-8000-000000000007';
  settled_no_replacement_report_id constant uuid := 'ca170000-0000-4000-8000-000000000008';
  unresolved_no_replacement_report_id constant uuid := 'ca170000-0000-4000-8000-000000000009';
  unresolved_duplicate_report_id constant uuid := 'ca170000-0000-4000-8000-000000000010';
  terminal_replay_report_id constant uuid := 'ca170000-0000-4000-8000-000000000011';
  foreign_replay_report_id constant uuid := 'ca170000-0000-4000-8000-000000000012';
  divergence_covered_report_id constant uuid := 'ca170000-0000-4000-8000-000000000013';
  divergence_no_replacement_report_id constant uuid := 'ca170000-0000-4000-8000-000000000014';
  orphan_report_id constant uuid := 'ca170000-0000-4000-8000-000000000099';
  resolved_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000001';
  canceled_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000002';
  grace_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000003';
  expired_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000004';
  overnight_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000005';
  divergence_covered_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000006';
  divergence_no_replacement_alert_id constant uuid := 'ca180000-0000-4000-8000-000000000007';
  future_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000001';
  resolved_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000002';
  canceled_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000003';
  grace_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000004';
  expired_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000005';
  overnight_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000006';
  grace_patrol_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000007';
  orphan_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000099';
  divergence_covered_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000008';
  divergence_no_replacement_notification_id constant uuid := 'ca190000-0000-4000-8000-000000000009';
  expired_coverage_case_id constant uuid := 'caa00000-0000-4000-8000-000000000001';
  grace_coverage_case_id constant uuid := 'caa00000-0000-4000-8000-000000000002';
  divergence_covered_case_id constant uuid := 'caa00000-0000-4000-8000-000000000003';
  divergence_no_replacement_case_id constant uuid := 'caa00000-0000-4000-8000-000000000004';
  expired_coverage_action_id constant uuid := 'cab00000-0000-4000-8000-000000000001';
  grace_coverage_action_id constant uuid := 'cab00000-0000-4000-8000-000000000002';
  divergence_covered_action_id constant uuid := 'cab00000-0000-4000-8000-000000000003';
  divergence_no_replacement_action_id constant uuid := 'cab00000-0000-4000-8000-000000000004';
  expired_coverage_wave_id constant uuid := 'cac00000-0000-4000-8000-000000000001';
  coverage_announcement_id constant uuid := 'cad00000-0000-4000-8000-000000000001';
  coverage_request_id constant uuid := 'cae00000-0000-4000-8000-000000000001';
  late_coverage_request_id constant uuid := 'cae00000-0000-4000-8000-000000000002';
  staging_coverage_request_id constant uuid := 'cae00000-0000-4000-8000-000000000003';
  owner_pending_request_id constant uuid := 'cae00000-0000-4000-8000-000000000004';
  terminal_replay_key constant uuid := 'caf00000-0000-4000-8000-000000000006';
  actor_push_subscription_id constant uuid := 'caf10000-0000-4000-8000-000000000001';
  orphan_alert_id constant uuid := 'caf20000-0000-4000-8000-000000000001';
  orphan_outbox_id constant uuid := 'caf30000-0000-4000-8000-000000000001';
  future_result jsonb;
  no_replacement_result jsonb;
  grace_update_result jsonb;
  grace_coverage_result jsonb;
  terminal_coverage_result jsonb;
  terminal_coverage_replay_result jsonb;
  first_reconciliation jsonb;
  second_reconciliation jsonb;
  claimed_delivery_batch jsonb;
  claimed_employee_email_batch jsonb;
  claimed_push_batch jsonb;
  stale_wave_result jsonb;
  terminal_coverage_workspace jsonb;
  future_report_id uuid;
  no_replacement_report_id uuid;
  initial_report_count integer;
  initial_alert_count integer;
  initial_action_count integer;
  initial_notification_count integer;
  initial_coverage_case_count integer;
  initial_coverage_action_count integer;
  initial_system_resolution_action_count integer;
  settled_report_count integer;
  settled_alert_count integer;
  settled_action_count integer;
  settled_notification_count integer;
  settled_coverage_case_count integer;
  settled_coverage_action_count integer;
  settled_system_resolution_action_count integer;
  settled_coverage_announcement_expires_at timestamptz;
  stale_wave_notification_count integer;
  post_cutoff_reopen_blocked boolean := false;
  legacy_reopen_blocked boolean := false;
  canceled_reopen_blocked boolean := false;
  no_replacement_coverage_blocked boolean := false;
  resolved_coverage_blocked boolean := false;
  duplicate_coverage_blocked boolean := false;
  cutoff_coverage_blocked boolean := false;
  terminal_shift_request_blocked boolean := false;
  late_shift_request_insert_blocked boolean := false;
  terminal_shift_request_reopen_blocked boolean := false;
  terminal_shift_request_move_blocked boolean := false;
  terminal_coverage_case_reopen_blocked boolean := false;
  foreign_replay_blocked boolean := false;
  raw_shift_request_update_blocked boolean := false;
  owner_withdrawal_result boolean := false;
  coverage_workspace_failed_closed boolean := false;
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.activated_at is not null
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and 'accountability.report_call_off' = any(private.employee_effective_permissions(employee.id))
    and 'requests.manage' = any(private.employee_effective_permissions(employee.id))
    and 'patrol.assignments.manage' = any(private.employee_effective_permissions(employee.id))
  order by (employee.role = 'admin') desc, employee.created_at, employee.id
  limit 1;

  assert actor_auth_user_id is not null and actor_employee_id is not null,
    'The regression requires one active MFA-capable call-off manager.';

  insert into public.employees (
    id, username, first_name, last_name, role, employment_type, status, time_zone
  ) values
    (
      target_employee_id, 'callofflifecycleregression', 'Calloff', 'Lifecycle',
      'guard', 'hourly', 'active', 'America/Denver'
    ),
    (
      requester_employee_id, 'callofflifecyclecandidate', 'Coverage', 'Candidate',
      'guard', 'flex', 'active', 'America/Denver'
    );

  insert into public.sites (id, code, name, time_zone)
  values (site_id, 'CALLOFF-LIFECYCLE', 'Call-Off Lifecycle Regression', 'America/Denver');

  insert into public.posts (id, site_id, name, requires_armed)
  values (post_id, site_id, 'Lifecycle Post', false);

  insert into public.schedules (
    id, week_starts_on, revision, status, created_by
  ) values
    (published_schedule_id, date '2099-10-04', 1, 'draft', actor_employee_id),
    (historical_schedule_id, date '2098-12-07', 1, 'superseded', actor_employee_id);

  insert into public.shifts (
    id, schedule_id, post_id, starts_at, ends_at, time_zone,
    headcount_required, is_open, created_by
  ) values
    (
      future_shift_id, published_schedule_id, post_id,
      timestamptz '2099-10-05 14:00:00+00', timestamptz '2099-10-05 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      no_replacement_shift_id, published_schedule_id, post_id,
      timestamptz '2099-10-06 14:00:00+00', timestamptz '2099-10-06 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      resolved_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-07 14:00:00+00', timestamptz '2099-10-07 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      canceled_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-08 14:00:00+00', timestamptz '2099-10-08 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      grace_shift_id, historical_schedule_id, post_id,
      clock_timestamp() - interval '8 hours', clock_timestamp() - interval '30 minutes',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      expired_shift_id, historical_schedule_id, post_id,
      clock_timestamp() - interval '17 hours', clock_timestamp() - interval '9 hours',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      coverage_shift_id, historical_schedule_id, post_id,
      clock_timestamp() - interval '17 hours', clock_timestamp() - interval '9 hours',
      'America/Denver', 1, true, actor_employee_id
    ),
    (
      overnight_shift_id, historical_schedule_id, post_id,
      timestamptz '2026-03-08 05:00:00+00', timestamptz '2026-03-08 12:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      post_cutoff_no_replacement_shift_id, historical_schedule_id, post_id,
      timestamptz '2026-03-09 14:00:00+00', timestamptz '2026-03-09 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      settled_no_replacement_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-09 14:00:00+00', timestamptz '2099-10-09 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      unresolved_no_replacement_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-10 14:00:00+00', timestamptz '2099-10-10 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      unresolved_duplicate_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-11 14:00:00+00', timestamptz '2099-10-11 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      terminal_replay_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-12 14:00:00+00', timestamptz '2099-10-12 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      foreign_replay_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-13 14:00:00+00', timestamptz '2099-10-13 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      request_staging_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-14 14:00:00+00', timestamptz '2099-10-14 22:00:00+00',
      'America/Denver', 1, true, actor_employee_id
    ),
    (
      divergence_covered_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-15 14:00:00+00', timestamptz '2099-10-15 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    ),
    (
      divergence_no_replacement_shift_id, historical_schedule_id, post_id,
      timestamptz '2099-10-16 14:00:00+00', timestamptz '2099-10-16 22:00:00+00',
      'America/Denver', 1, false, actor_employee_id
    );

  update public.shifts
  set coverage_source_shift_id = expired_shift_id
  where id = coverage_shift_id;

  insert into public.shift_assignments (id, shift_id, employee_id, status, assigned_by)
  values
    (future_assignment_id, future_shift_id, target_employee_id, 'assigned', actor_employee_id),
    (no_replacement_assignment_id, no_replacement_shift_id, target_employee_id, 'assigned', actor_employee_id),
    (grace_assignment_id, grace_shift_id, target_employee_id, 'assigned', actor_employee_id),
    (expired_assignment_id, expired_shift_id, target_employee_id, 'assigned', actor_employee_id),
    (overnight_assignment_id, overnight_shift_id, target_employee_id, 'assigned', actor_employee_id),
    (
      terminal_replay_assignment_id, terminal_replay_shift_id,
      target_employee_id, 'assigned', actor_employee_id
    ),
    (
      foreign_replay_assignment_id, foreign_replay_shift_id,
      target_employee_id, 'assigned', actor_employee_id
    ),
    (
      divergence_covered_assignment_id, divergence_covered_shift_id,
      target_employee_id, 'assigned', actor_employee_id
    ),
    (
      divergence_no_replacement_assignment_id, divergence_no_replacement_shift_id,
      target_employee_id, 'assigned', actor_employee_id
    );

  update public.schedules
  set status = 'published', published_at = clock_timestamp(), published_by = actor_employee_id
  where id = published_schedule_id;

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);
  perform set_config('sygshift.push_kicked', 'yes', true);

  -- Guarantee that a fresh notification identity also produces a distinct
  -- delivery row when a terminal report is legitimately reopened.
  insert into private.employee_push_subscriptions (
    id, employee_id, auth_session_id, endpoint, p256dh, auth_key
  ) values (
    actor_push_subscription_id,
    actor_employee_id,
    'caf10000-0000-4000-8000-000000000002',
    'https://push.invalid/call-off-lifecycle-regression',
    repeat('A', 87),
    repeat('B', 22)
  );

  future_result := public.report_employee_call_off(
    target_employee_id,
    future_shift_id,
    'other',
    clock_timestamp(),
    'Rollback-only future call-off.',
    'Must remain live while coverage is still needed.',
    true,
    'Synthetic future lifecycle fixture.'
  );
  future_report_id := (future_result ->> 'id')::uuid;

  no_replacement_result := public.report_employee_call_off(
    target_employee_id,
    no_replacement_shift_id,
    'other',
    clock_timestamp(),
    'Rollback-only no-replacement call-off.',
    'Must not create urgent work when coverage is explicitly unnecessary.',
    false,
    'Synthetic no-replacement lifecycle fixture.'
  );
  no_replacement_report_id := (no_replacement_result ->> 'id')::uuid;

  assert future_report_id is not null
    and coalesce((future_result ->> 'coverageRequired')::boolean, false),
    'The future replacement-needed fixture was not recorded as actionable.';
  assert no_replacement_report_id is not null
    and not coalesce((no_replacement_result ->> 'coverageRequired')::boolean, true),
    'The no-replacement fixture did not retain replacementNeeded=false.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = no_replacement_report_id
      and not report.replacement_needed
      and report.resolved_at is not null
      and report.resolution_outcome = 'no_replacement_required'
  ), 'replacementNeeded=false did not settle the call-off immediately.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id = no_replacement_report_id
      and not alert.active
      and alert.lifecycle_state = 'resolved'
      and alert.clear_source = 'automatic_resolution'
  ), 'replacementNeeded=false did not retain a resolved operational-alert record.';
  assert not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = no_replacement_report_id
      and notification.priority = 'urgent'
      and notification.action_required
      and notification.resolved_at is null
  ), 'replacementNeeded=false created an unresolved urgent workflow notification.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = no_replacement_report_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'replacementNeeded=false did not retain its notification as inactive history.';
  assert exists (
    select 1
    from private.notification_outbox outbox
    where outbox.message_type = 'call_off_supervisor_alert'
      and outbox.aggregate_type = 'call_off_report'
      and outbox.aggregate_id = no_replacement_report_id
      and outbox.delivered_at is null
      and outbox.failed_at is not null
  ), 'replacementNeeded=false left a supervisor-delivery outbox row claimable.';

  -- Source-less artifacts must fail closed. Implementations may reject the
  -- insert or retain an explicitly terminal record, but no orphan may remain
  -- actionable or eligible for a delivery claim.
  begin
    insert into public.employee_notifications (
      id, recipient_employee_id, sender_employee_id, source_type, source_id,
      source_key, title, body, priority, action_required, action_path, action_label
    ) values (
      orphan_notification_id,
      target_employee_id,
      actor_employee_id,
      'call_off_request',
      orphan_report_id,
      concat('call-off-lifecycle-orphan:', orphan_report_id),
      'Orphan call-off fixture',
      'A missing source report must never leave actionable work.',
      'urgent',
      true,
      concat('/requests?callOff=', orphan_report_id),
      'Open call-off'
    );
  exception
    when check_violation or foreign_key_violation then null;
  end;
  assert not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = orphan_report_id
      and notification.action_required
      and notification.resolved_at is null
  ), 'A missing call-off report left an actionable orphan notification.';

  begin
    insert into public.operational_alerts (
      id, alert_type, priority, title, summary, employee_id, shift_id,
      related_record_type, related_record_id, audience_roles, direct_path,
      deduplication_key
    ) values (
      orphan_alert_id,
      'employee_call_off',
      'urgent',
      'Orphan call-off alert fixture',
      'A missing source report must never leave a live operational alert.',
      target_employee_id,
      future_shift_id,
      'call_off_report',
      orphan_report_id,
      array['admin']::public.app_role[],
      concat('/requests?callOff=', orphan_report_id),
      concat('call-off-lifecycle-orphan:', orphan_report_id)
    );
  exception
    when check_violation or foreign_key_violation then null;
  end;
  assert not exists (
    select 1
    from public.operational_alerts alert
    where alert.alert_type = 'employee_call_off'
      and alert.related_record_type = 'call_off_report'
      and alert.related_record_id = orphan_report_id
      and alert.active
  ), 'A missing call-off report left a live orphan operational alert.';

  begin
    insert into private.notification_outbox (
      id, message_type, aggregate_type, aggregate_id, payload,
      idempotency_key, available_at
    ) values (
      orphan_outbox_id,
      'call_off_supervisor_alert',
      'call_off_report',
      orphan_report_id,
      jsonb_build_object('callOffReportId', orphan_report_id),
      concat('call-off-lifecycle-orphan:', orphan_report_id),
      timestamptz '1900-01-01 00:00:00+00'
    );
  exception
    when check_violation or foreign_key_violation then null;
  end;
  assert not exists (
    select 1
    from private.notification_outbox outbox
    where outbox.message_type = 'call_off_supervisor_alert'
      and outbox.aggregate_type = 'call_off_report'
      and outbox.aggregate_id = orphan_report_id
      and outbox.delivered_at is null
      and outbox.failed_at is null
  ), 'A missing call-off report left a claimable orphan supervisor outbox row.';

  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, call_received_at, received_by,
    reported_by, call_off_type, replacement_needed, operational_details
  ) values
    (
      resolved_report_id, resolved_shift_id, target_employee_id,
      'Rollback-only explicit resolution.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'Explicit terminal-state fixture.'
    ),
    (
      canceled_report_id, canceled_shift_id, target_employee_id,
      'Rollback-only explicit cancellation.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'Explicit cancellation fixture.'
    ),
    (
      grace_report_id, grace_shift_id, target_employee_id,
      'Rollback-only post-shift grace period.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'Still within the one-hour response window.'
    ),
    (
      terminal_replay_report_id, terminal_replay_shift_id, target_employee_id,
      'Rollback-only terminal idempotency replay.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'The first successful action will settle this report.'
    ),
    (
      foreign_replay_report_id, foreign_replay_shift_id, target_employee_id,
      'Rollback-only foreign idempotency-key isolation.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'A key from another report must never leak its result.'
    ),
    (
      divergence_covered_report_id, divergence_covered_shift_id, target_employee_id,
      'Rollback-only unresolved report with assigned coverage.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'Coverage evidence must settle this report before cutoff.'
    ),
    (
      divergence_no_replacement_report_id, divergence_no_replacement_shift_id, target_employee_id,
      'Rollback-only unresolved report with no-replacement coverage.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'Coverage evidence must settle this report before cutoff.'
    );

  -- Simulate unresolved legacy rows that existed before the lifecycle trigger.
  -- Re-enable the trigger immediately; the transaction guarantees restoration
  -- even if a later assertion aborts this test.
  execute 'alter table public.call_off_reports disable trigger prepare_call_off_report_lifecycle';
  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, call_received_at, received_by,
    reported_by, call_off_type, replacement_needed, operational_details
  ) values
    (
      expired_report_id, expired_shift_id, target_employee_id,
      'Rollback-only ended unfilled shift.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'Past the one-hour response window.'
    ),
    (
      overnight_report_id, overnight_shift_id, target_employee_id,
      'Rollback-only overnight DST shift.', clock_timestamp(), actor_employee_id,
      target_employee_id, 'other', true, 'America/Denver overnight lifecycle fixture.'
    );
  execute 'alter table public.call_off_reports enable trigger prepare_call_off_report_lifecycle';

  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, call_received_at, received_by,
    reported_by, call_off_type, replacement_needed, operational_details
  ) values (
    post_cutoff_no_replacement_report_id,
    post_cutoff_no_replacement_shift_id,
    target_employee_id,
    'Rollback-only post-cutoff no-replacement call-off.',
    clock_timestamp(),
    actor_employee_id,
    target_employee_id,
    'other',
    false,
    'A terminal report that must never reopen after its response window.'
  );

  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, call_received_at, received_by,
    reported_by, call_off_type, replacement_needed, operational_details,
    duplicate_of_call_off_report_id
  ) values (
    duplicate_report_id,
    coverage_shift_id,
    target_employee_id,
    'Rollback-only superseded duplicate call-off.',
    clock_timestamp(),
    actor_employee_id,
    target_employee_id,
    'other',
    true,
    'A duplicate terminal report that must never create coverage work.',
    future_report_id
  );

  -- Model rows that predate the lifecycle repair. One already carries its
  -- final outcome but is missing the append-only system action; the other two
  -- are unresolved legacy terminal shapes that reconciliation must complete.
  execute 'alter table public.call_off_reports disable trigger zz_sync_call_off_terminal_lifecycle';
  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, call_received_at, received_by,
    reported_by, call_off_type, replacement_needed, operational_details,
    resolved_at, resolution_outcome
  ) values (
    settled_no_replacement_report_id,
    settled_no_replacement_shift_id,
    target_employee_id,
    'Rollback-only settled no-replacement report without a system action.',
    clock_timestamp(),
    actor_employee_id,
    target_employee_id,
    'other',
    false,
    'Already terminal before full reconciliation.',
    clock_timestamp() - interval '10 minutes',
    'no_replacement_required'
  );

  execute 'alter table public.call_off_reports disable trigger prepare_call_off_report_lifecycle';
  insert into public.call_off_reports (
    id, shift_id, employee_id, reason, call_received_at, received_by,
    reported_by, call_off_type, replacement_needed, operational_details,
    duplicate_of_call_off_report_id
  ) values
    (
      unresolved_no_replacement_report_id,
      unresolved_no_replacement_shift_id,
      target_employee_id,
      'Rollback-only unresolved replacement-not-needed legacy report.',
      clock_timestamp(),
      actor_employee_id,
      target_employee_id,
      'other',
      false,
      'Must be completed one-way by reconciliation.',
      null
    ),
    (
      unresolved_duplicate_report_id,
      unresolved_duplicate_shift_id,
      target_employee_id,
      'Rollback-only unresolved duplicate legacy report.',
      clock_timestamp(),
      actor_employee_id,
      target_employee_id,
      'other',
      true,
      'Must be completed one-way by reconciliation.',
      future_report_id
    );
  execute 'alter table public.call_off_reports enable trigger prepare_call_off_report_lifecycle';
  execute 'alter table public.call_off_reports enable trigger zz_sync_call_off_terminal_lifecycle';

  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = settled_no_replacement_report_id
      and not report.replacement_needed
      and report.resolved_at is not null
      and report.resolution_outcome = 'no_replacement_required'
  ), 'The settled no-replacement fixture was not terminal before reconciliation.';
  assert not exists (
    select 1
    from public.call_off_report_actions action
    where action.call_off_report_id = settled_no_replacement_report_id
      and action.action = 'resolved'
      and action.snapshot ->> 'resolution_outcome' = 'no_replacement_required'
  ), 'The settled no-replacement fixture unexpectedly began with a system action.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = unresolved_no_replacement_report_id
      and not report.replacement_needed
      and report.resolved_at is null
      and report.resolution_outcome is null
  ), 'The unresolved replacement-not-needed legacy fixture was normalized too early.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = unresolved_duplicate_report_id
      and report.duplicate_of_call_off_report_id = future_report_id
      and report.resolved_at is null
      and report.resolution_outcome is null
  ), 'The unresolved duplicate legacy fixture was normalized too early.';

  insert into public.call_off_report_actions (
    call_off_report_id, action, reason, actor_id, snapshot
  )
  select
    report.id,
    'created',
    'Rollback-only lifecycle fixture created.',
    actor_employee_id,
    to_jsonb(report)
  from public.call_off_reports report
  where report.id in (
    resolved_report_id, canceled_report_id, grace_report_id,
    expired_report_id, overnight_report_id,
    divergence_covered_report_id, divergence_no_replacement_report_id
  );

  -- Simulate alerts and notifications that predate the lifecycle guards. The
  -- service reconciler must repair these stale rows without deleting them.
  execute 'alter table public.operational_alerts disable trigger operational_alert_lifecycle';
  insert into public.operational_alerts (
    id, alert_type, priority, title, summary, employee_id, shift_id,
    related_record_type, related_record_id, audience_roles, direct_path,
    deduplication_key
  ) values
    (
      resolved_alert_id, 'employee_call_off', 'urgent', 'Explicit resolution fixture',
      'Must close immediately when resolved_at is recorded.', target_employee_id,
      resolved_shift_id, 'call_off_report', resolved_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', resolved_report_id),
      concat('call-off-lifecycle:', resolved_report_id)
    ),
    (
      canceled_alert_id, 'employee_call_off', 'urgent', 'Explicit cancellation fixture',
      'Must close immediately when canceled_at is recorded.', target_employee_id,
      canceled_shift_id, 'call_off_report', canceled_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', canceled_report_id),
      concat('call-off-lifecycle:', canceled_report_id)
    ),
    (
      grace_alert_id, 'employee_call_off', 'urgent', 'Post-shift grace fixture',
      'Must remain active until one hour after shift end.', target_employee_id,
      grace_shift_id, 'call_off_report', grace_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', grace_report_id),
      concat('call-off-lifecycle:', grace_report_id)
    ),
    (
      expired_alert_id, 'employee_call_off', 'urgent', 'Expired call-off fixture',
      'Must retire to post-shift review without deleting history.', target_employee_id,
      expired_shift_id, 'call_off_report', expired_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', expired_report_id),
      concat('call-off-lifecycle:', expired_report_id)
    ),
    (
      overnight_alert_id, 'employee_call_off', 'urgent', 'Overnight call-off fixture',
      'Must use authoritative timestamps across the DST boundary.', target_employee_id,
      overnight_shift_id, 'call_off_report', overnight_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', overnight_report_id),
      concat('call-off-lifecycle:', overnight_report_id)
    ),
    (
      divergence_covered_alert_id, 'employee_call_off', 'urgent', 'Assigned divergence fixture',
      'Terminal coverage evidence must close this alert before cutoff.', target_employee_id,
      divergence_covered_shift_id, 'call_off_report', divergence_covered_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', divergence_covered_report_id),
      concat('call-off-lifecycle:', divergence_covered_report_id)
    ),
    (
      divergence_no_replacement_alert_id, 'employee_call_off', 'urgent', 'No-replacement divergence fixture',
      'Terminal coverage evidence must close this alert before cutoff.', target_employee_id,
      divergence_no_replacement_shift_id, 'call_off_report', divergence_no_replacement_report_id,
      array['admin']::public.app_role[], concat('/requests?callOff=', divergence_no_replacement_report_id),
      concat('call-off-lifecycle:', divergence_no_replacement_report_id)
    );
  execute 'alter table public.operational_alerts enable trigger operational_alert_lifecycle';

  execute 'alter table public.employee_notifications disable trigger prepare_call_off_notification_lifecycle';
  insert into public.employee_notifications (
    id, recipient_employee_id, sender_employee_id, source_type, source_id,
    source_key, title, body, priority, action_required, action_path, action_label
  ) values
    (
      future_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', future_report_id,
      concat('call-off-lifecycle-future:', future_report_id),
      'Future call-off needs review', 'Future coverage work remains open.',
      'urgent', true, concat('/requests?callOff=', future_report_id), 'Open call-off'
    ),
    (
      resolved_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', resolved_report_id,
      concat('call-off-lifecycle-resolved:', resolved_report_id),
      'Resolved call-off needs review', 'This action will be resolved immediately.',
      'urgent', true, concat('/requests?callOff=', resolved_report_id), 'Open call-off'
    ),
    (
      canceled_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', canceled_report_id,
      concat('call-off-lifecycle-canceled:', canceled_report_id),
      'Canceled call-off needs review', 'This action will be canceled immediately.',
      'urgent', true, concat('/requests?callOff=', canceled_report_id), 'Open call-off'
    ),
    (
      grace_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', grace_report_id,
      concat('call-off-lifecycle-grace:', grace_report_id),
      'Grace-period call-off needs review', 'This action remains in its live response window.',
      'urgent', true, concat('/requests?callOff=', grace_report_id), 'Open call-off'
    ),
    (
      expired_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', expired_report_id,
      concat('call-off-lifecycle-expired:', expired_report_id),
      'Expired call-off needs review', 'This action must retire after the response window.',
      'urgent', true, concat('/requests?callOff=', expired_report_id), 'Open call-off'
    ),
    (
      overnight_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', overnight_report_id,
      concat('call-off-lifecycle-overnight:', overnight_report_id),
      'Overnight call-off needs review', 'This action must retire using the zoned shift timestamps.',
      'urgent', true, concat('/requests?callOff=', overnight_report_id), 'Open call-off'
    ),
    (
      divergence_covered_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', divergence_covered_report_id,
      concat('call-off-lifecycle-assigned-divergence:', divergence_covered_report_id),
      'Assigned coverage divergence', 'Terminal coverage evidence must resolve this action.',
      'urgent', true, concat('/requests?callOff=', divergence_covered_report_id), 'Open call-off'
    ),
    (
      divergence_no_replacement_notification_id, target_employee_id, actor_employee_id,
      'call_off_request', divergence_no_replacement_report_id,
      concat('call-off-lifecycle-no-replacement-divergence:', divergence_no_replacement_report_id),
      'No-replacement coverage divergence', 'Terminal coverage evidence must resolve this action.',
      'urgent', true, concat('/requests?callOff=', divergence_no_replacement_report_id), 'Open call-off'
    );
  execute 'alter table public.employee_notifications enable trigger prepare_call_off_notification_lifecycle';

  update public.employee_notifications notification
  set expires_at = shift.ends_at + interval '1 hour'
  from public.call_off_reports report
  join public.shifts shift on shift.id = report.shift_id
  where notification.source_type = 'call_off_request'
    and notification.source_id = report.id
    and notification.id in (
      future_notification_id,
      resolved_notification_id,
      canceled_notification_id,
      grace_notification_id
    );

  insert into public.employee_notification_email_deliveries (
    notification_id, recipient_employee_id, subject, body
  ) values (
    expired_notification_id,
    target_employee_id,
    '[SygShift] Expired call-off fixture',
    'This rollback-only delivery must be suppressed when the response window ends.'
  );

  insert into private.employee_push_deliveries (notification_id, subscription_id)
  select expired_notification_id, subscription.id
  from private.employee_push_subscriptions subscription
  order by subscription.created_at, subscription.id
  limit 1
  on conflict (notification_id, subscription_id) do nothing;

  insert into public.shift_coverage_cases (
    id, call_off_report_id, source_shift_id, source_assignment_id,
    absent_employee_id, status, coverage_mode, original_assignment_snapshot,
    last_idempotency_key, opened_by
  ) values (
    grace_coverage_case_id,
    grace_report_id,
    grace_shift_id,
    grace_assignment_id,
    target_employee_id,
    'patrol_review',
    'patrol_review',
    jsonb_build_object(
      'assignmentId', grace_assignment_id,
      'shiftId', grace_shift_id,
      'employeeId', target_employee_id
    ),
    'caa00000-0000-4000-8000-000000000003',
    actor_employee_id
  );

  insert into public.shift_coverage_case_actions (
    id, coverage_case_id, action, actor_id, reason, before_record, after_record
  ) values (
    grace_coverage_action_id,
    grace_coverage_case_id,
    'patrol_review_requested',
    actor_employee_id,
    'Rollback-only grace-period coverage case created.',
    null,
    jsonb_build_object('status', 'patrol_review', 'coverage_mode', 'patrol_review')
  );

  -- Model old writer divergence: the terminal coverage decision committed,
  -- but the linked report never received resolved_at/outcome. Full
  -- reconciliation must trust this evidence even though cutoff is far away.
  insert into public.shift_coverage_cases (
    id, call_off_report_id, source_shift_id, source_assignment_id,
    absent_employee_id, status, coverage_mode, original_assignment_snapshot,
    last_idempotency_key, opened_by, resolved_by, resolved_at
  ) values
    (
      divergence_covered_case_id,
      divergence_covered_report_id,
      divergence_covered_shift_id,
      divergence_covered_assignment_id,
      target_employee_id,
      'assigned',
      'assigned_guard',
      jsonb_build_object(
        'assignmentId', divergence_covered_assignment_id,
        'shiftId', divergence_covered_shift_id,
        'employeeId', target_employee_id
      ),
      'caf00000-0000-4000-8000-000000000007',
      actor_employee_id,
      actor_employee_id,
      clock_timestamp() - interval '2 minutes'
    ),
    (
      divergence_no_replacement_case_id,
      divergence_no_replacement_report_id,
      divergence_no_replacement_shift_id,
      divergence_no_replacement_assignment_id,
      target_employee_id,
      'no_replacement',
      'no_replacement',
      jsonb_build_object(
        'assignmentId', divergence_no_replacement_assignment_id,
        'shiftId', divergence_no_replacement_shift_id,
        'employeeId', target_employee_id
      ),
      'caf00000-0000-4000-8000-000000000008',
      actor_employee_id,
      actor_employee_id,
      clock_timestamp() - interval '1 minute'
    );

  insert into public.shift_coverage_case_actions (
    id, coverage_case_id, action, actor_id, reason, before_record, after_record
  ) values
    (
      divergence_covered_action_id,
      divergence_covered_case_id,
      'assigned_guard',
      actor_employee_id,
      'Rollback-only assigned coverage evidence.',
      null,
      jsonb_build_object('status', 'assigned', 'coverage_mode', 'assigned_guard')
    ),
    (
      divergence_no_replacement_action_id,
      divergence_no_replacement_case_id,
      'no_replacement',
      actor_employee_id,
      'Rollback-only no-replacement coverage evidence.',
      null,
      jsonb_build_object('status', 'no_replacement', 'coverage_mode', 'no_replacement')
    );

  insert into public.employee_notifications (
    id, recipient_employee_id, sender_employee_id, source_type, source_id,
    source_key, title, body, priority, action_required, action_path, action_label
  ) values (
    grace_patrol_notification_id,
    actor_employee_id,
    actor_employee_id,
    'shift_coverage',
    grace_coverage_case_id,
    concat('call-off-lifecycle-patrol:', grace_coverage_case_id),
    'Patrol coverage review requested',
    'Rollback-only patrol review must reactivate when coverage is reopened.',
    'urgent',
    true,
    '/requests',
    'Review coverage'
  );

  insert into public.announcements (
    id, kind, title, body, shift_id, published_at, expires_at, created_by,
    template_key
  ) values (
    coverage_announcement_id,
    'open_shift',
    'Rollback-only stale coverage opening',
    'Synthetic coverage announcement retained for lifecycle verification.',
    coverage_shift_id,
    clock_timestamp() - interval '3 hours',
    timestamptz '2099-12-31 23:59:59+00',
    actor_employee_id,
    'shift_coverage_staged'
  );

  execute 'alter table public.shift_coverage_cases disable trigger guard_shift_coverage_case_lifecycle';
  insert into public.shift_coverage_cases (
    id, call_off_report_id, source_shift_id, source_assignment_id,
    coverage_shift_id, absent_employee_id, status, coverage_mode,
    announcement_id, original_assignment_snapshot, last_idempotency_key,
    opened_by
  ) values (
    expired_coverage_case_id,
    expired_report_id,
    expired_shift_id,
    expired_assignment_id,
    coverage_shift_id,
    target_employee_id,
    'open_pool',
    'open_pool',
    coverage_announcement_id,
    jsonb_build_object(
      'assignmentId', expired_assignment_id,
      'shiftId', expired_shift_id,
      'employeeId', target_employee_id
    ),
    'caa00000-0000-4000-8000-000000000002',
    actor_employee_id
  );
  execute 'alter table public.shift_coverage_cases enable trigger guard_shift_coverage_case_lifecycle';

  insert into public.shift_coverage_case_actions (
    id, coverage_case_id, action, actor_id, reason, before_record, after_record
  ) values (
    expired_coverage_action_id,
    expired_coverage_case_id,
    'created',
    actor_employee_id,
    'Rollback-only stale coverage case created.',
    null,
    jsonb_build_object('status', 'open_pool')
  );

  insert into private.shift_coverage_notification_waves (
    id, coverage_case_id, wave_number, audience, due_at, status
  ) values (
    expired_coverage_wave_id,
    expired_coverage_case_id,
    1,
    'flex_no_overtime',
    clock_timestamp() - interval '2 hours',
    'pending'
  );

  execute 'alter table public.shift_requests disable trigger guard_call_off_shift_request_lifecycle';
  insert into public.shift_requests (
    id, shift_id, employee_id, status, employee_note
  ) values (
    coverage_request_id,
    coverage_shift_id,
    target_employee_id,
    'pending',
    'Rollback-only stale coverage request.'
  );
  execute 'alter table public.shift_requests enable trigger guard_call_off_shift_request_lifecycle';

  insert into public.shift_requests (
    id, shift_id, employee_id, status, employee_note
  ) values
    (
      staging_coverage_request_id,
      request_staging_shift_id,
      requester_employee_id,
      'pending',
      'Rollback-only request that must not be movable onto terminal coverage.'
    ),
    (
      owner_pending_request_id,
      request_staging_shift_id,
      actor_employee_id,
      'pending',
      'Rollback-only owner request withdrawn through the supported RPC.'
    );

  -- Explicit terminal changes must close alerts and notifications without
  -- waiting for the service reconciliation loop.
  update public.call_off_reports
  set resolved_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = resolved_report_id;

  update public.call_off_reports
  set
    canceled_at = clock_timestamp(),
    canceled_by = actor_employee_id,
    cancellation_note = 'Rollback-only explicit cancellation.',
    updated_at = clock_timestamp()
  where id = canceled_report_id;

  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = resolved_alert_id
      and not alert.active
      and alert.lifecycle_state = 'resolved'
      and alert.cleared_at is not null
  ), 'resolved_at did not close the operational alert immediately.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = canceled_alert_id
      and not alert.active
      and alert.lifecycle_state = 'resolved'
      and alert.cleared_at is not null
  ), 'canceled_at did not close the operational alert immediately.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = resolved_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'legacy_resolved'
  ), 'An explicit resolved_at change did not receive the legacy-resolved outcome.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = canceled_report_id
      and report.canceled_at is not null
      and report.resolution_outcome = 'canceled'
  ), 'An explicit canceled_at change did not receive the canceled outcome.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = resolved_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'resolved_at left its workflow notification actionable.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = canceled_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'canceled_at left its workflow notification actionable.';

  -- Changing an otherwise live report to replacementNeeded=false is terminal,
  -- but an authorized correction may reopen it before the one-hour cutoff.
  grace_update_result := public.update_employee_call_off(
    grace_report_id,
    'other',
    'Rollback-only coverage no longer needed.',
    'Transition the live grace-period report to terminal.',
    false,
    'No replacement required during the live response window.'
  );
  assert grace_update_result ->> 'status' = 'updated'
    and exists (
      select 1
      from public.call_off_reports report
      where report.id = grace_report_id
        and not report.replacement_needed
        and report.resolved_at is not null
        and report.resolution_outcome = 'no_replacement_required'
    ), 'true-to-false replacement change did not settle immediately.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = grace_alert_id and not alert.active and alert.lifecycle_state = 'resolved'
  ), 'true-to-false replacement change left its alert live.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = grace_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'true-to-false replacement change left its notification actionable.';
  assert exists (
    select 1
    from public.shift_coverage_cases coverage
    where coverage.id = grace_coverage_case_id
      and coverage.status = 'closed'
      and coverage.resolved_at is not null
      and coverage.resolved_by is null
  ), 'true-to-false replacement change did not lifecycle-close its patrol-review case.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = grace_patrol_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'true-to-false replacement change left its patrol-review notification actionable.';

  grace_update_result := public.update_employee_call_off(
    grace_report_id,
    'other',
    'Rollback-only coverage is needed again.',
    'Reopen before the one-hour cutoff.',
    true,
    'Replacement coverage restored during the live response window.'
  );
  assert grace_update_result ->> 'status' = 'reopened'
    and exists (
      select 1
      from public.call_off_reports report
      where report.id = grace_report_id
        and report.replacement_needed
        and report.resolved_at is null
        and report.resolution_outcome is null
    ), 'false-to-true replacement correction did not reopen before the cutoff.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = grace_alert_id
      and alert.active
      and alert.lifecycle_state = 'active_operations'
  ) and (
    select count(*)
    from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id = grace_report_id
      and alert.active
      and alert.lifecycle_state = 'active_operations'
  ) = 1, 'The pre-cutoff replacement correction did not retain history and expose exactly one live alert.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = grace_report_id
      and notification.action_required
      and notification.resolved_at is null
      and notification.expires_at > clock_timestamp()
  ), 'The pre-cutoff replacement correction did not restore an actionable notification.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = grace_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
  ), 'The call-off reopen rewrote the original fixed-key notification instead of retaining history.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = grace_report_id
      and notification.recipient_employee_id = actor_employee_id
      and notification.id <> grace_notification_id
      and notification.source_key like '%:reopen:%'
      and notification.action_required
      and notification.resolved_at is null
      and notification.expires_at > clock_timestamp()
  ) and not exists (
    select notification.recipient_employee_id
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = grace_report_id
      and notification.action_required
      and notification.resolved_at is null
      and notification.expires_at > clock_timestamp()
    group by notification.recipient_employee_id
    having count(*) <> 1
  ), 'The reopen did not create exactly one generation-specific live call-off notification per reviewer.';
  assert exists (
    select 1
    from private.employee_push_deliveries delivery
    join public.employee_notifications notification
      on notification.id = delivery.notification_id
    where notification.source_type = 'call_off_request'
      and notification.source_id = grace_report_id
      and notification.recipient_employee_id = actor_employee_id
      and notification.source_key like '%:reopen:%'
      and delivery.subscription_id = actor_push_subscription_id
      and delivery.completed_at is null
  ), 'The generation-specific call-off notification did not produce a fresh delivery signal.';
  assert (
    select count(*)
    from public.call_off_report_actions action
    where action.call_off_report_id = grace_report_id
      and action.action = 'updated'
      and coalesce((action.snapshot ->> 'replacementReopened')::boolean, false)
  ) = 1, 'The pre-cutoff correction did not append exactly one reopen action.';
  assert exists (
    select 1
    from public.shift_coverage_cases coverage
    where coverage.id = grace_coverage_case_id
      and coverage.status = 'patrol_review'
      and coverage.resolved_at is null
      and coverage.resolved_by is null
  ), 'The pre-cutoff correction left its lifecycle-closed coverage case unusable.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'shift_coverage'
      and notification.source_id = grace_coverage_case_id
      and notification.recipient_employee_id = actor_employee_id
      and notification.action_required
      and notification.resolved_at is null
      and notification.expires_at > clock_timestamp()
  ), 'The pre-cutoff correction did not restore an actionable patrol-review notification.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = grace_patrol_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
  ), 'The patrol reopen rewrote the original notification instead of retaining it as history.';
  assert exists (
    select 1
    from public.employee_notifications notification
    join private.employee_push_deliveries delivery
      on delivery.notification_id = notification.id
    where notification.source_type = 'shift_coverage'
      and notification.source_id = grace_coverage_case_id
      and notification.recipient_employee_id = actor_employee_id
      and notification.id <> grace_patrol_notification_id
      and notification.source_key like '%:reopen:%'
      and notification.action_required
      and notification.resolved_at is null
      and notification.expires_at > clock_timestamp()
      and delivery.subscription_id = actor_push_subscription_id
      and delivery.completed_at is null
  ), 'The patrol reopen did not create a generation-specific actionable notification and delivery.';

  grace_coverage_result := public.resolve_call_off_coverage(
    grace_report_id,
    'patrol_review',
    null,
    null,
    null,
    'Rollback-only reopened case accepted for patrol review.',
    false,
    'caf00000-0000-4000-8000-000000000001'
  );
  assert grace_coverage_result ->> 'coverageCaseId' = grace_coverage_case_id::text
    and grace_coverage_result ->> 'status' = 'patrol_review'
    and exists (
      select 1
      from public.shift_coverage_cases coverage
      where coverage.id = grace_coverage_case_id
        and coverage.status = 'patrol_review'
        and coverage.resolved_at is null
        and coverage.resolved_by is null
    ), 'The reopened coverage case could not accept a valid pre-cutoff resolution workflow.';

  -- A client may lose the response after a terminal coverage decision. The
  -- same report/key must replay that completed result, while the same global
  -- key presented for another report must never disclose or reuse it.
  terminal_coverage_result := public.resolve_call_off_coverage(
    terminal_replay_report_id,
    'no_replacement',
    null,
    null,
    null,
    'Rollback-only terminal coverage decision.',
    false,
    terminal_replay_key
  );
  assert terminal_coverage_result ->> 'status' = 'no_replacement'
    and not coalesce((terminal_coverage_result ->> 'idempotentReplay')::boolean, true)
    and exists (
      select 1
      from public.call_off_reports report
      where report.id = terminal_replay_report_id
        and report.resolved_at is not null
        and report.resolution_outcome = 'no_replacement'
    ), 'The first terminal coverage decision did not settle its report.';

  terminal_coverage_replay_result := public.resolve_call_off_coverage(
    terminal_replay_report_id,
    'no_replacement',
    null,
    null,
    null,
    'Rollback-only terminal coverage decision.',
    false,
    terminal_replay_key
  );
  assert coalesce((terminal_coverage_replay_result ->> 'idempotentReplay')::boolean, false)
    and terminal_coverage_replay_result ->> 'coverageCaseId'
      = terminal_coverage_result ->> 'coverageCaseId'
    and terminal_coverage_replay_result ->> 'status' = 'no_replacement',
    'A lost-response replay was rejected after its first call made the report terminal.';

  begin
    perform public.resolve_call_off_coverage(
      foreign_replay_report_id,
      'no_replacement',
      null,
      null,
      null,
      'Rollback-only foreign replay isolation.',
      false,
      terminal_replay_key
    );
  exception
    when check_violation then foreign_replay_blocked := true;
  end;
  assert foreign_replay_blocked,
    'An idempotency key from another call-off leaked its completed coverage result.';
  assert not exists (
    select 1
    from public.shift_coverage_cases coverage
    where coverage.call_off_report_id = foreign_replay_report_id
  ) and exists (
    select 1
    from public.call_off_reports report
    where report.id = foreign_replay_report_id
      and report.resolved_at is null
      and report.resolution_outcome is null
  ), 'The rejected foreign-key replay partially mutated the other call-off.';

  assert exists (
    select 1
    from public.call_off_reports report
    join public.shifts shift on shift.id = report.shift_id
    join public.shift_coverage_cases coverage on coverage.call_off_report_id = report.id
    where report.id = divergence_covered_report_id
      and report.resolved_at is null
      and report.resolution_outcome is null
      and coverage.status = 'assigned'
      and coverage.coverage_mode = 'assigned_guard'
      and shift.ends_at + interval '1 hour' > clock_timestamp()
  ) and exists (
    select 1
    from public.call_off_reports report
    join public.shifts shift on shift.id = report.shift_id
    join public.shift_coverage_cases coverage on coverage.call_off_report_id = report.id
    where report.id = divergence_no_replacement_report_id
      and report.resolved_at is null
      and report.resolution_outcome is null
      and coverage.status = 'no_replacement'
      and coverage.coverage_mode = 'no_replacement'
      and shift.ends_at + interval '1 hour' > clock_timestamp()
  ), 'The terminal-coverage divergence fixtures were not unresolved before cutoff.';

  select count(*) into initial_report_count
  from public.call_off_reports report
  where report.employee_id = target_employee_id;
  select count(*) into initial_alert_count
  from public.operational_alerts alert
  where alert.related_record_type = 'call_off_report'
    and alert.related_record_id in (
      future_report_id, no_replacement_report_id, resolved_report_id,
      canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
      divergence_covered_report_id, divergence_no_replacement_report_id
    );
  select count(*) into initial_action_count
  from public.call_off_report_actions action
  join public.call_off_reports report on report.id = action.call_off_report_id
  where report.employee_id = target_employee_id;
  select count(*) into initial_notification_count
  from public.employee_notifications notification
  where notification.source_type = 'call_off_request'
    and notification.source_id in (
      future_report_id, no_replacement_report_id, resolved_report_id,
      canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
      divergence_covered_report_id, divergence_no_replacement_report_id
    );
  select count(*) into initial_coverage_case_count
  from public.shift_coverage_cases coverage
  where coverage.id = expired_coverage_case_id;
  select count(*) into initial_coverage_action_count
  from public.shift_coverage_case_actions action
  where action.coverage_case_id = expired_coverage_case_id;
  select count(*) into initial_system_resolution_action_count
  from public.call_off_report_actions action
  where action.action = 'resolved'
    and action.actor_id is null
    and action.snapshot ->> 'resolution_outcome' in (
      'no_replacement_required', 'patrol_completed', 'shift_ended_unfilled'
    );

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  first_reconciliation := public.service_reconcile_operational_alert_lifecycle(true);

  assert first_reconciliation ->> 'status' = 'completed',
    'The first lifecycle reconciliation did not complete.';
  assert coalesce((first_reconciliation ->> 'callOffResolvedCount')::integer, 0) >= 2,
    'The first reconciliation did not settle the expired call-offs.';
  assert coalesce((first_reconciliation ->> 'callOffAlertRetiredCount')::integer, 0) >= 2,
    'The first reconciliation did not retire the expired call-off alerts.';
  assert coalesce((first_reconciliation ->> 'callOffNotificationResolvedCount')::integer, 0) >= 2,
    'The first reconciliation did not resolve expired call-off notifications.';
  assert coalesce((first_reconciliation ->> 'staleCoverageCaseClosedCount')::integer, 0) >= 1,
    'The first reconciliation did not close stale coverage work.';
  assert coalesce((first_reconciliation ->> 'coverageWaveCanceledCount')::integer, 0) >= 1
    and coalesce((first_reconciliation ->> 'coverageAnnouncementExpiredCount')::integer, 0) >= 1
    and coalesce((first_reconciliation ->> 'coverageShiftRequestDeclinedCount')::integer, 0) >= 1
    and coalesce((first_reconciliation ->> 'coverageShiftClosedCount')::integer, 0) >= 1,
    'The first reconciliation did not retire every stale coverage artifact.';

  select count(*) into settled_system_resolution_action_count
  from public.call_off_report_actions action
  where action.action = 'resolved'
    and action.actor_id is null
    and action.snapshot ->> 'resolution_outcome' in (
      'no_replacement_required', 'patrol_completed', 'shift_ended_unfilled'
    );
  assert coalesce((first_reconciliation ->> 'callOffActionRecordedCount')::integer, 0)
      = settled_system_resolution_action_count - initial_system_resolution_action_count,
    'The full-reconciliation action counter did not match actual append-only inserts.';
  assert exists (
    select 1
    from public.call_off_report_actions action
    where action.call_off_report_id = settled_no_replacement_report_id
      and action.action = 'resolved'
      and action.actor_id is null
      and action.snapshot ->> 'resolution_outcome' = 'no_replacement_required'
  ), 'Full reconciliation did not backfill the missing terminal system action.';
  assert (
    select count(*)
    from public.call_off_report_actions action
    where action.call_off_report_id = settled_no_replacement_report_id
      and action.action = 'resolved'
      and action.actor_id is null
      and action.snapshot ->> 'resolution_outcome' = 'no_replacement_required'
  ) = 1, 'Full reconciliation duplicated the missing terminal system action.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = unresolved_no_replacement_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'no_replacement_required'
  ), 'Full reconciliation did not complete the unresolved replacement-not-needed legacy row.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = unresolved_duplicate_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'legacy_resolved'
  ), 'Full reconciliation did not complete the unresolved duplicate legacy row.';
  assert exists (
    select 1
    from public.call_off_reports report
    join public.shifts shift on shift.id = report.shift_id
    where report.id = divergence_covered_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'covered'
      and shift.ends_at + interval '1 hour' > clock_timestamp()
  ) and exists (
    select 1
    from public.call_off_reports report
    join public.shifts shift on shift.id = report.shift_id
    where report.id = divergence_no_replacement_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'no_replacement'
      and shift.ends_at + interval '1 hour' > clock_timestamp()
  ), 'Full reconciliation ignored terminal coverage evidence before cutoff.';
  assert not exists (
    select 1
    from public.operational_alerts alert
    where alert.id in (
      divergence_covered_alert_id,
      divergence_no_replacement_alert_id
    )
      and alert.active
  ) and not exists (
    select 1
    from public.employee_notifications notification
    where notification.id in (
      divergence_covered_notification_id,
      divergence_no_replacement_notification_id
    )
      and (
        notification.action_required
        or notification.resolved_at is null
        or notification.expires_at is null
      )
  ), 'Terminal coverage evidence left an alert or notification actionable.';
  assert exists (
    select 1
    from public.shift_coverage_case_actions action
    where action.id = divergence_covered_action_id
      and action.action = 'assigned_guard'
  ) and exists (
    select 1
    from public.shift_coverage_case_actions action
    where action.id = divergence_no_replacement_action_id
      and action.action = 'no_replacement'
  ), 'Coverage-decision audit history was lost while repairing report divergence.';

  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id = future_report_id
      and alert.active
      and alert.lifecycle_state = 'active_operations'
      and alert.priority = 'urgent'
      and alert.live_until_at = timestamptz '2099-10-05 23:00:00+00'
  ), 'A future replacement-needed call-off did not remain live through shift end plus one hour.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = future_notification_id
      and notification.action_required
      and notification.resolved_at is null
  ), 'The future call-off notification was incorrectly resolved.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = future_report_id
      and report.resolved_at is null
      and report.canceled_at is null
      and report.resolution_outcome is null
  ), 'The future call-off report was incorrectly closed.';

  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = grace_alert_id
      and alert.active
      and alert.lifecycle_state = 'active_operations'
      and alert.live_until_at > clock_timestamp()
  ), 'A call-off inside the one-hour post-shift window was retired early.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = grace_report_id
      and notification.action_required
      and notification.resolved_at is null
  ), 'The grace-period call-off lost every actionable notification before cutoff.';

  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = expired_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'shift_ended_unfilled'
  ), 'The shift-ended call-off report was not settled.';
  assert exists (
    select 1
    from public.call_off_report_actions action
    where action.call_off_report_id = expired_report_id
      and action.action = 'resolved'
      and btrim(action.reason) <> ''
      and action.snapshot ->> 'resolution_outcome' = 'shift_ended_unfilled'
  ), 'The ended-unfilled call-off resolution was not appended to history.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = expired_alert_id
      and not alert.active
      and alert.lifecycle_state = 'resolved'
      and alert.clear_source = 'automatic_resolution'
      and alert.cleared_reason ilike '%post-shift review%'
      and alert.live_until_at <= clock_timestamp()
  ), 'The stale call-off alert was not retained as resolved post-shift review.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = expired_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'The stale workflow notification remained actionable or was not retained.';

  assert exists (
    select 1
    from public.shift_coverage_cases coverage
    where coverage.id = expired_coverage_case_id
      and coverage.status = 'closed'
      and coverage.resolved_at is not null
      and coverage.resolved_by is null
  ), 'The stale open-pool coverage case did not close.';
  assert exists (
    select 1
    from public.shift_coverage_case_actions action
    where action.coverage_case_id = expired_coverage_case_id
      and action.action = 'closed'
      and btrim(action.reason) <> ''
      and action.after_record::text like '%shift_ended_unfilled%'
  ), 'Closing the stale coverage case did not append history.';
  assert exists (
    select 1
    from private.shift_coverage_notification_waves wave
    where wave.id = expired_coverage_wave_id and wave.status = 'canceled'
  ), 'The stale pending coverage wave was not canceled.';
  assert exists (
    select 1
    from public.announcements announcement
    where announcement.id = coverage_announcement_id
      and announcement.expires_at <= clock_timestamp()
  ), 'The stale coverage announcement remained live.';
  assert exists (
    select 1
    from public.shift_requests request
    where request.id = coverage_request_id and request.status = 'declined'
  ), 'The stale coverage request remained pending.';
  assert exists (
    select 1
    from public.shifts shift
    where shift.id = coverage_shift_id
      and not shift.is_open
      and shift.canceled_at is not null
      and shift.cancellation_reason like 'Call-off lifecycle retirement:%'
  ), 'The stale generated coverage shift did not reach its lifecycle-owned closed state.';

  begin
    insert into public.shift_requests (
      id, shift_id, employee_id, status, employee_note
    ) values (
      late_coverage_request_id,
      coverage_shift_id,
      requester_employee_id,
      'pending',
      'Rollback-only late request against a terminal call-off.'
    );
  exception
    when check_violation then late_shift_request_insert_blocked := true;
  end;
  assert late_shift_request_insert_blocked,
    'A raw shift-request insert recreated live work after call-off retirement.';
  assert not exists (
    select 1
    from public.shift_requests request
    where request.id = late_coverage_request_id
  ), 'The rejected late shift request was partially inserted.';

  begin
    update public.shift_requests request
    set status = 'pending', updated_at = clock_timestamp()
    where request.id = coverage_request_id;
  exception
    when check_violation then terminal_shift_request_reopen_blocked := true;
  end;
  assert terminal_shift_request_reopen_blocked and exists (
    select 1
    from public.shift_requests request
    where request.id = coverage_request_id
      and request.status = 'declined'
  ), 'A declined coverage request was reopened after its call-off became terminal.';

  begin
    update public.shift_requests request
    set shift_id = coverage_shift_id, updated_at = clock_timestamp()
    where request.id = staging_coverage_request_id;
  exception
    when check_violation then terminal_shift_request_move_blocked := true;
  end;
  assert terminal_shift_request_move_blocked and exists (
    select 1
    from public.shift_requests request
    where request.id = staging_coverage_request_id
      and request.shift_id = request_staging_shift_id
      and request.status = 'pending'
  ), 'A pending request was moved onto terminal call-off coverage.';

  assert exists (
    select 1
    from public.shifts shift
    where shift.id = overnight_shift_id
      and shift.time_zone = 'America/Denver'
      and (shift.starts_at at time zone shift.time_zone)::date
        <> (shift.ends_at at time zone shift.time_zone)::date
      and shift.ends_at - shift.starts_at = interval '7 hours'
  ), 'The overnight fixture did not preserve the America/Denver DST boundary.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = overnight_report_id
      and report.resolved_at is not null
      and report.resolution_outcome = 'shift_ended_unfilled'
  ), 'The overnight call-off was not retired by its authoritative end timestamp.';
  assert exists (
    select 1
    from public.operational_alerts alert
    where alert.id = overnight_alert_id
      and not alert.active
      and alert.lifecycle_state = 'resolved'
      and alert.clear_source = 'automatic_resolution'
      and alert.cleared_reason ilike '%post-shift review%'
  ), 'The overnight call-off alert did not enter retained post-shift review.';
  assert exists (
    select 1
    from public.employee_notifications notification
    where notification.id = overnight_notification_id
      and not notification.action_required
      and notification.resolved_at is not null
      and notification.expires_at is not null
  ), 'The overnight call-off notification remained actionable.';

  assert exists (
    select 1
    from public.employee_notification_email_deliveries delivery
    where delivery.notification_id = expired_notification_id
      and delivery.delivered_at is null
      and delivery.failed_at is not null
      and delivery.attempt_count = 0
  ), 'The terminal call-off email delivery remained claimable.';
  assert not exists (
    select 1
    from private.employee_push_deliveries delivery
    where delivery.notification_id = expired_notification_id
      and delivery.completed_at is null
  ), 'The terminal call-off push delivery remained claimable.';

  -- Simulate pre-migration outbox rows that were still pending at claim time.
  -- The claim wrapper must suppress terminal call-offs while allowing a live
  -- future call-off through the same batch.
  execute 'alter table private.notification_outbox disable trigger suppress_terminal_call_off_outbox';
  update private.notification_outbox outbox
  set
    failed_at = null,
    last_error = null,
    attempted_at = null,
    attempt_count = 0,
    available_at = timestamptz '1900-01-01 00:00:00+00'
  where outbox.message_type = 'call_off_supervisor_alert'
    and outbox.aggregate_type = 'call_off_report'
    and outbox.aggregate_id in (
      no_replacement_report_id, resolved_report_id, canceled_report_id,
      expired_report_id, overnight_report_id, post_cutoff_no_replacement_report_id,
      duplicate_report_id
    )
    and outbox.delivered_at is null;
  execute 'alter table private.notification_outbox enable trigger suppress_terminal_call_off_outbox';

  update private.notification_outbox outbox
  set
    attempted_at = null,
    attempt_count = 0,
    available_at = timestamptz '1900-01-01 00:00:01+00'
  where outbox.message_type = 'call_off_supervisor_alert'
    and outbox.aggregate_type = 'call_off_report'
    and outbox.aggregate_id = future_report_id
    and outbox.delivered_at is null
    and outbox.failed_at is null;

  claimed_delivery_batch := public.service_claim_notification_batch(25);
  assert not exists (
    select 1
    from jsonb_array_elements(claimed_delivery_batch) claimed
    where claimed ->> 'aggregateId' in (
      no_replacement_report_id::text,
      resolved_report_id::text,
      canceled_report_id::text,
      expired_report_id::text,
      overnight_report_id::text,
      post_cutoff_no_replacement_report_id::text,
      duplicate_report_id::text,
      orphan_report_id::text
    )
  ), 'A terminal call-off supervisor delivery was claimed.';
  assert exists (
    select 1
    from jsonb_array_elements(claimed_delivery_batch) claimed
    where claimed ->> 'aggregateId' = future_report_id::text
  ), 'The claim-time lifecycle filter suppressed a still-live future call-off.';
  assert not exists (
    select 1
    from private.notification_outbox outbox
    where outbox.aggregate_id in (
      no_replacement_report_id, resolved_report_id, canceled_report_id,
      expired_report_id, overnight_report_id, post_cutoff_no_replacement_report_id,
      duplicate_report_id, orphan_report_id
    )
      and outbox.delivered_at is null
      and outbox.failed_at is null
  ), 'A terminal call-off outbox row remained claimable after the claim-time recheck.';

  claimed_employee_email_batch := public.service_claim_employee_notification_batch(25);
  assert not exists (
    select 1
    from jsonb_array_elements(claimed_employee_email_batch) claimed
    where claimed ->> 'aggregateId' = expired_notification_id::text
  ), 'A suppressed terminal call-off email delivery was claimed.';

  claimed_push_batch := public.service_claim_employee_push(50);
  assert not exists (
    select 1
    from jsonb_array_elements(claimed_push_batch) claimed
    where claimed ->> 'notificationId' in (
      expired_notification_id::text,
      overnight_notification_id::text,
      resolved_notification_id::text,
      canceled_notification_id::text,
      orphan_notification_id::text
    )
  ), 'A terminal call-off push delivery was claimed.';

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);
  begin
    terminal_coverage_workspace := public.get_call_off_coverage_workspace(expired_report_id);
  exception
    when check_violation then coverage_workspace_failed_closed := true;
  end;
  assert coverage_workspace_failed_closed or (
    not coalesce((terminal_coverage_workspace ->> 'actionable')::boolean, false)
    and jsonb_array_length(coalesce(terminal_coverage_workspace -> 'candidates', '[]'::jsonb)) = 0
    and not coalesce(
      (terminal_coverage_workspace #>> '{patrolFallback,available}')::boolean,
      false
    )
  ), 'The coverage workspace exposed terminal call-off actions or candidates.';
  begin
    perform public.update_employee_call_off(
      post_cutoff_no_replacement_report_id,
      'other',
      'Rollback-only invalid post-cutoff reopen.',
      'Coverage cannot be reopened after the response window.',
      true,
      'This mutation must be rejected.'
    );
  exception
    when check_violation then post_cutoff_reopen_blocked := true;
  end;
  assert post_cutoff_reopen_blocked,
    'A replacement-not-needed call-off reopened after shift end plus one hour.';
  assert exists (
    select 1
    from public.call_off_reports report
    where report.id = post_cutoff_no_replacement_report_id
      and not report.replacement_needed
      and report.resolution_outcome = 'no_replacement_required'
      and report.resolved_at is not null
  ), 'The rejected post-cutoff reopen changed the terminal call-off.';

  begin
    perform public.update_employee_call_off(
      resolved_report_id,
      'other',
      'Rollback-only invalid legacy-outcome reopen.',
      'A legacy terminal outcome cannot be reopened as coverage work.',
      true,
      'This mutation must be rejected.'
    );
  exception
    when check_violation then legacy_reopen_blocked := true;
  end;
  assert legacy_reopen_blocked,
    'A legacy-resolved call-off reopened as coverage work.';

  begin
    perform public.update_employee_call_off(
      canceled_report_id,
      'other',
      'Rollback-only invalid canceled-outcome reopen.',
      'A canceled call-off cannot be reopened as coverage work.',
      true,
      'This mutation must be rejected.'
    );
  exception
    when check_violation then canceled_reopen_blocked := true;
  end;
  assert canceled_reopen_blocked,
    'A canceled call-off reopened as coverage work.';

  begin
    perform public.resolve_call_off_coverage(
      no_replacement_report_id,
      'patrol_review',
      null,
      null,
      null,
      'Rollback-only replacement-not-needed coverage rejection.',
      false,
      'caf00000-0000-4000-8000-000000000002'
    );
  exception
    when check_violation then no_replacement_coverage_blocked := true;
  end;
  assert no_replacement_coverage_blocked,
    'Coverage work opened for replacementNeeded=false.';

  begin
    perform public.resolve_call_off_coverage(
      resolved_report_id,
      'patrol_review',
      null,
      null,
      null,
      'Rollback-only resolved call-off coverage rejection.',
      false,
      'caf00000-0000-4000-8000-000000000003'
    );
  exception
    when check_violation then resolved_coverage_blocked := true;
  end;
  assert resolved_coverage_blocked,
    'Coverage work opened for a resolved call-off.';

  begin
    perform public.resolve_call_off_coverage(
      duplicate_report_id,
      'patrol_review',
      null,
      null,
      null,
      'Rollback-only duplicate call-off coverage rejection.',
      false,
      'caf00000-0000-4000-8000-000000000004'
    );
  exception
    when check_violation then duplicate_coverage_blocked := true;
  end;
  assert duplicate_coverage_blocked,
    'Coverage work opened for a superseded duplicate call-off.';

  begin
    perform public.resolve_call_off_coverage(
      expired_report_id,
      'patrol_review',
      null,
      null,
      null,
      'Rollback-only post-cutoff coverage rejection.',
      false,
      'caf00000-0000-4000-8000-000000000005'
    );
  exception
    when check_violation then cutoff_coverage_blocked := true;
  end;
  assert cutoff_coverage_blocked,
    'Coverage work opened after the live response cutoff.';

  begin
    perform public.decide_shift_request(
      coverage_request_id,
      'approved',
      'Rollback-only approval must fail after the linked call-off is terminal.'
    );
  exception
    when check_violation then terminal_shift_request_blocked := true;
  end;
  assert terminal_shift_request_blocked,
    'A coverage request was approved after its linked call-off became terminal.';

  -- The trigger protects trusted writers, while browser sessions must have no
  -- raw UPDATE path that can move a terminal request onto an ordinary shift.
  -- The supported owner withdrawal RPC must remain usable after that revoke.
  execute 'set local role authenticated';
  begin
    update public.shift_requests request
    set
      shift_id = request_staging_shift_id,
      status = 'pending',
      updated_at = clock_timestamp()
    where request.id = coverage_request_id;
  exception
    when insufficient_privilege then raw_shift_request_update_blocked := true;
  end;
  owner_withdrawal_result := public.withdraw_shift_request(owner_pending_request_id);
  execute 'reset role';

  assert raw_shift_request_update_blocked and exists (
    select 1
    from public.shift_requests request
    where request.id = coverage_request_id
      and request.shift_id = coverage_shift_id
      and request.status = 'declined'
  ), 'Authenticated raw UPDATE moved and reopened a terminal coverage request.';
  assert owner_withdrawal_result and exists (
    select 1
    from public.shift_requests request
    where request.id = owner_pending_request_id
      and request.employee_id = actor_employee_id
      and request.status = 'withdrawn'
  ), 'The supported owner withdrawal RPC stopped working after raw UPDATE was revoked.';

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

  -- Every authoritative/history row still exists after state reconciliation.
  assert (
    select count(*) from public.call_off_reports report
    where report.employee_id = target_employee_id
  ) = initial_report_count, 'Call-off report history was deleted.';
  assert (
    select count(*) from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id in (
        future_report_id, no_replacement_report_id, resolved_report_id,
        canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
        divergence_covered_report_id, divergence_no_replacement_report_id
      )
  ) = initial_alert_count, 'Operational alert history was deleted.';
  assert (
    select count(*) from public.call_off_report_actions action
    join public.call_off_reports report on report.id = action.call_off_report_id
    where report.employee_id = target_employee_id
  ) >= initial_action_count, 'Call-off action history was deleted.';
  assert (
    select count(*) from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id in (
        future_report_id, no_replacement_report_id, resolved_report_id,
        canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
        divergence_covered_report_id, divergence_no_replacement_report_id
      )
  ) >= initial_notification_count, 'Workflow notification history was deleted.';
  assert (
    select count(*) from public.shift_coverage_cases coverage
    where coverage.id = expired_coverage_case_id
  ) = initial_coverage_case_count, 'Coverage case history was deleted.';
  assert (
    select count(*) from public.shift_coverage_case_actions action
    where action.coverage_case_id = expired_coverage_case_id
  ) >= initial_coverage_action_count, 'Coverage action history was deleted.';

  select count(*) into settled_report_count
  from public.call_off_reports report where report.employee_id = target_employee_id;
  select count(*) into settled_alert_count
  from public.operational_alerts alert
  where alert.related_record_type = 'call_off_report'
    and alert.related_record_id in (
      future_report_id, no_replacement_report_id, resolved_report_id,
      canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
      divergence_covered_report_id, divergence_no_replacement_report_id
    );
  select count(*) into settled_action_count
  from public.call_off_report_actions action
  join public.call_off_reports report on report.id = action.call_off_report_id
  where report.employee_id = target_employee_id;
  select count(*) into settled_notification_count
  from public.employee_notifications notification
  where notification.source_type = 'call_off_request'
    and notification.source_id in (
      future_report_id, no_replacement_report_id, resolved_report_id,
      canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
      divergence_covered_report_id, divergence_no_replacement_report_id
    );
  select count(*) into settled_coverage_case_count
  from public.shift_coverage_cases coverage where coverage.id = expired_coverage_case_id;
  select count(*) into settled_coverage_action_count
  from public.shift_coverage_case_actions action
  where action.coverage_case_id = expired_coverage_case_id;
  select announcement.expires_at into settled_coverage_announcement_expires_at
  from public.announcements announcement
  where announcement.id = coverage_announcement_id;

  second_reconciliation := public.service_reconcile_operational_alert_lifecycle(true);

  assert second_reconciliation ->> 'status' = 'completed',
    'The repeated lifecycle reconciliation did not complete.';
  assert coalesce((second_reconciliation ->> 'callOffResolvedCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'callOffActionRecordedCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'callOffAlertRetiredCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'callOffNotificationResolvedCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'staleCoverageCaseClosedCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'coverageWaveCanceledCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'coverageAnnouncementExpiredCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'coverageShiftRequestDeclinedCount')::integer, 0) = 0
    and coalesce((second_reconciliation ->> 'coverageShiftClosedCount')::integer, 0) = 0,
    'The repeated lifecycle reconciliation was not idempotent.';
  assert (
    select count(*) from public.call_off_reports report where report.employee_id = target_employee_id
  ) = settled_report_count, 'The repeated reconciliation changed report cardinality.';
  assert (
    select count(*) from public.operational_alerts alert
    where alert.related_record_type = 'call_off_report'
      and alert.related_record_id in (
        future_report_id, no_replacement_report_id, resolved_report_id,
        canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
        divergence_covered_report_id, divergence_no_replacement_report_id
      )
  ) = settled_alert_count, 'The repeated reconciliation changed alert cardinality.';
  assert (
    select count(*) from public.call_off_report_actions action
    join public.call_off_reports report on report.id = action.call_off_report_id
    where report.employee_id = target_employee_id
  ) = settled_action_count, 'The repeated reconciliation duplicated call-off history.';
  assert (
    select count(*) from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id in (
        future_report_id, no_replacement_report_id, resolved_report_id,
        canceled_report_id, grace_report_id, expired_report_id, overnight_report_id,
        divergence_covered_report_id, divergence_no_replacement_report_id
      )
  ) = settled_notification_count, 'The repeated reconciliation duplicated notification history.';
  assert (
    select count(*) from public.shift_coverage_cases coverage
    where coverage.id = expired_coverage_case_id
  ) = settled_coverage_case_count, 'The repeated reconciliation changed coverage case cardinality.';
  assert (
    select count(*) from public.shift_coverage_case_actions action
    where action.coverage_case_id = expired_coverage_case_id
  ) = settled_coverage_action_count, 'The repeated reconciliation duplicated coverage history.';
  assert (
    select announcement.expires_at
    from public.announcements announcement
    where announcement.id = coverage_announcement_id
  ) is not distinct from settled_coverage_announcement_expires_at,
    'The repeated reconciliation rewrote an already-clamped announcement expiry.';
  assert (
    select count(*)
    from public.call_off_report_actions action
    where action.action = 'resolved'
      and action.actor_id is null
      and action.snapshot ->> 'resolution_outcome' in (
        'no_replacement_required', 'patrol_completed', 'shift_ended_unfilled'
      )
  ) = settled_system_resolution_action_count,
    'The repeated full reconciliation duplicated a terminal system action.';

  -- Recreate a pending/open artifact combination after the report is already
  -- terminal. A worker that trusts only the wave/case/shift flags would emit;
  -- the lifecycle-aware claim recheck must cancel it without a notification.
  begin
    update public.shift_coverage_cases coverage
    set
      status = 'open_pool',
      resolved_by = null,
      resolved_at = null,
      updated_at = clock_timestamp()
    where coverage.id = expired_coverage_case_id;
  exception
    when check_violation then terminal_coverage_case_reopen_blocked := true;
  end;
  assert terminal_coverage_case_reopen_blocked and exists (
    select 1
    from public.shift_coverage_cases coverage
    where coverage.id = expired_coverage_case_id
      and coverage.status = 'closed'
      and coverage.resolved_at is not null
  ), 'A raw coverage-case update recreated live work after retirement.';

  -- Bypass only the table boundary to model a legacy/concurrent stale row;
  -- the service worker still has to recheck the authoritative report.
  execute 'alter table public.shift_coverage_cases disable trigger guard_shift_coverage_case_lifecycle';
  update public.shift_coverage_cases coverage
  set
    status = 'open_pool',
    resolved_by = null,
    resolved_at = null,
    updated_at = clock_timestamp()
  where coverage.id = expired_coverage_case_id;
  execute 'alter table public.shift_coverage_cases enable trigger guard_shift_coverage_case_lifecycle';
  update public.shifts shift
  set
    starts_at = clock_timestamp() + interval '1 hour',
    ends_at = clock_timestamp() + interval '9 hours',
    canceled_at = null,
    canceled_by = null,
    cancellation_reason = null,
    is_open = true,
    updated_at = clock_timestamp()
  where shift.id = coverage_shift_id;
  update private.shift_coverage_notification_waves wave
  set
    status = 'pending',
    due_at = clock_timestamp() - interval '1 minute',
    attempts = 0,
    recipient_count = 0,
    claimed_at = null,
    processed_at = null,
    last_error = null,
    updated_at = clock_timestamp()
  where wave.id = expired_coverage_wave_id;
  select count(*) into stale_wave_notification_count
  from public.employee_notifications notification
  where notification.source_type = 'shift_coverage'
    and notification.source_id = expired_coverage_case_id;

  stale_wave_result := public.service_process_shift_coverage_notification_waves(1);
  assert coalesce((stale_wave_result ->> 'processed')::integer, 0) = 0
    and coalesce((stale_wave_result ->> 'recipients')::integer, 0) = 0,
    'The stale terminal coverage wave was processed as live work.';
  assert exists (
    select 1
    from private.shift_coverage_notification_waves wave
    where wave.id = expired_coverage_wave_id
      and wave.status = 'canceled'
  ), 'The stale terminal coverage wave was not canceled at claim time.';
  assert (
    select count(*)
    from public.employee_notifications notification
    where notification.source_type = 'shift_coverage'
      and notification.source_id = expired_coverage_case_id
  ) = stale_wave_notification_count,
    'The stale terminal coverage wave emitted a new employee notification.';
  assert not exists (
    select 1
    from public.shift_coverage_case_actions action
    where action.coverage_case_id = expired_coverage_case_id
      and action.action = 'notification_wave_sent'
  ), 'The stale terminal coverage wave appended a false delivery action.';

  assert not exists (
    select 1
    from public.employee_notifications notification
    where notification.source_type = 'call_off_request'
      and notification.source_id = orphan_report_id
      and notification.action_required
      and notification.resolved_at is null
  ) and not exists (
    select 1
    from public.operational_alerts alert
    where alert.alert_type = 'employee_call_off'
      and alert.related_record_type = 'call_off_report'
      and alert.related_record_id = orphan_report_id
      and alert.active
  ) and not exists (
    select 1
    from private.notification_outbox outbox
    where outbox.message_type = 'call_off_supervisor_alert'
      and outbox.aggregate_type = 'call_off_report'
      and outbox.aggregate_id = orphan_report_id
      and outbox.delivered_at is null
      and outbox.failed_at is null
  ), 'Postflight found a live artifact whose call-off report does not exist.';

  raise notice 'Call-off lifecycle regression passed future, explicit terminal, no-replacement, post-shift grace/retirement, notification, coverage cleanup, history, idempotency, and overnight DST cases.';
end
$$;

rollback;

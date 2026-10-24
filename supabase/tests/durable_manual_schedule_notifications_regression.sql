-- Rollback-only regression for manual schedule-notification operation
-- identity. A lost HTTP response must replay one immutable outbox row even
-- after the legacy minute boundary; a deliberate later resend uses a new UUID.
begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $durable_manual_schedule_notifications_regression$
declare
  actor_auth_user_id uuid;
  actor_employee_id uuid;
  schedule_id uuid := gen_random_uuid();
  first_operation_id uuid := gen_random_uuid();
  resend_operation_id uuid := gen_random_uuid();
  fixture_week date;
  first_result jsonb;
  replay_result jsonb;
  resend_result jsonb;
  first_payload jsonb;
  claimed_jobs jsonb;
  conflict_rejected boolean := false;
  send_permission_rejected boolean := false;
begin
  select account.auth_user_id, employee.id
  into actor_auth_user_id, actor_employee_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and private.employee_effective_permissions(employee.id)
      && array['schedule.manage', 'scheduler.manage']::text[]
    and 'announcements.send' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end,
    employee.created_at,
    employee.id
  limit 1;

  assert actor_auth_user_id is not null and actor_employee_id is not null,
    'An active schedule manager is required for this rollback-only regression.';

  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', actor_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  select coalesce(max(schedule.week_starts_on), current_date) + 7
  into fixture_week
  from public.schedules schedule;

  insert into public.schedules (
    id,
    week_starts_on,
    revision,
    status,
    published_at,
    published_by,
    created_by
  ) values (
    schedule_id,
    fixture_week,
    1,
    'published',
    clock_timestamp(),
    actor_employee_id,
    actor_employee_id
  );

  first_result := public.queue_schedule_published_notification(
    schedule_id,
    first_operation_id,
    'First immutable notice'
  );
  select outbox.payload into first_payload
  from private.notification_outbox outbox
  where outbox.id = (first_result ->> 'notificationId')::uuid;
  assert first_payload ->> 'recipientManifestFrozen' = 'true'
    and jsonb_typeof(first_payload -> 'deliveryRecipients') = 'array'
    and jsonb_typeof(first_payload -> 'deliveryMessage') = 'object',
    'The first queue transaction must freeze recipients and rendered message facts.';

  -- Drift every snapshotted employee preference after queueing. Neither a
  -- response-loss replay nor the service claim may silently substitute the
  -- now-current recipient set.
  insert into private.employee_notification_preferences (employee_id, schedule_published)
  select distinct employee.id, false
  from public.employees employee
  join private.employee_contacts contact on contact.employee_id = employee.id
  where private.preferred_delivery_email(contact.personal_email, contact.company_email) in (
    select jsonb_array_elements_text(first_payload -> 'deliveryRecipients')
  )
  on conflict (employee_id) do update
  set schedule_published = excluded.schedule_published,
      updated_at = clock_timestamp();

  -- This is the response-loss retry. Operation identity, rather than current
  -- wall-clock minute, selects the already-committed notification.
  replay_result := public.queue_schedule_published_notification(
    schedule_id,
    first_operation_id,
    'First immutable notice'
  );

  assert replay_result = first_result,
    'The same operation UUID must replay the exact committed notification.';
  assert (
    select count(*)
    from private.notification_outbox outbox
    where outbox.idempotency_key =
      'schedule-published-manual-operation:' || first_operation_id::text
  ) = 1,
    'A response-loss retry must not enqueue a duplicate schedule notice.';
  assert (
    select count(*)
    from private.audit_events audit
    where audit.operation = 'queue_schedule_notification'
      and audit.new_record ->> 'operation_id' = first_operation_id::text
  ) = 1,
    'A response-loss retry must not create a duplicate queue audit event.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'service_role', 'aal', 'aal2')::text,
    true
  );
  claimed_jobs := public.service_claim_notification_by_id((first_result ->> 'notificationId')::uuid);
  assert jsonb_array_length(claimed_jobs) = 1
    and claimed_jobs -> 0 ->> 'recipientManifestFrozen' = 'true'
    and claimed_jobs -> 0 -> 'recipients' = first_payload -> 'deliveryRecipients'
    and claimed_jobs -> 0 -> 'message' = first_payload -> 'deliveryMessage',
    'The targeted provider claim must use the queue-time manifest after recipient preference drift.';
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_auth_user_id, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  update private.notification_outbox
  set delivered_at = clock_timestamp(), attempted_at = clock_timestamp(), attempt_count = 1
  where id = (first_result ->> 'notificationId')::uuid;
  replay_result := public.queue_schedule_published_notification(
    schedule_id,
    first_operation_id,
    'First immutable notice'
  );
  assert replay_result ->> 'deliveryState' = 'delivered',
    'A response-loss retry after delivery must report the durable terminal outbox state.';

  begin
    perform public.queue_schedule_published_notification(
      schedule_id,
      first_operation_id,
      'Changed after the first writer'
    );
  exception
    when check_violation then
      conflict_rejected := sqlerrm = 'schedule_notification_operation_conflict';
  end;
  assert conflict_rejected,
    'The first operation manifest must reject a changed note on replay.';

  resend_result := public.queue_schedule_published_notification(
    schedule_id,
    resend_operation_id,
    'Deliberate resend'
  );
  assert resend_result ->> 'notificationId' is distinct from first_result ->> 'notificationId',
    'A deliberate resend must use a new operation UUID and outbox row.';
  assert (
    select count(*)
    from private.notification_outbox outbox
    where outbox.idempotency_key in (
      'schedule-published-manual-operation:' || first_operation_id::text,
      'schedule-published-manual-operation:' || resend_operation_id::text
    )
  ) = 2,
    'Two explicit operations must produce exactly two schedule notices.';

  -- Establish the rollback-only denial as the service role. A signed-in
  -- administrator cannot change their own permission overrides, which is a
  -- separate production safeguard and must remain enforced.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role', 'aal', 'aal2')::text,
    true
  );
  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    created_by
  ) values (
    actor_employee_id,
    'announcements.send',
    'deny',
    'Rollback-only schedule notice authorization regression',
    actor_employee_id
  )
  on conflict (employee_id, permission_code) where active do update
  set effect = excluded.effect,
      reason = excluded.reason,
      updated_at = clock_timestamp();
  perform set_config('request.jwt.claim.sub', actor_auth_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', actor_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  begin
    perform public.queue_schedule_published_notification(
      schedule_id,
      gen_random_uuid(),
      'Must not queue without announcement-send authority'
    );
  exception
    when insufficient_privilege then
      send_permission_rejected := true;
  end;
  assert send_permission_rejected,
    'Schedule-management authority alone must not queue a mass email notice.';
end
$durable_manual_schedule_notifications_regression$;

rollback;

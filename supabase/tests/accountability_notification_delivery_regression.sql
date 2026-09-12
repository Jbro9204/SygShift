begin;

set local statement_timeout = '15s';

do $$
declare
  actor_employee_id uuid;
  actor_auth_user_id uuid;
  target_employee_id uuid;
  created_event_id uuid;
  operation_result jsonb;
begin
  select employee.id, account.auth_user_id
  into actor_employee_id, actor_auth_user_id
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and account.disabled_at is null
    and not private.employee_required_action_checkpoint_enrolled(employee.id)
    and 'accountability.create' = any(private.employee_effective_permissions(employee.id))
    and 'accountability.manage' = any(private.employee_effective_permissions(employee.id))
  order by (employee.username = 'jbrown') desc, employee.id
  limit 1;

  select employee.id
  into target_employee_id
  from public.employees employee
  where employee.status = 'active'
    and employee.id is distinct from actor_employee_id
  order by employee.id
  limit 1;

  assert actor_employee_id is not null and actor_auth_user_id is not null,
    'The regression requires one active MFA-capable Accountability manager.';
  assert target_employee_id is not null,
    'The regression requires a second active employee.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', actor_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  operation_result := public.create_attendance_accountability_event(
    target_employee_id,
    null,
    'other',
    date '2026-09-11',
    'Rollback-only accountability notification regression.'
  );
  created_event_id := (operation_result ->> 'id')::uuid;

  assert created_event_id is not null,
    'Manager-created Accountability occurrence did not return an event.';
  assert (
    select count(*) = 1
    from public.attendance_accountability_event_actions action_record
    where action_record.event_id = created_event_id
      and action_record.action = 'created'
  ), 'The created action was not retained.';
  assert (
    select count(*) = 1
    from public.employee_notifications notification_record
    where notification_record.source_type = 'accountability_writeup'
      and notification_record.source_id = created_event_id
      and notification_record.recipient_employee_id = target_employee_id
  ), 'The employee did not receive the creation notification.';
  assert (
    select count(*) = 1
    from public.employee_notification_email_deliveries delivery_record
    join public.employee_notifications notification_record
      on notification_record.id = delivery_record.notification_id
    where notification_record.source_type = 'accountability_writeup'
      and notification_record.source_id = created_event_id
      and delivery_record.recipient_employee_id = target_employee_id
  ), 'The creation email delivery was not queued.';

  operation_result := public.review_attendance_accountability_event(
    created_event_id,
    'confirmed',
    'Rollback-only confirmation regression.'
  );
  assert operation_result ->> 'status' = 'resolved',
    'The Accountability decision did not save.';

  operation_result := public.reclassify_attendance_accountability_event(
    created_event_id,
    'late_arrival',
    'Rollback-only reclassification regression.'
  );
  assert operation_result ->> 'eventType' = 'late_arrival',
    'The Accountability classification did not save.';

  assert (
    select count(*) = 3
    from public.attendance_accountability_event_actions action_record
    where action_record.event_id = created_event_id
      and action_record.action in ('created', 'confirmed', 'reclassified')
  ), 'The complete append-only action history was not retained.';
  assert (
    select count(*) = 3
    from public.employee_notifications notification_record
    where notification_record.source_type = 'accountability_writeup'
      and notification_record.source_id = created_event_id
      and notification_record.recipient_employee_id = target_employee_id
  ), 'Each employee-facing Accountability action did not create one notification.';
  assert (
    select count(*) = 3
    from public.employee_notification_email_deliveries delivery_record
    join public.employee_notifications notification_record
      on notification_record.id = delivery_record.notification_id
    where notification_record.source_type = 'accountability_writeup'
      and notification_record.source_id = created_event_id
      and delivery_record.recipient_employee_id = target_employee_id
  ), 'Each employee-facing Accountability action did not queue one email delivery.';
end
$$;

rollback;

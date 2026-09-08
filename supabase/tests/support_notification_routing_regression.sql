-- Run only after 20260908143000 inside one outer BEGIN / ROLLBACK transaction.
-- This test creates temporary ticket/access fixtures and must never be committed.
do $$
declare
  admin_id uuid;
  admin_auth uuid;
  submitter_id uuid;
  submitter_auth uuid;
  handler_id uuid;
  handler_auth uuid;
  dispatcher_id uuid;
  fixture_role_id uuid;
  fixture_role_code text := 'support_regression_' || replace(gen_random_uuid()::text, '-', '');
  request_id uuid := gen_random_uuid();
  ticket_id uuid;
  submitted_event_id bigint;
  reply_event_id bigint;
  message_id bigint;
  routine_notification_id uuid;
  required_notification_id uuid;
  expected_open_recipients bigint;
  open_recipient_count bigint;
  clear_result jsonb;
  result jsonb;
begin
  select employee.id, account.auth_user_id
  into admin_id, admin_auth
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = 'admin'
    and account.disabled_at is null
  limit 1;

  select employee.id, account.auth_user_id
  into submitter_id, submitter_auth
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = 'guard'
    and account.disabled_at is null
    and not ('support.tickets.manage' = any(private.employee_effective_permissions(employee.id)))
  order by employee.id
  limit 1;

  select employee.id, account.auth_user_id
  into handler_id, handler_auth
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = 'guard'
    and account.disabled_at is null
    and employee.id <> submitter_id
    and not ('support.tickets.manage' = any(private.employee_effective_permissions(employee.id)))
  order by employee.id
  limit 1;

  select employee.id
  into dispatcher_id
  from public.employees employee
  where employee.status = 'active' and employee.role = 'dispatcher'
  limit 1;

  assert admin_auth is not null, 'An active Admin account is required';
  assert submitter_auth is not null and handler_auth is not null, 'Two active Guard accounts are required';
  assert dispatcher_id is not null, 'An active Dispatcher is required';
  assert private.employee_requires_mfa(dispatcher_id), 'Dispatcher MFA is inherited from system_dispatcher';
  assert exists (
    select 1 from public.access_roles access_role
    where access_role.code = 'system_dispatcher'
      and access_role.base_app_role = 'dispatcher'
      and access_role.system_role
      and access_role.protected
      and access_role.active
  ), 'Dispatcher remains represented by the protected access-role catalog';

  insert into public.access_roles(
    code, name, description, system_role, protected, mfa_required, active
  ) values (
    fixture_role_code,
    'Support routing regression handler',
    'Rollback-only support routing fixture.',
    false,
    false,
    true,
    true
  ) returning id into fixture_role_id;

  insert into public.access_role_permissions(role_id, permission_code, enabled)
  values
    (fixture_role_id, 'support.tickets.view', true),
    (fixture_role_id, 'support.tickets.manage', true),
    (fixture_role_id, 'schedule.manage', true);

  insert into public.employee_access_roles(employee_id, role_id, assigned_by)
  values (handler_id, fixture_role_id, admin_id);

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', submitter_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );

  result := public.submit_support_ticket(jsonb_build_object(
    'requestId', request_id,
    'category', 'schedule',
    'subcategory', 'Assigned shift missing',
    'subject', 'Support routing regression fixture',
    'description', 'Rollback-only fixture that verifies exact ticket recipients.',
    'confidential', false
  ));
  ticket_id := (result ->> 'id')::uuid;

  select event.id into submitted_event_id
  from public.support_ticket_events event
  where event.ticket_id = ticket_id and event.event_type = 'submitted';

  select 1 + count(*)
  into expected_open_recipients
  from private.support_notification_recipients('schedule.manage') recipient
  where recipient.employee_id <> submitter_id;

  select count(*) into open_recipient_count
  from public.support_ticket_notifications notification
  where notification.event_id = submitted_event_id;

  assert open_recipient_count = expected_open_recipients,
    'Ticket opened goes only to the requester and exact operational route';
  assert not exists (
    select 1
    from public.support_ticket_notifications notification
    join public.employees employee on employee.id = notification.recipient_employee_id
    where notification.event_id = submitted_event_id and employee.role = 'admin'
  ), 'Admins retain access without automatic email when an operational handler exists';
  assert not exists (
    select 1
    from public.support_ticket_notifications notification
    where notification.event_id = submitted_event_id
    group by notification.recipient_employee_id
    having count(*) > 1
  ), 'One event creates at most one delivery per recipient';

  result := public.submit_support_ticket(jsonb_build_object(
    'requestId', request_id,
    'category', 'schedule',
    'subject', 'Support routing regression fixture',
    'description', 'Rollback-only fixture that verifies exact ticket recipients.',
    'confidential', false
  ));
  assert (result ->> 'id')::uuid = ticket_id, 'Submission retries return the original ticket';
  assert (
    select count(*) from public.support_ticket_notifications notification
    where notification.event_id = submitted_event_id
  ) = open_recipient_count, 'Submission retries do not queue duplicate email or inbox items';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', admin_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform public.update_support_ticket(ticket_id, jsonb_build_object('assignedTo', handler_id));

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', submitter_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  message_id := public.add_support_ticket_message(
    ticket_id,
    'The employee added one follow-up for the assigned handler.',
    false
  );
  select event.id into reply_event_id
  from public.support_ticket_events event
  where event.ticket_id = ticket_id
    and (event.detail ->> 'messageId')::bigint = message_id;
  assert (
    select array_agg(notification.recipient_employee_id order by notification.recipient_employee_id)
    from public.support_ticket_notifications notification
    where notification.event_id = reply_event_id
  ) = array[handler_id], 'Employee reply alerts only the assigned handler';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', handler_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  message_id := public.add_support_ticket_message(
    ticket_id,
    'The assigned handler replied directly to the requester.',
    false
  );
  select event.id into reply_event_id
  from public.support_ticket_events event
  where event.ticket_id = ticket_id
    and (event.detail ->> 'messageId')::bigint = message_id;
  assert (
    select array_agg(notification.recipient_employee_id order by notification.recipient_employee_id)
    from public.support_ticket_notifications notification
    where notification.event_id = reply_event_id
  ) = array[submitter_id], 'Handler reply alerts only the requester';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', admin_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  perform public.update_support_ticket(ticket_id, '{"status":"resolved"}'::jsonb);

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', submitter_auth, 'role', 'authenticated', 'aal', 'aal2')::text,
    true
  );
  result := public.read_support_ticket(ticket_id);
  assert result ->> 'status' = 'resolved', 'Requester reads the authoritative resolved status';
  result := public.get_support_workspace(jsonb_build_object(
    'status', 'resolved',
    'search', 'Support routing regression fixture'
  ));
  assert exists (
    select 1 from jsonb_array_elements(result -> 'tickets') item
    where item ->> 'id' = ticket_id::text and item ->> 'status' = 'resolved'
  ), 'Requester queue refresh returns the authoritative resolved status';

  routine_notification_id := private.create_employee_notification(
    submitter_id,
    'regression',
    null,
    'clear-routine:' || gen_random_uuid()::text,
    'Routine clear fixture',
    'This rollback-only notification may be dismissed by Clear All.'
  );
  required_notification_id := private.create_employee_notification(
    submitter_id,
    'regression',
    null,
    'clear-required:' || gen_random_uuid()::text,
    'Required clear fixture',
    'This rollback-only notification must remain until acknowledged.',
    'important',
    true
  );

  clear_result := public.clear_my_notifications();
  assert (clear_result ->> 'remainingRequired')::integer >= 1,
    'Clear All reports notifications that still require action';
  assert exists (
    select 1 from public.employee_notifications notification
    where notification.id = routine_notification_id
      and notification.read_at is not null
      and notification.dismissed_at is not null
  ), 'Clear All marks and dismisses an ordinary notification';
  assert exists (
    select 1 from public.employee_notifications notification
    where notification.id = required_notification_id
      and notification.read_at is not null
      and notification.acknowledged_at is null
      and notification.dismissed_at is null
  ), 'Clear All cannot bypass a required acknowledgment';
  assert not exists (
    select 1 from public.support_ticket_notifications notification
    where notification.ticket_id = ticket_id
      and notification.recipient_employee_id = submitter_id
      and notification.read_at is null
  ), 'Clear All synchronizes the support read ledger';

  assert not has_function_privilege('anon', 'public.clear_my_notifications()', 'EXECUTE'),
    'Anonymous notification clearing stays denied';
  assert has_function_privilege('authenticated', 'public.clear_my_notifications()', 'EXECUTE'),
    'Authenticated employees may clear only their own inbox through the RPC';
  assert not has_function_privilege(
    'authenticated',
    'public.service_claim_support_ticket_notification_batch(integer)',
    'EXECUTE'
  ), 'Browser sessions cannot claim the delivery queue';
  assert position(
    'private.support_employee_can_view(employee.id, new)'
    in pg_get_functiondef('private.signal_support_update()'::regprocedure)
  ) > 0, 'Support status changes invalidate every currently authorized viewer';
end
$$;

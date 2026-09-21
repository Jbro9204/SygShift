-- Read-only function-contract regression. Run after 20260921185816.
do $$
declare
  routing_definition text := pg_get_functiondef(
    'private.support_notification_recipients(text)'::regprocedure
  );
  mirror_definition text := pg_get_functiondef(
    'private.mirror_support_ticket_notification()'::regprocedure
  );
  sync_definition text := pg_get_functiondef(
    'private.sync_support_ticket_notification_to_inbox(uuid)'::regprocedure
  );
begin
  assert position('system_admin' in routing_definition) > 0,
    'Additional Administrator role membership remains an authorized ticket recipient';
  assert position('support.tickets.view' in routing_definition) > 0
    and position('support.tickets.manage' in routing_definition) > 0,
    'Operational ticket recipients still require both routed ticket permissions';
  assert position('support_employee_can_view' in sync_definition) > 0,
    'In-app ticket synchronization rechecks recipient access';
  assert position('Submitted by:' in sync_definition) > 0
    and position('Priority:' in sync_definition) > 0
    and position('Category:' in sync_definition) > 0
    and position('Summary:' in sync_definition) > 0,
    'Ticket inbox items include the requested decision-making context';
  assert position('Private HR or workplace concern' in sync_definition) > 0
    and position('Protected details are available only inside the authorized Support Tickets workspace.' in sync_definition) > 0,
    'Confidential ticket content remains protected in the notification center';
  assert position('sync_support_ticket_notification_to_inbox' in mirror_definition) > 0,
    'Every new ticket delivery is mirrored through the enriched notification path';
  assert not has_function_privilege(
    'authenticated',
    'private.sync_support_ticket_notification_to_inbox(uuid)',
    'EXECUTE'
  ), 'Browser sessions cannot invoke the protected ticket inbox synchronizer';
end
$$;

-- Read-only function-contract regression. Run after 20260921182231.
do $$
declare
  claim_definition text := pg_get_functiondef(
    'public.service_claim_support_ticket_notification_batch(integer)'::regprocedure
  );
begin
  assert position('private.support_employee_can_view(notification.recipient_employee_id, ticket)' in claim_definition) > 0,
    'Ticket email delivery still rechecks recipient access before release';
  assert position('for update of notification skip locked' in lower(claim_definition)) > 0,
    'Ticket email claims remain concurrency safe';
  assert position('''supportTicket'', jsonb_build_object(' in claim_definition) > 0,
    'Ticket email claims include the structured support context';
  assert position('Private HR or workplace concern' in claim_definition) > 0,
    'Confidential subjects remain redacted before Worker delivery';
  assert position('Protected details are available only inside SygShift.' in claim_definition) > 0,
    'Confidential descriptions remain redacted before Worker delivery';
  assert not has_function_privilege(
    'authenticated',
    'public.service_claim_support_ticket_notification_batch(integer)',
    'EXECUTE'
  ), 'Browser sessions cannot claim support ticket email jobs';
  assert has_function_privilege(
    'service_role',
    'public.service_claim_support_ticket_notification_batch(integer)',
    'EXECUTE'
  ), 'The protected Worker delivery role retains claim access';
end
$$;

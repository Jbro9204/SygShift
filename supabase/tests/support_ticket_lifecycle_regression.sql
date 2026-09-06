-- Run inside a transaction and ROLLBACK. No email processor is invoked.
-- Requires the linked application's existing active Admin/employee accounts.
do $$
declare
  admin_employee uuid; admin_auth uuid; fixture_employee_id uuid; employee_auth uuid;
  request_key uuid := gen_random_uuid(); result jsonb; fixture_ticket_id uuid; fixture_event_id bigint;
  baseline bigint; expected bigint; batch jsonb; second_batch jsonb; item record;
  original_updated timestamptz; note_id bigint; own_ticket uuid; other_admin_auth uuid;
begin
  select employee.id, account.auth_user_id into admin_employee, admin_auth
  from public.employees employee join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active' and employee.role = 'admin' and account.disabled_at is null limit 1;
  select employee.id, account.auth_user_id into fixture_employee_id, employee_auth
  from public.employees employee join private.employee_accounts account on account.employee_id = employee.id
  where employee.status = 'active' and employee.role = 'guard' and account.disabled_at is null
    and not ('support.tickets.manage' = any(private.employee_effective_permissions(employee.id))) limit 1;
  assert admin_auth is not null and employee_auth is not null, 'Test actors are required';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',employee_auth,'role','authenticated','aal','aal2')::text,true);
  result := public.submit_support_ticket(jsonb_build_object('requestId',request_key,'category','human_resources','subcategory','Policy question','subject','Ticket regression fixture','description','A transaction-only request used to verify support behavior.','confidential',true));
  fixture_ticket_id := (result->>'id')::uuid;
  select count(*) into baseline from public.support_ticket_notifications n where n.ticket_id = (result->>'id')::uuid;
  select count(*) into expected from public.employees employee where employee.status = 'active' and (employee.id = fixture_employee_id or employee.role = 'admin' or ('support.tickets.view' = any(private.employee_effective_permissions(employee.id)) and 'hr.people.manage' = any(private.employee_effective_permissions(employee.id))));
  assert baseline = expected, 'Opening routes to the exact authorized recipient set';
  assert not exists(select 1 from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id and n.message_type <> 'support_ticket_opened'), 'Only the opened event is queued';
  assert not exists(select 1 from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id and position('\n' in n.body) > 0), 'Email text contains real newlines';
  assert not exists(select 1 from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id group by n.recipient_employee_id having count(*) <> 1), 'One opening delivery per person';
  assert (select count(*) from public.employee_notifications n where n.source_id = fixture_ticket_id) = expected, 'One mirrored inbox item per person';
  result := public.submit_support_ticket(jsonb_build_object('requestId',request_key,'category','human_resources','subject','Ticket regression fixture','description','A transaction-only request used to verify support behavior.','confidential',true));
  assert (result->>'id')::uuid = fixture_ticket_id, 'Submission retry returns the same ticket';
  assert (select count(*) from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id) = baseline, 'Submission retry queues nothing';
  begin
    perform public.update_support_ticket(fixture_ticket_id, '{"status":"resolved"}');
    raise exception 'Requester must not manage a ticket';
  exception when insufficient_privilege then null; end;
  begin
    perform public.add_support_ticket_message(fixture_ticket_id, 'Private note must be denied', true);
    raise exception 'Requester must not write internal notes';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',admin_auth,'role','authenticated','aal','aal2')::text,true);
  select updated_at into original_updated from public.support_tickets t where t.id = fixture_ticket_id;
  perform public.update_support_ticket(fixture_ticket_id, '{"status":"new","priority":"normal"}');
  assert (select updated_at from public.support_tickets t where t.id = fixture_ticket_id) = original_updated, 'No-op save does not touch activity';
  assert (select count(*) from public.support_ticket_events e where e.ticket_id = fixture_ticket_id) = 1, 'No-op save creates no event';
  perform public.update_support_ticket(fixture_ticket_id, '{"priority":"urgent"}');
  assert (select count(*) from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id) = baseline, 'Priority edit does not claim a status change';
  perform public.update_support_ticket(fixture_ticket_id, jsonb_build_object('assignedTo',admin_employee));
  assert (select count(*) from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id) = baseline, 'Self-assignment does not echo New to the requester';
  note_id := public.add_support_ticket_message(fixture_ticket_id, 'Handler-only confidential note.', true);
  assert (select count(*) from public.support_ticket_notifications n where n.ticket_id = fixture_ticket_id) = baseline, 'Internal notes queue no email or inbox item';
  perform public.add_support_ticket_message(fixture_ticket_id, 'We have started working on this request.', false);
  assert (select status from public.support_tickets t where t.id = fixture_ticket_id) = 'in_progress', 'Public handler reply advances the ticket';
  select id into fixture_event_id from public.support_ticket_events e where e.ticket_id = fixture_ticket_id order by id desc limit 1;
  assert (select detail->>'previousStatus' from public.support_ticket_events e where e.id = fixture_event_id) = 'new', 'Automatic status change has before/after evidence';
  assert (select count(*) from public.support_ticket_notifications n where n.event_id = fixture_event_id and n.recipient_employee_id = fixture_employee_id) = 1, 'Reply and automatic status change share one email';
  assert (select body like '%Status: In Progress%' from public.support_ticket_notifications n where n.event_id = fixture_event_id and n.recipient_employee_id = fixture_employee_id), 'Combined update includes the status';
  select * into item from public.support_ticket_notifications n where n.event_id = fixture_event_id limit 1;
  perform private.queue_support_ticket_notification(fixture_ticket_id,fixture_event_id,item.recipient_employee_id,'duplicate','Duplicate attempt','Must not appear','a-different-caller-key');
  assert (select count(*) from public.support_ticket_notifications n where n.event_id = fixture_event_id and n.recipient_employee_id = item.recipient_employee_id) = 1, 'Event recipient deduplication ignores caller key differences';
  perform public.update_support_ticket(fixture_ticket_id, '{"status":"closed"}');
  assert (select status from public.support_tickets t where t.id = fixture_ticket_id) = 'resolved', 'Old clients map Closed to Resolved';
  result := public.get_support_workspace('{"status":"open","search":"Ticket regression fixture"}');
  assert not exists(select 1 from jsonb_array_elements(result->'tickets') t where t->>'id' = fixture_ticket_id::text), 'Resolved ticket is absent from open queue';
  result := public.get_support_workspace('{"status":"resolved","search":"Ticket regression fixture"}');
  assert exists(select 1 from jsonb_array_elements(result->'tickets') t where t->>'id' = fixture_ticket_id::text), 'Resolved ticket remains searchable';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',employee_auth,'role','authenticated','aal','aal2')::text,true);
  result := public.get_support_ticket(fixture_ticket_id);
  assert not exists(select 1 from jsonb_array_elements(result->'messages') message where (message->>'id')::bigint = note_id), 'Requester cannot read internal notes';
  assert not exists(select 1 from public.employee_notifications n where n.source_id = fixture_ticket_id and n.recipient_employee_id = fixture_employee_id and n.read_at is null), 'Opening a ticket clears its unified unread items';
  perform public.add_support_ticket_message(fixture_ticket_id, 'I still need help with this request.', false);
  assert (select status from public.support_tickets t where t.id = fixture_ticket_id) = 'reopened', 'Requester can reopen a resolved ticket by replying';
  assert (select resolved_at from public.support_tickets t where t.id = fixture_ticket_id) is null, 'Reopened ticket is no longer resolved';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',admin_auth,'role','authenticated','aal','aal2')::text,true);
  result := public.submit_support_ticket(jsonb_build_object('category','technical','subject','Admin requester fixture','description','A transaction-only request from an Admin handler.'));
  own_ticket := (result->>'id')::uuid;
  assert (select count(*) from public.support_ticket_notifications n where n.ticket_id = own_ticket and n.recipient_employee_id = admin_employee) = 1, 'Requester who is also a handler receives one opening';
  select account.auth_user_id into other_admin_auth from private.employee_accounts account join public.employees employee on employee.id = account.employee_id where employee.role = 'admin' and employee.status = 'active' and account.disabled_at is null and employee.id <> admin_employee limit 1;
  assert other_admin_auth is not null, 'A second administrator is required for overlapping recipient verification';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',other_admin_auth,'role','authenticated','aal','aal2')::text,true);
  perform public.update_support_ticket(own_ticket, jsonb_build_object('status','in_progress','assignedTo',admin_employee));
  select id into fixture_event_id from public.support_ticket_events e where e.ticket_id = own_ticket order by id desc limit 1;
  assert (select count(*) from public.support_ticket_notifications n where n.event_id = fixture_event_id and n.recipient_employee_id = admin_employee) = 1, 'Requester and new assignee overlap yields one combined update';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',employee_auth,'role','authenticated','aal','aal2')::text,true);
  begin
    perform public.get_support_ticket(own_ticket);
    raise exception 'Unrelated employee must not read a ticket';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', '{"role":"anon"}',true);
  begin
    perform public.get_support_workspace('{}');
    raise exception 'Unauthenticated access must be denied';
  exception when insufficient_privilege then null; end;
  assert not has_function_privilege('anon','public.update_support_ticket(uuid,jsonb)','EXECUTE'), 'Anonymous update grant stays revoked';
  assert not has_table_privilege('authenticated','public.support_tickets','UPDATE'), 'Browser direct write stays revoked';
  update private.employee_accounts set disabled_at = clock_timestamp() where employee_id = fixture_employee_id;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',employee_auth,'role','authenticated','aal','aal2')::text,true);
  begin
    perform public.get_support_ticket(fixture_ticket_id);
    raise exception 'Disabled employee must not read a ticket';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}',true);
  batch := public.service_claim_support_ticket_notification_batch(50);
  second_batch := public.service_claim_support_ticket_notification_batch(50);
  assert not exists(select 1 from jsonb_array_elements(batch) a join jsonb_array_elements(second_batch) b on a->>'id' = b->>'id'), 'Delivery lease prevents simultaneous claims';
  assert (select count(*) from public.support_ticket_messages m where m.ticket_id = fixture_ticket_id) = 3, 'All public and internal messages survive the lifecycle';
end
$$;

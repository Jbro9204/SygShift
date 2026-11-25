create temporary table technology_support_checks (name text, passed boolean not null);
create function pg_temp.check_technology_support(name text, result boolean) returns void language sql as $$
  insert into technology_support_checks values (name, coalesce(result,false))
$$;

do $checks$
declare
  requester uuid := '10000000-0000-4000-8000-000000000001';
  other_requester uuid := '10000000-0000-4000-8000-000000000002';
  manager uuid := '10000000-0000-4000-8000-000000000003';
  viewer uuid := '10000000-0000-4000-8000-000000000004';
  admin uuid := '10000000-0000-4000-8000-000000000005';
  disabled uuid := '10000000-0000-4000-8000-000000000006';
  created_ticket_id uuid;
  other_ticket_id uuid;
  hidden_ticket_id uuid;
  account_ticket_id uuid;
  submit_input jsonb;
  response jsonb;
  next_page jsonb;
  action_wire jsonb;
  old_stamp timestamptz;
  new_stamp timestamptz;
  note_message bigint;
  notification_count bigint;
  event_count bigint;
  reply_key uuid := gen_random_uuid();
  action_key uuid;
begin
  perform set_config('fixture.actor', requester::text, true);
  submit_input := jsonb_build_object(
    'requestId', gen_random_uuid(), 'category', 'technical', 'subcategory','Application',
    'subject', 'New laptop ticket',
    'description', 'Synthetic ticket for the representative technology service workflow.'
  );
  response := public.submit_support_ticket(submit_input);
  created_ticket_id := (response ->> 'id')::uuid;
  perform pg_temp.check_technology_support('canonical submit idempotency', public.submit_support_ticket(submit_input) = response);
  perform pg_temp.check_technology_support('canonical requester receipt', (
    select count(*) = 1 from public.support_ticket_notifications n where n.ticket_id = (response ->> 'id')::uuid and n.recipient_employee_id = requester
  ));

  insert into public.support_tickets(submitted_by, subject, category, subcategory, description, route_permission, updated_at)
  select case when ordinal % 2 = 0 then other_requester else requester end,
    'Fixture technical ' || ordinal, 'technical','Application','Synthetic ticket seed used by technology queue tests.',
    'admin.maintenance.manage', statement_timestamp() - make_interval(days => ordinal)
  from generate_series(1, 6) as ordinal;
  update public.support_tickets set updated_at = statement_timestamp() - interval '20 days' + interval '1 microsecond'
    where subject in ('Fixture technical 1', 'Fixture technical 2');

  select t.id into other_ticket_id from public.support_tickets t where t.subject='Fixture technical 2';
  insert into public.support_tickets(submitted_by, subject, category, subcategory, description, confidential, route_permission)
  values (requester,'Private IT request','technical','Application','Synthetic protected support case for role boundary assertions.',true,'hr.people.manage')
  returning id into hidden_ticket_id;
  insert into public.support_tickets(submitted_by, subject, category, subcategory, description, priority, route_permission)
  select other_requester,'Fixture account ' || ordinal,'account_access','Sign-in',
    'Synthetic sign-in support case for queue isolation assertions.','urgent','admin.users.manage'
  from generate_series(1, 12) as ordinal;
  select t.id into account_ticket_id from public.support_tickets t where t.subject='Fixture account 1';
  insert into public.support_tickets(submitted_by, subject, category, subcategory, description, priority, route_permission)
  values (requester,'Private HR not technical','human_resources','Other','Synthetic HR ticket excluded from every new desk.','urgent','hr.people.manage');

  response := public.get_sygilant_technology_ticket_workspace_v1('{"view":"mine","status":"all"}');
  perform pg_temp.check_technology_support('employee own-only total including all categories and own confidential record', (response #>> '{page,total}')::int = 6);
  perform pg_temp.check_technology_support('employee owner UUID is canonical and exact', not exists (
    select 1 from jsonb_array_elements(response -> 'tickets') row where (row #>> '{submittedBy,id}')::uuid <> requester
  ));
  perform pg_temp.check_technology_support('mine can see own private record', exists (
    select 1 from jsonb_array_elements(response -> 'tickets') row where (row ->> 'id')::uuid = hidden_ticket_id
  ));
  perform pg_temp.check_technology_support('mine never presents staff management', not (response #>> '{permissions,canManage}')::boolean);

  begin
    perform public.get_sygilant_technology_ticket_workspace_v1('{"view":"it"}');
    perform pg_temp.check_technology_support('non-staff IT queue denied', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('non-staff IT queue denied', true);
  end;
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
      'view','mine','operation','reply','ticketId',other_ticket_id,'requestId',gen_random_uuid(),'body','Not my ticket.'
    ));
    perform pg_temp.check_technology_support('requester cannot reply as another employee', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('requester cannot reply as another employee', true);
  end;
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
      'view','mine','operation','note','ticketId',created_ticket_id,'requestId',gen_random_uuid(),'body','Not an internal note.'
    ));
    perform pg_temp.check_technology_support('requester cannot author internal note', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('requester cannot author internal note', true);
  end;

  perform set_config('fixture.actor', manager::text, true);
  perform set_config('fixture.aal2', 'true', true);
  response := public.get_support_workspace('{"page":1,"pageSize":5,"status":"open"}');
  perform pg_temp.check_technology_support('canonical mixed desk remains unchanged and its first page has no IT tickets', not exists (
    select 1 from jsonb_array_elements(response -> 'tickets') row where row ->> 'category' = 'technical'
  ));
  response := public.get_sygilant_technology_ticket_workspace_v1('{"view":"it","page":1,"pageSize":5,"order":"oldest"}');
  next_page := public.get_sygilant_technology_ticket_workspace_v1('{"view":"it","page":2,"pageSize":5,"order":"oldest"}');
  perform pg_temp.check_technology_support('IT category filter applied before correct total and pagination',
    (response #>> '{page,total}')::int = 7 and (response #>> '{page,totalPages}')::int = 2
    and jsonb_array_length(response -> 'tickets') = 5 and jsonb_array_length(next_page -> 'tickets') = 2
    and not exists (select 1 from jsonb_array_elements((response -> 'tickets') || (next_page -> 'tickets')) item where item ->> 'category' <> 'technical')
  );
  perform pg_temp.check_technology_support('oldest sorting applied across every page and uses stable UUID tie',
    not exists (select 1 from jsonb_array_elements(response -> 'tickets') a join jsonb_array_elements(next_page -> 'tickets') b on a ->> 'id' = b ->> 'id')
    and (response #>> '{tickets,0,updatedAt}')::timestamptz < (next_page #>> '{tickets,0,updatedAt}')::timestamptz
    and (response #>> '{tickets,0,id}')::uuid < (response #>> '{tickets,1,id}')::uuid
    and (response #>> '{tickets,0,updatedAt}')::timestamptz = (response #>> '{tickets,1,updatedAt}')::timestamptz
  );
  perform pg_temp.check_technology_support('IT search is scoped and treats search metacharacters literally',
    (public.get_sygilant_technology_ticket_workspace_v1('{"view":"it","search":"%"}') #>> '{page,total}')::int = 0
    and (public.get_sygilant_technology_ticket_workspace_v1('{"view":"it","search":"LAPTOP"}') #>> '{page,total}')::int = 1);
  perform pg_temp.check_technology_support('cybersecurity queue scopes before count', (
    public.get_sygilant_technology_ticket_workspace_v1('{"view":"cybersecurity","page":1,"pageSize":5}') #>> '{page,total}'
  )::int = 12);
  perform pg_temp.check_technology_support('admin technology view excludes HR and confidential', (
    public.get_sygilant_technology_ticket_workspace_v1('{"view":"admin"}') #>> '{page,total}'
  )::int = 19);
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
      'view','it','operation','reply','ticketId',account_ticket_id,'requestId',gen_random_uuid(),'body','Wrong desk.'
    ));
    perform pg_temp.check_technology_support('wrong category denied even for actor on both desks', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('wrong category denied even for actor on both desks', true);
  end;

  perform set_config('fixture.actor', admin::text, true);
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
      'view','admin','operation','note','ticketId',hidden_ticket_id,'requestId',gen_random_uuid(),'body','Confidential case remains separate.'
    ));
    perform pg_temp.check_technology_support('confidential ticket excluded from Admin technology mutation', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('confidential ticket excluded from Admin technology mutation', true);
  end;
  update public.employees set permissions = array_remove(permissions, 'support.tickets.manage') where id = admin;
  perform pg_temp.check_technology_support('Admin with a denied manage grant is presented as read-only', (
    public.get_sygilant_technology_ticket_workspace_v1('{"view":"admin"}') #>> '{permissions,canManage}'
  )::boolean = false);
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
      'view','admin','operation','reply','ticketId',created_ticket_id,'requestId',gen_random_uuid(),'body','No bypass for missing manage grant.'
    ));
    perform pg_temp.check_technology_support('Admin cannot bypass a missing exact manage grant', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('Admin cannot bypass a missing exact manage grant', true);
  end;

  perform set_config('fixture.actor', viewer::text, true);
  perform pg_temp.check_technology_support('reader can list but cannot manage', (
    public.get_sygilant_technology_ticket_workspace_v1('{"view":"it"}') #>> '{permissions,canManage}'
  )::boolean = false);
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
      'view','it','operation','reply','ticketId',created_ticket_id,'requestId',gen_random_uuid(),'body','Reader cannot send.'
    ));
    perform pg_temp.check_technology_support('staff read-only cannot post', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('staff read-only cannot post', true);
  end;

  perform set_config('fixture.actor', manager::text, true);
  perform set_config('fixture.aal2', 'false', true);
  begin
    perform public.get_sygilant_technology_ticket_workspace_v1('{"view":"it"}');
    perform pg_temp.check_technology_support('staff needs existing MFA assurance', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('staff needs existing MFA assurance', true);
  end;
  perform set_config('fixture.actor', disabled::text, true);
  begin
    perform public.get_sygilant_technology_ticket_workspace_v1('{"view":"mine"}');
    perform pg_temp.check_technology_support('disabled requester denied', false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('disabled requester denied', true);
  end;

  perform set_config('fixture.actor', manager::text, true);
  perform set_config('fixture.aal2', 'true', true);
  select t.updated_at into old_stamp from public.support_tickets t where t.subject = 'New laptop ticket';
  select count(*) into notification_count from public.support_ticket_notifications n where n.ticket_id = created_ticket_id;
  select count(*) into event_count from public.support_ticket_events e where e.ticket_id = created_ticket_id;
  action_key := gen_random_uuid();
  action_wire := jsonb_build_object('view','it','operation','update','ticketId',created_ticket_id,'requestId',action_key,
    'expectedUpdatedAt', old_stamp, 'changes', jsonb_build_object('assignedTo',manager));
  response := public.apply_sygilant_technology_ticket_action_v1(action_wire);
  perform pg_temp.check_technology_support('canonical assignment succeeds and has exact retry receipt without duplicate event',
    response = public.apply_sygilant_technology_ticket_action_v1(action_wire)
    and (select t.assigned_to = manager from public.support_tickets t where t.subject='New laptop ticket')
    and (select count(*) = event_count + 1 from public.support_ticket_events e where e.ticket_id = created_ticket_id)
    and (select count(*) = 1 from private.audit_events e
      where e.row_id = created_ticket_id::text and e.operation = 'UPDATE' and e.employee_id = manager)
  );
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(
      action_wire || jsonb_build_object('changes','{"status":"resolved"}'::jsonb)
    );
    perform pg_temp.check_technology_support('idempotency key cannot change the action', false);
  exception when sqlstate 'PT409' then
    perform pg_temp.check_technology_support('idempotency key cannot change the action', sqlerrm='ticket_request_conflict');
  end;
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(
      action_wire || jsonb_build_object('requestId',gen_random_uuid(),'changes','{"status":"resolved"}'::jsonb)
    );
    perform pg_temp.check_technology_support('stale write rejected before canonical update', false);
  exception when sqlstate 'PT409' then
    perform pg_temp.check_technology_support('stale write rejected before canonical update', sqlerrm='ticket_changed');
  end;

  action_wire := jsonb_build_object('view','it','operation','note','ticketId',created_ticket_id,'requestId',gen_random_uuid(),
    'body','A synthetic internal note that is never sent.');
  response := public.apply_sygilant_technology_ticket_action_v1(action_wire);
  note_message := (response ->> 'messageId')::bigint;
  perform pg_temp.check_technology_support('internal note returns canonical message ID, can be retried, and never queues notification',
    note_message > 0 and response = public.apply_sygilant_technology_ticket_action_v1(action_wire)
    and (select count(*) = notification_count from public.support_ticket_notifications n where n.ticket_id = created_ticket_id)
    and (select m.visibility = 'internal' and not m.email_requester from public.support_ticket_messages m where m.id = note_message)
  );

  action_wire := jsonb_build_object('view','it','operation','reply','ticketId',created_ticket_id,'requestId',reply_key,'body','We are fixing the synthetic report.');
  response := public.apply_sygilant_technology_ticket_action_v1(action_wire);
  perform pg_temp.check_technology_support('reply retry creates one message and canonical requester notification',
    response = public.apply_sygilant_technology_ticket_action_v1(action_wire)
    and (select count(*) = 1 from public.support_ticket_messages m where m.ticket_id = created_ticket_id and m.visibility = 'public')
    and (select count(*) = notification_count + 1 from public.support_ticket_notifications n where n.ticket_id = created_ticket_id)
    and (select count(*) = 1 from private.audit_events e
      where e.row_id = response ->> 'messageId' and e.operation = 'PUBLIC_REPLY' and e.employee_id = manager)
    and (select t.status = 'in_progress' from public.support_tickets t where t.subject='New laptop ticket')
  );
  select t.updated_at into new_stamp from public.support_tickets t where t.subject = 'New laptop ticket';
  response := public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object(
    'view','it','operation','update','ticketId',created_ticket_id,'requestId',gen_random_uuid(),
    'expectedUpdatedAt',new_stamp,'changes','{"status":"resolved"}'::jsonb));
  perform pg_temp.check_technology_support('resolve matches canonical status and leaves open queue', (
    public.get_sygilant_technology_ticket_workspace_v1('{"view":"it","status":"open","search":"new laptop"}') #>> '{page,total}'
  )::int = 0 and (
    public.get_sygilant_technology_ticket_workspace_v1('{"view":"it","status":"resolved","search":"new laptop"}') #>> '{page,total}'
  )::int = 1);

  perform set_config('fixture.actor', requester::text, true);
  perform set_config('fixture.aal2', 'false', true);
  response := public.read_support_ticket(created_ticket_id);
  perform pg_temp.check_technology_support('requester receives resolved status and no private note or audit events',
    (response ->> 'status') = 'resolved' and jsonb_array_length(response -> 'messages') = 1
    and jsonb_array_length(response -> 'events') = 0);
  action_wire := jsonb_build_object('view','mine','operation','reply','ticketId',created_ticket_id,
    'requestId',reply_key,'body','I still need help with this synthetic ticket.');
  response := public.apply_sygilant_technology_ticket_action_v1(action_wire);
  perform pg_temp.check_technology_support('actor-bound key and canonical reopen on requester reply',
    response = public.apply_sygilant_technology_ticket_action_v1(action_wire)
    and (public.read_support_ticket(created_ticket_id) ->> 'status') = 'reopened'
    and (select count(*) = 2 from public.support_ticket_messages m where m.ticket_id = created_ticket_id and m.visibility = 'public')
  );

  perform pg_temp.check_technology_support('RPCs grant only authenticated and receipt table stays private with forced RLS',
    has_function_privilege('authenticated','public.get_sygilant_technology_ticket_workspace_v1(jsonb)','execute')
    and has_function_privilege('authenticated','public.apply_sygilant_technology_ticket_action_v1(jsonb)','execute')
    and has_function_privilege('authenticated','public.read_sygilant_technology_ticket_v1(jsonb)','execute')
    and not has_function_privilege('anon','public.get_sygilant_technology_ticket_workspace_v1(jsonb)','execute')
    and not has_function_privilege('anon','public.read_sygilant_technology_ticket_v1(jsonb)','execute')
    and not has_function_privilege('service_role','public.apply_sygilant_technology_ticket_action_v1(jsonb)','execute')
    and not has_table_privilege('authenticated','private.sygilant_technology_ticket_action_receipts','select')
    and (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.sygilant_technology_ticket_action_receipts'::regclass)
  );
end
$checks$;

do $department_checks$
declare
  requester uuid := '10000000-0000-4000-8000-000000000001';
  other_requester uuid := '10000000-0000-4000-8000-000000000002';
  manager uuid := '10000000-0000-4000-8000-000000000003';
  viewer uuid := '10000000-0000-4000-8000-000000000004';
  admin uuid := '10000000-0000-4000-8000-000000000005';
  hr_manager uuid := '10000000-0000-4000-8000-000000000007';
  finance_manager uuid := '10000000-0000-4000-8000-000000000008';
  ops_manager uuid := '10000000-0000-4000-8000-000000000009';
  timekeeper uuid := '10000000-0000-4000-8000-000000000010';
  old_handler uuid := '10000000-0000-4000-8000-000000000011';
  response jsonb;
  transfer_receipt jsonb;
  transfer_action jsonb;
  protected_id uuid;
  salary_id uuid;
  malformed_route_id uuid;
  ticket_with_note uuid;
  transfer_id uuid;
  retained_assignee_id uuid;
  terminal_ticket_id uuid;
  old_stamp timestamptz;
  new_stamp timestamptz;
  notification_count bigint;
begin
  insert into public.support_tickets(submitted_by,subject,category,subcategory,description,route_permission,confidential)
  select requester,input.subject,input.category,'Other','Synthetic case for department authorization.',
    private.support_route_permission(input.category,input.confidential),input.confidential
  from (values
    ('Payroll test request','payroll',false),
    ('Schedule test request','schedule',false),
    ('Timekeeping test request','timekeeping',false),
    ('Site request test','site_post',false),
    ('Equipment request test','equipment',false),
    ('Private safety request','safety',true),
    ('Benefits request test','benefits_leave',false),
    ('Training request test','training_compliance',false)
  ) input(subject,category,confidential);
  select id into protected_id from public.support_tickets where subject = 'Private safety request';
  select id into salary_id from public.support_tickets where subject = 'Payroll test request';
  select id into ticket_with_note from public.support_tickets where subject = 'New laptop ticket';
  insert into public.support_tickets(submitted_by,subject,category,subcategory,description,route_permission)
  values (other_requester,'Malformed route payroll test','payroll','Other','Synthetic legacy misroute excluded by exact gate.','admin.maintenance.manage')
  returning id into malformed_route_id;

  perform set_config('fixture.aal2','true',true);
  perform set_config('fixture.actor',hr_manager::text,true);
  response := public.get_sygilant_technology_ticket_workspace_v1('{"view":"hr","status":"all","pageSize":5}');
  perform pg_temp.check_technology_support('HR sees authorized categories and protected records before pagination, but not Training without grant',
    (response #>> '{page,total}')::int = 4
    and exists (select 1 from jsonb_array_elements(response -> 'tickets') item
      where item ->> 'category' = 'safety' and item ->> 'routePermission' = 'hr.people.manage')
    and exists (select 1 from jsonb_array_elements(response -> 'tickets') item where item ->> 'category' = 'benefits_leave')
    and not exists (select 1 from jsonb_array_elements(response -> 'tickets') item where item ->> 'category' = 'training_compliance'));
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','hr','ticketId',protected_id));
  perform pg_temp.check_technology_support('protected detail is readable only through the authorized HR lane or owner',
    response ->> 'id' = protected_id::text and (response ->> 'confidential')::boolean
    and response ->> 'routePermission' = 'hr.people.manage' and response -> 'transferCategories' = '[]');
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(jsonb_build_object('view','hr','operation','transfer',
      'ticketId',protected_id,'requestId',gen_random_uuid(),'expectedUpdatedAt',response ->> 'updatedAt',
      'changes',jsonb_build_object('category','schedule','reason','This must remain protected.')));
    perform pg_temp.check_technology_support('protected tickets cannot be transferred to another department',false);
  exception when sqlstate 'PT409' then
    perform pg_temp.check_technology_support('protected tickets cannot be transferred to another department',sqlerrm='ticket_transfer_blocked');
  end;
  perform set_config('fixture.actor',finance_manager::text,true);
  response := public.get_sygilant_technology_ticket_workspace_v1('{"view":"finance","status":"all"}');
  perform pg_temp.check_technology_support('Finance receives only canonical payroll-routed rows, not a malformed legacy route or private search match',
    (response #>> '{page,total}')::int = 1 and response #>> '{tickets,0,id}' = salary_id::text
    and response #>> '{tickets,0,routePermission}' = 'time.export_payroll'
    and (public.get_sygilant_technology_ticket_workspace_v1(
      '{"view":"finance","status":"all","search":"Private safety request"}') #>> '{page,total}')::int = 0);
  begin
    perform public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','finance','ticketId',malformed_route_id));
    perform pg_temp.check_technology_support('Finance scoped detail rejects category-only access',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('Finance scoped detail rejects category-only access',sqlerrm='ticket_not_available');
  end;
  begin
    perform public.get_sygilant_technology_ticket_workspace_v1('{"view":"hr"}');
    perform pg_temp.check_technology_support('Finance cannot open the protected HR lane with support grants alone',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('Finance cannot open the protected HR lane with support grants alone',true);
  end;
  perform set_config('fixture.aal2','false',true);
  begin
    perform public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','finance','ticketId',salary_id,'assignees',true));
    perform pg_temp.check_technology_support('scoped handler lookup retains the existing staff MFA boundary',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('scoped handler lookup retains the existing staff MFA boundary',true);
  end;
  perform set_config('fixture.aal2','true',true);
  perform set_config('fixture.actor',ops_manager::text,true);
  response := public.get_sygilant_technology_ticket_workspace_v1('{"view":"operations","status":"all"}');
  perform pg_temp.check_technology_support('Operations sees only entitled routes, excluding ungranted equipment and confidential safety',
    (response #>> '{page,total}')::int = 1 and response #>> '{tickets,0,category}' = 'site_post'
    and response #>> '{tickets,0,routePermission}' = 'sites.manage'
    and (public.get_sygilant_technology_ticket_workspace_v1(
      '{"view":"operations","status":"all","search":"Private safety request"}') #>> '{page,total}')::int = 0);
  perform set_config('fixture.actor',timekeeper::text,true);
  response := public.get_sygilant_technology_ticket_workspace_v1('{"view":"timekeeping","status":"all"}');
  perform pg_temp.check_technology_support('Timekeeping scope does not inherit Scheduling or Payroll requests',
    (response #>> '{page,total}')::int = 1 and response #>> '{tickets,0,routePermission}' = 'time.manage');
  perform set_config('fixture.actor',viewer::text,true);
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','it','ticketId',ticket_with_note));
  perform pg_temp.check_technology_support('staff without manage see public replies but never notes, private events or transfer controls',
    response -> 'canManage' = 'false' and response -> 'events' = '[]' and response -> 'transferCategories' = '[]'
    and jsonb_array_length(response -> 'messages') = 2 and not exists (
      select 1 from jsonb_array_elements(response -> 'messages') message where message ->> 'visibility' <> 'public'));
  begin
    perform public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','it','ticketId',ticket_with_note,'assignees',true));
    perform pg_temp.check_technology_support('read-only actor cannot enumerate eligible handlers',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('read-only actor cannot enumerate eligible handlers',true);
  end;

  insert into public.support_tickets(submitted_by,subject,category,subcategory,description,route_permission,status,assigned_to)
  values (requester,'Transfer test request','technical','Other','Synthetic request preserves a public conversation.','admin.maintenance.manage','assigned',old_handler)
  returning id,updated_at into transfer_id,old_stamp;
  insert into public.support_ticket_messages(ticket_id,author_id,body,visibility)
  values (transfer_id,requester,'Synthetic original public message.','public');
  insert into public.support_tickets(submitted_by,subject,category,subcategory,description,route_permission,status,assigned_to)
  values (requester,'Retained handler test request','technical','Other','Synthetic request preserves an eligible assignee.','admin.maintenance.manage','assigned',manager)
  returning id into retained_assignee_id;
  insert into public.support_tickets(submitted_by,subject,category,subcategory,description,route_permission,status,resolved_at)
  values (requester,'Terminal test request','technical','Other','Synthetic resolved request must remain unchanged.','admin.maintenance.manage','resolved',statement_timestamp())
  returning id into terminal_ticket_id;

  perform set_config('fixture.actor',old_handler::text,true);
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','it','ticketId',transfer_id));
  perform pg_temp.check_technology_support('destination category is not offered without the exact route and workspace gates',
    response -> 'transferCategories' = '[]');
  perform set_config('fixture.actor',manager::text,true);
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','it','ticketId',transfer_id));
  perform pg_temp.check_technology_support('only reachable destinations with exact grants are offered',
    response -> 'transferCategories' = '["account_access","schedule"]' and response -> 'canManage' = 'true');
  select count(*) into notification_count from public.support_ticket_notifications where ticket_id = transfer_id;
  transfer_action := jsonb_build_object('view','it','operation','transfer','ticketId',transfer_id,
    'requestId',gen_random_uuid(),'expectedUpdatedAt',old_stamp,
    'changes',jsonb_build_object('category','schedule','reason','Synthetic request belongs to Scheduling.'));
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(transfer_action
      || jsonb_build_object('expectedUpdatedAt',old_stamp - interval '1 microsecond'));
    perform pg_temp.check_technology_support('transfer rejects a stale timestamp without changing state',false);
  exception when sqlstate 'PT409' then
    perform pg_temp.check_technology_support('transfer rejects a stale timestamp without changing state',sqlerrm='ticket_changed'
      and (select updated_at = old_stamp and category = 'technical' from public.support_tickets where id = transfer_id));
  end;
  perform set_config('fixture.actor',old_handler::text,true);
  begin
    perform public.apply_sygilant_technology_ticket_action_v1(transfer_action);
    perform pg_temp.check_technology_support('cross-department transfer needs destination grant as well as source',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('cross-department transfer needs destination grant as well as source',true);
  end;
  perform set_config('fixture.actor',manager::text,true);
  transfer_receipt := public.apply_sygilant_technology_ticket_action_v1(transfer_action);
  perform pg_temp.check_technology_support('permitted transfer moves same ticket, clears ineligible handler, and is exactly retryable from prior desk',
    transfer_receipt = jsonb_build_object('ticketId',transfer_id,'operation','transfer','destinationCategory','schedule',
      'destinationView','scheduling','assignmentCleared',true)
    and transfer_receipt = public.apply_sygilant_technology_ticket_action_v1(transfer_action)
    and (select category = 'schedule' and route_permission = 'schedule.manage' and assigned_to is null
      and status = 'new' and updated_at > old_stamp from public.support_tickets where id = transfer_id));
  perform pg_temp.check_technology_support('transfer logs exactly once, retains public history, and queues no additional notification',
    (select count(*) = 1 from public.support_ticket_events
      where ticket_id = transfer_id and event_type = 'ticket_transferred' and not (detail ? 'reason'))
    and (select count(*) = 1 from private.audit_events
      where row_id = transfer_id::text and operation = 'TRANSFER' and employee_id = manager
      and old_record ->> 'category' = 'technical' and new_record ->> 'category' = 'schedule'
      and new_record ->> 'transferReason' = 'Synthetic request belongs to Scheduling.')
    and (select count(*) = notification_count from public.support_ticket_notifications where ticket_id = transfer_id)
    and (select count(*) = 1 from public.support_ticket_messages where ticket_id = transfer_id and visibility = 'public'));
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','scheduling','ticketId',transfer_id,'assignees',true));
  perform pg_temp.check_technology_support('handler eligibility combines canonical assignment with access to the destination desk',
    exists (select 1 from jsonb_array_elements(response) handler where handler ->> 'id' = manager::text)
    and not exists (select 1 from jsonb_array_elements(response) handler where handler ->> 'id' in (old_handler::text,admin::text)));
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','scheduling','ticketId',transfer_id));
  perform pg_temp.check_technology_support('destination desk sees original ticket thread; source filtered total removes it',
    response #>> '{messages,0,body}' = 'Synthetic original public message.'
    and (public.get_sygilant_technology_ticket_workspace_v1(
      '{"view":"scheduling","search":"Transfer test request"}') #>> '{page,total}')::int = 1
    and (public.get_sygilant_technology_ticket_workspace_v1(
      '{"view":"it","search":"Transfer test request"}') #>> '{page,total}')::int = 0);
  begin
    perform public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','it','ticketId',transfer_id));
    perform pg_temp.check_technology_support('former desk cannot read moved ticket detail',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('former desk cannot read moved ticket detail',true);
  end;
  begin
    update public.employees set permissions = array_remove(permissions,'admin.maintenance.manage') where id = manager;
    perform public.apply_sygilant_technology_ticket_action_v1(transfer_action);
    perform pg_temp.check_technology_support('retry does not bypass revocation of the originating route grant',false);
  exception when insufficient_privilege then
    perform pg_temp.check_technology_support('retry does not bypass revocation of the originating route grant',true);
  end;
  select updated_at into new_stamp from public.support_tickets where id = retained_assignee_id;
  response := public.apply_sygilant_technology_ticket_action_v1(transfer_action || jsonb_build_object('ticketId',retained_assignee_id,
    'requestId',gen_random_uuid(),'expectedUpdatedAt',new_stamp));
  perform pg_temp.check_technology_support('transfer preserves an assignee with exact destination access',
    response -> 'assignmentCleared' = 'false' and (select status = 'assigned' and assigned_to = manager
      from public.support_tickets where id = retained_assignee_id));
  begin
    select updated_at into new_stamp from public.support_tickets where id = ticket_with_note;
    perform public.apply_sygilant_technology_ticket_action_v1(transfer_action || jsonb_build_object('ticketId',ticket_with_note,
      'requestId',gen_random_uuid(),'expectedUpdatedAt',new_stamp));
    perform pg_temp.check_technology_support('request with internal-note history cannot transfer even if open',false);
  exception when sqlstate 'PT409' then
    perform pg_temp.check_technology_support('request with internal-note history cannot transfer even if open',sqlerrm='ticket_transfer_blocked');
  end;
  begin
    select updated_at into new_stamp from public.support_tickets where id = terminal_ticket_id;
    perform public.apply_sygilant_technology_ticket_action_v1(transfer_action || jsonb_build_object('ticketId',terminal_ticket_id,
      'requestId',gen_random_uuid(),'expectedUpdatedAt',new_stamp));
    perform pg_temp.check_technology_support('resolved history cannot transfer',false);
  exception when sqlstate 'PT409' then
    perform pg_temp.check_technology_support('resolved history cannot transfer',sqlerrm='ticket_transfer_blocked');
  end;

  perform set_config('fixture.actor',requester::text,true);
  perform set_config('fixture.aal2','false',true);
  response := public.read_sygilant_technology_ticket_v1(jsonb_build_object('view','mine','ticketId',transfer_id));
  perform pg_temp.check_technology_support('employee still sees own request and public history after cross-department transfer without MFA',
    response ->> 'category' = 'schedule' and response #>> '{messages,0,body}' = 'Synthetic original public message.'
    and response -> 'events' = '[]' and response -> 'canManage' = 'false');
end
$department_checks$;
select json_build_object('checks',count(*),'passed',bool_and(passed),'failed',coalesce(json_agg(name) filter (where not passed),'[]'::json)) from technology_support_checks;

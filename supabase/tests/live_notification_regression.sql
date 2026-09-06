-- This file is a transaction body. Run with its migration inside ONE BEGIN / ROLLBACK.
do $$
declare
  admin_id uuid; admin_auth uuid; employee_id uuid; employee_auth uuid;
  ticket_id uuid; notification_id uuid; result jsonb; before_count bigint; after_count bigint;
  session_id uuid := gen_random_uuid(); batch jsonb; next_batch jsonb;
begin
  select e.id,a.auth_user_id into admin_id,admin_auth from public.employees e join private.employee_accounts a on a.employee_id=e.id where e.status='active' and e.role='admin' and a.disabled_at is null limit 1;
  select e.id,a.auth_user_id into employee_id,employee_auth from public.employees e join private.employee_accounts a on a.employee_id=e.id where e.status='active' and e.role='guard' and a.disabled_at is null and not ('support.tickets.manage'=any(private.employee_effective_permissions(e.id))) limit 1;
  assert admin_auth is not null and employee_auth is not null, 'Actors required';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee_auth,'role','authenticated','aal','aal2','session_id',session_id)::text,true);
  -- No committed session or subscription is created; claim will correctly mark this fake session ineligible.
  result := public.set_my_push_subscription(jsonb_build_object('endpoint','https://fcm.googleapis.com/fcm/send/rollback-fixture','keys',jsonb_build_object('p256dh',repeat('A',87),'auth',repeat('B',22))),true);
  assert (result->>'enabled')::boolean, 'Push subscription saved for current employee';
  result := public.get_my_push_subscription('https://fcm.googleapis.com/fcm/send/rollback-fixture');
  assert (result->>'enabled')::boolean, 'Device status matches owner and session';
  begin
    perform public.set_my_push_subscription('{"endpoint":"https://localhost/secret","keys":{"p256dh":"bad","auth":"bad"}}',true);
    raise exception 'Unsafe endpoint accepted';
  exception when check_violation then null; end;
  -- Prevent any wake request during rehearsal, even if a production secret already exists.
  perform set_config('sygshift.push_kicked','yes',true);
  result := public.submit_support_ticket(jsonb_build_object('requestId',gen_random_uuid(),'category','human_resources','subcategory','Policy question','subject','Live sync rollback fixture','description','Transaction-only live notification verification.','confidential',true));
  ticket_id := (result->>'id')::uuid;
  assert exists(select 1 from realtime.messages where topic='employee:'||employee_auth::text and event='changed'), 'Database emits a private recipient signal';
  perform set_config('realtime.topic','employee:'||employee_auth::text,true);
  execute 'set local role authenticated';
  assert exists(select 1 from realtime.messages where topic='employee:'||employee_auth::text), 'Authorized employee can receive own private channel';
  assert not exists(select 1 from realtime.messages where topic <> 'employee:'||employee_auth::text), 'Other recipients remain isolated by row policy';
  perform set_config('realtime.topic','employee:'||admin_auth::text,true);
  assert not exists(select 1 from realtime.messages), 'Employee cannot join another account channel';
  execute 'reset role';
  perform set_config('realtime.topic','',true);
  select count(*) into before_count from public.employee_notifications n where n.source_id=ticket_id and n.recipient_employee_id=employee_id and n.read_at is null;
  assert before_count=1, 'Opening creates one employee inbox item';
  result := public.read_support_ticket(ticket_id);
  select count(*) into after_count from public.employee_notifications n where n.source_id=ticket_id and n.recipient_employee_id=employee_id and n.read_at is null;
  assert before_count=after_count, 'Background read does not clear unread state';
  assert result->>'readThrough' is not null, 'Read cutoff is server-authoritative';
  assert (select count(*) from private.employee_push_deliveries d join public.employee_notifications n on n.id=d.notification_id where n.source_id=ticket_id)=1, 'Exactly one device delivery queued';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_auth,'role','authenticated','aal','aal2')::text,true);
  perform public.add_support_ticket_message(ticket_id,'An internal note must never be visible to the employee.',true);
  perform public.update_support_ticket(ticket_id,'{"status":"resolved"}');
  result := public.read_support_ticket(ticket_id);
  assert result->>'status'='resolved','Admin sees authoritative resolved status';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',employee_auth,'role','authenticated','aal','aal2','session_id',session_id)::text,true);
  result := public.read_support_ticket(ticket_id);
  assert result->>'status'='resolved','Employee sees identical resolved status';
  assert jsonb_array_length(result->'messages')=0,'Employee cannot read internal note';
  result := public.get_my_live_notifications(clock_timestamp()-interval '1 minute');
  assert exists(select 1 from jsonb_array_elements(result->'notifications') n where n->>'sourceId'=ticket_id::text),'Live inbox includes own new ticket update';
  assert not exists(select 1 from jsonb_array_elements(result->'notifications') n where n ? 'body'),'Broadcast follow-up omits message bodies';
  -- A visible read uses an explicit cutoff; acknowledgment is never automatic.
  perform public.mark_support_ticket_read(ticket_id,clock_timestamp());
  assert not exists(select 1 from public.employee_notifications n where n.source_id=ticket_id and n.recipient_employee_id=employee_id and n.read_at is null),'Explicit visible read updates personal unread state';
  notification_id := private.create_employee_notification(employee_id,'direct',null,'live-required-fixture','Required fixture','A required notification regression fixture.','important',true,'/notifications','Review',admin_id,null);
  perform public.get_my_live_notifications(clock_timestamp()-interval '1 minute');
  assert (select acknowledged_at is null from public.employee_notifications where id=notification_id),'Live refresh never acknowledges';
  assert not has_table_privilege('authenticated','private.employee_push_subscriptions','SELECT'),'Device endpoints stay private';
  assert not has_table_privilege('authenticated','private.employee_push_deliveries','SELECT'),'Push delivery queue stays private';
  assert not has_function_privilege('authenticated','public.service_claim_employee_push(integer)','EXECUTE'),'Employee cannot claim deliveries';
  assert not has_function_privilege('anon','public.get_my_live_notifications(timestamptz)','EXECUTE'),'Anonymous cannot get live inbox';
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  batch := public.service_claim_employee_push(50);
  next_batch := public.service_claim_employee_push(50);
  assert not exists(select 1 from jsonb_array_elements(batch) a join jsonb_array_elements(next_batch) b on a->>'id'=b->>'id'),'Overlapping dispatches cannot claim the same lease';
  assert not exists(select 1 from jsonb_array_elements(batch) a where a->'subscription'->>'endpoint'='https://fcm.googleapis.com/fcm/send/rollback-fixture' and (a->>'eligible')::boolean),'Missing auth session prevents background push';
end
$$;

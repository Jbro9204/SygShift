-- Rollback-only coverage for the explicit SygSphere acknowledgment contract.
-- Run after 20261019130405_sygsphere_message_acknowledgment.sql.
begin;

update private.sygsphere_gate set enabled = true;

do $$
declare
  actors uuid[];
  accounts uuid[];
  group_id uuid;
  direct_id uuid;
  channel_id uuid;
  group_message_id uuid;
  direct_message_id uuid;
  channel_message_id uuid;
  payload jsonb;
  stored_count integer;
begin
  select array_agg(employee_id order by employee_id), array_agg(auth_user_id order by employee_id)
  into actors, accounts
  from (
    select account.employee_id, account.auth_user_id
    from private.employee_accounts account
    join public.employees employee on employee.id = account.employee_id
    where employee.status = 'active'
      and account.disabled_at is null
      and not account.must_change_password
    order by account.employee_id
    limit 3
  ) fixtures;
  assert cardinality(actors) = 3, 'Three active fixture identities are required';

  perform set_config('request.jwt.claim.sub', accounts[1]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('create', jsonb_build_object(
    'kind','group','name','Acknowledgment rollback test','members',jsonb_build_array(actors[2],actors[3])
  ));
  group_id := (payload->>'id')::uuid;
  payload := public.sygsphere_request('send', jsonb_build_object(
    'conversationId',group_id,'body','Please acknowledge these instructions.','clientId',gen_random_uuid()
  ));
  group_message_id := (payload->>'id')::uuid;
  assert payload->'acknowledgment' = jsonb_build_object('mine',false,'count',0,'people','[]'::jsonb),
    'New messages must expose an empty acknowledgment state';

  begin
    perform public.sygsphere_request('acknowledge', jsonb_build_object('conversationId',group_id,'messageId',group_message_id));
    raise exception 'Authors must not acknowledge their own messages';
  exception when check_violation then null;
  end;

  perform set_config('request.jwt.claim.sub', accounts[2]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text, true);

  -- Reading a message or a page of messages never creates acknowledgment
  -- evidence. Read receipts and acknowledgments remain separate actions.
  payload := public.sygsphere_request('message', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id
  ));
  assert (payload->'acknowledgment'->>'count')::integer = 0,
    'Viewing one message created an acknowledgment';
  payload := public.sygsphere_request('messages', jsonb_build_object('conversationId',group_id));
  assert (payload->0->'acknowledgment'->>'count')::integer = 0,
    'Viewing a message page created an acknowledgment';
  assert not exists(
    select 1 from private.sygsphere_acknowledgments
    where message_id = group_message_id and employee_id = actors[2]
  ), 'Viewing stored acknowledgment evidence';

  -- Historical and stale-client check-mark reactions keep their original,
  -- removable reaction semantics and never become instruction evidence.
  perform public.sygsphere_request('react', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id,'emoji','✅','enabled',true
  ));
  payload := public.sygsphere_request('message', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id
  ));
  assert not (payload->'acknowledgment'->>'mine')::boolean,
    'A check-mark reaction was reclassified as an acknowledgment';
  assert exists(select 1 from jsonb_array_elements(payload->'reactions') reaction where reaction->>'emoji' = '✅'),
    'The check-mark reaction disappeared from ordinary reactions';
  perform public.sygsphere_request('react', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id,'emoji','✅','enabled',false
  ));
  payload := public.sygsphere_request('message', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id
  ));
  assert not exists(select 1 from jsonb_array_elements(payload->'reactions') reaction where reaction->>'emoji' = '✅'),
    'The check-mark reaction could not be removed';

  payload := public.sygsphere_request('acknowledge', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id
  ));
  assert (payload->'acknowledgment'->>'mine')::boolean, 'Acknowledging participant state was not returned';
  assert (payload->'acknowledgment'->>'count')::integer = 1, 'First acknowledgment count is wrong';
  assert payload->'acknowledgment'->'people'->0->>'id' = actors[2]::text, 'Acknowledging identity is missing';

  -- Network retries are insertion-idempotent and must not create extra audit events.
  payload := public.sygsphere_request('acknowledge', jsonb_build_object('conversationId',group_id,'messageId',group_message_id));
  select count(*) into stored_count
  from private.sygsphere_acknowledgments
  where message_id = group_message_id and employee_id = actors[2];
  assert stored_count = 1, 'Repeated acknowledgment created a duplicate row';
  select count(*) into stored_count
  from private.audit_events
  where table_name = 'sygsphere_acknowledgments' and operation = 'ACKNOWLEDGE'
    and row_id = group_message_id::text and employee_id = actors[2];
  assert stored_count = 1, 'Repeated acknowledgment created a duplicate audit event';
  assert not exists(
    select 1 from private.sygsphere_reads
    where message_id = group_message_id and employee_id = actors[2]
  ), 'Acknowledging a message must not mark it read';

  perform public.sygsphere_request('react', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id,'emoji','👍','enabled',true
  ));

  perform set_config('request.jwt.claim.sub', accounts[3]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[3],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('acknowledge', jsonb_build_object('conversationId',group_id,'messageId',group_message_id));
  assert (payload->'acknowledgment'->>'count')::integer = 2, 'Multiple-user acknowledgment count is wrong';
  assert jsonb_array_length(payload->'acknowledgment'->'people') = 2, 'Authorized identity list is incomplete';
  assert not exists(
    select 1 from private.sygsphere_reads
    where message_id = group_message_id and employee_id = actors[3]
  ), 'Acknowledgment must remain separate from read receipts';

  -- Removed participants cannot fetch or acknowledge message state.
  perform set_config('request.jwt.claim.sub', accounts[1]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text, true);
  perform public.sygsphere_request('members', jsonb_build_object(
    'conversationId',group_id,'employeeId',actors[3],'operation','remove'
  ));
  perform set_config('request.jwt.claim.sub', accounts[3]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[3],'role','authenticated','aal','aal2')::text, true);
  begin
    perform public.sygsphere_request('acknowledge', jsonb_build_object('conversationId',group_id,'messageId',group_message_id));
    raise exception 'Removed participant acknowledgment was allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sygsphere_request('message', jsonb_build_object('conversationId',group_id,'messageId',group_message_id));
    raise exception 'Removed participant could fetch acknowledgment identities';
  exception when insufficient_privilege then null;
  end;

  -- Direct messages intentionally retain read receipts/reactions but do not
  -- offer the instruction-acknowledgment workflow.
  perform set_config('request.jwt.claim.sub', accounts[1]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('create', jsonb_build_object('kind','direct','members',jsonb_build_array(actors[2])));
  direct_id := (payload->>'id')::uuid;
  payload := public.sygsphere_request('send', jsonb_build_object(
    'conversationId',direct_id,'body','Direct-message acknowledgment boundary','clientId',gen_random_uuid()
  ));
  direct_message_id := (payload->>'id')::uuid;
  perform set_config('request.jwt.claim.sub', accounts[2]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('message', jsonb_build_object(
    'conversationId',direct_id,'messageId',direct_message_id
  ));
  assert payload->'acknowledgment' = jsonb_build_object('mine',false,'count',0,'people','[]'::jsonb),
    'Direct-message payload did not keep acknowledgment state empty';
  begin
    perform public.sygsphere_request('acknowledge', jsonb_build_object('conversationId',direct_id,'messageId',direct_message_id));
    raise exception 'Direct-message acknowledgment was allowed';
  exception when check_violation then null;
  end;

  -- Channels use the same explicit contract as groups.
  perform set_config('request.jwt.claim.sub', accounts[1]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('create', jsonb_build_object(
    'kind','channel','name','Acknowledgment channel test','members',jsonb_build_array(actors[2])
  ));
  channel_id := (payload->>'id')::uuid;
  payload := public.sygsphere_request('send', jsonb_build_object(
    'conversationId',channel_id,'body','Acknowledge this channel instruction.','clientId',gen_random_uuid()
  ));
  channel_message_id := (payload->>'id')::uuid;
  perform set_config('request.jwt.claim.sub', accounts[2]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('acknowledge', jsonb_build_object(
    'conversationId',channel_id,'messageId',channel_message_id
  ));
  assert (payload->'acknowledgment'->>'mine')::boolean,
    'Channel acknowledgment was not stored';

  -- Editing revised instructions invalidates every prior acknowledgment while
  -- preserving ordinary reactions and all source/revision history.
  perform set_config('request.jwt.claim.sub', accounts[1]::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text, true);
  payload := public.sygsphere_request('edit', jsonb_build_object(
    'conversationId',group_id,'messageId',group_message_id,'body','Please acknowledge these revised instructions.'
  ));
  assert (payload->'acknowledgment'->>'count')::integer = 0, 'Edit response returned stale acknowledgment state';
  payload := public.sygsphere_request('message', jsonb_build_object('conversationId',group_id,'messageId',group_message_id));
  assert (payload->'acknowledgment'->>'count')::integer = 0, 'Edit did not clear prior acknowledgments';
  assert jsonb_array_length(payload->'acknowledgment'->'people') = 0, 'Edit retained acknowledgment identities';
  assert not exists(select 1 from private.sygsphere_acknowledgments where message_id = group_message_id),
    'Edit left acknowledgment evidence attached to superseded instructions';
  assert exists(select 1 from private.sygsphere_reactions where message_id = group_message_id and emoji = '👍'),
    'Edit removed an ordinary reaction';
  assert exists(select 1 from private.sygsphere_revisions where message_id = group_message_id and action = 'edit'),
    'Edit revision history was not preserved';
  select count(*) into stored_count
  from private.audit_events
  where table_name = 'sygsphere_acknowledgments' and operation = 'CLEAR_ACKNOWLEDGMENTS_ON_EDIT'
    and row_id = group_message_id::text;
  assert stored_count = 1, 'Acknowledgment edit invalidation was not audited exactly once';

  assert not has_function_privilege('authenticated','private.sygsphere_acknowledge_message(uuid,jsonb)','EXECUTE'),
    'Authenticated users must not bypass the public acknowledgment boundary';
  assert not has_function_privilege('anon','public.sygsphere_request(text,jsonb)','EXECUTE'),
    'Anonymous users must not access SygSphere actions';
  assert (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'private.sygsphere_acknowledgments'::regclass),
    'Acknowledgment storage must retain forced RLS';
  assert not has_table_privilege('authenticated','private.sygsphere_acknowledgments','SELECT'),
    'Authenticated users must not read acknowledgment identities outside the participant-gated payload';
end
$$;

rollback;

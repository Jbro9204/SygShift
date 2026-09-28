update private.sygsphere_gate set enabled=true;
do $$
declare actors uuid[]; accounts uuid[]; c uuid; other_c uuid; removed_c uuid; message uuid; reply uuid; read_message uuid; payload jsonb; target jsonb; actor1_global_target jsonb; actor2_global_target jsonb; request_id uuid:=gen_random_uuid(); total integer;
begin
  select array_agg(employee_id order by employee_id),array_agg(auth_user_id order by employee_id) into actors,accounts from (
    select a.employee_id,a.auth_user_id from private.employee_accounts a join public.employees e on e.id=a.employee_id
    where e.status='active' and a.disabled_at is null and not a.must_change_password order by a.employee_id limit 3)x;
  if cardinality(actors)<>3 then raise exception 'Three active fixture identities required'; end if;
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  actor1_global_target:=public.sygsphere_request('list','{}')->'latestUnreadTarget';
  payload:=public.sygsphere_request('create',jsonb_build_object('kind','direct','members',jsonb_build_array(actors[2]))); c:=(payload->>'id')::uuid;
  if (public.sygsphere_request('create',jsonb_build_object('kind','direct','members',jsonb_build_array(actors[2])))->>'id')::uuid<>c then raise exception 'Duplicate DM'; end if;
  perform set_config('request.jwt.claim.sub',accounts[2]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text,true);
  actor2_global_target:=public.sygsphere_request('list','{}')->'latestUnreadTarget';
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  payload:=public.sygsphere_request('send',jsonb_build_object('conversationId',c,'body','SygSphere transaction test','clientId',request_id)); message:=(payload->>'id')::uuid;
  perform public.sygsphere_request('send',jsonb_build_object('conversationId',c,'body','SygSphere transaction test','clientId',request_id));
  select count(*) into total from private.sygsphere_messages where conversation_id=c;
  if total<>1 then raise exception 'Retry created duplicate'; end if;
  begin
    perform public.sygsphere_request('send',jsonb_build_object('conversationId',c,'body','Changed retry','clientId',request_id));
    raise exception 'Changed retry accepted';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.sub',accounts[3]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[3],'role','authenticated','aal','aal2')::text,true);
  begin
    perform public.sygsphere_request('messages',jsonb_build_object('conversationId',c)); raise exception 'Nonmember read allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.sygsphere_request('send',jsonb_build_object('conversationId',c,'body','Unauthorized','clientId',gen_random_uuid())); raise exception 'Nonmember send allowed';
  exception when insufficient_privilege then null; end;
  payload:=public.sygsphere_request('create',jsonb_build_object('kind','group','name','Rollback-only test','members',jsonb_build_array(actors[2]))); other_c:=(payload->>'id')::uuid;
  begin
    perform public.sygsphere_request('send',jsonb_build_object('conversationId',other_c,'body','Cross reply','parentId',message,'clientId',gen_random_uuid())); raise exception 'Cross-conversation reply allowed';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.sub',accounts[2]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text,true);
  payload:=public.sygsphere_request('messages',jsonb_build_object('conversationId',c));
  if (payload->0->>'read')::boolean then raise exception 'New message already read'; end if;
  payload:=public.sygsphere_request('list','{}');
  select item into target from jsonb_array_elements(payload->'conversations') item where item->>'id'=c::text;
  if target is null or target->'latestUnreadTarget'->>'conversationId' is distinct from c::text or target->'latestUnreadTarget'->>'messageId' is distinct from message::text or target->'latestUnreadTarget'->'parentId' is distinct from 'null'::jsonb then raise exception 'Conversation unread target missing'; end if;
  if payload->'latestUnreadTarget'->>'conversationId' is distinct from c::text or payload->'latestUnreadTarget'->>'messageId' is distinct from message::text or payload->'latestUnreadTarget'->'parentId' is distinct from 'null'::jsonb then raise exception 'Inbox unread target missing'; end if;
  perform public.sygsphere_request('read',jsonb_build_object('conversationId',c,'messageIds',jsonb_build_array(message)));
  payload:=public.sygsphere_request('messages',jsonb_build_object('conversationId',c));
  if not (payload->0->>'read')::boolean then raise exception 'Read not persisted'; end if;
  payload:=public.sygsphere_request('list','{}');
  select item into target from jsonb_array_elements(payload->'conversations') item where item->>'id'=c::text;
  if target is null or target->'latestUnreadTarget' is distinct from 'null'::jsonb or payload->'latestUnreadTarget' is distinct from actor2_global_target or (target->>'unread')::integer is distinct from 0 then raise exception 'Read target or unread count did not clear to baseline'; end if;
  payload:=public.sygsphere_request('send',jsonb_build_object('conversationId',c,'parentId',message,'body','Reply target test','clientId',gen_random_uuid())); reply:=(payload->>'id')::uuid;
  begin
    perform public.sygsphere_request('delete',jsonb_build_object('conversationId',c,'messageId',message)); raise exception 'Other author delete allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.sygsphere_request('members',jsonb_build_object('conversationId',other_c,'employeeId',actors[1],'operation','add')); raise exception 'Nonowner membership allowed';
  exception when insufficient_privilege then null; end;
  perform public.sygsphere_request('react',jsonb_build_object('conversationId',c,'messageId',message,'emoji','👍','enabled',true));
  perform public.sygsphere_request('save',jsonb_build_object('conversationId',c,'messageId',message,'enabled',true));
  if jsonb_array_length(public.sygsphere_request('saved','{}'))<>1 then raise exception 'Save failed'; end if;
  if jsonb_array_length(public.sygsphere_request('search','{"query":"transaction"}'))<>1 then raise exception 'Search failed'; end if;
  perform set_config('request.jwt.claim.sub',accounts[3]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[3],'role','authenticated','aal','aal2')::text,true);
  perform public.sygsphere_request('send',jsonb_build_object('conversationId',other_c,'body','Nonmember target exclusion','clientId',gen_random_uuid()));
  payload:=public.sygsphere_request('create',jsonb_build_object('kind','group','name','Rollback-only removed member','members',jsonb_build_array(actors[1]))); removed_c:=(payload->>'id')::uuid;
  perform public.sygsphere_request('send',jsonb_build_object('conversationId',removed_c,'body','Removed member target exclusion','clientId',gen_random_uuid()));
  perform public.sygsphere_request('members',jsonb_build_object('conversationId',removed_c,'employeeId',actors[1],'operation','remove'));
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  perform public.sygsphere_request('send',jsonb_build_object('conversationId',c,'body','Later own message','clientId',gen_random_uuid()));
  perform set_config('request.jwt.claim.sub',accounts[2]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text,true);
  payload:=public.sygsphere_request('send',jsonb_build_object('conversationId',c,'body','Later read message','clientId',gen_random_uuid())); read_message:=(payload->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  payload:=public.sygsphere_request('list','{}');
  if exists(select 1 from jsonb_array_elements(payload->'conversations') item where item->>'id'=other_c::text) then raise exception 'Nonmember conversation exposed'; end if;
  if exists(select 1 from jsonb_array_elements(payload->'conversations') item where item->>'id'=removed_c::text) then raise exception 'Removed conversation exposed'; end if;
  select item into target from jsonb_array_elements(payload->'conversations') item where item->>'id'=c::text;
  if target is null or target->'latestUnreadTarget'->>'conversationId' is distinct from c::text or target->'latestUnreadTarget'->>'messageId' is distinct from read_message::text or target->'latestUnreadTarget'->'parentId' is distinct from 'null'::jsonb or (target->>'unread')::integer is distinct from 2 then raise exception 'Newest unread target or count missing after later own message'; end if;
  if payload->'latestUnreadTarget'->>'conversationId' is distinct from c::text or payload->'latestUnreadTarget'->>'messageId' is distinct from read_message::text or payload->'latestUnreadTarget'->'parentId' is distinct from 'null'::jsonb then raise exception 'Newest global unread target missing after later own message'; end if;
  perform public.sygsphere_request('read',jsonb_build_object('conversationId',c,'messageIds',jsonb_build_array(read_message)));
  payload:=public.sygsphere_request('list','{}');
  select item into target from jsonb_array_elements(payload->'conversations') item where item->>'id'=c::text;
  if target is null or target->'latestUnreadTarget'->>'conversationId' is distinct from c::text or target->'latestUnreadTarget'->>'messageId' is distinct from reply::text or target->'latestUnreadTarget'->>'parentId' is distinct from message::text or (target->>'unread')::integer is distinct from 1 then raise exception 'Unread thread target or count missing after later message read'; end if;
  if payload->'latestUnreadTarget'->>'conversationId' is distinct from c::text or payload->'latestUnreadTarget'->>'messageId' is distinct from reply::text or payload->'latestUnreadTarget'->>'parentId' is distinct from message::text then raise exception 'Global unread thread target missing after later message read'; end if;
  perform public.sygsphere_request('read',jsonb_build_object('conversationId',c,'messageIds',jsonb_build_array(reply)));
  payload:=public.sygsphere_request('list','{}');
  select item into target from jsonb_array_elements(payload->'conversations') item where item->>'id'=c::text;
  if target is null or target->'latestUnreadTarget' is distinct from 'null'::jsonb or payload->'latestUnreadTarget' is distinct from actor1_global_target or (target->>'unread')::integer is distinct from 0 then raise exception 'Thread read target or unread count did not clear to baseline'; end if;
  perform public.sygsphere_request('edit',jsonb_build_object('conversationId',c,'messageId',message,'body','Edited message'));
  perform public.sygsphere_request('delete',jsonb_build_object('conversationId',c,'messageId',message));
  if (select count(*) from private.sygsphere_revisions where message_id=message)<>2 then raise exception 'Revision evidence missing'; end if;
  payload:=public.sygsphere_request('messages',jsonb_build_object('conversationId',c));
  if not (payload->0->>'deleted')::boolean or payload->0->>'body'<>'' then raise exception 'Deleted content exposed'; end if;
  if has_function_privilege('anon','public.sygsphere_request(text,jsonb)','EXECUTE') then raise exception 'Anonymous execute granted'; end if;
  if exists(select 1 from pg_tables where schemaname='private' and tablename like 'sygsphere_%' and not rowsecurity) then raise exception 'RLS missing'; end if;
  update private.sygsphere_gate set enabled=false;
  begin perform public.sygsphere_request('list','{}'); raise exception 'Gate bypass'; exception when object_not_in_prerequisite_state then null; end;
end $$;
select 'SygSphere permission, retry, read, search, history and recovery assertions passed; transaction will roll back.' as result;

begin;

update private.sygsphere_gate set enabled=true;
do $$
declare
  actors uuid[]; accounts uuid[]; usernames text[]; cid uuid; mid uuid; request_id uuid:=gen_random_uuid(); payload jsonb;
  upload_id uuid:=gen_random_uuid(); upload_client_id uuid:=gen_random_uuid();
  small_upload_id uuid:=gen_random_uuid(); small_upload_client_id uuid:=gen_random_uuid(); retry_request_id uuid:=gen_random_uuid();
begin
  select array_agg(employee_id order by employee_id),array_agg(auth_user_id order by employee_id),array_agg(username order by employee_id)
    into actors,accounts,usernames from (
      select account.employee_id,account.auth_user_id,employee.username
      from private.employee_accounts account join public.employees employee on employee.id=account.employee_id
      where employee.status='active' and account.disabled_at is null and not account.must_change_password
      order by account.employee_id limit 3
    ) fixture;
  if cardinality(actors)<>3 then raise exception 'Three active fixture identities required'; end if;
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  cid:=(public.sygsphere_request('create',jsonb_build_object('kind','group','name','Mention rehearsal','members',jsonb_build_array(actors[2])))->>'id')::uuid;
  payload:=public.sygsphere_request('send',jsonb_build_object('conversationId',cid,'body','Please review @'||usernames[2],
    'clientId',request_id,'mentionIds',jsonb_build_array(actors[2]))); mid:=(payload->>'id')::uuid;
  if jsonb_array_length(payload->'mentions')<>1 or payload->'mentions'->0->>'id'<>actors[2]::text then raise exception 'Structured mention missing'; end if;
  begin
    perform public.sygsphere_request('send',jsonb_build_object('conversationId',cid,'body','Please review @'||usernames[2],
      'clientId',request_id,'mentionIds','[]'::jsonb)); raise exception 'Changed mention retry accepted';
  exception when check_violation then null; end;
  begin
    perform public.sygsphere_request('send',jsonb_build_object('conversationId',cid,'body','Not a member @'||usernames[3],
      'clientId',gen_random_uuid(),'mentionIds',jsonb_build_array(actors[3]))); raise exception 'Nonmember mention accepted';
  exception when check_violation then null; end;
  perform set_config('request.jwt.claim.sub',accounts[2]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text,true);
  if jsonb_array_length(public.sygsphere_request('mentions','{}'::jsonb))<>1 then raise exception 'Mention inbox missing'; end if;
  if public.sygsphere_preferences('large')->>'textSize'<>'large' or public.sygsphere_preferences(null)->>'textSize'<>'large' then raise exception 'Text preference not persisted'; end if;
  if jsonb_typeof(public.sygsphere_people('directory','{}'::jsonb))<>'array' then raise exception 'Profile directory unavailable'; end if;
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  perform public.sygsphere_request('edit',jsonb_build_object('conversationId',cid,'messageId',mid,'body','Mention removed','mentionIds','[]'::jsonb));
  if exists(select 1 from private.sygsphere_mentions where message_id=mid) then raise exception 'Removed mention retained'; end if;
  payload:=public.sygsphere_upload_capabilities();
  if not (payload->>'resumableEnabled')::boolean
    or (payload->>'inlineMaxBytes')::integer<>26214400
    or (payload->>'resumableMaxBytes')::integer<>104857600 then
    raise exception 'Protected resumable capability bounds are incorrect';
  end if;
  if has_function_privilege('authenticated','public.service_begin_sygsphere_resumable_upload(uuid,jsonb)','EXECUTE') then raise exception 'Browser can authorize resumable uploads'; end if;
  if has_function_privilege('authenticated','public.service_complete_sygsphere_resumable_upload_available(uuid,uuid,text,text)','EXECUTE') then raise exception 'Browser can complete protected upload availability directly'; end if;
  if has_function_privilege('anon','public.sygsphere_people(text,jsonb)','EXECUTE') then raise exception 'Anonymous people access granted'; end if;

  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
  payload:=public.service_begin_sygsphere_resumable_upload(actors[1],jsonb_build_object(
    'conversationId',cid,'fileId',upload_id,'clientId',upload_client_id,'filename','large-evidence.png',
    'mimeType','image/png','sizeBytes',26214401));
  if payload->>'state'<>'prepared' or (payload->>'uploadId')::uuid<>upload_id then raise exception 'Resumable begin failed'; end if;
  if (public.service_begin_sygsphere_resumable_upload(actors[1],jsonb_build_object(
    'conversationId',cid,'fileId',upload_id,'clientId',upload_client_id,'filename','large-evidence.png',
    'mimeType','image/png','sizeBytes',26214401))->>'uploadId')::uuid<>upload_id then raise exception 'Resumable retry changed operation'; end if;
  perform public.service_mark_sygsphere_resumable_uploaded(actors[1],upload_id,26214401,'image/png');
  insert into storage.objects(bucket_id,name,metadata)
  select 'sygsphere-files',upload.object_key,jsonb_build_object('size',26214401,'contentLength',26214401,'mimetype','image/png')
  from private.sygsphere_resumable_uploads upload where upload.id=upload_id;
  begin
    perform public.service_complete_sygsphere_resumable_upload_available(actors[1],upload_id,'not-a-checksum',null);
    raise exception 'Invalid checksum accepted';
  exception when check_violation then null; end;
  payload:=public.service_complete_sygsphere_resumable_upload_available(actors[1],upload_id,repeat('a',64),null);
  if payload->>'state'<>'clean' or nullif(payload->>'messageId','') is null then raise exception 'Protected availability completion failed'; end if;
  payload:=public.service_complete_sygsphere_resumable_upload_available(actors[1],upload_id,repeat('a',64),null);
  if payload->>'state'<>'clean' then raise exception 'Availability retry changed the completed upload'; end if;

  payload:=public.service_begin_sygsphere_resumable_upload(actors[1],jsonb_build_object(
    'conversationId',cid,'fileId',small_upload_id,'clientId',small_upload_client_id,'filename','small-evidence.png',
    'mimeType','image/png','sizeBytes',29500,'requestId',retry_request_id));
  if payload->>'state'<>'prepared' or payload->>'requestReference'<>retry_request_id::text then raise exception 'Small protected begin failed'; end if;
  perform public.service_mark_sygsphere_resumable_uploaded(actors[1],small_upload_id,29500,'image/png');
  insert into storage.objects(bucket_id,name,metadata)
  select 'sygsphere-files',upload.object_key,jsonb_build_object('size',29500,'contentLength',29500,'mimetype','image/png')
  from private.sygsphere_resumable_uploads upload where upload.id=small_upload_id;
  payload:=public.service_complete_sygsphere_resumable_upload_available(actors[1],small_upload_id,repeat('b',64),retry_request_id::text);
  if payload->>'state'<>'clean' or nullif(payload->>'messageId','') is null then raise exception 'Small protected availability completion failed'; end if;
end $$;
select 'SygSphere mentions, profile identity, text preferences, and protected immediate-availability uploads passed; transaction will roll back.' as result;

rollback;

update private.sygsphere_gate set enabled=true;
do $$
declare actors uuid[]; accounts uuid[]; cid uuid; fid uuid:=gen_random_uuid(); payload jsonb; checksum text:=repeat('a',64); msg uuid;
begin
  select array_agg(employee_id order by employee_id),array_agg(auth_user_id order by employee_id) into actors,accounts from (
    select a.employee_id,a.auth_user_id from private.employee_accounts a join public.employees e on e.id=a.employee_id
    where e.status='active' and a.disabled_at is null and not a.must_change_password order by a.employee_id limit 3)x;
  perform set_config('request.jwt.claim.sub',accounts[1]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  cid:=(public.sygsphere_request('create',jsonb_build_object('kind','group','name','File boundary rehearsal','members',jsonb_build_array(actors[2])))->>'id')::uuid;
  begin perform public.service_sygsphere_file('begin',actors[1],jsonb_build_object('fileId',fid,'conversationId',cid)); raise exception 'Browser trusted as scanner'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
  perform public.service_sygsphere_file('begin',actors[1],jsonb_build_object('fileId',fid,'conversationId',cid,'filename','Rehearsal.txt','mimeType','text/plain','sizeBytes',5,'checksum',checksum));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[1],'role','authenticated','aal','aal2')::text,true);
  begin perform public.sygsphere_files('access',jsonb_build_object('fileId',fid)); raise exception 'Pending file readable'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
  begin perform public.service_sygsphere_file('complete',actors[1],jsonb_build_object('fileId',fid,'state','clean','scanner','ClamAV test')); raise exception 'Missing checksum accepted'; exception when check_violation then null; end;
  payload:=public.service_sygsphere_file('complete',actors[1],jsonb_build_object('fileId',fid,'state','clean','scanner','ClamAV test','checksum',checksum)); msg:=(payload->>'messageId')::uuid;
  payload:=public.service_sygsphere_file('complete',actors[1],jsonb_build_object('fileId',fid,'state','clean','scanner','ClamAV test','checksum',checksum));
  if (payload->>'messageId')::uuid<>msg or (select count(*) from private.sygsphere_messages where conversation_id=cid)<>1 then raise exception 'File retry duplicated message'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',accounts[2]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[2],'role','authenticated','aal','aal2')::text,true);
  if (public.sygsphere_files('access',jsonb_build_object('fileId',fid))->>'filename')<>'Rehearsal.txt' then raise exception 'Clean member download unavailable'; end if;
  update private.sygsphere_members set removed_at=clock_timestamp() where conversation_id=cid and employee_id=actors[2];
  begin perform public.sygsphere_files('access',jsonb_build_object('fileId',fid)); raise exception 'Removed member download allowed'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',accounts[3]::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',accounts[3],'role','authenticated','aal','aal2')::text,true);
  begin perform public.sygsphere_files('list',jsonb_build_object('conversationId',cid)); raise exception 'Nonmember file list allowed'; exception when insufficient_privilege then null; end;
  if has_function_privilege('authenticated','public.service_sygsphere_file(text,uuid,jsonb)','EXECUTE') then raise exception 'Browser scanner privilege'; end if;
  if exists(select 1 from storage.buckets where id='sygsphere-files' and public) then raise exception 'Public files bucket'; end if;
end $$;
select 'SygSphere file quarantine, service-only scanner, checksum, retry and membership checks passed; rollback follows.' as file_result;

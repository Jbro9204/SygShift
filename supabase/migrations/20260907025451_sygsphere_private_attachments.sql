begin;
set local lock_timeout='5s';
create table private.sygsphere_files (
  id uuid primary key, conversation_id uuid not null references private.sygsphere_conversations(id),
  author_id uuid not null references public.employees(id), parent_id uuid references private.sygsphere_messages(id),
  message_id uuid references private.sygsphere_messages(id), filename text not null check(length(filename)<=240),
  mime_type text not null, size_bytes integer not null check(size_bytes between 1 and 26214400),
  checksum text not null check(checksum ~ '^[0-9a-f]{64}$'), state text not null default 'pending' check(state in ('pending','clean','rejected','error')),
  scanner text, scanned_at timestamptz, created_at timestamptz not null default clock_timestamp()
);
create index sygsphere_files_conversation on private.sygsphere_files(conversation_id,created_at desc);
create index sygsphere_files_author on private.sygsphere_files(author_id);
create index sygsphere_files_parent on private.sygsphere_files(parent_id);
create index sygsphere_files_message on private.sygsphere_files(message_id);
alter table private.sygsphere_files enable row level security;
revoke all on private.sygsphere_files from public,anon,authenticated;
insert into storage.buckets(id,name,public,file_size_limit) values('sygsphere-files','sygsphere-files',false,26214400);

create function public.sygsphere_files(action text,input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.current_employee_id(); cid uuid:=(input->>'conversationId')::uuid; item private.sygsphere_files%rowtype; result jsonb;
begin
  if actor is null or not exists(select 1 from private.sygsphere_gate where enabled) then raise insufficient_privilege using message='SygSphere file access is unavailable.'; end if;
  if action='access' then select * into item from private.sygsphere_files where id=(input->>'fileId')::uuid; cid:=item.conversation_id; end if;
  perform private.sygsphere_request('conversation',jsonb_build_object('conversationId',cid));
  if cid is null or not exists(select 1 from private.sygsphere_members where conversation_id=cid and employee_id=actor and removed_at is null) then raise insufficient_privilege using message='You do not have access to these conversation files.'; end if;
  if action='authorize' then
    if exists(select 1 from private.sygsphere_conversations where id=cid and archived) then raise check_violation using message='This conversation is archived.'; end if;
    return jsonb_build_object('ok',true);
  elsif action='access' then
    if item.state<>'clean' or item.message_id is null or exists(select 1 from private.sygsphere_messages where id=item.message_id and deleted_at is not null) then raise insufficient_privilege using message='This file is not available for download.'; end if;
    return jsonb_build_object('id',item.id,'filename',item.filename,'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'objectKey',cid::text||'/'||item.id::text);
  elsif action='list' then
    select coalesce(jsonb_agg(x.payload order by x.created_at desc),'[]'::jsonb) into result from (
      select f.created_at,jsonb_build_object('id',f.id,'filename',f.filename,'mimeType',f.mime_type,'sizeBytes',f.size_bytes,'messageId',f.message_id,'parentId',f.parent_id,'state',f.state,'createdAt',f.created_at) payload
      from private.sygsphere_files f where f.conversation_id=cid and f.state='clean' and f.message_id is not null
      and (input->>'messageId' is null or f.message_id=(input->>'messageId')::uuid)
      and not exists(select 1 from private.sygsphere_messages m where m.id=f.message_id and m.deleted_at is not null)
      and f.created_at<coalesce((input->>'before')::timestamptz,'infinity'::timestamptz) order by f.created_at desc limit 50)x;
    return result;
  end if;
  raise check_violation using message='Unknown file request.';
end $$;

create function public.service_sygsphere_file(action text,target_actor_id uuid,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_files%rowtype; cid uuid:=(input->>'conversationId')::uuid; fid uuid:=(input->>'fileId')::uuid; mid uuid;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  if not exists(select 1 from private.sygsphere_gate where enabled) or not exists(select 1 from private.employee_accounts a join public.employees e on e.id=a.employee_id where e.id=target_actor_id and e.status='active' and a.disabled_at is null) then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('sygsphere-file:'||fid::text,0));
  select * into item from private.sygsphere_files where id=fid for update;
  if found then cid:=item.conversation_id; if item.author_id<>target_actor_id then raise insufficient_privilege; end if; end if;
  perform 1 from private.sygsphere_conversations where id=cid and not archived for update;
  if not found or not exists(select 1 from private.sygsphere_members where conversation_id=cid and employee_id=target_actor_id and removed_at is null) then raise insufficient_privilege; end if;
  if action='begin' then
    if item.id is not null then
      if item.checksum<>input->>'checksum' or item.conversation_id<>(input->>'conversationId')::uuid or item.parent_id is distinct from nullif(input->>'parentId','')::uuid then raise check_violation using message='Upload retry does not match the original file.'; end if;
      if item.state='rejected' then raise check_violation using message='This file did not pass its security scan.'; end if;
      return jsonb_build_object('state',item.state,'id',item.id,'messageId',item.message_id);
    end if;
    if (select count(*) from private.sygsphere_files where author_id=target_actor_id and created_at>clock_timestamp()-interval '1 hour')>=50 then raise check_violation using message='Hourly file sharing limit reached. Try again later.'; end if;
    if nullif(input->>'parentId','') is not null and not exists(select 1 from private.sygsphere_messages where id=(input->>'parentId')::uuid and conversation_id=cid and parent_id is null and deleted_at is null) then raise check_violation using message='Thread is not available.'; end if;
    insert into private.sygsphere_files(id,conversation_id,author_id,parent_id,filename,mime_type,size_bytes,checksum)
      values(fid,cid,target_actor_id,nullif(input->>'parentId','')::uuid,input->>'filename',input->>'mimeType',(input->>'sizeBytes')::integer,input->>'checksum') returning * into item;
  elsif action='complete' then
    if item.id is null then raise check_violation using message='File upload not found.'; end if;
    if item.state='clean' then return jsonb_build_object('state','clean','id',item.id,'messageId',item.message_id); end if;
    if input->>'state' not in ('clean','rejected','error') or item.state='rejected' then raise check_violation; end if;
    if input->>'state'='clean' then
      if input->>'checksum' is distinct from item.checksum or coalesce(input->>'scanner','')='' then raise check_violation using message='Verified scan evidence is required.'; end if;
      insert into private.sygsphere_messages(conversation_id,author_id,client_id,parent_id,body) values(cid,target_actor_id,fid,item.parent_id,'Shared file: '||item.filename) returning id into mid;
      update private.sygsphere_conversations set updated_at=clock_timestamp() where id=cid;
    end if;
    update private.sygsphere_files set state=input->>'state',scanner=input->>'scanner',scanned_at=clock_timestamp(),message_id=mid where id=fid returning * into item;
    perform private.sygsphere_signal(cid);
  else raise check_violation; end if;
  return jsonb_build_object('state',item.state,'id',item.id,'messageId',item.message_id);
end $$;
revoke all on function public.sygsphere_files(text,jsonb) from public,anon;
grant execute on function public.sygsphere_files(text,jsonb) to authenticated;
revoke all on function public.service_sygsphere_file(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.service_sygsphere_file(text,uuid,jsonb) to service_role;
commit;

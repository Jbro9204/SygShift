begin;

set local lock_timeout = '5s';

alter table private.sygsphere_resumable_uploads
  drop constraint if exists sygsphere_resumable_uploads_size_bytes_check;
alter table private.sygsphere_resumable_uploads
  add constraint sygsphere_resumable_uploads_size_bytes_check
  check (size_bytes between 1 and 104857600) not valid;
alter table private.sygsphere_resumable_uploads
  validate constraint sygsphere_resumable_uploads_size_bytes_check;

alter table private.sygsphere_resumable_uploads
  add column if not exists manual_retry_count integer not null default 0,
  add column if not exists last_request_id uuid,
  add column if not exists uploaded_at timestamptz,
  add column if not exists first_scan_started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists failure_stage text;

alter table private.sygsphere_resumable_uploads
  drop constraint if exists sygsphere_resumable_uploads_manual_retry_count_check;
alter table private.sygsphere_resumable_uploads
  add constraint sygsphere_resumable_uploads_manual_retry_count_check
  check (manual_retry_count between 0 and 2) not valid;
alter table private.sygsphere_resumable_uploads
  validate constraint sygsphere_resumable_uploads_manual_retry_count_check;

alter table private.sygsphere_resumable_uploads
  drop constraint if exists sygsphere_resumable_uploads_failure_stage_check;
alter table private.sygsphere_resumable_uploads
  add constraint sygsphere_resumable_uploads_failure_stage_check
  check (failure_stage is null or failure_stage in ('file_validation','security_scan','storage','expired')) not valid;
alter table private.sygsphere_resumable_uploads
  validate constraint sygsphere_resumable_uploads_failure_stage_check;

create index if not exists sygsphere_resumable_retry_expiry
  on private.sygsphere_resumable_uploads(expires_at)
  where state = 'error' and purged_at is null;

create or replace function public.service_begin_sygsphere_resumable_upload(target_actor_id uuid, input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  config_row private.sygsphere_resumable_policy%rowtype;
  cid uuid := (input->>'conversationId')::uuid;
  fid uuid := (input->>'fileId')::uuid;
  requested_size bigint := (input->>'sizeBytes')::bigint;
  requested_name text := left(trim(coalesce(input->>'filename','')),240);
  requested_mime text := left(lower(trim(coalesce(input->>'mimeType',''))),200);
  requested_extension text := lower(regexp_replace(left(trim(coalesce(input->>'filename','')),240), '^.*\.', ''));
  expected_mime text;
  request_reference uuid := nullif(input->>'requestId','')::uuid;
  item private.sygsphere_resumable_uploads%rowtype;
  hourly_limit integer;
  concurrent_limit integer;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_actor_id::text,0));
  select * into config_row from private.sygsphere_resumable_policy where singleton;
  if not config_row.enabled then raise object_not_in_prerequisite_state using message='Protected SygSphere uploads are not enabled.'; end if;
  if not exists(select 1 from private.sygsphere_gate where enabled) or not exists(
    select 1 from public.employees employee
    join private.employee_accounts account on account.employee_id=employee.id
    where employee.id=target_actor_id and employee.status='active' and account.disabled_at is null
  ) then raise insufficient_privilege; end if;
  if requested_size < 1 or requested_size > config_row.resumable_max_bytes then
    raise check_violation using message='Choose a file between 1 byte and 100 MB.';
  end if;
  expected_mime := case requested_extension
    when 'pdf' then 'application/pdf'
    when 'txt' then 'text/plain'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'jpg' then 'image/jpeg'
    when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png'
    when 'webp' then 'image/webp'
    else null
  end;
  if requested_name='' or expected_mime is null or requested_mime<>expected_mime then
    raise check_violation using message='The file name and selected file type do not match a supported SygSphere format.';
  end if;
  if requested_size>config_row.inline_max_bytes and requested_mime not in ('image/jpeg','image/png','image/webp') then
    raise check_violation using message='Files over 25 MB must be matching JPEG, PNG, or WebP images.';
  end if;
  hourly_limit := case when requested_size>config_row.inline_max_bytes then 10 else 50 end;
  concurrent_limit := case when requested_size>config_row.inline_max_bytes then 3 else 10 end;
  if (select count(*) from private.sygsphere_resumable_uploads where author_id=target_actor_id and client_id<>(input->>'clientId')::uuid and created_at>clock_timestamp()-interval '1 hour')>=hourly_limit then
    raise check_violation using message='Hourly protected-file limit reached. Try again later.';
  end if;
  if (select count(*) from private.sygsphere_resumable_uploads where author_id=target_actor_id and client_id<>(input->>'clientId')::uuid and state in ('prepared','uploading','uploaded','scanning') and expires_at>clock_timestamp())>=concurrent_limit then
    raise check_violation using message='Finish or allow your existing uploads to complete before starting another.';
  end if;
  if not exists(
    select 1 from private.sygsphere_members member
    join private.sygsphere_conversations conversation on conversation.id=member.conversation_id
    where member.conversation_id=cid and member.employee_id=target_actor_id and member.removed_at is null and not conversation.archived
  ) then raise insufficient_privilege; end if;
  if nullif(input->>'parentId','') is not null and not exists(
    select 1 from private.sygsphere_messages where id=(input->>'parentId')::uuid and conversation_id=cid and parent_id is null and deleted_at is null
  ) then raise check_violation using message='Thread is not available.'; end if;

  insert into private.sygsphere_resumable_uploads(
    id,conversation_id,author_id,client_id,parent_id,object_key,filename,mime_type,size_bytes,expires_at,last_request_id
  ) values(
    fid,cid,target_actor_id,(input->>'clientId')::uuid,nullif(input->>'parentId','')::uuid,cid::text||'/'||fid::text,
    requested_name,requested_mime,requested_size::integer,clock_timestamp()+interval '2 hours',request_reference
  ) on conflict(author_id,client_id) do nothing returning * into item;
  if item.id is null then
    select * into item from private.sygsphere_resumable_uploads where author_id=target_actor_id and client_id=(input->>'clientId')::uuid for update;
  end if;
  if item.expires_at<=clock_timestamp() and item.state in ('prepared','uploading','uploaded') then
    update private.sygsphere_resumable_uploads set state='expired',failure_stage='expired',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=item.id returning * into item;
  end if;
  if item.id<>fid or item.conversation_id<>cid or item.parent_id is distinct from nullif(input->>'parentId','')::uuid
    or item.filename<>requested_name or item.mime_type<>requested_mime or item.size_bytes<>requested_size::integer then
    raise check_violation using message='Upload retry does not match the original request.';
  end if;
  if request_reference is not null and item.last_request_id is null then
    update private.sygsphere_resumable_uploads set last_request_id=request_reference where id=item.id returning * into item;
  end if;
  return jsonb_build_object(
    'uploadId',item.id,'objectKey',item.object_key,'expiresAt',item.expires_at,'state',item.state,
    'requestReference',item.last_request_id,
    'retryable',item.state='error' and item.purged_at is null and item.expires_at>clock_timestamp() and item.manual_retry_count<2
  );
end
$$;

create or replace function public.service_get_sygsphere_resumable_upload(target_actor_id uuid,target_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select upload.* into item from private.sygsphere_resumable_uploads upload
    join public.employees employee on employee.id=upload.author_id and employee.status='active'
    join private.employee_accounts account on account.employee_id=employee.id and account.disabled_at is null
    where upload.id=target_upload_id and upload.author_id=target_actor_id;
  if item.id is null then raise insufficient_privilege using message='This protected upload is not available.'; end if;
  if item.expires_at<=clock_timestamp() and item.state in ('prepared','uploading','uploaded') then
    update private.sygsphere_resumable_uploads set state='expired',failure_stage='expired',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=item.id returning * into item;
  end if;
  return jsonb_build_object(
    'uploadId',item.id,'bucket','sygsphere-files','objectKey',item.object_key,
    'filename',item.filename,'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'state',item.state,
    'messageId',item.message_id,'expiresAt',item.expires_at,'failureStage',item.failure_stage,
    'manualRetryCount',item.manual_retry_count,'requestReference',item.last_request_id,
    'retryable',item.state='error' and item.purged_at is null and item.expires_at>clock_timestamp() and item.manual_retry_count<2
  );
end
$$;

create or replace function public.service_mark_sygsphere_resumable_uploaded(
  target_actor_id uuid,target_upload_id uuid,target_size_bytes bigint,target_mime_type text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into item from private.sygsphere_resumable_uploads where id=target_upload_id for update;
  if item.id is null or item.author_id<>target_actor_id then raise insufficient_privilege; end if;
  if item.size_bytes<>target_size_bytes or item.mime_type<>lower(trim(target_mime_type)) then
    raise check_violation using message='The stored file does not match the authorized upload.';
  end if;
  if item.expires_at<=clock_timestamp() and item.state='prepared' then
    update private.sygsphere_resumable_uploads set state='expired',failure_stage='expired',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=item.id returning * into item;
  end if;
  if item.state in ('clean','rejected','error','expired','scanning','uploaded') then
    return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
  end if;
  if item.state<>'prepared' then raise object_not_in_prerequisite_state using message='This protected upload is no longer available.'; end if;
  update private.sygsphere_resumable_uploads
    set state='uploaded',available_at=clock_timestamp(),uploaded_at=coalesce(uploaded_at,clock_timestamp()),failure_stage=null,updated_at=clock_timestamp(),last_error=null
    where id=item.id returning * into item;
  return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
end
$$;

create or replace function public.service_reject_sygsphere_resumable_upload(
  target_actor_id uuid,target_upload_id uuid,target_error text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads
  set state='rejected',lease_id=null,failure_stage='file_validation',completed_at=clock_timestamp(),
      last_error=left(coalesce(nullif(trim(target_error),''),'The stored file did not match the authorized upload.'),1000),updated_at=clock_timestamp()
  where id=target_upload_id and author_id=target_actor_id and state in ('prepared','uploaded','scanning')
  returning * into item;
  if item.id is null then select * into item from private.sygsphere_resumable_uploads where id=target_upload_id and author_id=target_actor_id; end if;
  if item.id is null then raise insufficient_privilege; end if;
  if item.state='rejected' then
    perform private.create_employee_notification(item.author_id,'sygsphere_file',item.id,
      concat('sygsphere-file-rejected:',item.id),'SygSphere file was blocked',
      'A file did not pass its protected validation or security check and was not shared.','important',false,
      concat('/sygsphere?conversation=',item.conversation_id),'Open SygSphere');
  end if;
  return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id,
    'objectKey',case when item.state in ('rejected','expired') then item.object_key else null end);
end
$$;

create or replace function public.service_claim_sygsphere_resumable_scan(target_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into item from private.sygsphere_resumable_uploads where id=target_upload_id for update;
  if item.id is null then return jsonb_build_object('terminal',true); end if;
  if item.state in ('clean','rejected','error','expired') then
    return jsonb_strip_nulls(jsonb_build_object('terminal',true,'state',item.state,
      'objectKey',case when item.state in ('rejected','expired') then item.object_key else null end));
  end if;
  if item.state in ('prepared','uploading','uploaded') and item.expires_at<=clock_timestamp() then
    update private.sygsphere_resumable_uploads set state='expired',lease_id=null,failure_stage='expired',completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=item.id;
    return jsonb_build_object('terminal',true,'state','expired','objectKey',item.object_key);
  end if;
  if item.state='scanning' and item.updated_at>clock_timestamp()-interval '8 minutes' then return jsonb_build_object('terminal',false,'deferred',true); end if;
  if item.state not in ('uploaded','scanning') or item.available_at>clock_timestamp() then return jsonb_build_object('terminal',false,'deferred',true); end if;
  if item.attempt_count>=5 then
    update private.sygsphere_resumable_uploads
      set state='error',lease_id=null,failure_stage='security_scan',completed_at=clock_timestamp(),expires_at=greatest(expires_at,clock_timestamp()+interval '24 hours'),
          last_error='The malware scan could not be completed after five attempts.',updated_at=clock_timestamp()
      where id=item.id returning * into item;
    perform private.create_employee_notification(item.author_id,'sygsphere_file',item.id,
      concat('sygsphere-file-scan-error:',item.id,':',item.manual_retry_count),'SygSphere file needs attention',
      'A protected file security check could not finish. The quarantined upload can be checked again without re-uploading.','important',false,
      concat('/sygsphere?conversation=',item.conversation_id,'&upload=',item.id),'Review upload');
    return jsonb_build_object('terminal',true,'state','error');
  end if;
  update private.sygsphere_resumable_uploads
    set state='scanning',lease_id=gen_random_uuid(),attempt_count=attempt_count+1,first_scan_started_at=coalesce(first_scan_started_at,clock_timestamp()),updated_at=clock_timestamp(),last_error=null
    where id=item.id returning * into item;
  return jsonb_build_object('terminal',false,'deferred',false,'uploadId',item.id,'conversationId',item.conversation_id,
    'authorId',item.author_id,'parentId',item.parent_id,'bucket','sygsphere-files','objectKey',item.object_key,
    'filename',item.filename,'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'leaseId',item.lease_id);
end
$$;

create or replace function public.service_complete_sygsphere_resumable_scan(
  target_upload_id uuid,target_lease_id uuid,target_state text,target_checksum text,target_scanner text,target_error text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  if target_state not in ('clean','rejected','error') or coalesce(target_checksum,'') !~ '^[0-9a-f]{64}$' then raise check_violation; end if;
  select * into item from private.sygsphere_resumable_uploads where id=target_upload_id for update;
  if item.id is null then raise check_violation using message='Protected upload not found.'; end if;
  if item.state in ('clean','rejected','error') then return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id); end if;
  if item.state<>'scanning' or item.lease_id is distinct from target_lease_id then raise object_not_in_prerequisite_state using message='The protected scan lease is no longer current.'; end if;
  result := public.service_sygsphere_file('begin',item.author_id,jsonb_build_object(
    'fileId',item.id,'conversationId',item.conversation_id,'parentId',item.parent_id,'filename',item.filename,
    'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'checksum',target_checksum));
  result := public.service_sygsphere_file('complete',item.author_id,jsonb_build_object(
    'fileId',item.id,'conversationId',item.conversation_id,'parentId',item.parent_id,'filename',item.filename,
    'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'checksum',target_checksum,'state',target_state,
    'scanner',case when target_state='error' then coalesce(nullif(trim(target_scanner),''),'scanner unavailable') else target_scanner end));
  update private.sygsphere_resumable_uploads
    set state=target_state,checksum=target_checksum,scanner=target_scanner,message_id=nullif(result->>'messageId','')::uuid,
        lease_id=null,last_error=left(nullif(trim(target_error),''),1000),failure_stage=case when target_state='clean' then null else 'security_scan' end,
        completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=item.id returning * into item;
  if item.state='clean' then
    perform private.create_employee_notification(item.author_id,'sygsphere_file',item.id,
      concat('sygsphere-file-ready:',item.id),'SygSphere file is ready',
      'Your protected file passed its security check and is ready in SygSphere.','routine',false,
      concat('/sygsphere?conversation=',item.conversation_id,'&message=',item.message_id),'Open file');
  elsif item.state='rejected' then
    perform private.create_employee_notification(item.author_id,'sygsphere_file',item.id,
      concat('sygsphere-file-rejected:',item.id),'SygSphere file was blocked',
      'A file did not pass its protected security check and was not shared.','important',false,
      concat('/sygsphere?conversation=',item.conversation_id),'Open SygSphere');
  end if;
  return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
end
$$;

create or replace function public.service_defer_sygsphere_resumable_scan(target_upload_id uuid,target_lease_id uuid,target_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads
  set state=case when attempt_count>=5 then 'error' else 'uploaded' end,lease_id=null,
      available_at=clock_timestamp()+interval '30 seconds',failure_stage=case when attempt_count>=5 then 'security_scan' else null end,
      completed_at=case when attempt_count>=5 then clock_timestamp() else null end,
      expires_at=case when attempt_count>=5 then greatest(expires_at,clock_timestamp()+interval '24 hours') else expires_at end,
      last_error=left(coalesce(nullif(trim(target_error),''),'The malware scan was interrupted.'),1000),updated_at=clock_timestamp()
  where id=target_upload_id and state='scanning' and lease_id=target_lease_id returning * into item;
  if item.id is null then
    select * into item from private.sygsphere_resumable_uploads where id=target_upload_id;
    if item.id is null then return jsonb_build_object('terminal',true,'state','missing'); end if;
    if item.state in ('clean','rejected','error','expired') then
      return jsonb_strip_nulls(jsonb_build_object('terminal',true,'state',item.state,
        'objectKey',case when item.state in ('rejected','expired') then item.object_key else null end));
    end if;
    return jsonb_build_object('terminal',false,'stale',true,'state',item.state);
  end if;
  if item.state='error' then
    perform private.create_employee_notification(item.author_id,'sygsphere_file',item.id,
      concat('sygsphere-file-scan-error:',item.id,':',item.manual_retry_count),'SygSphere file needs attention',
      'A protected file security check could not finish. The quarantined upload can be checked again without re-uploading.','important',false,
      concat('/sygsphere?conversation=',item.conversation_id,'&upload=',item.id),'Review upload');
  end if;
  return jsonb_build_object('terminal',item.state='error','state',item.state);
end
$$;

create or replace function public.service_retry_sygsphere_resumable_scan(target_actor_id uuid,target_upload_id uuid,target_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_actor_id::text,0));
  select upload.* into item from private.sygsphere_resumable_uploads upload
    join private.sygsphere_members member on member.conversation_id=upload.conversation_id and member.employee_id=target_actor_id and member.removed_at is null
    where upload.id=target_upload_id and upload.author_id=target_actor_id for update of upload;
  if item.id is null then raise insufficient_privilege; end if;
  if item.state<>'error' or item.purged_at is not null or item.expires_at<=clock_timestamp() then
    raise object_not_in_prerequisite_state using message='This quarantined upload can no longer be retried.';
  end if;
  if item.manual_retry_count>=2 then raise check_violation using message='This upload has reached its security-check retry limit. Choose the file again.'; end if;
  update private.sygsphere_resumable_uploads
    set state='uploaded',attempt_count=0,manual_retry_count=manual_retry_count+1,lease_id=null,available_at=clock_timestamp(),
        expires_at=clock_timestamp()+interval '2 hours',completed_at=null,failure_stage=null,last_error=null,last_request_id=target_request_id,updated_at=clock_timestamp()
    where id=item.id returning * into item;
  insert into private.audit_events(employee_id,request_id,schema_name,table_name,operation,row_id,old_record,new_record)
    values(target_actor_id,target_request_id::text,'private','sygsphere_resumable_uploads','RETRY_SCAN',item.id::text,
      jsonb_build_object('state','error'),jsonb_build_object('state','uploaded','manualRetryCount',item.manual_retry_count));
  return jsonb_build_object('uploadId',item.id,'state',item.state,'manualRetryCount',item.manual_retry_count,
    'requestReference',item.last_request_id,'retryable',false);
end
$$;

create or replace function public.service_list_sygsphere_resumable_purge(target_limit integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads set state='expired',lease_id=null,failure_stage='expired',completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where state in ('prepared','uploading','uploaded') and expires_at<=clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('uploadId',candidate.id,'objectKey',candidate.object_key)),'[]'::jsonb) into result
  from (
    select id,object_key from private.sygsphere_resumable_uploads
    where ((state in ('rejected','expired')) or (state='error' and expires_at<=clock_timestamp()))
      and (purged_at is null or (expires_at+interval '27 hours'>clock_timestamp() and purged_at<=clock_timestamp()-interval '15 minutes'))
    order by updated_at,id limit greatest(1,least(coalesce(target_limit,25),100))
  ) candidate;
  return result;
end
$$;

revoke all on function public.service_begin_sygsphere_resumable_upload(uuid,jsonb),
  public.service_get_sygsphere_resumable_upload(uuid,uuid),
  public.service_mark_sygsphere_resumable_uploaded(uuid,uuid,bigint,text),
  public.service_reject_sygsphere_resumable_upload(uuid,uuid,text),
  public.service_claim_sygsphere_resumable_scan(uuid),
  public.service_complete_sygsphere_resumable_scan(uuid,uuid,text,text,text,text),
  public.service_defer_sygsphere_resumable_scan(uuid,uuid,text),
  public.service_retry_sygsphere_resumable_scan(uuid,uuid,uuid),
  public.service_list_sygsphere_resumable_purge(integer)
from public,anon,authenticated;

grant execute on function public.service_begin_sygsphere_resumable_upload(uuid,jsonb),
  public.service_get_sygsphere_resumable_upload(uuid,uuid),
  public.service_mark_sygsphere_resumable_uploaded(uuid,uuid,bigint,text),
  public.service_reject_sygsphere_resumable_upload(uuid,uuid,text),
  public.service_claim_sygsphere_resumable_scan(uuid),
  public.service_complete_sygsphere_resumable_scan(uuid,uuid,text,text,text,text),
  public.service_defer_sygsphere_resumable_scan(uuid,uuid,text),
  public.service_retry_sygsphere_resumable_scan(uuid,uuid,uuid),
  public.service_list_sygsphere_resumable_purge(integer)
to service_role;

comment on function public.service_retry_sygsphere_resumable_scan(uuid,uuid,uuid) is
  'Restarts an owned, retained SygSphere malware scan without granting browser storage access or requiring a re-upload.';
comment on table private.sygsphere_resumable_uploads is
  'Private SygSphere quarantine queue for all supported attachments, including bounded retry and request-reference evidence.';

notify pgrst, 'reload schema';

commit;

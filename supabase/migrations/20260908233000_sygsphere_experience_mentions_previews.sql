begin;
set local lock_timeout = '5s';

alter table private.sygsphere_activity
  add column if not exists text_size text not null default 'comfortable'
  check (text_size in ('comfortable', 'large', 'extra_large'));

create table private.sygsphere_mentions (
  message_id uuid not null references private.sygsphere_messages(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  username text not null check(username ~ '^[a-z][a-z0-9]*$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (message_id, employee_id)
);
create index sygsphere_mentions_employee_created
  on private.sygsphere_mentions(employee_id, created_at desc);
alter table private.sygsphere_mentions enable row level security;
revoke all on private.sygsphere_mentions from public, anon, authenticated;

-- Large SygSphere files use a direct resumable quarantine plus the existing
-- isolated ClamAV scanner. Inline uploads remain bounded at 25 MB and HR
-- document limits remain unchanged.
create table private.sygsphere_resumable_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  inline_max_bytes integer not null default 26214400 check (inline_max_bytes = 26214400),
  resumable_max_bytes integer not null default 104857600 check (resumable_max_bytes = 104857600)
);
insert into private.sygsphere_resumable_policy(singleton) values(true);
create table private.sygsphere_resumable_uploads (
  id uuid primary key,
  conversation_id uuid not null references private.sygsphere_conversations(id),
  author_id uuid not null references public.employees(id),
  client_id uuid not null,
  parent_id uuid references private.sygsphere_messages(id),
  object_key text not null unique,
  filename text not null check(length(filename) between 1 and 240),
  mime_type text not null,
  size_bytes integer not null check(size_bytes between 26214401 and 104857600),
  state text not null default 'prepared' check(state in ('prepared','uploading','uploaded','scanning','clean','rejected','error','expired')),
  checksum text check(checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  scanner text,
  message_id uuid references private.sygsphere_messages(id),
  lease_id uuid,
  attempt_count integer not null default 0 check(attempt_count between 0 and 5),
  available_at timestamptz not null default clock_timestamp(),
  last_error text,
  purged_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(author_id, client_id)
);
create index sygsphere_resumable_uploads_actor_created on private.sygsphere_resumable_uploads(author_id, created_at desc);
create index sygsphere_resumable_uploads_conversation on private.sygsphere_resumable_uploads(conversation_id, created_at desc);
create index sygsphere_resumable_uploads_parent on private.sygsphere_resumable_uploads(parent_id) where parent_id is not null;
create index sygsphere_resumable_uploads_expiry on private.sygsphere_resumable_uploads(expires_at) where state in ('prepared','uploading','uploaded','scanning');
alter table private.sygsphere_resumable_policy enable row level security;
alter table private.sygsphere_resumable_uploads enable row level security;
revoke all on private.sygsphere_resumable_policy, private.sygsphere_resumable_uploads from public, anon, authenticated;

alter table private.sygsphere_files drop constraint sygsphere_files_size_bytes_check;
alter table private.sygsphere_files add constraint sygsphere_files_size_bytes_check
  check(size_bytes between 1 and 104857600);
update storage.buckets set file_size_limit=104857600 where id='sygsphere-files';

create function private.sygsphere_apply_structured_mentions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_ids text := current_setting('private.sygsphere.mention_ids', true);
  requested uuid[];
  previous uuid[];
  recipient uuid;
begin
  if raw_ids is null or raw_ids = '' then return new; end if;
  if jsonb_typeof(raw_ids::jsonb) <> 'array' or jsonb_array_length(raw_ids::jsonb) > 25 then
    raise check_violation using message = 'Choose no more than 25 conversation participants to mention.';
  end if;
  begin
    select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[])
      into requested from jsonb_array_elements_text(raw_ids::jsonb);
  exception when invalid_text_representation then
    raise check_violation using message = 'A selected mention is invalid.';
  end;
  requested := array_remove(requested, new.author_id);
  if exists (
    select 1 from unnest(requested) selected
    where not exists (
      select 1 from private.sygsphere_members member
      join public.employees employee on employee.id = member.employee_id
      join private.employee_accounts account on account.employee_id = employee.id
      left join private.sygsphere_mentions existing on existing.message_id=new.id and existing.employee_id=employee.id
      where member.conversation_id = new.conversation_id and member.employee_id = selected
        and member.removed_at is null and employee.status = 'active' and account.disabled_at is null
        and strpos(lower(new.body), '@' || lower(coalesce(existing.username,employee.username))) > 0
    )
  ) then
    raise check_violation using message = 'Mentions must identify an active participant selected in this conversation.';
  end if;
  select coalesce(array_agg(employee_id), '{}'::uuid[]) into previous
    from private.sygsphere_mentions where message_id=new.id;
  delete from private.sygsphere_mentions where message_id = new.id and employee_id <> all(requested);
  insert into private.sygsphere_mentions(message_id, employee_id, username)
    select new.id, selected, employee.username from unnest(requested) selected
    join public.employees employee on employee.id=selected on conflict do nothing;
  foreach recipient in array requested loop
    if not (recipient = any(previous)) then perform private.sygsphere_signal(new.conversation_id, recipient); end if;
  end loop;
  return new;
end
$$;
create trigger sygsphere_apply_structured_mentions
after insert or update of body on private.sygsphere_messages
for each row execute function private.sygsphere_apply_structured_mentions();

create or replace function private.sygsphere_message_json(target_message private.sygsphere_messages, actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',target_message.id,'sequence',target_message.sequence,'conversationId',target_message.conversation_id,
    'authorId',target_message.author_id,'authorName',concat(coalesce(nullif(e.preferred_name,''),e.first_name),' ',e.last_name),
    'body',case when target_message.deleted_at is null then target_message.body else '' end,'parentId',target_message.parent_id,
    'createdAt',target_message.created_at,'editedAt',target_message.edited_at,'deleted',target_message.deleted_at is not null,'pinned',target_message.pinned,
    'saved',exists(select 1 from private.sygsphere_saved s where s.message_id=target_message.id and s.employee_id=actor),
    'read',target_message.author_id=actor or exists(select 1 from private.sygsphere_reads r where r.message_id=target_message.id and r.employee_id=actor),
    'readBy',coalesce((select jsonb_agg(jsonb_build_object('id',r.employee_id,'name',concat(coalesce(nullif(reader.preferred_name,''),reader.first_name),' ',reader.last_name)))
      from private.sygsphere_reads r join public.employees reader on reader.id=r.employee_id where r.message_id=target_message.id and r.employee_id<>target_message.author_id),'[]'::jsonb),
    'replyCount',(select count(*) from private.sygsphere_messages reply where reply.parent_id=target_message.id),
    'unreadReplies',(select count(*) from private.sygsphere_messages reply where reply.parent_id=target_message.id and reply.author_id<>actor and reply.deleted_at is null
      and not exists(select 1 from private.sygsphere_reads r where r.message_id=reply.id and r.employee_id=actor)),
    'reactions',coalesce((select jsonb_agg(jsonb_build_object('emoji',x.emoji,'count',x.total,'mine',x.mine)) from (
      select r.emoji,count(*) total,bool_or(r.employee_id=actor) mine from private.sygsphere_reactions r where r.message_id=target_message.id group by r.emoji)x),'[]'::jsonb),
    'mentions',case when target_message.deleted_at is not null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
      'id',mentioned.id,'name',concat(coalesce(nullif(mentioned.preferred_name,''),mentioned.first_name),' ',mentioned.last_name),'username',mention.username)
      order by mentioned.first_name,mentioned.last_name,mentioned.id)
      from private.sygsphere_mentions mention join public.employees mentioned on mentioned.id=mention.employee_id
      where mention.message_id=target_message.id),'[]'::jsonb) end)
  from public.employees e where e.id=target_message.author_id
$$;

create or replace function public.sygsphere_request(action text, input jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.current_employee_id();
  result jsonb;
  requested uuid[];
  persisted uuid[];
begin
  if action = 'mentions' then
    perform private.sygsphere_request('presence', '{}'::jsonb);
    select coalesce(jsonb_agg(payload order by created_at desc), '[]'::jsonb) into result
    from (
      select mention.created_at,
        jsonb_build_object(
          'messageId', message.id,
          'conversationId', message.conversation_id,
          'conversationName', case when conversation.kind='direct' then coalesce((
            select concat(coalesce(nullif(other_employee.preferred_name,''),other_employee.first_name),' ',other_employee.last_name)
            from private.sygsphere_members other_member
            join public.employees other_employee on other_employee.id=other_member.employee_id
            where other_member.conversation_id=conversation.id and other_member.employee_id<>actor and other_member.removed_at is null limit 1
          ),'Direct conversation') else conversation.name end,
          'authorId', message.author_id,
          'parentId', message.parent_id,
          'createdAt', mention.created_at
        ) payload
      from private.sygsphere_mentions mention
      join private.sygsphere_messages message on message.id=mention.message_id
      join private.sygsphere_conversations conversation on conversation.id=message.conversation_id
      join private.sygsphere_members membership on membership.conversation_id=message.conversation_id and membership.employee_id=actor and membership.removed_at is null
      where mention.employee_id=actor and message.deleted_at is null
        and not exists(select 1 from private.sygsphere_reads read where read.message_id=message.id and read.employee_id=actor)
      order by mention.created_at desc limit 100
    ) mention_rows;
    return result;
  end if;

  if action in ('send','edit') and input ? 'mentionIds' then
    if jsonb_typeof(input->'mentionIds') <> 'array' then raise check_violation using message='Mentions must be a list.'; end if;
    perform set_config('private.sygsphere.mention_ids', (input->'mentionIds')::text, true);
  else
    perform set_config('private.sygsphere.mention_ids', '', true);
  end if;
  result := private.sygsphere_request(action,input);
  if action='send' and input ? 'mentionIds' then
    select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[]) into requested
      from jsonb_array_elements_text(input->'mentionIds');
    requested := array_remove(requested, actor);
    select coalesce(array_agg(mention.employee_id order by mention.employee_id), '{}'::uuid[]) into persisted
      from private.sygsphere_mentions mention where mention.message_id=(result->>'id')::uuid;
    if requested is distinct from persisted then raise check_violation using message='This retry does not match the original mentions.'; end if;
  end if;
  return result;
end
$$;

create function public.sygsphere_people(action text, input jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.current_employee_id();
  cid uuid := nullif(input->>'conversationId','')::uuid;
  result jsonb;
begin
  if action='conversation' then perform private.sygsphere_request('conversation',jsonb_build_object('conversationId',cid));
  else perform private.sygsphere_request('presence','{}'::jsonb); end if;
  if action='directory' then
    select coalesce(jsonb_agg(row_to_json(person) order by person.name,person.id),'[]'::jsonb) into result from (
      select employee.id,concat(coalesce(nullif(employee.preferred_name,''),employee.first_name),' ',employee.last_name) name,
        employee.username,employee.role,employee.photo_path "photoPath",
        case when activity.last_seen>clock_timestamp()-interval '75 seconds' then coalesce(activity.availability,'available') else 'offline' end presence,true active
      from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
      left join private.sygsphere_activity activity on activity.employee_id=employee.id
      where employee.status='active' and account.disabled_at is null and (coalesce(input->>'query','')='' or
        concat(employee.first_name,' ',employee.last_name,' ',employee.preferred_name,' ',employee.username) ilike '%'||left(input->>'query',100)||'%')
      order by employee.first_name,employee.last_name,employee.id limit 100
    ) person;
    return result;
  elsif action='conversation' then
    select jsonb_build_object('description',conversation.description,'members',coalesce(jsonb_agg(jsonb_build_object(
      'id',employee.id,'name',concat(coalesce(nullif(employee.preferred_name,''),employee.first_name),' ',employee.last_name),
      'username',employee.username,'role',employee.role,'photoPath',employee.photo_path,'owner',member.owner,
      'active',employee.status='active' and account.disabled_at is null,
      'presence',case when activity.last_seen>clock_timestamp()-interval '75 seconds' then coalesce(activity.availability,'available') else 'offline' end,
      'typing',coalesce(member.typing_until>clock_timestamp(),false)) order by member.owner desc,employee.first_name,employee.last_name),'[]'::jsonb))
      into result from private.sygsphere_conversations conversation
      join private.sygsphere_members member on member.conversation_id=conversation.id and member.removed_at is null
      join public.employees employee on employee.id=member.employee_id
      left join private.employee_accounts account on account.employee_id=employee.id
      left join private.sygsphere_activity activity on activity.employee_id=employee.id
      where conversation.id=cid group by conversation.id,conversation.description;
    return result;
  elsif action='avatars' then
    select coalesce(jsonb_agg(jsonb_build_object('conversationId',conversation.id,'person',jsonb_build_object(
      'id',employee.id,'name',concat(coalesce(nullif(employee.preferred_name,''),employee.first_name),' ',employee.last_name),
      'username',employee.username,'role',employee.role,'photoPath',employee.photo_path,'presence','offline','active',true))),'[]'::jsonb)
      into result from private.sygsphere_members mine
      join private.sygsphere_conversations conversation on conversation.id=mine.conversation_id and conversation.kind='direct'
      join private.sygsphere_members other_member on other_member.conversation_id=conversation.id and other_member.employee_id<>actor and other_member.removed_at is null
      join public.employees employee on employee.id=other_member.employee_id
      join private.employee_accounts account on account.employee_id=employee.id and account.disabled_at is null
      where mine.employee_id=actor and mine.removed_at is null and employee.status='active';
    return result;
  end if;
  raise check_violation using message='Unknown SygSphere people request.';
end
$$;

create function public.sygsphere_preferences(target_text_size text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare actor uuid := private.current_employee_id(); selected text;
begin
  perform private.sygsphere_request('presence','{}'::jsonb);
  if target_text_size is not null and target_text_size not in ('comfortable','large','extra_large') then
    raise check_violation using message='Choose a supported SygSphere text size.';
  end if;
  if target_text_size is not null then
    update private.sygsphere_activity set text_size=target_text_size where employee_id=actor;
  end if;
  select coalesce(text_size,'comfortable') into selected from private.sygsphere_activity where employee_id=actor;
  return jsonb_build_object('textSize',coalesce(selected,'comfortable'));
end
$$;

create function public.sygsphere_can_read_avatar(target_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor uuid := private.current_employee_id(); session_context jsonb;
begin
  if actor is null or not exists(select 1 from private.sygsphere_gate where enabled) then return false; end if;
  select to_jsonb(context) into session_context from public.get_session_context() context;
  if coalesce((session_context->>'must_change_password')::boolean,true)
    or ((session_context->>'mfa_required')::boolean and not (session_context->>'has_mfa')::boolean) then return false; end if;
  return exists(
    select 1 from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
    where employee.photo_path=target_path and employee.status='active' and account.disabled_at is null
  );
end
$$;

drop policy if exists sygsphere_employee_photos_active_account_read on storage.objects;
create policy sygsphere_employee_photos_active_account_read on storage.objects
for select to authenticated
using (bucket_id='employee-photos' and public.sygsphere_can_read_avatar(name));

create function public.sygsphere_upload_capabilities()
returns jsonb language plpgsql security definer set search_path='' as $$
declare config_row private.sygsphere_resumable_policy%rowtype;
begin
  perform private.sygsphere_request('presence','{}'::jsonb);
  select * into config_row from private.sygsphere_resumable_policy where singleton;
  return jsonb_build_object('inlineMaxBytes',config_row.inline_max_bytes,'resumableEnabled',config_row.enabled,'resumableMaxBytes',config_row.resumable_max_bytes);
end
$$;

create function public.service_begin_sygsphere_resumable_upload(target_actor_id uuid,input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare config_row private.sygsphere_resumable_policy%rowtype; cid uuid:=(input->>'conversationId')::uuid; fid uuid:=(input->>'fileId')::uuid; item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_actor_id::text,0));
  select * into config_row from private.sygsphere_resumable_policy where singleton;
  if not config_row.enabled then raise object_not_in_prerequisite_state using message='Larger resumable SygSphere uploads are not enabled.'; end if;
  if not exists(select 1 from private.sygsphere_gate where enabled) or not exists(select 1 from public.employees employee
    join private.employee_accounts account on account.employee_id=employee.id
    where employee.id=target_actor_id and employee.status='active' and account.disabled_at is null) then raise insufficient_privilege; end if;
  if (input->>'sizeBytes')::bigint<=config_row.inline_max_bytes or (input->>'sizeBytes')::bigint>config_row.resumable_max_bytes then raise check_violation using message='File size is outside the resumable range.'; end if;
  if left(trim(coalesce(input->>'filename','')),240)='' or lower(trim(coalesce(input->>'mimeType',''))) not in ('image/jpeg','image/png','image/webp') then raise check_violation using message='Larger uploads support JPEG, PNG, and WebP image files.'; end if;
  if (select count(*) from private.sygsphere_resumable_uploads where author_id=target_actor_id and client_id<>(input->>'clientId')::uuid and created_at>clock_timestamp()-interval '1 hour')>=10 then raise check_violation using message='Hourly larger-file limit reached. Try again later.'; end if;
  if (select count(*) from private.sygsphere_resumable_uploads where author_id=target_actor_id and client_id<>(input->>'clientId')::uuid and state in ('prepared','uploading','uploaded','scanning') and expires_at>clock_timestamp())>=3 then raise check_violation using message='Finish or allow your existing larger uploads to expire before starting another.'; end if;
  if not exists(select 1 from private.sygsphere_members member join private.sygsphere_conversations conversation on conversation.id=member.conversation_id
    where member.conversation_id=cid and member.employee_id=target_actor_id and member.removed_at is null and not conversation.archived) then raise insufficient_privilege; end if;
  if nullif(input->>'parentId','') is not null and not exists(select 1 from private.sygsphere_messages where id=(input->>'parentId')::uuid and conversation_id=cid and parent_id is null and deleted_at is null) then raise check_violation using message='Thread is not available.'; end if;
  insert into private.sygsphere_resumable_uploads(id,conversation_id,author_id,client_id,parent_id,object_key,filename,mime_type,size_bytes,expires_at)
    values(fid,cid,target_actor_id,(input->>'clientId')::uuid,nullif(input->>'parentId','')::uuid,cid::text||'/'||fid::text,
      left(trim(input->>'filename'),240),left(lower(trim(input->>'mimeType')),200),(input->>'sizeBytes')::integer,clock_timestamp()+interval '2 hours')
    on conflict(author_id,client_id) do nothing returning * into item;
  if item.id is null then select * into item from private.sygsphere_resumable_uploads where author_id=target_actor_id and client_id=(input->>'clientId')::uuid for update; end if;
  if item.expires_at<=clock_timestamp() and item.state in ('prepared','uploading','uploaded') then
    update private.sygsphere_resumable_uploads set state='expired',updated_at=clock_timestamp() where id=item.id returning * into item;
  end if;
  if item.id<>fid or item.conversation_id<>cid or item.parent_id is distinct from nullif(input->>'parentId','')::uuid
    or item.filename<>left(trim(input->>'filename'),240) or item.mime_type<>left(lower(trim(input->>'mimeType')),200)
    or item.size_bytes<>(input->>'sizeBytes')::integer then raise check_violation using message='Upload retry does not match the original request.'; end if;
  return jsonb_build_object('uploadId',item.id,'objectKey',item.object_key,'expiresAt',item.expires_at,'state',item.state);
end
$$;

create function public.service_get_sygsphere_resumable_upload(target_actor_id uuid,target_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select upload.* into item from private.sygsphere_resumable_uploads upload
    join public.employees employee on employee.id=upload.author_id and employee.status='active'
    join private.employee_accounts account on account.employee_id=employee.id and account.disabled_at is null
    where upload.id=target_upload_id and upload.author_id=target_actor_id;
  if item.id is null then raise insufficient_privilege using message='This larger-file upload is not available.'; end if;
  if item.expires_at<=clock_timestamp() and item.state in ('prepared','uploading','uploaded') then
    update private.sygsphere_resumable_uploads set state='expired',updated_at=clock_timestamp() where id=item.id returning * into item;
  end if;
  return jsonb_build_object('uploadId',item.id,'bucket','sygsphere-files','objectKey',item.object_key,
    'filename',item.filename,'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'state',item.state,
    'messageId',item.message_id,'expiresAt',item.expires_at,'lastError',item.last_error);
end
$$;

create function public.service_mark_sygsphere_resumable_uploaded(
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
    update private.sygsphere_resumable_uploads set state='expired',updated_at=clock_timestamp() where id=item.id returning * into item;
  end if;
  if item.state in ('clean','rejected','error','expired','scanning','uploaded') then
    return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
  end if;
  if item.state<>'prepared' then
    raise object_not_in_prerequisite_state using message='This larger-file upload is no longer available.';
  end if;
  update private.sygsphere_resumable_uploads set state='uploaded',available_at=clock_timestamp(),updated_at=clock_timestamp(),last_error=null
    where id=item.id returning * into item;
  return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
end
$$;

create function public.service_reject_sygsphere_resumable_upload(
  target_actor_id uuid,target_upload_id uuid,target_error text
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads
  set state='rejected',lease_id=null,last_error=left(coalesce(nullif(trim(target_error),''),'The stored file did not match the authorized upload.'),1000),updated_at=clock_timestamp()
  where id=target_upload_id and author_id=target_actor_id and state in ('prepared','uploaded','scanning')
  returning * into item;
  if item.id is null then
    select * into item from private.sygsphere_resumable_uploads where id=target_upload_id and author_id=target_actor_id;
  end if;
  if item.id is null then raise insufficient_privilege; end if;
  return jsonb_build_object(
    'uploadId',item.id,
    'state',item.state,
    'messageId',item.message_id,
    'objectKey',case when item.state in ('rejected','error','expired') then item.object_key else null end
  );
end
$$;

create function public.service_claim_sygsphere_resumable_scan(target_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into item from private.sygsphere_resumable_uploads where id=target_upload_id for update;
  if item.id is null then return jsonb_build_object('terminal',true); end if;
  if item.state in ('clean','rejected','error','expired') then
    return jsonb_build_object('terminal',true,'state',item.state,'objectKey',case when item.state='clean' then null else item.object_key end);
  end if;
  if item.state in ('prepared','uploading','uploaded') and item.expires_at<=clock_timestamp() then
    update private.sygsphere_resumable_uploads set state='expired',lease_id=null,updated_at=clock_timestamp() where id=item.id;
    return jsonb_build_object('terminal',true,'state','expired','objectKey',item.object_key);
  end if;
  if item.state='scanning' and item.updated_at>clock_timestamp()-interval '8 minutes' then
    return jsonb_build_object('terminal',false,'deferred',true);
  end if;
  if item.state not in ('uploaded','scanning') or item.available_at>clock_timestamp() then
    return jsonb_build_object('terminal',false,'deferred',true);
  end if;
  if item.attempt_count>=5 then
    update private.sygsphere_resumable_uploads set state='error',lease_id=null,last_error='The malware scan could not be completed after five attempts.',updated_at=clock_timestamp() where id=item.id;
    return jsonb_build_object('terminal',true,'state','error','objectKey',item.object_key);
  end if;
  update private.sygsphere_resumable_uploads set state='scanning',lease_id=gen_random_uuid(),attempt_count=attempt_count+1,updated_at=clock_timestamp(),last_error=null
    where id=item.id returning * into item;
  return jsonb_build_object('terminal',false,'deferred',false,'uploadId',item.id,'conversationId',item.conversation_id,
    'authorId',item.author_id,'parentId',item.parent_id,'bucket','sygsphere-files','objectKey',item.object_key,
    'filename',item.filename,'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'leaseId',item.lease_id);
end
$$;

create function public.service_complete_sygsphere_resumable_scan(
  target_upload_id uuid,target_lease_id uuid,target_state text,target_checksum text,target_scanner text,target_error text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  if target_state not in ('clean','rejected','error') or coalesce(target_checksum,'') !~ '^[0-9a-f]{64}$' then raise check_violation; end if;
  select * into item from private.sygsphere_resumable_uploads where id=target_upload_id for update;
  if item.id is null then raise check_violation using message='Larger-file upload not found.'; end if;
  if item.state in ('clean','rejected','error') then
    return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
  end if;
  if item.state<>'scanning' or item.lease_id is distinct from target_lease_id then raise object_not_in_prerequisite_state using message='The larger-file scan lease is no longer current.'; end if;
  result := public.service_sygsphere_file('begin',item.author_id,jsonb_build_object(
    'fileId',item.id,'conversationId',item.conversation_id,'parentId',item.parent_id,'filename',item.filename,
    'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'checksum',target_checksum));
  result := public.service_sygsphere_file('complete',item.author_id,jsonb_build_object(
    'fileId',item.id,'conversationId',item.conversation_id,'parentId',item.parent_id,'filename',item.filename,
    'mimeType',item.mime_type,'sizeBytes',item.size_bytes,'checksum',target_checksum,'state',target_state,
    'scanner',case when target_state='error' then coalesce(nullif(trim(target_scanner),''),'scanner unavailable') else target_scanner end));
  update private.sygsphere_resumable_uploads set state=target_state,checksum=target_checksum,scanner=target_scanner,
    message_id=nullif(result->>'messageId','')::uuid,lease_id=null,last_error=left(nullif(trim(target_error),''),1000),updated_at=clock_timestamp()
    where id=item.id returning * into item;
  return jsonb_build_object('uploadId',item.id,'state',item.state,'messageId',item.message_id);
end
$$;

create function public.service_defer_sygsphere_resumable_scan(target_upload_id uuid,target_lease_id uuid,target_error text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item private.sygsphere_resumable_uploads%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads
  set state=case when attempt_count>=5 then 'error' else 'uploaded' end,
      lease_id=null,
      available_at=clock_timestamp()+interval '30 seconds',
      last_error=left(coalesce(nullif(trim(target_error),''),'The malware scan was interrupted.'),1000),
      updated_at=clock_timestamp()
  where id=target_upload_id and state='scanning' and lease_id=target_lease_id
  returning * into item;
  if item.id is null then
    select * into item from private.sygsphere_resumable_uploads where id=target_upload_id;
    if item.id is null then return jsonb_build_object('terminal',true,'state','missing'); end if;
    if item.state in ('clean','rejected','error','expired') then
      return jsonb_build_object(
        'terminal',true,
        'state',item.state,
        'objectKey',case when item.state in ('rejected','error','expired') then item.object_key else null end
      );
    end if;
    return jsonb_build_object('terminal',false,'stale',true,'state',item.state);
  end if;
  return jsonb_build_object(
    'terminal',item.state='error',
    'state',item.state,
    'objectKey',case when item.state='error' then item.object_key else null end
  );
end
$$;

create function public.service_list_sygsphere_resumable_purge(target_limit integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads
    set state='expired',lease_id=null,updated_at=clock_timestamp()
    where state in ('prepared','uploading','uploaded') and expires_at<=clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('uploadId',candidate.id,'objectKey',candidate.object_key)),'[]'::jsonb)
    into result
    from (
      select id,object_key from private.sygsphere_resumable_uploads
      where state in ('rejected','error','expired')
        and (
          purged_at is null
          or (expires_at + interval '27 hours'>clock_timestamp() and purged_at<=clock_timestamp()-interval '15 minutes')
        )
      order by updated_at,id limit greatest(1,least(coalesce(target_limit,25),100))
    ) candidate;
  return result;
end
$$;

create function public.service_mark_sygsphere_resumable_purged(target_upload_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  update private.sygsphere_resumable_uploads set purged_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=any(coalesce(target_upload_ids,'{}'::uuid[])) and state in ('rejected','error','expired');
  get diagnostics affected=row_count;
  return affected;
end
$$;

revoke all on function private.sygsphere_apply_structured_mentions(),
  private.sygsphere_message_json(private.sygsphere_messages,uuid) from public,anon,authenticated;
revoke all on function public.sygsphere_request(text,jsonb),public.sygsphere_people(text,jsonb),public.sygsphere_preferences(text),
  public.sygsphere_can_read_avatar(text),public.sygsphere_upload_capabilities(),public.service_begin_sygsphere_resumable_upload(uuid,jsonb),
  public.service_get_sygsphere_resumable_upload(uuid,uuid),public.service_mark_sygsphere_resumable_uploaded(uuid,uuid,bigint,text),
  public.service_reject_sygsphere_resumable_upload(uuid,uuid,text),
  public.service_claim_sygsphere_resumable_scan(uuid),public.service_complete_sygsphere_resumable_scan(uuid,uuid,text,text,text,text),
  public.service_defer_sygsphere_resumable_scan(uuid,uuid,text),public.service_list_sygsphere_resumable_purge(integer),
  public.service_mark_sygsphere_resumable_purged(uuid[]) from public,anon,authenticated;
grant execute on function public.sygsphere_request(text,jsonb),public.sygsphere_people(text,jsonb),public.sygsphere_preferences(text),
  public.sygsphere_can_read_avatar(text),public.sygsphere_upload_capabilities() to authenticated;
grant execute on function public.service_begin_sygsphere_resumable_upload(uuid,jsonb),public.service_get_sygsphere_resumable_upload(uuid,uuid),
  public.service_mark_sygsphere_resumable_uploaded(uuid,uuid,bigint,text),public.service_claim_sygsphere_resumable_scan(uuid),
  public.service_reject_sygsphere_resumable_upload(uuid,uuid,text),
  public.service_complete_sygsphere_resumable_scan(uuid,uuid,text,text,text,text),public.service_defer_sygsphere_resumable_scan(uuid,uuid,text),
  public.service_list_sygsphere_resumable_purge(integer),public.service_mark_sygsphere_resumable_purged(uuid[]) to service_role;

notify pgrst, 'reload schema';
commit;

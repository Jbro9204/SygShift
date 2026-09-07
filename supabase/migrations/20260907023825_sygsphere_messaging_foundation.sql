begin;
set local lock_timeout = '5s';

create table private.sygsphere_gate (singleton boolean primary key default true check(singleton), enabled boolean not null default false);
insert into private.sygsphere_gate values(true,false);
create table private.sygsphere_conversations (
  id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('direct','group','channel')),
  name text not null default '' check(length(name)<=100), description text not null default '' check(length(description)<=1000),
  direct_key text unique, created_by uuid not null references public.employees(id),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  archived boolean not null default false, check((kind='direct')=(direct_key is not null))
);
create index sygsphere_conversations_creator on private.sygsphere_conversations(created_by);
create table private.sygsphere_members (
  conversation_id uuid not null references private.sygsphere_conversations(id), employee_id uuid not null references public.employees(id),
  owner boolean not null default false, joined_at timestamptz not null default clock_timestamp(), removed_at timestamptz,
  muted boolean not null default false, favorite boolean not null default false, typing_until timestamptz,
  primary key(conversation_id,employee_id)
);
create index sygsphere_members_employee on private.sygsphere_members(employee_id,conversation_id) where removed_at is null;
create table private.sygsphere_messages (
  id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity unique,
  conversation_id uuid not null references private.sygsphere_conversations(id), author_id uuid not null references public.employees(id),
  client_id uuid not null, parent_id uuid references private.sygsphere_messages(id),
  body text not null check(length(body)<=12000), created_at timestamptz not null default clock_timestamp(),
  edited_at timestamptz, deleted_at timestamptz, pinned boolean not null default false,
  unique(author_id,client_id)
);
create index sygsphere_messages_conversation_sequence on private.sygsphere_messages(conversation_id,sequence desc);
create index sygsphere_messages_parent on private.sygsphere_messages(parent_id,sequence);
create index sygsphere_messages_author_time on private.sygsphere_messages(author_id,created_at desc);
create index sygsphere_messages_search on private.sygsphere_messages using gin(to_tsvector('english',body)) where deleted_at is null;
create table private.sygsphere_reads (
  message_id uuid not null references private.sygsphere_messages(id), employee_id uuid not null references public.employees(id),
  read_at timestamptz not null default clock_timestamp(), primary key(message_id,employee_id)
);
create index sygsphere_reads_employee on private.sygsphere_reads(employee_id,message_id);
create table private.sygsphere_reactions (
  message_id uuid not null references private.sygsphere_messages(id), employee_id uuid not null references public.employees(id),
  emoji text not null check(emoji in ('👍','❤️','✅','🎉','👀','🙏')), primary key(message_id,employee_id,emoji)
);
create index sygsphere_reactions_employee on private.sygsphere_reactions(employee_id);
create table private.sygsphere_saved (
  message_id uuid not null references private.sygsphere_messages(id), employee_id uuid not null references public.employees(id),
  primary key(message_id,employee_id)
);
create index sygsphere_saved_employee on private.sygsphere_saved(employee_id,message_id);
create table private.sygsphere_revisions (
  id bigint generated always as identity primary key, message_id uuid not null references private.sygsphere_messages(id),
  actor_id uuid not null references public.employees(id), body text not null, action text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index sygsphere_revisions_message on private.sygsphere_revisions(message_id);
create index sygsphere_revisions_actor on private.sygsphere_revisions(actor_id);
create table private.sygsphere_activity (
  employee_id uuid primary key references public.employees(id), last_seen timestamptz not null default clock_timestamp(),
  availability text not null default 'available' check(availability in ('available','busy','away')), sound_enabled boolean not null default true
);

do $$ declare item text; begin
  foreach item in array array['gate','conversations','members','messages','reads','reactions','saved','revisions','activity'] loop
    execute format('alter table private.sygsphere_%I enable row level security',item);
    execute format('revoke all on private.sygsphere_%I from public, anon, authenticated',item);
  end loop;
end $$;

-- Signals are recipient-specific invalidations, not message content. No ticket/system producer is used.
create policy sygsphere_private_updates on realtime.messages for select to authenticated
using ((select realtime.topic())='sygsphere:'||(select auth.uid())::text and topic='sygsphere:'||(select auth.uid())::text);
create function private.sygsphere_signal(target_conversation uuid,target_employee uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare recipient record;
begin
  for recipient in select a.auth_user_id from private.employee_accounts a join public.employees e on e.id=a.employee_id
    where a.disabled_at is null and e.status='active' and (a.employee_id=target_employee or (target_employee is null and exists(
      select 1 from private.sygsphere_members m where m.conversation_id=target_conversation and m.employee_id=a.employee_id and m.removed_at is null)))
  loop perform realtime.send(jsonb_build_object('conversationId',target_conversation),'changed','sygsphere:'||recipient.auth_user_id::text,true); end loop;
exception when others then raise warning 'SygSphere signal deferred: %',sqlstate;
end $$;

create function private.sygsphere_message_json(target_message private.sygsphere_messages, actor uuid)
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
      select r.emoji,count(*) total,bool_or(r.employee_id=actor) mine from private.sygsphere_reactions r where r.message_id=target_message.id group by r.emoji)x),'[]'::jsonb))
  from public.employees e where e.id=target_message.author_id
$$;

create function private.sygsphere_request(action text, input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare
  actor uuid:=private.current_employee_id(); cid uuid:=nullif(input->>'conversationId','')::uuid;
  mid uuid:=nullif(input->>'messageId','')::uuid; target uuid; result jsonb; ids uuid[]; pair text; body_text text;
  conv private.sygsphere_conversations%rowtype; membership private.sygsphere_members%rowtype; msg private.sygsphere_messages%rowtype;
begin
  if actor is null then raise insufficient_privilege using message='An active SygShift account is required.'; end if;
  if not exists(select 1 from private.sygsphere_gate where enabled) then raise object_not_in_prerequisite_state using message='SygSphere is temporarily unavailable. Other SygShift features remain available.'; end if;
  if octet_length(input::text)>65000 then raise check_violation using message='This request is too large.'; end if;

  if action='directory' then
    select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) into result from (
      select e.id,concat(coalesce(nullif(e.preferred_name,''),e.first_name),' ',e.last_name) name,e.username,e.role,
        case when p.last_seen>clock_timestamp()-interval '75 seconds' then coalesce(p.availability,'available') else 'offline' end presence
      from public.employees e join private.employee_accounts a on a.employee_id=e.id
      left join private.sygsphere_activity p on p.employee_id=e.id
      where e.status='active' and a.disabled_at is null and (coalesce(input->>'query','')='' or concat(e.first_name,' ',e.last_name,' ',e.preferred_name,' ',e.username) ilike '%'||left(input->>'query',100)||'%')
      order by e.first_name,e.last_name,e.id limit 100)x;
    return result;
  elsif action='presence' then
    insert into private.sygsphere_activity(employee_id) values(actor) on conflict(employee_id) do update set last_seen=clock_timestamp();
    if input ? 'availability' then update private.sygsphere_activity set availability=input->>'availability' where employee_id=actor; end if;
    if input ? 'soundEnabled' then update private.sygsphere_activity set sound_enabled=(input->>'soundEnabled')::boolean where employee_id=actor; end if;
    return jsonb_build_object('ok',true);
  elsif action='list' then
    select coalesce(jsonb_agg(x.payload order by x.favorite desc,x.updated_at desc),'[]'::jsonb) into result from (
      select c.updated_at,m.favorite,jsonb_build_object('id',c.id,'kind',c.kind,'name',case when c.kind='direct' then coalesce((select concat(coalesce(nullif(e.preferred_name,''),e.first_name),' ',e.last_name)
        from private.sygsphere_members other join public.employees e on e.id=other.employee_id where other.conversation_id=c.id and other.employee_id<>actor limit 1),'Direct conversation') else c.name end,
        'description',c.description,'archived',c.archived,'owner',m.owner,'muted',m.muted,'favorite',m.favorite,'updatedAt',c.updated_at,
        'unread',(select count(*) from private.sygsphere_messages msg where msg.conversation_id=c.id and msg.author_id<>actor and msg.deleted_at is null
          and not exists(select 1 from private.sygsphere_reads r where r.message_id=msg.id and r.employee_id=actor)),
        'latest', (select jsonb_build_object('id',msg.id,'authorId',msg.author_id,'createdAt',msg.created_at,'parentId',msg.parent_id,'body',case when msg.deleted_at is null then left(msg.body,140) else 'Message deleted' end)
          from private.sygsphere_messages msg where msg.conversation_id=c.id order by msg.sequence desc limit 1)) payload
      from private.sygsphere_members m join private.sygsphere_conversations c on c.id=m.conversation_id
      where m.employee_id=actor and m.removed_at is null)x;
    return jsonb_build_object('conversations',result,'employeeId',actor,'soundEnabled',coalesce((select sound_enabled from private.sygsphere_activity where employee_id=actor),true));
  elsif action='create' then
    select array_agg(distinct x) into ids from (select actor x union select value::uuid from jsonb_array_elements_text(coalesce(input->'members','[]'::jsonb))) s;
    if cardinality(ids)<2 or cardinality(ids)>100 then raise check_violation using message='Choose between 1 and 99 other account holders.'; end if;
    if exists(select 1 from unnest(ids) x where not exists(select 1 from public.employees e join private.employee_accounts a on a.employee_id=e.id where e.id=x and e.status='active' and a.disabled_at is null)) then
      raise check_violation using message='Every participant must have an active account.'; end if;
    if input->>'kind'='direct' then
      if cardinality(ids)<>2 then raise check_violation using message='Direct messages require exactly two participants.'; end if;
      select string_agg(x::text,':' order by x::text) into pair from unnest(ids) x;
      perform pg_advisory_xact_lock(hashtextextended('sygsphere-direct:'||pair,0));
      select id into cid from private.sygsphere_conversations where direct_key=pair;
      if cid is not null then return jsonb_build_object('id',cid); end if;
    elsif input->>'kind' not in ('group','channel') or input->>'kind' is null or length(trim(coalesce(input->>'name','')))=0 then
      raise check_violation using message='Choose a conversation type and a name for groups or channels.';
    end if;
    if (select count(*) from private.sygsphere_conversations where created_by=actor and created_at>clock_timestamp()-interval '1 minute')>=10 then raise check_violation using message='Please wait a moment before creating more conversations.'; end if;
    insert into private.sygsphere_conversations(kind,name,description,direct_key,created_by)
      values(input->>'kind',trim(coalesce(input->>'name','')),trim(coalesce(input->>'description','')),pair,actor) returning id into cid;
    insert into private.sygsphere_members(conversation_id,employee_id,owner) select cid,x,x=actor from unnest(ids) x;
    perform private.sygsphere_signal(cid); return jsonb_build_object('id',cid);
  elsif action in ('search','saved') then
    select coalesce(jsonb_agg(x.payload order by x.sequence desc),'[]'::jsonb) into result from (
      select msg.sequence,private.sygsphere_message_json(msg,actor) payload from private.sygsphere_messages msg
      join private.sygsphere_members m on m.conversation_id=msg.conversation_id and m.employee_id=actor and m.removed_at is null
      where msg.deleted_at is null and (cid is null or msg.conversation_id=cid) and msg.sequence<coalesce((input->>'before')::bigint,9223372036854775807)
      and ((action='saved' and exists(select 1 from private.sygsphere_saved s where s.message_id=msg.id and s.employee_id=actor))
        or (action='search' and length(trim(coalesce(input->>'query','')))>=2 and to_tsvector('english',msg.body) @@ websearch_to_tsquery('english',left(input->>'query',200))))
      order by msg.sequence desc limit 50)x;
    return result;
  end if;

  select * into conv from private.sygsphere_conversations where id=cid;
  select * into membership from private.sygsphere_members where conversation_id=cid and employee_id=actor and removed_at is null;
  if membership.employee_id is null then raise insufficient_privilege using message='This conversation is not available to your account.'; end if;
  if action='conversation' then
    select jsonb_build_object('description',conv.description,'members',coalesce(jsonb_agg(jsonb_build_object('id',e.id,
      'name',concat(coalesce(nullif(e.preferred_name,''),e.first_name),' ',e.last_name),'owner',m.owner,'active',e.status='active' and a.disabled_at is null,
      'presence',case when p.last_seen>clock_timestamp()-interval '75 seconds' then coalesce(p.availability,'available') else 'offline' end,
      'typing',coalesce(m.typing_until>clock_timestamp(),false)) order by m.owner desc,e.first_name),'[]'::jsonb)) into result
      from private.sygsphere_members m join public.employees e on e.id=m.employee_id left join private.employee_accounts a on a.employee_id=e.id
      left join private.sygsphere_activity p on p.employee_id=e.id where m.conversation_id=cid and m.removed_at is null;
    return result;
  elsif action='messages' then
    target:=nullif(input->>'parentId','')::uuid;
    if target is not null and not exists(select 1 from private.sygsphere_messages where id=target and conversation_id=cid and parent_id is null) then raise check_violation using message='This thread is not available.'; end if;
    select coalesce(jsonb_agg(x.payload order by x.sequence),'[]'::jsonb) into result from (
      select msg.sequence,private.sygsphere_message_json(msg,actor) payload from private.sygsphere_messages msg
      where msg.conversation_id=cid and ((input->>'pinned')::boolean is true and msg.pinned or (coalesce((input->>'pinned')::boolean,false)=false and msg.parent_id is not distinct from target))
      and msg.sequence<coalesce((input->>'before')::bigint,9223372036854775807)
      order by msg.sequence desc limit 50)x;
    return result;
  elsif action='message' then
    select * into msg from private.sygsphere_messages where id=mid and conversation_id=cid;
    if not found then raise check_violation using message='This message is not available.'; end if;
    return private.sygsphere_message_json(msg,actor);
  elsif action='read' then
    if jsonb_array_length(coalesce(input->'messageIds','[]'::jsonb))>100 then raise check_violation using message='Read requests must be bounded.'; end if;
    insert into private.sygsphere_reads(message_id,employee_id)
      select msg.id,actor from private.sygsphere_messages msg where msg.conversation_id=cid and msg.id in(select value::uuid from jsonb_array_elements_text(input->'messageIds'))
      on conflict do nothing;
    perform private.sygsphere_signal(cid); return jsonb_build_object('ok',true);
  elsif action='settings' then
    update private.sygsphere_members set muted=coalesce((input->>'muted')::boolean,muted),favorite=coalesce((input->>'favorite')::boolean,favorite)
      where conversation_id=cid and employee_id=actor;
    perform private.sygsphere_signal(cid,actor); return jsonb_build_object('ok',true);
  elsif action='typing' then
    if membership.typing_until is null or membership.typing_until<clock_timestamp()+interval '4 seconds' or (input->>'typing')::boolean=false then
      update private.sygsphere_members set typing_until=case when (input->>'typing')::boolean then clock_timestamp()+interval '8 seconds' else null end where conversation_id=cid and employee_id=actor;
      perform private.sygsphere_signal(cid);
    end if;
    return jsonb_build_object('ok',true);
  end if;

  -- Serialize membership and message mutations per conversation. This also makes sequence/read ordering deterministic.
  perform 1 from private.sygsphere_conversations where id=cid for update;
  select * into conv from private.sygsphere_conversations where id=cid;
  select * into membership from private.sygsphere_members where conversation_id=cid and employee_id=actor and removed_at is null;
  if membership.employee_id is null then raise insufficient_privilege using message='You no longer have access to this conversation.'; end if;
  if action='members' then
    target:=(input->>'employeeId')::uuid;
    if conv.kind='direct' then raise check_violation using message='Start a new group to include more people.'; end if;
    if not membership.owner and not (target=actor and input->>'operation'='remove') then raise insufficient_privilege using message='Only conversation owners can manage members.'; end if;
    if input->>'operation'='add' then
      if not exists(select 1 from public.employees e join private.employee_accounts a on a.employee_id=e.id where e.id=target and e.status='active' and a.disabled_at is null) then raise check_violation using message='Choose an active account holder.'; end if;
      if (select count(*) from private.sygsphere_members where conversation_id=cid and removed_at is null)>=100 then raise check_violation using message='Conversations support up to 100 participants.'; end if;
      insert into private.sygsphere_members(conversation_id,employee_id) values(cid,target) on conflict(conversation_id,employee_id) do update set removed_at=null,owner=false,joined_at=clock_timestamp() where private.sygsphere_members.removed_at is not null;
    elsif input->>'operation'='remove' then
      if exists(select 1 from private.sygsphere_members where conversation_id=cid and employee_id=target and owner and removed_at is null)
        and (select count(*) from private.sygsphere_members where conversation_id=cid and owner and removed_at is null)<=1 then raise check_violation using message='Make another participant an owner before removing the last owner.'; end if;
      update private.sygsphere_members set removed_at=clock_timestamp(),typing_until=null where conversation_id=cid and employee_id=target;
      perform private.sygsphere_signal(cid,target);
    elsif input->>'operation'='owner' then
      update private.sygsphere_members set owner=true where conversation_id=cid and employee_id=target and removed_at is null;
    else raise check_violation using message='Choose a valid membership action.'; end if;
  elsif action='rename' then
    if not membership.owner or conv.kind='direct' then raise insufficient_privilege using message='Only group or channel owners can change these details.'; end if;
    if length(trim(coalesce(input->>'name','')))=0 then raise check_violation using message='Enter a conversation name.'; end if;
    update private.sygsphere_conversations set name=trim(input->>'name'),description=trim(coalesce(input->>'description','')) where id=cid;
  elsif action='archive' then
    if not membership.owner or conv.kind='direct' then raise insufficient_privilege using message='Only group or channel owners can archive conversations.'; end if;
    update private.sygsphere_conversations set archived=(input->>'archived')::boolean where id=cid;
  elsif action='send' then
    if conv.archived then raise check_violation using message='This conversation is archived and read-only.'; end if;
    select * into msg from private.sygsphere_messages where author_id=actor and client_id=(input->>'clientId')::uuid;
    if found then
      if msg.conversation_id<>cid or msg.body<>trim(coalesce(input->>'body','')) or msg.parent_id is distinct from nullif(input->>'parentId','')::uuid then raise check_violation using message='This send identifier was already used for a different message.'; end if;
      return private.sygsphere_message_json(msg,actor);
    end if;
    body_text:=trim(coalesce(input->>'body','')); target:=nullif(input->>'parentId','')::uuid;
    if length(body_text)=0 then raise check_violation using message='Write a message before sending.'; end if;
    if target is not null and not exists(select 1 from private.sygsphere_messages where id=target and conversation_id=cid and parent_id is null and deleted_at is null) then raise check_violation using message='Reply to an existing message in this conversation.'; end if;
    if (select count(*) from private.sygsphere_messages where author_id=actor and created_at>clock_timestamp()-interval '1 minute')>=60 then raise check_violation using message='Please wait a moment before sending more messages.'; end if;
    insert into private.sygsphere_messages(conversation_id,author_id,client_id,parent_id,body) values(cid,actor,(input->>'clientId')::uuid,target,body_text) returning * into msg;
    update private.sygsphere_members set typing_until=null where conversation_id=cid and employee_id=actor;
    update private.sygsphere_conversations set updated_at=clock_timestamp() where id=cid;
    perform private.sygsphere_signal(cid); return private.sygsphere_message_json(msg,actor);
  elsif action in ('edit','delete','react','save','pin') then
    select * into msg from private.sygsphere_messages where id=mid and conversation_id=cid for update;
    if not found or msg.deleted_at is not null then raise check_violation using message='This message is no longer available.'; end if;
    if action in ('edit','delete') then
      if msg.author_id<>actor then raise insufficient_privilege using message='You can only change your own messages.'; end if;
      if conv.archived then raise check_violation using message='This conversation is archived and read-only.'; end if;
      body_text:=trim(coalesce(input->>'body',''));
      if action='edit' and length(body_text)=0 then raise check_violation using message='Messages cannot be empty. Use Delete instead.'; end if;
      insert into private.sygsphere_revisions(message_id,actor_id,body,action) values(mid,actor,msg.body,action);
      update private.sygsphere_messages set body=case when action='edit' then body_text else body end,
        edited_at=case when action='edit' then clock_timestamp() else edited_at end,deleted_at=case when action='delete' then clock_timestamp() else deleted_at end where id=mid;
    elsif action='react' then
      if coalesce((input->>'enabled')::boolean,true) then insert into private.sygsphere_reactions values(mid,actor,input->>'emoji') on conflict do nothing;
      else delete from private.sygsphere_reactions where message_id=mid and employee_id=actor and emoji=input->>'emoji'; end if;
    elsif action='save' then
      if coalesce((input->>'enabled')::boolean,true) then insert into private.sygsphere_saved values(mid,actor) on conflict do nothing;
      else delete from private.sygsphere_saved where message_id=mid and employee_id=actor; end if;
    elsif action='pin' then update private.sygsphere_messages set pinned=(input->>'enabled')::boolean where id=mid;
    end if;
  else raise check_violation using message='Unknown SygSphere action.';
  end if;
  perform private.sygsphere_signal(cid); return jsonb_build_object('ok',true);
end $$;

create function public.sygsphere_request(action text,input jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path='' as $$ select private.sygsphere_request(action,input) $$;
revoke all on function private.sygsphere_signal(uuid,uuid),private.sygsphere_message_json(private.sygsphere_messages,uuid),private.sygsphere_request(text,jsonb) from public,anon,authenticated;
revoke all on function public.sygsphere_request(text,jsonb) from public,anon;
grant execute on function public.sygsphere_request(text,jsonb) to authenticated;

commit;

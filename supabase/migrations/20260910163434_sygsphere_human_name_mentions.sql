begin;
set local lock_timeout = '5s';

alter table private.sygsphere_mentions add column label text;
update private.sygsphere_mentions set label = username where label is null;
alter table private.sygsphere_mentions alter column label set not null;
alter table private.sygsphere_mentions add constraint sygsphere_mentions_label_length
  check (length(trim(label)) between 1 and 160);

-- Only active conversation members are eligible. Human names are accepted when
-- they resolve to exactly one member; the historical username token remains a
-- temporary compatibility alias for clients already open during deployment.
create function private.sygsphere_mention_aliases(target_conversation uuid, target_employee uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select employee.first_name,employee.preferred_name,employee.last_name,employee.username
    from private.sygsphere_members member
    join public.employees employee on employee.id=member.employee_id
    join private.employee_accounts account on account.employee_id=employee.id
    where member.conversation_id=target_conversation and member.employee_id=target_employee
      and member.removed_at is null and employee.status='active' and account.disabled_at is null
  ), raw_candidates(label,priority,legacy) as (
    select trim(target.first_name||' '||target.last_name),1,false from target
    union all select trim(coalesce(nullif(target.preferred_name,''),target.first_name)||' '||target.last_name),2,false from target
    union all select trim(target.first_name),3,false from target
    union all select trim(target.preferred_name),4,false from target where nullif(trim(target.preferred_name),'') is not null
    union all select target.username,100,true from target
  ), candidates as (
    select distinct on (lower(label)) label,priority,legacy
    from raw_candidates where nullif(trim(label),'') is not null
    order by lower(label),priority
  ), eligible as (
    select candidate.label,candidate.priority
    from candidates candidate
    where candidate.legacy or 1=(
      select count(distinct scoped_employee.id)
      from private.sygsphere_members scoped_member
      join public.employees scoped_employee on scoped_employee.id=scoped_member.employee_id
      join private.employee_accounts scoped_account on scoped_account.employee_id=scoped_employee.id
      cross join lateral unnest(array[
        trim(scoped_employee.first_name||' '||scoped_employee.last_name),
        trim(coalesce(nullif(scoped_employee.preferred_name,''),scoped_employee.first_name)||' '||scoped_employee.last_name),
        trim(scoped_employee.first_name),
        nullif(trim(scoped_employee.preferred_name),'')
      ]) scoped_alias(label)
      where scoped_member.conversation_id=target_conversation and scoped_member.removed_at is null
        and scoped_employee.status='active' and scoped_account.disabled_at is null
        and lower(scoped_alias.label)=lower(candidate.label)
    )
  )
  select coalesce(array_agg(label order by priority,length(label) desc),'{}'::text[]) from eligible
$$;

create function private.sygsphere_body_has_mention(target_body text,target_label text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(target_body,'')) ~ (
    '(^|[^[:alnum:]_])@'
    || regexp_replace(lower(target_label),'([\\.^$|()\\[\\]{}*+?])','\\\1','g')
    || '($|[^[:alnum:]_.-])'
  )
$$;

create or replace function private.sygsphere_apply_structured_mentions()
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
  selected_label text;
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
  select coalesce(array_agg(employee_id), '{}'::uuid[]) into previous
    from private.sygsphere_mentions where message_id=new.id;
  delete from private.sygsphere_mentions where message_id=new.id and employee_id <> all(requested);
  foreach recipient in array requested loop
    if not exists (
      select 1 from private.sygsphere_members member
      join public.employees employee on employee.id=member.employee_id
      join private.employee_accounts account on account.employee_id=employee.id
      where member.conversation_id=new.conversation_id and member.employee_id=recipient
        and member.removed_at is null and employee.status='active' and account.disabled_at is null
    ) then
      raise check_violation using message = 'Mentions must identify an active participant selected in this conversation.';
    end if;
    select mention.label into selected_label
      from private.sygsphere_mentions mention
      where mention.message_id=new.id and mention.employee_id=recipient
        and private.sygsphere_body_has_mention(new.body,mention.label);
    if selected_label is null then
      select alias.label into selected_label
      from unnest(private.sygsphere_mention_aliases(new.conversation_id,recipient)) with ordinality alias(label,position)
      where private.sygsphere_body_has_mention(new.body,alias.label)
      order by alias.position limit 1;
    end if;
    if selected_label is null then
      raise check_violation using message = 'Use a unique employee name from the SygSphere mention list.';
    end if;
    insert into private.sygsphere_mentions(message_id,employee_id,username,label)
      select new.id,recipient,employee.username,selected_label from public.employees employee where employee.id=recipient
      on conflict(message_id,employee_id) do update set label=excluded.label;
    if not (recipient = any(previous)) then perform private.sygsphere_signal(new.conversation_id,recipient); end if;
  end loop;
  return new;
end
$$;

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
      'id',mentioned.id,'name',concat(coalesce(nullif(mentioned.preferred_name,''),mentioned.first_name),' ',mentioned.last_name),
      'username',mention.username,'label',mention.label) order by mentioned.first_name,mentioned.last_name,mentioned.id)
      from private.sygsphere_mentions mention join public.employees mentioned on mentioned.id=mention.employee_id
      where mention.message_id=target_message.id),'[]'::jsonb) end)
  from public.employees e where e.id=target_message.author_id
$$;

create or replace function public.sygsphere_people(action text, input jsonb default '{}'::jsonb)
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
        employee.first_name "firstName",nullif(employee.preferred_name,'') "preferredName",concat(employee.first_name,' ',employee.last_name) "legalName",
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
      'firstName',employee.first_name,'preferredName',nullif(employee.preferred_name,''),'legalName',concat(employee.first_name,' ',employee.last_name),
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
      'firstName',employee.first_name,'preferredName',nullif(employee.preferred_name,''),'legalName',concat(employee.first_name,' ',employee.last_name),
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

revoke all on function private.sygsphere_mention_aliases(uuid,uuid),
  private.sygsphere_body_has_mention(text,text),private.sygsphere_apply_structured_mentions(),
  private.sygsphere_message_json(private.sygsphere_messages,uuid) from public,anon,authenticated;

do $$
begin
  if exists(select 1 from private.sygsphere_mentions where label is null or trim(label)='') then
    raise exception 'SygSphere mention label backfill failed.';
  end if;
  if has_function_privilege('authenticated','private.sygsphere_mention_aliases(uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','private.sygsphere_body_has_mention(text,text)','EXECUTE') then
    raise exception 'Private SygSphere mention helpers are exposed.';
  end if;
end
$$;

commit;

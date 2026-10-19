-- Forward recovery checkpoint for 20261019130405_sygsphere_message_acknowledgment.sql.
-- This disables the acknowledgment API contract without deleting acknowledgment
-- rows or audit history. Apply only after a confirmed production defect.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('private.sygsphere_acknowledge_message(uuid,jsonb)') is null
      or position(
        'sygsphere_acknowledgments'
        in pg_get_functiondef('private.sygsphere_message_json(private.sygsphere_messages,uuid)'::regprocedure)
      ) = 0 then
    raise exception 'The SygSphere acknowledgment release is not the active database contract.';
  end if;
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
    'readBy',case when target_message.author_id=actor then coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.employee_id,
      'name',concat(coalesce(nullif(reader.preferred_name,''),reader.first_name),' ',reader.last_name),
      'photoPath',reader.photo_path,
      'readAt',r.read_at
    ) order by r.read_at,reader.id)
      from private.sygsphere_reads r join public.employees reader on reader.id=r.employee_id where r.message_id=target_message.id and r.employee_id<>target_message.author_id),'[]'::jsonb) else '[]'::jsonb end,
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

revoke all on function private.sygsphere_message_json(private.sygsphere_messages,uuid) from public, anon, authenticated;

comment on function private.sygsphere_message_json(private.sygsphere_messages,uuid) is
  'Builds participant-authorized message JSON and returns reader identity/timestamps only to the message author.';

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
  enriched_conversations jsonb;
  latest_unread_target jsonb;
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

  if action = 'list' then
    select coalesce(jsonb_agg(
      conversation.payload || jsonb_build_object('latestUnreadTarget', (
        select jsonb_build_object(
          'conversationId', message.conversation_id,
          'messageId', message.id,
          'parentId', message.parent_id
        )
        from private.sygsphere_messages message
        where message.conversation_id = (conversation.payload->>'id')::uuid
          and message.author_id <> actor
          and message.deleted_at is null
          and not exists(
            select 1
            from private.sygsphere_reads receipt
            where receipt.message_id = message.id
              and receipt.employee_id = actor
          )
        order by message.sequence desc
        limit 1
      ))
      order by conversation.position
    ), '[]'::jsonb)
    into enriched_conversations
    from jsonb_array_elements(result->'conversations') with ordinality as conversation(payload, position);

    select jsonb_build_object(
      'conversationId', message.conversation_id,
      'messageId', message.id,
      'parentId', message.parent_id
    )
    into latest_unread_target
    from private.sygsphere_messages message
    join private.sygsphere_members membership
      on membership.conversation_id = message.conversation_id
      and membership.employee_id = actor
      and membership.removed_at is null
    where message.author_id <> actor
      and message.deleted_at is null
      and not exists(
        select 1
        from private.sygsphere_reads receipt
        where receipt.message_id = message.id
          and receipt.employee_id = actor
      )
    order by message.sequence desc
    limit 1;

    result := jsonb_set(result, '{conversations}', enriched_conversations, true)
      || jsonb_build_object('latestUnreadTarget', latest_unread_target);
  end if;

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

revoke all on function public.sygsphere_request(text,jsonb) from public, anon;
grant execute on function public.sygsphere_request(text,jsonb) to authenticated;

drop function private.sygsphere_acknowledge_message(uuid,jsonb);

comment on table private.sygsphere_acknowledgments is
  'Retained inactive acknowledgment evidence after recovery. Do not delete; later forward repair may reuse it.';

commit;

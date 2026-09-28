begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Additive response metadata lets every SygSphere client open the exact unread
-- item, including a thread reply that is absent from the root message page.
-- The private messaging implementation and all receipt history remain intact.
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

commit;

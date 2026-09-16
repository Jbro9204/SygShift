-- Reader identities and exact read timestamps are delivery evidence for the
-- message author. Keep ordinary participants' message payloads free of other
-- participants' reader-detail history.

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

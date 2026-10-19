begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Fail closed if either central SygSphere function differs from the reviewed
-- production baseline. This prevents an out-of-band repair from being silently
-- overwritten by this migration.
do $$
begin
  if md5(pg_get_functiondef('private.sygsphere_message_json(private.sygsphere_messages,uuid)'::regprocedure))
      is distinct from 'aea9db6d4c107fd46a8a6490a5a6830e' then
    raise exception 'SygSphere message JSON baseline changed; review the live function before release.';
  end if;
  if md5(pg_get_functiondef('public.sygsphere_request(text,jsonb)'::regprocedure))
      is distinct from '12bada3cec92d74c18a2cd4d60d95e02' then
    raise exception 'SygSphere request baseline changed; review the live function before release.';
  end if;
end
$$;

-- Acknowledgment is durable instruction evidence, not a visual reaction or a
-- read receipt. Keep it in a dedicated private relation so every historical
-- check-mark reaction retains its original meaning and remains removable.
create table private.sygsphere_acknowledgments (
  message_id uuid not null references private.sygsphere_messages(id),
  employee_id uuid not null references public.employees(id),
  acknowledged_at timestamptz not null default clock_timestamp(),
  primary key(message_id, employee_id)
);
create index sygsphere_acknowledgments_employee
  on private.sygsphere_acknowledgments(employee_id, message_id);
alter table private.sygsphere_acknowledgments enable row level security;
alter table private.sygsphere_acknowledgments force row level security;
revoke all on private.sygsphere_acknowledgments from public, anon, authenticated;

comment on table private.sygsphere_acknowledgments is
  'Insert-only participant acknowledgments for SygSphere group/channel instructions. Read receipts and reactions remain separate.';

create or replace function private.sygsphere_message_json(target_message private.sygsphere_messages, actor uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', target_message.id,
    'sequence', target_message.sequence,
    'conversationId', target_message.conversation_id,
    'authorId', target_message.author_id,
    'authorName', concat(coalesce(nullif(e.preferred_name,''),e.first_name),' ',e.last_name),
    'body', case when target_message.deleted_at is null then target_message.body else '' end,
    'parentId', target_message.parent_id,
    'createdAt', target_message.created_at,
    'editedAt', target_message.edited_at,
    'deleted', target_message.deleted_at is not null,
    'pinned', target_message.pinned,
    'saved', exists(
      select 1
      from private.sygsphere_saved saved
      where saved.message_id = target_message.id
        and saved.employee_id = actor
    ),
    'read', target_message.author_id = actor or exists(
      select 1
      from private.sygsphere_reads receipt
      where receipt.message_id = target_message.id
        and receipt.employee_id = actor
    ),
    'readBy', case when target_message.author_id = actor then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', receipt.employee_id,
        'name', concat(coalesce(nullif(reader.preferred_name,''),reader.first_name),' ',reader.last_name),
        'photoPath', reader.photo_path,
        'readAt', receipt.read_at
      ) order by receipt.read_at, reader.id)
      from private.sygsphere_reads receipt
      join public.employees reader on reader.id = receipt.employee_id
      where receipt.message_id = target_message.id
        and receipt.employee_id <> target_message.author_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'replyCount', (
      select count(*)
      from private.sygsphere_messages reply
      where reply.parent_id = target_message.id
    ),
    'unreadReplies', (
      select count(*)
      from private.sygsphere_messages reply
      where reply.parent_id = target_message.id
        and reply.author_id <> actor
        and reply.deleted_at is null
        and not exists(
          select 1
          from private.sygsphere_reads receipt
          where receipt.message_id = reply.id
            and receipt.employee_id = actor
        )
    ),
    'reactions', coalesce((
      select jsonb_agg(
        jsonb_build_object('emoji', reaction.emoji, 'count', reaction.total, 'mine', reaction.mine)
        order by reaction.emoji
      )
      from (
        select stored.emoji, count(*) total, bool_or(stored.employee_id = actor) mine
        from private.sygsphere_reactions stored
        where stored.message_id = target_message.id
        group by stored.emoji
      ) reaction
    ), '[]'::jsonb),
    'acknowledgment', jsonb_build_object(
      'mine', target_message.author_id <> actor and exists(
        select 1
        from private.sygsphere_acknowledgments acknowledgment
        where acknowledgment.message_id = target_message.id
          and acknowledgment.employee_id = actor
      ),
      'count', (
        select count(*)
        from private.sygsphere_acknowledgments acknowledgment
        where acknowledgment.message_id = target_message.id
          and acknowledgment.employee_id <> target_message.author_id
      ),
      'people', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', acknowledging_employee.id,
          'name', concat(coalesce(nullif(acknowledging_employee.preferred_name,''),acknowledging_employee.first_name),' ',acknowledging_employee.last_name),
          'photoPath', acknowledging_employee.photo_path
        ) order by acknowledging_employee.first_name, acknowledging_employee.last_name, acknowledging_employee.id)
        from private.sygsphere_acknowledgments acknowledgment
        join public.employees acknowledging_employee on acknowledging_employee.id = acknowledgment.employee_id
        where acknowledgment.message_id = target_message.id
          and acknowledgment.employee_id <> target_message.author_id
      ), '[]'::jsonb)
    ),
    'mentions', case when target_message.deleted_at is not null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mentioned.id,
        'name', concat(coalesce(nullif(mentioned.preferred_name,''),mentioned.first_name),' ',mentioned.last_name),
        'username', mention.username,
        'label', mention.label
      ) order by mentioned.first_name, mentioned.last_name, mentioned.id)
      from private.sygsphere_mentions mention
      join public.employees mentioned on mentioned.id = mention.employee_id
      where mention.message_id = target_message.id
    ), '[]'::jsonb) end
  )
  from public.employees e
  where e.id = target_message.author_id
$$;

revoke all on function private.sygsphere_message_json(private.sygsphere_messages,uuid) from public, anon, authenticated;

comment on function private.sygsphere_message_json(private.sygsphere_messages,uuid) is
  'Builds participant-authorized message JSON. Read identities remain author-only; explicit acknowledgment identities are available to active conversation participants.';

create or replace function private.sygsphere_acknowledge_message(actor uuid, input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  cid uuid := nullif(input->>'conversationId','')::uuid;
  mid uuid := nullif(input->>'messageId','')::uuid;
  conv private.sygsphere_conversations%rowtype;
  membership private.sygsphere_members%rowtype;
  message_record private.sygsphere_messages%rowtype;
  inserted_count integer := 0;
begin
  -- Reuse the canonical SygSphere gate, account/MFA checks, membership check,
  -- and message lookup before taking mutation locks.
  perform private.sygsphere_request('message', input);

  perform 1
  from private.sygsphere_conversations
  where id = cid
  for update;

  select * into conv
  from private.sygsphere_conversations
  where id = cid;

  select * into membership
  from private.sygsphere_members
  where conversation_id = cid
    and employee_id = actor
    and removed_at is null;

  if membership.employee_id is null then
    raise insufficient_privilege using message = 'You no longer have access to this conversation.';
  end if;

  select * into message_record
  from private.sygsphere_messages
  where id = mid
    and conversation_id = cid
  for update;

  if not found or message_record.deleted_at is not null then
    raise check_violation using message = 'This message is no longer available.';
  end if;
  if conv.kind not in ('group','channel') then
    raise check_violation using message = 'Acknowledgments are available in group conversations and channels.';
  end if;
  if message_record.author_id = actor then
    raise check_violation using message = 'You cannot acknowledge your own message.';
  end if;

  insert into private.sygsphere_acknowledgments(message_id, employee_id)
  values(mid, actor)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 1 then
    insert into private.audit_events(
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
    ) values (
      auth.uid(), actor, 'private', 'sygsphere_acknowledgments', 'ACKNOWLEDGE', mid::text,
      jsonb_build_object('conversationId', cid, 'messageId', mid)
    );
    perform private.sygsphere_signal(cid);
  end if;

  return private.sygsphere_message_json(message_record, actor);
end
$$;

revoke all on function private.sygsphere_acknowledge_message(uuid,jsonb) from public, anon, authenticated;

comment on function private.sygsphere_acknowledge_message(uuid,jsonb) is
  'Idempotently acknowledges a non-author message in a group or channel after the canonical SygSphere security and membership checks.';

-- Preserve the latest mention and unread-target wrapper while adding the
-- explicit acknowledgment command and the edit invalidation rule.
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
  cleared_acknowledgments integer := 0;
  edited_message_id uuid;
begin
  if action = 'acknowledge' then
    return private.sygsphere_acknowledge_message(actor, input);
  end if;

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
    if jsonb_typeof(input->'mentionIds') <> 'array' then
      raise check_violation using message='Mentions must be a list.';
    end if;
    perform set_config('private.sygsphere.mention_ids', (input->'mentionIds')::text, true);
  else
    perform set_config('private.sygsphere.mention_ids', '', true);
  end if;

  result := private.sygsphere_request(action,input);

  if action = 'edit' then
    edited_message_id := nullif(input->>'messageId','')::uuid;
    delete from private.sygsphere_acknowledgments
    where message_id = edited_message_id;
    get diagnostics cleared_acknowledgments = row_count;

    if cleared_acknowledgments > 0 then
      insert into private.audit_events(
        auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
      ) values (
        auth.uid(), actor, 'private', 'sygsphere_acknowledgments', 'CLEAR_ACKNOWLEDGMENTS_ON_EDIT', edited_message_id::text,
        jsonb_build_object('acknowledgmentCount', cleared_acknowledgments),
        jsonb_build_object('acknowledgmentCount', 0)
      );
    end if;

    -- The canonical edit action historically returned only {ok:true}. Return
    -- the freshly rebuilt message so every client that consumes the response
    -- observes the cleared acknowledgment state immediately.
    result := private.sygsphere_request('message', input);
  end if;

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
    if requested is distinct from persisted then
      raise check_violation using message='This retry does not match the original mentions.';
    end if;
  end if;
  return result;
end
$$;

revoke all on function public.sygsphere_request(text,jsonb) from public, anon;
grant execute on function public.sygsphere_request(text,jsonb) to authenticated;

commit;

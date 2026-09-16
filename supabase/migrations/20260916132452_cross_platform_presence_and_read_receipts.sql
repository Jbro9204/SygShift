begin;

create table if not exists private.platform_presence_sessions (
  auth_session_id uuid not null,
  client_instance_id uuid not null,
  application text not null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  state text not null,
  last_heartbeat_at timestamptz not null default clock_timestamp(),
  last_active_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (auth_session_id, client_instance_id, application),
  constraint platform_presence_application_check check (application in ('sygshift', 'sygilant')),
  constraint platform_presence_state_check check (state in ('active', 'away')),
  constraint platform_presence_expiry_check check (expires_at > last_heartbeat_at)
);

alter table private.platform_presence_sessions
drop constraint if exists platform_presence_sessions_auth_session_id_fkey;

create index if not exists platform_presence_employee_expiry_idx
on private.platform_presence_sessions(employee_id, expires_at desc);

create index if not exists platform_presence_employee_activity_idx
on private.platform_presence_sessions(employee_id, last_active_at desc);

alter table private.platform_presence_sessions enable row level security;
alter table private.platform_presence_sessions force row level security;
revoke all on private.platform_presence_sessions from public, anon, authenticated;

create or replace function private.platform_presence_for(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with account_state as (
    select
      employee.status = 'active' and account.disabled_at is null as enabled
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_employee_id
  ), current_sessions as (
    select session.application, session.state
    from private.platform_presence_sessions session
    where session.employee_id = target_employee_id
      and session.expires_at > clock_timestamp()
  ), history as (
    select max(session.last_active_at) as last_active_at, count(*) > 0 as has_history
    from private.platform_presence_sessions session
    where session.employee_id = target_employee_id
  )
  select jsonb_build_object(
    'status', case
      when not coalesce((select enabled from account_state), false) then 'offline'
      when exists(select 1 from current_sessions where state = 'active') then 'active'
      when exists(select 1 from current_sessions) then 'away'
      when coalesce((select has_history from history), false) then 'offline'
      else 'never_active'
    end,
    'lastActiveAt', (select last_active_at from history),
    'applications', coalesce((
      select jsonb_agg(source.application order by source.application)
      from (select distinct application from current_sessions) source
    ), '[]'::jsonb),
    'accountEnabled', coalesce((select enabled from account_state), false)
  )
$$;

create or replace function public.record_platform_presence(
  target_client_instance_id uuid,
  target_application text,
  target_state text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_auth_user_id uuid := auth.uid();
  actor_auth_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  heartbeat_at timestamptz := clock_timestamp();
begin
  if actor_id is null or actor_auth_user_id is null or actor_auth_session_id is null then
    raise insufficient_privilege using message = 'An active employee session is required.';
  end if;

  if target_client_instance_id is null then
    raise check_violation using message = 'A client instance is required.';
  end if;

  if target_application not in ('sygshift', 'sygilant') then
    raise check_violation using message = 'The application is invalid.';
  end if;

  if target_state not in ('active', 'away') then
    raise check_violation using message = 'The presence state is invalid.';
  end if;

  if not exists (
    select 1
    from auth.sessions session
    where session.id = actor_auth_session_id
      and session.user_id = actor_auth_user_id
      and (session.not_after is null or session.not_after > heartbeat_at)
  ) then
    raise insufficient_privilege using message = 'The authenticated session is no longer active.';
  end if;

  if target_application = 'sygilant' and not exists (
    select 1
    from public.sygilant_shared_identity_sessions shared_session
    where shared_session.employee_id = actor_id
      and shared_session.auth_user_id = actor_auth_user_id
      and shared_session.auth_session_id = actor_auth_session_id
      and shared_session.status = 'active'
      and shared_session.revoked_at is null
      and shared_session.session_expires_at > heartbeat_at
  ) then
    raise insufficient_privilege using message = 'An active Sygilant shared session is required.';
  end if;

  insert into private.platform_presence_sessions (
    auth_session_id,
    client_instance_id,
    application,
    employee_id,
    auth_user_id,
    state,
    last_heartbeat_at,
    last_active_at,
    expires_at
  ) values (
    actor_auth_session_id,
    target_client_instance_id,
    target_application,
    actor_id,
    actor_auth_user_id,
    target_state,
    heartbeat_at,
    heartbeat_at,
    heartbeat_at + interval '2 minutes'
  )
  on conflict (auth_session_id, client_instance_id, application) do update
  set employee_id = excluded.employee_id,
      auth_user_id = excluded.auth_user_id,
      state = excluded.state,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_active_at = case
        when excluded.state = 'active' then excluded.last_heartbeat_at
        else private.platform_presence_sessions.last_active_at
      end,
      expires_at = excluded.expires_at;

  delete from private.platform_presence_sessions session
  where session.employee_id = actor_id
    and session.expires_at < heartbeat_at - interval '30 days';

  return private.platform_presence_for(actor_id);
end
$$;

create or replace function public.get_platform_presence_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  records jsonb;
begin
  actor_id := private.require_any_user_admin_permission(
    array['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.separate', 'admin.users.delete'],
    false
  );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'employeeId', employee.id,
      'status', presence.payload->>'status',
      'lastActiveAt', presence.payload->'lastActiveAt',
      'applications', presence.payload->'applications',
      'accountEnabled', (presence.payload->>'accountEnabled')::boolean
    ) order by employee.last_name, employee.first_name, employee.id
  ), '[]'::jsonb)
  into records
  from public.employees employee
  cross join lateral (select private.platform_presence_for(employee.id) payload) presence;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'people', records
  );
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
    'readBy',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.employee_id,
      'name',concat(coalesce(nullif(reader.preferred_name,''),reader.first_name),' ',reader.last_name),
      'photoPath',reader.photo_path,
      'readAt',r.read_at
    ) order by r.read_at,reader.id)
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
        employee.username,employee.role,employee.photo_path "photoPath",presence.payload->>'status' presence,true active
      from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
      cross join lateral (select private.platform_presence_for(employee.id) payload) presence
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
      'active',employee.status='active' and account.disabled_at is null,'presence',presence.payload->>'status',
      'typing',coalesce(member.typing_until>clock_timestamp(),false)) order by member.owner desc,employee.first_name,employee.last_name),'[]'::jsonb))
      into result from private.sygsphere_conversations conversation
      join private.sygsphere_members member on member.conversation_id=conversation.id and member.removed_at is null
      join public.employees employee on employee.id=member.employee_id
      left join private.employee_accounts account on account.employee_id=employee.id
      cross join lateral (select private.platform_presence_for(employee.id) payload) presence
      where conversation.id=cid group by conversation.id,conversation.description;
    return result;
  elsif action='avatars' then
    select coalesce(jsonb_agg(jsonb_build_object('conversationId',conversation.id,'person',jsonb_build_object(
      'id',employee.id,'name',concat(coalesce(nullif(employee.preferred_name,''),employee.first_name),' ',employee.last_name),
      'firstName',employee.first_name,'preferredName',nullif(employee.preferred_name,''),'legalName',concat(employee.first_name,' ',employee.last_name),
      'username',employee.username,'role',employee.role,'photoPath',employee.photo_path,'presence',presence.payload->>'status','active',true))),'[]'::jsonb)
      into result from private.sygsphere_members mine
      join private.sygsphere_conversations conversation on conversation.id=mine.conversation_id and conversation.kind='direct'
      join private.sygsphere_members other_member on other_member.conversation_id=conversation.id and other_member.employee_id<>actor and other_member.removed_at is null
      join public.employees employee on employee.id=other_member.employee_id
      join private.employee_accounts account on account.employee_id=employee.id and account.disabled_at is null
      cross join lateral (select private.platform_presence_for(employee.id) payload) presence
      where mine.employee_id=actor and mine.removed_at is null and employee.status='active';
    return result;
  end if;
  raise check_violation using message='Unknown SygSphere people request.';
end
$$;

revoke all on function private.platform_presence_for(uuid) from public, anon, authenticated;
revoke all on function public.record_platform_presence(uuid,text,text) from public, anon;
revoke all on function public.get_platform_presence_directory() from public, anon;
revoke all on function private.sygsphere_message_json(private.sygsphere_messages,uuid) from public, anon, authenticated;
grant execute on function public.record_platform_presence(uuid,text,text) to authenticated;
grant execute on function public.get_platform_presence_directory() to authenticated;

do $$
begin
  if has_table_privilege('authenticated','private.platform_presence_sessions','select')
    or has_function_privilege('authenticated','private.platform_presence_for(uuid)','execute') then
    raise exception 'Private platform presence data is exposed.';
  end if;

  if not has_function_privilege('authenticated','public.record_platform_presence(uuid,text,text)','execute')
    or not has_function_privilege('authenticated','public.get_platform_presence_directory()','execute') then
    raise exception 'Platform presence RPC grants are incomplete.';
  end if;
end
$$;

commit;

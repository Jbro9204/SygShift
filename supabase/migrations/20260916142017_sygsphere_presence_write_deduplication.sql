-- SygSphere directory/avatar reads already receive presence from the shared
-- platform model. Preserve the existing account-security and feature-gate
-- checks without also writing the retired SygSphere activity heartbeat.

create or replace function private.sygsphere_require_read_access(input jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.current_employee_id();
  session_context jsonb;
begin
  if actor is null then
    raise insufficient_privilege using message = 'An active SygShift account is required.';
  end if;

  select to_jsonb(context)
  into session_context
  from public.get_session_context() context;

  if coalesce((session_context->>'must_change_password')::boolean, true)
    or (
      (session_context->>'mfa_required')::boolean
      and not (session_context->>'has_mfa')::boolean
    ) then
    raise insufficient_privilege using message = 'Complete your SygShift account security verification before opening messages.';
  end if;

  if not exists (select 1 from private.sygsphere_gate where enabled) then
    raise object_not_in_prerequisite_state using message = 'SygSphere is temporarily unavailable. Other SygShift features remain available.';
  end if;

  if octet_length(input::text) > 65000 then
    raise check_violation using message = 'This request is too large.';
  end if;

  return actor;
end
$$;

create or replace function public.sygsphere_people(action text, input jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.sygsphere_require_read_access(input);
  cid uuid := nullif(input->>'conversationId','')::uuid;
  result jsonb;
begin
  if action='conversation' then
    perform private.sygsphere_request('conversation',jsonb_build_object('conversationId',cid));
  end if;

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

revoke all on function private.sygsphere_require_read_access(jsonb) from public, anon, authenticated;
revoke all on function public.sygsphere_people(text,jsonb) from public, anon;
grant execute on function public.sygsphere_people(text,jsonb) to authenticated;

comment on function public.sygsphere_people(text,jsonb) is
  'Returns participant-protected SygSphere people data using shared presence without generating a legacy activity heartbeat write.';

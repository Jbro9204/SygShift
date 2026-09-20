begin;
set local lock_timeout = '5s';

-- Advance the database-owned release record with the shared protocol. The
-- previous operational record was draft 4; draft 6 adds the PTT listener
-- readiness and meeting media lifecycle that the Worker now enforces.
alter table private.sygsphere_communications_release_gate
  drop constraint if exists sygsphere_communications_release_gate_version;
alter table private.sygsphere_communications_release_gate
  add constraint sygsphere_communications_release_gate_version
  check (contract_version in ('1.0.0-draft.2', '1.0.0-draft.3', '1.0.0-draft.4', '1.0.0-draft.6'));

update private.sygsphere_communications_release_gate
set contract_version = '1.0.0-draft.6', updated_at = clock_timestamp()
where singleton
  and database_foundation_applied
  and command_schemas_verified
  and provider_physical_device_evidence_complete
  and coordinator_deployment_approved
  and shared_compatibility_verified
  and runtime_enabled;

do $$
begin
  if not exists (
    select 1
    from private.sygsphere_communications_release_gate
    where singleton and contract_version = '1.0.0-draft.6'
  ) then
    raise exception using
      errcode = 'object_not_in_prerequisite_state',
      message = 'The operational communications gate must be complete before activating protocol draft 6.';
  end if;
end
$$;

-- PTT is limited to an existing SygSphere channel.  This resolver expands
-- active channel membership on the server and returns a bounded recipient set;
-- the Worker never accepts a browser-supplied listener list.
create or replace function private.sygsphere_communications_required_permission(target_command_kind text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case target_command_kind
    when 'floor.request' then 'sygsphere.comms.ptt.transmit'
    when 'floor.cancel' then 'sygsphere.comms.ptt.transmit'
    when 'floor.renew' then 'sygsphere.comms.ptt.transmit'
    when 'floor.release' then 'sygsphere.comms.ptt.transmit'
    when 'ptt.listen' then 'sygsphere.comms.ptt.listen'
    when 'call.request' then 'sygsphere.comms.call.start'
    when 'call.accept' then 'sygsphere.comms.call.receive'
    when 'call.decline' then 'sygsphere.comms.call.receive'
    when 'call.cancel' then 'sygsphere.comms.call.start'
    when 'meeting.create' then 'sygsphere.comms.meeting.create'
    when 'meeting.end' then 'sygsphere.comms.moderate'
    when 'participant.remove' then 'sygsphere.comms.moderate'
    when 'participant.mute' then 'sygsphere.comms.moderate'
    when 'camera.request' then 'sygsphere.comms.video.publish'
    when 'screen.request' then 'sygsphere.comms.screen.publish'
    when 'auth' then 'sygsphere.comms.use'
    when 'heartbeat' then 'sygsphere.comms.use'
    when 'resume' then 'sygsphere.comms.use'
    when 'snapshot.request' then 'sygsphere.comms.use'
    when 'call.end' then 'sygsphere.comms.use'
    when 'meeting.join' then 'sygsphere.comms.use'
    when 'meeting.leave' then 'sygsphere.comms.use'
    when 'media.answer' then 'sygsphere.comms.use'
    when 'media.ready' then 'sygsphere.comms.use'
    when 'media.layout' then 'sygsphere.comms.use'
    when 'media.stop' then 'sygsphere.comms.use'
    when 'camera.release' then 'sygsphere.comms.use'
    when 'screen.release' then 'sygsphere.comms.use'
    when 'focus.request' then 'sygsphere.comms.use'
    when 'focus.release' then 'sygsphere.comms.use'
    else null
  end
$$;

create or replace function public.service_resolve_sygsphere_communications_command_scope(
  target_auth_user_id uuid,
  target_command_kind text,
  target_conversation_reference uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  context_value jsonb;
  gate_record private.sygsphere_communications_release_gate%rowtype;
  required_permission text;
  permission_granted boolean;
  actor_employee_id uuid;
  recipient_employee_id uuid;
  active_member_count integer;
  participant_employee_ids uuid[];
  conversation_is_direct boolean := false;
  conversation_is_channel boolean := false;
  scope_value jsonb := null;
  scope_verified boolean := false;
begin
  if target_auth_user_id is null then
    raise check_violation using message = 'A communications subject is required.';
  end if;

  context_value := public.service_get_sygsphere_communications_context(target_auth_user_id);
  required_permission := private.sygsphere_communications_required_permission(target_command_kind);
  if required_permission is null then
    raise check_violation using message = 'The communications command is not recognized.';
  end if;

  select * into gate_record from private.sygsphere_communications_release_gate where singleton;
  if not found then
    raise insufficient_privilege using message = 'The communications release gate is unavailable.';
  end if;

  permission_granted := required_permission = any (
    array(select jsonb_array_elements_text(coalesce(context_value -> 'permissions', '[]'::jsonb)))
  );
  actor_employee_id := (context_value ->> 'employeeId')::uuid;

  if target_command_kind in (
    'auth', 'heartbeat', 'resume', 'snapshot.request', 'ptt.listen',
    'floor.cancel', 'floor.renew', 'floor.release',
    'call.accept', 'call.decline', 'call.cancel', 'call.end',
    'meeting.join', 'meeting.leave', 'meeting.end',
    'participant.remove', 'participant.mute',
    'media.answer', 'media.layout', 'media.stop',
    'camera.request', 'camera.release', 'screen.request', 'screen.release',
    'focus.request', 'focus.release'
  ) then
    scope_verified := true;
  elsif target_command_kind in ('floor.request', 'meeting.create') and target_conversation_reference is not null then
    select
      conversation.kind = 'channel',
      count(member.employee_id)::integer,
      array_agg(member.employee_id order by member.employee_id)
    into conversation_is_channel, active_member_count, participant_employee_ids
    from private.sygsphere_conversations conversation
    join private.sygsphere_members member
      on member.conversation_id = conversation.id and member.removed_at is null
    join public.employees member_employee
      on member_employee.id = member.employee_id and member_employee.status = 'active'
    where conversation.id = target_conversation_reference and conversation.archived = false
    group by conversation.id, conversation.kind;

    if conversation_is_channel and active_member_count between 1 and 50
      and actor_employee_id = any(coalesce(participant_employee_ids, '{}'::uuid[])) then
      scope_verified := true;
      scope_value := jsonb_build_object(
        'kind', 'channel_conversation',
        'channelReference', target_conversation_reference,
        'participantEmployeeIds', to_jsonb(participant_employee_ids),
        'scope', 'dispatch'
      );
    end if;
  elsif target_command_kind in ('call.request', 'media.ready') and target_conversation_reference is not null then
    select conversation.kind = 'direct', count(member.employee_id)::integer
      into conversation_is_direct, active_member_count
    from private.sygsphere_conversations conversation
    join private.sygsphere_members member
      on member.conversation_id = conversation.id and member.removed_at is null
    join public.employees member_employee
      on member_employee.id = member.employee_id and member_employee.status = 'active'
    where conversation.id = target_conversation_reference and conversation.archived = false
    group by conversation.id, conversation.kind;

    select member.employee_id into recipient_employee_id
    from private.sygsphere_members member
    join public.employees member_employee
      on member_employee.id = member.employee_id and member_employee.status = 'active'
    where member.conversation_id = target_conversation_reference
      and member.removed_at is null and member.employee_id <> actor_employee_id
    limit 1;

    if conversation_is_direct and active_member_count = 2 and recipient_employee_id is not null
      and exists (
        select 1 from private.sygsphere_members actor_member
        where actor_member.conversation_id = target_conversation_reference
          and actor_member.employee_id = actor_employee_id and actor_member.removed_at is null
      ) then
      scope_verified := true;
      scope_value := jsonb_build_object(
        'kind', 'direct_conversation',
        'conversationReference', target_conversation_reference,
        'recipientEmployeeId', recipient_employee_id
      );
    end if;
  end if;

  return jsonb_build_object(
    'context', context_value,
    'requiredPermission', required_permission,
    'permissionGranted', permission_granted,
    'scopeMembershipVerified', scope_verified,
    'scope', scope_value,
    'release', jsonb_build_object(
      'databaseFoundationApplied', gate_record.database_foundation_applied,
      'commandSchemasVerified', gate_record.command_schemas_verified,
      'providerPhysicalDeviceEvidenceComplete', gate_record.provider_physical_device_evidence_complete,
      'coordinatorDeploymentApproved', gate_record.coordinator_deployment_approved,
      'sharedCompatibilityVerified', gate_record.shared_compatibility_verified,
      'runtimeEnabled', gate_record.runtime_enabled
    ),
    'authorized', permission_granted and scope_verified
  );
end
$$;

revoke all on function private.sygsphere_communications_required_permission(text) from public, anon, authenticated;
grant execute on function private.sygsphere_communications_required_permission(text) to service_role;
revoke all on function public.service_resolve_sygsphere_communications_command_scope(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.service_resolve_sygsphere_communications_command_scope(uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;

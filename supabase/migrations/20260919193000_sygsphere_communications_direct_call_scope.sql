begin;
set local lock_timeout = '5s';

-- Direct calls use the existing SygSphere direct-conversation membership as
-- their only employee-facing scope. The browser can request a conversation
-- reference, but it can never select a recipient, tenant, or permission.
-- Those values are resolved here under the service role from active records.
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
  conversation_is_direct boolean := false;
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

  select *
  into gate_record
  from private.sygsphere_communications_release_gate
  where singleton;
  if not found then
    raise insufficient_privilege using message = 'The communications release gate is unavailable.';
  end if;

  permission_granted := required_permission = any (
    array(select jsonb_array_elements_text(coalesce(context_value -> 'permissions', '[]'::jsonb)))
  );
  actor_employee_id := (context_value ->> 'employeeId')::uuid;

  -- Commands that name no target are only authorization-context refreshes.
  -- State-specific authority (for example accepting an invitation) is checked
  -- again inside the tenant coordinator against the server-created call.
  if target_command_kind in (
    'auth', 'heartbeat', 'resume', 'snapshot.request',
    'call.accept', 'call.decline', 'call.cancel', 'call.end',
    'meeting.join', 'meeting.leave', 'meeting.end',
    'participant.remove', 'participant.mute',
    'media.answer', 'media.ready', 'media.layout', 'media.stop',
    'camera.request', 'camera.release', 'screen.request', 'screen.release',
    'focus.request', 'focus.release'
  ) then
    scope_verified := true;
  elsif target_command_kind in ('call.request', 'meeting.create') then
    if target_conversation_reference is not null then
      select conversation.kind = 'direct', count(member.employee_id)::integer
      into conversation_is_direct, active_member_count
      from private.sygsphere_conversations conversation
      join private.sygsphere_members member
        on member.conversation_id = conversation.id
        and member.removed_at is null
      join public.employees member_employee
        on member_employee.id = member.employee_id
        and member_employee.status = 'active'
      where conversation.id = target_conversation_reference
        and conversation.archived = false
      group by conversation.id, conversation.kind;

      select member.employee_id
      into recipient_employee_id
      from private.sygsphere_members member
      join public.employees member_employee
        on member_employee.id = member.employee_id
        and member_employee.status = 'active'
      where member.conversation_id = target_conversation_reference
        and member.removed_at is null
        and member.employee_id <> actor_employee_id
      limit 1;

      if conversation_is_direct and active_member_count = 2 and recipient_employee_id is not null
        and exists (
          select 1
          from private.sygsphere_members actor_member
          where actor_member.conversation_id = target_conversation_reference
            and actor_member.employee_id = actor_employee_id
            and actor_member.removed_at is null
        ) then
        scope_verified := true;
        scope_value := jsonb_build_object(
          'kind', 'direct_conversation',
          'conversationReference', target_conversation_reference,
          'recipientEmployeeId', recipient_employee_id
        );
      end if;
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

revoke all on function public.service_resolve_sygsphere_communications_command_scope(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.service_resolve_sygsphere_communications_command_scope(uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;

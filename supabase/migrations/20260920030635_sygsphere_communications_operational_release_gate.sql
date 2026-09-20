begin;
set local lock_timeout = '5s';

-- The original foundation intentionally returned a closed decision for every
-- bootstrap request.  Direct-audio activation uses the later, scoped resolver
-- for both bootstrap and commands, so the caller's active role and tenant are
-- verified from server-owned records before a ticket can be minted.
create or replace function public.service_authorize_sygsphere_communications_command(
  target_auth_user_id uuid,
  target_command_kind text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.service_resolve_sygsphere_communications_command_scope(
    target_auth_user_id,
    target_command_kind,
    null
  )
$$;

revoke all on function public.service_authorize_sygsphere_communications_command(uuid, text) from public, anon, authenticated;
grant execute on function public.service_authorize_sygsphere_communications_command(uuid, text) to service_role;

-- Controlled operational release: this enables only the already-deployed
-- direct-audio call surface.  PTT, video, meetings, and screen sharing remain
-- unavailable until their own complete, separately tested releases exist.
update private.sygsphere_communications_release_gate
set
  contract_version = '1.0.0-draft.4',
  database_foundation_applied = true,
  command_schemas_verified = true,
  provider_physical_device_evidence_complete = true,
  coordinator_deployment_approved = true,
  shared_compatibility_verified = true,
  runtime_enabled = true,
  updated_at = clock_timestamp()
where singleton;

do $$
begin
  if not exists (
    select 1
    from private.sygsphere_communications_release_gate gate
    where gate.singleton
      and gate.contract_version = '1.0.0-draft.4'
      and gate.database_foundation_applied
      and gate.command_schemas_verified
      and gate.provider_physical_device_evidence_complete
      and gate.coordinator_deployment_approved
      and gate.shared_compatibility_verified
      and gate.runtime_enabled
  ) then
    raise exception 'SygSphere Communications operational release gate did not activate.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;

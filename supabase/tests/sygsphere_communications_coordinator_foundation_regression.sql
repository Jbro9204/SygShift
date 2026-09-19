begin;

do $$
declare
  baseline_tenant_count integer;
  baseline_catalog_count integer;
  baseline_role_grant_count integer;
  baseline_override_count integer;
begin
  select count(*) into baseline_tenant_count from private.sygsphere_tenants where active;
  select count(*) into baseline_catalog_count from public.permission_catalog where code like 'sygsphere.comms.%' and active;
  select count(*) into baseline_role_grant_count
  from public.access_role_permissions role_permission
  join public.permission_catalog catalog on catalog.id = role_permission.permission_id
  where catalog.code like 'sygsphere.comms.%';
  select count(*) into baseline_override_count
  from public.employee_permission_overrides override_record
  join public.permission_catalog catalog on catalog.id = override_record.permission_id
  where catalog.code like 'sygsphere.comms.%';

  if baseline_tenant_count <> 1 then
    raise exception 'Expected exactly one active SygSphere tenant, found %.', baseline_tenant_count;
  end if;
  if baseline_catalog_count <> 14 then
    raise exception 'Expected 14 active communications catalog entries, found %.', baseline_catalog_count;
  end if;
  if baseline_role_grant_count <> 0 or baseline_override_count <> 0 then
    raise exception 'Communications permissions must remain unassigned.';
  end if;
end
$$;

do $$
declare
  relation_name text;
  relation_rls boolean;
  relation_force_rls boolean;
  release_gate private.sygsphere_communications_release_gate%rowtype;
  usage_column_count integer;
begin
  foreach relation_name in array array[
    'sygsphere_communications_release_gate',
    'sygsphere_communications_provider_registry',
    'sygsphere_communications_command_ledger',
    'sygsphere_communications_history_events',
    'sygsphere_communications_audit_events',
    'sygsphere_communications_usage_daily'
  ] loop
    select relrowsecurity, relforcerowsecurity
    into relation_rls, relation_force_rls
    from pg_class
    where oid = format('private.%I', relation_name)::regclass;

    if not relation_rls or not relation_force_rls then
      raise exception 'RLS must be enabled and forced for private.%', relation_name;
    end if;
  end loop;

  select * into release_gate from private.sygsphere_communications_release_gate where singleton;
  if not found then
    raise exception 'Closed communications release gate is missing.';
  end if;
  if release_gate.contract_version <> '1.0.0-draft.2'
    or not release_gate.database_foundation_applied
    or release_gate.command_schemas_verified
    or release_gate.provider_physical_device_evidence_complete
    or release_gate.coordinator_deployment_approved
    or release_gate.shared_compatibility_verified
    or release_gate.runtime_enabled then
    raise exception 'Communications release gate is not in its required closed state.';
  end if;

  select count(*) into usage_column_count
  from information_schema.columns
  where table_schema = 'private'
    and table_name = 'sygsphere_communications_usage_daily'
    and column_name in (
      'feature_key',
      'estimated_received_bytes',
      'telemetry_status',
      'estimate_version',
      'reconciliation_metadata'
    );
  if usage_column_count <> 5 then
    raise exception 'Usage foundation must retain feature, estimate, telemetry, and reconciliation columns.';
  end if;
end
$$;

do $$
begin
  if exists (select 1 from private.sygsphere_communications_provider_registry where enabled) then
    raise exception 'Provider registry must remain disabled.';
  end if;
  if (select count(*) from private.sygsphere_communications_command_ledger) <> 0
    or (select count(*) from private.sygsphere_communications_history_events) <> 0
    or (select count(*) from private.sygsphere_communications_audit_events) <> 0
    or (select count(*) from private.sygsphere_communications_usage_daily) <> 0 then
    raise exception 'Coordinator records must be empty before a controlled release.';
  end if;
end
$$;

do $$
declare
  function_acl aclitem[];
  function_search_path text;
  retention_acl aclitem[];
begin
  select proacl, array_to_string(proconfig, ',')
  into function_acl, function_search_path
  from pg_proc
  where oid = 'public.service_authorize_sygsphere_communications_command(uuid, text)'::regprocedure;

  if coalesce(array_to_string(function_acl, ','), '') !~ 'service_role=X' then
    raise exception 'Service command authorization must be executable by service_role.';
  end if;
  if coalesce(array_to_string(function_acl, ','), '') ~ '(anon|authenticated)=X' then
    raise exception 'Browser roles must not execute service command authorization.';
  end if;
  if function_search_path not like '%search_path=%' then
    raise exception 'Service command authorization must pin search_path.';
  end if;

  select proacl into retention_acl
  from pg_proc
  where oid = 'private.purge_sygsphere_communications_command_ledger(timestamptz, integer)'::regprocedure;
  if coalesce(array_to_string(retention_acl, ','), '') !~ 'service_role=X'
    or coalesce(array_to_string(retention_acl, ','), '') ~ '(anon|authenticated)=X' then
    raise exception 'Command-ledger retention must be service-only.';
  end if;
end
$$;

rollback;

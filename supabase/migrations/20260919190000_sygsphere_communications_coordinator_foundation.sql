begin;
set local lock_timeout = '5s';

-- Stage 1/2 records the SygShift-owned, server-only coordinator foundation.
-- It is deliberately additive and closed: no employee is granted a
-- communications permission, no media/provider credential is stored here,
-- and no browser-facing RPC is created by this migration.
create table if not exists private.sygsphere_communications_release_gate (
  singleton boolean primary key default true,
  contract_version text not null default '1.0.0-draft.2',
  database_foundation_applied boolean not null default true,
  command_schemas_verified boolean not null default false,
  provider_physical_device_evidence_complete boolean not null default false,
  coordinator_deployment_approved boolean not null default false,
  shared_compatibility_verified boolean not null default false,
  runtime_enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygsphere_communications_release_gate_singleton check (singleton),
  constraint sygsphere_communications_release_gate_version check (contract_version = '1.0.0-draft.2'),
  constraint sygsphere_communications_release_gate_closed_until_evidence check (
    not runtime_enabled or (
      database_foundation_applied
      and command_schemas_verified
      and provider_physical_device_evidence_complete
      and coordinator_deployment_approved
      and shared_compatibility_verified
    )
  )
);

insert into private.sygsphere_communications_release_gate (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists private.sygsphere_communications_provider_registry (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique,
  provider_family text not null,
  enabled boolean not null default false,
  configuration_version text not null default 'unconfigured',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sygsphere_communications_provider_registry_family check (provider_family = 'cloudflare-realtime'),
  constraint sygsphere_communications_provider_registry_no_enabled_provider check (not enabled)
);

-- This is a reviewable registry marker only. Provider credentials, endpoint
-- details, and session material belong in future protected bindings, never in
-- database rows or browser payloads.
insert into private.sygsphere_communications_provider_registry (provider_key, provider_family)
values ('cloudflare-realtime', 'cloudflare-realtime')
on conflict (provider_key) do nothing;

create table if not exists private.sygsphere_communications_command_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references private.sygsphere_tenants(id),
  actor_employee_id uuid not null references public.employees(id),
  command_id uuid not null,
  command_kind text not null,
  request_digest text not null,
  outcome text not null,
  response_metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint sygsphere_communications_command_ledger_kind check (command_kind in (
    'auth', 'heartbeat', 'resume', 'snapshot.request',
    'floor.request', 'floor.cancel', 'floor.renew', 'floor.release',
    'call.accept', 'call.decline', 'call.cancel', 'call.end',
    'media.answer', 'media.ready', 'media.layout', 'media.stop',
    'screen.request', 'screen.release', 'focus.request', 'focus.release'
  )),
  constraint sygsphere_communications_command_ledger_digest check (request_digest ~ '^[a-f0-9]{64}$'),
  constraint sygsphere_communications_command_ledger_metadata_object check (jsonb_typeof(response_metadata) = 'object'),
  constraint sygsphere_communications_command_ledger_expiry check (expires_at > recorded_at),
  constraint sygsphere_communications_command_ledger_idempotent unique (tenant_id, actor_employee_id, command_id)
);

create index if not exists sygsphere_communications_command_ledger_expiry_idx
  on private.sygsphere_communications_command_ledger (expires_at);

create table if not exists private.sygsphere_communications_history_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references private.sygsphere_tenants(id),
  actor_employee_id uuid references public.employees(id),
  event_kind text not null,
  room_reference text,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint sygsphere_communications_history_events_kind check (event_kind ~ '^[a-z][a-z0-9._-]{1,96}$'),
  constraint sygsphere_communications_history_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists sygsphere_communications_history_events_tenant_occurred_idx
  on private.sygsphere_communications_history_events (tenant_id, occurred_at desc);

create table if not exists private.sygsphere_communications_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references private.sygsphere_tenants(id),
  actor_employee_id uuid references public.employees(id),
  action text not null,
  request_id uuid,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint sygsphere_communications_audit_events_action check (action ~ '^[a-z][a-z0-9._-]{1,96}$'),
  constraint sygsphere_communications_audit_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists sygsphere_communications_audit_events_tenant_occurred_idx
  on private.sygsphere_communications_audit_events (tenant_id, occurred_at desc);

create table if not exists private.sygsphere_communications_usage_daily (
  tenant_id uuid not null references private.sygsphere_tenants(id),
  employee_id uuid not null references public.employees(id),
  usage_date date not null,
  feature_key text not null,
  command_count integer not null default 0,
  rejected_command_count integer not null default 0,
  provider_session_count integer not null default 0,
  estimated_received_bytes bigint not null default 0,
  telemetry_status text not null default 'unavailable',
  estimate_version text not null default 'unconfigured',
  reconciliation_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, employee_id, usage_date, feature_key),
  constraint sygsphere_communications_usage_daily_feature check (feature_key in (
    'ptt', 'direct-call', 'video', 'meeting', 'screen-share'
  )),
  constraint sygsphere_communications_usage_daily_counts_nonnegative check (
    command_count >= 0
    and rejected_command_count >= 0
    and provider_session_count >= 0
    and estimated_received_bytes >= 0
  ),
  constraint sygsphere_communications_usage_daily_telemetry_status check (
    telemetry_status in ('unavailable', 'estimated', 'reconciled')
  ),
  constraint sygsphere_communications_usage_daily_reconciliation_metadata_object check (
    jsonb_typeof(reconciliation_metadata) = 'object'
  )
);

alter table private.sygsphere_communications_release_gate enable row level security;
alter table private.sygsphere_communications_release_gate force row level security;
alter table private.sygsphere_communications_provider_registry enable row level security;
alter table private.sygsphere_communications_provider_registry force row level security;
alter table private.sygsphere_communications_command_ledger enable row level security;
alter table private.sygsphere_communications_command_ledger force row level security;
alter table private.sygsphere_communications_history_events enable row level security;
alter table private.sygsphere_communications_history_events force row level security;
alter table private.sygsphere_communications_audit_events enable row level security;
alter table private.sygsphere_communications_audit_events force row level security;
alter table private.sygsphere_communications_usage_daily enable row level security;
alter table private.sygsphere_communications_usage_daily force row level security;

revoke all on table private.sygsphere_communications_release_gate from public, anon, authenticated;
revoke all on table private.sygsphere_communications_provider_registry from public, anon, authenticated;
revoke all on table private.sygsphere_communications_command_ledger from public, anon, authenticated;
revoke all on table private.sygsphere_communications_history_events from public, anon, authenticated;
revoke all on table private.sygsphere_communications_audit_events from public, anon, authenticated;
revoke all on table private.sygsphere_communications_usage_daily from public, anon, authenticated;

create or replace function private.prevent_sygsphere_communications_command_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('app.sygsphere_command_ledger_purge', true) = 'approved' then
    return old;
  end if;

  raise exception '% is append-only except for the service retention procedure.', tg_table_name;
end
$$;

create trigger sygsphere_communications_command_ledger_append_only
before update or delete on private.sygsphere_communications_command_ledger
for each row execute function private.prevent_sygsphere_communications_command_ledger_mutation();

create trigger sygsphere_communications_history_events_append_only
before update or delete on private.sygsphere_communications_history_events
for each row execute function private.prevent_append_only_change();

create trigger sygsphere_communications_audit_events_append_only
before update or delete on private.sygsphere_communications_audit_events
for each row execute function private.prevent_append_only_change();

create trigger sygsphere_communications_release_gate_audit
after insert or update or delete on private.sygsphere_communications_release_gate
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_provider_registry_audit
after insert or update or delete on private.sygsphere_communications_provider_registry
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_command_ledger_audit
after insert or delete on private.sygsphere_communications_command_ledger
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_history_events_audit
after insert on private.sygsphere_communications_history_events
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_audit_events_audit
after insert on private.sygsphere_communications_audit_events
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_usage_daily_audit
after insert or update or delete on private.sygsphere_communications_usage_daily
for each row execute function private.write_audit_event();

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
    when 'call.accept' then 'sygsphere.comms.call.receive'
    when 'call.decline' then 'sygsphere.comms.call.receive'
    when 'call.cancel' then 'sygsphere.comms.call.start'
    when 'screen.request' then 'sygsphere.comms.screen.publish'
    when 'auth' then 'sygsphere.comms.use'
    when 'heartbeat' then 'sygsphere.comms.use'
    when 'resume' then 'sygsphere.comms.use'
    when 'snapshot.request' then 'sygsphere.comms.use'
    when 'call.end' then 'sygsphere.comms.use'
    when 'media.answer' then 'sygsphere.comms.use'
    when 'media.ready' then 'sygsphere.comms.use'
    when 'media.layout' then 'sygsphere.comms.use'
    when 'media.stop' then 'sygsphere.comms.use'
    when 'screen.release' then 'sygsphere.comms.use'
    when 'focus.request' then 'sygsphere.comms.use'
    when 'focus.release' then 'sygsphere.comms.use'
    else null
  end
$$;

-- Idempotency ledger entries keep enough information for safe replay. Their
-- limited retention is managed by this service-only, bounded procedure; no
-- browser-facing database policy can invoke it. The delete exception is
-- audited by the command-ledger audit trigger above.
create or replace function private.purge_sygsphere_communications_command_ledger(
  retention_cutoff timestamptz,
  maximum_rows integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_rows integer;
begin
  if retention_cutoff is null
    or retention_cutoff > clock_timestamp() - interval '30 days' then
    raise check_violation using message = 'Command ledger retention requires a cutoff at least 30 days old.';
  end if;

  if maximum_rows is null or maximum_rows < 1 or maximum_rows > 500 then
    raise check_violation using message = 'Command ledger retention batch must be between 1 and 500 rows.';
  end if;

  perform set_config('app.sygsphere_command_ledger_purge', 'approved', true);

  delete from private.sygsphere_communications_command_ledger ledger
  where ledger.id in (
    select candidate.id
    from private.sygsphere_communications_command_ledger candidate
    where candidate.expires_at < retention_cutoff
    order by candidate.expires_at asc
    limit maximum_rows
  );
  get diagnostics deleted_rows = row_count;

  return deleted_rows;
end
$$;

-- The Worker must call this with a verified SygShift auth subject. It returns
-- an authorization decision, but scopeMembershipVerified remains false until
-- a dedicated assignment/room-scope policy has passed review. That keeps this
-- service ingress unavailable even if someone later changes one gate alone.
create or replace function public.service_authorize_sygsphere_communications_command(
  target_auth_user_id uuid,
  target_command_kind text
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
begin
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

  return jsonb_build_object(
    'context', context_value,
    'requiredPermission', required_permission,
    'permissionGranted', permission_granted,
    'scopeMembershipVerified', false,
    'release', jsonb_build_object(
      'databaseFoundationApplied', gate_record.database_foundation_applied,
      'commandSchemasVerified', gate_record.command_schemas_verified,
      'providerPhysicalDeviceEvidenceComplete', gate_record.provider_physical_device_evidence_complete,
      'coordinatorDeploymentApproved', gate_record.coordinator_deployment_approved,
      'sharedCompatibilityVerified', gate_record.shared_compatibility_verified,
      'runtimeEnabled', gate_record.runtime_enabled
    ),
    'authorized', false,
    'reason', 'scope_verification_pending'
  );
end
$$;

revoke all on function private.sygsphere_communications_required_permission(text) from public, anon, authenticated;
revoke all on function private.prevent_sygsphere_communications_command_ledger_mutation() from public, anon, authenticated;
revoke all on function private.purge_sygsphere_communications_command_ledger(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.service_authorize_sygsphere_communications_command(uuid, text) from public, anon, authenticated;
grant execute on function private.sygsphere_communications_required_permission(text) to service_role;
grant execute on function private.purge_sygsphere_communications_command_ledger(timestamptz, integer) to service_role;
grant execute on function public.service_authorize_sygsphere_communications_command(uuid, text) to service_role;

notify pgrst, 'reload schema';
commit;

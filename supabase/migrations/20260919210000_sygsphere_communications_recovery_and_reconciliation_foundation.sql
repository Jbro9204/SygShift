begin;
set local lock_timeout = '5s';

-- Draft 4 makes server-to-browser event payloads explicit and adds only
-- private, append-only foundations for recovery and verified usage evidence.
-- It grants no role, opens no runtime gate, and stores no provider secret,
-- ICE credential, SDP description, or browser-supplied authority.
alter table private.sygsphere_communications_release_gate
  drop constraint if exists sygsphere_communications_release_gate_version;
alter table private.sygsphere_communications_release_gate
  add constraint sygsphere_communications_release_gate_version
  check (contract_version in ('1.0.0-draft.2', '1.0.0-draft.3', '1.0.0-draft.4'));

create table if not exists private.sygsphere_communications_room_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references private.sygsphere_tenants(id),
  room_reference text not null check (length(room_reference) between 1 and 128),
  room_epoch bigint not null check (room_epoch >= 0),
  room_seq bigint not null check (room_seq >= 0),
  event_kind text not null check (event_kind in (
    'authenticated', 'authorization.expiring', 'session.revoked', 'snapshot',
    'floor.preparing', 'floor.ready', 'floor.renewed', 'floor.denied', 'floor.revoked',
    'transmission.started', 'transmission.ended', 'call.ringing', 'call.requested',
    'call.accepted', 'call.ended', 'call.missed', 'meeting.created',
    'meeting.joined', 'meeting.ended', 'participant.changed', 'participant.removed',
    'participant.muted', 'media.negotiation', 'media.policy', 'media.failed',
    'media.closed', 'camera.granted', 'camera.denied', 'camera.revoked',
    'screen.granted', 'screen.denied', 'screen.revoked', 'focus.granted',
    'focus.denied', 'focus.revoked'
  )),
  event_id uuid not null unique,
  correlation_id uuid not null,
  payload_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint sygsphere_communications_room_events_payload_object
    check (jsonb_typeof(payload_metadata) = 'object'),
  constraint sygsphere_communications_room_events_sequence_unique
    unique (tenant_id, room_reference, room_epoch, room_seq)
);

create index if not exists sygsphere_communications_room_events_replay_idx
  on private.sygsphere_communications_room_events (tenant_id, room_reference, room_epoch, room_seq);

create table if not exists private.sygsphere_communications_outbox_deliveries (
  event_id uuid not null references private.sygsphere_communications_room_events(event_id),
  recipient_connection_id uuid not null,
  delivery_state text not null default 'pending'
    check (delivery_state in ('pending', 'in_flight', 'delivered', 'expired')),
  delivery_attempt_count integer not null default 0
    check (delivery_attempt_count between 0 and 16),
  lease_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  primary key (event_id, recipient_connection_id),
  constraint sygsphere_communications_outbox_lease_shape check (
    (delivery_state = 'in_flight' and lease_id is not null and lease_expires_at is not null)
    or (delivery_state <> 'in_flight' and lease_id is null and lease_expires_at is null)
  ),
  constraint sygsphere_communications_outbox_delivery_shape check (
    (delivery_state = 'delivered' and delivered_at is not null)
    or (delivery_state <> 'delivered' and delivered_at is null)
  )
);

create index if not exists sygsphere_communications_outbox_pending_idx
  on private.sygsphere_communications_outbox_deliveries (delivery_state, created_at)
  where delivery_state in ('pending', 'in_flight');

-- Every reconciled byte total requires an immutable, digest-addressed source
-- record. An empty data pull is unavailable in presentation code, never a
-- fabricated zero-usage reconciliation.
create table if not exists private.sygsphere_communications_usage_reconciliation_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references private.sygsphere_tenants(id),
  period_starts_at timestamptz not null,
  period_ends_at timestamptz not null,
  received_bytes bigint not null check (received_bytes >= 0),
  source_reference text not null check (length(source_reference) between 1 and 256),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  reconciled_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint sygsphere_communications_usage_reconciliation_period check (period_ends_at > period_starts_at),
  constraint sygsphere_communications_usage_reconciliation_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint sygsphere_communications_usage_reconciliation_evidence_unique unique (tenant_id, source_digest)
);

create index if not exists sygsphere_communications_usage_reconciliation_period_idx
  on private.sygsphere_communications_usage_reconciliation_evidence (tenant_id, period_starts_at, period_ends_at);

alter table private.sygsphere_communications_room_events enable row level security;
alter table private.sygsphere_communications_room_events force row level security;
alter table private.sygsphere_communications_outbox_deliveries enable row level security;
alter table private.sygsphere_communications_outbox_deliveries force row level security;
alter table private.sygsphere_communications_usage_reconciliation_evidence enable row level security;
alter table private.sygsphere_communications_usage_reconciliation_evidence force row level security;

revoke all on table private.sygsphere_communications_room_events from public, anon, authenticated;
revoke all on table private.sygsphere_communications_outbox_deliveries from public, anon, authenticated;
revoke all on table private.sygsphere_communications_usage_reconciliation_evidence from public, anon, authenticated;

create trigger sygsphere_communications_room_events_append_only
before update or delete on private.sygsphere_communications_room_events
for each row execute function private.prevent_append_only_change();

create trigger sygsphere_communications_usage_reconciliation_append_only
before update or delete on private.sygsphere_communications_usage_reconciliation_evidence
for each row execute function private.prevent_append_only_change();

create trigger sygsphere_communications_room_events_audit
after insert on private.sygsphere_communications_room_events
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_outbox_deliveries_audit
after insert or update or delete on private.sygsphere_communications_outbox_deliveries
for each row execute function private.write_audit_event();

create trigger sygsphere_communications_usage_reconciliation_audit
after insert on private.sygsphere_communications_usage_reconciliation_evidence
for each row execute function private.write_audit_event();

-- This private service procedure is intentionally the only write surface for
-- verified reconciliation evidence. It validates digest-addressed source
-- material and remains unavailable to browser/database roles.
create or replace function private.record_sygsphere_communications_usage_reconciliation(
  target_tenant_id uuid,
  target_period_starts_at timestamptz,
  target_period_ends_at timestamptz,
  target_received_bytes bigint,
  target_source_reference text,
  target_source_digest text,
  target_observed_at timestamptz,
  target_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_id uuid;
begin
  if target_tenant_id is null
    or target_period_starts_at is null
    or target_period_ends_at is null
    or target_period_ends_at <= target_period_starts_at
    or target_received_bytes is null
    or target_received_bytes < 0
    or target_source_reference is null
    or length(target_source_reference) not between 1 and 256
    or target_source_digest is null
    or target_source_digest !~ '^[a-f0-9]{64}$'
    or target_observed_at is null
    or jsonb_typeof(coalesce(target_metadata, '{}'::jsonb)) <> 'object' then
    raise check_violation using message = 'Usage reconciliation requires complete verified evidence.';
  end if;

  insert into private.sygsphere_communications_usage_reconciliation_evidence (
    tenant_id, period_starts_at, period_ends_at, received_bytes,
    source_reference, source_digest, observed_at, metadata
  ) values (
    target_tenant_id, target_period_starts_at, target_period_ends_at, target_received_bytes,
    target_source_reference, target_source_digest, target_observed_at, coalesce(target_metadata, '{}'::jsonb)
  ) returning id into inserted_id;

  return inserted_id;
end
$$;

revoke all on function private.record_sygsphere_communications_usage_reconciliation(uuid, timestamptz, timestamptz, bigint, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function private.record_sygsphere_communications_usage_reconciliation(uuid, timestamptz, timestamptz, bigint, text, text, timestamptz, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;

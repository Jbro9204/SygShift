import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const readWorkspaceFile = (relativePath) => readFileSync(resolve(process.cwd(), relativePath), 'utf8')
const failures = []
const migration = readWorkspaceFile('supabase/migrations/20260919190000_sygsphere_communications_coordinator_foundation.sql')
const coordinator = readWorkspaceFile('worker/comms/tenantCommsDurableObject.ts')
const providerRegistry = readWorkspaceFile('worker/comms/providerRegistry.ts')
const workerConfiguration = readWorkspaceFile('wrangler.jsonc')
const workerEntrypoint = readWorkspaceFile('worker/index.ts')
const manifest = JSON.parse(readWorkspaceFile('shared/sygsphere-communications/v1/contract-manifest.json'))

for (const relation of [
  'sygsphere_communications_release_gate',
  'sygsphere_communications_provider_registry',
  'sygsphere_communications_command_ledger',
  'sygsphere_communications_history_events',
  'sygsphere_communications_audit_events',
  'sygsphere_communications_usage_daily',
]) {
  if (!migration.includes(`private.${relation}`)) failures.push(`Missing private ${relation} persistence.`)
  if (!migration.includes(`alter table private.${relation} force row level security`)) {
    failures.push(`RLS is not forced for private.${relation}.`)
  }
}

for (const gate of [
  'command_schemas_verified boolean not null default false',
  'provider_physical_device_evidence_complete boolean not null default false',
  'coordinator_deployment_approved boolean not null default false',
  'shared_compatibility_verified boolean not null default false',
  'runtime_enabled boolean not null default false',
]) {
  if (!migration.includes(gate)) failures.push(`Closed release gate is missing ${gate}.`)
}

if (!migration.includes("constraint sygsphere_communications_provider_registry_no_enabled_provider check (not enabled)")) {
  failures.push('Provider registry is not constrained to remain disabled.')
}

for (const usageField of [
  'feature_key text not null',
  'estimated_received_bytes bigint not null default 0',
  "telemetry_status text not null default 'unavailable'",
  "estimate_version text not null default 'unconfigured'",
  'reconciliation_metadata jsonb not null',
]) {
  if (!migration.includes(usageField)) failures.push(`Usage foundation is missing ${usageField}.`)
}

if (!migration.includes('purge_sygsphere_communications_command_ledger')
  || !migration.includes('maximum_rows integer default 500')
  || !migration.includes('limit maximum_rows')) {
  failures.push('Command-ledger retention is not a protected bounded service procedure.')
}

if (!migration.includes('service_authorize_sygsphere_communications_command')) {
  failures.push('The protected server authorization procedure is missing.')
}

if (!migration.includes("'scopeMembershipVerified', false") || !migration.includes("'authorized', false")) {
  failures.push('The protected authorization procedure does not fail closed on scope authorization.')
}

if (!coordinator.includes('class TenantCommsDurableObject extends DurableObject')) {
  failures.push('The SQLite Durable Object coordinator is missing.')
}

if (!coordinator.includes('coordinator_commands') || !coordinator.includes('coordinator_rate_windows')) {
  failures.push('The coordinator does not persist replay and rate-window state.')
}

if (!coordinator.includes('purgeExpiredState') || !coordinator.includes('maximumRecordsPurgedPerDispatch')) {
  failures.push('The coordinator does not bound local replay/rate-window retention.')
}

if (!providerRegistry.includes('enabled: false')
  || !providerRegistry.includes('provider_adapter_not_released')
  || !providerRegistry.includes('closedProviderOutcome')) {
  failures.push('The provider registry does not fail closed.')
}

if (!/"TENANT_COMMS"\s*,\s*\n\s*"class_name"\s*:\s*"TenantCommsDurableObject"/.test(workerConfiguration)) {
  failures.push('The source-only coordinator Durable Object binding is missing.')
}

if (!/"SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED"\s*:\s*"false"/.test(workerConfiguration)) {
  failures.push('The coordinator runtime flag is not explicitly disabled.')
}

if (/sygsphere-communications|\/api\/(?:v1\/communications|comms\/v1)/.test(workerEntrypoint)) {
  failures.push('A browser-facing communications route is present before release approval.')
}

if (manifest.contractVersion !== '1.0.0-draft.2' || manifest.lifecycle !== 'closed-coordinator-foundation') {
  failures.push('The shared contract manifest does not identify the closed coordinator foundation.')
}

for (const artifact of ['integration-gates.ts', 'presentation-policy.ts', 'command-payload.schema.json']) {
  if (!manifest.artifacts.includes(artifact)) failures.push(`The shared manifest omits ${artifact}.`)
}

if (failures.length > 0) {
  console.error('SygSphere Communications Stage 1/2 foundation gate failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('SygSphere Communications Stage 1/2 coordinator foundation is closed as intended.')
}

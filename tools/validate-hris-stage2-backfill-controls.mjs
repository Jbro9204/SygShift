import { readFile } from 'node:fs/promises'
import process from 'node:process'

const contractUrl = new URL('../config/hris-stage-2-controlled-backfill.json', import.meta.url)
const migrationUrl = new URL('../supabase/migrations/20260830005500_hris_stage2_controlled_backfill.sql', import.meta.url)
const [contract, migration] = await Promise.all([
  readFile(contractUrl, 'utf8').then(JSON.parse),
  readFile(migrationUrl, 'utf8'),
])

const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }

requireValue(contract.releaseState?.featureEnabled === false, 'The HRIS feature must remain disabled.')
requireValue(contract.releaseState?.productionBackfillGateEnabled === false, 'The production backfill gate must remain closed.')
requireValue(contract.releaseState?.canaryExecuted === false, 'The repository contract cannot claim that a canary ran.')
requireValue(contract.releaseState?.fullBackfillExecuted === false, 'The repository contract cannot claim that a full backfill ran.')
requireValue(contract.releaseState?.roleMappingAllowed === false, 'Role mapping must remain disabled.')
requireValue(contract.releaseState?.browserDirectAccessAllowed === false, 'Direct browser access must remain disabled.')
requireValue(contract.effectiveDates?.authoritativeSourceRequired === true, 'Authoritative effective-date evidence is required.')
requireValue(contract.effectiveDates?.guessingAllowed === false, 'Effective dates cannot be guessed.')
requireValue(contract.recovery?.isolatedRestoreEvidenceRequired === true, 'Isolated recovery evidence is required.')
requireValue(contract.recovery?.productionEvidencePresent === false, 'The contract cannot claim missing production recovery evidence exists.')
requireValue(contract.authorization?.mfaRequired === true, 'Protected authorization must require MFA.')
requireValue(contract.authorization?.serviceExecutorOnly === true, 'The executor must remain service-only.')
requireValue(contract.authorization?.authorizationMinutes === 15, 'Authorizations must expire after 15 minutes.')
requireValue(contract.authorization?.maximumCanaryEmployees === 3, 'Canaries must be limited to three employees.')
requireValue(contract.authorization?.singleUse === true, 'Backfill authorizations must be single-use.')
requireValue(contract.authorization?.staleSnapshotRejected === true, 'A stale authorization snapshot must be rejected.')

for (const domain of contract.preservationDomains) {
  requireValue(migration.includes(`'${domain}'`), `Missing preservation snapshot domain ${domain}.`)
}

requireValue(migration.includes('default false'), 'The database backfill gate must default to disabled.')
requireValue(migration.includes("values (true, false, 'Stage 2 protected backfill remains disabled.')"), 'The migration must install the gate closed.')
requireValue(migration.includes("coalesce(auth.role(), '') <> 'service_role'"), 'The executor must reject non-service callers.')
requireValue(migration.includes("public.has_effective_permission('hr.people.manage')"), 'The control plane must require the HR management permission.')
requireValue(migration.includes('if not public.has_mfa()'), 'The control plane must require verified MFA.')
requireValue(migration.includes("clock_timestamp() + interval '15 minutes'"), 'Authorizations must have a bounded lifetime.')
requireValue(migration.includes('cardinality(clean_employee_ids) not between 1 and 3'), 'Canary size must be bounded in the database.')
requireValue(migration.includes('authorization_record.authorization_snapshot'), 'Execution must reject stale operational authorization snapshots.')
requireValue(migration.includes('private.hris_stage2_preservation_snapshot()'), 'The protected operational snapshot is missing.')
requireValue(migration.includes('if before_snapshot <> after_snapshot'), 'Execution must enforce post-write operational preservation.')
requireValue(migration.includes('private.prevent_append_only_change()'), 'Authorization and execution history must be append-only.')
requireValue(migration.includes('private.write_audit_event()'), 'Control-plane mutations must be audited.')
requireValue(migration.includes('enable row level security'), 'Control-plane tables must enable row-level security.')
requireValue(migration.includes('from public, anon, authenticated'), 'Private controls must be denied to browser roles.')
requireValue(migration.includes("raise exception 'Stage 2 run 3 changed protected employee, access, or HR identity records.'"), 'The installation transaction must preserve live records.')
requireValue(!/select\s+private\.execute_hris_stage2_identity_backfill\s*\(/i.test(migration), 'The migration must never invoke the backfill executor.')
requireValue(!/\b(first_name|last_name|preferred_name|personal_email|company_email|mobile_phone|auth_user_id)\b/i.test(migration), 'The control plane must not copy personal or authentication identity data.')
requireValue(!/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration), 'Run 3 cannot change current access.')
requireValue(!/update\s+public\.employees/i.test(migration), 'Run 3 cannot rewrite employee records.')

if (failures.length > 0) {
  console.error('HRIS Stage 2 controlled backfill validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info(`HRIS Stage 2 controlled backfill plane validated: gate closed, ${contract.authorization.maximumCanaryEmployees}-employee canary maximum, ${contract.preservationDomains.length} protected domains.`)

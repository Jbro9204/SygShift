import { readFile } from 'node:fs/promises'
import process from 'node:process'

const contractUrl = new URL('../config/hris-stage-2-reconciliation.json', import.meta.url)
const coreUrl = new URL('../config/hris-core-data-architecture.json', import.meta.url)
const migrationUrl = new URL('../supabase/migrations/20260829233000_hris_stage2_reconciliation_proposal.sql', import.meta.url)
const [contract, core, migration] = await Promise.all([
  readFile(contractUrl, 'utf8').then(JSON.parse),
  readFile(coreUrl, 'utf8').then(JSON.parse),
  readFile(migrationUrl, 'utf8'),
])

const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }

requireValue(contract.releaseState?.featureEnabled === false, 'The HRIS feature must remain disabled.')
requireValue(contract.releaseState?.protectedProductionBackfillAllowed === false, 'Protected backfill must remain disabled.')
requireValue(contract.releaseState?.roleMappingAllowed === false, 'Role mapping must remain disabled.')
requireValue(contract.releaseState?.browserDirectAccessAllowed === false, 'Browser access must remain disabled.')
requireValue(core.releaseState?.protectedProductionBackfillAllowed === false, 'The core Stage 2 backfill gate must remain closed.')
requireValue(contract.source?.authoritativeEmployeeTable === 'public.employees', 'The proposal must use the permanent employee identity.')
requireValue(contract.source?.copiesNames === false, 'The proposal cannot duplicate employee names.')
requireValue(contract.source?.copiesContactDetails === false, 'The proposal cannot duplicate employee contact data.')
requireValue(contract.source?.copiesAuthenticationIdentity === false, 'The proposal cannot duplicate authentication identity.')
requireValue(contract.proposal?.deterministicIdentifiers === true, 'Proposed HR identifiers must be deterministic.')
requireValue(contract.proposal?.automaticPromotionAllowed === false, 'The proposal cannot promote itself into protected records.')
requireValue(contract.proposal?.serviceRoleOnly === true, 'Detailed reconciliation must remain service-only.')

for (const blocker of contract.blockingConditions) {
  requireValue(migration.includes(`'${blocker}'`), `Missing reconciliation blocker ${blocker}.`)
}
for (const warning of contract.reviewWarnings) {
  requireValue(migration.includes(`'${warning}'`), `Missing reconciliation warning ${warning}.`)
}

requireValue(migration.includes("private.hris_deterministic_uuid('sygshift-hr-person-v1'"), 'Person identifiers must use a versioned deterministic scope.')
requireValue(migration.includes("private.hris_deterministic_uuid('sygshift-hr-worker-v1'"), 'Worker identifiers must use a versioned deterministic scope.')
requireValue(migration.includes('private.hris_stage2_mapping_proposal()'), 'The service-only detail proposal is missing.')
requireValue(migration.includes('private.hris_stage2_reconciliation_summary()'), 'The aggregate reconciliation summary is missing.')
requireValue(migration.includes('private.assert_hris_stage2_reconciliation_ready()'), 'The blocking reconciliation assertion is missing.')
requireValue(migration.includes("'protectedBackfillAllowed', false"), 'The database summary must report that backfill is disabled.')
requireValue(migration.includes("'proposal_ready_backfill_disabled'"), 'The assertion must preserve the closed release gate.')
requireValue(migration.includes('from public, anon, authenticated'), 'Reconciliation functions must be denied to browser roles.')
requireValue(migration.includes('hris_stage2_run2_preservation_baseline'), 'The migration must prove employee, access, and HR identity preservation.')
requireValue(!/insert\s+into\s+private\.hr_(person|worker)_identifiers/i.test(migration), 'Run 2 cannot backfill protected HR identifiers.')
requireValue(!/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration), 'Run 2 cannot change current access.')
requireValue(!/\b(first_name|last_name|preferred_name|personal_email|company_email|mobile_phone|auth_user_id)\b/i.test(
  migration.match(/create function private\.hris_stage2_mapping_proposal\(\)[\s\S]*?\n\$\$;/)?.[0] ?? '',
), 'The proposal must not return names, contact data, or authentication identity.')

if (failures.length > 0) {
  console.error('HRIS Stage 2 reconciliation validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info(`HRIS Stage 2 reconciliation validated: ${contract.blockingConditions.length} blockers, ${contract.reviewWarnings.length} review warnings, protected backfill disabled.`)

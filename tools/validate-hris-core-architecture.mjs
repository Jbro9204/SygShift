import { readFile } from 'node:fs/promises'
import process from 'node:process'

const configUrl = new URL('../config/hris-core-data-architecture.json', import.meta.url)
const migrationUrl = new URL('../supabase/migrations/20260829230000_hris_core_data_architecture.sql', import.meta.url)
const foundationUrl = new URL('../config/hris-foundation-boundaries.json', import.meta.url)
const [config, migration, foundation] = await Promise.all([
  readFile(configUrl, 'utf8').then(JSON.parse),
  readFile(migrationUrl, 'utf8'),
  readFile(foundationUrl, 'utf8').then(JSON.parse),
])
const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }

requireValue(config.releaseState?.featureEnabled === false, 'Stage 2 HR features must remain disabled.')
requireValue(config.releaseState?.protectedProductionBackfillAllowed === false, 'Protected production backfill must remain blocked.')
requireValue(config.releaseState?.roleMappingAllowed === false, 'Stage 2 cannot assign new HR permissions to existing roles.')
requireValue(config.identity?.authoritativeEmployeeTable === 'public.employees', 'public.employees must remain the authoritative employee identity.')
requireValue(config.identity?.employeeNumberIsPrimaryKey === false, 'Employee number cannot become the HRIS primary key.')
requireValue(config.identity?.duplicatesLegalNames === false, 'The HRIS mapping cannot duplicate legal names.')
requireValue(config.historyControls?.deletesAllowed === false, 'HR history must prohibit deletion.')
requireValue(config.historyControls?.overlapPrevention === true, 'Effective-dated records must prevent conflicting overlap.')
requireValue(config.accessPreservation?.assignPermissionsToExistingRoles === false, 'New permissions cannot be granted to existing roles in this run.')
requireValue(config.reconciliation?.automaticPromotionAllowed === false, 'Unresolved HR identity mappings cannot be promoted automatically.')
requireValue(foundation.releaseGate?.protectedProductionDataAllowed === false, 'The Stage 1 protected-data gate must remain closed.')

for (const table of [...config.effectiveDatedRecords, ...config.referenceRecords, config.identity.personTable, config.identity.workerTable]) {
  const [, name] = table.split('.')
  requireValue(migration.includes(`create table private.${name}`), `Missing HRIS table ${table}.`)
  requireValue(migration.includes(`alter table private.%I enable row level security`), 'Private HRIS tables must be placed behind RLS.')
}

const personIdentifierTable = migration.match(/create table private\.hr_person_identifiers \([\s\S]*?\n\);/)?.[0] ?? ''
requireValue(migration.includes('employee_id uuid not null unique references public.employees(id) on delete restrict'), 'Person identity must map one-to-one to the permanent employee record.')
requireValue(personIdentifierTable.length > 0, 'The person identifier table contract is missing.')
requireValue(!/first_name|last_name|preferred_name|email|phone/i.test(personIdentifierTable), 'Person identifiers cannot create a second employee directory.')
requireValue(migration.includes('private.hris_protect_effective_record()'), 'Effective history requires close-only protection.')
requireValue(migration.includes('private.hris_prevent_effective_overlap()'), 'Effective history requires overlap prevention.')
requireValue(migration.includes('A worker cannot be assigned as their own manager.'), 'Manager relationships must reject self-management.')
requireValue(migration.includes('requires an actor, timestamp, and reason'), 'Closing effective history must identify the responsible actor.')
requireValue(migration.includes('private.hris_core_reconciliation_report()'), 'A non-PII reconciliation report is required.')
requireValue(migration.includes('private.assert_hris_core_integrity()'), 'A core identity integrity assertion is required.')
requireValue(migration.includes('from public, anon, authenticated'), 'Direct browser access must be revoked.')
requireValue(migration.includes('hris_stage2_preservation_baseline'), 'The migration must assert employee and access preservation.')
requireValue(!migration.includes('insert into public.access_role_permissions'), 'Stage 2 run 1 cannot grant HR permissions to roles.')
requireValue(!migration.includes('insert into public.employee_access_roles'), 'Stage 2 run 1 cannot change employee role membership.')
requireValue(!migration.includes('insert into public.employee_permission_overrides'), 'Stage 2 run 1 cannot add individual access overrides.')
requireValue(!migration.includes('insert into private.hr_person_identifiers'), 'Stage 2 run 1 cannot silently backfill protected person identifiers.')
requireValue(!migration.includes('insert into private.hr_worker_identifiers'), 'Stage 2 run 1 cannot silently backfill protected worker identifiers.')

if (failures.length > 0) {
  console.error('HRIS Stage 2 core architecture validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info(`HRIS Stage 2 core architecture validated: ${config.effectiveDatedRecords.length} effective record families, ${config.referenceRecords.length} reference families, protected backfill disabled.`)

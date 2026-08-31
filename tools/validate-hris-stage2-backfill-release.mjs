import { readFile } from 'node:fs/promises'
import process from 'node:process'

const migrationUrl = new URL('../supabase/migrations/20260831220000_hris_stage2_backfill_release_verification.sql', import.meta.url)
const contractUrl = new URL('../config/hris-stage-2-controlled-backfill.json', import.meta.url)
const [migration, contract] = await Promise.all([
  readFile(migrationUrl, 'utf8'),
  readFile(contractUrl, 'utf8').then(JSON.parse),
])

const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }

requireValue(contract.releaseSequencing?.verifiedCanaryRequiredBeforeFull === true, 'Full rollout must require a verified canary.')
requireValue(contract.releaseSequencing?.gateClosesAfterEveryExecution === true, 'The gate must close after every execution.')
requireValue(contract.releaseSequencing?.verificationEvidenceDigestRequired === true, 'Canary verification must require evidence with a digest.')
requireValue(migration.includes('create table private.hr_stage2_canary_verifications'), 'The append-only canary verification record is missing.')
requireValue(migration.includes('private.prevent_append_only_change()'), 'Canary verification history must be append-only.')
requireValue(migration.includes('private.write_audit_event()'), 'Canary verification writes must be audited.')
requireValue(migration.includes("coalesce(auth.role(), '') <> 'service_role'"), 'Canary verification must remain service-only.')
requireValue(migration.includes('verification_sha256 ~'), 'Verification evidence must require a SHA-256 digest.')
requireValue(migration.includes("execution_record.before_snapshot <> execution_record.after_snapshot"), 'Verification must independently inspect preservation evidence.')
requireValue(migration.includes("mapped_count <> execution_record.employee_count"), 'Verification must assert every canary mapping.')
requireValue(migration.includes("A verified canary using the current recovery evidence is required before full authorization."), 'Full authorization must require a current verified canary.')
requireValue(migration.includes('hr_stage2_backfill_execution_close_gate'), 'A post-execution gate-closing trigger is required.')
requireValue(migration.includes("where singleton and enabled"), 'Automatic gate closure must be bounded to an open gate.')
requireValue(migration.includes('from public, anon, authenticated'), 'Private release controls must be denied to browser roles.')
requireValue(migration.includes("raise exception 'Stage 2 release hardening changed protected employee, access, or HR identity records.'"), 'Installation must assert protected-record preservation.')
requireValue(migration.includes("raise exception 'Stage 2 release hardening must not fabricate canary verification evidence.'"), 'Installation must assert that no canary evidence was fabricated.')
requireValue(!/select\s+private\.execute_hris_stage2_identity_backfill\s*\(/i.test(migration), 'Release hardening must not execute the identity backfill.')
requireValue(!/insert\s+into\s+private\.hr_(person|worker)_identifiers/i.test(migration), 'Release hardening must not create protected HR identities.')
requireValue(!/update\s+public\.employees/i.test(migration), 'Release hardening must not update employee records.')

if (failures.length > 0) {
  console.error('HRIS Stage 2 backfill release validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('HRIS Stage 2 release controls validated: verified canary required, gate auto-closes, evidence is append-only, and no identity write is embedded.')

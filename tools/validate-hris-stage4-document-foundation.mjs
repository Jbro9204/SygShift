import { readFileSync } from 'node:fs'

const policy = JSON.parse(readFileSync('config/hris-document-security.json', 'utf8'))
const migration = readFileSync('supabase/migrations/20260830043000_hris_stage4_document_foundation.sql', 'utf8')

const failures = []
const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

requireValue(policy.release?.defaultEnabled === false, 'The document feature must default to disabled.')
requireValue(policy.authorization?.recentMfaRequiredBeforeDocumentAccessRelease === true, 'Recent MFA must be required before document access is released.')
requireValue(policy.authorization?.recentMfaMaximumAgeSeconds === 900, 'Recent MFA must expire after 15 minutes.')
requireValue(policy.authorization?.trustedDeviceAloneSatisfiesRecentMfa === false, 'A trusted device must not replace recent MFA for document access.')
requireValue(policy.storage?.publicObjectsAllowed === false, 'Public HR document objects are forbidden.')
requireValue(policy.storage?.directBrowserObjectAccessAllowed === false, 'Direct browser object access is forbidden.')
requireValue(policy.malware?.quarantineByDefault === true, 'Documents must enter quarantine by default.')
requireValue(policy.malware?.scanRequiredBeforeAccess === true, 'A clean malware scan must precede access.')
requireValue(policy.history?.versionsImmutable === true, 'Document versions must remain immutable.')
requireValue(Array.isArray(policy.vaults) && policy.vaults.length === 6, 'Exactly six separated vaults are required.')
requireValue(!migration.includes('create policy'), 'Authenticated storage policies must not be created for HR vaults.')
requireValue(!migration.includes('insert into public.access_role_permissions'), 'The migration must preserve current role permissions.')
requireValue(migration.includes('hr_document_versions_immutable'), 'The immutable version trigger is missing.')
requireValue(migration.includes('hr_document_access_events_append_only'), 'The append-only access audit is missing.')
requireValue(migration.includes('hr_document_active_legal_hold_unique'), 'The legal-hold constraint is missing.')
requireValue(migration.includes('no more than 15 minutes old'), 'The recent-MFA release blocker is not documented at the access boundary.')

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log('HRIS Stage 4 document foundation validation passed.')

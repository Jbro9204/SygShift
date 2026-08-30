import { readFileSync } from 'node:fs'

const policy = JSON.parse(readFileSync('config/hris-document-security.json', 'utf8'))
const worker = readFileSync('worker/index.ts', 'utf8')
const migration = readFileSync('supabase/migrations/20260830120000_hris_stage4_secure_document_pipeline.sql', 'utf8')

const failures = []
const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

const functionBody = (name) => {
  const match = migration.match(new RegExp(`create function ${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'))
  return match?.[0] ?? ''
}

const beginUpload = functionBody('public\\.service_begin_hr_document_upload')
const issueAccess = functionBody('public\\.service_issue_hr_document_access_grant')
const consumeAccess = functionBody('public\\.service_consume_hr_document_access_grant')

requireValue(policy.release?.featureFlag === 'SYGSHIFT_DOCUMENT_PIPELINE_ENABLED', 'The document pipeline must use its dedicated release flag.')
requireValue(policy.release?.defaultEnabled === false, 'The document pipeline must default to disabled.')
requireValue(policy.release?.requiresSecurityEvidence === true, 'Security evidence must be required before release.')
requireValue(policy.release?.requiresRecoveryEvidence === true, 'Recovery evidence must be required before release.')
requireValue(policy.authorization?.recentMfaMaximumAgeSeconds === 900, 'Document access MFA must expire after 15 minutes.')
requireValue(policy.authorization?.trustedDeviceAloneSatisfiesRecentMfa === false, 'A trusted device must not replace recent MFA for document access.')
requireValue(policy.storage?.publicObjectsAllowed === false, 'Public HR document objects are forbidden.')
requireValue(policy.storage?.directBrowserObjectAccessAllowed === false, 'Direct browser object access is forbidden.')
requireValue(policy.storage?.maximumFileSizeBytes === 26_214_400, 'The upload limit must remain 25 MB.')
requireValue(policy.storage?.signedAccessLifetimeSeconds === 60, 'One-time document access must expire after 60 seconds.')
requireValue(policy.validation?.trustedBrowserMimeType === false, 'Browser MIME claims must not be trusted.')
requireValue(policy.validation?.trustedBrowserFileName === false, 'Browser filenames must not be trusted.')
requireValue(policy.validation?.requireFileSignatureMatch === true, 'File signatures must be verified.')
requireValue(policy.validation?.rejectExtensionMimeMismatch === true, 'Extension/MIME mismatches must be rejected.')
requireValue(policy.validation?.rejectActiveContent === true, 'Active content must be rejected.')
requireValue(policy.validation?.rejectMacroEnabledOffice === true, 'Macro-enabled Office files must be rejected.')
requireValue(policy.malware?.quarantineByDefault === true, 'Uploads must enter quarantine by default.')
requireValue(policy.malware?.scanRequiredBeforeAccess === true, 'A clean malware scan must precede access.')
requireValue(policy.malware?.previewBeforeCleanScanAllowed === false, 'Preview before a clean scan is forbidden.')
requireValue(policy.malware?.downloadBeforeCleanScanAllowed === false, 'Download before a clean scan is forbidden.')
requireValue(Array.isArray(policy.vaults) && policy.vaults.length === 6, 'Exactly six separated document vaults are required.')

requireValue(worker.includes('SYGSHIFT_DOCUMENT_PIPELINE_ENABLED?: string'), 'The Worker release flag binding is missing.')
requireValue(worker.includes('SYGSHIFT_DOCUMENT_SCANNER_SECRET?: string'), 'The scanner callback secret binding is missing.')
requireValue(worker.includes('/api/v1/hr/documents/uploads'), 'The protected upload route is missing.')
requireValue(worker.includes('scanOperationId') && worker.includes('handleHrDocumentScanCallback'), 'The protected scan callback route is missing.')
requireValue(worker.includes('/api/v1/hr/documents/access/'), 'The one-time access route is missing.')
requireValue(worker.includes('validateHrDocumentFile'), 'Server-side document validation is missing.')
requireValue(worker.includes('requireRecentDocumentMfa'), 'Recent-MFA verification is missing.')
requireValue(worker.includes('unzipSync'), 'Office ZIP package inspection is missing.')
requireValue(worker.includes('sha256Hex'), 'SHA-256 evidence is missing.')
requireValue(worker.includes('private, no-store'), 'Document delivery must be private and non-cacheable.')
requireValue(!worker.includes('createSignedUrl('), 'Direct signed storage URLs are forbidden in the document pipeline.')

for (const [label, body] of [
  ['begin upload', beginUpload],
  ['issue access', issueAccess],
  ['consume access', consumeAccess],
]) {
  requireValue(body.length > 0, `The ${label} database boundary is missing.`)
  requireValue(body.includes('security definer'), `The ${label} boundary must be security definer.`)
  requireValue(body.includes("set search_path = ''"), `The ${label} boundary must use an empty search path.`)
  requireValue(body.includes('hr_document_release_gate'), `The ${label} boundary must enforce the database release gate.`)
}

requireValue(issueAccess.includes("interval '15 minutes'"), 'Access issuance must reject stale MFA after 15 minutes.')
requireValue(issueAccess.includes("interval '60 seconds'"), 'Access grants must expire after 60 seconds.')
requireValue(issueAccess.includes("<> 'clean'"), 'Access issuance must require a clean scan.')
requireValue(consumeAccess.includes('consumed_at is null'), 'Document access grants must be one-time use.')
requireValue(consumeAccess.includes('current_version_id = grant_record.version_id'), 'Document access must remain bound to the current version.')
requireValue(consumeAccess.includes('service_require_hr_document_permission'), 'Document permissions must be rechecked at consumption time.')
requireValue(consumeAccess.includes("<> 'clean'"), 'A clean scan must be rechecked at consumption time.')
requireValue(worker.includes('target_token_hash: await sha256Hex(rawToken)'), 'Access tokens must be stored as SHA-256 hashes.')
requireValue(migration.includes('hr_document_upload_transition_guard'), 'Upload state transitions must be guarded.')
requireValue(migration.includes('hr_document_access_grant_guard'), 'Issued access grants must be immutable.')
requireValue(migration.includes('Run 2 deliberately leaves production access disabled.'), 'The migration must document the closed production gate.')
requireValue(migration.includes('set enabled = false'), 'The migration must leave the database release gate disabled.')
requireValue(migration.includes('hris_stage4_run2_preservation_baseline'), 'Production identity and access preservation checks are missing.')
requireValue(!migration.includes('insert into public.access_role_permissions'), 'The pipeline migration must not assign role permissions.')
requireValue(!migration.includes('insert into public.employee_permission_overrides'), 'The pipeline migration must not assign employee permission overrides.')
requireValue(!migration.includes('create policy'), 'The pipeline migration must not expose storage through browser policies.')

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log('HRIS Stage 4 secure document pipeline validation passed.')

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workerSource = readFileSync(resolve(import.meta.dirname, '..', 'worker/index.ts'), 'utf8')
const clientUploadMigration = readFileSync(resolve(
  import.meta.dirname,
  '..',
  'supabase/migrations/20261024151000_harden_client_document_upload_completion.sql',
), 'utf8')
const licensingUploadMigration = readFileSync(resolve(
  import.meta.dirname,
  '..',
  'supabase/migrations/20261024154500_harden_licensing_document_upload_completion.sql',
), 'utf8')
const hrAuthorityMigration = readFileSync(resolve(
  import.meta.dirname,
  '..',
  'supabase/migrations/20261024164000_hr_document_authority_fence.sql',
), 'utf8')
const hrAuthorityRegression = readFileSync(resolve(
  import.meta.dirname,
  '..',
  'supabase/tests/hr_document_authority_fence_regression.sql',
), 'utf8')

function section(start: string, end: string): string {
  const startIndex = workerSource.indexOf(start)
  const endIndex = workerSource.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return workerSource.slice(startIndex, endIndex)
}

describe('Worker ambiguous completion resilience', () => {
  it.each([
    ['credential licensing', 'async function handleLicensingDocumentUpload(', 'async function handleLicensingSubmissionDocumentUpload('],
    ['submission licensing', 'async function handleLicensingSubmissionDocumentUpload(', 'async function handleLicensingSubmissionDocumentRemoval('],
  ])('gets a locked cleanup decision for a rejected %s upload before ambiguous reconciliation', (_label, start, end) => {
    const handler = section(start, end)
    const deterministicGate = handler.indexOf('completionStarted && !completionFailureMayBeAmbiguous(error)')
    const cleanupDecision = handler.indexOf('reconcileRejectedLicensingCompletion', deterministicGate)
    const reconciliation = handler.indexOf('reconcileAmbiguousUploadCompletion', cleanupDecision)
    expect(deterministicGate).toBeGreaterThanOrEqual(0)
    expect(cleanupDecision).toBeGreaterThan(deterministicGate)
    expect(reconciliation).toBeGreaterThan(cleanupDecision)
  })

  it('locks licensing completion and cleanup decisions before authorizing exact-object deletion', () => {
    const helper = section('async function reconcileRejectedLicensingCompletion(', 'async function handleDocumentPipelineCanary(')
    expect(helper).toContain("'service_reconcile_licensing_document_upload_failure'")
    expect(helper).toContain('decision.documentId === input.operation.documentId')
    expect(helper).toContain('inspectPrivateStorageObjectIntegrity')
    expect(helper).toContain('deletePrivateStorageObject')
    expect(helper).toContain('deferLicensingDocumentCleanup')
    expect(helper).toContain('completeLicensingDocumentCleanup')
    expect(licensingUploadMigration).toContain('for update;')
    expect(licensingUploadMigration).toContain("if document_record.upload_state = 'stored'")
    expect(licensingUploadMigration).toContain("'cleanupAllowed', document_record.upload_state = 'failed'")
    expect(licensingUploadMigration).toContain('service_list_licensing_document_cleanup_recovery')
    expect(licensingUploadMigration).toContain('service_defer_licensing_document_cleanup')
    expect(licensingUploadMigration).toContain('service_complete_licensing_document_cleanup')
  })

  it('recovers licensing cleanup only after exact immutable storage verification', () => {
    const recovery = section('export async function recoverLicensingDocumentCleanup(', 'async function recoverStoredSygSphereFiles(')
    const inspection = recovery.indexOf('inspectPrivateStorageObjectIntegrity')
    const deletion = recovery.indexOf('deletePrivateStorageObject', inspection)
    const completion = recovery.indexOf('completeLicensingDocumentCleanup', deletion)

    expect(recovery).toContain("item.bucket !== identity.bucket")
    expect(recovery).toContain("bucket: 'credential-documents'")
    expect(inspection).toBeGreaterThanOrEqual(0)
    expect(deletion).toBeGreaterThan(inspection)
    expect(completion).toBeGreaterThan(deletion)
    expect(recovery).toContain('deferLicensingDocumentCleanup')
  })

  it('preserves stored HR bytes until the locked authority state is known', () => {
    const handler = section('async function handleHrDocumentUpload(', 'async function handleHrDocumentWorkspace(')
    const deterministicGate = handler.indexOf('completionStarted && !completionFailureMayBeAmbiguous(error)')
    const failureState = handler.indexOf("'service_fail_hr_document_upload'", deterministicGate)
    const reconciliation = handler.indexOf('reconcileAmbiguousUploadCompletion', failureState)
    expect(deterministicGate).toBeGreaterThanOrEqual(0)
    expect(failureState).toBeGreaterThan(deterministicGate)
    expect(reconciliation).toBeGreaterThan(failureState)
    expect(handler.slice(deterministicGate, reconciliation)).not.toContain('deletePrivateStorageObject')
    expect(handler).toContain("failureState.state === 'clean'")
    expect(hrAuthorityMigration).toContain('authority_superseded boolean not null default false')
    expect(hrAuthorityMigration).toContain('for update;')
    expect(hrAuthorityMigration).toContain('document.current_version_id is not distinct from operation.version_id')
    expect(hrAuthorityMigration).toContain('if operation_record.authority_superseded then')
    expect(hrAuthorityMigration).toContain("'initialized', 'quarantined', 'stored', 'scan_pending'")
    expect(hrAuthorityMigration).toContain("'scan_error', 'storage_error'")
    expect(hrAuthorityMigration).toContain('and not operation.authority_superseded')
    expect(hrAuthorityMigration).toContain('from public, anon, authenticated, service_role;')
    expect(hrAuthorityRegression).toContain('The service role must not bypass the public HR document authority wrapper.')
  })

  it('atomically terminalizes competing HR replacements that share a predecessor', () => {
    expect(hrAuthorityMigration).toContain('update private.hr_document_upload_operations competing_operation')
    expect(hrAuthorityMigration).toContain("set state = 'rejected'")
    expect(hrAuthorityMigration).toContain('authority_superseded = true')
    expect(hrAuthorityMigration).toContain("failure_code = 'authority_superseded'")
    expect(hrAuthorityMigration).toContain(
      'competing_operation.prior_current_version_id\n      is not distinct from operation_record.prior_current_version_id',
    )
    expect(hrAuthorityMigration).toContain("and competing_operation.state in (\n      'initialized', 'quarantined', 'stored', 'scan_pending',")
    expect(hrAuthorityRegression).toContain('Both live replacements must bind the same verified predecessor')
    expect(hrAuthorityRegression).toContain('The competing loser must atomically become terminal and superseded')
    expect(hrAuthorityRegression).toContain('A superseded competing upload must never remain eligible for automatic recovery')
  })

  it('gets a row-locked client-document cleanup decision before deleting the exact object', () => {
    const handler = section('async function handleClientDocumentUpload(', 'async function handleClientDocumentAccess(')
    const deterministicGate = handler.indexOf('completionStarted && !completionFailureMayBeAmbiguous(error)')
    const cleanupDecision = handler.indexOf('reconcileRejectedCompletion(error)', deterministicGate)
    const exactIdentity = handler.indexOf("failureDecision.documentId === operation.documentId", cleanupDecision)
    const integrityCheck = handler.indexOf('inspectPrivateStorageObjectIntegrity', exactIdentity)
    const cleanup = handler.indexOf('deletePrivateStorageObject', integrityCheck)

    expect(cleanupDecision).toBeGreaterThan(deterministicGate)
    expect(exactIdentity).toBeGreaterThan(cleanupDecision)
    expect(integrityCheck).toBeGreaterThan(exactIdentity)
    expect(cleanup).toBeGreaterThan(integrityCheck)
    expect(handler).toContain("failureDecision.state === 'stored'")
    expect(handler).toContain('!failureDecision.cleanupAllowed')
  })

  it('serializes client-document completion and never authorizes cleanup of stored rows', () => {
    const prepareStart = clientUploadMigration.indexOf('create or replace function public.service_prepare_client_document_upload')
    const completionStart = clientUploadMigration.indexOf('create or replace function public.service_complete_client_document_upload')
    const cleanupStart = clientUploadMigration.indexOf('create or replace function public.service_reconcile_client_document_upload_failure')
    const prepare = clientUploadMigration.slice(prepareStart, completionStart)
    const completion = clientUploadMigration.slice(completionStart, cleanupStart)
    const cleanup = clientUploadMigration.slice(cleanupStart)

    expect(prepare).toContain('pg_advisory_xact_lock')
    expect(prepare).toContain('Upload request ID was already used with different document metadata.')
    expect(prepare).toContain('existing.access_classification is distinct from target_access_classification')
    expect(prepare).toContain('existing.sha256_checksum is distinct from lower(target_sha256_checksum)')
    expect(completion).toContain('for update;')
    expect(completion).toContain("if document_record.upload_state = 'stored'")
    expect(cleanup).toContain('for update;')
    expect(cleanup).toContain("'cleanupAllowed', document_record.upload_state = 'failed'")
  })

  it('prepares a durable profile-photo identity and preserves ambiguous completion outcomes', () => {
    const handler = section('export async function persistProfilePhotoUpload(', 'async function handleMyAccountApi(')
    const prepare = handler.indexOf("'service_prepare_employee_photo_upload_v2'")
    const deterministicIdentity = handler.indexOf('const candidatePath = `${employeeId}/${prepared.operationId}/${checksum}.${extension}`', prepare)
    const storage = handler.indexOf('storeIdempotentPrivateStorageObject', deterministicIdentity)
    const completion = handler.indexOf("'service_complete_employee_photo_upload_v2'", storage)
    const deterministicGate = handler.indexOf('!completionFailureMayBeAmbiguous(error)', completion)
    const authoritativeRead = handler.indexOf("'service_get_employee_photo_path'", deterministicGate)
    const integrityCheck = handler.indexOf('inspectPrivateStorageObjectIntegrity', authoritativeRead)
    const ambiguousOutcome = handler.slice(authoritativeRead)

    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(deterministicIdentity).toBeGreaterThan(prepare)
    expect(storage).toBeGreaterThan(deterministicIdentity)
    expect(completion).toBeGreaterThan(storage)
    expect(deterministicGate).toBeGreaterThan(completion)
    expect(authoritativeRead).toBeGreaterThan(deterministicGate)
    expect(integrityCheck).toBeGreaterThan(authoritativeRead)
    expect(handler.slice(deterministicGate, authoritativeRead)).not.toContain('deletePrivateStorageObject')
    expect(ambiguousOutcome).not.toContain('deletePrivateStorageObject')
    expect(ambiguousOutcome).toContain("'profile_photo_finalization_pending'")
    expect(handler).toContain('only an explicit row-locked conflict below authorizes cleanup')
  })

  it('durably reconciles a rejected signature appearance without request-local deletion', () => {
    const handler = section('async function handleMySignatureAction(', 'async function handleSignatureAuditCertificate(')
    const prepare = handler.indexOf("'service_prepare_signature_appearance_v2'")
    const deterministicIdentity = handler.indexOf('signatureAppearanceObjectKey(', prepare)
    const storage = handler.indexOf('storeIdempotentPrivateStorageObject', deterministicIdentity)
    const fencedAction = handler.indexOf("'service_record_signature_action_v2'", storage)
    const deterministicGate = handler.indexOf('!completionFailureMayBeAmbiguous(error)')
    const deterministicStateRead = handler.indexOf('const state = await readActionState()', deterministicGate)
    const deterministicReconciliation = handler.indexOf('result = await reconcileAppearance(state)', deterministicStateRead)
    const ambiguousInspection = handler.indexOf('inspectPrivateStorageObjectIntegrity', deterministicReconciliation)
    const appearanceMismatch = handler.indexOf('if (!appearanceIsAuthoritative)')
    expect(handler).toContain('result = await recordAction()')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(deterministicIdentity).toBeGreaterThan(prepare)
    expect(storage).toBeGreaterThan(deterministicIdentity)
    expect(fencedAction).toBeGreaterThan(storage)
    expect(deterministicGate).toBeGreaterThanOrEqual(0)
    expect(deterministicStateRead).toBeGreaterThan(deterministicGate)
    expect(deterministicReconciliation).toBeGreaterThan(deterministicStateRead)
    expect(handler.slice(deterministicGate, ambiguousInspection)).not.toContain('deletePrivateStorageObject')
    expect(appearanceMismatch).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("'service_reconcile_signature_appearance_v2'")
    expect(handler).toContain("operationState?.state !== 'cleanup_pending'")
    expect(handler).not.toContain('deletePrivateStorageObject')
    expect(ambiguousInspection).toBeGreaterThan(deterministicReconciliation)
    expect(handler).toContain('signature_action_finalization_pending')
  })

  it('reclaims protected cleanup leases and verifies exact objects before deletion', () => {
    const recovery = section('export async function recoverProtectedStorageCleanup(', 'async function recoverStoredSygSphereFiles(')
    const claim = recovery.indexOf("'service_list_protected_storage_cleanup_v2'")
    const inspection = recovery.indexOf('inspectPrivateStorageObjectIntegrity', claim)
    const deletion = recovery.indexOf('deletePrivateStorageObject', inspection)
    const completion = recovery.indexOf('await complete(candidate)', deletion)

    expect(recovery).toContain("'service_reconcile_stale_employee_photo_uploads_v2'")
    expect(recovery).toContain("'service_reconcile_stale_signature_appearances_v2'")
    expect(claim).toBeGreaterThanOrEqual(0)
    expect(inspection).toBeGreaterThan(claim)
    expect(deletion).toBeGreaterThan(inspection)
    expect(completion).toBeGreaterThan(deletion)
    expect(recovery).toContain("inspection === 'unknown' || inspection === 'mismatch'")
    expect(recovery).toContain("'service_defer_protected_storage_cleanup_v2'")
    expect(recovery).toContain("'service_complete_protected_storage_cleanup_v2'")
  })
})

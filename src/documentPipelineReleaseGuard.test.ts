import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const worker = readFileSync('worker/index.ts', 'utf8')
const immediateAvailabilityMigration = readFileSync('supabase/migrations/20260930215000_document_upload_immediate_availability.sql', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')
const workbench = readFileSync('src/components/DocumentWorkbench.tsx', 'utf8')

describe('protected document immediate availability', () => {
  it('makes valid HR documents available after protected storage and checksum verification', () => {
    expect(worker).toContain('requireDocumentStudioAccess(session.context)')
    expect(worker).toContain('await requireRecentHrMfa(request, session)')
    expect(worker).toContain('const validated = validateHrDocumentFile')
    expect(worker).toContain('const checksum = await sha256BytesHex(bytes)')
    expect(worker).toContain('await storePrivateDocument')
    expect(worker).toContain('const existingChecksum = await privateStorageChecksum(existing, bytes.byteLength)')
    expect(worker).toContain('await verifyPrivateStorageObjectChecksum(\n    config,\n    operation.bucket,')
    expect(worker).toContain('The stored private object does not match its approved SHA-256 checksum.')
    expect(worker).toContain("'service_mark_hr_document_upload_stored'")
    expect(immediateAvailabilityMigration).toContain("perform private.service_require_hr_document_permission(target_actor_id, target_vault_code, 'manage')")
    expect(immediateAvailabilityMigration).toContain('private.require_private_storage_object')
    expect(immediateAvailabilityMigration).toContain('storage.objects stored_object')
    expect(immediateAvailabilityMigration).toContain("'Upload completed after protected storage and checksum verification.'")
    expect(immediateAvailabilityMigration).toContain("'upload_available'")
    expect(immediateAvailabilityMigration).toContain('target_sha256_checksum')
  })

  it('keeps the availability transition service-only, idempotent, and auditable', () => {
    expect(immediateAvailabilityMigration).toContain("if (select auth.role()) <> 'service_role'")
    expect(immediateAvailabilityMigration).toContain("if operation_record.state = 'clean' then")
    expect(immediateAvailabilityMigration).toContain("'scan_error', 'storage_error') then")
    expect(immediateAvailabilityMigration).toContain('Document upload identity fields are immutable.')
    expect(immediateAvailabilityMigration).toContain("jsonb_build_object('operationId', operation_record.id, 'previousState', previous_state, 'state', 'clean')")
    expect(immediateAvailabilityMigration).toContain('private.hr_document_latest_availability_state')
    expect(immediateAvailabilityMigration).toContain('newly stored documents appear immediately without fabricating scan evidence')
    expect(immediateAvailabilityMigration).toContain("'public.service_get_hr_document_workspace(uuid,text,uuid,text,boolean,integer,integer)'::regprocedure")
    expect(immediateAvailabilityMigration).toContain('service_record_document_pipeline_availability_evidence')
    expect(worker).toContain("'service_record_document_pipeline_availability_evidence'")
    expect(worker).not.toContain("'service_record_document_pipeline_release_evidence'")
  })

  it('recovers only verified legacy HR uploads without reopening terminal records', () => {
    const recoveryStart = immediateAvailabilityMigration.indexOf(
      'create or replace function public.service_list_hr_document_availability_recovery',
    )
    const recoveryEnd = immediateAvailabilityMigration.indexOf(
      'create or replace function public.service_commit_signature_finalization',
      recoveryStart,
    )
    const recoveryRpc = immediateAvailabilityMigration.slice(recoveryStart, recoveryEnd)
    const workerRecoveryStart = worker.indexOf('async function recoverLegacyHrDocumentAvailability')
    const workerRecoveryEnd = worker.indexOf('async function recoverStoredSygSphereFiles', workerRecoveryStart)
    const workerRecovery = worker.slice(workerRecoveryStart, workerRecoveryEnd)

    expect(recoveryStart).toBeGreaterThanOrEqual(0)
    expect(recoveryEnd).toBeGreaterThan(recoveryStart)
    expect(recoveryRpc).toContain("if (select auth.role()) <> 'service_role'")
    expect(recoveryRpc).toContain("operation.state in ('quarantined', 'stored', 'scan_pending', 'scan_error')")
    expect(recoveryRpc).toContain('version.document_id = operation.document_id')
    expect(recoveryRpc).toContain('version.storage_bucket = operation.storage_bucket')
    expect(recoveryRpc).toContain('version.object_key = operation.object_key')
    expect(recoveryRpc).toContain("version.size_bytes between 1 and 26214400")
    expect(recoveryRpc).toContain("version.sha256_checksum ~ '^[a-f0-9]{64}$'")
    expect(recoveryRpc).not.toContain("'rejected'")
    expect(recoveryRpc).not.toContain("'cancelled'")
    expect(immediateAvailabilityMigration).toContain(
      'grant execute on function public.service_list_hr_document_availability_recovery(integer) to service_role;',
    )
    expect(workerRecoveryStart).toBeGreaterThanOrEqual(0)
    expect(workerRecovery).toContain("'service_list_hr_document_availability_recovery'")
    expect(workerRecovery).toContain('await verifyPrivateStorageObjectChecksum(config, bucket, objectKey, sizeBytes, expectedChecksum)')
    expect(workerRecovery).toContain("'service_mark_hr_document_upload_stored'")
    expect(workerRecovery.indexOf('await verifyPrivateStorageObjectChecksum')).toBeLessThan(
      workerRecovery.indexOf("'service_mark_hr_document_upload_stored'"),
    )
  })

  it('retires live scanner entrypoints instead of leaving a hidden fallback queue', () => {
    expect(immediateAvailabilityMigration).toContain('drop function if exists public.service_claim_hr_document_scan')
    expect(immediateAvailabilityMigration).toContain('drop function if exists public.service_record_hr_document_scan_result')
    expect(immediateAvailabilityMigration).toContain('drop function if exists public.service_claim_sygsphere_resumable_scan')
    expect(immediateAvailabilityMigration).toContain('drop function if exists public.service_complete_sygsphere_resumable_scan')
    expect(worker).not.toContain('DOCUMENT_SCAN_QUEUE')
    expect(worker).not.toContain('SYGSHIFT_DOCUMENT_SCANNER_SECRET')
  })

  it('supports company-owned records and refreshes documents immediately after save', () => {
    expect(workbench).toContain('Company documents')
    expect(workbench).toContain("employeeId: employeeId === 'company' ? null : employeeId")
    expect(workbench).toContain('Add to employee file')
    expect(page).toContain('New uploads appear here as soon as they are saved.')
    expect(page).toContain("queryClient.invalidateQueries({ queryKey: ['hr-documents'] })")
    expect(worker).toContain('renderOfficeDocumentPreview')
  })
})

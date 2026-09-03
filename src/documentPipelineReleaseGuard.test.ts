import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const worker = readFileSync('worker/index.ts', 'utf8')
const config = readFileSync('wrangler.jsonc', 'utf8')
const evidenceMigration = readFileSync('supabase/migrations/20260903001850_document_pipeline_scanner_release_evidence.sql', 'utf8')
const activationMigration = readFileSync('supabase/migrations/20260903001851_document_studio_controlled_activation.sql', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')

describe('protected document production release', () => {
  it('dispatches every stored HR document through the private scan queue', () => {
    expect(worker).toContain('await enqueueDocumentScan(environment, operation.operationId, requestId)')
    expect(worker).toContain('service_claim_hr_document_scan')
    expect(worker).toContain('service_record_hr_document_scan_result')
    expect(worker).toContain("if (result.state === 'rejected')")
    expect(worker).toContain('deletePrivateStorageObject(config, operation.bucket, operation.objectKey)')
    expect(config).toContain('"DOCUMENT_SCAN_QUEUE"')
    expect(config).toContain('"sygshift-document-scans-dlq"')
    expect(config).toContain('"max_batch_size": 1')
  })

  it('uses a private, pinned ClamAV container with bounded resources', () => {
    expect(config).toContain('"docker.io/clamav/clamav:1.5.4"')
    expect(config).toContain('"instance_type": "standard-1"')
    expect(config).toContain('"max_instances": 1')
    expect(worker).toContain('enableInternet = false')
    expect(worker).toContain('scanProcess.kill(9)')
    expect(worker).not.toContain('cursor: none')
  })

  it('requires clean, rejection, and storage recovery evidence before activation', () => {
    expect(evidenceMigration).toContain("'scanner_clean','scanner_reject','storage_recovery'")
    expect(evidenceMigration).toContain('document_pipeline_release_evidence_append_only')
    expect(activationMigration).toContain("evidence.evidence_type = 'scanner_clean'")
    expect(activationMigration).toContain("evidence.evidence_type = 'scanner_reject'")
    expect(activationMigration).toContain("evidence.evidence_type = 'storage_recovery'")
    expect(activationMigration).toContain("where gate in ('workspace','processing','signatures')")
  })

  it('supports company-owned records and automatically refreshes pending scans', () => {
    expect(page).toContain('Company / shared document')
    expect(page).toContain("employeeId: employeeId === 'company' ? null : employeeId")
    expect(page).toContain('refetchInterval:')
    expect(worker).toContain('renderOfficeDocumentPreview')
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const data = readFileSync(join(root, 'src', 'data', 'licensing.ts'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260902030000_secure_licensing_document_workflow.sql'),
  'utf8',
)

describe('secure licensing document workflow', () => {
  it('removes the browser-to-storage path that caused the production RLS failure', () => {
    expect(data).not.toContain("storage.from('credential-documents')")
    expect(data).toContain('/api/v1/licensing/credentials/')
    expect(worker).toContain('handleLicensingDocumentUpload')
    expect(worker).toContain('service_prepare_licensing_document_upload')
    expect(worker).toContain('service_complete_licensing_document_upload')
    expect(migration).toContain('drop policy if exists sygshift_credential_documents_privileged_access')
  })

  it('validates file content, exact permission, MFA, checksum, and idempotency at the server boundary', () => {
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
    expect(worker).toContain("['licensing.manage', 'directory.edit_credentials']")
    expect(worker).toContain('validateHrDocumentFile(bytes, metadata.originalFilename, metadata.declaredMimeType)')
    expect(worker).toContain('sha256BytesHex(bytes)')
    expect(migration).toContain('employee_credential_documents_upload_request_uidx')
    expect(migration).toContain("target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')")
  })

  it('keeps object paths server-only and audits every preview or download', () => {
    expect(data).toContain('getLicensingDocumentBlob')
    expect(data).not.toContain('storagePath:')
    expect(worker).toContain('service_authorize_licensing_document_access')
    expect(migration).toContain('LICENSING_DOCUMENT_PREVIEWED')
    expect(migration).toContain('LICENSING_DOCUMENT_DOWNLOADED')
    expect(migration).toContain('service_get_licensing_credential_documents')
  })

  it('provides compact in-app viewing and downloading without an unbounded list', () => {
    expect(page).toContain('View licensing document')
    expect(page).toContain('Download protected file')
    expect(page).toContain('setPageSize(Number(event.target.value) as 5 | 10 | 20)')
    expect(page).toContain('<option value={5}>5</option>')
    expect(page).toContain('<CredentialDocumentsModal')
    expect(styles).toContain('.licensing-document-list')
    expect(styles).toContain('.licensing-document-preview iframe')
  })
})

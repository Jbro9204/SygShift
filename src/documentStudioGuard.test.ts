import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260902202948_enterprise_document_studio.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const studioPage = readFileSync('src/components/DocumentStudioDashboard.tsx', 'utf8')
const employeePage = readFileSync('src/pages/MyDocumentsPage.tsx', 'utf8')
const viewer = readFileSync('src/components/SecurePdfViewer.tsx', 'utf8')

describe('enterprise Document Studio safeguards', () => {
  it('keeps every high-risk release gate closed by default', () => {
    expect(migration).toContain("('workspace', false), ('processing', false), ('signatures', false)")
    expect(migration).toContain("set enabled=false,enabled_at=null,enabled_by=null,evidence_reference=null")
    expect(migration).not.toContain('revoke all on storage.objects')
  })

  it('pins signature execution to an exact clean immutable source version', () => {
    expect(migration).toContain("private.hr_document_latest_scan_state(version_record.id)<>'clean'")
    expect(migration).toContain('document.current_version_id=envelope_record.document_version_id')
    expect(migration).toContain('sourceChecksum')
    expect(migration).toContain('final_package_checksum')
  })

  it('records consent, authentication evidence, immutable completion, and an audit certificate', () => {
    expect(migration).toContain('signature_authentication_evidence')
    expect(migration).toContain('signature_consent_records')
    expect(migration).toContain('signature_events_immutable')
    expect(migration).toContain('signature_audit_certificates_immutable')
    expect(worker).toContain('buildSignatureAuditCertificate')
    expect(worker).toContain('service_commit_signature_finalization')
  })

  it('preserves recorded signature evidence when PDF finalization must retry', () => {
    expect(worker).toContain('if (appearance && !actionRecorded)')
    expect(worker).toContain('processSignatureFinalizationJobs')
    expect(migration).toContain('service_list_signature_finalization_jobs')
    expect(migration).toContain("job_record.status='processing' and job_record.leased_at>clock_timestamp()-interval '10 minutes'")
    expect(migration).toContain("attempt_count>=5 then 'dead_letter'")
  })

  it('requires current consent and protected MFA-backed access for reusable signature images', () => {
    expect(migration).toContain('target_consent_version is distinct from policy_record.consent_version')
    expect(migration).toContain('service_get_my_signature_adoption_access')
    expect(migration).toContain("perform private.document_studio_require_recent_mfa(target_mfa_method,target_mfa_verified_at,interval '10 minutes')")
    expect(worker).toContain('saved_signature_integrity_failed')
    expect(employeePage).toContain('getSavedSignatureAppearance')
  })

  it('uses protected short-lived access instead of exposing storage URLs', () => {
    expect(worker).toContain('service_issue_my_signature_document_access_grant')
    expect(worker).toContain('/api/v1/hr/documents/access/${rawToken}')
    expect(worker).toContain("headers.set('cache-control', 'private, no-store, max-age=0')")
    expect(employeePage).not.toContain('/storage/v1/object/')
  })

  it('ships real management and employee execution surfaces with a PDF renderer', () => {
    expect(studioPage).toContain('Signature envelopes')
    expect(studioPage).toContain('New document policy version')
    expect(employeePage).toContain('Adopt your signature')
    expect(employeePage).toContain('Request correction')
    expect(viewer).toContain("from 'pdfjs-dist'")
    expect(viewer).toContain('Search document')
  })
})

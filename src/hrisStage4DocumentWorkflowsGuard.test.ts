/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260830200000_hris_stage4_document_workflows.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const managerPage = readFileSync('src/pages/HrisDocumentWorkflowsPage.tsx', 'utf8')
const employeePage = readFileSync('src/pages/MyDocumentsPage.tsx', 'utf8')
const data = readFileSync('src/data/hrDocumentWorkflows.ts', 'utf8')
const protectedTransport = readFileSync('src/data/hrDocuments.ts', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')

describe('HRIS Stage 4 protected document workflows', () => {
  it('preserves production access and leaves the release closed', () => {
    expect(migration).toContain('hris_stage4_run4_preservation_baseline')
    expect(migration).toContain('set enabled = false')
    expect(migration).not.toContain('insert into public.access_role_permissions')
    expect(migration).not.toContain('insert into public.employee_permission_overrides')
    expect(navigation).not.toContain("path: '/hr/documents/workflows'")
    expect(navigation).not.toContain("path: '/my-documents'")
  })

  it('binds assignments and evidence to an exact immutable clean version', () => {
    expect(migration).toContain('version_id uuid not null references private.hr_document_versions')
    expect(migration).toContain('unique (employee_id, document_id, version_id, requirement_type)')
    expect(migration).toContain("private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean'")
    expect(migration).toContain('document.current_version_id = assignment_record.version_id')
    expect(migration).toContain('hr_document_completion_evidence_append_only')
  })

  it('limits employee actions to their own assignment with recent MFA', () => {
    expect(migration).toContain('assignment.employee_id = target_actor_id')
    expect(migration).toContain("target_mfa_method not in ('authenticator','security_key')")
    expect(migration).toContain("target_mfa_verified_at < clock_timestamp() - interval '15 minutes'")
    expect(migration).toContain('private.hr_document_access_events')
    expect(worker).toContain('requireRecentDocumentMfa')
    expect(worker).toContain('handleMyHrDocumentAccessGrant')
    expect(worker).toContain('handleCompleteHrDocumentAssignment')
  })

  it('keeps protected documents out of browser storage APIs', () => {
    expect(data).not.toContain('storage.from(')
    expect(data).not.toContain('createSignedUrl')
    expect(data).toContain('documentApiRequest')
    expect(protectedTransport).toContain("cache: 'no-store'")
    expect(protectedTransport).toContain('fetchWithIdentityVerification')
    expect(data).toContain('/api/v1/hr/documents/assignments/${assignmentId}/access')
    expect(data).toContain('/api/v1/hr/documents/assignments/${id}/complete')
  })

  it('provides compact manager worklists and deliberate employee completion', () => {
    expect(managerPage).toContain('useState<PageSize>(10)')
    expect(managerPage).toContain('<option value={5}>5</option>')
    expect(managerPage).toContain('<option value={10}>10</option>')
    expect(managerPage).toContain('<option value={20}>20</option>')
    expect(managerPage).toContain('Required audit note')
    expect(employeePage).toContain('Complete only after reviewing the exact assigned document version.')
    expect(employeePage).toContain('Complete legal name')
    expect(employeePage).toContain('mutation.isPending')
  })
})

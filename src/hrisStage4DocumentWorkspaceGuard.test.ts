/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260830170000_hris_stage4_document_workspace.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')
const data = readFileSync('src/data/hrDocuments.ts', 'utf8')

describe('HRIS Stage 4 protected document workspace', () => {
  it('keeps the production release and access state dormant', () => {
    expect(migration).toContain('set enabled = false')
    expect(migration).not.toContain('insert into public.access_role_permissions')
    expect(migration).not.toContain('insert into public.employee_permission_overrides')
    expect(migration).toContain('hris_stage4_run3_preservation_baseline')
  })

  it('authorizes inventory at the database boundary', () => {
    expect(migration).toContain("auth.role()) <> 'service_role'")
    expect(migration).toContain('private.employee_effective_permissions(target_actor_id)')
    expect(migration).toContain("'hr.documents.view' = any(effective_permissions)")
    expect(migration).toContain('revoke all on function public.service_get_hr_document_workspace')
    expect(migration).toContain('to service_role')
  })

  it('keeps employee choices legal-name-only and operationally scoped', () => {
    expect(migration).toContain("employee.status in ('active', 'onboarding', 'leave')")
    expect(migration).toContain("concat_ws(' ', employee.first_name")
    expect(migration).not.toContain("coalesce(employee.preferred_name")
  })

  it('requires the release flag, authenticated session, and recent MFA in the Worker', () => {
    const start = worker.indexOf('async function handleHrDocumentWorkspace')
    const end = worker.indexOf('async function handleHrDocumentUpload', start)
    const handler = worker.slice(start, end)
    expect(handler).toContain('requireHrDocumentPipeline(environment)')
    expect(handler).toContain('requireAuthenticatedSession')
    expect(handler).toContain('requireRecentDocumentMfa')
    expect(handler).toContain("'service_get_hr_document_workspace'")
  })

  it('never exposes direct document storage paths to the browser', () => {
    expect(data).not.toContain('createSignedUrl')
    expect(data).not.toContain('storage.from(')
    expect(data).toContain('/api/v1/hr/documents/access/')
    expect(data).toContain("cache: 'no-store'")
    expect(data).toContain('idempotencyKey: input.idempotencyKey')
    expect(migration).toContain("version.detected_mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'text/plain')")
  })

  it('uses a compact inventory and deliberate modal workflows', () => {
    expect(page).toContain('pageSize: 10')
    expect(page).toContain('<option value={5}>5</option>')
    expect(page).toContain('<option value={10}>10</option>')
    expect(page).toContain('<option value={20}>20</option>')
    expect(page).toContain('aria-expanded={isExpanded}')
    expect(page).toContain('Upload HR document')
    expect(page).toContain('Open protected preview')
    expect(page).toContain('Download protected file')
  })
})

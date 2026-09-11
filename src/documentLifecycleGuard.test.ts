/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260912190000_hr_document_archive_restore.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const data = readFileSync('src/data/hrDocuments.ts', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')
const viewer = readFileSync('src/components/SecurePdfViewer.tsx', 'utf8')

describe('recoverable HR document lifecycle', () => {
  it('preserves files and audit history while supporting archive and restore', () => {
    expect(migration).toContain('service_set_hr_document_archived')
    expect(migration).toContain("'archive'")
    expect(migration).toContain("'restore'")
    expect(migration).toContain('insert into private.document_lifecycle_events')
    expect(migration).not.toMatch(/delete\s+from\s+private\.hr_documents/i)
    expect(migration).not.toMatch(/delete\s+from\s+private\.hr_document_versions/i)
  })

  it('keeps lifecycle writes behind service role, document permission, and recent HR MFA', () => {
    expect(migration).toContain("private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'manage')")
    expect(migration).toContain('revoke all on function public.service_set_hr_document_archived')
    expect(migration).toContain('to service_role')
    const start = worker.indexOf('async function handleHrDocumentArchive')
    const end = worker.indexOf('async function handleHrTemplateLibrary', start)
    const handler = worker.slice(start, end)
    expect(handler).toContain('requireDocumentStudioAccess(session.context)')
    expect(handler).toContain('requireRecentHrMfa(request, session)')
    expect(handler).toContain("'service_set_hr_document_archived'")
  })

  it('blocks removal that would hide active or immutable workflow evidence', () => {
    expect(migration).toContain('active legal hold')
    expect(migration).toContain('active employee assignment')
    expect(migration).toContain('completion evidence for an HR action')
    expect(migration).toContain('active signature request')
    expect(migration).toContain('source for a published company form')
    expect(migration).toContain('still being processed')
  })

  it('provides deliberate remove and restore controls without weakening PDF CSP', () => {
    expect(data).toContain('/archive`')
    expect(page).toContain('Remove from employee file')
    expect(page).toContain('Restore document')
    expect(page).toContain('Include archived')
    expect(viewer).toContain('if (bytes)')
    expect(worker).toContain("\"connect-src 'self' https://*.supabase.co wss://*.supabase.co\"")
    expect(worker).not.toContain("connect-src 'self' blob:")
  })
})

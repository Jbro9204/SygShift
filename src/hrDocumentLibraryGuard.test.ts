/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260902232050_searchable_hr_template_library.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const library = readFileSync('src/components/HrDocumentLibrary.tsx', 'utf8')
const employeePage = readFileSync('src/pages/MyDocumentsPage.tsx', 'utf8')
const studio = readFileSync('src/components/DocumentStudioDashboard.tsx', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')

describe('searchable HR document library', () => {
  it('reconciles the complete controlled v1.0 index without changing protected records', () => {
    expect(migration.match(/'GS-HR-\d{3}'/g)).toHaveLength(56)
    expect(migration).toContain("library_version, source_reference")
    expect(migration).toContain("'Guardianship HR Template Library v1.0 and GS-HR Template Register'")
    expect(migration).toContain('HR template library migration changed protected operational records.')
    expect(migration).not.toContain('insert into public.employee_access_roles')
    expect(migration).not.toContain('insert into public.access_role_permissions')
  })

  it('keeps catalog discovery separate from protected binary release', () => {
    expect(migration).toContain('private.hr_template_library_release_gate')
    expect(migration).toContain('private.hr_document_release_gate')
    expect(migration).toContain("then 'available'")
    expect(migration).toContain("else 'cataloged'")
    expect(migration).not.toMatch(/update\s+private\.hr_document_release_gate\s+set\s+enabled\s*=\s*true/i)
    expect(worker).toContain("if (url.pathname === '/api/v1/hr/documents/library')")
    const handler = worker.slice(worker.indexOf('async function handleHrTemplateLibrary'), worker.indexOf('async function handleHrDocumentScanCallback'))
    expect(handler).toContain('requireAuthenticatedSession')
    expect(handler).not.toContain('requireHrDocumentPipeline')
  })

  it('enforces role-aware results at the database boundary', () => {
    expect(migration).toContain('private.document_studio_require_actor(target_actor_id)')
    expect(migration).toContain("item.audience_scope = 'all_employees'")
    expect(migration).toContain("item.audience_scope = 'supervisors_and_hr' and can_see_supervisor")
    expect(migration).toContain("item.audience_scope = 'hr_only' and can_see_hr")
    expect(migration).toContain('using gin(search_vector)')
    expect(migration).toContain('revoke all on private.hr_template_library_items from public, anon, authenticated')
    expect(migration).toContain('grant execute on function public.service_get_hr_template_library')
  })

  it('provides compact discovery in employee and HR workspaces', () => {
    expect(library).toContain("useState<HrDocumentLibraryFilters>({ page: 1, pageSize: 10 })")
    expect(library).toContain('<option value={5}>5</option>')
    expect(library).toContain('<option value={10}>10</option>')
    expect(library).toContain('<option value={20}>20</option>')
    expect(library).toContain('Search by form name, code, purpose, or everyday terms')
    expect(library).toContain('PTO, emergency contact, injury, complaint, or payroll correction')
    expect(employeePage).toContain('<HrDocumentLibrary/>')
    expect(studio).toContain('<HrDocumentLibrary mode="studio"/>')
    expect(navigation).toContain("label: 'Document Library', path: '/my-documents?view=library'")
  })
})

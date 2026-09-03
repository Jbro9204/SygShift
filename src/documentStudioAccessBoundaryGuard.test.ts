/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const navigation = readFileSync('src/app/navigation.ts', 'utf8')
const accessPolicy = readFileSync('src/app/accessPolicy.ts', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const employeePage = readFileSync('src/pages/MyDocumentsPage.tsx', 'utf8')
const migration = readFileSync('supabase/migrations/20260903020750_restrict_document_studio_to_hr.sql', 'utf8')

function handler(name: string, nextName: string): string {
  const start = worker.indexOf(`async function ${name}`)
  const end = worker.indexOf(`async function ${nextName}`, start + 1)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return worker.slice(start, end)
}

describe('Document Studio access boundary', () => {
  it('uses one exact permission for navigation and both management routes', () => {
    expect(accessPolicy).toContain("export const documentStudioAccessPermission = 'documents.workspace.view'")
    expect(accessPolicy).toContain("'/hr/documents': { anyOf: [documentStudioAccessPermission] }")
    expect(accessPolicy).toContain("'/hr/documents/workflows': { anyOf: [documentStudioAccessPermission] }")
    expect(navigation).toContain('permissions: [documentStudioAccessPermission]')
    expect(navigation).toContain("label: 'My Documents', path: '/my-documents'")
  })

  it('keeps the employee workspace self-service only', () => {
    expect(employeePage).toContain('<h1>My Documents</h1>')
    expect(employeePage).toContain('getMyHrDocumentWorkspace')
    expect(employeePage).toContain('getMySignatureWorkspace')
    expect(employeePage).not.toContain('HrDocumentLibrary')
    expect(employeePage).not.toContain('getDocumentStudioWorkspace')
    expect(employeePage).not.toContain('Forms library')
  })

  it('requires the exact permission before MFA on every management endpoint', () => {
    const managementHandlers = [
      handler('handleHrDocumentUpload', 'handleHrDocumentWorkspace'),
      handler('handleHrDocumentWorkspace', 'handleHrTemplateLibrary'),
      handler('handleHrTemplateLibrary', 'handleHrDocumentScanCallback'),
      handler('handleHrDocumentAccessGrant', 'handleHrDocumentAccess'),
      handler('handleHrDocumentWorkflowWorkspace', 'handleMyHrDocumentWorkspace'),
      handler('handleCreateHrDocumentRequest', 'handleReviewHrDocumentRequest'),
      handler('handleReviewHrDocumentRequest', 'handleCreateHrDocumentAssignment'),
      handler('handleCreateHrDocumentAssignment', 'handleCancelHrDocumentAssignment'),
      handler('handleCancelHrDocumentAssignment', 'handleMyHrDocumentAccessGrant'),
      handler('handleDocumentStudioWorkspace', 'handleMySignatureWorkspace'),
      handler('handleDocumentStudioMutation', 'handleHrAutomationApi'),
    ]

    for (const body of managementHandlers) {
      expect(body).toContain('requireDocumentStudioAccess(session.context)')
      const permissionCheck = body.indexOf('requireDocumentStudioAccess(session.context)')
      const mfaCheck = body.indexOf('requireRecentDocumentMfa')
      if (mfaCheck >= 0) expect(permissionCheck).toBeLessThan(mfaCheck)
    }

    expect(handler('handleMyHrDocumentWorkspace', 'handleCreateHrDocumentRequest')).not.toContain('requireDocumentStudioAccess')
    expect(handler('handleMySignatureWorkspace', 'handleMyDocumentActionCount')).not.toContain('requireDocumentStudioAccess')
    expect(handler('handleMySignatureAccess', 'handleMySignatureAction')).not.toContain('requireDocumentStudioAccess')
  })

  it('enforces the boundary again inside Postgres without changing protected records', () => {
    expect(migration).toContain("if not ('documents.workspace.view' = any(effective_permissions))")
    expect(migration).toContain('create or replace function private.service_require_hr_document_permission')
    expect(migration).toContain('create or replace function private.document_studio_require_permission')
    expect(migration).toContain('create function public.service_get_hr_template_library')
    expect(migration).toContain('Document Studio access hardening changed protected records or permission assignments.')
    expect(migration).not.toContain('insert into public.employee_access_roles')
    expect(migration).not.toContain('insert into public.employee_permission_overrides')
    expect(migration).not.toContain('update public.access_role_permissions')
  })
})

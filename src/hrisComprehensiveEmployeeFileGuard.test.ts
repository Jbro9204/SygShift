/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260831234500_hris_comprehensive_employee_file.sql'), 'utf8')
const employeeFile = readFileSync(join(root, 'src', 'pages', 'HrisEmployeeFilePage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'hrisPeople.ts'), 'utf8')

describe('comprehensive Employee File guardrails', () => {
  it('enforces module permissions and release gates inside the database RPC', () => {
    expect(migration).toContain('private.require_hr_people_viewer()')
    expect(migration).toContain("public.has_effective_permission('hr.documents.view')")
    expect(migration).toContain("public.has_effective_permission('hr.compensation.view')")
    expect(migration).toContain("public.has_effective_permission('hr.cases.view')")
    expect(migration).toContain('private.hr_document_release_gate')
    expect(migration).toContain('private.hr_stage8_release_gates')
    expect(migration).toContain('private.hr_stage9_release_gates')
    expect(migration).toContain('from public, anon')
    expect(migration).toContain('to authenticated')
  })

  it('never returns compensation amounts from the general Employee File', () => {
    expect(migration).toContain("'activeRecords'")
    expect(migration).not.toContain('amount_cents')
    expect(migration).not.toContain('salary_amount')
    expect(employeeFile).toContain('Pay values remain restricted to the compensation workspace.')
  })

  it('uses the Employee File as one permission-aware index, not another editor', () => {
    expect(data).toContain('moduleAccess: z.object')
    expect(employeeFile).toContain('No information is copied or maintained twice.')
    expect(employeeFile).toContain('module.visible && canAccessRoute(module.path, sessionQuery.data)')
    expect(employeeFile).toContain('Employee File remains a review surface.')
    expect(employeeFile).not.toMatch(/useMutation|<input|<textarea/)
  })

  it('connects every major employee-record domain', () => {
    for (const path of [
      '/hr/documents',
      '/hr/onboarding',
      '/hr/leave',
      '/hr/benefits',
      '/hr/compensation',
      '/hr/talent-learning',
      '/hr/cases-compliance',
      '/hr/offboarding',
      '/hr/self-service',
    ]) expect(employeeFile).toContain(`path: '${path}'`)
    expect(employeeFile).toContain("label: 'Employee relations'")
    expect(employeeFile).toContain("label: 'Assigned assets'")
  })
})

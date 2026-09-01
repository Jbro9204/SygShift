/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260830023000_hris_stage3_people_workspace.sql'), 'utf8')
const workspace = readFileSync(join(root, 'src', 'pages', 'HrisPeopleWorkspacePage.tsx'), 'utf8')
const employeeFile = readFileSync(join(root, 'src', 'pages', 'HrisEmployeeFilePage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'hrisPeople.ts'), 'utf8')
const accessPolicy = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')

describe('HRIS Stage 3 People and HR guardrails', () => {
  it('enforces MFA, People permission, and separate restricted-data permission', () => {
    expect(migration).toContain('private.require_hr_people_viewer()')
    expect(migration).toContain('public.has_mfa()')
    expect(migration).toContain("public.has_effective_permission('hr.people.view')")
    expect(migration).toContain("public.has_effective_permission('hr.people.manage')")
    expect(migration).toContain("public.has_effective_permission('hr.people.restricted')")
    expect(migration).toContain('from public, anon')
    expect(migration).toContain('to authenticated')
  })

  it('uses legal names and never exposes preferred names in HR records', () => {
    expect(workspace).toContain('Legal names are used throughout this protected HR workspace.')
    expect(migration).not.toContain('preferred_name')
    expect(data).not.toContain('preferredName')
    expect(employeeFile).not.toContain('Preferred')
  })

  it('keeps results compact and server bounded', () => {
    expect(migration).toContain('safe_page_size integer := case when target_page_size in (5, 10, 15, 25) then target_page_size else 15 end')
    expect(migration).toContain('limit 5')
    expect(workspace).toContain('<option value={25}>25</option>')
    expect(workspace).not.toContain('<option value={50}>50</option>')
  })

  it('keeps the Employee File connected to established authoritative workspaces', () => {
    expect(employeeFile).toContain('Specialized records remain in their connected workspace so information is never maintained twice.')
    expect(employeeFile).toContain('EmployeeIdentityEditorDialog')
    expect(employeeFile).toContain('EmployeeEmploymentEditorDialog')
    expect(employeeFile).toContain('EmployeeContactEditorDialog')
    expect(employeeFile).toContain("path: '/licensing'")
    expect(employeeFile).toContain("path: '/availability'")
    expect(employeeFile).toContain("path: '/requests'")
    expect(employeeFile).toContain("path: '/users'")
    expect(employeeFile).toContain('canAccessRoute(workspace.path, sessionQuery.data)')
    expect(employeeFile).toContain('No information is copied or maintained twice.')
  })

  it('preserves permanent employee, identity, role, and permission records', () => {
    expect(migration).toContain('hris_stage3_people_preservation_baseline')
    expect(migration).toContain('employee_role_count')
    expect(migration).toContain('role_permission_count')
    expect(migration).toContain('override_count')
    expect(migration).toContain('person_identifier_count')
    expect(migration).toContain('worker_identifier_count')
    expect(migration).not.toMatch(/update\s+public\.employees/i)
    expect(migration).not.toMatch(/delete\s+from\s+public\.employees/i)
  })

  it('protects both People routes with the HR permission boundary', () => {
    expect(accessPolicy).toContain("'/hr': { anyOf: ['hr.people.view', 'hr.people.manage'] }")
    expect(accessPolicy).toContain("'/hr/people': { anyOf: ['hr.people.view', 'hr.people.manage'] }")
    expect(accessPolicy).toContain("'/hr/people/:employeeId': { anyOf: ['hr.people.view', 'hr.people.manage'] }")
  })
})

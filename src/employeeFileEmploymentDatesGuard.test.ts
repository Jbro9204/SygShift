/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260901210000_employee_file_employment_date_maintenance.sql'), 'utf8')
const employeeFile = readFileSync(join(root, 'src', 'pages', 'HrisEmployeeFilePage.tsx'), 'utf8')
const employmentDateEditor = readFileSync(join(root, 'src', 'components', 'EmploymentDateEditorDialog.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'hrisPeople.ts'), 'utf8')

describe('Employee File employment-date maintenance guardrails', () => {
  it('enforces active HR management, MFA, evidence, and append-only history in the database', () => {
    expect(migration).toContain('private.require_hris_stage2_manager()')
    expect(migration).toContain("public.has_effective_permission('hr.people.manage')")
    expect(migration).toContain('private.hr_stage2_effective_date_authorizations')
    expect(migration).toContain('supersedes_id')
    expect(migration).toContain('source reference')
    expect(migration).toContain('UPDATE_EMPLOYMENT_DATES')
    expect(migration).toContain('from public, anon')
    expect(migration).toContain('to authenticated')
  })

  it('validates start and separation dates without rewriting operational history', () => {
    expect(migration).toContain('A future start date is allowed only for an onboarding employee.')
    expect(migration).toContain('The separation or termination date cannot be before the start or hire date.')
    expect(migration).toContain('A separated employee requires a verified separation or termination date.')
    expect(migration).toContain('Use the Offboarding workflow to plan a future separation.')
    expect(migration).not.toMatch(/update\s+public\.shifts/i)
    expect(migration).not.toMatch(/update\s+public\.time_events/i)
    expect(migration).not.toMatch(/update\s+private\.payroll/i)
  })

  it('provides a compact, auditable Employee File editing experience', () => {
    expect(employeeFile).toContain('Start / hire date')
    expect(employeeFile).toContain('Separation / termination date')
    expect(employeeFile).toContain('EmploymentDateEditorDialog')
    expect(employmentDateEditor).toContain('Evidence and explanation are required')
    expect(employmentDateEditor).toContain('Existing schedules, punches, time cards, and payroll records will not be rewritten.')
    expect(data).toContain('target_limit: 5')
    expect(data).toContain('update_hr_employee_employment_dates')
  })

  it('protects the migration itself from changing production records', () => {
    expect(migration).toContain('employee_file_date_release_baseline')
    expect(migration).toContain('employee_fingerprint')
    expect(migration).toContain('effective_date_history_count')
    expect(migration).toContain('shift_count')
    expect(migration).toContain('time_event_count')
    expect(migration).toContain('payroll_batch_count')
    expect(migration).toContain('the migration was rolled back')
  })
})

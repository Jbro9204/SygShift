import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Licensing Status report release guardrails', () => {
  const page = read('src/reports/LicensingStatusReportWorkspace.tsx')
  const workbook = read('src/reports/licensingStatusWorkbook.ts')
  const migration = read('supabase/migrations/20260901230000_licensing_status_report_export.sql')

  it('adds the licensing report to Reports without granting timekeeping-report access', () => {
    expect(canAccessRoute('/reports/licensingStatus', { permissions: ['reports.view', 'licensing.view'] })).toBe(true)
    expect(page).toContain('Guard Licensing Status')
    expect(page).toContain('pageSizes = [10, 25, 50]')
    expect(page).toContain(": 'guards'")
    expect(page).toContain('legalLicensingEmployeeName(employee)')
  })

  it('requires verified licensing access and report export permission at the database boundary', () => {
    expect(migration).toContain("private.require_licensing_mfa('licensing.view')")
    expect(migration).toContain("public.has_effective_permission('licensing.view')")
    expect(migration).toContain("public.has_effective_permission('reports.export')")
    expect(migration).toContain('LICENSING_STATUS_REPORT_EXPORT')
    expect(migration).toContain("role.code = 'system_recruiting_licensing'")
  })

  it('exports a complete two-sheet workbook without notes, emails, or documents', () => {
    expect(workbook).toContain("name: 'Guard Status'")
    expect(workbook).toContain("name: 'Credential Detail'")
    expect(workbook).toContain("'Legal Employee Name'")
    expect(workbook).toContain("'Guard License Status'")
    expect(workbook).not.toContain('internalNotes')
    expect(workbook).not.toContain('employeeNotes')
    expect(workbook).not.toContain('personalEmail')
    expect(workbook).not.toContain('companyEmail')
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'
import { operationalReportDefinitions } from './reports/reportDefinitions'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Reports workspace guardrails', () => {
  it('preserves the approved eight operational reports alongside dedicated protected reports', () => {
    expect(operationalReportDefinitions).toHaveLength(8)
    expect(new Set(operationalReportDefinitions.map((report) => report.key)).size).toBe(8)
    for (const report of operationalReportDefinitions) {
      expect(report.summaryFields.length).toBeGreaterThan(0)
      expect(report.detailFields.length).toBeGreaterThanOrEqual(report.summaryFields.length)
      expect(report.canonicalPath).toMatch(/^\//)
    }
  })

  it('requires the effective reporting permission for both the library and nested reports', () => {
    expect(canAccessRoute('/reports', { permissions: ['time.reports.view'] })).toBe(true)
    expect(canAccessRoute('/reports/timekeepingExceptions', { permissions: ['time.reports.view'] })).toBe(true)
    expect(canAccessRoute('/reports', { permissions: ['time.view'] })).toBe(false)
    expect(canAccessRoute('/reports', { permissions: ['reports.view'] })).toBe(true)
    expect(canAccessRoute('/reports/licensingStatus', { permissions: ['reports.view'] })).toBe(true)
    expect(canAccessRoute('/reports/timekeepingExceptions', { permissions: ['time.view'] })).toBe(false)
  })

  it('keeps report browsing server-paginated, bounded, and read-only', () => {
    const page = read('src/pages/ReportsPage.tsx')
    const migration = read('supabase/migrations/20260828203000_reports_workspace_server_pagination.sql')

    expect(page).toContain('pageSizes = [10, 25, 50]')
    expect(page).toContain('getTimekeepingOperationsReportPage')
    expect(page).not.toContain('getTimekeepingOperationsReports')
    expect(page).toContain('Read-only report detail')
    expect(migration).toContain("private.timekeeping_require_permission('time.reports.view')")
    expect(migration).toContain('target_page_size not in (10, 25, 50)')
    expect(migration).toContain('limit target_page_size')
    expect(migration).toContain('offset (target_page - 1) * target_page_size')
  })

  it('authorizes the report-library summary through additive effective roles', () => {
    const migration = read('supabase/migrations/20260910090000_effective_role_operations_report_access.sql')
    const databaseRegression = read('supabase/tests/effective_role_operations_report_access.sql')

    expect(migration).toContain("public.has_effective_permission(''reports.view'')")
    expect(migration).toContain('Reports access with verified MFA is required')
    expect(migration).toContain('unexpected authorization boundary; refusing to rewrite it')
    expect(migration).toContain('execute repaired_definition')
    expect(migration).toContain('grant execute on function public.get_operations_report() to authenticated, service_role')
    expect(databaseRegression).toContain("employee.role not in ('supervisor', 'admin')")
    expect(databaseRegression).toContain('perform public.get_operations_report()')
    expect(databaseRegression).toContain('denied_without_permission')
    expect(databaseRegression).toContain('denied_without_mfa')
    expect(databaseRegression.trimEnd()).toMatch(/rollback;$/)
  })
})

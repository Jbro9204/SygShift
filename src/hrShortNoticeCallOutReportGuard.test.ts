import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('HR short-notice call-out report guardrails', () => {
  it('keeps the report behind HR reporting access in navigation and the nested route', () => {
    const page = read('src/pages/ReportsPage.tsx')
    expect(canAccessRoute('/reports/shortNoticeCallOuts', { permissions: ['hr.reporting.view'] })).toBe(true)
    expect(canAccessRoute('/reports/shortNoticeCallOuts', { permissions: ['time.reports.view'] })).toBe(false)
    expect(page).toContain("permissions.includes('hr.reporting.view')")
    expect(page).toContain("permissions.includes('hr.reporting.export')")
    expect(page).toContain("reportKey === 'shortNoticeCallOuts'")
  })

  it('enforces the strict four-hour boundary, MFA, effective permissions, and export auditing in the database', () => {
    const migration = read('supabase/migrations/20260921193740_hr_short_notice_call_out_report.sql')
    const regression = read('supabase/tests/hr_short_notice_call_out_report_regression.sql')
    expect(migration).toContain('not public.has_mfa()')
    expect(migration).toContain("public.has_effective_permission('hr.reporting.view')")
    expect(migration).toContain("public.has_effective_permission('hr.reporting.export')")
    expect(migration).toContain("shift.starts_at - interval '4 hours'")
    expect(migration).toContain('> shift.starts_at - interval')
    expect(migration).toContain('coalesce(report.call_received_at, report.reported_at)')
    expect(migration).toContain('insert into private.audit_events')
    expect(migration).toContain("'EXPORT'")
    expect(migration).toContain('revoke all on function public.get_hr_short_notice_call_out_report')
    expect(migration).toContain('to authenticated')
    expect(regression).toContain("'239-minute regression event'")
    expect(regression).toContain("'240-minute compliant boundary'")
    expect(regression).toContain("'no_call_no_show'")
    expect(regression).toContain('export_audit_after = export_audit_before + 1')
    expect(regression).toContain('A non-HR employee was able to open the protected HR report')
    expect(regression.trimEnd()).toMatch(/rollback;$/)
  })

  it('uses one visually uniform catalog-card structure for every report in the library', () => {
    const page = read('src/pages/ReportsPage.tsx')
    const styles = read('src/App.css')
    expect(page).toContain('function ReportCatalogCard')
    expect(page.match(/<ReportCatalogCard/g)?.length).toBeGreaterThanOrEqual(6)
    expect(styles).toContain('.reports-report-card__copy')
    expect(styles).toContain('.reports-report-card__action')
    expect(styles).toContain('grid-template-rows: minmax(0, 1fr) auto')
  })
})

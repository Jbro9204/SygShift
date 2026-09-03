import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Scheduled overtime forecast guardrails', () => {
  it('calculates future schedule overtime from the authoritative revision and excludes Dispatch overlap', () => {
    const migration = read('supabase/migrations/20260903154821_scheduled_overtime_forecast_report.sql')
    expect(migration).toContain("case schedule.status when 'draft' then 0 when 'published' then 1")
    expect(migration).toContain("private.shift_assignment_type(shift.id) = 'standard'")
    expect(migration).toContain('scheduled_minutes > 2400')
    expect(migration).toContain("count(*) filter (where requires_armed)")
    expect(migration).toContain("employee.employment_type = 'flex'")
    expect(migration).toContain("public.has_valid_credential(employee.id, 'armed_guard'")
  })

  it('protects view and export with MFA, permissions, grants, and export auditing', () => {
    const migration = read('supabase/migrations/20260903154821_scheduled_overtime_forecast_report.sql')
    expect(migration).toContain("private.timekeeping_require_permission('time.reports.view')")
    expect(migration).toContain("public.has_effective_permission('reports.export')")
    expect(migration).toContain("'SCHEDULED_OVERTIME_FORECAST_EXPORT'")
    expect(migration).toContain('revoke all on function public.get_scheduled_overtime_forecast(date) from public, anon, authenticated')
    expect(migration).toContain('grant execute on function public.get_scheduled_overtime_forecast(date) to authenticated')
  })

  it('preserves employee and scheduling records during release', () => {
    const migration = read('supabase/migrations/20260903154821_scheduled_overtime_forecast_report.sql')
    expect(migration).toContain('scheduled_overtime_forecast_release_baseline')
    expect(migration).toContain('employee_fingerprint')
    expect(migration).toContain('schedule_fingerprint')
    expect(migration).toContain('assignment_fingerprint')
    expect(migration).toContain('Scheduled overtime report release changed protected employee or schedule data.')
  })

  it('provides a focused UI and audited Excel export without confusing candidates with availability', () => {
    const page = read('src/pages/ReportsPage.tsx')
    const workspace = read('src/reports/ScheduledOvertimeForecastWorkspace.tsx')
    const workbook = read('src/reports/scheduledOvertimeForecastWorkbook.ts')
    expect(page).toContain('/reports/scheduledOvertimeForecast')
    expect(page).toContain("permissions.includes('time.reports.view')")
    expect(workspace).toContain('Scheduled Overtime Forecast')
    expect(workspace).toContain('Supplemental Dispatch phone duty is excluded')
    expect(workspace).toContain('Verify availability before assigning.')
    expect(workbook).toContain("name: 'Overtime Forecast'")
    expect(workbook).toContain("name: 'Shift Detail'")
    expect(workbook).toContain("name: 'Armed Flex Capacity'")
  })
})

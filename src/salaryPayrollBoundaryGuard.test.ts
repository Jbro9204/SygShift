import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260913211117_exclude_salary_from_hourly_payroll_review.sql'), 'utf8')
const teamPage = readFileSync(join(root, 'src', 'time', 'TimeTeamAttendancePage.tsx'), 'utf8')
const maintenancePage = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('salary payroll and focused timecard boundaries', () => {
  it('keeps salary defaults but removes salary punches and correction requests from hourly payroll review', () => {
    expect(migration).toContain("coalesce(item.value ->> 'employmentType', '') <> 'salary'")
    expect(migration).toContain("item.value ->> 'rowKind' = 'salary_default'")
    expect(migration).toContain("employee.employment_type <> 'salary'")
    expect(migration).toContain("'pendingCorrectionCount', jsonb_array_length(filtered_pending_corrections)")
    expect(migration).toContain("'overtimeMinutes', overtime_minutes")
    expect(migration).toContain("'regularPlusOvertimeMatchesPaid', paid_minutes = regular_minutes + overtime_minutes")
  })

  it('keeps the employee timecard heading synchronized with its editable date controls', () => {
    expect(maintenancePage).toContain("onPeriodChange?.({ fromDate, throughDate })")
    expect(teamPage).toContain("periodLabel(detailPeriod ?? { fromDate, throughDate })")
    expect(teamPage).toContain('onPeriodChange={setDetailPeriod}')
  })
})

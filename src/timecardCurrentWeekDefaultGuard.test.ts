import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const timePage = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')
const teamAttendancePage = readFileSync(join(root, 'src', 'time', 'TimeTeamAttendancePage.tsx'), 'utf8')

describe('timecard current-week defaults', () => {
  it('opens standalone Time Maintenance to the current payroll week', () => {
    expect(timePage).toContain("import { currentPayrollWeek } from '../time/timeRules'")
    expect(timePage).toContain('defaultPeriod ?? currentPayrollWeek()')
    expect(timePage).not.toContain('defaultPeriod ?? completedPayrollPeriod()')
  })

  it('opens Team Attendance to the current week and preserves deliberate ranges in the URL', () => {
    expect(teamAttendancePage).toContain('requestedPeriod ?? currentPayrollWeek()')
    expect(teamAttendancePage).toContain('currentPayrollWeek(undefined, rulesForWeek(rulesQuery.data))')
    expect(teamAttendancePage).toContain("nextSearchParams.set('from', period.fromDate)")
    expect(teamAttendancePage).toContain("nextSearchParams.set('through', period.throughDate)")
    expect(teamAttendancePage).toContain('setSearchParams(nextSearchParams, { replace: true })')
  })

  it('keeps explicit one-day review links authoritative', () => {
    expect(teamAttendancePage).toContain('defaultPeriod={{ fromDate, throughDate }}')
    expect(timePage).toContain('setFromDate(focusRequest.fromDate)')
    expect(timePage).toContain('setThroughDate(focusRequest.throughDate)')
  })
})

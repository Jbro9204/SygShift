/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const myTime = readFileSync(join(root, 'src', 'time', 'MyTimePage.tsx'), 'utf8')
const commandCenter = readFileSync(join(root, 'src', 'time', 'TimeCommandCenterPage.tsx'), 'utf8')

describe('employee pay-period range integrity', () => {
  it('loads an employee-safe authoritative payroll boundary before requesting My Time rows', () => {
    expect(myTime).toContain('queryFn: getPayrollPeriodContext')
    expect(myTime).toContain('periodQuery.isSuccess')
    expect(myTime).toContain('fromDate: payrollPeriod.fromDate')
    expect(myTime).toContain('throughDate: payrollPeriod.throughDate')
    expect(myTime).toContain("queryKey: ['my-time-review', dashboard?.employee.id, payrollPeriod.fromDate, payrollPeriod.throughDate]")
    expect(myTime).not.toContain('queryFn: getPayrollRules')
    expect(myTime).not.toContain('fromDate: defaultPeriod.fromDate')
  })

  it('keeps the displayed My Time dates identical to the returned review boundaries', () => {
    expect(myTime).toContain('{ fromDate: reviewQuery.data.fromDate, throughDate: reviewQuery.data.throughDate }')
  })

  it('loads the employee-safe boundary for Command Center views before requesting totals', () => {
    expect(commandCenter).toContain('sessionQuery.isSuccess && ownTimeAllowed')
    expect(commandCenter).toContain('Boolean(dashboardQuery.data) && periodQuery.isSuccess')
    expect(commandCenter).toContain('payrollPeriodFromBoundary(periodQuery.data)')
    expect(commandCenter).not.toContain('queryFn: getPayrollRules')
  })
})

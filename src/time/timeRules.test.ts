import { describe, expect, it } from 'vitest'
import { completedPayrollPeriod, currentPayrollPeriod, shiftPayrollPeriod } from './timeRules'

const biweeklyRules = {
  payDateAnchor: '2026-07-31',
  payFrequency: 'biweekly' as const,
  weekStartsOn: 0,
}

describe('payroll period rules', () => {
  it('anchors the active biweekly payroll period to the configured pay date', () => {
    expect(currentPayrollPeriod(new Date('2026-07-30T16:00:00.000Z'), biweeklyRules)).toMatchObject({
      fromDate: '2026-07-26',
      throughDate: '2026-08-08',
    })
  })

  it('finds the most recent closed payroll period for export', () => {
    expect(completedPayrollPeriod(new Date('2026-07-30T16:00:00.000Z'), biweeklyRules)).toMatchObject({
      fromDate: '2026-07-12',
      throughDate: '2026-07-25',
    })
  })

  it('moves selected payroll ranges by full pay periods', () => {
    const selected = { fromDate: '2026-07-26' }

    expect(shiftPayrollPeriod(selected, -1, biweeklyRules)).toMatchObject({
      fromDate: '2026-07-12',
      throughDate: '2026-07-25',
    })
    expect(shiftPayrollPeriod(selected, 1, biweeklyRules)).toMatchObject({
      fromDate: '2026-08-09',
      throughDate: '2026-08-22',
    })
  })
})

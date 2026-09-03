import { describe, expect, it } from 'vitest'
import { completedPayrollPeriod, currentPayrollPeriod, currentPayrollWeek, payrollPeriodFromBoundary, shiftPayrollPeriod } from './timeRules'

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

  it('returns the current Sunday through Saturday payroll week independently of pay frequency', () => {
    expect(currentPayrollWeek(new Date('2026-08-26T16:00:00.000Z'), biweeklyRules)).toMatchObject({
      fromDate: '2026-08-23',
      throughDate: '2026-08-29',
    })
  })

  it('keeps Sunday inside the new current week', () => {
    expect(currentPayrollWeek(new Date('2026-08-23T16:00:00.000Z'), biweeklyRules)).toMatchObject({
      fromDate: '2026-08-23',
      throughDate: '2026-08-29',
    })
  })

  it('uses the server-resolved employee-safe boundary without recalculating its dates', () => {
    expect(payrollPeriodFromBoundary({
      fromDate: '2026-08-23',
      throughDate: '2026-09-05',
      serverTimestamp: '2026-09-03T01:30:00.000Z',
    })).toEqual({
      daysRemaining: 3,
      fromDate: '2026-08-23',
      status: 'open',
      throughDate: '2026-09-05',
    })
  })
})

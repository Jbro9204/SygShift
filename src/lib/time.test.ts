import { describe, expect, it } from 'vitest'
import {
  formatDualClockTime,
  formatDualTime,
  formatDualTimeRange,
  formatOperationalDateTime,
  formatOperationalDate,
  formatOperationalTime,
  lastCompletedPayrollWeek,
  operationalToday,
} from './time'

describe('operational time', () => {
  it('uses the Colorado calendar date near the UTC boundary', () => {
    const date = operationalToday(new Date('2026-01-15T06:30:00.000Z'))

    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(0)
    expect(date.getDate()).toBe(14)
  })

  it('labels the date and time in Mountain Time', () => {
    const instant = new Date('2026-07-03T18:45:00.000Z')

    expect(formatOperationalDate(instant)).toBe('Friday, 07/03/2026')
    expect(formatOperationalTime(instant)).toMatch(/^12:45 PM \(12:45\) MDT$/)
  })

  it('shows civilian and military time together for operational displays', () => {
    expect(formatDualTime(new Date('2026-07-03T20:00:00.000Z'))).toBe('2:00 PM (14:00)')
    expect(formatDualTimeRange('2026-07-03T20:00:00.000Z', '2026-07-04T04:00:00.000Z')).toBe('2:00 PM (14:00) – 10:00 PM (22:00)')
    expect(formatDualClockTime('00:30')).toBe('12:30 AM (00:30)')
    expect(formatDualClockTime('14:00')).toBe('2:00 PM (14:00)')
    expect(formatOperationalDateTime('2026-07-03T20:00:00.000Z')).toBe('07/03/2026, 2:00 PM (14:00)')
  })

  it('returns the last fully closed Sunday-through-Saturday payroll week', () => {
    expect(lastCompletedPayrollWeek(new Date('2026-07-28T16:00:00.000Z'))).toMatchObject({
      fromLabel: '07/19/2026',
      throughLabel: '07/25/2026',
    })

    expect(lastCompletedPayrollWeek(new Date('2026-08-01T16:00:00.000Z'))).toMatchObject({
      fromLabel: '07/19/2026',
      throughLabel: '07/25/2026',
    })
  })
})

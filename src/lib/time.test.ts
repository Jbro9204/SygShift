import { describe, expect, it } from 'vitest'
import {
  formatCompactDualTime,
  formatDualClockTime,
  formatDualTime,
  formatDualTimeRange,
  formatOperationalDateTime,
  formatOperationalDate,
  formatOperationalTime,
  formatTimeZoneClock,
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

  it('shows compact secondary military time only when the hour is genuinely different', () => {
    const timeZone = 'America/Denver'
    expect(formatCompactDualTime('2026-07-03T15:41:00.000Z', timeZone)).toBe('9:41 AM')
    expect(formatCompactDualTime('2026-07-03T16:15:00.000Z', timeZone)).toBe('10:15 AM')
    expect(formatCompactDualTime('2026-07-03T18:20:00.000Z', timeZone)).toBe('12:20 PM')
    expect(formatCompactDualTime('2026-07-03T19:00:00.000Z', timeZone)).toBe('1:00 PM (13:00)')
    expect(formatCompactDualTime('2026-07-03T22:35:00.000Z', timeZone)).toBe('4:35 PM (16:35)')
    expect(formatCompactDualTime('2026-07-04T05:59:00.000Z', timeZone)).toBe('11:59 PM (23:59)')
    expect(formatCompactDualTime('2026-07-04T06:10:00.000Z', timeZone)).toBe('12:10 AM (00:10)')
  })

  it('derives daylight and standard abbreviations for every supported zone', () => {
    const zones = [
      ['America/New_York', 'EDT', 'EST'],
      ['America/Chicago', 'CDT', 'CST'],
      ['America/Denver', 'MDT', 'MST'],
      ['America/Los_Angeles', 'PDT', 'PST'],
    ] as const
    for (const [timeZone, daylight, standard] of zones) {
      expect(formatTimeZoneClock('2026-07-03T18:00:00.000Z', timeZone).abbreviation).toBe(daylight)
      expect(formatTimeZoneClock('2026-01-03T18:00:00.000Z', timeZone).abbreviation).toBe(standard)
    }
  })

  it('calculates each clock date independently across a U.S. date boundary', () => {
    const instant = '2026-07-04T04:30:00.000Z'
    expect(formatTimeZoneClock(instant, 'America/New_York').date).toBe('Sat, 07/04/2026')
    expect(formatTimeZoneClock(instant, 'America/Los_Angeles').date).toBe('Fri, 07/03/2026')
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

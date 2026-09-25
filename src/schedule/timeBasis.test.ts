import { describe, expect, it } from 'vitest'
import {
  formatScheduleTimeZoneRange,
  scheduleCalendarDateInTimeZone,
  scheduleTimeBasisLabel,
  scheduleWallClockRangeToInstants,
  scheduleWallClockToInstant,
} from './timeBasis'

describe('schedule time-basis contract', () => {
  it('moves the personal calendar date at midnight in the employee profile zone', () => {
    const beforeMidnight = scheduleCalendarDateInTimeZone(
      '2026-09-27T03:59:59.000Z',
      'America/New_York',
    )
    const afterMidnight = scheduleCalendarDateInTimeZone(
      '2026-09-27T04:00:00.000Z',
      'America/New_York',
    )

    expect([
      beforeMidnight.getFullYear(),
      beforeMidnight.getMonth() + 1,
      beforeMidnight.getDate(),
    ]).toEqual([2026, 9, 26])
    expect([
      afterMidnight.getFullYear(),
      afterMidnight.getMonth() + 1,
      afterMidnight.getDate(),
    ]).toEqual([2026, 9, 27])
  })

  it('converts an Eastern employee wall-clock shift to the same Mountain site instant', () => {
    const range = scheduleWallClockRangeToInstants(
      '2026-09-25',
      '09:00',
      '17:00',
      'America/New_York',
    )

    expect(range).toEqual({
      startsAt: '2026-09-25T13:00:00.000Z',
      endsAt: '2026-09-25T21:00:00.000Z',
    })
    expect(formatScheduleTimeZoneRange(range.startsAt, range.endsAt, 'America/New_York'))
      .toBe('09/25/2026 · 9:00 AM (09:00)–5:00 PM (17:00)')
    expect(formatScheduleTimeZoneRange(range.startsAt, range.endsAt, 'America/Denver'))
      .toBe('09/25/2026 · 7:00 AM (07:00)–3:00 PM (15:00)')
  })

  it('keeps overnight end dates in the selected time basis', () => {
    expect(scheduleWallClockRangeToInstants(
      '2026-09-25',
      '22:00',
      '06:00',
      'America/Chicago',
    )).toEqual({
      startsAt: '2026-09-26T03:00:00.000Z',
      endsAt: '2026-09-26T11:00:00.000Z',
    })
  })

  it('keeps an existing site-basis instant when only the assigned employee changes', () => {
    const existingBasisRange = scheduleWallClockRangeToInstants(
      '2026-09-25',
      '07:00',
      '15:00',
      'America/Denver',
    )

    expect(existingBasisRange.startsAt).toBe('2026-09-25T13:00:00.000Z')
    expect(formatScheduleTimeZoneRange(
      existingBasisRange.startsAt,
      existingBasisRange.endsAt,
      'America/New_York',
    )).toBe('09/25/2026 · 9:00 AM (09:00)–5:00 PM (17:00)')
  })

  it('blocks a nonexistent daylight-saving wall-clock time instead of silently moving it', () => {
    expect(() => scheduleWallClockToInstant(
      '2026-03-08',
      '02:30',
      'America/New_York',
    )).toThrow('does not exist')
  })

  it('matches PostgreSQL by choosing standard time when the fall-back hour repeats', () => {
    expect(scheduleWallClockToInstant(
      '2026-11-01',
      '01:30',
      'America/New_York',
    )).toBe('2026-11-01T06:30:00.000Z')
  })

  it('names employee, site, and preserved recorded bases explicitly', () => {
    expect(scheduleTimeBasisLabel('employee', 'America/New_York')).toBe('Employee Time — Eastern')
    expect(scheduleTimeBasisLabel('site', 'America/Denver')).toBe('Site Time — Mountain')
    expect(scheduleTimeBasisLabel('explicit', 'America/Chicago')).toBe('Recorded Time — Central')
  })
})

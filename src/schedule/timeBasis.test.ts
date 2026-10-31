import { describe, expect, it, vi } from 'vitest'
import {
  formatScheduleTimeZoneRange,
  scheduleCalendarDateInTimeZone,
  scheduleTimeBasisLabel,
  runAfterScheduleWallClockPreflight,
  scheduleWallClockRangeToInstants,
  scheduleWallClockRangesForDates,
  scheduleWallClockToInstant,
  possibleScheduleWallClockInstants,
  inspectScheduleWallClockRange,
  inspectScheduleWallClockRangesForDates,
  requireScheduleRepeatedTimeConfirmation,
  scheduleRepeatedTimeConfirmationKey,
  storedScheduleRepeatedTimeEditError,
  formatScheduleInstantOffset,
  scheduleElapsedTimeLabel,
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

  it('validates every repeated date before creation and identifies a later DST gap', () => {
    expect(() => scheduleWallClockRangesForDates(
      ['2026-03-07', '2026-03-08'],
      '02:30',
      '03:30',
      'America/New_York',
    )).toThrow('03/08/2026: That local time does not exist')
  })

  it('does not create an earlier repeated date when a later date is in a DST gap', async () => {
    const createBatch = vi.fn(async (dateKeys: string[]) => dateKeys)

    await expect(runAfterScheduleWallClockPreflight(
      ['2026-03-07', '2026-03-08'],
      '02:30',
      '03:30',
      'America/New_York',
      createBatch,
    )).rejects.toThrow('03/08/2026: That local time does not exist')

    expect(createBatch).not.toHaveBeenCalled()
  })

  it('submits every validated repeated date in one batch operation', async () => {
    const createBatch = vi.fn(async (dateKeys: string[]) => dateKeys)

    await expect(runAfterScheduleWallClockPreflight(
      ['2026-03-09', '2026-03-10'],
      '09:00',
      '17:00',
      'America/New_York',
      createBatch,
    )).resolves.toEqual(['2026-03-09', '2026-03-10'])

    expect(createBatch).toHaveBeenCalledOnce()
    expect(createBatch).toHaveBeenCalledWith(['2026-03-09', '2026-03-10'])
  })

  it('matches PostgreSQL by choosing standard time when the fall-back hour repeats', () => {
    expect(scheduleWallClockToInstant(
      '2026-11-01',
      '01:30',
      'America/New_York',
    )).toBe('2026-11-01T06:30:00.000Z')
  })

  it.each([
    ['America/New_York', ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']],
    ['America/Chicago', ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z']],
    ['America/Denver', ['2026-11-01T07:30:00.000Z', '2026-11-01T08:30:00.000Z']],
    ['America/Los_Angeles', ['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']],
    ['America/Phoenix', ['2026-11-01T08:30:00.000Z']],
  ])('identifies the exact possible instants in %s without inventing a Phoenix transition', (zone, expected) => {
    expect(possibleScheduleWallClockInstants('2026-11-01', '01:30', zone)).toEqual(expected)
  })

  it('exposes both endpoint offsets and actual elapsed hours for overnight DST coverage', () => {
    const fall = inspectScheduleWallClockRange('2026-10-31', '22:00', '06:00', 'America/Denver')
    const spring = inspectScheduleWallClockRange('2026-03-07', '22:00', '06:00', 'America/Denver')
    const arizona = inspectScheduleWallClockRange('2026-10-31', '22:00', '06:00', 'America/Phoenix')
    expect(scheduleElapsedTimeLabel(fall.startsAt, fall.endsAt)).toBe('9h elapsed before breaks')
    expect(scheduleElapsedTimeLabel(spring.startsAt, spring.endsAt)).toBe('7h elapsed before breaks')
    expect(scheduleElapsedTimeLabel(arizona.startsAt, arizona.endsAt)).toBe('8h elapsed before breaks')
    expect(formatScheduleInstantOffset(fall.startsAt, 'America/Denver')).toBe('MDT (UTC-06:00)')
    expect(formatScheduleInstantOffset(fall.endsAt, 'America/Denver')).toBe('MST (UTC-07:00)')
  })

  it('requires explicit confirmation for repeated starts and overnight repeated ends in every selected date', () => {
    const ranges = inspectScheduleWallClockRangesForDates(['2026-10-31', '2026-11-01'], '01:30', '03:00', 'America/New_York')
    expect(ranges[0].repeatedTimes).toEqual([])
    expect(ranges[1].repeatedTimes[0]).toMatchObject({ endpoint: 'Start', selectedInstant: '2026-11-01T06:30:00.000Z' })
    expect(() => requireScheduleRepeatedTimeConfirmation(ranges, 'America/New_York', null)).toThrow('Confirm the second')
    const key = scheduleRepeatedTimeConfirmationKey(ranges, 'America/New_York')
    expect(() => requireScheduleRepeatedTimeConfirmation(ranges, 'America/New_York', key)).not.toThrow()
    const changed = inspectScheduleWallClockRangesForDates(['2026-10-31', '2026-11-01'], '01:45', '03:00', 'America/New_York')
    expect(() => requireScheduleRepeatedTimeConfirmation(changed, 'America/New_York', key)).toThrow('Confirm the second')
    const end = inspectScheduleWallClockRange('2026-10-31', '22:00', '01:30', 'America/New_York')
    expect(end.repeatedTimes[0]).toMatchObject({ endpoint: 'End', dateKey: '2026-11-01', selectedInstant: '2026-11-01T06:30:00.000Z' })
  })

  it('binds repeated-time confirmation to all dates and the zone, including otherwise ordinary repeated dates', () => {
    const first = inspectScheduleWallClockRangesForDates(['2026-11-01', '2026-11-02'], '01:30', '03:00', 'America/New_York')
    const key = scheduleRepeatedTimeConfirmationKey(first, 'America/New_York')
    const changedDates = inspectScheduleWallClockRangesForDates(['2026-11-01', '2026-11-03'], '01:30', '03:00', 'America/New_York')
    expect(scheduleRepeatedTimeConfirmationKey(changedDates, 'America/New_York')).not.toBe(key)
    const changedZone = inspectScheduleWallClockRangesForDates(['2026-11-01', '2026-11-02'], '01:30', '03:00', 'America/Denver')
    expect(scheduleRepeatedTimeConfirmationKey(changedZone, 'America/Denver')).not.toBe(key)
  })

  it('preserves an existing second-fold range and blocks silent first-fold reinterpretation', () => {
    const requested = inspectScheduleWallClockRange('2026-11-01', '01:30', '03:00', 'America/New_York')
    expect(storedScheduleRepeatedTimeEditError(requested, requested, 'America/New_York')).toBeNull()
    expect(storedScheduleRepeatedTimeEditError({ startsAt: '2026-11-01T05:30:00.000Z', endsAt: requested.endsAt }, requested, 'America/New_York'))
      .toContain('first occurrence')
    const overnight = inspectScheduleWallClockRange('2026-10-31', '22:00', '01:30', 'America/New_York')
    expect(storedScheduleRepeatedTimeEditError({ startsAt: overnight.startsAt, endsAt: '2026-11-01T05:30:00.000Z' }, overnight, 'America/New_York'))
      .toContain('first occurrence')
  })

  it('keeps spring gaps rejected throughout inspection, including a later repeated date', () => {
    expect(() => inspectScheduleWallClockRangesForDates(['2026-03-07', '2026-03-08'], '02:30', '03:30', 'America/Denver'))
      .toThrow('03/08/2026: That local time does not exist')
  })

  it('names employee, site, and preserved recorded bases explicitly', () => {
    expect(scheduleTimeBasisLabel('employee', 'America/New_York')).toBe('Employee Time — Eastern')
    expect(scheduleTimeBasisLabel('site', 'America/Denver')).toBe('Site Time — Mountain')
    expect(scheduleTimeBasisLabel('explicit', 'America/Chicago')).toBe('Recorded Time — Central')
  })
})

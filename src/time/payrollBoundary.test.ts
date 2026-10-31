import { describe, expect, it } from 'vitest'
import {
  allocateIntervalByPayrollWeek,
  elapsedMinutes,
  getPayrollBatchWeek,
  PAYROLL_BATCH_POLICY_VERSION,
  payrollDateRangeInstants,
  reconcilePayrollMinutes,
  resolvePayrollOccurrenceAssignment,
  shiftDateKey,
  type PayrollOccurrenceInput,
} from './payrollBoundary'

const denver = { timeZone: 'America/Denver', weekStartsOn: 0, weekStartMinutes: 0 }
const occurrence = (overrides: Partial<PayrollOccurrenceInput> = {}): PayrollOccurrenceInput => ({
  employeeId: 'employee-1',
  shiftId: 'shift-1',
  scheduledStart: '2026-08-16T04:00:00.000Z', // Saturday 10:00 PM MDT
  scheduledEnd: '2026-08-16T12:00:00.000Z',
  actualClockIn: '2026-08-16T04:00:00.000Z',
  actualClockOut: '2026-08-16T12:00:00.000Z',
  ...overrides,
})

describe('payroll batch week assignment', () => {
  it('labels active boundary allocations with the v2 payroll policy', () => {
    expect(PAYROLL_BATCH_POLICY_VERSION).toBe('payroll-batch-v2')
  })

  it('allocates one canonical Saturday-night interval across the Sunday midnight boundary', () => {
    expect(allocateIntervalByPayrollWeek(
      '2026-09-06T04:00:00.000Z',
      '2026-09-06T12:00:00.000Z',
      denver,
    )).toEqual([{
      minutes: 120,
      weekEndsOn: '2026-09-05',
      weekStartsOn: '2026-08-30',
    }, {
      minutes: 360,
      weekEndsOn: '2026-09-12',
      weekStartsOn: '2026-09-06',
    }])
  })

  it('awards an equal sub-minute rounding remainder to the earlier payroll week', () => {
    expect(allocateIntervalByPayrollWeek(
      '2026-09-06T05:59:30.000Z',
      '2026-09-06T06:00:30.000Z',
      denver,
    )).toEqual([{
      minutes: 1,
      weekEndsOn: '2026-09-05',
      weekStartsOn: '2026-08-30',
    }, {
      minutes: 0,
      weekEndsOn: '2026-09-12',
      weekStartsOn: '2026-09-06',
    }])
  })

  it('allocates actual elapsed time across the spring DST payroll-week boundary', () => {
    expect(allocateIntervalByPayrollWeek(
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T10:00:00.000Z',
      denver,
    )).toEqual([{
      minutes: 60,
      weekEndsOn: '2026-03-07',
      weekStartsOn: '2026-03-01',
    }, {
      minutes: 180,
      weekEndsOn: '2026-03-14',
      weekStartsOn: '2026-03-08',
    }])
  })

  it('allocates actual elapsed time across the fall DST payroll-week boundary', () => {
    expect(allocateIntervalByPayrollWeek(
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T11:00:00.000Z',
      denver,
    )).toEqual([{
      minutes: 60,
      weekEndsOn: '2026-10-31',
      weekStartsOn: '2026-10-25',
    }, {
      minutes: 300,
      weekEndsOn: '2026-11-07',
      weekStartsOn: '2026-11-01',
    }])
  })

  it('keeps Saturday 10 PM to Sunday 6 AM in the previous week with all eight hours', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence(), denver)
    expect(result.weekStartsOn).toBe('2026-08-09')
    expect(result.crossesPayrollBoundary).toBe(true)
    expect(elapsedMinutes(occurrence().actualClockIn!, occurrence().actualClockOut!)).toBe(480)
  })

  it('keeps Saturday 6 PM to Sunday 6 AM in the previous week with all twelve hours', () => {
    const input = occurrence({ scheduledStart: '2026-08-16T00:00:00.000Z', actualClockIn: '2026-08-16T00:00:00.000Z' })
    expect(resolvePayrollOccurrenceAssignment(input, denver).weekStartsOn).toBe('2026-08-09')
    expect(elapsedMinutes(input.actualClockIn!, input.actualClockOut!)).toBe(720)
  })

  it('puts a Sunday midnight shift in the new week', () => {
    expect(resolvePayrollOccurrenceAssignment(occurrence({ scheduledStart: '2026-08-16T06:00:00.000Z' }), denver).weekStartsOn).toBe('2026-08-16')
  })

  it('puts a Sunday 6 PM to Monday 6 AM shift in the new week', () => {
    expect(resolvePayrollOccurrenceAssignment(occurrence({ scheduledStart: '2026-08-17T00:00:00.000Z', scheduledEnd: '2026-08-17T12:00:00.000Z' }), denver).weekStartsOn).toBe('2026-08-16')
  })

  it('uses a Sunday scheduled start despite a Saturday 11:57 PM early punch', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence({ scheduledStart: '2026-08-16T06:00:00.000Z', actualClockIn: '2026-08-16T05:57:00.000Z' }), denver)
    expect(result.weekStartsOn).toBe('2026-08-16')
    expect(result.source).toBe('scheduled_shift')
  })

  it('uses a Saturday scheduled start despite a Sunday 12:03 AM late punch', () => {
    expect(resolvePayrollOccurrenceAssignment(occurrence({ actualClockIn: '2026-08-16T06:03:00.000Z' }), denver).weekStartsOn).toBe('2026-08-09')
  })

  it('uses actual clock-in for legitimate unscheduled Sunday work', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence({ shiftId: null, scheduledStart: null, scheduledEnd: null, actualClockIn: '2026-08-16T06:03:00.000Z' }), denver)
    expect(result.weekStartsOn).toBe('2026-08-16')
    expect(result.source).toBe('unscheduled_actual_punch')
  })

  it('uses the parent shift for a replacement employee', () => {
    expect(resolvePayrollOccurrenceAssignment(occurrence({ replacementAssignment: true }), denver).source).toBe('replacement_assignment')
  })

  it('uses the scheduled shift for a linked manual entry', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence({ manualEntry: true, manualClockIn: '2026-08-16T06:05:00.000Z' }), denver)
    expect(result.source).toBe('manual_linked_shift')
    expect(result.weekStartsOn).toBe('2026-08-09')
  })

  it('uses manual clock-in for a standalone manual entry', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence({ shiftId: null, scheduledStart: null, manualEntry: true, manualClockIn: '2026-08-16T06:05:00.000Z' }), denver)
    expect(result.source).toBe('manual_entry')
    expect(result.weekStartsOn).toBe('2026-08-16')
  })

  it('keeps a post-midnight break with its parent occurrence', () => {
    const parent = resolvePayrollOccurrenceAssignment(occurrence(), denver)
    expect(getPayrollBatchWeek('2026-08-16T08:00:00.000Z', denver).weekStartsOn).toBe('2026-08-16')
    expect(parent.weekStartsOn).toBe('2026-08-09')
  })

  it('keeps assignment stable when only clock-out changes', () => {
    const original = resolvePayrollOccurrenceAssignment(occurrence(), denver)
    const adjusted = resolvePayrollOccurrenceAssignment(occurrence({ actualClockOut: '2026-08-16T13:00:00.000Z' }), denver)
    expect(adjusted.weekStartsOn).toBe(original.weekStartsOn)
  })

  it('keeps assignment stable when an approved actual start crosses midnight', () => {
    expect(resolvePayrollOccurrenceAssignment(occurrence({ actualClockIn: '2026-08-16T06:30:00.000Z' }), denver).weekStartsOn).toBe('2026-08-09')
  })

  it('preserves the stored week for locked historical payroll', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence({ locked: true, lockedWeekStartsOn: '2026-08-02' }), denver)
    expect(result.weekStartsOn).toBe('2026-08-02')
    expect(result.locked).toBe(true)
  })

  it('derives open payroll under the active rule', () => {
    expect(resolvePayrollOccurrenceAssignment(occurrence(), denver).locked).toBe(false)
  })

  it('reconciliation is idempotent and rejects duplicate occurrence keys', () => {
    expect(reconcilePayrollMinutes({ paidMinutes: 480, regularMinutes: 480, overtimeMinutes: 0, occurrenceKeys: ['shift-1'] }).passed).toBe(true)
    expect(reconcilePayrollMinutes({ paidMinutes: 960, regularMinutes: 960, overtimeMinutes: 0, occurrenceKeys: ['shift-1', 'shift-1'] })).toEqual({ duplicateOccurrenceKeys: ['shift-1'], passed: false })
  })

  it('handles the spring daylight-saving transition using real elapsed time', () => {
    expect(elapsedMinutes('2026-03-08T07:00:00.000Z', '2026-03-08T14:00:00.000Z')).toBe(420)
    expect(getPayrollBatchWeek('2026-03-08T07:00:00.000Z', denver).weekStartsOn).toBe('2026-03-08')
  })

  it.each([
    {
      label: 'fall-back',
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-11-01T13:00:00.000Z',
      minutes: 780,
      priorWeek: '2026-10-25',
      nextWeek: '2026-11-01',
      nextMinutes: 420,
    },
    {
      label: 'spring-forward',
      startsAt: '2026-03-08T01:00:00.000Z',
      endsAt: '2026-03-08T12:00:00.000Z',
      minutes: 660,
      priorWeek: '2026-03-01',
      nextWeek: '2026-03-08',
      nextMinutes: 300,
    },
  ])('keeps Denver 6 PM to 6 AM $label elapsed time before any unpaid break', ({ startsAt, endsAt, minutes, priorWeek, nextWeek, nextMinutes }) => {
    // The same wall-clock endpoints span thirteen hours in fall and eleven in spring.
    // This checks elapsed time and allocation only, not a new overtime policy.
    expect(elapsedMinutes(startsAt, endsAt)).toBe(minutes)
    expect(allocateIntervalByPayrollWeek(startsAt, endsAt, denver)).toEqual([
      { minutes: 360, weekStartsOn: priorWeek, weekEndsOn: shiftDateKey(priorWeek, 6) },
      { minutes: nextMinutes, weekStartsOn: nextWeek, weekEndsOn: shiftDateKey(nextWeek, 6) },
    ])
  })

  it('counts a break between the two Denver 1:30 AM instants as sixty elapsed minutes', () => {
    const startsAt = '2026-11-01T04:00:00.000Z' // Saturday 10 PM MDT.
    const breakStartsAt = '2026-11-01T07:30:00.000Z' // First 1:30 AM, MDT.
    const breakEndsAt = '2026-11-01T08:30:00.000Z' // Second 1:30 AM, MST.
    const endsAt = '2026-11-01T13:00:00.000Z' // Sunday 6 AM MST.
    const paidIntervals = [
      ...allocateIntervalByPayrollWeek(startsAt, breakStartsAt, denver),
      ...allocateIntervalByPayrollWeek(breakEndsAt, endsAt, denver),
    ]

    expect(elapsedMinutes(startsAt, endsAt)).toBe(540)
    expect(elapsedMinutes(breakStartsAt, breakEndsAt)).toBe(60)
    expect(paidIntervals.reduce((total, interval) => total + interval.minutes, 0)).toBe(480)
    expect(paidIntervals.filter((interval) => interval.weekStartsOn === '2026-10-25')
      .reduce((total, interval) => total + interval.minutes, 0)).toBe(120)
    expect(paidIntervals.filter((interval) => interval.weekStartsOn === '2026-11-01')
      .reduce((total, interval) => total + interval.minutes, 0)).toBe(360)
  })

  it('distinguishes a correction to the second repeated hour without altering the original evidence', () => {
    const original = Object.freeze({ recordedAt: '2026-11-01T07:15:00.000Z' })
    const corrected = Object.freeze({ effectiveAt: '2026-11-01T08:15:00.000Z' })
    const endsAt = '2026-11-01T08:45:00.000Z'

    expect(elapsedMinutes(original.recordedAt, endsAt)).toBe(90)
    expect(elapsedMinutes(corrected.effectiveAt, endsAt)).toBe(30)
    expect(allocateIntervalByPayrollWeek(corrected.effectiveAt, endsAt, denver)).toEqual([
      { minutes: 30, weekStartsOn: '2026-11-01', weekEndsOn: '2026-11-07' },
    ])
    expect(original.recordedAt).toBe('2026-11-01T07:15:00.000Z')
  })

  it.each([
    { date: '2026-11-01', nextDate: '2026-11-02', minutes: 1_500 },
    { date: '2026-03-08', nextDate: '2026-03-09', minutes: 1_380 },
  ])('uses contiguous local midnight boundaries for the $date DST date range', ({ date, nextDate, minutes }) => {
    const range = payrollDateRangeInstants(date, date, denver.timeZone)
    const followingRange = payrollDateRangeInstants(nextDate, nextDate, denver.timeZone)

    expect(elapsedMinutes(range.startsAt, range.endsAtExclusive)).toBe(minutes)
    expect(range.endsAtExclusive).toBe(followingRange.startsAt)
  })

  it.each(['UTC', 'America/New_York', 'America/Phoenix', 'America/Los_Angeles'])(
    'does not let the device zone %s change Denver DST payroll allocations', (deviceTimeZone) => {
      const originalTimeZone = process.env.TZ
      try {
        process.env.TZ = deviceTimeZone
        expect(allocateIntervalByPayrollWeek(
          '2026-11-01T04:00:00.000Z', '2026-11-01T13:00:00.000Z', denver,
        )).toEqual([
          { minutes: 120, weekStartsOn: '2026-10-25', weekEndsOn: '2026-10-31' },
          { minutes: 420, weekStartsOn: '2026-11-01', weekEndsOn: '2026-11-07' },
        ])
      } finally {
        if (originalTimeZone === undefined) delete process.env.TZ
        else process.env.TZ = originalTimeZone
      }
    },
  )

  it('uses the configured payroll time zone', () => {
    const newYork = { timeZone: 'America/New_York', weekStartsOn: 0, weekStartMinutes: 0 }
    const instant = '2026-08-16T05:00:00.000Z'
    expect(getPayrollBatchWeek(instant, denver).weekStartsOn).toBe('2026-08-09')
    expect(getPayrollBatchWeek(instant, newYork).weekStartsOn).toBe('2026-08-16')
  })

  it('flags missing shift and clock-in instead of guessing', () => {
    const result = resolvePayrollOccurrenceAssignment(occurrence({ shiftId: null, scheduledStart: null, manualClockIn: null, actualClockIn: null }), denver)
    expect(result.weekStartsOn).toBeNull()
    expect(result.source).toBe('unresolved')
    expect(result.reviewReason).toContain('No scheduled shift start')
  })

  it('assigns split shifts independently on both sides of the boundary', () => {
    const saturday = resolvePayrollOccurrenceAssignment(occurrence(), denver)
    const sunday = resolvePayrollOccurrenceAssignment(occurrence({ shiftId: 'shift-2', scheduledStart: '2026-08-16T18:00:00.000Z', scheduledEnd: '2026-08-16T22:00:00.000Z' }), denver)
    expect(saturday.weekStartsOn).toBe('2026-08-09')
    expect(sunday.weekStartsOn).toBe('2026-08-16')
    expect(shiftDateKey(saturday.weekStartsOn!, 7)).toBe(sunday.weekStartsOn)
  })
})

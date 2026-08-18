import { describe, expect, it } from 'vitest'
import {
  elapsedMinutes,
  getPayrollBatchWeek,
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

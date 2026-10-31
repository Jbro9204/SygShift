import { describe, expect, it } from 'vitest'
import {
  payrollHours,
  reviewRowsToPayrollCsv,
  summarizeOperationalRowsByEmployee,
  summarizePayrollRowsByEmployee,
  type PayrollWeekAllocation,
  type TimekeepingReviewRow,
} from '../data/timekeeping'
import { allocateIntervalByPayrollWeek, elapsedMinutes } from './payrollBoundary'

const employeeId = '73000000-0000-4000-8000-000000000001'

function allocation(
  allocationKey: string,
  weekStartsOn: string,
  weekEndsOn: string,
  paidMinutes: number,
  overrides: Partial<PayrollWeekAllocation> = {},
): PayrollWeekAllocation {
  return {
    allocationKey,
    breakMinutes: 0,
    epMinutes: 0,
    grossMinutes: paidMinutes,
    overtimeMinutes: 0,
    paidMinutes,
    regularCategoryMinutes: paidMinutes,
    regularMinutes: paidMinutes,
    truepMinutes: 0,
    unclassifiedCategoryMinutes: 0,
    unpaidGapMinutes: 0,
    weekEndsOn,
    weekStartsOn,
    ...overrides,
  }
}

function reviewRow(overrides: Partial<TimekeepingReviewRow>): TimekeepingReviewRow {
  const operationalDate = overrides.operationalDate ?? '2026-10-15'
  const paidMinutes = overrides.paidMinutes ?? 480
  const firstClockIn = overrides.firstClockIn ?? `${operationalDate}T02:00:00.000Z`
  const lastClockOut = overrides.lastClockOut === undefined
    ? `${operationalDate}T10:00:00.000Z`
    : overrides.lastClockOut

  return {
    breakMinutes: 0,
    crossesPayrollBoundary: false,
    detectedExceptionCodes: [],
    employeeId,
    employeeName: 'Alejandro Alejandro',
    employmentType: 'hourly',
    eventCount: 2,
    eventName: null,
    eventTimeline: [],
    exceptionCodes: [],
    exceptionDetails: [],
    firstClockIn,
    grossMinutes: paidMinutes,
    isOvertime: false,
    lastClockOut,
    locationName: 'Neon Local Apt-Unarmed',
    manualAdjustment: false,
    mixedPayrollCategories: false,
    mixedWorkTypes: false,
    operationalDate,
    overtimeMinutes: 0,
    paidMinutes,
    payCode: 'POST',
    payrollAssignmentCandidates: [],
    payrollAssignmentExplanation: 'Scheduled shift establishes the canonical occurrence.',
    payrollAssignmentSource: 'scheduled_shift',
    payrollAssignmentStatus: 'derived',
    payrollCategory: 'regular',
    payrollCategoryLabel: 'Regular',
    payrollCategoryResolved: true,
    payrollConfigurationVersion: 2,
    payrollGroupingPolicy: 'elapsed_time_boundary_split',
    payrollNotes: [],
    payrollOccurrenceKey: `shift:${operationalDate}:employee:${employeeId}`,
    payrollPolicyVersion: 'payroll-batch-v2',
    payrollReady: true,
    payrollWeekAllocations: [],
    postName: 'Unarmed coverage',
    regularMinutes: paidMinutes,
    requiresArmed: false,
    reviewStatus: 'ready',
    role: 'guard',
    rowKind: 'time_event',
    salaryDefaultMinutes: 0,
    scheduledEndsAt: lastClockOut,
    scheduledStartsAt: firstClockIn,
    shiftId: '73000000-0000-4000-8000-000000000010',
    siteCode: 'NLA',
    siteName: 'Neon Local Apt-Unarmed',
    timeOffMinutes: 0,
    timeZone: 'America/Denver',
    unpaidGapMinutes: 0,
    unpaidGaps: [],
    username: 'ralejandro',
    workType: 'post',
    workTypeLabel: 'Worked Time',
    workTypeOvertimeEligible: true,
    workTypePaid: true,
    workTypeRateSource: 'employee_base_rate',
    workedSegments: lastClockOut
      ? [{ breakMinutes: 0, endsAt: lastClockOut, paidMinutes, segmentNumber: 1, startsAt: firstClockIn }]
      : [],
    ...overrides,
    overtimePolicyVersion: overrides.overtimePolicyVersion ?? 'colorado-daily-weekly-v1',
  }
}

function exportedHours(rows: TimekeepingReviewRow[]): number {
  // Timestamp fields contain quoted commas; splitting on commas reads gross
  // hours instead of paid hours and can conceal a break/export discrepancy.
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  const csv = reviewRowsToPayrollCsv(rows)
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      record.push(field)
      field = ''
    } else if (character === '\n' && !quoted) {
      records.push([...record, field])
      record = []
      field = ''
    } else if (character !== '\r' || quoted) field += character
  }
  records.push([...record, field])
  const [header, ...lines] = records
  const paidColumn = header.indexOf('Total Worked Hours')
  expect(paidColumn).toBeGreaterThanOrEqual(0)
  return lines.reduce((total, line) => total + Number(line[paidColumn]), 0)
}

describe('payroll-hours consistency regression', () => {
  it('keeps Alejandro\'s three complete occurrences operationally whole while payroll owns 1205 + 240 minutes', () => {
    const first = reviewRow({
      firstClockIn: '2026-10-16T02:00:00.000Z',
      eventTimeline: [{
        effectiveAt: '2026-10-16T02:00:00.000Z',
        id: '73000000-0000-4000-8000-000000000101',
        kind: 'clock_in',
        recordedAt: '2026-10-16T05:36:00.000Z',
        shiftId: '73000000-0000-4000-8000-000000000010',
      }, {
        effectiveAt: '2026-10-16T10:00:41.000Z',
        id: '73000000-0000-4000-8000-000000000102',
        kind: 'clock_out',
        recordedAt: '2026-10-16T10:00:41.000Z',
        shiftId: '73000000-0000-4000-8000-000000000010',
      }],
      grossMinutes: 481,
      lastClockOut: '2026-10-16T10:00:41.000Z',
      manualAdjustment: true,
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 481,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 481,
      occurrenceRegularCategoryMinutes: 481,
      occurrenceRegularMinutes: 481,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-10-15',
      paidMinutes: 481,
      payrollOccurrenceKey: `shift:oct-15:employee:${employeeId}`,
      payrollWeekAllocations: [allocation(
        `shift:oct-15:employee:${employeeId}|2026-10-11`,
        '2026-10-11',
        '2026-10-17',
        481,
      )],
      regularMinutes: 481,
      workedSegments: [{
        breakMinutes: 0,
        endsAt: '2026-10-16T10:00:41.000Z',
        paidMinutes: 481,
        segmentNumber: 1,
        startsAt: '2026-10-16T02:00:00.000Z',
      }],
    })
    const second = reviewRow({
      firstClockIn: '2026-10-17T01:55:09.000Z',
      grossMinutes: 485,
      lastClockOut: '2026-10-17T10:00:04.000Z',
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 485,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 485,
      occurrenceRegularCategoryMinutes: 485,
      occurrenceRegularMinutes: 485,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-10-16',
      paidMinutes: 485,
      payrollOccurrenceKey: `shift:oct-16:employee:${employeeId}`,
      payrollWeekAllocations: [allocation(
        `shift:oct-16:employee:${employeeId}|2026-10-11`,
        '2026-10-11',
        '2026-10-17',
        485,
      )],
      regularMinutes: 485,
      workedSegments: [{
        breakMinutes: 0,
        endsAt: '2026-10-17T10:00:04.000Z',
        paidMinutes: 485,
        segmentNumber: 1,
        startsAt: '2026-10-17T01:55:09.000Z',
      }],
    })
    const finalCurrentSlice = reviewRow({
      crossesPayrollBoundary: true,
      firstClockIn: '2026-10-18T02:00:59.000Z',
      grossMinutes: 239,
      lastClockOut: '2026-10-18T10:00:05.000Z',
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 479,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 479,
      occurrenceRegularCategoryMinutes: 479,
      occurrenceRegularMinutes: 479,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-10-17',
      paidMinutes: 239,
      payrollOccurrenceKey: `shift:oct-17:employee:${employeeId}`,
      payrollWeekAllocations: [allocation(
        `shift:oct-17:employee:${employeeId}|2026-10-11`,
        '2026-10-11',
        '2026-10-17',
        239,
      )],
      regularMinutes: 239,
      workedSegments: [{
        breakMinutes: 0,
        endsAt: '2026-10-18T10:00:05.000Z',
        paidMinutes: 479,
        segmentNumber: 1,
        startsAt: '2026-10-18T02:00:59.000Z',
      }],
    })
    const finalNextSlice = reviewRow({
      ...finalCurrentSlice,
      grossMinutes: 240,
      paidMinutes: 240,
      payrollWeekAllocations: [allocation(
        `shift:oct-17:employee:${employeeId}|2026-10-18`,
        '2026-10-18',
        '2026-10-24',
        240,
      )],
      regularMinutes: 240,
    })
    const currentPeriodRows = [first, second, finalCurrentSlice]
    const currentOperational = summarizeOperationalRowsByEmployee(currentPeriodRows, {
      fromDate: '2026-10-04',
      throughDate: '2026-10-17',
    })[0]
    const currentPayroll = summarizePayrollRowsByEmployee(currentPeriodRows)[0]
    const nextPayroll = summarizePayrollRowsByEmployee([finalNextSlice])[0]

    expect(currentOperational).toMatchObject({
      breakMinutes: 0,
      exceptionCount: 0,
      paidMinutes: 1_445,
      regularCategoryMinutes: 1_445,
      workedShiftCount: 3,
    })
    expect(first.eventTimeline[0]).toMatchObject({
      effectiveAt: '2026-10-16T02:00:00.000Z',
      recordedAt: '2026-10-16T05:36:00.000Z',
    })
    expect(currentPayroll?.paidMinutes).toBe(1_205)
    expect(nextPayroll?.paidMinutes).toBe(240)
    expect((currentPayroll?.paidMinutes ?? 0) + (nextPayroll?.paidMinutes ?? 0)).toBe(1_445)
    expect(payrollHours(currentOperational?.paidMinutes ?? 0)).toBe('24.08')
    expect((currentOperational?.paidMinutes ?? 0) - 1_440).toBe(5)
    expect(payrollHours((currentOperational?.paidMinutes ?? 0) - 1_440)).toBe('0.08')
    expect(payrollHours(currentPayroll?.paidMinutes ?? 0)).toBe('20.08')
    expect(payrollHours(nextPayroll?.paidMinutes ?? 0)).toBe('4.00')
    expect(exportedHours(currentPeriodRows)).toBeCloseTo(20.08, 8)
    expect(exportedHours([finalNextSlice])).toBe(4)
    expect(summarizeOperationalRowsByEmployee([finalNextSlice], {
      fromDate: '2026-10-18',
      throughDate: '2026-10-31',
    })).toEqual([])
  })

  it('reconciles a boundary-spanning break without duplicating its canonical occurrence', () => {
    const currentSlice = reviewRow({
      breakMinutes: 15,
      crossesPayrollBoundary: true,
      grossMinutes: 120,
      occurrenceBreakMinutes: 30,
      occurrenceGrossMinutes: 480,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 450,
      occurrenceRegularCategoryMinutes: 450,
      occurrenceRegularMinutes: 450,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-09-05',
      paidMinutes: 105,
      payrollOccurrenceKey: `shift:break:employee:${employeeId}`,
      payrollWeekAllocations: [allocation(
        `shift:break:employee:${employeeId}|2026-08-30`,
        '2026-08-30',
        '2026-09-05',
        105,
        { breakMinutes: 15, grossMinutes: 120 },
      )],
      regularMinutes: 105,
      workedSegments: [{
        breakMinutes: 30,
        endsAt: '2026-09-06T12:00:00.000Z',
        paidMinutes: 450,
        segmentNumber: 1,
        startsAt: '2026-09-06T04:00:00.000Z',
      }],
    })
    const nextSlice = reviewRow({
      ...currentSlice,
      breakMinutes: 15,
      grossMinutes: 360,
      paidMinutes: 345,
      payrollWeekAllocations: [allocation(
        `shift:break:employee:${employeeId}|2026-09-06`,
        '2026-09-06',
        '2026-09-12',
        345,
        { breakMinutes: 15, grossMinutes: 360 },
      )],
      regularMinutes: 345,
    })
    const operational = summarizeOperationalRowsByEmployee([currentSlice], {
      fromDate: '2026-08-30',
      throughDate: '2026-09-05',
    })[0]

    expect(operational).toMatchObject({
      breakMinutes: 30,
      paidMinutes: 450,
      workedShiftCount: 1,
    })
    expect(summarizePayrollRowsByEmployee([currentSlice])[0]?.paidMinutes).toBe(105)
    expect(summarizePayrollRowsByEmployee([nextSlice])[0]?.paidMinutes).toBe(345)
    expect(
      (summarizePayrollRowsByEmployee([currentSlice])[0]?.paidMinutes ?? 0)
      + (summarizePayrollRowsByEmployee([nextSlice])[0]?.paidMinutes ?? 0),
    ).toBe(operational?.paidMinutes)
  })

  it('reconciles fall-back paid intervals and a repeated-hour break across adjacent payroll ranges', () => {
    const firstClockIn = '2026-11-01T04:00:00.000Z' // October 31, 10 PM MDT.
    const breakStartsAt = '2026-11-01T07:30:00.000Z' // First 1:30 AM.
    const breakEndsAt = '2026-11-01T08:30:00.000Z' // Second 1:30 AM.
    const lastClockOut = '2026-11-01T13:00:00.000Z' // November 1, 6 AM MST.
    const config = { timeZone: 'America/Denver', weekStartsOn: 0, weekStartMinutes: 0 }
    const grossSlices = allocateIntervalByPayrollWeek(firstClockIn, lastClockOut, config)
    const breakSlices = allocateIntervalByPayrollWeek(breakStartsAt, breakEndsAt, config)
    const paidSlices = [
      ...allocateIntervalByPayrollWeek(firstClockIn, breakStartsAt, config),
      ...allocateIntervalByPayrollWeek(breakEndsAt, lastClockOut, config),
    ]
    const occurrenceKey = `shift:fall-back:employee:${employeeId}`
    const canonicalGrossMinutes = elapsedMinutes(firstClockIn, lastClockOut)
    const canonicalBreakMinutes = elapsedMinutes(breakStartsAt, breakEndsAt)
    const canonicalPaidMinutes = canonicalGrossMinutes - canonicalBreakMinutes
    const timeline: TimekeepingReviewRow['eventTimeline'] = [
      { id: 'fall-in', kind: 'clock_in', effectiveAt: firstClockIn, recordedAt: firstClockIn, shiftId: null },
      { id: 'fall-break-start', kind: 'break_start', effectiveAt: breakStartsAt, recordedAt: breakStartsAt, shiftId: null },
      { id: 'fall-break-end', kind: 'break_end', effectiveAt: breakEndsAt, recordedAt: breakEndsAt, shiftId: null },
      { id: 'fall-out', kind: 'clock_out', effectiveAt: lastClockOut, recordedAt: lastClockOut, shiftId: null },
    ]
    const rows = grossSlices.map((slice) => {
      const breakMinutes = breakSlices.filter((item) => item.weekStartsOn === slice.weekStartsOn)
        .reduce((total, item) => total + item.minutes, 0)
      const paidMinutes = paidSlices.filter((item) => item.weekStartsOn === slice.weekStartsOn)
        .reduce((total, item) => total + item.minutes, 0)
      return reviewRow({
        breakMinutes,
        crossesPayrollBoundary: true,
        eventCount: 4,
        eventTimeline: timeline,
        firstClockIn,
        grossMinutes: slice.minutes,
        lastClockOut,
        occurrenceBreakMinutes: canonicalBreakMinutes,
        occurrenceGrossMinutes: canonicalGrossMinutes,
        occurrenceOvertimeMinutes: 0,
        occurrencePaidMinutes: canonicalPaidMinutes,
        occurrenceRegularCategoryMinutes: canonicalPaidMinutes,
        occurrenceRegularMinutes: canonicalPaidMinutes,
        occurrenceUnpaidGapMinutes: 0,
        operationalDate: '2026-10-31',
        paidMinutes,
        payrollBatchWeekEndsOn: slice.weekEndsOn,
        payrollBatchWeekStartsOn: slice.weekStartsOn,
        payrollOccurrenceKey: occurrenceKey,
        payrollWeekAllocations: [allocation(
          `${occurrenceKey}|${slice.weekStartsOn}`, slice.weekStartsOn, slice.weekEndsOn, paidMinutes,
          { breakMinutes, grossMinutes: slice.minutes },
        )],
        regularMinutes: paidMinutes,
        workedSegments: [{
          breakMinutes: canonicalBreakMinutes, endsAt: lastClockOut, paidMinutes: canonicalPaidMinutes,
          segmentNumber: 1, startsAt: firstClockIn,
        }],
      })
    })
    const priorRange = { fromDate: '2026-10-25', throughDate: '2026-10-31' }
    const nextRange = { fromDate: '2026-11-01', throughDate: '2026-11-07' }
    const priorPayroll = summarizePayrollRowsByEmployee([rows[0]])[0]
    const nextPayroll = summarizePayrollRowsByEmployee([rows[1]])[0]
    const operational = summarizeOperationalRowsByEmployee(rows, priorRange)[0]

    expect(operational).toMatchObject({
      grossMinutes: 540, breakMinutes: 60, paidMinutes: 480, workedShiftCount: 1,
    })
    expect(priorPayroll?.paidMinutes).toBe(120)
    expect(nextPayroll?.paidMinutes).toBe(360)
    expect((priorPayroll?.paidMinutes ?? 0) + (nextPayroll?.paidMinutes ?? 0)).toBe(480)
    expect(exportedHours([rows[0]])).toBe(2)
    expect(exportedHours([rows[1]])).toBe(6)
    expect(exportedHours(rows)).toBe(8)
    expect(summarizeOperationalRowsByEmployee(rows, nextRange)).toEqual([])
    expect(new Set(rows.flatMap((row) => (row.payrollWeekAllocations ?? []).map((slice) => slice.allocationKey))).size)
      .toBe(2)
    expect(rows[0].eventTimeline).toEqual(timeline)
  })

  it('keeps an incomplete punch pair visible as an exception without inventing worked minutes', () => {
    const incomplete = reviewRow({
      detectedExceptionCodes: ['missing_clock_out'],
      eventCount: 1,
      exceptionCodes: ['missing_clock_out'],
      grossMinutes: 0,
      lastClockOut: null,
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 0,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 0,
      occurrenceRegularCategoryMinutes: 0,
      occurrenceRegularMinutes: 0,
      occurrenceUnpaidGapMinutes: 0,
      paidMinutes: 0,
      payrollReady: false,
      payrollWeekAllocations: [],
      regularMinutes: 0,
      reviewStatus: 'unresolved',
      scheduledEndsAt: '2026-10-18T10:00:00.000Z',
      workedSegments: [{
        breakMinutes: 0,
        endsAt: null,
        paidMinutes: 0,
        segmentNumber: 1,
        startsAt: '2026-10-15T02:00:00.000Z',
      }],
    })
    const summary = summarizeOperationalRowsByEmployee([incomplete], {
      fromDate: '2026-10-04',
      throughDate: '2026-10-17',
    })[0]

    expect(summary).toMatchObject({
      exceptionCount: 1,
      paidMinutes: 0,
      payrollReady: false,
      readyCount: 0,
      workedShiftCount: 0,
    })
  })
})

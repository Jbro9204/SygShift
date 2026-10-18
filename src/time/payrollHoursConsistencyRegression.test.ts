import { describe, expect, it } from 'vitest'
import {
  payrollHours,
  reviewRowsToPayrollCsv,
  summarizeOperationalRowsByEmployee,
  summarizePayrollRowsByEmployee,
  type PayrollWeekAllocation,
  type TimekeepingReviewRow,
} from '../data/timekeeping'

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
  const [header, ...lines] = reviewRowsToPayrollCsv(rows).split('\n')
  const paidColumn = header.split(',').indexOf('Total Worked Hours')
  return lines.reduce((total, line) => total + Number(line.split(',')[paidColumn]), 0)
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

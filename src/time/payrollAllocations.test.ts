import { describe, expect, it } from 'vitest'
import { reviewRowsToPayrollCsv, type TimekeepingReviewRow } from '../data/timekeeping'
import {
  hasSplitPayrollAllocation,
  payrollAllocatedPaidMinutes,
  payrollAllocatedPaidMinutesForWeek,
  payrollAllocationRemainderMinutes,
  payrollOccurrenceMinutes,
  payrollWeekAllocationsForRow,
} from './payrollAllocations'

function reviewRow(overrides: Partial<TimekeepingReviewRow> = {}): TimekeepingReviewRow {
  return {
    breakMinutes: 0,
    employeeId: '73000000-0000-4000-8000-000000000001',
    grossMinutes: 480,
    operationalDate: '2026-09-05',
    overtimeMinutes: 0,
    paidMinutes: 480,
    payrollBatchWeekEndsOn: '2026-09-05',
    payrollBatchWeekStartsOn: '2026-08-30',
    payrollCategory: 'regular',
    payrollOccurrenceKey: 'shift:boundary:employee:73000000-0000-4000-8000-000000000001',
    regularMinutes: 480,
    rowKind: 'time_event',
    unpaidGapMinutes: 0,
    ...overrides,
  } as TimekeepingReviewRow
}

describe('payroll-week allocations', () => {
  it('uses range-scoped allocations for payroll totals without changing the occurrence total', () => {
    const row = reviewRow({
      crossesPayrollBoundary: true,
      grossMinutes: 360,
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 480,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 480,
      occurrenceRegularMinutes: 480,
      occurrenceUnpaidGapMinutes: 0,
      paidMinutes: 360,
      payrollWeekAllocations: [{
        allocationKey: 'shift:boundary:employee:73000000-0000-4000-8000-000000000001|2026-09-06',
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 360,
        overtimeMinutes: 0,
        paidMinutes: 360,
        regularCategoryMinutes: 360,
        regularMinutes: 360,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-09-12',
        weekStartsOn: '2026-09-06',
      }],
      regularMinutes: 360,
    })

    expect(payrollOccurrenceMinutes(row).paidMinutes).toBe(480)
    expect(payrollAllocatedPaidMinutes([row], { fromDate: '2026-09-06', throughDate: '2026-09-19' })).toBe(360)
    expect(payrollAllocatedPaidMinutesForWeek([row], '2026-09-06')).toBe(360)
    expect(payrollAllocationRemainderMinutes(row)).toBe(120)
    expect(hasSplitPayrollAllocation(row)).toBe(true)
  })

  it('adapts a historical row without allocation metadata to one legacy week', () => {
    const [allocation] = payrollWeekAllocationsForRow(reviewRow())

    expect(allocation).toMatchObject({
      allocationKey: 'shift:boundary:employee:73000000-0000-4000-8000-000000000001|2026-08-30',
      breakMinutes: 0,
      paidMinutes: 480,
      regularCategoryMinutes: 480,
      regularMinutes: 480,
      weekEndsOn: '2026-09-05',
      weekStartsOn: '2026-08-30',
    })
  })

  it('includes a salary default only in its explicitly assigned payroll week', () => {
    const salaryDefault = reviewRow({
      grossMinutes: 2_400,
      paidMinutes: 2_400,
      payrollBatchWeekEndsOn: undefined,
      payrollBatchWeekStartsOn: undefined,
      payrollOccurrenceKey: '',
      regularMinutes: 2_400,
      rowKind: 'salary_default',
      weekEndsOn: '2026-09-12',
      weekStartsOn: '2026-09-06',
    })

    expect(payrollAllocatedPaidMinutesForWeek([salaryDefault], '2026-09-06')).toBe(2_400)
    expect(payrollAllocatedPaidMinutesForWeek([salaryDefault], '2026-09-13')).toBe(0)
    expect(hasSplitPayrollAllocation(salaryDefault)).toBe(false)
  })

  it('exports derived allocation lines with one canonical occurrence identity', () => {
    const row = reviewRow({
      exceptionCodes: [],
      firstClockIn: '2026-09-06T05:00:00.000Z',
      lastClockOut: '2026-09-06T13:00:00.000Z',
      mixedPayrollCategories: false,
      occurrencePaidMinutes: 480,
      payrollNotes: [],
      payrollReady: true,
      payrollWeekAllocations: [{
        allocationKey: 'shift:boundary|2026-08-30',
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 60,
        overtimeMinutes: 0,
        paidMinutes: 60,
        regularCategoryMinutes: 60,
        regularMinutes: 60,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-09-05',
        weekStartsOn: '2026-08-30',
      }, {
        allocationKey: 'shift:boundary|2026-09-06',
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 420,
        overtimeMinutes: 0,
        paidMinutes: 420,
        regularCategoryMinutes: 420,
        regularMinutes: 420,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-09-12',
        weekStartsOn: '2026-09-06',
      }],
    })

    const csv = reviewRowsToPayrollCsv([row])

    expect(csv.split('\n')).toHaveLength(3)
    expect(csv).toContain('shift:boundary|2026-08-30')
    expect(csv).toContain('shift:boundary|2026-09-06')
    expect(csv.match(/shift:boundary:employee:73000000-0000-4000-8000-000000000001/g)).toHaveLength(2)
    expect(csv).toContain('Derived payroll-week allocation from one 8.00-hour canonical timecard.')
  })

  it('keeps a zero-paid break allocation out of payroll CSV lines', () => {
    const row = reviewRow({
      breakMinutes: 30,
      exceptionCodes: [],
      firstClockIn: '2026-09-06T05:30:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-09-06T13:30:00.000Z',
      mixedPayrollCategories: false,
      occurrenceBreakMinutes: 30,
      occurrenceGrossMinutes: 480,
      occurrencePaidMinutes: 450,
      paidMinutes: 450,
      payrollNotes: [],
      payrollReady: true,
      payrollWeekAllocations: [{
        allocationKey: 'shift:boundary:employee:73000000-0000-4000-8000-000000000001|2026-08-30',
        breakMinutes: 30,
        epMinutes: 0,
        grossMinutes: 30,
        overtimeMinutes: 0,
        paidMinutes: 0,
        regularCategoryMinutes: 0,
        regularMinutes: 0,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-09-05',
        weekStartsOn: '2026-08-30',
      }, {
        allocationKey: 'shift:boundary:employee:73000000-0000-4000-8000-000000000001|2026-09-06',
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 450,
        overtimeMinutes: 0,
        paidMinutes: 450,
        regularCategoryMinutes: 450,
        regularMinutes: 450,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-09-12',
        weekStartsOn: '2026-09-06',
      }],
      regularMinutes: 450,
    })

    const csv = reviewRowsToPayrollCsv([row])

    expect(csv.split('\n')).toHaveLength(2)
    expect(csv).not.toContain('|2026-08-30')
    expect(csv).toContain('|2026-09-06')
    expect(csv.split('\n')[1]).toMatch(/,8\.00,30,0,7\.50$/)
  })

  it('preserves the existing detailed CSV column order before appended allocation fields', () => {
    const [header] = reviewRowsToPayrollCsv([]).split('\n')

    expect(header).toBe([
      'Row Type',
      'Employee',
      'Username',
      'Date',
      'Week Start',
      'Week End',
      'Location',
      'Clock In',
      'Clock Out',
      'Gross Hours',
      'Break Minutes',
      'Total Worked Hours',
      'Payroll Category',
      'Regular Hours',
      'EP Hours',
      'TRUEP Hours',
      'Legacy Unclassified Hours',
      'Non-Overtime Hours',
      'Overtime Hours (included in category totals)',
      'Overtime',
      'Payroll Ready',
      'Exceptions',
      'Shift Notes',
      'Notes',
      'Canonical Occurrence',
      'Allocation Key',
      'Occurrence Gross Hours',
      'Occurrence Break Minutes',
      'Occurrence Unpaid Gap Minutes',
      'Occurrence Paid Hours',
    ].join(','))
  })
})

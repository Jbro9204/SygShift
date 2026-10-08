import {
  payrollCategoryAllocation,
  type PayrollWeekAllocation,
  type TimekeepingReviewRow,
} from '../data/timekeeping'
import { shiftDateKey } from './payrollBoundary'

export interface PayrollAllocationRange {
  fromDate: string
  throughDate: string
}

export interface PayrollOccurrenceMinutes {
  breakMinutes: number
  grossMinutes: number
  overtimeMinutes: number
  paidMinutes: number
  regularMinutes: number
  unpaidGapMinutes: number
}

function allocationOverlapsRange(allocation: PayrollWeekAllocation, range: PayrollAllocationRange): boolean {
  return allocation.weekStartsOn <= range.throughDate && allocation.weekEndsOn >= range.fromDate
}

export function payrollOccurrenceMinutes(row: TimekeepingReviewRow): PayrollOccurrenceMinutes {
  return {
    breakMinutes: row.occurrenceBreakMinutes ?? row.breakMinutes,
    grossMinutes: row.occurrenceGrossMinutes ?? row.grossMinutes,
    overtimeMinutes: row.occurrenceOvertimeMinutes ?? row.overtimeMinutes,
    paidMinutes: row.occurrencePaidMinutes ?? row.paidMinutes,
    regularMinutes: row.occurrenceRegularMinutes ?? row.regularMinutes,
    unpaidGapMinutes: row.occurrenceUnpaidGapMinutes ?? row.unpaidGapMinutes,
  }
}

export function payrollWeekAllocationsForRow(
  row: TimekeepingReviewRow,
  fallbackWeek?: { weekEndsOn: string; weekStartsOn: string },
): PayrollWeekAllocation[] {
  if (row.payrollWeekAllocations?.length) return row.payrollWeekAllocations
  if (row.rowKind !== 'time_event') return []

  const weekStartsOn = row.payrollBatchWeekStartsOn ?? fallbackWeek?.weekStartsOn ?? row.weekStartsOn
  if (!weekStartsOn) return []
  const weekEndsOn = row.payrollBatchWeekEndsOn ?? fallbackWeek?.weekEndsOn ?? row.weekEndsOn ?? shiftDateKey(weekStartsOn, 6)
  const categoryMinutes = payrollCategoryAllocation(row)

  return [{
    allocationKey: `${row.payrollOccurrenceKey || `${row.employeeId}:${row.operationalDate}`}|${weekStartsOn}`,
    breakMinutes: row.breakMinutes,
    epMinutes: categoryMinutes.epMinutes,
    grossMinutes: row.grossMinutes,
    overtimeMinutes: row.overtimeMinutes,
    paidMinutes: row.paidMinutes,
    regularCategoryMinutes: categoryMinutes.regularCategoryMinutes,
    regularMinutes: row.regularMinutes,
    truepMinutes: categoryMinutes.truepMinutes,
    unclassifiedCategoryMinutes: categoryMinutes.unclassifiedCategoryMinutes,
    unpaidGapMinutes: row.unpaidGapMinutes,
    weekEndsOn,
    weekStartsOn,
  }]
}

export function payrollWeekAllocationForRow(
  row: TimekeepingReviewRow,
  weekStartsOn: string,
  fallbackWeek?: { weekEndsOn: string; weekStartsOn: string },
): PayrollWeekAllocation | undefined {
  return payrollWeekAllocationsForRow(row, fallbackWeek)
    .find((allocation) => allocation.weekStartsOn === weekStartsOn)
}

export function payrollAllocatedPaidMinutes(
  rows: TimekeepingReviewRow[],
  range?: PayrollAllocationRange,
): number {
  return rows.reduce((total, row) => {
    const allocations = payrollWeekAllocationsForRow(row)
    if (allocations.length === 0) return total + row.paidMinutes
    return total + allocations
      .filter((allocation) => !range || allocationOverlapsRange(allocation, range))
      .reduce((allocationTotal, allocation) => allocationTotal + allocation.paidMinutes, 0)
  }, 0)
}

export function payrollAllocatedPaidMinutesForWeek(rows: TimekeepingReviewRow[], weekStartsOn: string): number {
  return rows.reduce((total, row) => {
    const allocation = payrollWeekAllocationForRow(row, weekStartsOn)
    if (allocation) return total + allocation.paidMinutes
    if (row.rowKind === 'time_event') return total

    const assignedWeekStartsOn = row.payrollBatchWeekStartsOn ?? row.weekStartsOn
    return assignedWeekStartsOn === weekStartsOn ? total + row.paidMinutes : total
  }, 0)
}

export function payrollAllocationRemainderMinutes(row: TimekeepingReviewRow): number {
  if (row.rowKind !== 'time_event') return 0
  const allocatedMinutes = (row.payrollWeekAllocations ?? []).reduce((total, allocation) => total + allocation.paidMinutes, 0)
  return Math.max(0, payrollOccurrenceMinutes(row).paidMinutes - allocatedMinutes)
}

export function hasSplitPayrollAllocation(row: TimekeepingReviewRow): boolean {
  return (row.payrollWeekAllocations?.length ?? 0) > 1
    || payrollAllocationRemainderMinutes(row) > 0
    || Boolean(row.crossesPayrollBoundary)
}

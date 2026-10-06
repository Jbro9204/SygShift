import {
  payrollCategoryAllocation,
  payrollCategoryLabel,
  type TimekeepingReview,
  type TimekeepingReviewRow,
} from '../data/timekeeping'

export const ACTIVE_CLOCK_IN_REVIEW_LIMIT_HOURS = 14
export const SCHEDULED_CLOCK_OUT_GRACE_HOURS = 2

export function isWorkedTimeRow(row: TimekeepingReviewRow): boolean {
  return row.rowKind === 'time_event' && row.employmentType !== 'salary'
}

export function isExportableWorkedTimeRow(row: TimekeepingReviewRow): boolean {
  return isWorkedTimeRow(row)
    && Boolean(row.firstClockIn)
    && Boolean(row.lastClockOut)
    && row.payrollReady
    && row.exceptionCodes.length === 0
    && !row.mixedWorkTypes
    && !row.mixedPayrollCategories
    && row.paidMinutes > 0
}

export function isActiveInProgressTimeRow(row: TimekeepingReviewRow, now = new Date()): boolean {
  if (!isWorkedTimeRow(row) || !row.firstClockIn || row.lastClockOut) return false
  if (row.exceptionCodes.some((code) => code !== 'missing_clock_out' && code !== 'zero_paid_minutes')) return false

  const startedAt = Date.parse(row.firstClockIn)
  if (Number.isNaN(startedAt)) return false

  const scheduledEnd = row.scheduledEndsAt ? Date.parse(row.scheduledEndsAt) : Number.NaN
  const hardLimitUntil = startedAt + ACTIVE_CLOCK_IN_REVIEW_LIMIT_HOURS * 60 * 60 * 1000
  const scheduledGraceUntil = Number.isNaN(scheduledEnd)
    ? Number.NaN
    : scheduledEnd + SCHEDULED_CLOCK_OUT_GRACE_HOURS * 60 * 60 * 1000
  const reviewUntil = Number.isNaN(scheduledGraceUntil)
    ? hardLimitUntil
    : Math.max(hardLimitUntil, scheduledGraceUntil)

  return now.getTime() < reviewUntil
}

export function workedTimeRows(rows: TimekeepingReviewRow[]): TimekeepingReviewRow[] {
  return rows.filter(isWorkedTimeRow)
}

export function exportableWorkedTimeRows(rows: TimekeepingReviewRow[]): TimekeepingReviewRow[] {
  return rows.filter(isExportableWorkedTimeRow)
}

function sumRows(rows: TimekeepingReviewRow[], field: 'breakMinutes' | 'grossMinutes' | 'overtimeMinutes' | 'paidMinutes' | 'regularMinutes'): number {
  return rows.reduce((total, row) => total + row[field], 0)
}

export function workedTimePayrollReview(review: TimekeepingReview | undefined): TimekeepingReview | undefined {
  if (!review) return undefined
  const serverNow = new Date(review.serverTimestamp)
  const rows = workedTimeRows(review.rows)
    .filter((row) => !isActiveInProgressTimeRow(row, serverNow))
    .map((row) => row.payrollCategory || row.payrollCategoryResolved === false ? row : {
      ...row,
      payrollCategory: 'regular' as const,
      payrollCategoryLabel: payrollCategoryLabel('regular'),
    })
  const readyRows = rows.filter((row) => row.payrollReady && row.exceptionCodes.length === 0 && !row.mixedPayrollCategories)
  const blockedRows = rows.filter((row) => !row.payrollReady || row.exceptionCodes.length > 0 || row.mixedPayrollCategories)
  const categoryTotals = rows.reduce((totals, row) => {
    const allocation = payrollCategoryAllocation(row)
    totals.regularCategoryMinutes += allocation.regularCategoryMinutes
    totals.epMinutes += allocation.epMinutes
    totals.truepMinutes += allocation.truepMinutes
    totals.unclassifiedCategoryMinutes += allocation.unclassifiedCategoryMinutes
    return totals
  }, {
    epMinutes: 0,
    regularCategoryMinutes: 0,
    truepMinutes: 0,
    unclassifiedCategoryMinutes: 0,
  })

  return {
    ...review,
    rows,
    summary: {
      exceptionCount: blockedRows.length,
      grossMinutes: sumRows(rows, 'grossMinutes'),
      overtimeMinutes: sumRows(rows, 'overtimeMinutes'),
      paidMinutes: sumRows(rows, 'paidMinutes'),
      pendingCorrectionCount: review.pendingCorrections.length,
      readyCount: readyRows.length,
      ...categoryTotals,
      regularMinutes: sumRows(rows, 'regularMinutes'),
      rowCount: rows.length,
      salaryDefaultMinutes: 0,
      timeOffMinutes: 0,
    },
  }
}

export function payrollLockBlocker(review: TimekeepingReview | undefined): string {
  const workedReview = workedTimePayrollReview(review)
  if (!workedReview) return 'Load the payroll review before locking an export.'
  if (workedReview.summary.rowCount === 0) return 'There are no SygShift clock-in/out time records in this range yet.'
  if (workedReview.summary.pendingCorrectionCount > 0) return 'Resolve every pending correction request first.'
  if (workedReview.rows.some((row) => row.mixedWorkTypes)) return 'Resolve every row with conflicting worked-time and training classifications before locking payroll.'
  if (workedReview.rows.some((row) => row.mixedPayrollCategories)) return 'Resolve every row with conflicting Regular, EP, or TRUEP payroll categories before locking payroll.'
  if (workedReview.summary.exceptionCount > 0) return 'Fix every worked-time row marked Needs review before locking payroll.'
  if (workedReview.summary.readyCount !== workedReview.summary.rowCount) return 'Every worked-time row must be marked Ready before payroll can be locked.'
  return ''
}

export function payrollExportFileName(fromDate: string, throughDate: string, kind = 'preview'): string {
  return `sygshift-payroll-${kind}-${fromDate}-to-${throughDate}.xlsx`
}

export function payrollReadinessPercent(review: TimekeepingReview | undefined): number | null {
  const workedReview = workedTimePayrollReview(review)
  if (!workedReview || workedReview.summary.rowCount === 0) return null
  return Math.round((workedReview.summary.readyCount / workedReview.summary.rowCount) * 100)
}

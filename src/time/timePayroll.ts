import type { TimekeepingReview, TimekeepingReviewRow } from '../data/timekeeping'

export function isWorkedTimeRow(row: TimekeepingReviewRow): boolean {
  return row.rowKind === 'time_event'
}

export function isExportableWorkedTimeRow(row: TimekeepingReviewRow): boolean {
  return isWorkedTimeRow(row)
    && Boolean(row.firstClockIn)
    && Boolean(row.lastClockOut)
    && row.payrollReady
    && row.exceptionCodes.length === 0
    && row.paidMinutes > 0
}

export function isActiveInProgressTimeRow(row: TimekeepingReviewRow, now = new Date()): boolean {
  if (!isWorkedTimeRow(row) || !row.firstClockIn || row.lastClockOut) return false
  if (row.exceptionCodes.some((code) => code !== 'missing_clock_out' && code !== 'zero_paid_minutes')) return false

  const startedAt = Date.parse(row.firstClockIn)
  if (Number.isNaN(startedAt)) return false

  const scheduledEnd = row.scheduledEndsAt ? Date.parse(row.scheduledEndsAt) : Number.NaN
  const reviewUntil = Number.isNaN(scheduledEnd)
    ? startedAt + 16 * 60 * 60 * 1000
    : scheduledEnd + 2 * 60 * 60 * 1000

  return now.getTime() <= reviewUntil
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
  const rows = workedTimeRows(review.rows).filter((row) => !isActiveInProgressTimeRow(row, serverNow))
  const readyRows = rows.filter((row) => row.payrollReady && row.exceptionCodes.length === 0)
  const blockedRows = rows.filter((row) => !row.payrollReady || row.exceptionCodes.length > 0)

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
  if (workedReview.summary.exceptionCount > 0) return 'Fix every worked-time row marked Needs review before locking payroll.'
  if (workedReview.summary.readyCount !== workedReview.summary.rowCount) return 'Every worked-time row must be marked Ready before payroll can be locked.'
  return ''
}

export function payrollExportFileName(fromDate: string, throughDate: string, kind = 'preview'): string {
  return `sygshift-payroll-${kind}-${fromDate}-to-${throughDate}.csv`
}

export function payrollReadinessPercent(review: TimekeepingReview | undefined): number | null {
  const workedReview = workedTimePayrollReview(review)
  if (!workedReview || workedReview.summary.rowCount === 0) return null
  return Math.round((workedReview.summary.readyCount / workedReview.summary.rowCount) * 100)
}

import type { TimekeepingReview } from '../data/timekeeping'

export function payrollLockBlocker(review: TimekeepingReview | undefined): string {
  if (!review) return 'Load the payroll review before locking an export.'
  if (review.summary.rowCount === 0) return 'There are no time records in this range yet.'
  if (review.summary.pendingCorrectionCount > 0) return 'Resolve every pending correction request first.'
  if (review.summary.exceptionCount > 0) return 'Fix every row marked Needs review before locking payroll.'
  if (review.summary.readyCount !== review.summary.rowCount) return 'Every row must be marked Ready before payroll can be locked.'
  return ''
}

export function payrollExportFileName(fromDate: string, throughDate: string, kind: 'preview' | 'official' = 'preview'): string {
  return `sygshift-payroll-${kind}-${fromDate}-to-${throughDate}.csv`
}

export function payrollReadinessPercent(review: TimekeepingReview | undefined): number | null {
  if (!review || review.summary.rowCount === 0) return null
  return Math.round((review.summary.readyCount / review.summary.rowCount) * 100)
}

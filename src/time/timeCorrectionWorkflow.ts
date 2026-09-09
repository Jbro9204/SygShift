export interface TimeCorrectionReviewTarget {
  employeeId?: string | null
  fromDate: string
  throughDate: string
}

export function timeCorrectionReviewPath(target: TimeCorrectionReviewTarget): string {
  const parameters = new URLSearchParams({
    from: target.fromDate,
    through: target.throughDate,
    show: 'pending_correction',
  })
  if (target.employeeId) parameters.set('employee', target.employeeId)
  return `/time/review?${parameters.toString()}`
}

export function pendingTimeRequestCount(
  adjustmentRequestCount: number,
  punchCorrectionCount: number,
): number {
  return adjustmentRequestCount + punchCorrectionCount
}

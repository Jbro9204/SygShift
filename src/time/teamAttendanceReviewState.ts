export type TeamAttendanceReviewTone = 'neutral' | 'good' | 'warning' | 'danger'

export interface TeamAttendanceReviewState {
  label: string
  requiresAttention: boolean
  tone: TeamAttendanceReviewTone
}

export function teamAttendanceReviewState(input: {
  hasSelectedRangeSummary: boolean
  incompletePunchCount?: number
  pendingCorrectionCount: number
}): TeamAttendanceReviewState {
  if (!input.hasSelectedRangeSummary) {
    return { label: 'Live status only', requiresAttention: false, tone: 'neutral' }
  }
  if (input.incompletePunchCount === undefined) {
    return { label: 'Punch status unavailable', requiresAttention: true, tone: 'warning' }
  }
  if (input.incompletePunchCount > 0) {
    return {
      label: input.incompletePunchCount === 1 ? 'Incomplete punch' : `${input.incompletePunchCount} incomplete punches`,
      requiresAttention: true,
      tone: 'danger',
    }
  }
  if (input.pendingCorrectionCount > 0) {
    return {
      label: `${input.pendingCorrectionCount} review${input.pendingCorrectionCount === 1 ? '' : 's'}`,
      requiresAttention: true,
      tone: 'warning',
    }
  }
  return { label: 'Clean', requiresAttention: false, tone: 'good' }
}

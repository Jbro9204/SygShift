import type {
  AttendanceClientCreditStatus,
  AttendanceReconciliationAction,
  AttendanceReconciliationDiscrepancy,
  AttendanceReconciliationRow,
} from '../data/timekeeping'
import { operationalToday } from '../lib/time'
import { addDays, dateKey } from './timeRules'

export const attendanceDiscrepancyCopy: Record<AttendanceReconciliationDiscrepancy, { label: string; help: string }> = {
  call_off_reported: {
    label: 'Call-off reported',
    help: 'A sick report, call-off, or no-call/no-show record is linked to this scheduled shift.',
  },
  planned_understaffing: {
    label: 'Published understaffing',
    help: 'The published schedule had fewer assigned employees than the required headcount.',
  },
  understaffed_or_uncovered: {
    label: 'Coverage not verified',
    help: 'Recorded workers do not meet the shift headcount. Confirm whether the work was covered or needs client-credit review.',
  },
  missing_recorded_time: {
    label: 'No recorded time',
    help: 'No SygShift punches are linked to this ended shift.',
  },
  scheduled_employee_missing: {
    label: 'Scheduled employee missing',
    help: 'At least one scheduled employee has no punches linked to this shift.',
  },
  replacement_or_unplanned_worker: {
    label: 'Replacement or unplanned worker',
    help: 'A person with recorded time was not listed on the published schedule for this shift.',
  },
  incomplete_punch_sequence: {
    label: 'Incomplete punch sequence',
    help: 'At least one worker has an incomplete or invalid punch sequence. This must be corrected in Time Maintenance.',
  },
  multiple_work_segments: {
    label: 'Multiple work segments',
    help: 'A worker clocked out and returned. Review the unpaid gap and confirm that the split was legitimate.',
  },
  worked_time_variance: {
    label: 'Scheduled vs. worked variance',
    help: 'Total recorded time differs from planned coverage by more than 15 minutes.',
  },
}

export const attendanceActionCopy: Record<AttendanceReconciliationAction, string> = {
  confirmed_replacement: 'Confirm replacement coverage',
  confirmed_call_off: 'Confirm call-off',
  confirmed_uncovered: 'Confirm uncovered work',
  approved_variance: 'Approve legitimate variance',
  dismissed_false_positive: 'Dismiss incorrect flag',
  reopened: 'Reopen review',
}

export const attendanceClientCreditCopy: Record<AttendanceClientCreditStatus, string> = {
  not_required: 'Not required',
  review_required: 'Client-credit review required',
  approved_credit: 'Client credit approved',
  no_credit: 'No client credit',
}

export function recentAttendanceReviewPeriod(now = new Date()): { fromDate: string; throughDate: string } {
  const through = addDays(operationalToday(now), -1)
  return {
    fromDate: dateKey(addDays(through, -6)),
    throughDate: dateKey(through),
  }
}

export function recommendedAttendanceAction(row: AttendanceReconciliationRow): AttendanceReconciliationAction {
  if (row.discrepancyCodes.includes('replacement_or_unplanned_worker')) return 'confirmed_replacement'
  if (
    row.discrepancyCodes.includes('understaffed_or_uncovered')
    || row.discrepancyCodes.includes('missing_recorded_time')
  ) return 'confirmed_uncovered'
  if (row.discrepancyCodes.includes('call_off_reported')) return 'confirmed_call_off'
  return 'approved_variance'
}

export function recommendedClientCreditStatus(action: AttendanceReconciliationAction): AttendanceClientCreditStatus {
  return action === 'confirmed_uncovered' ? 'review_required' : 'not_required'
}

export function reconciliationNeedsCorrection(row: AttendanceReconciliationRow): boolean {
  return row.requiresTimeCorrection || row.discrepancyCodes.includes('incomplete_punch_sequence')
}

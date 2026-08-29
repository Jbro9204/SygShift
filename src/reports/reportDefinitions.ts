import type { OperationalReportKey } from '../data/timeOperations'

export interface OperationalReportDefinition {
  key: OperationalReportKey
  title: string
  shortTitle: string
  description: string
  activeLabel: string
  archiveLabel: string
  detailFields: string[]
  summaryFields: string[]
  filter?: { key: string; label: string; options: Array<{ label: string; value: string }> }
  canonicalPath: string
  canonicalLabel: string
}

export const operationalReportDefinitions: OperationalReportDefinition[] = [
  {
    key: 'timekeepingExceptions',
    title: 'Timekeeping Exceptions',
    shortTitle: 'Timekeeping Exceptions',
    description: 'Review missing punches, automatic clock-outs, and documented resolutions without changing source time records here.',
    activeLabel: 'Unresolved',
    archiveLabel: 'Resolved Archive',
    summaryFields: ['employeeName', 'sitePost', 'exceptionCode', 'scheduledStartAt', 'status'],
    detailFields: ['employeeName', 'sitePost', 'scheduledStartAt', 'scheduledEndAt', 'exceptionCode', 'status', 'resolutionMethod', 'resolutionNote', 'resolvedBy', 'resolvedAt', 'detectedAt'],
    filter: { key: 'exceptionCode', label: 'Exception type', options: [{ label: 'All types', value: '' }, { label: 'Missing clock-in', value: 'missing_clock_in' }, { label: 'Automatic clock-out', value: 'automatic_clock_out' }] },
    canonicalPath: '/time/review',
    canonicalLabel: 'Open exception review',
  },
  {
    key: 'automaticClockOuts',
    title: 'Automatic Clock-Outs',
    shortTitle: 'Automatic Clock-Outs',
    description: 'See automatic clock-outs, the scheduled ending, and whether an employee correction still needs review.',
    activeLabel: 'Needs Review',
    archiveLabel: 'Resolved Archive',
    summaryFields: ['employeeName', 'sitePost', 'automaticClockOutAt', 'status', 'adjustmentStatus'],
    detailFields: ['employeeName', 'sitePost', 'scheduledStartAt', 'scheduledEndAt', 'automaticClockOutAt', 'status', 'adjustmentStatus'],
    canonicalPath: '/time/team',
    canonicalLabel: 'Open team attendance',
  },
  {
    key: 'manualTimeEntryAudit',
    title: 'Manual Time Entry Audit',
    shortTitle: 'Manual Entry Audit',
    description: 'Trace supervisor-entered time and every recorded before-and-after change.',
    activeLabel: 'Audit Records',
    archiveLabel: 'Archive',
    summaryFields: ['employeeName', 'workDate', 'action', 'actor', 'createdAt'],
    detailFields: ['employeeName', 'workDate', 'clockInAt', 'clockOutAt', 'action', 'reason', 'actor', 'approvalStatus', 'beforeValues', 'afterValues', 'createdAt'],
    canonicalPath: '/time/team',
    canonicalLabel: 'Open time maintenance',
  },
  {
    key: 'timeAdjustmentRequests',
    title: 'Time-Adjustment Requests',
    shortTitle: 'Adjustment Requests',
    description: 'Track employee-requested corrections, reviewer decisions, and processing time.',
    activeLabel: 'Awaiting Decision',
    archiveLabel: 'Decision Archive',
    summaryFields: ['employeeName', 'workDate', 'issueType', 'status', 'submittedAt'],
    detailFields: ['employeeName', 'workDate', 'issueType', 'requestedClockInAt', 'requestedClockOutAt', 'reason', 'status', 'reviewer', 'decisionNote', 'submittedAt', 'reviewedAt', 'processingMinutes'],
    filter: { key: 'issueType', label: 'Request type', options: [{ label: 'All request types', value: '' }, { label: 'Clock in', value: 'clock_in' }, { label: 'Clock out', value: 'clock_out' }, { label: 'Both punches', value: 'both_punches' }, { label: 'Missing shift', value: 'missing_shift' }, { label: 'Other', value: 'other' }] },
    canonicalPath: '/time/operations',
    canonicalLabel: 'Open request decisions',
  },
  {
    key: 'attendanceCallOffs',
    title: 'Attendance & Call-Offs',
    shortTitle: 'Attendance & Call-Offs',
    description: 'Review active sick reports, call-offs, replacement needs, and historical cancellations.',
    activeLabel: 'Active Call-Offs',
    archiveLabel: 'Canceled Archive',
    summaryFields: ['employeeName', 'sitePost', 'scheduledStartAt', 'callOffType', 'replacementNeeded'],
    detailFields: ['employeeName', 'sitePost', 'scheduledStartAt', 'callOffType', 'reason', 'replacementNeeded', 'reportedAt', 'canceledAt'],
    filter: { key: 'callOffType', label: 'Call-off type', options: [{ label: 'All call-offs', value: '' }, { label: 'Sick', value: 'sick' }, { label: 'Other', value: 'other' }] },
    canonicalPath: '/time/accountability',
    canonicalLabel: 'Open accountability',
  },
  {
    key: 'scheduledVsActual',
    title: 'Scheduled vs. Actual',
    shortTitle: 'Scheduled vs. Actual',
    description: 'Compare planned coverage with punch-based worked time by employee and workday.',
    activeLabel: 'Needs Review',
    archiveLabel: 'Payroll Ready',
    summaryFields: ['employeeName', 'operationalDate', 'sitePost', 'scheduledMinutes', 'workedMinutes', 'payrollReady'],
    detailFields: ['employeeName', 'operationalDate', 'sitePost', 'scheduledStartAt', 'scheduledEndAt', 'scheduledMinutes', 'workedMinutes', 'unpaidBreakMinutes', 'overtimeMinutes', 'exceptionCodes', 'payrollReady', 'shiftNotes'],
    filter: { key: 'payrollReady', label: 'Payroll state', options: [{ label: 'All states', value: '' }, { label: 'Ready', value: 'true' }, { label: 'Needs review', value: 'false' }] },
    canonicalPath: '/time/team',
    canonicalLabel: 'Open employee time',
  },
  {
    key: 'coverageUnfilled',
    title: 'Coverage & Unfilled Shifts',
    shortTitle: 'Coverage & Open Shifts',
    description: 'Monitor open coverage and call-offs while retaining filled-shift history separately.',
    activeLabel: 'Coverage Needed',
    archiveLabel: 'Filled History',
    summaryFields: ['sitePost', 'startsAt', 'headcountRequired', 'assignedCount', 'openCount', 'callOffCount'],
    detailFields: ['sitePost', 'startsAt', 'endsAt', 'headcountRequired', 'assignedCount', 'openCount', 'callOffCount', 'timeOpenMinutes'],
    canonicalPath: '/scheduler',
    canonicalLabel: 'Open Scheduler',
  },
  {
    key: 'overtimePayrollRisk',
    title: 'Overtime & Payroll Risk',
    shortTitle: 'Overtime & Payroll Risk',
    description: 'Identify overtime exposure and unresolved readiness conditions before opening Payroll.',
    activeLabel: 'Current Risk',
    archiveLabel: 'Archive',
    summaryFields: ['employeeName', 'operationalDate', 'workedMinutes', 'overtimeMinutes', 'payrollReady'],
    detailFields: ['employeeName', 'operationalDate', 'sitePost', 'scheduledMinutes', 'workedMinutes', 'unpaidBreakMinutes', 'overtimeMinutes', 'exceptionCodes', 'warningCodes', 'payrollReady'],
    canonicalPath: '/payroll/review',
    canonicalLabel: 'Open Payroll review',
  },
]

export function getOperationalReportDefinition(key: string | undefined): OperationalReportDefinition | null {
  return operationalReportDefinitions.find((definition) => definition.key === key) ?? null
}

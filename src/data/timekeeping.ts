import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { getTrustedDeviceToken } from '../lib/trustedDeviceToken'

const timeEventKindSchema = z.enum(['clock_in', 'break_start', 'break_end', 'clock_out'])
const timeEventSourceSchema = z.enum(['web', 'mobile_web', 'supervisor', 'import', 'system'])
const assignmentStatusSchema = z.enum(['assigned', 'confirmed', 'canceled', 'completed'])
const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary', 'flex'])
const workTypeSchema = z.enum(['post', 'training'])

const timekeepingEmployeeSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
})

const timekeepingShiftSchema = z.object({
  assignmentId: z.string().uuid(),
  shiftId: z.string().uuid(),
  status: assignmentStatusSchema,
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  requiresArmed: z.boolean(),
  isOvertime: z.boolean(),
  postName: z.string().nullable(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string().nullable(),
  workType: workTypeSchema.optional().default('post'),
})

const timekeepingEventSchema = z.object({
  id: z.string().uuid(),
  kind: timeEventKindSchema,
  shiftId: z.string().uuid().nullable(),
  recordedAt: z.string(),
  effectiveAt: z.string().optional(),
  clientRecordedAt: z.string().nullable().optional(),
  source: timeEventSourceSchema,
  voided: z.boolean().optional(),
  workType: workTypeSchema.optional().default('post'),
})

const timekeepingDashboardSchema = z.object({
  serverTimestamp: z.string(),
  operationalDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  employee: timekeepingEmployeeSchema,
  lastEvent: timekeepingEventSchema.nullable(),
  eligibleShifts: z.array(timekeepingShiftSchema),
  recentEvents: z.array(timekeepingEventSchema),
  pendingCorrectionCount: z.number().int().nonnegative(),
})

const correctionResultSchema = z.object({
  id: z.string().uuid(),
  timeEventId: z.string().uuid(),
  replacementTime: z.string().nullable(),
  replacementKind: timeEventKindSchema.nullable().optional(),
  recordedKind: timeEventKindSchema.optional(),
  voided: z.boolean(),
  requestedBy: z.string().uuid(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: z.string().nullable(),
})

const payrollExceptionSchema = z.enum([
  'unscheduled',
  'missing_clock_in',
  'missing_clock_out',
  'invalid_sequence',
  'pending_correction',
  'zero_paid_minutes',
  'multiple_work_segments',
  'payroll_assignment_unresolved',
])

const timekeepingExceptionPolicySchema = z.enum(['reviewable', 'hard'])
const timekeepingReviewStatusSchema = z.enum([
  'ready',
  'unresolved',
  'corrected',
  'approved_exception',
  'dismissed_false_positive',
])
const timekeepingExceptionResolutionActionSchema = z.enum([
  'approved_exception',
  'dismissed_false_positive',
  'reopened',
])

const timekeepingExceptionDetailSchema = z.object({
  code: payrollExceptionSchema,
  policy: timekeepingExceptionPolicySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: timekeepingReviewStatusSchema.exclude(['ready', 'corrected']),
  resolutionId: z.string().uuid().nullable().optional(),
  resolvedBy: z.string().uuid().nullable().optional(),
  resolvedAt: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
})

const timekeepingEventTimelineItemSchema = z.object({
  id: z.string().uuid(),
  kind: timeEventKindSchema,
  recordedAt: z.string(),
  effectiveAt: z.string(),
  shiftId: z.string().uuid().nullable(),
})

const timekeepingWorkedSegmentSchema = z.object({
  segmentNumber: z.number().int().positive(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  paidMinutes: z.number().int().nonnegative(),
  breakMinutes: z.number().int().nonnegative(),
})

const timekeepingUnpaidGapSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  minutes: z.number().int().nonnegative(),
})

const timekeepingExceptionResolutionSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string().nullable().optional(),
  shiftId: z.string().uuid().nullable(),
  operationalDate: z.string(),
  exceptionCode: payrollExceptionSchema,
  occurrenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: timekeepingExceptionResolutionActionSchema,
  reason: z.string(),
  resolvedBy: z.string().uuid(),
  resolvedByName: z.string().nullable().optional(),
  resolvedAt: z.string(),
})

const payrollRulesSchema = z.object({
  timeZone: z.string(),
  weekStartsOn: z.number().int().min(0).max(6),
  weekStartsOnLabel: z.string(),
  payFrequency: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly']),
  payDateAnchor: z.string(),
  dailyOvertimeMinutes: z.number().int().positive(),
  weeklyOvertimeMinutes: z.number().int().positive(),
  unpaidBreaks: z.boolean(),
  defaultBreakMinutes: z.number().int().nonnegative(),
  salaryWeeklyDefaultMinutes: z.number().int().nonnegative(),
  salaryTimeOffReducesDefault: z.boolean(),
  payrollWeekStartTime: z.string().optional().default('00:00:00'),
  crossBoundaryGroupingPolicy: z.literal('scheduled_shift_start').optional().default('scheduled_shift_start'),
  payrollPolicyEffectiveFrom: z.string().optional().default('2026-08-16'),
  payrollConfigurationVersion: z.number().int().positive().optional().default(1),
  payrollCalculationPolicyVersion: z.string().optional().default('payroll-batch-v1'),
  overtimeTimeZone: z.string().optional().default('America/Denver'),
  overtimeWeekStartsOn: z.number().int().min(0).max(6).optional().default(0),
  overtimeWeekStartTime: z.string().optional().default('00:00:00'),
  overtimePolicyVersion: z.string().optional().default('colorado-daily-weekly-v1'),
})

const payrollAssignmentCandidateSchema = z.object({
  shiftId: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  locationName: z.string(),
})

const timekeepingReviewRowSchema = z.object({
  rowKind: z.enum(['time_event', 'salary_default']).default('time_event'),
  employeeId: z.string().uuid(),
  username: z.string(),
  employeeName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  shiftId: z.string().uuid().nullable(),
  operationalDate: z.string(),
  weekStartsOn: z.string().optional(),
  weekEndsOn: z.string().optional(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  scheduledStartsAt: z.string().nullable(),
  scheduledEndsAt: z.string().nullable(),
  timeZone: z.string(),
  firstClockIn: z.string().nullable(),
  lastClockOut: z.string().nullable(),
  grossMinutes: z.number().int().nonnegative(),
  breakMinutes: z.number().int().nonnegative(),
  paidMinutes: z.number().int().nonnegative(),
  regularMinutes: z.number().int().nonnegative().default(0),
  overtimeMinutes: z.number().int().nonnegative().default(0),
  salaryDefaultMinutes: z.number().int().nonnegative().default(0),
  timeOffMinutes: z.number().int().nonnegative().default(0),
  eventCount: z.number().int().nonnegative(),
  requiresArmed: z.boolean(),
  isOvertime: z.boolean(),
  payrollReady: z.boolean(),
  exceptionCodes: z.array(payrollExceptionSchema),
  detectedExceptionCodes: z.array(payrollExceptionSchema).optional().default([]),
  exceptionDetails: z.array(timekeepingExceptionDetailSchema).optional().default([]),
  reviewStatus: timekeepingReviewStatusSchema.optional().default('ready'),
  eventTimeline: z.array(timekeepingEventTimelineItemSchema).optional().default([]),
  workedSegments: z.array(timekeepingWorkedSegmentSchema).optional().default([]),
  unpaidGaps: z.array(timekeepingUnpaidGapSchema).optional().default([]),
  unpaidGapMinutes: z.number().int().nonnegative().optional().default(0),
  shiftNotes: z.string().nullable().optional(),
  payrollNotes: z.array(z.string()).default([]),
  workType: workTypeSchema.optional().default('post'),
  workTypeLabel: z.string().optional().default('Worked Time'),
  payCode: z.string().optional().default('POST'),
  workTypePaid: z.boolean().optional().default(true),
  workTypeOvertimeEligible: z.boolean().optional().default(true),
  workTypeRateSource: z.enum(['employee_base_rate', 'configured_rate']).optional().default('employee_base_rate'),
  mixedWorkTypes: z.boolean().optional().default(false),
  payrollOccurrenceKey: z.string().optional().default(''),
  payrollOccurrenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  payrollAssignmentAnchor: z.string().nullable().optional(),
  payrollBatchWeekStartsOn: z.string().nullable().optional(),
  payrollBatchWeekEndsOn: z.string().nullable().optional(),
  payrollPeriodStartsOn: z.string().nullable().optional(),
  payrollPeriodEndsOn: z.string().nullable().optional(),
  payrollAssignmentSource: z.enum([
    'scheduled_shift',
    'replacement_assignment',
    'manual_linked_shift',
    'manual_entry',
    'unscheduled_actual_punch',
    'salary_default',
    'authorized_correction',
    'unresolved',
  ]).optional().default('unresolved'),
  payrollAssignmentStatus: z.enum(['derived', 'corrected', 'unresolved']).optional().default('unresolved'),
  payrollAssignmentExplanation: z.string().optional().default('Payroll assignment metadata is unavailable for this historical row.'),
  payrollAssignmentCandidates: z.array(payrollAssignmentCandidateSchema).optional().default([]),
  crossesPayrollBoundary: z.boolean().optional().default(false),
  payrollGroupingPolicy: z.string().optional().default('historical'),
  payrollPolicyVersion: z.string().optional().default('historical'),
  payrollConfigurationVersion: z.number().int().positive().optional().default(1),
  overtimeWorkweekStartsOn: z.string().nullable().optional(),
  overtimeWorkweekEndsOn: z.string().nullable().optional(),
  overtimePolicyVersion: z.string().optional().default('historical'),
  manualAdjustment: z.boolean().optional().default(false),
})

const payrollReconciliationSchema = z.object({
  passed: z.boolean(),
  paidMinutes: z.number().int().nonnegative(),
  regularMinutes: z.number().int().nonnegative(),
  overtimeMinutes: z.number().int().nonnegative(),
  regularPlusOvertimeMatchesPaid: z.boolean(),
  rowCount: z.number().int().nonnegative(),
  uniqueOccurrenceCount: z.number().int().nonnegative(),
  duplicateOccurrenceCount: z.number().int().nonnegative(),
  unresolvedAssignmentCount: z.number().int().nonnegative(),
  policyVersion: z.string(),
  configurationVersion: z.number().int().positive(),
})

const pendingCorrectionSchema = z.object({
  id: z.string().uuid(),
  timeEventId: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  username: z.string(),
  kind: timeEventKindSchema,
  recordedAt: z.string(),
  replacementTime: z.string().nullable(),
  voided: z.boolean(),
  reason: z.string(),
  requestedBy: z.string().uuid(),
  requestedAt: z.string(),
  shiftId: z.string().uuid().nullable(),
})

const employeeStatusSchema = z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated'])

const timeMaintenanceEmployeeSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  status: employeeStatusSchema,
})

const timeMaintenanceEventSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  username: z.string(),
  employeeName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  shiftId: z.string().uuid().nullable(),
  kind: timeEventKindSchema,
  recordedKind: timeEventKindSchema.optional(),
  recordedAt: z.string(),
  effectiveAt: z.string(),
  clientRecordedAt: z.string().nullable(),
  source: timeEventSourceSchema,
  createdBy: z.string().uuid().nullable(),
  createdByName: z.string().nullable(),
  voided: z.boolean(),
  pendingCorrectionCount: z.number().int().nonnegative(),
  maintenanceNoteCount: z.number().int().nonnegative(),
  latestNote: z.string().nullable(),
  // Maintenance actions are append-only operational history. Accept future
  // non-empty action names so a newly deployed database action cannot make the
  // entire maintenance workspace unreadable on an older browser bundle.
  latestAction: z.string().trim().min(1).nullable(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  timeZone: z.string(),
  workType: workTypeSchema.optional().default('post'),
  workTypeLabel: z.string().optional().default('Worked Time'),
  payCode: z.string().optional().default('POST'),
})

const timeMaintenanceSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  employees: z.array(timeMaintenanceEmployeeSchema),
  events: z.array(timeMaintenanceEventSchema),
})

const timeMaintenanceShiftOptionSchema = z.object({
  shiftId: z.string().uuid(),
  siteId: z.string().uuid().nullable().optional(),
  postId: z.string().uuid().nullable().optional(),
  eventId: z.string().uuid().nullable().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  requiresArmed: z.boolean(),
  isOvertime: z.boolean(),
  headcountRequired: z.number().int().positive(),
  scheduleStatus: z.enum(['draft', 'published']),
  scheduleRevision: z.number().int().positive(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  assignedEmployees: z.array(z.object({
    employeeId: z.string().uuid(),
    name: z.string(),
    username: z.string().nullable(),
  })),
  selectedEmployeeAssigned: z.boolean(),
  workType: workTypeSchema.optional().default('post'),
})

const timeWorkTypeMapItemSchema = z.object({
  employeeId: z.string().uuid(),
  shiftId: z.string().uuid().nullable(),
  operationalDate: z.string(),
  workType: workTypeSchema,
  payCode: z.string(),
  label: z.string(),
  paid: z.literal(true),
  overtimeEligible: z.literal(true),
  rateSource: z.enum(['employee_base_rate', 'configured_rate']).optional().default('employee_base_rate'),
  mixedWorkTypes: z.boolean().default(false),
})

const workTypeCorrectionResultSchema = z.object({
  correctionCount: z.number().int().positive(),
  eventIds: z.array(z.string().uuid()),
  workType: workTypeSchema,
  reason: z.string(),
  correctedAt: z.string(),
  correctedBy: z.string().uuid(),
})

const teamAttendanceSummaryRowSchema = z.object({
  employeeId: z.string().uuid(),
  username: z.string(),
  employeeName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  latestKind: timeEventKindSchema.nullable(),
  latestEffectiveAt: z.string().nullable(),
  latestLocationName: z.string().nullable(),
  latestSiteName: z.string().nullable(),
  latestSiteCode: z.string().nullable(),
  latestPostName: z.string().nullable(),
  latestEventName: z.string().nullable(),
  latestTimeZone: z.string(),
  firstClockIn: z.string().nullable(),
  lastClockOut: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  scheduledShiftCount: z.number().int().nonnegative(),
  scheduledMinutes: z.number().int().nonnegative().optional(),
  scheduledStartsAt: z.string().nullable(),
  scheduledEndsAt: z.string().nullable(),
  scheduledLocationName: z.string().nullable(),
  scheduledSiteName: z.string().nullable(),
  scheduledSiteCode: z.string().nullable(),
  scheduledPostName: z.string().nullable(),
  scheduledEventName: z.string().nullable(),
  scheduledTimeZone: z.string(),
  paidMinutes: z.number().int().nonnegative().default(0),
  breakMinutes: z.number().int().nonnegative().default(0),
  overtimeMinutes: z.number().int().nonnegative().default(0),
  workedSegmentCount: z.number().int().nonnegative().default(0),
  pendingCorrectionCount: z.number().int().nonnegative().default(0),
})

const teamAttendanceSummarySchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  rows: z.array(teamAttendanceSummaryRowSchema),
})

const teamAttendanceTotalsSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  rows: z.array(z.object({
    employeeId: z.string().uuid(),
    paidMinutes: z.number().int().nonnegative(),
    breakMinutes: z.number().int().nonnegative(),
    overtimeMinutes: z.number().int().nonnegative(),
    workedSegmentCount: z.number().int().nonnegative(),
    pendingCorrectionCount: z.number().int().nonnegative(),
  })),
})

const timekeepingReviewSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  payrollRules: payrollRulesSchema.optional(),
  summary: z.object({
    rowCount: z.number().int().nonnegative(),
    readyCount: z.number().int().nonnegative(),
    exceptionCount: z.number().int().nonnegative(),
    pendingCorrectionCount: z.number().int().nonnegative(),
    grossMinutes: z.number().int().nonnegative(),
    paidMinutes: z.number().int().nonnegative(),
    regularMinutes: z.number().int().nonnegative().default(0),
    overtimeMinutes: z.number().int().nonnegative().default(0),
    timeOffMinutes: z.number().int().nonnegative().default(0),
    salaryDefaultMinutes: z.number().int().nonnegative().default(0),
  }),
  rows: z.array(timekeepingReviewRowSchema),
  pendingCorrections: z.array(pendingCorrectionSchema),
  exceptionResolutionHistory: z.array(timekeepingExceptionResolutionSchema).optional().default([]),
  reconciliation: payrollReconciliationSchema.optional(),
})

const payrollAssignmentCorrectionResultSchema = z.object({
  occurrenceKey: z.string(),
  originalWeekStartsOn: z.string().nullable(),
  assignedWeekStartsOn: z.string(),
  assignmentStatus: z.literal('corrected'),
  reason: z.string(),
  correctedBy: z.string().uuid(),
  correctedAt: z.string(),
})

const payrollRecalculationResultSchema = z.object({
  dryRun: z.boolean(),
  fromDate: z.string(),
  throughDate: z.string(),
  rowCount: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  lockedSkippedCount: z.number().int().nonnegative(),
  paidMinutes: z.number().int().nonnegative(),
  regularMinutes: z.number().int().nonnegative(),
  overtimeMinutes: z.number().int().nonnegative(),
  policyVersion: z.string(),
  configurationVersion: z.number().int().positive(),
  reconciliationPassed: z.boolean(),
  runId: z.string().uuid(),
  runAt: z.string(),
})

const correctionReviewResultSchema = z.object({
  id: z.string().uuid(),
  timeEventId: z.string().uuid(),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  declinedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
})

const payrollExportBatchSchema = z.object({
  id: z.string().uuid(),
  fromDate: z.string(),
  throughDate: z.string(),
  createdAt: z.string(),
  createdBy: z.string().uuid(),
  createdByName: z.string().nullable(),
  rowCount: z.number().int().positive(),
  grossMinutes: z.number().int().nonnegative(),
  paidMinutes: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().min(1),
  duplicate: z.boolean().optional(),
})

const payrollExportDetailSchema = z.object({
  batch: payrollExportBatchSchema,
  exceptionResolutionHistory: z.array(timekeepingExceptionResolutionSchema).optional().default([]),
  rows: z.array(timekeepingReviewRowSchema),
})

const payrollAccountabilityEventSchema = z.object({
  id: z.string().uuid(),
  sourceTable: z.enum(['attendance_accountability_events', 'call_off_reports', 'time_off_requests']),
  eventType: z.enum(['called_in_sick', 'call_off', 'vacation', 'no_call_no_show', 'late_arrival', 'early_departure', 'other']),
  status: z.string(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  username: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  operationalDate: z.string(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  timeZone: z.string(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  note: z.string(),
  createdAt: z.string(),
})

const attendanceReportResultSchema = z.object({
  id: z.string().uuid(),
  callOffId: z.string().uuid().nullable().optional(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  username: z.string(),
  eventType: z.enum(['called_in_sick', 'call_off']),
  status: z.string(),
  operationalDate: z.string(),
  shiftId: z.string().uuid().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  timeZone: z.string(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  note: z.string(),
  createdAt: z.string(),
  dispatchNotified: z.boolean().optional().default(false),
  dispatchError: z.string().nullable().optional(),
})

const attendanceReconciliationDiscrepancySchema = z.enum([
  'call_off_reported',
  'planned_understaffing',
  'understaffed_or_uncovered',
  'missing_recorded_time',
  'scheduled_employee_missing',
  'replacement_or_unplanned_worker',
  'incomplete_punch_sequence',
  'multiple_work_segments',
  'worked_time_variance',
])

const attendanceReconciliationActionSchema = z.enum([
  'confirmed_replacement',
  'confirmed_call_off',
  'confirmed_uncovered',
  'approved_variance',
  'dismissed_false_positive',
  'reopened',
])

const attendanceClientCreditStatusSchema = z.enum([
  'not_required',
  'review_required',
  'approved_credit',
  'no_credit',
])

const attendanceReconciliationPersonSchema = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  username: z.string().nullable(),
})

const attendanceReconciliationScheduledEmployeeSchema = attendanceReconciliationPersonSchema.extend({
  assignmentStatus: assignmentStatusSchema,
})

const attendanceReconciliationActualEmployeeSchema = attendanceReconciliationPersonSchema.extend({
  eventCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  sequenceComplete: z.boolean(),
  firstClockIn: z.string().nullable(),
  lastClockOut: z.string().nullable(),
  paidMinutes: z.number().int().nonnegative(),
  breakMinutes: z.number().int().nonnegative(),
  unpaidGapMinutes: z.number().int().nonnegative(),
  eventTimeline: z.array(timekeepingEventTimelineItemSchema),
  workedSegments: z.array(timekeepingWorkedSegmentSchema),
  unpaidGaps: z.array(timekeepingUnpaidGapSchema),
})

const attendanceReconciliationCallOffSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  eventType: z.enum(['called_in_sick', 'call_off', 'no_call_no_show']),
  status: z.string(),
  note: z.string(),
  reportedAt: z.string(),
})

const attendanceReconciliationResolutionSchema = z.object({
  id: z.string().uuid(),
  action: attendanceReconciliationActionSchema,
  clientCreditStatus: attendanceClientCreditStatusSchema,
  reason: z.string(),
  resolvedBy: z.string().uuid(),
  resolvedByName: z.string().nullable(),
  resolvedAt: z.string(),
})

const attendanceReconciliationRowSchema = z.object({
  shiftId: z.string().uuid(),
  scheduleId: z.string().uuid(),
  operationalDate: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  headcountRequired: z.number().int().positive(),
  requiresArmed: z.boolean(),
  scheduledMinutesPerPosition: z.number().int().nonnegative(),
  scheduledCoverageMinutes: z.number().int().nonnegative(),
  actualPaidMinutes: z.number().int().nonnegative(),
  varianceMinutes: z.number().int(),
  scheduledEmployeeCount: z.number().int().nonnegative(),
  actualEmployeeCount: z.number().int().nonnegative(),
  scheduledMissingCount: z.number().int().nonnegative(),
  unexpectedActualCount: z.number().int().nonnegative(),
  siteId: z.string().uuid().nullable(),
  siteCode: z.string().nullable(),
  siteName: z.string().nullable(),
  postId: z.string().uuid().nullable(),
  postName: z.string().nullable(),
  eventId: z.string().uuid().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  scheduledEmployees: z.array(attendanceReconciliationScheduledEmployeeSchema),
  actualEmployees: z.array(attendanceReconciliationActualEmployeeSchema),
  callOffs: z.array(attendanceReconciliationCallOffSchema),
  discrepancyCodes: z.array(attendanceReconciliationDiscrepancySchema),
  requiresTimeCorrection: z.boolean(),
  occurrenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewStatus: z.union([z.literal('unresolved'), attendanceReconciliationActionSchema]),
  resolution: attendanceReconciliationResolutionSchema.nullable(),
})

const dailyAttendanceReviewSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  graceMinutes: z.number().int().positive(),
  rows: z.array(attendanceReconciliationRowSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  }),
})

const attendanceReconciliationDecisionResultSchema = z.object({
  id: z.string().uuid(),
  shiftId: z.string().uuid(),
  operationalDate: z.string(),
  occurrenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: attendanceReconciliationActionSchema,
  clientCreditStatus: attendanceClientCreditStatusSchema,
  reason: z.string(),
  resolvedBy: z.string().uuid(),
  resolvedAt: z.string(),
})

export type TimeEventKind = z.infer<typeof timeEventKindSchema>
export type TimekeepingShift = z.infer<typeof timekeepingShiftSchema>
export type TimekeepingEvent = z.infer<typeof timekeepingEventSchema>
export type TimekeepingDashboard = z.infer<typeof timekeepingDashboardSchema>
export type TimekeepingState = 'off_clock' | 'working' | 'on_break'
export type PayrollException = z.infer<typeof payrollExceptionSchema>
export type TimekeepingExceptionDetail = z.infer<typeof timekeepingExceptionDetailSchema>
export type TimekeepingExceptionResolution = z.infer<typeof timekeepingExceptionResolutionSchema>
export type TimekeepingExceptionResolutionAction = z.infer<typeof timekeepingExceptionResolutionActionSchema>
export type TimekeepingReview = z.infer<typeof timekeepingReviewSchema>
export type TimekeepingReviewRow = z.infer<typeof timekeepingReviewRowSchema>
export type PendingCorrection = z.infer<typeof pendingCorrectionSchema>
export type PayrollExportBatch = z.infer<typeof payrollExportBatchSchema>
export type PayrollExportDetail = z.infer<typeof payrollExportDetailSchema>
export type TimeMaintenance = z.infer<typeof timeMaintenanceSchema>
export type TimeMaintenanceEmployee = z.infer<typeof timeMaintenanceEmployeeSchema>
export type TimeMaintenanceEvent = z.infer<typeof timeMaintenanceEventSchema>
export type TimeMaintenanceShiftOption = z.infer<typeof timeMaintenanceShiftOptionSchema>
export type TeamAttendanceSummary = z.infer<typeof teamAttendanceSummarySchema>
export type TeamAttendanceSummaryRow = z.infer<typeof teamAttendanceSummaryRowSchema>
export type PayrollRules = z.infer<typeof payrollRulesSchema>
export type PayrollAssignmentCorrectionResult = z.infer<typeof payrollAssignmentCorrectionResultSchema>
export type PayrollRecalculationResult = z.infer<typeof payrollRecalculationResultSchema>
export type PayrollAccountabilityEvent = z.infer<typeof payrollAccountabilityEventSchema>
export type AttendanceReportResult = z.infer<typeof attendanceReportResultSchema>
export type WorkType = z.infer<typeof workTypeSchema>
export type AttendanceReconciliationDiscrepancy = z.infer<typeof attendanceReconciliationDiscrepancySchema>
export type AttendanceReconciliationAction = z.infer<typeof attendanceReconciliationActionSchema>
export type AttendanceClientCreditStatus = z.infer<typeof attendanceClientCreditStatusSchema>
export type AttendanceReconciliationRow = z.infer<typeof attendanceReconciliationRowSchema>
export type DailyAttendanceReview = z.infer<typeof dailyAttendanceReviewSchema>

export interface PayrollEmployeeSummary {
  employeeId: string
  employeeName: string
  username: string
  role: TimekeepingReviewRow['role']
  employmentType: TimekeepingReviewRow['employmentType']
  firstDate: string
  lastDate: string
  workedShiftCount: number
  locationCount: number
  grossMinutes: number
  breakMinutes: number
  paidMinutes: number
  regularMinutes: number
  overtimeMinutes: number
  postMinutes: number
  trainingMinutes: number
  readyCount: number
  exceptionCount: number
  payrollReady: boolean
  notes: string[]
}

const CLOCK_IN_WINDOW_BEFORE_MS = 12 * 60 * 60 * 1000
const CLOCK_IN_WINDOW_AFTER_MS = 6 * 60 * 60 * 1000

export interface ClockableShiftChoices {
  shifts: TimekeepingShift[]
  hiddenCount: number
  outsideWindowCount: number
  duplicateCount: number
}

async function authenticatedApiHeaders(): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure session is not available.')

  const headers = new Headers()
  headers.set('authorization', `Bearer ${data.session.access_token}`)
  headers.set('content-type', 'application/json')

  const trustedDeviceToken = getTrustedDeviceToken()
  if (trustedDeviceToken) headers.set('x-sygshift-trusted-device', trustedDeviceToken)

  return headers
}

async function parseAttendanceReportResponse(response: Response): Promise<AttendanceReportResult> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error.replaceAll('_', ' ')
        : 'The attendance report could not be saved.'
    throw new Error(message)
  }
  return attendanceReportResultSchema.parse(payload)
}

export const verifiedTimekeepingBaseline = {
  operationalTimeZone: 'America/Denver',
  punchWindow: 'Assigned shifts open for clock-in 12 hours before start and remain available until 6 hours after end.',
  guarantees: [
    'Official punch time comes from the secure server.',
    'Device time is stored only as supporting audit evidence.',
    'Punches are append-only, and corrections require a recorded reason.',
    'Employees must complete the active time session before starting another one.',
  ],
} as const

export function parseTimekeepingDashboard(value: unknown): TimekeepingDashboard {
  return timekeepingDashboardSchema.parse(value)
}

export function parseTimekeepingEvent(value: unknown): TimekeepingEvent {
  return timekeepingEventSchema.parse(value)
}

export function parseTimekeepingReview(value: unknown): TimekeepingReview {
  return timekeepingReviewSchema.parse(value)
}

export function parseTimeMaintenance(value: unknown): TimeMaintenance {
  return timeMaintenanceSchema.parse(value)
}

export function sortTimeMaintenanceEmployees(
  employees: TimeMaintenanceEmployee[],
): TimeMaintenanceEmployee[] {
  return [...employees].sort((left, right) => (
    left.displayName.localeCompare(right.displayName, 'en-US', { sensitivity: 'base' })
      || left.username.localeCompare(right.username, 'en-US', { sensitivity: 'base' })
  ))
}

export function parseTeamAttendanceSummary(value: unknown): TeamAttendanceSummary {
  return teamAttendanceSummarySchema.parse(value)
}

export function parsePayrollRules(value: unknown): PayrollRules {
  return payrollRulesSchema.parse(value)
}

export function parsePayrollExportBatch(value: unknown): PayrollExportBatch {
  return payrollExportBatchSchema.parse(value)
}

export function parsePayrollExportHistory(value: unknown): PayrollExportBatch[] {
  return z.array(payrollExportBatchSchema).parse(value)
}

export function parsePayrollExportDetail(value: unknown): PayrollExportDetail {
  return payrollExportDetailSchema.parse(value)
}

export function activeTimeState(lastEvent: TimekeepingEvent | null): TimekeepingState {
  if (!lastEvent || lastEvent.kind === 'clock_out') return 'off_clock'
  if (lastEvent.kind === 'break_start') return 'on_break'
  return 'working'
}

export function nextTimeEventKinds(state: TimekeepingState): TimeEventKind[] {
  if (state === 'off_clock') return ['clock_in']
  if (state === 'on_break') return ['break_end']
  return ['break_start', 'clock_out']
}

function shiftChoiceKey(shift: TimekeepingShift): string {
  return [
    shift.startsAt,
    shift.endsAt,
    shift.timeZone,
    shift.siteCode ?? '',
    shift.siteName ?? '',
    shift.postName ?? '',
    shift.eventName ?? '',
    shift.locationName ?? '',
    shift.requiresArmed ? 'armed' : 'unarmed',
    shift.isOvertime ? 'ot' : 'standard',
  ].join('|')
}

function isInsideClockInWindow(shift: TimekeepingShift, serverTimestamp: string): boolean {
  const serverTime = new Date(serverTimestamp).getTime()
  const startTime = new Date(shift.startsAt).getTime()
  const endTime = new Date(shift.endsAt).getTime()
  if (!Number.isFinite(serverTime) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return true
  return startTime <= serverTime + CLOCK_IN_WINDOW_BEFORE_MS && endTime >= serverTime - CLOCK_IN_WINDOW_AFTER_MS
}

export function getClockableShiftChoices(
  shifts: TimekeepingShift[],
  serverTimestamp: string,
): ClockableShiftChoices {
  const insideWindow = shifts.filter((shift) => isInsideClockInWindow(shift, serverTimestamp))
  const outsideWindowCount = shifts.length - insideWindow.length
  const seen = new Set<string>()
  const deduped: TimekeepingShift[] = []

  for (const shift of [...insideWindow].sort((left, right) => {
    const leftStart = new Date(left.startsAt).getTime()
    const rightStart = new Date(right.startsAt).getTime()
    if (leftStart !== rightStart) return leftStart - rightStart
    return new Date(left.endsAt).getTime() - new Date(right.endsAt).getTime()
  })) {
    const key = shiftChoiceKey(shift)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(shift)
  }

  const duplicateCount = insideWindow.length - deduped.length
  return {
    shifts: deduped,
    hiddenCount: outsideWindowCount + duplicateCount,
    outsideWindowCount,
    duplicateCount,
  }
}

export function applyRecordedTimeEventToDashboard(
  dashboard: TimekeepingDashboard,
  event: TimekeepingEvent,
): TimekeepingDashboard {
  const recordedEvent: TimekeepingEvent = {
    ...event,
    voided: event.voided ?? false,
  }
  const recentEvents = [
    recordedEvent,
    ...dashboard.recentEvents.filter((recentEvent) => recentEvent.id !== recordedEvent.id),
  ].slice(0, 10)

  return {
    ...dashboard,
    lastEvent: recordedEvent,
    recentEvents,
    serverTimestamp: recordedEvent.effectiveAt ?? recordedEvent.recordedAt,
  }
}

function requestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function optionTextKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function optionDateKey(value: string, timeZone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date)
}

function shiftOptionIdentity(option: TimeMaintenanceShiftOption): string {
  const dateKey = optionDateKey(option.startsAt, option.timeZone)
  const siteKey = optionTextKey(option.siteCode || option.siteName || option.locationName)
  const postKey = optionTextKey(option.postName)
  const eventKey = optionTextKey(option.eventName)
  const locationKey = optionTextKey(option.locationName)
  const kind = option.eventName ? 'event' : 'post'

  return [
    dateKey,
    kind,
    siteKey,
    postKey,
    eventKey,
    locationKey,
    option.requiresArmed ? 'armed' : 'unarmed',
  ].join('|')
}

function shiftOptionRank(option: TimeMaintenanceShiftOption): number {
  let rank = 0
  if (option.scheduleStatus === 'published') rank -= 100_000
  if (option.selectedEmployeeAssigned) rank -= 10_000
  rank -= option.scheduleRevision * 100
  return rank
}

export function dedupeTimeMaintenanceShiftOptions(options: TimeMaintenanceShiftOption[]): TimeMaintenanceShiftOption[] {
  const selected = new Map<string, TimeMaintenanceShiftOption>()

  for (const option of options) {
    const key = shiftOptionIdentity(option)
    const existing = selected.get(key)
    if (!existing) {
      selected.set(key, option)
      continue
    }

    const rankDiff = shiftOptionRank(option) - shiftOptionRank(existing)
    if (rankDiff < 0 || (rankDiff === 0 && option.startsAt.localeCompare(existing.startsAt) < 0)) {
      selected.set(key, option)
    }
  }

  return [...selected.values()].sort((left, right) => {
    const leftDate = optionDateKey(left.startsAt, left.timeZone)
    const rightDate = optionDateKey(right.startsAt, right.timeZone)
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
    const leftName = [left.siteCode, left.siteName, left.postName ?? left.eventName, left.locationName].filter(Boolean).join(' ')
    const rightName = [right.siteCode, right.siteName, right.postName ?? right.eventName, right.locationName].filter(Boolean).join(' ')
    const nameCompare = leftName.localeCompare(rightName, undefined, { sensitivity: 'base' })
    if (nameCompare !== 0) return nameCompare
    return left.startsAt.localeCompare(right.startsAt)
  })
}

export async function getTimekeepingDashboard(operationalDate?: string): Promise<TimekeepingDashboard> {
  const { data, error } = await getSupabaseClient().rpc('get_timekeeping_dashboard', {
    target_operational_date: operationalDate ?? null,
  })
  if (error) throw new Error('Timekeeping could not be loaded for this account.')
  return parseTimekeepingDashboard(data)
}

export async function recordTimeEvent(input: {
  kind: TimeEventKind
  shiftId?: string | null
  idempotencyKey?: string
}): Promise<TimekeepingEvent> {
  const { data, error } = await getSupabaseClient().rpc('record_time_event', {
    target_kind: input.kind,
    target_shift_id: input.shiftId ?? null,
    target_client_recorded_at: new Date().toISOString(),
    target_idempotency_key: input.idempotencyKey ?? requestKey(),
  })
  if (error) throw new Error(error.message || 'The time event could not be recorded.')
  return parseTimekeepingEvent(data)
}

export async function requestTimeEventCorrection(input: {
  timeEventId: string
  replacementTime?: string | null
  voided?: boolean
  reason: string
}): Promise<z.infer<typeof correctionResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('request_time_event_correction', {
    target_time_event_id: input.timeEventId,
    target_replacement_time: input.replacementTime ?? null,
    target_voided: input.voided ?? false,
    target_reason: input.reason,
  })
  if (error) throw new Error(error.message || 'The time correction could not be requested.')
  return correctionResultSchema.parse(data)
}

export async function getTimekeepingReview(input: {
  fromDate: string
  throughDate: string
}): Promise<TimekeepingReview> {
  const [reviewResult, workTypeResult] = await Promise.all([
    getSupabaseClient().rpc('get_timekeeping_review', {
      target_from_date: input.fromDate,
      target_through_date: input.throughDate,
    }),
    getSupabaseClient().rpc('get_time_work_type_map', {
      target_from_date: input.fromDate,
      target_through_date: input.throughDate,
    }),
  ])
  const { data, error } = reviewResult
  if (error) throw new Error(error.message || 'Supervisor time review could not be loaded.')
  const review = parseTimekeepingReview(data)
  if (workTypeResult.error) throw new Error(workTypeResult.error.message || 'Work classifications could not be loaded.')
  const workTypes = z.array(timeWorkTypeMapItemSchema).parse(workTypeResult.data ?? [])
  const workTypeByOccurrence = new Map(workTypes.map((item) => [
    `${item.employeeId}|${item.shiftId ?? ''}|${item.operationalDate}`,
    item,
  ]))

  return {
    ...review,
    rows: review.rows.map((row) => {
      const workType = workTypeByOccurrence.get(`${row.employeeId}|${row.shiftId ?? ''}|${row.operationalDate}`)
      if (!workType) return row
      return {
        ...row,
        mixedWorkTypes: workType.mixedWorkTypes,
        payCode: workType.payCode,
        workType: workType.workType,
        workTypeLabel: workType.label,
        workTypeOvertimeEligible: workType.overtimeEligible,
        workTypePaid: workType.paid,
        workTypeRateSource: workType.rateSource,
      }
    }),
  }
}

export async function correctTimeRecordWorkType(input: {
  timeEventId: string
  workType: WorkType
  reason: string
}): Promise<z.infer<typeof workTypeCorrectionResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('correct_time_event_work_type', {
    target_reason: input.reason,
    target_time_event_id: input.timeEventId,
    target_work_type: input.workType,
  })
  if (error) throw new Error(error.message || 'The work classification could not be corrected.')
  return workTypeCorrectionResultSchema.parse(data)
}

export async function getTeamAttendanceSummary(input: {
  fromDate: string
  throughDate: string
}): Promise<TeamAttendanceSummary> {
  const parameters = {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  }
  const [summaryResult, totalsResult] = await Promise.all([
    getSupabaseClient().rpc('get_team_attendance_summary', parameters),
    getSupabaseClient().rpc('get_team_attendance_totals', parameters),
  ])
  if (summaryResult.error) throw new Error(summaryResult.error.message || 'Team Attendance could not be loaded.')
  if (totalsResult.error) throw new Error(totalsResult.error.message || 'Team Attendance totals could not be loaded.')

  const summary = parseTeamAttendanceSummary(summaryResult.data)
  const totals = teamAttendanceTotalsSchema.parse(totalsResult.data)
  const totalsByEmployee = new Map(totals.rows.map((row) => [row.employeeId, row]))

  return {
    ...summary,
    rows: summary.rows.map((row) => ({
      ...row,
      ...totalsByEmployee.get(row.employeeId),
    })),
  }
}

function summarizeTimekeepingRows(rows: TimekeepingReviewRow[], pendingCorrections: PendingCorrection[]): TimekeepingReview['summary'] {
  return rows.reduce<TimekeepingReview['summary']>((summary, row) => {
    summary.rowCount += 1
    if (row.payrollReady) summary.readyCount += 1
    else summary.exceptionCount += 1
    summary.grossMinutes += row.grossMinutes
    summary.paidMinutes += row.paidMinutes
    summary.regularMinutes += row.regularMinutes
    summary.overtimeMinutes += row.overtimeMinutes
    summary.timeOffMinutes += row.timeOffMinutes
    summary.salaryDefaultMinutes += row.salaryDefaultMinutes
    return summary
  }, {
    exceptionCount: 0,
    grossMinutes: 0,
    overtimeMinutes: 0,
    paidMinutes: 0,
    pendingCorrectionCount: pendingCorrections.length,
    readyCount: 0,
    regularMinutes: 0,
    rowCount: 0,
    salaryDefaultMinutes: 0,
    timeOffMinutes: 0,
  })
}

export async function getOwnTimekeepingReview(input: {
  employeeId: string
  fromDate: string
  throughDate: string
}): Promise<TimekeepingReview> {
  const review = await getTimekeepingReview({
    fromDate: input.fromDate,
    throughDate: input.throughDate,
  })
  const rows = review.rows.filter((row) => row.employeeId === input.employeeId)
  const pendingCorrections = review.pendingCorrections.filter((correction) => correction.employeeId === input.employeeId)

  return {
    ...review,
    pendingCorrections,
    rows,
    summary: summarizeTimekeepingRows(rows, pendingCorrections),
  }
}

export async function getPayrollRules(): Promise<PayrollRules> {
  const { data, error } = await getSupabaseClient().rpc('get_payroll_rules')
  if (error) throw new Error(error.message || 'Payroll rules could not be loaded. MFA is required.')
  return parsePayrollRules(data)
}

export async function correctPayrollBatchAssignment(input: {
  occurrenceKey: string
  occurrenceFingerprint: string
  employeeId: string
  shiftId: string | null
  firstClockIn: string | null
  originalWeekStartsOn: string | null
  assignedWeekStartsOn: string
  reason: string
}): Promise<PayrollAssignmentCorrectionResult> {
  const { data, error } = await getSupabaseClient().rpc('correct_payroll_batch_assignment', {
    target_assigned_week_start: input.assignedWeekStartsOn,
    target_employee_id: input.employeeId,
    target_first_clock_in: input.firstClockIn,
    target_occurrence_fingerprint: input.occurrenceFingerprint,
    target_occurrence_key: input.occurrenceKey,
    target_original_week_start: input.originalWeekStartsOn,
    target_reason: input.reason,
    target_shift_id: input.shiftId,
  })
  if (error) throw new Error(error.message || 'The payroll batch assignment could not be corrected.')
  return payrollAssignmentCorrectionResultSchema.parse(data)
}

export async function recalculateOpenPayrollBatchAssignments(input: {
  fromDate: string
  throughDate: string
  dryRun?: boolean
}): Promise<PayrollRecalculationResult> {
  const { data, error } = await getSupabaseClient().rpc('recalculate_open_payroll_batch_assignments', {
    target_dry_run: input.dryRun ?? true,
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error(error.message || 'Open payroll assignments could not be recalculated.')
  return payrollRecalculationResultSchema.parse(data)
}

export async function getPayrollAccountabilityEvents(input: {
  fromDate: string
  throughDate: string
}): Promise<PayrollAccountabilityEvent[]> {
  const { data, error } = await getSupabaseClient().rpc('get_payroll_accountability_events', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error(error.message || 'Payroll accountability events could not be loaded.')
  return z.array(payrollAccountabilityEventSchema).parse(data)
}

export async function getDailyAttendanceReview(input: {
  fromDate: string
  throughDate: string
  includeResolved?: boolean
}): Promise<DailyAttendanceReview> {
  const { data, error } = await getSupabaseClient().rpc('get_daily_attendance_review', {
    target_from_date: input.fromDate,
    target_include_resolved: input.includeResolved ?? false,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error(error.message || 'Daily Attendance Review could not be loaded. MFA is required.')
  return dailyAttendanceReviewSchema.parse(data)
}

export async function resolveDailyAttendanceReview(input: {
  shiftId: string
  occurrenceFingerprint: string
  action: AttendanceReconciliationAction
  clientCreditStatus: AttendanceClientCreditStatus
  reason: string
}): Promise<z.infer<typeof attendanceReconciliationDecisionResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('resolve_daily_attendance_review', {
    target_action: input.action,
    target_client_credit_status: input.clientCreditStatus,
    target_occurrence_fingerprint: input.occurrenceFingerprint,
    target_reason: input.reason,
    target_shift_id: input.shiftId,
  })
  if (error) throw new Error(error.message || 'The attendance review decision could not be saved.')
  return attendanceReconciliationDecisionResultSchema.parse(data)
}

export async function reportAttendanceIssue(input: {
  eventType: 'called_in_sick' | 'call_off'
  note: string
  operationalDate?: string | null
  shiftId?: string | null
}): Promise<AttendanceReportResult> {
  const headers = await authenticatedApiHeaders()
  const response = await fetch('/api/v1/time/attendance/report', {
    body: JSON.stringify({
      eventType: input.eventType,
      note: input.note,
      operationalDate: input.operationalDate ?? null,
      shiftId: input.shiftId ?? null,
    }),
    headers,
    method: 'POST',
  })
  return parseAttendanceReportResponse(response)
}

export async function getTimeMaintenance(input: {
  fromDate: string
  throughDate: string
  employeeId?: string | null
}): Promise<TimeMaintenance> {
  const client = getSupabaseClient()
  const [maintenanceResult, workTypeResult] = await Promise.all([
    client.rpc('get_time_maintenance', {
      target_employee_id: input.employeeId ?? null,
      target_from_date: input.fromDate,
      target_through_date: input.throughDate,
    }),
    client.rpc('get_time_work_type_map', {
      target_from_date: input.fromDate,
      target_through_date: input.throughDate,
    }),
  ])
  if (maintenanceResult.error) throw new Error(maintenanceResult.error.message || 'Time maintenance could not be loaded. MFA is required.')
  if (workTypeResult.error) throw new Error(workTypeResult.error.message || 'Work classifications could not be loaded.')

  let maintenance: TimeMaintenance
  try {
    maintenance = parseTimeMaintenance(maintenanceResult.data)
  } catch {
    throw new Error('Time maintenance returned an unreadable record. Refresh the page. If the issue continues, contact an administrator.')
  }
  const workTypes = z.array(timeWorkTypeMapItemSchema).parse(workTypeResult.data ?? [])
  const workTypeByOccurrence = new Map(workTypes.map((item) => [
    `${item.employeeId}|${item.shiftId ?? ''}|${item.operationalDate}`,
    item,
  ]))
  const denverDate = (timestamp: string) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'America/Denver',
      year: 'numeric',
    }).formatToParts(new Date(timestamp))
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
  }

  return {
    ...maintenance,
    events: maintenance.events.map((event) => {
      const mapped = workTypeByOccurrence.get(`${event.employeeId}|${event.shiftId ?? ''}|${denverDate(event.effectiveAt)}`)
      return mapped ? { ...event, payCode: mapped.payCode, workType: mapped.workType, workTypeLabel: mapped.label } : event
    }),
  }
}

export async function getTimeMaintenanceShiftOptions(input: {
  fromDate: string
  throughDate: string
  employeeId?: string | null
}): Promise<TimeMaintenanceShiftOption[]> {
  const { data, error } = await getSupabaseClient().rpc('get_time_maintenance_shift_options', {
    target_employee_id: input.employeeId ?? null,
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error(error.message || 'Site/Post shift options could not be loaded. MFA is required.')
  return dedupeTimeMaintenanceShiftOptions(z.array(timeMaintenanceShiftOptionSchema).parse(data))
}

export async function reviewTimeEventCorrection(input: {
  correctionId: string
  approved: boolean
  note: string | null
}): Promise<z.infer<typeof correctionReviewResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('review_time_event_correction', {
    target_correction_id: input.correctionId,
    target_approved: input.approved,
    target_decision_note: input.note,
  })
  if (error) throw new Error(error.message || 'The correction decision could not be recorded.')
  return correctionReviewResultSchema.parse(data)
}

export async function resolveTimekeepingException(input: {
  employeeId: string
  shiftId: string | null
  operationalDate: string
  exceptionCode: PayrollException
  occurrenceFingerprint: string
  action: TimekeepingExceptionResolutionAction
  reason: string
}): Promise<TimekeepingExceptionResolution> {
  const { data, error } = await getSupabaseClient().rpc('resolve_timekeeping_exception', {
    target_action: input.action,
    target_employee_id: input.employeeId,
    target_exception_code: input.exceptionCode,
    target_occurrence_fingerprint: input.occurrenceFingerprint,
    target_operational_date: input.operationalDate,
    target_reason: input.reason,
    target_shift_id: input.shiftId,
  })
  if (error) throw new Error(error.message || 'The payroll exception decision could not be saved.')
  return timekeepingExceptionResolutionSchema.parse(data)
}

export async function supervisorRecordTimeEvent(input: {
  employeeId: string
  kind: TimeEventKind
  effectiveAt: string
  shiftId?: string | null
  reason: string
}): Promise<TimekeepingEvent> {
  const { data, error } = await getSupabaseClient().rpc('supervisor_record_time_event', {
    target_effective_at: input.effectiveAt,
    target_employee_id: input.employeeId,
    target_idempotency_key: requestKey(),
    target_kind: input.kind,
    target_reason: input.reason,
    target_shift_id: input.shiftId ?? null,
  })
  if (error) throw new Error(error.message || 'The time event could not be added.')
  return parseTimekeepingEvent(data)
}

export async function supervisorCorrectTimeEvent(input: {
  timeEventId: string
  replacementTime?: string | null
  replacementKind?: TimeEventKind | null
  voided?: boolean
  reason: string
}): Promise<z.infer<typeof correctionResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('supervisor_correct_time_event_details', {
    target_reason: input.reason,
    target_replacement_kind: input.replacementKind ?? null,
    target_replacement_time: input.replacementTime ?? null,
    target_time_event_id: input.timeEventId,
    target_voided: input.voided ?? false,
  })
  if (error) throw new Error(error.message || 'The time event could not be corrected.')
  return correctionResultSchema.parse(data)
}

export async function supervisorUpdateTimeEventLocation(input: {
  timeEventId: string
  locationName: string
  timeZone?: string | null
  reason: string
}): Promise<{
  id: string
  timeEventId: string
  locationName: string
  timeZone: string
  reason: string
}> {
  const { data, error } = await getSupabaseClient().rpc('supervisor_update_time_event_location', {
    target_location_name: input.locationName,
    target_reason: input.reason,
    target_time_event_id: input.timeEventId,
    target_time_zone: input.timeZone ?? 'America/Denver',
  })
  if (error) throw new Error(error.message || 'The punch location could not be updated.')
  return z.object({
    id: z.string().uuid(),
    timeEventId: z.string().uuid(),
    locationName: z.string(),
    timeZone: z.string(),
    reason: z.string(),
  }).parse(data)
}

export async function supervisorUpdateTimeEventSitePost(input: {
  timeEventId: string
  shiftId: string
  reason: string
}): Promise<{
  timeEventId: string
  shiftId: string
  affectedEventCount: number
  locationName: string
  siteName: string | null
  siteCode: string | null
  postName: string | null
  eventName: string | null
  reason: string
}> {
  const { data, error } = await getSupabaseClient().rpc('supervisor_update_time_event_site_post', {
    target_reason: input.reason,
    target_shift_id: input.shiftId,
    target_time_event_id: input.timeEventId,
  })
  if (error) throw new Error(error.message || 'The punch Site/Post could not be updated.')
  return z.object({
    affectedEventCount: z.number().int().positive(),
    eventName: z.string().nullable(),
    locationName: z.string(),
    postName: z.string().nullable(),
    reason: z.string(),
    shiftId: z.string().uuid(),
    siteCode: z.string().nullable(),
    siteName: z.string().nullable(),
    timeEventId: z.string().uuid(),
  }).parse(data)
}

export async function createPayrollExportBatch(input: {
  fromDate: string
  throughDate: string
  note: string
}): Promise<PayrollExportBatch> {
  const { data, error } = await getSupabaseClient().rpc('create_payroll_export_batch', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
    target_note: input.note,
  })
  if (error) throw new Error(error.message || 'Payroll export could not be locked.')
  return parsePayrollExportBatch(data)
}

export async function getPayrollExportHistory(limit = 20): Promise<PayrollExportBatch[]> {
  const { data, error } = await getSupabaseClient().rpc('get_payroll_export_history', {
    target_limit: limit,
  })
  if (error) throw new Error('Payroll export history could not be loaded. MFA is required.')
  return parsePayrollExportHistory(data)
}

export async function getPayrollExportBatchDetail(batchId: string): Promise<PayrollExportDetail> {
  const { data, error } = await getSupabaseClient().rpc('get_payroll_export_batch_detail', {
    target_batch_id: batchId,
  })
  if (error) throw new Error(error.message || 'Locked payroll export could not be loaded.')
  return parsePayrollExportDetail(data)
}

export function payrollHours(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

function payrollDate(value: string | null | undefined): string {
  if (!value) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return value
  return `${match[2]}/${match[3]}/${match[1]}`
}

function payrollDateTime(value: string | null | undefined, timeZone: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const civilian = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date)
  const military = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone,
  }).format(date)
  return `${civilian} (${military})`
}

function csvEscape(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const text = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function payrollLocationKey(row: TimekeepingReviewRow): string {
  return [
    row.siteCode,
    row.siteName,
    row.postName ?? row.eventName,
    row.locationName,
  ].filter(Boolean).join('|') || row.locationName
}

function payrollLocationLabel(row: TimekeepingReviewRow): string {
  return [
    row.siteCode,
    row.siteName,
    row.postName ?? row.eventName,
  ].filter(Boolean).join(' / ') || row.locationName
}

export function payrollWorkedRows(rows: TimekeepingReviewRow[]): TimekeepingReviewRow[] {
  return rows.filter((row) => row.rowKind === 'time_event')
}

export function payrollExportRows(rows: TimekeepingReviewRow[]): TimekeepingReviewRow[] {
  return payrollWorkedRows(rows).filter((row) =>
    Boolean(row.firstClockIn)
    && Boolean(row.lastClockOut)
    && row.payrollReady
    && row.exceptionCodes.length === 0
    && row.paidMinutes > 0,
  )
}

export function summarizePayrollRowsByEmployee(rows: TimekeepingReviewRow[]): PayrollEmployeeSummary[] {
  const summaries = new Map<string, PayrollEmployeeSummary & { locationKeys: Set<string>; noteKeys: Set<string> }>()

  for (const row of payrollWorkedRows(rows)) {
    const existing = summaries.get(row.employeeId)
    const summary = existing ?? {
      breakMinutes: 0,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      employmentType: row.employmentType,
      exceptionCount: 0,
      firstDate: row.operationalDate,
      grossMinutes: 0,
      lastDate: row.operationalDate,
      locationCount: 0,
      locationKeys: new Set<string>(),
      noteKeys: new Set<string>(),
      notes: [],
      overtimeMinutes: 0,
      paidMinutes: 0,
      payrollReady: true,
      postMinutes: 0,
      readyCount: 0,
      regularMinutes: 0,
      role: row.role,
      trainingMinutes: 0,
      username: row.username,
      workedShiftCount: 0,
    }

    summary.breakMinutes += row.breakMinutes
    summary.grossMinutes += row.grossMinutes
    summary.paidMinutes += row.paidMinutes
    summary.regularMinutes += row.regularMinutes
    summary.overtimeMinutes += row.overtimeMinutes
    if (row.workType === 'training') summary.trainingMinutes += row.paidMinutes
    else summary.postMinutes += row.paidMinutes
    summary.workedShiftCount += 1
    summary.firstDate = row.operationalDate < summary.firstDate ? row.operationalDate : summary.firstDate
    summary.lastDate = row.operationalDate > summary.lastDate ? row.operationalDate : summary.lastDate
    summary.locationKeys.add(payrollLocationKey(row))

    if (row.payrollReady && row.exceptionCodes.length === 0) {
      summary.readyCount += 1
    } else {
      summary.exceptionCount += 1
      summary.payrollReady = false
    }

    for (const note of [...row.exceptionCodes.map((code) => code.replaceAll('_', ' ')), ...row.payrollNotes]) {
      const cleanNote = note.trim()
      if (!cleanNote || summary.noteKeys.has(cleanNote)) continue
      summary.noteKeys.add(cleanNote)
      summary.notes.push(cleanNote)
    }

    summaries.set(row.employeeId, summary)
  }

  return [...summaries.values()]
    .map(({ locationKeys, noteKeys: _noteKeys, ...summary }) => ({
      ...summary,
      locationCount: locationKeys.size,
    }))
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' }))
}

export function reviewRowsToPayrollSummaryCsv(rows: TimekeepingReviewRow[]): string {
  const headers = [
    'Employee',
    'Username',
    'Role',
    'Employment',
    'First Worked Date',
    'Last Worked Date',
    'Worked Shifts',
    'Locations Worked',
    'Gross Hours',
    'Break Minutes',
    'Training Hours',
    'Paid Hours',
    'Regular Hours',
    'Overtime Hours',
    'Payroll Ready',
    'Rows Ready',
    'Rows Needing Review',
    'Notes',
  ]

  const lines = summarizePayrollRowsByEmployee(rows).map((summary) => [
    summary.employeeName,
    summary.username,
    summary.role,
    summary.employmentType,
    payrollDate(summary.firstDate),
    payrollDate(summary.lastDate),
    summary.workedShiftCount,
    summary.locationCount,
    payrollHours(summary.grossMinutes),
    summary.breakMinutes,
    payrollHours(summary.trainingMinutes),
    payrollHours(summary.paidMinutes),
    payrollHours(summary.regularMinutes),
    payrollHours(summary.overtimeMinutes),
    summary.payrollReady ? 'yes' : 'no',
    summary.readyCount,
    summary.exceptionCount,
    summary.notes.join('|'),
  ].map(csvEscape).join(','))

  return [headers.map(csvEscape).join(','), ...lines].join('\n')
}

export function reviewRowsToPayrollCsv(rows: TimekeepingReviewRow[]): string {
  const headers = [
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
    'Paid Hours',
    'Regular Hours',
    'Overtime Hours',
    'Overtime',
    'Payroll Ready',
    'Exceptions',
    'Shift Notes',
    'Notes',
  ]
  const lines = payrollExportRows(rows).map((row) => [
    row.rowKind,
    row.employeeName,
    row.username,
    payrollDate(row.operationalDate),
    payrollDate(row.weekStartsOn),
    payrollDate(row.weekEndsOn),
    payrollLocationLabel(row),
    payrollDateTime(row.firstClockIn, row.timeZone),
    payrollDateTime(row.lastClockOut, row.timeZone),
    payrollHours(row.grossMinutes),
    row.breakMinutes,
    payrollHours(row.paidMinutes),
    payrollHours(row.regularMinutes),
    payrollHours(row.overtimeMinutes),
    row.isOvertime ? 'yes' : 'no',
    row.payrollReady ? 'yes' : 'no',
    row.exceptionCodes.join('|'),
    row.shiftNotes ?? '',
    row.payrollNotes.join('|'),
  ].map(csvEscape).join(','))

  return [headers.map(csvEscape).join(','), ...lines].join('\n')
}

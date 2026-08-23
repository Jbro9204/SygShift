import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary', 'flex'])
const eventTypeSchema = z.enum([
  'called_in_sick',
  'call_off',
  'vacation',
  'no_call_no_show',
  'late_arrival',
  'early_departure',
  'other',
])
const reviewOutcomeSchema = z.enum(['confirmed', 'excused_protected', 'corrected', 'dismissed'])
const actionSchema = z.enum(['created', 'confirmed', 'excused_protected', 'corrected', 'dismissed', 'voided', 'reopened'])
const decisionSchema = z.enum(['confirmed', 'excused_protected', 'corrected', 'dismissed', 'voided', 'reopened'])

const employeeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
})

const shiftOptionSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  operationalDate: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  locationName: z.string(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
})

const actionHistorySchema = z.object({
  id: z.string().uuid(),
  action: actionSchema,
  reason: z.string(),
  actorId: z.string().uuid(),
  actorName: z.string(),
  actionAt: z.string(),
})

const scheduledEmployeeSchema = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  username: z.string().nullable(),
  assignmentStatus: z.string(),
})

const timelineEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  recordedAt: z.string(),
  effectiveAt: z.string(),
  shiftId: z.string().uuid().nullable(),
})

const workedSegmentSchema = z.object({
  segmentNumber: z.number().int().positive(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  paidMinutes: z.number().int().nonnegative(),
  breakMinutes: z.number().int().nonnegative(),
})

const unpaidGapSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  minutes: z.number().int().nonnegative(),
})

const actualEmployeeSchema = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  username: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  sequenceComplete: z.boolean(),
  firstClockIn: z.string().nullable(),
  lastClockOut: z.string().nullable(),
  paidMinutes: z.number().int().nonnegative(),
  breakMinutes: z.number().int().nonnegative(),
  unpaidGapMinutes: z.number().int().nonnegative(),
  eventTimeline: z.array(timelineEventSchema),
  workedSegments: z.array(workedSegmentSchema),
  unpaidGaps: z.array(unpaidGapSchema),
})

const reconciliationSchema = z.object({
  startsAt: z.string(),
  endsAt: z.string(),
  locationName: z.string(),
  scheduledCoverageMinutes: z.number().int().nonnegative(),
  actualPaidMinutes: z.number().int().nonnegative(),
  scheduledEmployees: z.array(scheduledEmployeeSchema),
  actualEmployees: z.array(actualEmployeeSchema),
  discrepancyCodes: z.array(z.string()),
})

const eventSchema = z.object({
  id: z.string().uuid(),
  sourceTable: z.enum(['attendance_accountability_events', 'call_off_reports', 'time_off_requests']),
  eventType: eventTypeSchema,
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
  shiftId: z.string().uuid().nullable(),
  reviewOutcome: reviewOutcomeSchema.nullable(),
  reviewedAt: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  reviewable: z.boolean(),
  actionHistory: z.array(actionHistorySchema),
  reconciliation: reconciliationSchema.nullable(),
})

const exceptionSummarySchema = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  unresolvedCount: z.number().int().nonnegative(),
  blockingCount: z.number().int().nonnegative(),
  oldestDetectedAt: z.string(),
  newestDetectedAt: z.string(),
  codes: z.array(z.string()),
})

const workspaceSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  capabilities: z.object({
    canCreate: z.boolean(),
    canManage: z.boolean(),
  }),
  employees: z.array(employeeSchema),
  shiftOptions: z.array(shiftOptionSchema),
  events: z.array(eventSchema),
  exceptionSummaries: z.array(exceptionSummarySchema),
})

const createResultSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  shiftId: z.string().uuid().nullable(),
  eventType: eventTypeSchema,
  status: z.string(),
  operationalDate: z.string(),
  createdAt: z.string(),
})

const reviewResultSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  reviewOutcome: reviewOutcomeSchema.nullable(),
  decisionNote: z.string().nullable(),
  reviewedBy: z.string().uuid(),
  reviewedAt: z.string(),
})

export type AccountabilityWorkspace = z.infer<typeof workspaceSchema>
export type AccountabilityEvent = z.infer<typeof eventSchema>
export type AccountabilityEventType = z.infer<typeof eventTypeSchema>
export type AccountabilityDecision = z.infer<typeof decisionSchema>

export async function getAccountabilityWorkspace(input: { fromDate: string; throughDate: string }): Promise<AccountabilityWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_accountability_workspace', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error(error.message || 'The Accountability Tracker could not be loaded. MFA is required.')
  return workspaceSchema.parse(data)
}

export async function createAccountabilityOccurrence(input: {
  employeeId: string
  shiftId: string | null
  eventType: AccountabilityEventType
  operationalDate: string | null
  note: string
}) {
  const { data, error } = await getSupabaseClient().rpc('create_attendance_accountability_event', {
    target_employee_id: input.employeeId,
    target_event_type: input.eventType,
    target_note: input.note,
    target_operational_date: input.operationalDate,
    target_shift_id: input.shiftId,
  })
  if (error) throw new Error(error.message || 'The accountability occurrence could not be recorded.')
  return createResultSchema.parse(data)
}

export async function reviewAccountabilityOccurrence(input: {
  eventId: string
  action: AccountabilityDecision
  reason: string
}) {
  const { data, error } = await getSupabaseClient().rpc('review_attendance_accountability_event', {
    target_action: input.action,
    target_event_id: input.eventId,
    target_reason: input.reason,
  })
  if (error) throw new Error(error.message || 'The accountability decision could not be saved.')
  return reviewResultSchema.parse(data)
}

import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { reportAttendanceIssue } from './timekeeping'

const roleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const requestStatusSchema = z.enum(['pending', 'approved', 'declined', 'withdrawn', 'canceled'])
export const timeOffRequestKinds = ['paid_vacation', 'sick_time', 'unpaid_time_off'] as const
export type TimeOffRequestKind = (typeof timeOffRequestKinds)[number]
const timeOffRequestKindSchema = z.enum(timeOffRequestKinds)

const affectedTimeOffShiftSchema = z.object({
  shiftId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  workday: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  siteCode: z.string().nullable(),
  siteName: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  location: z.string(),
  estimatedMinutes: z.number().int().nonnegative(),
})

const employeeSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  preferred_name: z.string().nullable(),
})

const requestShiftSchema = z.object({
  id: z.string().uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  title: z.string().optional(),
  location: z.string().optional(),
  post: z.object({
    id: z.string().uuid(),
    name: z.string(),
    site: z.object({ id: z.string().uuid(), name: z.string() }),
  }).nullable(),
  event: z.object({
    id: z.string().uuid(),
    name: z.string(),
    location_name: z.string().nullable(),
  }).nullable(),
})

const timeOffSchema = z.object({
  id: z.string().uuid(),
  employee_id: z.string().uuid(),
  employee_number: z.string().nullable().optional().default(null),
  starts_on: z.string(),
  ends_on: z.string(),
  partial_day_start: z.string().nullable(),
  partial_day_end: z.string().nullable(),
  request_type: timeOffRequestKindSchema.nullable().optional().default(null),
  employment_type_snapshot: z.enum(['hourly', 'salary', 'flex']).nullable().optional().default(null),
  pay_treatment: z.enum(['salary_paid_leave', 'sick_policy', 'unpaid']).nullable().optional().default(null),
  requested_minutes: z.number().int().nonnegative().nullable().optional().default(null),
  return_on: z.string().nullable().optional().default(null),
  affected_shift_count: z.number().int().nonnegative().optional().default(0),
  affected_shifts: z.array(affectedTimeOffShiftSchema).optional().default([]),
  reason: z.string().nullable(),
  status: requestStatusSchema,
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable().optional().default(null),
  decided_by_name: z.string().nullable().optional().default(null),
  updated_at: z.string().nullable().optional().default(null),
  created_at: z.string(),
  employee: employeeSchema,
})

const shiftRequestSchema = z.object({
  id: z.string().uuid(),
  employee_id: z.string().uuid(),
  status: requestStatusSchema,
  employee_note: z.string().nullable(),
  decision_note: z.string().nullable(),
  created_at: z.string(),
  employee: employeeSchema,
  shift: requestShiftSchema,
})

const callOffSchema = z.object({
  id: z.string().uuid(),
  employee_id: z.string().uuid(),
  reason: z.string().nullable(),
  reported_at: z.string(),
  acknowledged_at: z.string().nullable(),
  announcement_id: z.string().uuid().nullable(),
  resolved_at: z.string().nullable(),
  employee: employeeSchema,
  shift: requestShiftSchema,
})

const assignmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['assigned', 'confirmed']),
  shift: requestShiftSchema,
})

export type TimeOffRequest = z.infer<typeof timeOffSchema>
export type ShiftWorkRequest = z.infer<typeof shiftRequestSchema>
export type CallOffReport = z.infer<typeof callOffSchema>
export type UpcomingAssignment = z.infer<typeof assignmentSchema>
export type RequestShift = z.infer<typeof requestShiftSchema>
export type RequestEmployee = z.infer<typeof employeeSchema>

const coverageModeSchema = z.enum(['open_pool', 'assigned_guard', 'patrol_review', 'no_replacement'])
const coverageStatusSchema = z.enum(['draft', 'open_pool', 'assigned', 'patrol_review', 'no_replacement', 'closed', 'canceled'])
const coverageCandidateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  employeeNumber: z.string().nullable(),
  employmentType: z.enum(['hourly', 'salary', 'flex']),
  workClassification: z.string().nullable(),
  // Older coverage payloads could return SQL null when a non-Flex employee had
  // no work classification. Derive the safe boolean from the authoritative
  // employment fields so a single legacy row cannot take down the worklist.
  isFlex: z.boolean().nullable().optional(),
  available: z.boolean(),
  noOverlap: z.boolean(),
  armedReady: z.boolean(),
  overtimeMinutes: z.number().int().nonnegative(),
  requiresOvertimeApproval: z.boolean(),
  eligible: z.boolean(),
  recommended: z.boolean(),
  blockReason: z.string().nullable(),
}).transform((candidate) => ({
  ...candidate,
  isFlex: candidate.isFlex
    ?? (candidate.employmentType === 'flex'
      || candidate.workClassification?.trim().toLowerCase() === 'flex'),
}))

const coverageWorkspaceSchema = z.object({
  actionable: z.boolean().optional().default(false),
  nonActionableReason: z.string().nullable().optional().default(null),
  callOff: z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    reason: z.string().nullable(),
    reportedAt: z.string(),
    replacementNeeded: z.boolean(),
  }),
  shift: z.object({
    id: z.string().uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
    timeZone: z.string(),
    title: z.string(),
    location: z.string(),
    requiresArmed: z.boolean(),
    isOpen: z.boolean(),
  }),
  coverageCase: z.object({
    id: z.string().uuid(),
    status: coverageStatusSchema,
    coverageMode: coverageModeSchema.nullable(),
    replacementEmployeeId: z.string().uuid().nullable(),
    replacementAssignmentId: z.string().uuid().nullable(),
    coverageShiftId: z.string().uuid().nullable(),
    announcementId: z.string().uuid().nullable(),
    allowOvertimeWave: z.boolean(),
    originalAssignment: z.record(z.string(), z.unknown()),
    openedAt: z.string(),
    resolvedAt: z.string().nullable(),
  }).nullable(),
  candidates: z.array(coverageCandidateSchema),
  actions: z.array(z.object({
    id: z.string().uuid(),
    action: z.string(),
    actorId: z.string().uuid().nullable(),
    actorName: z.string(),
    reason: z.string(),
    createdAt: z.string(),
  })),
  attendancePolicy: z.object({ pointsActive: z.boolean(), message: z.string() }),
  patrolFallback: z.object({ available: z.boolean(), message: z.string() }),
})

const coverageResolutionSchema = z.object({
  coverageCaseId: z.string().uuid(),
  status: coverageStatusSchema,
  coverageMode: coverageModeSchema,
  coverageShiftId: z.string().uuid().nullable(),
  announcementId: z.string().uuid().nullable(),
  replacementAssignmentId: z.string().uuid().nullable(),
  idempotentReplay: z.boolean(),
})

export type CallOffCoverageWorkspace = z.infer<typeof coverageWorkspaceSchema>
export type CallOffCoverageCandidate = z.infer<typeof coverageCandidateSchema>
export type CallOffCoverageMode = z.infer<typeof coverageModeSchema>

export function parseCallOffCoverageWorkspace(input: unknown): CallOffCoverageWorkspace {
  const parsed = coverageWorkspaceSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error('The coverage details could not be verified. Refresh and try again.')
  }
  return parsed.data
}

export interface RequestCenter {
  employeeId: string
  employeeTimeZone: string | null
  role: z.infer<typeof roleSchema>
  permissions: {
    canManage: boolean
  }
  timeOffHistory: {
    managerHistoryLimit: number | null
    truncated: boolean
  }
  timeOff: TimeOffRequest[]
  shiftRequests: ShiftWorkRequest[]
  callOffs: CallOffReport[]
  upcomingAssignments: UpcomingAssignment[]
}

interface RequestCenterRecords {
  timeOff: TimeOffRequest[]
  shiftRequests: ShiftWorkRequest[]
  callOffs: CallOffReport[]
  assignments: UpcomingAssignment[]
}

function parseRecordArray<T>(schema: z.ZodType<T>, input: unknown): T[] {
  const rows = Array.isArray(input) ? input : []
  return rows.flatMap((row) => {
    const result = schema.safeParse(row)
    return result.success ? [result.data] : []
  })
}

export function parseRequestCenterRecords(input: {
  timeOff: unknown
  shiftRequests: unknown
  callOffs: unknown
  assignments: unknown
}): RequestCenterRecords {
  return {
    timeOff: parseRecordArray(timeOffSchema, input.timeOff),
    shiftRequests: parseRecordArray(shiftRequestSchema, input.shiftRequests),
    callOffs: parseRecordArray(callOffSchema, input.callOffs),
    assignments: parseRecordArray(assignmentSchema, input.assignments),
  }
}

const rpcShiftSchema = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  title: z.string(),
  location: z.string(),
})

export const requestCenterPayloadSchema = z.object({
  employeeId: z.string().uuid(),
  employeeTimeZone: z.string().nullable().optional().default(null),
  role: roleSchema,
  permissions: z.object({
    canManage: z.boolean(),
  }),
  timeOffHistory: z.object({
    managerHistoryLimit: z.number().int().positive().nullable(),
    truncated: z.boolean(),
  }).optional().default({ managerHistoryLimit: null, truncated: false }),
  timeOff: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    employeeNumber: z.string().nullable().optional().default(null),
    startsOn: z.string(),
    endsOn: z.string(),
    partialDayStart: z.string().nullable(),
    partialDayEnd: z.string().nullable(),
    requestType: timeOffRequestKindSchema.nullable().optional().default(null),
    employmentType: z.enum(['hourly', 'salary', 'flex']).nullable().optional().default(null),
    payTreatment: z.enum(['salary_paid_leave', 'sick_policy', 'unpaid']).nullable().optional().default(null),
    requestedMinutes: z.number().int().nonnegative().nullable().optional().default(null),
    returnOn: z.string().nullable().optional().default(null),
    affectedShiftCount: z.number().int().nonnegative().optional().default(0),
    affectedShifts: z.array(affectedTimeOffShiftSchema).optional().default([]),
    reason: z.string().nullable(),
    status: requestStatusSchema,
    decisionNote: z.string().nullable(),
    decidedAt: z.string().nullable().optional().default(null),
    decidedByName: z.string().nullable().optional().default(null),
    updatedAt: z.string().nullable().optional().default(null),
    createdAt: z.string(),
  })),
  shiftRequests: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    status: requestStatusSchema,
    employeeNote: z.string().nullable(),
    decisionNote: z.string().nullable(),
    createdAt: z.string(),
    shift: rpcShiftSchema,
  })),
  callOffs: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    reason: z.string().nullable(),
    reportedAt: z.string(),
    acknowledgedAt: z.string().nullable(),
    announcementId: z.string().uuid().nullable(),
    resolvedAt: z.string().nullable(),
    shift: rpcShiftSchema,
  })),
  upcomingAssignments: z.array(z.object({
    id: z.string().uuid(),
    status: z.enum(['assigned', 'confirmed']),
    shift: rpcShiftSchema,
  })),
})

export function parseRequestCenterPayload(input: unknown) {
  return requestCenterPayloadSchema.parse(input)
}

function employeeFromPayload(id: string, displayName: string): z.infer<typeof employeeSchema> {
  const trimmedName = displayName.trim() || 'Employee'
  return {
    id,
    first_name: trimmedName,
    last_name: '',
    preferred_name: trimmedName,
  }
}

function shiftFromPayload(shift: z.infer<typeof rpcShiftSchema>): RequestShift {
  return {
    id: shift.id,
    starts_at: shift.startsAt,
    ends_at: shift.endsAt,
    time_zone: shift.timeZone,
    title: shift.title,
    location: shift.location,
    post: null,
    event: null,
  }
}

export async function getRequestCenter(): Promise<RequestCenter> {
  const { data, error } = await getSupabaseClient().rpc('get_request_center_payload')

  if (error) {
    throw new Error(error.message || 'The request center could not be loaded for this account.')
  }

  const payload = parseRequestCenterPayload(data)
  const records: RequestCenterRecords = {
    timeOff: payload.timeOff.map((request) => ({
      id: request.id,
      employee_id: request.employeeId,
      employee_number: request.employeeNumber,
      starts_on: request.startsOn,
      ends_on: request.endsOn,
      partial_day_start: request.partialDayStart,
      partial_day_end: request.partialDayEnd,
      request_type: request.requestType,
      employment_type_snapshot: request.employmentType,
      pay_treatment: request.payTreatment,
      requested_minutes: request.requestedMinutes,
      return_on: request.returnOn,
      affected_shift_count: request.affectedShiftCount,
      affected_shifts: request.affectedShifts,
      reason: request.reason,
      status: request.status,
      decision_note: request.decisionNote,
      decided_at: request.decidedAt,
      decided_by_name: request.decidedByName,
      updated_at: request.updatedAt,
      created_at: request.createdAt,
      employee: employeeFromPayload(request.employeeId, request.employeeName),
    })),
    shiftRequests: payload.shiftRequests.map((request) => ({
      id: request.id,
      employee_id: request.employeeId,
      status: request.status,
      employee_note: request.employeeNote,
      decision_note: request.decisionNote,
      created_at: request.createdAt,
      employee: employeeFromPayload(request.employeeId, request.employeeName),
      shift: shiftFromPayload(request.shift),
    })),
    callOffs: payload.callOffs.map((report) => ({
      id: report.id,
      employee_id: report.employeeId,
      reason: report.reason,
      reported_at: report.reportedAt,
      acknowledged_at: report.acknowledgedAt,
      announcement_id: report.announcementId,
      resolved_at: report.resolvedAt,
      employee: employeeFromPayload(report.employeeId, report.employeeName),
      shift: shiftFromPayload(report.shift),
    })),
    assignments: payload.upcomingAssignments.map((assignment) => ({
      id: assignment.id,
      status: assignment.status,
      shift: shiftFromPayload(assignment.shift),
    })),
  }
  const upcomingAssignments = records.assignments

  return {
    employeeId: payload.employeeId,
    employeeTimeZone: payload.employeeTimeZone,
    role: payload.role,
    permissions: payload.permissions,
    timeOffHistory: payload.timeOffHistory,
    timeOff: records.timeOff,
    shiftRequests: records.shiftRequests,
    callOffs: records.callOffs,
    upcomingAssignments,
  }
}

export interface TimeOffInput {
  startsOn: string
  endsOn: string
  partialStart: string | null
  partialEnd: string | null
  reason: string | null
}

const timeOffEmployeeContextSchema = z.object({
  id: z.string().uuid(),
  employeeNumber: z.string().nullable(),
  name: z.string(),
  employmentType: z.enum(['hourly', 'salary', 'flex']),
  timeZone: z.string().nullable().optional().default(null),
  status: z.literal('active'),
})

const recentTimeOffRequestSchema = z.object({
  id: z.string().uuid(),
  requestType: z.enum(timeOffRequestKinds).nullable(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: requestStatusSchema,
  createdAt: z.string(),
})

const timeOffRequestContextSchema = z.object({
  employee: timeOffEmployeeContextSchema,
  allowedTypes: z.array(z.enum(timeOffRequestKinds)),
  affectedShifts: z.array(affectedTimeOffShiftSchema),
  requestedMinutes: z.number().int().nonnegative().nullable().optional().default(null),
  recentRequests: z.array(recentTimeOffRequestSchema),
})

const timeOffReviewContextSchema = z.object({
  id: z.string().uuid(),
  employee: z.object({
    id: z.string().uuid(),
    employeeNumber: z.string().nullable(),
    name: z.string(),
    timeZone: z.string().nullable().optional().default(null),
  }),
  requestType: z.enum(timeOffRequestKinds).nullable(),
  employmentType: z.enum(['hourly', 'salary', 'flex']).nullable(),
  payTreatment: z.enum(['salary_paid_leave', 'sick_policy', 'unpaid']).nullable(),
  startsOn: z.string(),
  endsOn: z.string(),
  partialStart: z.string().nullable(),
  partialEnd: z.string().nullable(),
  returnOn: z.string().nullable(),
  requestedMinutes: z.number().int().nonnegative().nullable(),
  reason: z.string().nullable(),
  status: requestStatusSchema,
  createdAt: z.string(),
  affectedShifts: z.array(affectedTimeOffShiftSchema),
  decisionNote: z.string().nullable(),
  decisionSnapshot: z.unknown().nullable(),
})

export type AffectedTimeOffShift = z.infer<typeof affectedTimeOffShiftSchema>
export type TimeOffRequestContext = z.infer<typeof timeOffRequestContextSchema>
export type TimeOffReviewContext = z.infer<typeof timeOffReviewContextSchema>

export interface TimeOffRequestV2Input {
  requestType: TimeOffRequestKind
  startsOn: string
  endsOn: string
  partialStart: string | null
  partialEnd: string | null
  returnOn: string | null
  reason: string | null
}

export async function getTimeOffRequestContext(
  startsOn?: string,
  endsOn?: string,
  partialStart: string | null = null,
  partialEnd: string | null = null,
): Promise<TimeOffRequestContext> {
  const { data, error } = await getSupabaseClient().rpc('get_time_off_request_context_v2', {
    request_starts_on: startsOn || null,
    request_ends_on: endsOn || null,
    request_partial_start: partialStart,
    request_partial_end: partialEnd,
  })
  if (error) throw new Error(error.message || 'Time-off request details could not be loaded.')
  return timeOffRequestContextSchema.parse(data)
}

export async function submitTimeOffRequestV2(input: TimeOffRequestV2Input): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('submit_time_off_request_v2', {
    request_kind: input.requestType,
    request_starts_on: input.startsOn,
    request_ends_on: input.endsOn,
    request_partial_start: input.partialStart,
    request_partial_end: input.partialEnd,
    request_return_on: input.returnOn,
    request_reason: input.reason,
  })
  if (error) throw new Error(error.message || 'The time-off request could not be submitted.')
  return z.string().uuid().parse(data)
}

export async function getTimeOffReviewContext(requestId: string): Promise<TimeOffReviewContext> {
  const { data, error } = await getSupabaseClient().rpc('get_time_off_review_context', {
    target_request_id: requestId,
  })
  if (error) throw new Error(error.message || 'The time-off request could not be opened for review.')
  return timeOffReviewContextSchema.parse(data)
}

export async function decideTimeOffRequestV2(
  requestId: string,
  decision: 'approved' | 'declined',
  note: string,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('decide_time_off_request_v2', {
    target_request_id: requestId,
    target_decision: decision,
    target_note: note,
  })
  if (error) throw new Error(error.message || 'The time-off decision could not be saved.')
}

export async function submitTimeOff(input: TimeOffInput): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('submit_time_off_request', {
    request_starts_on: input.startsOn,
    request_ends_on: input.endsOn,
    request_partial_start: input.partialStart,
    request_partial_end: input.partialEnd,
    request_reason: input.reason,
  })
  if (error) throw new Error('The time-off request was not saved. Check the dates for conflicts.')
  return z.string().uuid().parse(data)
}

export async function withdrawTimeOff(requestId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('withdraw_time_off_request', {
    target_request_id: requestId,
  })
  if (error) throw new Error('The time-off request could not be withdrawn in its current state.')
}

export async function reportCallOff(shiftId: string, reason: string): Promise<string> {
  const result = await reportAttendanceIssue({
    eventType: 'call_off',
    note: reason,
    shiftId,
  })
  return result.callOffId ?? result.id
}

export async function decideTimeOff(
  requestId: string,
  decision: 'approved' | 'declined',
  note: string | null,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('decide_time_off_request', {
    target_request_id: requestId,
    target_decision: decision,
    target_note: note,
  })
  if (error) throw new Error(error.message || 'The time-off decision was not saved.')
}

export async function decideShiftRequest(
  requestId: string,
  decision: 'approved' | 'declined',
  note: string | null,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('decide_shift_request', {
    target_request_id: requestId,
    target_decision: decision,
    target_note: note,
  })
  if (error) throw new Error('The shift decision was not saved. The opening may already be filled.')
}

export async function publishCallOffOpening(
  callOffId: string,
  title: string,
  body: string,
): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('publish_call_off_opening', {
    target_call_off_id: callOffId,
    announcement_title: title,
    announcement_body: body,
  })
  if (error) throw new Error('The replacement opening was not published. Refresh the call-off queue.')
  return z.string().uuid().parse(data)
}

export async function getCallOffCoverageWorkspace(callOffId: string): Promise<CallOffCoverageWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_call_off_coverage_workspace', {
    target_call_off_id: callOffId,
  })
  if (error) {
    throw new Error('The coverage review could not be loaded. Refresh and confirm your secure session is current.')
  }
  return parseCallOffCoverageWorkspace(data)
}

export async function resolveCallOffCoverage(input: {
  callOffId: string
  mode: CallOffCoverageMode
  replacementEmployeeId: string | null
  announcementTitle: string | null
  announcementBody: string | null
  reason: string
  allowOvertime: boolean
  idempotencyKey: string
}) {
  const { data, error } = await getSupabaseClient().rpc('resolve_call_off_coverage', {
    announcement_body: input.announcementBody,
    announcement_title: input.announcementTitle,
    target_allow_overtime: input.allowOvertime,
    target_call_off_id: input.callOffId,
    target_idempotency_key: input.idempotencyKey,
    target_mode: input.mode,
    target_reason: input.reason.trim(),
    target_replacement_employee_id: input.replacementEmployeeId,
  })
  if (error) throw new Error(error.message || 'The coverage decision could not be saved. Nothing was changed.')
  return coverageResolutionSchema.parse(data)
}

export function employeeName(employee: z.infer<typeof employeeSchema>): string {
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`.trim()
}

export function requestShiftTitle(shift: RequestShift): string {
  return shift.title ?? shift.event?.name ?? shift.post?.name ?? 'Assigned shift'
}

export function requestShiftLocation(shift: RequestShift): string {
  return shift.location ?? shift.post?.site.name ?? shift.event?.location_name ?? 'Location pending'
}

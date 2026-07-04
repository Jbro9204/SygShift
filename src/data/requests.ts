import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const roleSchema = z.enum(['guard', 'supervisor', 'admin'])
const requestStatusSchema = z.enum(['pending', 'approved', 'declined', 'withdrawn', 'canceled'])

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
  starts_on: z.string(),
  ends_on: z.string(),
  partial_day_start: z.string().nullable(),
  partial_day_end: z.string().nullable(),
  reason: z.string().nullable(),
  status: requestStatusSchema,
  decision_note: z.string().nullable(),
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

export interface RequestCenter {
  employeeId: string
  role: z.infer<typeof roleSchema>
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

const requestCenterPayloadSchema = z.object({
  employeeId: z.string().uuid(),
  role: roleSchema,
  timeOff: z.array(z.object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
    partialDayStart: z.string().nullable(),
    partialDayEnd: z.string().nullable(),
    reason: z.string().nullable(),
    status: requestStatusSchema,
    decisionNote: z.string().nullable(),
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

  const payload = requestCenterPayloadSchema.parse(data)
  const records: RequestCenterRecords = {
    timeOff: payload.timeOff.map((request) => ({
      id: request.id,
      employee_id: request.employeeId,
      starts_on: request.startsOn,
      ends_on: request.endsOn,
      partial_day_start: request.partialDayStart,
      partial_day_end: request.partialDayEnd,
      reason: request.reason,
      status: request.status,
      decision_note: request.decisionNote,
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
    role: payload.role,
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
  const { data, error } = await getSupabaseClient().rpc('report_call_off', {
    target_shift_id: shiftId,
    call_off_reason: reason,
  })
  if (error) throw new Error('The call-off was not saved. Refresh and confirm the assignment is active.')
  return z.string().uuid().parse(data)
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
  if (error) throw new Error('The time-off decision was not saved. Check for assigned-shift conflicts.')
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

export function employeeName(employee: z.infer<typeof employeeSchema>): string {
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`.trim()
}

export function requestShiftTitle(shift: RequestShift): string {
  return shift.title ?? shift.event?.name ?? shift.post?.name ?? 'Assigned shift'
}

export function requestShiftLocation(shift: RequestShift): string {
  return shift.location ?? shift.post?.site.name ?? shift.event?.location_name ?? 'Location pending'
}

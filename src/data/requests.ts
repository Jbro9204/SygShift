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

const employeeSelection = 'employee:employees (id, first_name, last_name, preferred_name)'
const shiftSelection = `
  shift:shifts (
    id,
    starts_at,
    ends_at,
    time_zone,
    post:posts (id, name, site:sites (id, name)),
    event:events (id, name, location_name)
  )
`

export async function getRequestCenter(): Promise<RequestCenter> {
  const client = getSupabaseClient()
  const [employeeResult, roleResult] = await Promise.all([
    client.rpc('current_employee_id'),
    client.rpc('current_app_role'),
  ])

  if (employeeResult.error || !employeeResult.data) {
    throw new Error('An active employee account is required to view requests.')
  }
  if (roleResult.error || !roleResult.data) {
    throw new Error('Your application role could not be verified.')
  }

  const employeeId = z.string().uuid().parse(employeeResult.data)
  const role = roleSchema.parse(roleResult.data)
  const privileged = role === 'supervisor' || role === 'admin'

  let timeOffQuery = client
    .from('time_off_requests')
    .select(`
      id, employee_id, starts_on, ends_on, partial_day_start, partial_day_end,
      reason, status, decision_note, created_at, ${employeeSelection}
    `)
    .order('created_at', { ascending: false })
    .limit(200)
  let shiftRequestQuery = client
    .from('shift_requests')
    .select(`
      id, employee_id, status, employee_note, decision_note, created_at,
      ${employeeSelection}, ${shiftSelection}
    `)
    .order('created_at', { ascending: false })
    .limit(200)
  let callOffQuery = client
    .from('call_off_reports')
    .select(`
      id, employee_id, reason, reported_at, acknowledged_at, announcement_id,
      resolved_at, ${employeeSelection}, ${shiftSelection}
    `)
    .order('reported_at', { ascending: false })
    .limit(200)

  if (privileged) {
    timeOffQuery = timeOffQuery.eq('status', 'pending')
    shiftRequestQuery = shiftRequestQuery.eq('status', 'pending')
    callOffQuery = callOffQuery.is('announcement_id', null).is('resolved_at', null)
  } else {
    timeOffQuery = timeOffQuery.eq('employee_id', employeeId)
    shiftRequestQuery = shiftRequestQuery.eq('employee_id', employeeId)
    callOffQuery = callOffQuery.eq('employee_id', employeeId)
  }

  const assignmentPromise = privileged
    ? Promise.resolve({ data: [], error: null })
    : client
        .from('shift_assignments')
        .select(`id, status, ${shiftSelection}`)
        .eq('employee_id', employeeId)
        .in('status', ['assigned', 'confirmed'])
        .limit(100)

  const [timeOffResult, shiftRequestResult, callOffResult, assignmentResult] = await Promise.all([
    timeOffQuery,
    shiftRequestQuery,
    callOffQuery,
    assignmentPromise,
  ])

  if (timeOffResult.error || shiftRequestResult.error || callOffResult.error || assignmentResult.error) {
    throw new Error('The request center could not be loaded for this account.')
  }

  const records = parseRequestCenterRecords({
    timeOff: timeOffResult.data,
    shiftRequests: shiftRequestResult.data,
    callOffs: callOffResult.data,
    assignments: assignmentResult.data,
  })
  const upcomingAssignments = records.assignments
    .filter((assignment) => new Date(assignment.shift.ends_at) > new Date())
    .sort((left, right) => left.shift.starts_at.localeCompare(right.shift.starts_at))

  return {
    employeeId,
    role,
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
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`
}

export function requestShiftTitle(shift: RequestShift): string {
  return shift.event?.name ?? shift.post?.name ?? 'Assigned shift'
}

export function requestShiftLocation(shift: RequestShift): string {
  return shift.post?.site.name ?? shift.event?.location_name ?? 'Location pending'
}

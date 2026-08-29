import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const employeeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  employmentType: z.string(),
})

const postSchema = z.object({
  id: z.string().uuid(),
  siteId: z.string().uuid(),
  siteCode: z.string().nullable().optional(),
  siteName: z.string(),
  postName: z.string(),
  timeZone: z.string(),
})

const shiftSchema = z.object({
  shiftId: z.string().uuid(),
  employeeId: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  location: z.string(),
  postId: z.string().uuid().nullable(),
})

const operationalExceptionSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  shiftId: z.string().uuid(),
  exceptionCode: z.enum(['automatic_clock_out', 'missing_clock_in']),
  status: z.enum(['unresolved', 'resolved', 'dismissed']),
  severity: z.string(),
  scheduledStartAt: z.string(),
  scheduledEndAt: z.string(),
  location: z.string(),
  sourceTimeEventId: z.string().uuid().nullable(),
  detectedAt: z.string(),
  resolutionMethod: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
})

const adjustmentRequestSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  shiftId: z.string().uuid().nullable(),
  workDate: z.string(),
  issueType: z.enum(['clock_in', 'clock_out', 'both_punches', 'missing_shift', 'other']),
  requestedClockInAt: z.string().nullable(),
  requestedClockOutAt: z.string().nullable(),
  requestedPostId: z.string().uuid().nullable().optional().default(null),
  requestedLocation: z.string().nullable().optional().default(null),
  requestedTimeZone: z.string().nullable().optional().default(null),
  requestedUnpaidBreakMinutes: z.number().int().nonnegative().optional().default(0),
  appliedTimeEventIds: z.array(z.string().uuid()).optional().default([]),
  reason: z.string(),
  notes: z.string().nullable(),
  status: z.enum(['submitted', 'under_review', 'approved', 'partially_approved', 'rejected', 'canceled']),
  submittedAt: z.string(),
  reviewedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  reviewer: z.string().nullable(),
})

const missingTimeRequestWorkspaceSchema = z.object({
  serverTimestamp: z.string(),
  canReviewAdjustments: z.boolean(),
  posts: z.array(postSchema),
  requests: z.array(adjustmentRequestSchema),
})

const alertSchema = z.object({
  id: z.string().uuid(),
  alertType: z.string(),
  priority: z.enum(['normal', 'high', 'urgent']),
  title: z.string(),
  summary: z.string(),
  employeeId: z.string().uuid().nullable(),
  shiftId: z.string().uuid().nullable(),
  directPath: z.string().nullable(),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
})

const manualEntryHistorySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  beforeValues: z.record(z.string(), z.unknown()).nullable(),
  afterValues: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string(),
  actor: z.string(),
  createdAt: z.string(),
})

const manualEntrySchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  workDate: z.string(),
  clockInAt: z.string(),
  clockOutAt: z.string(),
  shiftId: z.string().uuid().nullable(),
  postId: z.string().uuid().nullable(),
  reason: z.string(),
  notes: z.string().nullable(),
  approvalStatus: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  lastEditedBy: z.string().nullable(),
  lastEditedAt: z.string().nullable(),
  history: z.array(manualEntryHistorySchema),
})

const adjustmentActionSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  action: z.string(),
  note: z.string().nullable(),
  actor: z.string(),
  createdAt: z.string(),
})

const callOffReportSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  shiftId: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  timeZone: z.string(),
  location: z.string(),
  callOffType: z.enum(['sick', 'other']),
  reason: z.string(),
  callReceivedAt: z.string(),
  receivedBy: z.string(),
  replacementNeeded: z.boolean(),
  operationalDetails: z.string().nullable(),
  reportedAt: z.string(),
})

const workspaceSchema = z.object({
  serverTimestamp: z.string(),
  canViewOperations: z.boolean(),
  canCreateManualEntry: z.boolean(),
  canEditManualEntry: z.boolean().optional().default(false),
  canReviewAdjustments: z.boolean(),
  canResolveExceptions: z.boolean(),
  canReportCallOff: z.boolean(),
  employees: z.array(employeeSchema),
  posts: z.array(postSchema).optional().default([]),
  shifts: z.array(shiftSchema),
  exceptions: z.array(operationalExceptionSchema),
  adjustmentRequests: z.array(adjustmentRequestSchema),
  alerts: z.array(alertSchema),
  manualEntries: z.array(manualEntrySchema).optional().default([]),
  adjustmentRequestActions: z.array(adjustmentActionSchema).optional().default([]),
  callOffReports: z.array(callOffReportSchema).optional().default([]),
})

const reportsSchema = z.object({
  generatedAt: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  timekeepingExceptions: z.array(z.record(z.string(), z.unknown())),
  automaticClockOuts: z.array(z.record(z.string(), z.unknown())),
  manualTimeEntryAudit: z.array(z.record(z.string(), z.unknown())),
  timeAdjustmentRequests: z.array(z.record(z.string(), z.unknown())),
  attendanceCallOffs: z.array(z.record(z.string(), z.unknown())),
  scheduledVsActual: z.array(z.record(z.string(), z.unknown())),
  coverageUnfilled: z.array(z.record(z.string(), z.unknown())),
  overtimePayrollRisk: z.array(z.record(z.string(), z.unknown())),
})

export const operationalReportKeySchema = z.enum([
  'timekeepingExceptions',
  'automaticClockOuts',
  'manualTimeEntryAudit',
  'timeAdjustmentRequests',
  'attendanceCallOffs',
  'scheduledVsActual',
  'coverageUnfilled',
  'overtimePayrollRisk',
])

const reportPageSchema = z.object({
  reportKey: operationalReportKeySchema,
  generatedAt: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  scope: z.enum(['active', 'archive', 'all']),
  page: z.number().int().positive(),
  pageSize: z.union([z.literal(10), z.literal(25), z.literal(50)]),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  archiveCount: z.number().int().nonnegative(),
  rows: z.array(z.record(z.string(), z.unknown())),
})

export type TimeOperationsWorkspace = z.infer<typeof workspaceSchema>
export type TimeAdjustmentRequest = z.infer<typeof adjustmentRequestSchema>
export type MissingTimeRequestWorkspace = z.infer<typeof missingTimeRequestWorkspaceSchema>
export type OperationalAlert = z.infer<typeof alertSchema>
export type OperationalException = z.infer<typeof operationalExceptionSchema>
export type ManualTimeEntry = z.infer<typeof manualEntrySchema>
export type EmployeeCallOffReport = z.infer<typeof callOffReportSchema>
export type TimeOperationsReports = z.infer<typeof reportsSchema>
export type OperationalReportKey = z.infer<typeof operationalReportKeySchema>
export type OperationalReportPage = z.infer<typeof reportPageSchema>

export function formatTimeOperationsPostLabel(
  post: TimeOperationsWorkspace['posts'][number],
): string {
  return [post.siteCode, post.siteName, post.postName]
    .filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index)
    .join(' · ')
}

async function rpc<T>(name: string, parameters: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await getSupabaseClient().rpc(name, parameters)
  if (error) throw new Error(error.message || 'The requested timekeeping action could not be completed.')
  return schema.parse(data)
}

export async function getTimekeepingOperationsWorkspace(fromDate: string, throughDate: string): Promise<TimeOperationsWorkspace> {
  return rpc('get_timekeeping_operations_workspace', { target_from_date: fromDate, target_through_date: throughDate }, workspaceSchema)
}

export async function getMissingTimeRequestWorkspace(fromDate: string, throughDate: string): Promise<MissingTimeRequestWorkspace> {
  return rpc('get_missing_time_request_workspace', {
    target_from_date: fromDate,
    target_through_date: throughDate,
  }, missingTimeRequestWorkspaceSchema)
}

export async function submitMissingTimeRequest(input: {
  workDate: string
  requestedClockInAt: string
  requestedClockOutAt: string
  postId: string
  unpaidBreakMinutes: number
  reason: string
}) {
  return rpc('submit_missing_time_request', {
    target_work_date: input.workDate,
    target_requested_clock_in_at: input.requestedClockInAt,
    target_requested_clock_out_at: input.requestedClockOutAt,
    target_post_id: input.postId,
    target_unpaid_break_minutes: input.unpaidBreakMinutes,
    target_reason: input.reason,
  }, z.object({ id: z.string().uuid(), status: z.string(), submittedAt: z.string() }))
}

export async function submitTimeAdjustmentRequest(input: {
  shiftId?: string | null
  workDate: string
  issueType: 'clock_in' | 'clock_out' | 'both_punches' | 'missing_shift' | 'other'
  requestedClockInAt?: string | null
  requestedClockOutAt?: string | null
  reason: string
  notes?: string | null
}) {
  return rpc('submit_time_adjustment_request', {
    target_shift_id: input.shiftId ?? null,
    target_work_date: input.workDate,
    target_issue_type: input.issueType,
    target_requested_clock_in_at: input.requestedClockInAt ?? null,
    target_requested_clock_out_at: input.requestedClockOutAt ?? null,
    target_reason: input.reason,
    target_notes: input.notes ?? null,
  }, z.object({ id: z.string().uuid(), status: z.string(), submittedAt: z.string() }))
}

export async function cancelTimeAdjustmentRequest(id: string) {
  return rpc('cancel_time_adjustment_request', { target_request_id: id, target_note: 'Canceled by employee.' }, z.null())
}

export async function createManualTimeEntry(input: {
  employeeId: string
  workDate: string
  clockInAt: string
  clockOutAt: string
  postId?: string | null
  shiftId?: string | null
  reason: string
  notes?: string | null
  exceptionId?: string | null
  confirmWarnings: boolean
}) {
  return rpc('create_manual_time_entry', {
    target_employee_id: input.employeeId,
    target_work_date: input.workDate,
    target_clock_in_at: input.clockInAt,
    target_clock_out_at: input.clockOutAt,
    target_post_id: input.postId ?? null,
    target_shift_id: input.shiftId ?? null,
    target_reason: input.reason,
    target_notes: input.notes ?? null,
    target_exception_id: input.exceptionId ?? null,
    target_confirm_warnings: input.confirmWarnings,
  }, z.object({ id: z.string().uuid(), clockInEventId: z.string().uuid(), clockOutEventId: z.string().uuid(), warningCodes: z.array(z.string()) }))
}

export async function editManualTimeEntry(input: {
  id: string
  clockInAt: string
  clockOutAt: string
  postId?: string | null
  shiftId?: string | null
  reason: string
  notes?: string | null
  confirmWarnings: boolean
}) {
  return rpc('edit_manual_time_entry', {
    target_manual_entry_id: input.id,
    target_clock_in_at: input.clockInAt,
    target_clock_out_at: input.clockOutAt,
    target_post_id: input.postId ?? null,
    target_shift_id: input.shiftId ?? null,
    target_reason: input.reason,
    target_notes: input.notes ?? null,
    target_confirm_warnings: input.confirmWarnings,
  }, z.object({ id: z.string().uuid(), warningCodes: z.array(z.string()), lastEditedAt: z.string() }))
}

export async function reviewTimeAdjustmentRequest(input: {
  id: string
  status: 'under_review' | 'approved' | 'partially_approved' | 'rejected'
  decisionNote: string
  confirmWarnings?: boolean
}) {
  return rpc('review_time_adjustment_request', {
    target_request_id: input.id,
    target_decision: input.status,
    target_decision_note: input.decisionNote,
    target_confirm_warnings: input.confirmWarnings ?? false,
  }, z.object({ id: z.string().uuid(), status: z.string(), manualEntry: z.unknown().nullable() }))
}

export async function reviewMissingTimeRequest(input: {
  id: string
  status: 'under_review' | 'approved' | 'rejected'
  decisionNote: string
  confirmWarnings?: boolean
}) {
  return rpc('review_missing_time_request', {
    target_request_id: input.id,
    target_decision: input.status,
    target_decision_note: input.decisionNote,
    target_confirm_warnings: input.confirmWarnings ?? false,
  }, z.object({
    id: z.string().uuid(),
    status: z.string(),
    timeEventIds: z.array(z.string().uuid()),
    warningCodes: z.array(z.string()),
  }))
}

export async function resolveOperationalException(input: { id: string; action: 'resolved' | 'dismissed'; method: string; note: string }) {
  return rpc('resolve_timekeeping_operational_exception', {
    target_exception_id: input.id,
    target_action: input.action === 'dismissed' ? 'dismissed' : input.method,
    target_reason: input.note,
  }, z.null())
}

export async function acknowledgeOperationalAlert(id: string) {
  return rpc('acknowledge_operational_alert', { target_alert_id: id }, z.null())
}

export async function reportEmployeeCallOff(input: {
  employeeId: string
  shiftId: string
  callOffType: 'sick' | 'other'
  reason: string
  callReceivedAt: string
  notes?: string | null
  replacementNeeded: boolean
  operationalDetails?: string | null
}) {
  return rpc('report_employee_call_off', {
    target_employee_id: input.employeeId,
    target_shift_id: input.shiftId,
    target_call_off_type: input.callOffType,
    target_reason: input.reason,
    target_call_received_at: input.callReceivedAt,
    target_notes: input.notes ?? null,
    target_replacement_needed: input.replacementNeeded,
    target_operational_details: input.operationalDetails ?? null,
  }, z.object({ id: z.string().uuid(), alertId: z.string().uuid(), status: z.string() }))
}

export async function updateEmployeeCallOff(input: { id: string; callOffType: 'sick' | 'other'; reason: string; notes?: string | null; operationalDetails?: string | null; replacementNeeded: boolean }) {
  return rpc('update_employee_call_off', {
    target_call_off_report_id: input.id,
    target_call_off_type: input.callOffType,
    target_reason: input.reason,
    target_notes: input.notes ?? null,
    target_operational_details: input.operationalDetails ?? null,
    target_replacement_needed: input.replacementNeeded,
  }, z.object({ id: z.string().uuid(), status: z.string() }))
}

export async function cancelEmployeeCallOff(id: string, reason: string) {
  return rpc('cancel_employee_call_off', { target_call_off_report_id: id, target_reason: reason }, z.null())
}

export async function getTimekeepingOperationsReports(fromDate: string, throughDate: string): Promise<TimeOperationsReports> {
  return rpc('get_timekeeping_operations_reports', { target_from_date: fromDate, target_through_date: throughDate }, reportsSchema)
}

export async function getTimekeepingOperationsReportPage(input: {
  reportKey: OperationalReportKey
  fromDate: string
  throughDate: string
  scope: 'active' | 'archive' | 'all'
  search?: string
  filterKey?: string
  filterValue?: string
  sort: 'priority' | 'newest' | 'oldest' | 'employee'
  page: number
  pageSize: 10 | 25 | 50
}): Promise<OperationalReportPage> {
  return rpc('get_timekeeping_operations_report_page', {
    target_report_key: input.reportKey,
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
    target_scope: input.scope,
    target_search: input.search?.trim() || null,
    target_filter_key: input.filterKey || null,
    target_filter_value: input.filterValue || null,
    target_sort: input.sort,
    target_page: input.page,
    target_page_size: input.pageSize,
  }, reportPageSchema)
}

export function zonedLocalDateTimeToUtc(value: string, timeZone = 'America/Denver'): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('Enter a complete date and time.')
  const [, year, month, day, hour, minute] = match.map(Number)
  const requestedUtc = Date.UTC(year, month - 1, day, hour, minute)
  let result = requestedUtc

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', timeZone, year: 'numeric',
    }).formatToParts(new Date(result))
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
    const representedUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute)
    const correction = requestedUtc - representedUtc
    if (correction === 0) return new Date(result).toISOString()
    result += correction
  }

  throw new Error('That local time does not exist in the selected time zone because of daylight-saving time. Choose another time.')
}

export function toZonedLocalDateTimeInput(value: Date | string, timeZone = 'America/Denver'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', timeZone, year: 'numeric',
  }).formatToParts(typeof value === 'string' ? new Date(value) : value)
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`
}

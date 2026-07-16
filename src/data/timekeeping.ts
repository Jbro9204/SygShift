import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const timeEventKindSchema = z.enum(['clock_in', 'break_start', 'break_end', 'clock_out'])
const timeEventSourceSchema = z.enum(['web', 'mobile_web', 'supervisor', 'import', 'system'])
const assignmentStatusSchema = z.enum(['assigned', 'confirmed', 'canceled', 'completed'])
const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary'])

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
])

const timekeepingReviewRowSchema = z.object({
  employeeId: z.string().uuid(),
  username: z.string(),
  employeeName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  shiftId: z.string().uuid().nullable(),
  operationalDate: z.string(),
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
  eventCount: z.number().int().nonnegative(),
  requiresArmed: z.boolean(),
  isOvertime: z.boolean(),
  payrollReady: z.boolean(),
  exceptionCodes: z.array(payrollExceptionSchema),
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

const employeeStatusSchema = z.enum(['active', 'leave', 'inactive', 'separated'])

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
  latestAction: z.enum(['manual_add', 'time_adjust', 'void']).nullable(),
  siteName: z.string().nullable(),
  siteCode: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  locationName: z.string(),
  timeZone: z.string(),
})

const timeMaintenanceSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  employees: z.array(timeMaintenanceEmployeeSchema),
  events: z.array(timeMaintenanceEventSchema),
})

const timekeepingReviewSchema = z.object({
  serverTimestamp: z.string(),
  fromDate: z.string(),
  throughDate: z.string(),
  operationalTimeZone: z.literal('America/Denver'),
  summary: z.object({
    rowCount: z.number().int().nonnegative(),
    readyCount: z.number().int().nonnegative(),
    exceptionCount: z.number().int().nonnegative(),
    pendingCorrectionCount: z.number().int().nonnegative(),
    grossMinutes: z.number().int().nonnegative(),
    paidMinutes: z.number().int().nonnegative(),
  }),
  rows: z.array(timekeepingReviewRowSchema),
  pendingCorrections: z.array(pendingCorrectionSchema),
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

export type TimeEventKind = z.infer<typeof timeEventKindSchema>
export type TimekeepingShift = z.infer<typeof timekeepingShiftSchema>
export type TimekeepingEvent = z.infer<typeof timekeepingEventSchema>
export type TimekeepingDashboard = z.infer<typeof timekeepingDashboardSchema>
export type TimekeepingState = 'off_clock' | 'working' | 'on_break'
export type PayrollException = z.infer<typeof payrollExceptionSchema>
export type TimekeepingReview = z.infer<typeof timekeepingReviewSchema>
export type TimekeepingReviewRow = z.infer<typeof timekeepingReviewRowSchema>
export type PendingCorrection = z.infer<typeof pendingCorrectionSchema>
export type PayrollExportBatch = z.infer<typeof payrollExportBatchSchema>
export type TimeMaintenance = z.infer<typeof timeMaintenanceSchema>
export type TimeMaintenanceEmployee = z.infer<typeof timeMaintenanceEmployeeSchema>
export type TimeMaintenanceEvent = z.infer<typeof timeMaintenanceEventSchema>

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

export function parsePayrollExportBatch(value: unknown): PayrollExportBatch {
  return payrollExportBatchSchema.parse(value)
}

export function parsePayrollExportHistory(value: unknown): PayrollExportBatch[] {
  return z.array(payrollExportBatchSchema).parse(value)
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

function requestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  const { data, error } = await getSupabaseClient().rpc('get_timekeeping_review', {
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error('Supervisor time review could not be loaded. MFA is required.')
  return parseTimekeepingReview(data)
}

export async function getTimeMaintenance(input: {
  fromDate: string
  throughDate: string
  employeeId?: string | null
}): Promise<TimeMaintenance> {
  const { data, error } = await getSupabaseClient().rpc('get_time_maintenance', {
    target_employee_id: input.employeeId ?? null,
    target_from_date: input.fromDate,
    target_through_date: input.throughDate,
  })
  if (error) throw new Error(error.message || 'Time maintenance could not be loaded. MFA is required.')
  return parseTimeMaintenance(data)
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
  voided?: boolean
  reason: string
}): Promise<z.infer<typeof correctionResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('supervisor_correct_time_event', {
    target_reason: input.reason,
    target_replacement_time: input.replacementTime ?? null,
    target_time_event_id: input.timeEventId,
    target_voided: input.voided ?? false,
  })
  if (error) throw new Error(error.message || 'The time event could not be corrected.')
  return correctionResultSchema.parse(data)
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

export function payrollHours(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

export function reviewRowsToPayrollCsv(rows: TimekeepingReviewRow[]): string {
  const headers = [
    'Employee',
    'Username',
    'Date',
    'Location',
    'Clock In',
    'Clock Out',
    'Gross Hours',
    'Break Minutes',
    'Paid Hours',
    'Overtime',
    'Payroll Ready',
    'Exceptions',
  ]
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const lines = rows.map((row) => [
    row.employeeName,
    row.username,
    row.operationalDate,
    row.locationName,
    row.firstClockIn ?? '',
    row.lastClockOut ?? '',
    payrollHours(row.grossMinutes),
    row.breakMinutes,
    payrollHours(row.paidMinutes),
    row.isOvertime ? 'yes' : 'no',
    row.payrollReady ? 'yes' : 'no',
    row.exceptionCodes.join('|'),
  ].map(escape).join(','))

  return [headers.map(escape).join(','), ...lines].join('\n')
}

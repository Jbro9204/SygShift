import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const timeEventKindSchema = z.enum(['clock_in', 'break_start', 'break_end', 'clock_out'])
const timeEventSourceSchema = z.enum(['web', 'mobile_web', 'supervisor', 'import', 'system'])
const assignmentStatusSchema = z.enum(['assigned', 'confirmed', 'canceled', 'completed'])
const appRoleSchema = z.enum(['guard', 'supervisor', 'admin'])
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

export type TimeEventKind = z.infer<typeof timeEventKindSchema>
export type TimekeepingShift = z.infer<typeof timekeepingShiftSchema>
export type TimekeepingEvent = z.infer<typeof timekeepingEventSchema>
export type TimekeepingDashboard = z.infer<typeof timekeepingDashboardSchema>
export type TimekeepingState = 'off_clock' | 'working' | 'on_break'

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

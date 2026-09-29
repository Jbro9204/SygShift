import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { supabaseWithIdentityVerification } from '../lib/identityVerificationCoordinator'

export const salariedShiftPresenceStatuses = ['worked', 'unconfirmed'] as const

const presenceStatusSchema = z.enum(salariedShiftPresenceStatuses)
const employeeSchema = z.object({
  id: z.string().uuid(),
  employeeNumber: z.string().nullable(),
  displayName: z.string().min(1),
  timeZone: z.string().min(1),
})
const actorSchema = z.object({ id: z.string().uuid(), displayName: z.string().min(1) })
const assignmentSchema = z.object({
  assignmentId: z.string().uuid(),
  shiftId: z.string().uuid(),
  employee: employeeSchema,
  startsAt: z.string(),
  endsAt: z.string(),
  shiftTimeZone: z.string().min(1),
  employeeTimeZone: z.string().min(1),
  workday: z.string(),
  scheduleStatus: z.literal('published'),
  assignmentStatus: z.enum(['assigned', 'confirmed', 'completed']),
  assignmentType: z.enum(['standard', 'dispatch_primary']),
  siteCode: z.string().nullable(),
  siteName: z.string().nullable(),
  postName: z.string().nullable(),
  eventName: z.string().nullable(),
  location: z.string().min(1),
  presenceStatus: presenceStatusSchema,
  workedAt: z.string().nullable(),
  recordedNote: z.string().nullable(),
  recordedBy: actorSchema.nullable(),
  updatedAt: z.string().nullable(),
  canMarkWorked: z.boolean(),
  canVoid: z.boolean(),
  blockingReason: z.enum(['shift_not_ended', 'already_worked']).nullable(),
  history: z.array(z.object({
    id: z.string().uuid(),
    action: z.enum(['worked', 'voided']),
    note: z.string().nullable(),
    actor: actorSchema,
    recordedAt: z.string(),
  })),
})
const workspaceSchema = z.object({
  generatedAt: z.string(),
  range: z.object({ startsOn: z.string(), endsOn: z.string() }),
  viewer: z.object({
    employeeId: z.string().uuid(),
    timeZone: z.string().min(1),
    employmentType: z.enum(['hourly', 'salary', 'flex']),
    canManage: z.boolean(),
  }),
  filters: z.object({ employeeId: z.string().uuid().nullable() }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    worked: z.number().int().nonnegative(),
    unconfirmed: z.number().int().nonnegative(),
  }),
  employees: z.array(employeeSchema),
  assignments: z.array(assignmentSchema),
})
const mutationResultSchema = z.object({
  assignmentId: z.string().uuid(),
  presenceStatus: presenceStatusSchema,
  workedAt: z.string().nullable(),
  updatedAt: z.string(),
  action: z.enum(['recorded', 'corrected', 'voided', 'unchanged']),
})

export type SalariedShiftPresenceStatus = z.infer<typeof presenceStatusSchema>
export type SalariedShiftAssignment = z.infer<typeof assignmentSchema>
export type SalariedShiftWorkspace = z.infer<typeof workspaceSchema>
export type SalariedShiftMutationResult = z.infer<typeof mutationResultSchema>

export interface SalariedShiftWorkspaceInput {
  startsOn?: string | null
  endsOn?: string | null
  employeeId?: string | null
}

export interface RecordSalariedShiftOutcomeInput {
  assignmentId: string
  presenceStatus: SalariedShiftPresenceStatus
  requestId: string
  note?: string | null
}

export function parseSalariedShiftWorkspace(value: unknown): SalariedShiftWorkspace {
  const parsed = workspaceSchema.safeParse(value)
  if (!parsed.success) throw new Error('The shift confirmation details could not be verified. Refresh and try again.')
  return parsed.data
}

export function parseSalariedShiftMutationResult(value: unknown): SalariedShiftMutationResult {
  const parsed = mutationResultSchema.safeParse(value)
  if (!parsed.success) throw new Error('The saved shift confirmation could not be verified. Refresh and check the shift before trying again.')
  return parsed.data
}

export function salariedShiftWorkspaceQueryKey(input: SalariedShiftWorkspaceInput = {}) {
  return ['salaried-shift-workspace', input.startsOn ?? null, input.endsOn ?? null, input.employeeId ?? null] as const
}

export async function getSalariedShiftWorkspace(input: SalariedShiftWorkspaceInput = {}): Promise<SalariedShiftWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_salaried_shift_workspace', {
    range_starts_on: input.startsOn ?? null,
    range_ends_on: input.endsOn ?? null,
    requested_employee_id: input.employeeId ?? null,
  })
  if (error) throw new Error('Shift confirmations could not be loaded. Refresh the page and try again.')
  return parseSalariedShiftWorkspace(data)
}

export async function recordSalariedShiftOutcome(input: RecordSalariedShiftOutcomeInput): Promise<SalariedShiftMutationResult> {
  const note = input.note?.trim() || null
  if (!z.string().uuid().safeParse(input.requestId).success) throw new Error('The shift confirmation request could not be verified. Close it and try again.')
  if (note && note.length > 2000) throw new Error('Keep the shift confirmation note to 2,000 characters or fewer.')
  if (input.presenceStatus === 'unconfirmed' && (!note || note.length < 8)) {
    throw new Error('Enter at least 8 characters explaining why the Worked marker is being removed.')
  }
  const { data, error } = await supabaseWithIdentityVerification(() => getSupabaseClient().rpc('record_salaried_shift_outcome', {
    target_assignment_id: input.assignmentId,
    requested_outcome: input.presenceStatus,
    outcome_note: note,
    request_id: input.requestId,
  }))
  if (error) throw new Error('The shift confirmation could not be saved. Refresh the record and try again.')
  return parseSalariedShiftMutationResult(data)
}

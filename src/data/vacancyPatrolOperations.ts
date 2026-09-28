import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const uuidSchema = z.string().uuid()
const instantSchema = z.string().min(1)

export const vacancyPatrolRecoveryStatusSchema = z.enum([
  'requested',
  'patrol_planned',
  'in_progress',
  'completed',
  'declined',
  'canceled',
])

export const vacancyPatrolRecoveryStageSchema = z.enum([
  'requested',
  'patrol_planned',
  'partial',
  'completed',
  'finance_reviewed',
  'declined',
  'canceled',
])

const billingDispositionSchema = z.enum([
  'pending_review',
  'bill_separately',
  'included_in_contract',
  'non_billable',
  'duplicate_suppressed',
])

const recoveryRouteSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  requiresArmed: z.boolean(),
  routeId: uuidSchema,
  routeVersionId: uuidSchema,
  timeZone: z.string().min(1),
})

const recoveryRouteChoiceSchema = recoveryRouteSchema.extend({
  isRequestedRoute: z.boolean(),
})

const recoveryEmployeeSchema = z.object({
  employeeId: uuidSchema,
  employeeNumber: z.string().nullable(),
  name: z.string().min(1),
})

const recoveryEmployeeChoiceSchema = recoveryEmployeeSchema.extend({
  armedQualified: z.boolean(),
})

const recoveryShiftSchema = z.object({
  clientId: uuidSchema.nullable(),
  clientName: z.string().nullable(),
  endsAt: instantSchema,
  isPublished: z.boolean(),
  isUnassigned: z.boolean(),
  postId: uuidSchema.nullable(),
  postName: z.string().nullable(),
  requiresArmed: z.boolean(),
  scheduleId: uuidSchema,
  scheduleName: z.string().nullable(),
  shiftId: uuidSchema,
  siteId: uuidSchema.nullable(),
  siteName: z.string().nullable(),
  startsAt: instantSchema,
  timeZone: z.string().min(1),
  weekStartsOn: z.string().min(1),
})

const recoveryHitWindowSchema = z.object({
  completedHits: z.number().int().nonnegative(),
  hitWindowId: uuidSchema,
  missedHits: z.number().int().nonnegative(),
  plannedHits: z.number().int().positive(),
  remainingHits: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  status: z.enum(['planned', 'partial', 'completed', 'missed']),
  windowEndAt: instantSchema,
  windowStartAt: instantSchema,
})

const recoveryStatusHistorySchema = z.object({
  action: z.string().min(1),
  actorEmployeeId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  createdAt: instantSchema,
  fromStatus: vacancyPatrolRecoveryStatusSchema.nullable(),
  historyId: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()),
  note: z.string().nullable(),
  toStatus: vacancyPatrolRecoveryStatusSchema,
})

const recoveryPermissionsSchema = z.object({
  canAccept: z.boolean(),
  canReviewBilling: z.boolean(),
  canUpdate: z.boolean(),
})

export const vacancyPatrolRecoveryDetailSchema = z.object({
  acceptedRoute: recoveryRouteSchema.nullable(),
  assignedEmployee: recoveryEmployeeSchema.nullable(),
  billingDisposition: billingDispositionSchema.nullable(),
  completedHits: z.number().int().nonnegative(),
  createdAt: instantSchema,
  displayStage: vacancyPatrolRecoveryStageSchema,
  employeeChoices: z.array(recoveryEmployeeChoiceSchema),
  hitWindows: z.array(recoveryHitWindowSchema).min(1),
  patrolAssignmentId: uuidSchema.nullable(),
  permissions: recoveryPermissionsSchema,
  plannedHits: z.number().int().nonnegative(),
  reason: z.string().min(1),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  requestedRoute: recoveryRouteSchema,
  routeChoices: z.array(recoveryRouteChoiceSchema),
  shift: recoveryShiftSchema,
  status: vacancyPatrolRecoveryStatusSchema,
  statusHistory: z.array(recoveryStatusHistorySchema),
  updatedAt: instantSchema,
})

const vacancyPatrolRecoveryWorklistSchema = z.object({
  counts: z.object({
    canceled: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    declined: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    patrolPlanned: z.number().int().nonnegative(),
    requested: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  generatedAt: instantSchema,
  permissions: z.object({ canAccept: z.boolean(), canUpdate: z.boolean() }),
  requests: z.array(vacancyPatrolRecoveryDetailSchema),
})

const acceptReceiptSchema = z.object({
  acceptedAt: instantSchema,
  acceptedRouteId: uuidSchema,
  assignedEmployeeId: uuidSchema,
  completedHits: z.number().int().nonnegative(),
  idempotentReplay: z.boolean(),
  patrolAssignmentId: uuidSchema,
  plannedHits: z.number().int().nonnegative(),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  status: z.literal('patrol_planned'),
})

const updateReceiptSchema = z.object({
  completedHits: z.number().int().nonnegative(),
  displayStage: vacancyPatrolRecoveryStageSchema,
  idempotentReplay: z.boolean(),
  missedHits: z.number().int().nonnegative(),
  plannedHits: z.number().int().nonnegative(),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  status: vacancyPatrolRecoveryStatusSchema,
  updatedAt: instantSchema,
})

const planWindowInputSchema = z.object({
  plannedHits: z.number().int().positive(),
  windowEndAt: instantSchema,
  windowStartAt: instantSchema,
})

export type VacancyPatrolRecoveryStatus = z.infer<typeof vacancyPatrolRecoveryStatusSchema>
export type VacancyPatrolRecoveryStage = z.infer<typeof vacancyPatrolRecoveryStageSchema>
export type VacancyPatrolRecoveryDetail = z.infer<typeof vacancyPatrolRecoveryDetailSchema>
export type VacancyPatrolRecoveryWorklist = z.infer<typeof vacancyPatrolRecoveryWorklistSchema>
export type VacancyPatrolRecoveryHitWindow = z.infer<typeof recoveryHitWindowSchema>
export type VacancyPatrolRecoveryPlanWindow = z.infer<typeof planWindowInputSchema>
export type VacancyPatrolRecoveryAcceptReceipt = z.infer<typeof acceptReceiptSchema>
export type VacancyPatrolRecoveryUpdateReceipt = z.infer<typeof updateReceiptSchema>
export type VacancyPatrolRecoveryWorklistStatus = 'all' | VacancyPatrolRecoveryStatus
export type VacancyPatrolRecoveryUpdateAction = 'update_plan' | 'decline' | 'cancel' | 'reconcile'

export interface VacancyPatrolRecoveryWorklistInput {
  from: string
  status: VacancyPatrolRecoveryWorklistStatus
  through: string
}

export interface AcceptVacancyPatrolRecoveryInput {
  employeeId: string
  idempotencyKey: string
  note: string
  requestId: string
  routeId: string
}

export interface UpdateVacancyPatrolRecoveryInput {
  action: VacancyPatrolRecoveryUpdateAction
  hitWindows?: VacancyPatrolRecoveryPlanWindow[] | null
  idempotencyKey: string
  note: string
  requestId: string
}

function messageFromError(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message || fallback)
}

export async function getVacancyPatrolRecoveryWorklist(input: VacancyPatrolRecoveryWorklistInput): Promise<VacancyPatrolRecoveryWorklist> {
  const { data, error } = await getSupabaseClient().rpc('get_vacancy_patrol_recovery_worklist', {
    target_from: input.from,
    target_status: input.status === 'all' ? null : input.status,
    target_through: input.through,
  })
  if (error) throw messageFromError(error, 'Vacancy recovery requests could not be loaded.')
  return vacancyPatrolRecoveryWorklistSchema.parse(data)
}

export async function getVacancyPatrolRecovery(requestId: string): Promise<VacancyPatrolRecoveryDetail> {
  const { data, error } = await getSupabaseClient().rpc('get_vacancy_patrol_recovery', {
    target_request_id: uuidSchema.parse(requestId),
  })
  if (error) throw messageFromError(error, 'The vacancy recovery request could not be loaded.')
  return vacancyPatrolRecoveryDetailSchema.parse(data)
}

export async function acceptVacancyPatrolRecovery(input: AcceptVacancyPatrolRecoveryInput): Promise<VacancyPatrolRecoveryAcceptReceipt> {
  const { data, error } = await getSupabaseClient().rpc('accept_vacancy_patrol_recovery', {
    target_employee_id: uuidSchema.parse(input.employeeId),
    target_idempotency_key: uuidSchema.parse(input.idempotencyKey),
    target_note: input.note.trim(),
    target_request_id: uuidSchema.parse(input.requestId),
    target_route_id: uuidSchema.parse(input.routeId),
  })
  if (error) throw messageFromError(error, 'The vacancy recovery request could not be accepted.')
  return acceptReceiptSchema.parse(data)
}

export async function updateVacancyPatrolRecovery(input: UpdateVacancyPatrolRecoveryInput): Promise<VacancyPatrolRecoveryUpdateReceipt> {
  const hitWindows = input.hitWindows == null ? null : z.array(planWindowInputSchema).min(1).parse(input.hitWindows)
  const { data, error } = await getSupabaseClient().rpc('update_vacancy_patrol_recovery', {
    target_action: input.action,
    target_hit_windows: hitWindows,
    target_idempotency_key: uuidSchema.parse(input.idempotencyKey),
    target_note: input.note.trim(),
    target_request_id: uuidSchema.parse(input.requestId),
  })
  if (error) throw messageFromError(error, 'The vacancy recovery request could not be updated.')
  return updateReceiptSchema.parse(data)
}

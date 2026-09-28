import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const uuidSchema = z.string().uuid()
const instantSchema = z.string().min(1)

const vacancyPatrolHitWindowSchema = z.object({
  plannedHits: z.number().int().positive(),
  windowEndAt: instantSchema,
  windowStartAt: instantSchema,
})

const vacancyPatrolShiftSchema = z.object({
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
})

const vacancyPatrolRouteChoiceSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  requiresArmed: z.boolean(),
  routeId: uuidSchema,
  routeVersionId: uuidSchema,
  timeZone: z.string().min(1),
})

const vacancyPatrolExistingRequestSchema = z.object({
  createdAt: instantSchema,
  hitWindows: z.array(vacancyPatrolHitWindowSchema).min(1),
  reason: z.string().min(1),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  requestedRouteId: uuidSchema,
  status: z.enum(['requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled']),
})

const vacancyPatrolRecoveryBootstrapSchema = z.object({
  defaults: z.object({
    hitWindows: z.array(vacancyPatrolHitWindowSchema).min(1),
    maxHitWindows: z.number().int().positive(),
    reasonMinLength: z.number().int().positive(),
  }),
  existingRequest: vacancyPatrolExistingRequestSchema.nullable(),
  permissions: z.object({ canInitiate: z.boolean() }),
  routeChoices: z.array(vacancyPatrolRouteChoiceSchema),
  shift: vacancyPatrolShiftSchema,
})

const vacancyPatrolRecoveryReceiptSchema = z.object({
  createdAt: instantSchema,
  idempotentReplay: z.boolean(),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  status: z.literal('requested'),
})

const vacancyPatrolRecoveryMapSchema = z.object({
  permissions: z.object({ canInitiate: z.boolean() }),
  recoveries: z.array(z.object({
    acceptedRouteId: uuidSchema.nullable(),
    billingDisposition: z.string().nullable(),
    completedHits: z.number().int().nonnegative(),
    displayStage: z.enum(['requested', 'patrol_planned', 'partial', 'completed', 'finance_reviewed', 'declined', 'canceled']),
    patrolAssignmentId: uuidSchema.nullable(),
    plannedHits: z.number().int().nonnegative(),
    requestId: uuidSchema,
    requestNumber: z.string().min(1),
    requestedRouteId: uuidSchema,
    shiftId: uuidSchema,
    status: z.enum(['requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled']),
    updatedAt: instantSchema,
  })),
  weekEndsOn: z.string().min(1),
  weekStartsOn: z.string().min(1),
})

export type VacancyPatrolHitWindow = z.infer<typeof vacancyPatrolHitWindowSchema>
export type VacancyPatrolRecoveryBootstrap = z.infer<typeof vacancyPatrolRecoveryBootstrapSchema>
export type VacancyPatrolRecoveryReceipt = z.infer<typeof vacancyPatrolRecoveryReceiptSchema>
export type VacancyPatrolRecoveryMap = z.infer<typeof vacancyPatrolRecoveryMapSchema>
export type VacancyPatrolRecoveryMapItem = VacancyPatrolRecoveryMap['recoveries'][number]

export interface CreateVacancyPatrolRecoveryInput {
  hitWindows: VacancyPatrolHitWindow[]
  idempotencyKey: string
  reason: string
  requestedRouteId: string
  shiftId: string
}

function messageFromError(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message || fallback)
}

export async function getVacancyPatrolRecoveryBootstrap(shiftId: string): Promise<VacancyPatrolRecoveryBootstrap> {
  const { data, error } = await getSupabaseClient().rpc('get_vacancy_patrol_recovery_bootstrap', {
    target_shift_id: uuidSchema.parse(shiftId),
  })
  if (error) throw messageFromError(error, 'Vacancy recovery details could not be loaded.')
  return vacancyPatrolRecoveryBootstrapSchema.parse(data)
}

export async function createVacancyPatrolRecovery(input: CreateVacancyPatrolRecoveryInput): Promise<VacancyPatrolRecoveryReceipt> {
  const { data, error } = await getSupabaseClient().rpc('create_vacancy_patrol_recovery', {
    target_hit_windows: z.array(vacancyPatrolHitWindowSchema).min(1).parse(input.hitWindows),
    target_idempotency_key: uuidSchema.parse(input.idempotencyKey),
    target_reason: input.reason.trim(),
    target_requested_route_id: uuidSchema.parse(input.requestedRouteId),
    target_shift_id: uuidSchema.parse(input.shiftId),
  })
  if (error) throw messageFromError(error, 'The vacancy recovery request could not be submitted.')
  return vacancyPatrolRecoveryReceiptSchema.parse(data)
}

export async function getVacancyPatrolRecoveryMap(weekStartsOn: string): Promise<VacancyPatrolRecoveryMap> {
  const { data, error } = await getSupabaseClient().rpc('get_vacancy_patrol_recovery_map', {
    target_week_starts_on: weekStartsOn,
  })
  if (error) throw messageFromError(error, 'Vacancy recovery status could not be loaded.')
  return vacancyPatrolRecoveryMapSchema.parse(data)
}

import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const uuidSchema = z.string().uuid()
const instantSchema = z.string().min(1)

export const vacancyPatrolBillingDispositionSchema = z.enum([
  'pending_review',
  'bill_separately',
  'included_in_contract',
  'non_billable',
  'duplicate_suppressed',
])

const vacancyPatrolFinanceRowSchema = z.object({
  acceptedAt: instantSchema.nullable(),
  acceptedById: uuidSchema.nullable(),
  acceptedByName: z.string().nullable(),
  acceptedRouteId: uuidSchema.nullable(),
  acceptedRouteName: z.string().nullable(),
  assignedEmployeeId: uuidSchema.nullable(),
  assignedEmployeeName: z.string().nullable(),
  assignedEmployeeNumber: z.string().nullable(),
  billingDisposition: vacancyPatrolBillingDispositionSchema,
  billingReason: z.string().nullable(),
  billingReference: z.string().nullable(),
  canReview: z.boolean(),
  clientId: uuidSchema.nullable(),
  clientName: z.string().nullable(),
  completedAt: instantSchema.nullable(),
  completedHits: z.number().int().nonnegative(),
  endsAt: instantSchema,
  missedHits: z.number().int().nonnegative(),
  originalShiftHours: z.number().nonnegative(),
  patrolAssignmentId: uuidSchema.nullable(),
  plannedHits: z.number().int().nonnegative(),
  postId: uuidSchema.nullable(),
  postName: z.string().nullable(),
  remainingHits: z.number().int().nonnegative(),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  requestedAt: instantSchema,
  requestedById: uuidSchema,
  requestedByName: z.string().min(1),
  requestedRouteId: uuidSchema,
  requestedRouteName: z.string().nullable(),
  reviewedAt: instantSchema.nullable(),
  reviewedById: uuidSchema.nullable(),
  reviewedByName: z.string().nullable(),
  serviceDate: z.string().min(1),
  shiftId: uuidSchema,
  siteId: uuidSchema.nullable(),
  siteName: z.string().nullable(),
  startsAt: instantSchema,
  status: z.enum(['requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled']),
  timeZone: z.string().min(1),
})

const vacancyPatrolFinanceReportSchema = z.object({
  from: z.string().min(1),
  generatedAt: instantSchema,
  permissions: z.object({
    canExport: z.boolean(),
    canReview: z.boolean(),
    canView: z.boolean(),
  }),
  rows: z.array(vacancyPatrolFinanceRowSchema),
  summary: z.object({
    awaitingCompletion: z.number().int().nonnegative(),
    billSeparately: z.number().int().nonnegative(),
    duplicateSuppressed: z.number().int().nonnegative(),
    includedInContract: z.number().int().nonnegative(),
    nonBillable: z.number().int().nonnegative(),
    pendingReview: z.number().int().nonnegative(),
    reviewed: z.number().int().nonnegative(),
    totalRequests: z.number().int().nonnegative(),
  }),
  through: z.string().min(1),
})

const vacancyPatrolBillingReceiptSchema = z.object({
  auditId: z.number().int().positive(),
  billingDisposition: vacancyPatrolBillingDispositionSchema.exclude(['pending_review']),
  billingReason: z.string().min(1),
  billingReference: z.string().nullable(),
  idempotentReplay: z.boolean(),
  requestId: uuidSchema,
  requestNumber: z.string().min(1),
  reviewedAt: instantSchema,
  reviewedBy: z.object({ employeeId: uuidSchema, name: z.string().min(1) }),
})

const vacancyPatrolFinanceExportReceiptSchema = z.object({
  auditId: z.number().int().positive(),
  authorizedAt: instantSchema,
  format: z.enum(['csv', 'xlsx', 'pdf']),
  from: z.string().min(1),
  through: z.string().min(1),
})

export type VacancyPatrolBillingDisposition = z.infer<typeof vacancyPatrolBillingDispositionSchema>
export type VacancyPatrolFinanceReport = z.infer<typeof vacancyPatrolFinanceReportSchema>
export type VacancyPatrolFinanceRow = z.infer<typeof vacancyPatrolFinanceRowSchema>
export type VacancyPatrolBillingReceipt = z.infer<typeof vacancyPatrolBillingReceiptSchema>

function messageFromError(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message || fallback)
}

export async function getVacancyPatrolFinanceReport(input: {
  billingDisposition?: VacancyPatrolBillingDisposition | 'all'
  from: string
  through: string
}): Promise<VacancyPatrolFinanceReport> {
  const { data, error } = await getSupabaseClient().rpc('get_vacancy_patrol_finance_report', {
    target_billing_disposition: input.billingDisposition === 'all' ? null : input.billingDisposition ?? null,
    target_from: input.from,
    target_through: input.through,
  })
  if (error) throw messageFromError(error, 'The vacancy Patrol billing report could not be loaded.')
  return vacancyPatrolFinanceReportSchema.parse(data)
}

export async function reviewVacancyPatrolBilling(input: {
  billingReference: string | null
  disposition: Exclude<VacancyPatrolBillingDisposition, 'pending_review'>
  idempotencyKey: string
  reason: string
  requestId: string
}): Promise<VacancyPatrolBillingReceipt> {
  const { data, error } = await getSupabaseClient().rpc('review_vacancy_patrol_billing', {
    target_disposition: input.disposition,
    target_idempotency_key: uuidSchema.parse(input.idempotencyKey),
    target_reason: input.reason.trim(),
    target_reference: input.billingReference?.trim() || null,
    target_request_id: uuidSchema.parse(input.requestId),
  })
  if (error) throw messageFromError(error, 'The billing decision could not be recorded.')
  return vacancyPatrolBillingReceiptSchema.parse(data)
}

export async function authorizeVacancyPatrolFinanceExport(input: {
  format: 'csv' | 'xlsx' | 'pdf'
  from: string
  through: string
}): Promise<void> {
  const { data, error } = await getSupabaseClient().rpc('authorize_vacancy_patrol_finance_export', {
    target_format: input.format,
    target_from: input.from,
    target_through: input.through,
  })
  if (error) throw messageFromError(error, 'The protected Finance export could not be authorized.')
  vacancyPatrolFinanceExportReceiptSchema.parse(data)
}

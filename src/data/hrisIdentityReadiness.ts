import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const hrisDateSourceTypeSchema = z.enum([
  'hr_export',
  'employee_file',
  'verified_hr_record',
  'verified_manual',
])

const readinessItemSchema = z.object({
  employeeId: z.string().uuid(),
  legalName: z.string(),
  employeeNumber: z.string().nullable(),
  status: z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated']),
  employmentType: z.string(),
  primaryRole: z.string(),
  effectiveHiredOn: z.string().nullable(),
  effectiveSeparatedOn: z.string().nullable(),
  permanentHiredOn: z.string().nullable(),
  permanentSeparatedOn: z.string().nullable(),
  hireDateLocked: z.boolean(),
  separationDateLocked: z.boolean(),
  dateSourceType: z.string(),
  authorizationRecordedAt: z.string().nullable(),
  mappingState: z.enum(['blocked', 'already_mapped', 'worker_ready', 'identity_ready']),
  blockerCodes: z.array(z.string()),
  warningCodes: z.array(z.string()),
  canaryEligible: z.boolean(),
})

const summarySchema = z.object({
  employeeCount: z.number(),
  currentEmployeeCount: z.number(),
  historicalEmployeeCount: z.number(),
  readyCount: z.number(),
  alreadyMappedCount: z.number(),
  blockedCount: z.number(),
  warningCount: z.number(),
  missingEmployeeNumberWarningCount: z.number(),
  missingHireDateWarningCount: z.number(),
  missingSeparationDateWarningCount: z.number(),
  protectedBackfillAllowed: z.boolean(),
  generatedAt: z.string(),
})

const controlSchema = z.object({
  gateEnabled: z.boolean(),
  employeeCount: z.number(),
  missingHireDateCount: z.number(),
  missingSeparationDateCount: z.number(),
  currentRecoveryEvidence: z.boolean(),
  currentRecoveryEvidenceExpiresAt: z.string().nullable(),
  executionCount: z.number(),
  generatedAt: z.string(),
})

const preservationSchema = z.object({
  employees: z.number(),
  employeeRoleMemberships: z.number(),
  rolePermissions: z.number(),
  employeePermissionOverrides: z.number(),
  employeeAccounts: z.number(),
  employeeCredentials: z.number(),
  schedules: z.number(),
  shifts: z.number(),
  shiftAssignments: z.number(),
  timeEvents: z.number(),
  timeOffRequests: z.number(),
  payrollExportBatches: z.number(),
  payrollExportRows: z.number(),
})

const readinessWorkspaceSchema = z.object({
  generatedAt: z.string(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
  items: z.array(readinessItemSchema),
  summary: summarySchema,
  control: controlSchema,
  preservation: preservationSchema,
  canaryReadiness: z.object({
    eligibleEmployeeCount: z.number(),
    prerequisitesSatisfied: z.boolean(),
    recoveryEvidenceCurrent: z.boolean(),
    backfillGateEnabled: z.boolean(),
    browserExecutionAvailable: z.literal(false),
  }),
})

export type HrisDateSourceType = z.infer<typeof hrisDateSourceTypeSchema>
export type HrisIdentityReadinessItem = z.infer<typeof readinessItemSchema>
export type HrisIdentityReadinessWorkspace = z.infer<typeof readinessWorkspaceSchema>

export type HrisIdentityReadinessQuery = {
  search?: string
  status?: string
  page?: number
  pageSize?: number
}

export type HrisEffectiveDateAuthorizationInput = {
  employeeId: string
  hiredOn: string
  separatedOn: string | null
  sourceType: HrisDateSourceType
  sourceReference: string
  reason: string
}

export async function getHrisIdentityReadiness(
  query: HrisIdentityReadinessQuery = {},
): Promise<HrisIdentityReadinessWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_hris_stage2_identity_readiness', {
    target_page: query.page ?? 1,
    target_page_size: query.pageSize ?? 10,
    target_search: query.search?.trim() || null,
    target_status: query.status ?? 'all',
  })
  if (error) throw new Error(error.message || 'Employment data readiness could not be loaded.')
  return readinessWorkspaceSchema.parse(data)
}

export async function authorizeHrisEffectiveDates(
  input: HrisEffectiveDateAuthorizationInput,
): Promise<string> {
  const parsedSourceType = hrisDateSourceTypeSchema.parse(input.sourceType)
  const { data, error } = await getSupabaseClient().rpc('authorize_hris_stage2_effective_dates', {
    target_employee_id: input.employeeId,
    target_hired_on: input.hiredOn,
    target_reason: input.reason.trim(),
    target_separated_on: input.separatedOn || null,
    target_source_reference: input.sourceReference.trim(),
    target_source_type: parsedSourceType,
  })
  if (error) throw new Error(error.message || 'The verified employment dates could not be recorded.')
  return z.string().uuid().parse(data)
}

import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary', 'flex'])
const employeeStatusSchema = z.enum(['active', 'leave', 'inactive', 'separated'])
const sourcePayloadSchema = z.record(z.string(), z.unknown())
const mappingDecisionSchema = z.record(z.string(), z.unknown()).nullable()

const importReadinessSchema = z.object({
  importRunId: z.string().uuid(),
  fromDate: z.string(),
  throughDate: z.string(),
  employeeCandidateCount: z.number().int().nonnegative(),
  directoryEmployeeMappingCount: z.number().int().nonnegative(),
  scheduleCandidateCount: z.number().int().nonnegative(),
  acceptedScheduleCount: z.number().int().nonnegative(),
  shiftCandidateCount: z.number().int().nonnegative(),
  sourceOpenShiftCount: z.number().int().nonnegative(),
  missingContextShiftCount: z.number().int().nonnegative(),
  siteKeyCount: z.number().int().nonnegative(),
  siteMappingCount: z.number().int().nonnegative(),
  assigneeLabelCount: z.number().int().nonnegative(),
  aliasMappingCount: z.number().int().nonnegative(),
  conservativeAliasSuggestionCount: z.number().int().nonnegative(),
  qualificationConflictCount: z.number().int().nonnegative(),
  assignmentOverlapConflictCount: z.number().int().nonnegative(),
  directoryReady: z.boolean(),
  scheduleReady: z.boolean(),
})

const employeeMappingQueueItemSchema = z.object({
  candidate_id: z.string().uuid(),
  candidate_key: z.string(),
  source_payload: sourcePayloadSchema,
  current_mapping: mappingDecisionSchema,
  mapping_decided_at: z.string().nullable(),
  total_count: z.number().int().nonnegative(),
})

const siteMappingQueueItemSchema = z.object({
  candidate_id: z.string().uuid(),
  candidate_key: z.string(),
  source_payload: sourcePayloadSchema,
  scope_shift_count: z.number().int().nonnegative(),
  current_mapping: mappingDecisionSchema,
  mapping_decided_at: z.string().nullable(),
  total_count: z.number().int().nonnegative(),
})

const assigneeAliasQueueItemSchema = z.object({
  normalized_label: z.string(),
  label_variants: z.array(z.string()),
  scope_shift_count: z.number().int().nonnegative(),
  first_shift_on: z.string(),
  last_shift_on: z.string(),
  suggested_employee_mapping_key: z.string().nullable(),
  suggested_employee_name: z.string().nullable(),
  suggestion_method: z.string().nullable(),
  suggestion_ready: z.boolean(),
  current_mapping: mappingDecisionSchema,
  mapping_decided_at: z.string().nullable(),
  total_count: z.number().int().nonnegative(),
})

const shiftExceptionSchema = z.object({
  candidate_id: z.string().uuid(),
  source_payload: sourcePayloadSchema,
  effective_mapping: mappingDecisionSchema,
  current_override: mappingDecisionSchema,
  overlap_conflict: z.boolean(),
  qualification_conflict: z.boolean(),
  total_count: z.number().int().nonnegative(),
})

const employeeMappingOptionSchema = z.object({
  mapping_key: z.string(),
  display_name: z.string(),
  source_type: z.string(),
  employee_status: employeeStatusSchema,
})

const promotionResultSchema = z.object({
  promotionBatchId: z.string().uuid(),
  employeesCreated: z.number().int().nonnegative(),
  sitesCreated: z.number().int().nonnegative(),
  postsCreated: z.number().int().nonnegative(),
  schedulesCreated: z.number().int().nonnegative(),
  shiftsCreated: z.number().int().nonnegative(),
  assignmentsCreated: z.number().int().nonnegative(),
  shiftsExcluded: z.number().int().nonnegative(),
  published: z.boolean(),
})

export type ImportReadiness = z.infer<typeof importReadinessSchema>
export type EmployeeMappingQueueItem = z.infer<typeof employeeMappingQueueItemSchema>
export type SiteMappingQueueItem = z.infer<typeof siteMappingQueueItemSchema>
export type AssigneeAliasQueueItem = z.infer<typeof assigneeAliasQueueItemSchema>
export type ShiftException = z.infer<typeof shiftExceptionSchema>
export type EmployeeMappingOption = z.infer<typeof employeeMappingOptionSchema>
export type AppRole = z.infer<typeof appRoleSchema>
export type EmploymentType = z.infer<typeof employmentTypeSchema>
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>

export interface ImportScope {
  fromDate: string
  throughDate: string
}

export interface EmployeeMappingInput {
  candidateId: string
  firstName: string
  middleName: string | null
  lastName: string
  preferredName: string | null
  role: AppRole
  employmentType: EmploymentType
  status: EmployeeStatus
  personalEmail: string | null
  companyEmail: string | null
  mobilePhone: string | null
  guardLicenseNumber: string | null
  guardLicenseExpiresOn: string | null
  armedStatus: 'not_armed' | 'pending_verification' | 'active'
  armedCredentialNumber: string | null
  armedExpiresOn: string | null
  note: string
}

export const verifiedCurrentImportScope: ImportScope = {
  fromDate: '2026-06-28',
  throughDate: '2026-08-15',
}

export const verifiedCurrentScopeBaseline = {
  employeeCandidates: 56,
  siteKeys: 14,
  assigneeLabels: 53,
  conservativeAliasSuggestions: 28,
  scheduleWeeks: 7,
  shifts: 963,
  sourceOpenShifts: 199,
} as const

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  return z.array(schema).parse(value)
}

export function parseImportReadiness(value: unknown): ImportReadiness {
  return importReadinessSchema.parse(value)
}

async function rpcRows<T>(name: string, parameters: Record<string, unknown>, schema: z.ZodType<T>, message: string): Promise<T[]> {
  const { data, error } = await getSupabaseClient().rpc(name, parameters)
  if (error) throw new Error(message)
  return parseRows(schema, data)
}

export async function getImportMappingReadiness(importRunId: string, scope: ImportScope): Promise<ImportReadiness> {
  const { data, error } = await getSupabaseClient().rpc('get_import_mapping_readiness', {
    target_import_run_id: importRunId,
    target_from_date: scope.fromDate,
    target_through_date: scope.throughDate,
  })
  if (error) throw new Error('Operational import readiness could not be loaded.')
  return parseImportReadiness(data)
}

export function getEmployeeMappingQueue(importRunId: string): Promise<EmployeeMappingQueueItem[]> {
  return rpcRows(
    'get_import_employee_mapping_queue',
    { target_import_run_id: importRunId, page_size: 100, page_offset: 0 },
    employeeMappingQueueItemSchema,
    'Employee mapping records could not be loaded.',
  )
}

export function getSiteMappingQueue(importRunId: string, scope: ImportScope): Promise<SiteMappingQueueItem[]> {
  return rpcRows(
    'get_import_site_mapping_queue',
    {
      target_import_run_id: importRunId,
      target_from_date: scope.fromDate,
      target_through_date: scope.throughDate,
      page_size: 100,
      page_offset: 0,
    },
    siteMappingQueueItemSchema,
    'Site and post mapping records could not be loaded.',
  )
}

export function getAssigneeAliasQueue(importRunId: string, scope: ImportScope): Promise<AssigneeAliasQueueItem[]> {
  return rpcRows(
    'get_import_assignee_alias_queue',
    {
      target_import_run_id: importRunId,
      target_from_date: scope.fromDate,
      target_through_date: scope.throughDate,
      page_size: 100,
      page_offset: 0,
    },
    assigneeAliasQueueItemSchema,
    'Schedule-name mappings could not be loaded.',
  )
}

export function getShiftExceptionQueue(importRunId: string, scope: ImportScope): Promise<ShiftException[]> {
  return rpcRows(
    'get_import_shift_exception_queue',
    {
      target_import_run_id: importRunId,
      target_from_date: scope.fromDate,
      target_through_date: scope.throughDate,
      page_size: 100,
      page_offset: 0,
    },
    shiftExceptionSchema,
    'Shift exceptions could not be loaded.',
  )
}

export async function getEmployeeMappingOptions(importRunId: string): Promise<EmployeeMappingOption[]> {
  return rpcRows(
    'get_import_employee_mapping_options',
    { target_import_run_id: importRunId },
    employeeMappingOptionSchema,
    'Reviewed employee mappings could not be loaded.',
  )
}

export async function saveEmployeeMapping(input: EmployeeMappingInput): Promise<void> {
  const { error } = await getSupabaseClient().rpc('save_import_employee_mapping', {
    target_candidate_id: input.candidateId,
    target_first_name: input.firstName,
    target_middle_name: input.middleName,
    target_last_name: input.lastName,
    target_preferred_name: input.preferredName,
    target_role: input.role,
    target_employment_type: input.employmentType,
    target_status: input.status,
    target_personal_email: input.personalEmail,
    target_company_email: input.companyEmail,
    target_mobile_phone: input.mobilePhone,
    target_guard_license_number: input.guardLicenseNumber,
    target_guard_license_expires_on: input.guardLicenseExpiresOn,
    target_armed_status: input.armedStatus,
    target_armed_credential_number: input.armedCredentialNumber,
    target_armed_expires_on: input.armedExpiresOn,
    target_note: input.note,
  })
  if (error) throw new Error('The employee mapping could not be saved. Review required fields and credential dates.')
}

export async function saveSiteMapping(input: {
  candidateId: string
  canonicalSiteKey: string
  siteCode: string | null
  siteName: string
  postName: string
  requiresArmed: boolean
  active: boolean
  note: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('save_import_site_mapping', {
    target_candidate_id: input.candidateId,
    target_canonical_site_key: input.canonicalSiteKey,
    target_site_code: input.siteCode,
    target_site_name: input.siteName,
    target_post_name: input.postName,
    target_requires_armed: input.requiresArmed,
    target_active: input.active,
    target_note: input.note,
  })
  if (error) throw new Error('The site and post mapping could not be saved.')
}

export async function saveAssigneeAliasMapping(input: {
  importRunId: string
  sourceLabel: string
  disposition: 'employee' | 'multiple_employees' | 'open' | 'exclude'
  employeeMappingKeys: string[]
  note: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('save_import_assignee_alias_mapping', {
    target_import_run_id: input.importRunId,
    target_source_label: input.sourceLabel,
    target_disposition: input.disposition,
    target_employee_mapping_keys: input.employeeMappingKeys,
    target_note: input.note,
  })
  if (error) throw new Error('The schedule-name mapping could not be saved.')
}

export async function saveScheduleOnlyEmployee(input: {
  importRunId: string
  sourceLabel: string
  firstName: string
  middleName: string | null
  lastName: string
  status: EmployeeStatus
  note: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('save_import_schedule_employee_and_alias', {
    target_import_run_id: input.importRunId,
    target_source_label: input.sourceLabel,
    target_first_name: input.firstName,
    target_middle_name: input.middleName,
    target_last_name: input.lastName,
    target_status: input.status,
    target_note: input.note,
  })
  if (error) throw new Error('The schedule-only employee and label mapping could not be saved.')
}

export async function saveShiftOverride(input: {
  candidateId: string
  disposition: 'employee' | 'multiple_employees' | 'open' | 'exclude'
  employeeMappingKeys: string[]
  note: string
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc('save_import_shift_override', {
    target_candidate_id: input.candidateId,
    target_disposition: input.disposition,
    target_employee_mapping_keys: input.employeeMappingKeys,
    target_note: input.note,
  })
  if (error) throw new Error('The shift exception could not be resolved.')
}

export async function acceptScheduleScope(importRunId: string, scope: ImportScope, note: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('accept_import_schedule_scope', {
    target_import_run_id: importRunId,
    target_from_date: scope.fromDate,
    target_through_date: scope.throughDate,
    target_note: note,
  })
  if (error) throw new Error('The schedule scope could not be accepted.')
}

export async function promoteImportScope(input: {
  importRunId: string
  scope: ImportScope
  publish: boolean
  note: string
}): Promise<z.infer<typeof promotionResultSchema>> {
  const { data, error } = await getSupabaseClient().rpc('promote_import_scope', {
    target_import_run_id: input.importRunId,
    target_from_date: input.scope.fromDate,
    target_through_date: input.scope.throughDate,
    target_publish: input.publish,
    target_note: input.note,
  })
  if (error) throw new Error('Promotion was stopped. Refresh readiness and resolve every remaining conflict.')
  return promotionResultSchema.parse(data)
}

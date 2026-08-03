import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary', 'flex'])
const employeeStatusSchema = z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated'])
const credentialStatusSchema = z.enum(['pending', 'active', 'expired', 'suspended', 'revoked'])
const renewalStatusSchema = z.enum([
  'not_started',
  'started',
  'submitted',
  'awaiting_issuing_authority',
  'approved',
  'rejected',
  'completed',
])
const complianceColorSchema = z.enum(['green', 'yellow', 'red', 'gray'])
const workEligibilitySchema = z.enum(['eligible', 'eligible_with_warning', 'restricted', 'ineligible', 'pending_review'])

const credentialTypeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  legacyKind: z.enum(['guard_license', 'armed_guard', 'driver_license', 'first_aid_cpr', 'site_training', 'other']).nullable(),
  name: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  issuingAuthority: z.string().nullable(),
  expirationRequired: z.boolean(),
  affectsWorkEligibility: z.boolean(),
  warningDays: z.array(z.number().int()),
  renewalInstructions: z.string().nullable(),
  employeeEmailInstructions: z.string().nullable(),
  active: z.boolean(),
})

const licensingCredentialSchema = z.object({
  credentialId: z.string().uuid().nullable(),
  credentialTypeId: z.string().uuid(),
  credentialTypeCode: z.string(),
  credentialName: z.string(),
  category: z.string(),
  required: z.boolean(),
  affectsWorkEligibility: z.boolean(),
  status: z.string(),
  complianceColor: complianceColorSchema,
  statusLabel: z.string(),
  credentialNumber: z.string().nullable(),
  issuingAuthority: z.string().nullable(),
  issueDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  daysRemaining: z.number().int().nullable(),
  renewalStatus: renewalStatusSchema.nullable(),
  internalNotes: z.string().nullable(),
  employeeNotes: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
  latestDocumentAt: z.string().nullable(),
  lastEmployeeNotification: z.string().nullable(),
})

const licensingRecordSchema = licensingCredentialSchema.extend({
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  role: appRoleSchema,
  employmentStatus: employeeStatusSchema,
  jobTitle: z.string().nullable(),
  primaryLocation: z.string().nullable(),
  contactEmail: z.string().nullable(),
})

const licensingEmployeeSchema = z.object({
  employeeId: z.string().uuid(),
  employeeNumber: z.string().nullable(),
  username: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  displayName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  employmentStatus: employeeStatusSchema,
  jobTitle: z.string().nullable(),
  hiredOn: z.string().nullable(),
  primaryLocation: z.string().nullable(),
  personalEmail: z.string().nullable(),
  companyEmail: z.string().nullable(),
  mobilePhone: z.string().nullable(),
  credentials: z.array(licensingCredentialSchema),
  overallCompliance: complianceColorSchema,
  workEligibility: workEligibilitySchema,
  requiredCredentialCount: z.number().int().nonnegative(),
  verifiedCredentialCount: z.number().int().nonnegative(),
  missingCredentialCount: z.number().int().nonnegative(),
  closestExpirationDate: z.string().nullable(),
  lastEmployeeNotification: z.string().nullable(),
  affectedFutureShiftCount: z.number().int().nonnegative(),
})

const licensingSummarySchema = z.object({
  fullyCompliantEmployees: z.number().int().nonnegative(),
  expiring90: z.number().int().nonnegative(),
  expiring60: z.number().int().nonnegative(),
  expiring30: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  missingRequired: z.number().int().nonnegative(),
  awaitingReview: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  renewalsInProgress: z.number().int().nonnegative(),
  ineligibleEmployees: z.number().int().nonnegative(),
})

const licensingCenterSchema = z.object({
  serverTimestamp: z.string(),
  currentEmployeeId: z.string().uuid(),
  permissions: z.object({
    canManage: z.boolean(),
    canConfigure: z.boolean(),
    canCommunicate: z.boolean(),
  }),
  summary: licensingSummarySchema,
  credentialTypes: z.array(credentialTypeSchema),
  records: z.array(licensingRecordSchema),
  employees: z.array(licensingEmployeeSchema),
})

export type AppRole = z.infer<typeof appRoleSchema>
export type EmploymentType = z.infer<typeof employmentTypeSchema>
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>
export type CredentialStatus = z.infer<typeof credentialStatusSchema>
export type RenewalStatus = z.infer<typeof renewalStatusSchema>
export type ComplianceColor = z.infer<typeof complianceColorSchema>
export type WorkEligibility = z.infer<typeof workEligibilitySchema>
export type CredentialType = z.infer<typeof credentialTypeSchema>
export type LicensingCredential = z.infer<typeof licensingCredentialSchema>
export type LicensingRecord = z.infer<typeof licensingRecordSchema>
export type LicensingEmployee = z.infer<typeof licensingEmployeeSchema>
export type LicensingCenter = z.infer<typeof licensingCenterSchema>

export interface LicensingEmployeeInput {
  employeeId?: string | null
  firstName: string
  middleName?: string | null
  lastName: string
  preferredName?: string | null
  jobTitle?: string | null
  employmentType: EmploymentType
  employmentStatus: EmployeeStatus
  personalEmail?: string | null
  companyEmail?: string | null
  mobilePhone?: string | null
  role?: AppRole
}

export interface LicensingCredentialInput {
  employeeId: string
  credentialTypeId: string
  status: CredentialStatus
  credentialNumber?: string | null
  issuingAuthority?: string | null
  issueDate?: string | null
  expirationDate?: string | null
  renewalStatus: RenewalStatus
  internalNotes?: string | null
  employeeNotes?: string | null
  rejectionReason?: string | null
}

export interface LicensingCommunicationInput {
  employeeId: string
  credentialId: string | null
  communicationType: string
  recipientEmail: string
  subject: string
  body: string
  templateCode?: string | null
}

function cleanOptional(value: string | null | undefined): string | null {
  const clean = value?.trim()
  return clean ? clean : null
}

function filteredLicensingCenter(center: LicensingCenter, removedEmployeeIds: string[]): LicensingCenter {
  if (removedEmployeeIds.length === 0) return center

  const removed = new Set(removedEmployeeIds)
  const employees = center.employees.filter((employee) => !removed.has(employee.employeeId))
  const records = center.records.filter((record) => !removed.has(record.employeeId))
  const daysRemaining = (minimum: number, maximum: number) => records.filter((record) =>
    typeof record.daysRemaining === 'number'
    && record.daysRemaining >= minimum
    && record.daysRemaining <= maximum,
  ).length

  return {
    ...center,
    employees,
    records,
    summary: {
      awaitingReview: records.filter((record) => record.status === 'Under Review').length,
      expired: records.filter((record) => record.statusLabel === 'Expired').length,
      expiring30: daysRemaining(0, 30),
      expiring60: daysRemaining(31, 60),
      expiring90: daysRemaining(61, 90),
      fullyCompliantEmployees: employees.filter((employee) => employee.overallCompliance === 'green').length,
      ineligibleEmployees: employees.filter((employee) => employee.workEligibility === 'ineligible').length,
      missingRequired: records.filter((record) => record.statusLabel === 'Missing Required Credential').length,
      rejected: records.filter((record) => record.status === 'Rejected').length,
      renewalsInProgress: records.filter((record) => record.status === 'Renewal In Progress' || record.status === 'Renewal Submitted').length,
    },
  }
}

export async function getLicensingCenter(): Promise<LicensingCenter> {
  const client = getSupabaseClient()
  const [centerResult, removedResult] = await Promise.all([
    client.rpc('get_licensing_center'),
    client.rpc('get_removed_employee_ids'),
  ])
  if (centerResult.error) throw new Error(centerResult.error.message || 'Licensing Center could not be loaded.')
  if (removedResult.error) throw new Error(removedResult.error.message || 'Removed employee records could not be reconciled.')
  const center = licensingCenterSchema.parse(centerResult.data)
  const removedEmployeeIds = z.array(z.string().uuid()).parse(removedResult.data)
  return filteredLicensingCenter(center, removedEmployeeIds)
}

export async function upsertLicensingEmployee(input: LicensingEmployeeInput): Promise<LicensingCenter> {
  const { data, error } = await getSupabaseClient().rpc('upsert_licensing_employee', {
    target_company_email: cleanOptional(input.companyEmail),
    target_employee_id: input.employeeId || null,
    target_employment_type: input.employmentType,
    target_first_name: input.firstName.trim(),
    target_job_title: cleanOptional(input.jobTitle),
    target_last_name: input.lastName.trim(),
    target_middle_name: cleanOptional(input.middleName),
    target_mobile_phone: cleanOptional(input.mobilePhone),
    target_personal_email: cleanOptional(input.personalEmail),
    target_preferred_name: cleanOptional(input.preferredName),
    target_role: input.role ?? 'guard',
    target_status: input.employmentStatus,
  })
  if (error) throw new Error(error.message || 'Employee licensing profile could not be saved.')
  return licensingCenterSchema.parse(data)
}

export async function upsertLicensingCredential(input: LicensingCredentialInput): Promise<LicensingCenter> {
  const { data, error } = await getSupabaseClient().rpc('upsert_licensing_credential', {
    target_credential_number: cleanOptional(input.credentialNumber),
    target_credential_type_id: input.credentialTypeId,
    target_employee_id: input.employeeId,
    target_employee_notes: cleanOptional(input.employeeNotes),
    target_expires_on: cleanOptional(input.expirationDate),
    target_issuing_authority: cleanOptional(input.issuingAuthority),
    target_notes: cleanOptional(input.internalNotes),
    target_rejection_reason: cleanOptional(input.rejectionReason),
    target_renewal_status: input.renewalStatus,
    target_status: input.status,
    target_valid_from: cleanOptional(input.issueDate),
  })
  if (error) throw new Error(error.message || 'Credential record could not be saved.')
  return licensingCenterSchema.parse(data)
}

export async function recordLicensingCommunication(input: LicensingCommunicationInput): Promise<LicensingCenter> {
  const { data, error } = await getSupabaseClient().rpc('record_licensing_communication', {
    target_body: input.body.trim(),
    target_communication_type: input.communicationType,
    target_credential_id: input.credentialId,
    target_employee_id: input.employeeId,
    target_recipient_email: input.recipientEmail.trim(),
    target_subject: input.subject.trim(),
    target_template_code: cleanOptional(input.templateCode),
  })
  if (error) throw new Error(error.message || 'Licensing communication could not be recorded.')
  return licensingCenterSchema.parse(data)
}

export async function uploadCredentialDocument(input: {
  credentialId: string
  employeeId: string
  file: File
}): Promise<LicensingCenter> {
  const extension = input.file.name.includes('.') ? input.file.name.split('.').pop() : 'document'
  const safeExtension = extension?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'document'
  const path = `${input.employeeId}/${input.credentialId}/${crypto.randomUUID()}.${safeExtension}`

  const client = getSupabaseClient()
  const upload = await client.storage.from('credential-documents').upload(path, input.file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (upload.error) throw new Error(upload.error.message || 'Credential document could not be uploaded.')

  const { data, error } = await client.rpc('record_licensing_credential_document', {
    target_byte_size: input.file.size,
    target_content_type: input.file.type || null,
    target_credential_id: input.credentialId,
    target_original_filename: input.file.name,
    target_storage_path: upload.data.path,
  })
  if (error) throw new Error(error.message || 'Credential document upload could not be recorded.')
  return licensingCenterSchema.parse(data)
}

export function employeeDisplayName(employee: Pick<LicensingEmployee, 'displayName'>): string {
  return employee.displayName
}

export function formatEligibility(value: WorkEligibility): string {
  return {
    eligible: 'Eligible',
    eligible_with_warning: 'Eligible with Warning',
    ineligible: 'Ineligible',
    pending_review: 'Pending Review',
    restricted: 'Restricted',
  }[value]
}

export function formatRole(value: AppRole): string {
  return {
    admin: 'Admin',
    dispatcher: 'Dispatcher',
    guard: 'Guard',
    recruiting_licensing: 'Recruiting & Licensing',
    scheduler: 'Scheduler',
    supervisor: 'Supervisor',
  }[value]
}

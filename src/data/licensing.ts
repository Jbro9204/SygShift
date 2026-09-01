import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

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

const licensingCredentialDocumentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  uploadedAt: z.string(),
})

const licensingCredentialDocumentsSchema = z.object({
  credentialId: z.string().uuid(),
  credentialName: z.string().nullable(),
  canUpload: z.boolean(),
  documents: z.array(licensingCredentialDocumentSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
})

const licensingDocumentUploadResultSchema = z.object({
  documentId: z.string().uuid(),
  requestId: z.string().uuid(),
  state: z.literal('stored'),
  uploadedAt: z.string().optional(),
})

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
export type LicensingCredentialDocument = z.infer<typeof licensingCredentialDocumentSchema>
export type LicensingCredentialDocuments = z.infer<typeof licensingCredentialDocumentsSchema>
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

export interface LicensingStatusExportAuditInput {
  credentialTypeId?: string | null
  employeeScope: 'guards' | 'all'
  employmentStatus: EmployeeStatus | 'all'
  licenseStatus: 'all' | 'current' | 'expiring' | 'expired' | 'not_licensed' | 'pending' | 'restricted'
  search?: string | null
}

const licensingStatusExportAuditSchema = z.object({
  authorizedAt: z.string(),
  exportId: z.string().uuid(),
})

export type LicensingStatusExportAudit = z.infer<typeof licensingStatusExportAuditSchema>

function cleanOptional(value: string | null | undefined): string | null {
  const clean = value?.trim()
  return clean ? clean : null
}

function filteredLicensingCenter(center: LicensingCenter, removedEmployeeIds: string[]): LicensingCenter {
  const removed = new Set(removedEmployeeIds)
  const employees = center.employees.filter((employee) => !removed.has(employee.employeeId))
  const retainedEmployeeIds = new Set(employees.map((employee) => employee.employeeId))
  const records = center.records.filter((record) => (
    retainedEmployeeIds.has(record.employeeId)
  ))
  // Historical and non-active employees remain available through an intentional filter,
  // but only active employees contribute to the coordinator's current workload summary.
  const workingEmployees = employees.filter((employee) => employee.employmentStatus === 'active')
  const workingEmployeeIds = new Set(workingEmployees.map((employee) => employee.employeeId))
  const workingRecords = records.filter((record) => workingEmployeeIds.has(record.employeeId))
  const daysRemaining = (minimum: number, maximum: number) => workingRecords.filter((record) =>
    typeof record.daysRemaining === 'number'
    && record.daysRemaining >= minimum
    && record.daysRemaining <= maximum,
  ).length

  return {
    ...center,
    employees,
    records,
    summary: {
      awaitingReview: workingRecords.filter((record) => record.status === 'Under Review').length,
      expired: workingRecords.filter((record) => record.statusLabel === 'Expired').length,
      expiring30: daysRemaining(0, 30),
      expiring60: daysRemaining(31, 60),
      expiring90: daysRemaining(61, 90),
      fullyCompliantEmployees: workingEmployees.filter((employee) => employee.overallCompliance === 'green').length,
      ineligibleEmployees: workingEmployees.filter((employee) => employee.workEligibility === 'ineligible').length,
      missingRequired: workingRecords.filter((record) => record.statusLabel === 'Missing Required Credential').length,
      rejected: workingRecords.filter((record) => record.status === 'Rejected').length,
      renewalsInProgress: workingRecords.filter((record) => record.status === 'Renewal In Progress' || record.status === 'Renewal Submitted').length,
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

export async function authorizeLicensingStatusExport(input: LicensingStatusExportAuditInput): Promise<LicensingStatusExportAudit> {
  const { data, error } = await getSupabaseClient().rpc('authorize_licensing_status_report_export', {
    target_credential_type_id: input.credentialTypeId ?? null,
    target_employee_scope: input.employeeScope,
    target_employment_status: input.employmentStatus,
    target_license_status: input.licenseStatus,
    target_search: cleanOptional(input.search),
  })
  if (error) throw new Error(error.message || 'The licensing report export could not be authorized.')
  return licensingStatusExportAuditSchema.parse(data)
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

async function licensingApiHeaders(contentType?: string): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure licensing session is not available.')
  const headers = new Headers({ authorization: `Bearer ${data.session.access_token}` })
  if (contentType) headers.set('content-type', contentType)
  return appendProtectedSessionHeaders(headers)
}

export class LicensingApiError extends Error {
  code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.name = 'LicensingApiError'
    this.code = code
  }
}

export function isLicensingIdentityVerificationRequired(error: unknown): boolean {
  return error instanceof LicensingApiError && error.code === 'recent_document_mfa_required'
}

async function licensingApiError(response: Response, fallback: string): Promise<LicensingApiError> {
  const payload = await response.json().catch(() => null) as { detail?: unknown; error?: unknown } | null
  return new LicensingApiError(
    typeof payload?.detail === 'string' ? payload.detail : fallback,
    typeof payload?.error === 'string' ? payload.error : null,
  )
}

function encodeLicensingDocumentMetadata(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function licensingDocumentMimeType(file: File): string {
  const declared = file.type.trim().toLowerCase().split(';')[0]
  if (['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(declared)) return declared
  const extension = file.name.trim().toLowerCase().split('.').at(-1) ?? ''
  return {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    png: 'image/png',
    webp: 'image/webp',
  }[extension] ?? declared
}

export async function getLicensingCredentialDocuments(
  credentialId: string,
  page = 1,
  pageSize: 5 | 10 | 20 = 5,
): Promise<LicensingCredentialDocuments> {
  const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  const response = await fetch(`/api/v1/licensing/credentials/${encodeURIComponent(credentialId)}/documents?${search}`, {
    cache: 'no-store',
    headers: await licensingApiHeaders(),
  })
  if (!response.ok) throw await licensingApiError(response, 'Credential documents could not be loaded.')
  return licensingCredentialDocumentsSchema.parse(await response.json())
}

export async function uploadCredentialDocument(
  input: { credentialId: string; file: File; idempotencyKey: string },
  onProgress: (percent: number) => void,
): Promise<z.infer<typeof licensingDocumentUploadResultSchema>> {
  const declaredMimeType = licensingDocumentMimeType(input.file)
  const headers = await licensingApiHeaders(declaredMimeType)
  headers.set('x-sygshift-licensing-document-metadata', encodeLicensingDocumentMetadata({
    credentialId: input.credentialId,
    declaredMimeType,
    idempotencyKey: input.idempotencyKey,
    originalFilename: input.file.name,
  }))

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', `/api/v1/licensing/credentials/${encodeURIComponent(input.credentialId)}/documents`)
    headers.forEach((value, key) => request.setRequestHeader(key, value))
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    })
    request.addEventListener('load', () => {
      let payload: unknown = null
      try { payload = request.responseText ? JSON.parse(request.responseText) : null } catch { /* handled below */ }
      if (request.status >= 200 && request.status < 300) {
        onProgress(100)
        try { resolve(licensingDocumentUploadResultSchema.parse(payload)) } catch { reject(new Error('The document was stored but its confirmation was invalid.')) }
        return
      }
      const detail = payload && typeof payload === 'object' && 'detail' in payload
        ? (payload as { detail?: unknown }).detail
        : null
      const code = payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : null
      const failure = new LicensingApiError(
        typeof detail === 'string' ? detail : 'The licensing document could not be uploaded.',
        code,
      )
      reject(failure)
    })
    request.addEventListener('error', () => reject(new Error('The upload connection was interrupted. You can retry safely.')))
    request.addEventListener('abort', () => reject(new Error('The upload was canceled. No incomplete document was released.')))
    request.send(input.file)
  })
}

export async function getLicensingDocumentBlob(
  documentId: string,
  action: 'preview' | 'download',
  reason: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/v1/licensing/documents/${encodeURIComponent(documentId)}/content`, {
    body: JSON.stringify({ action, reason: reason.trim() }),
    cache: 'no-store',
    headers: await licensingApiHeaders('application/json'),
    method: 'POST',
  })
  if (!response.ok) throw await licensingApiError(response, 'The protected licensing document could not be loaded.')
  const disposition = response.headers.get('content-disposition') ?? ''
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  return {
    blob: await response.blob(),
    filename: encodedFilename ? decodeURIComponent(encodedFilename) : 'SygShift-licensing-document',
  }
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

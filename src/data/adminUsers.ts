import { z } from 'zod'
import { fetchWithIdentityVerification } from '../lib/identityVerificationCoordinator'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'
import { employeeLegalDisplayName } from '../lib/employeeName'
import { securityKeySchema, type SecurityKeySummary } from './securityKeys'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary', 'flex'])
const employeeStatusSchema = z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated'])
const accountStatusSchema = z.enum(['not_created', 'active', 'disabled'])
const employeeTimeZoneSchema = z.enum(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'])

const credentialSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['guard_license', 'armed_guard', 'driver_license', 'first_aid_cpr', 'site_training', 'other']),
  status: z.enum(['pending', 'active', 'expired', 'suspended', 'revoked']),
  credentialNumber: z.string().nullable(),
  validFrom: z.string().nullable(),
  expiresOn: z.string().nullable(),
  notes: z.string().nullable(),
})

const accountSchema = z.object({
  authUserId: z.string().uuid(),
  invitedAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  lastSignInAt: z.string().nullable(),
  mustChangePassword: z.boolean(),
  passwordChangedAt: z.string().nullable(),
  mfaEnrolledAt: z.string().nullable(),
  isBootstrapAdmin: z.boolean(),
  status: z.enum(['active', 'disabled']),
  trustedDeviceCount: z.number().int().nonnegative().optional(),
})

const adminUserSchema = z.object({
  id: z.string().uuid(),
  employeeNumber: z.string().nullable(),
  jobTitle: z.string().nullable(),
  username: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  displayName: z.string(),
  role: appRoleSchema,
  employmentType: employmentTypeSchema,
  timeZone: employeeTimeZoneSchema.default('America/Denver'),
  status: employeeStatusSchema,
  photoPath: z.string().nullable(),
  hiredOn: z.string().nullable(),
  separatedOn: z.string().nullable(),
  personalEmail: z.string().nullable(),
  companyEmail: z.string().nullable(),
  mobilePhone: z.string().nullable(),
  account: accountSchema.nullable(),
  accountStatus: accountStatusSchema,
  credentials: z.array(credentialSchema),
})

const adminUserDirectorySchema = z.object({
  serverTimestamp: z.string(),
  currentEmployeeId: z.string().uuid(),
  users: z.array(adminUserSchema),
})

const provisioningCredentialSchema = z.object({
  displayName: z.string(),
  username: z.string(),
  role: appRoleSchema,
  temporaryPassword: z.string(),
  action: z.string(),
})

const provisioningResponseSchema = z.object({
  requestId: z.string(),
  provisioned: z.array(provisioningCredentialSchema).optional(),
  failures: z.array(z.object({
    displayName: z.string(),
    username: z.string(),
    error: z.string(),
  })).optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
  role: appRoleSchema.optional(),
  temporaryPassword: z.string().optional(),
  action: z.string().optional(),
})

const loginEmailResponseSchema = z.object({
  requestId: z.string(),
  sent: z.array(z.object({
    displayName: z.string(),
    email: z.string().nullable(),
    username: z.string(),
  })).optional(),
  failures: z.array(z.object({
    displayName: z.string(),
    username: z.string(),
    error: z.string(),
  })).optional(),
  displayName: z.string().optional(),
  email: z.string().nullable().optional(),
  username: z.string().optional(),
  action: z.string().optional(),
})

const mfaResetResponseSchema = z.object({
  displayName: z.string(),
  factorsRemoved: z.number().int().nonnegative(),
  requestId: z.string(),
  securityKeysRevoked: z.number().int().nonnegative(),
  securityKeySessionsRevoked: z.number().int().nonnegative(),
  trustedDevicesRevoked: z.number().int().nonnegative(),
  username: z.string(),
})

const adminSecurityKeysResponseSchema = z.object({
  displayName: z.string(),
  employeeId: z.string().uuid(),
  keys: z.array(securityKeySchema),
  requestId: z.string(),
})

const adminSecurityKeyRemovalResponseSchema = z.object({
  displayName: z.string(),
  employeeId: z.string().uuid(),
  removed: z.boolean(),
  requestId: z.string(),
  securityKeySessionsRevoked: z.number().int().nonnegative(),
})

const passwordResetResponseSchema = z.object({
  displayName: z.string(),
  email: z.string(),
  requestId: z.string(),
  username: z.string(),
})

const welcomeEmailResponseSchema = z.object({
  requestId: z.string(),
  displayName: z.string(),
  delivery: z.unknown().optional(),
  email: z.string().nullable(),
  username: z.string(),
})

const recentlyDeletedRecordSchema = z.object({
  id: z.string().uuid(),
  recordType: z.enum(['employee', 'site', 'post']),
  recordId: z.string().uuid(),
  displayName: z.string(),
  metadata: z.unknown(),
  deletedBy: z.string().uuid().nullable(),
  deletedAt: z.string(),
  expiresAt: z.string(),
})

const deleteEmployeeResponseSchema = z.object({
  deletedId: z.string().uuid(),
  employeeId: z.string().uuid(),
  displayName: z.string(),
  expiresAt: z.string(),
  removalMode: z.literal('history_preserving'),
})

const employeeRemovalPreviewSchema = z.object({
  employeeId: z.string().uuid(),
  displayName: z.string(),
  username: z.string(),
  operationalHistory: z.object({
    shiftAssignments: z.number().int().nonnegative(),
    shiftRequests: z.number().int().nonnegative(),
    timeEvents: z.number().int().nonnegative(),
    timeOffRequests: z.number().int().nonnegative(),
    callOffReports: z.number().int().nonnegative(),
    credentials: z.number().int().nonnegative(),
  }),
})

export type AppRole = z.infer<typeof appRoleSchema>
export type CredentialKind = z.infer<typeof credentialSchema>['kind']
export type CredentialStatus = z.infer<typeof credentialSchema>['status']
export type EmploymentType = z.infer<typeof employmentTypeSchema>
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>
export type AccountStatus = z.infer<typeof accountStatusSchema>
export type EmployeeTimeZone = z.infer<typeof employeeTimeZoneSchema>
export type AdminUser = z.infer<typeof adminUserSchema>
export type AdminUserDirectory = z.infer<typeof adminUserDirectorySchema>
export type ProvisioningCredential = z.infer<typeof provisioningCredentialSchema>
export type LoginEmailResult = z.infer<typeof loginEmailResponseSchema>
export type EmployeePasswordResetResult = z.infer<typeof passwordResetResponseSchema>
export type WelcomeEmailResult = z.infer<typeof welcomeEmailResponseSchema>
export type RecentlyDeletedRecord = z.infer<typeof recentlyDeletedRecordSchema>
export type DeleteEmployeeResult = z.infer<typeof deleteEmployeeResponseSchema>
export type EmployeeRemovalPreview = z.infer<typeof employeeRemovalPreviewSchema>

export interface EmployeeMutationInput {
  employeeId?: string
  employeeNumber?: string | null
  jobTitle?: string | null
  firstName: string
  middleName?: string | null
  lastName: string
  preferredName?: string | null
  role: AppRole
  employmentType: EmploymentType
  timeZone?: EmployeeTimeZone
  status: EmployeeStatus
  personalEmail?: string | null
  companyEmail?: string | null
  mobilePhone?: string | null
}

export interface EmployeeCredentialMutationInput {
  employeeId: string
  kind: CredentialKind
  status: CredentialStatus
  credentialNumber?: string | null
  validFrom?: string | null
  expiresOn?: string | null
  notes?: string | null
}

function withLegalDisplayName(user: AdminUser): AdminUser {
  return {
    ...user,
    displayName: employeeLegalDisplayName(user),
  }
}

function cleanOptional(value: string | null | undefined): string | null {
  const clean = value?.trim()
  return clean ? clean : null
}

function employeeRpcPayload(input: EmployeeMutationInput) {
  return {
    target_company_email: cleanOptional(input.companyEmail),
    target_employee_number: cleanOptional(input.employeeNumber),
    target_employment_type: input.employmentType,
    target_first_name: input.firstName.trim(),
    target_job_title: cleanOptional(input.jobTitle),
    target_last_name: input.lastName.trim(),
    target_middle_name: cleanOptional(input.middleName),
    target_mobile_phone: cleanOptional(input.mobilePhone),
    target_personal_email: cleanOptional(input.personalEmail),
    target_preferred_name: cleanOptional(input.preferredName),
    target_role: input.role,
    target_status: input.status,
  }
}

async function authHeaders(): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure session is not available.')
  return appendProtectedSessionHeaders({
    authorization: `Bearer ${data.session.access_token}`,
    'content-type': 'application/json',
  })
}

async function adminApiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithIdentityVerification(async () => fetch(path, {
    ...init,
    cache: 'no-store',
    headers: await authHeaders(),
  }))
}

async function parseApiResponse(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error.replaceAll('_', ' ')
        : 'The account request failed.'
    throw new Error(message)
  }
  return payload
}

export async function getAdminUserDirectory(): Promise<AdminUserDirectory> {
  const { data, error } = await getSupabaseClient().rpc('get_admin_user_directory')
  if (error) throw new Error('Admin user directory could not be loaded. Admin MFA is required.')
  const directory = adminUserDirectorySchema.parse(data)
  return {
    ...directory,
    users: directory.users.map(withLegalDisplayName),
  }
}

export async function createEmployee(input: EmployeeMutationInput): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_create_employee_with_time_zone', {
    ...employeeRpcPayload(input),
    target_time_zone: input.timeZone ?? 'America/Denver',
  })
  if (error) throw new Error(error.message || 'Employee could not be created.')
  return withLegalDisplayName(adminUserSchema.parse(data))
}

export async function updateEmployee(input: EmployeeMutationInput & { employeeId: string }): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_update_employee_with_time_zone', {
    target_employee_id: input.employeeId,
    target_time_zone: input.timeZone ?? 'America/Denver',
    ...employeeRpcPayload(input),
  })
  if (error) throw new Error(error.message || 'Employee could not be updated.')
  return withLegalDisplayName(adminUserSchema.parse(data))
}

export async function upsertEmployeeCredential(input: EmployeeCredentialMutationInput): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_upsert_employee_credential', {
    target_credential_number: cleanOptional(input.credentialNumber),
    target_employee_id: input.employeeId,
    target_expires_on: cleanOptional(input.expiresOn),
    target_kind: input.kind,
    target_notes: cleanOptional(input.notes),
    target_status: input.status,
    target_valid_from: cleanOptional(input.validFrom),
  })
  if (error) throw new Error(error.message || 'Credential could not be updated.')
  return withLegalDisplayName(adminUserSchema.parse(data))
}

export async function setEmployeeAccountState(employeeId: string, disabled: boolean): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_set_employee_account_state', {
    target_disabled: disabled,
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Account state could not be changed.')
  return withLegalDisplayName(adminUserSchema.parse(data))
}

export async function revokeEmployeeTrustedDevices(employeeId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('admin_revoke_employee_trusted_devices', {
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Remembered devices could not be revoked.')
  return z.number().int().nonnegative().parse(data)
}

export type EmployeeMfaResetResult = z.infer<typeof mfaResetResponseSchema>

export async function resetEmployeeMfa(employeeId: string): Promise<EmployeeMfaResetResult> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/mfa-reset`, {
    body: JSON.stringify({}),
    method: 'POST',
  })
  const payload = await parseApiResponse(response)
  return mfaResetResponseSchema.parse(payload)
}

export async function getEmployeeSecurityKeys(employeeId: string): Promise<SecurityKeySummary[]> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/security-keys`, {
    method: 'GET',
  })
  const parsed = adminSecurityKeysResponseSchema.safeParse(await parseApiResponse(response))
  if (!parsed.success) {
    throw new Error('Registered security keys could not be loaded. Refresh and try again.')
  }
  return parsed.data.keys
}

export async function revokeEmployeeSecurityKey(employeeId: string, keyId: string): Promise<{
  removed: boolean
  securityKeySessionsRevoked: number
}> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/security-keys/${encodeURIComponent(keyId)}`, {
    method: 'DELETE',
  })
  const result = adminSecurityKeyRemovalResponseSchema.parse(await parseApiResponse(response))
  return {
    removed: result.removed,
    securityKeySessionsRevoked: result.securityKeySessionsRevoked,
  }
}

export async function sendEmployeePasswordReset(employeeId: string): Promise<EmployeePasswordResetResult> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/password-reset`, {
    body: JSON.stringify({}),
    method: 'POST',
  })
  return passwordResetResponseSchema.parse(await parseApiResponse(response))
}

export async function getEmployeeRemovalPreview(employeeId: string): Promise<EmployeeRemovalPreview> {
  const { data, error } = await getSupabaseClient().rpc('get_employee_removal_preview', {
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Employee removal details could not be loaded.')
  return employeeRemovalPreviewSchema.parse(data)
}

export async function removeSeparatedEmployee(
  employeeId: string,
  confirmationUsername: string,
  reason: string,
): Promise<DeleteEmployeeResult> {
  const { data, error } = await getSupabaseClient().rpc('admin_remove_separated_employee', {
    confirmation_username: confirmationUsername.trim(),
    removal_reason: reason.trim(),
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Separated employee could not be removed.')
  return deleteEmployeeResponseSchema.parse(data)
}

export async function getRecentlyDeletedEmployees(): Promise<RecentlyDeletedRecord[]> {
  const { data, error } = await getSupabaseClient().rpc('get_recently_deleted_records', {
    target_record_type: 'employee',
  })
  if (error) throw new Error(error.message || 'Recently deleted employees could not be loaded.')
  return z.array(recentlyDeletedRecordSchema).parse(data)
}

export async function provisionEmployeeAccount(employeeId: string, temporaryPassword?: string): Promise<ProvisioningCredential> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/account`, {
    body: JSON.stringify({ temporaryPassword: cleanOptional(temporaryPassword) }),
    method: 'POST',
  })
  const payload = await parseApiResponse(response)
  const parsed = provisioningResponseSchema.parse(payload)
  if (!parsed.username || !parsed.role || !parsed.temporaryPassword || !parsed.action) {
    throw new Error('Provisioning response was incomplete.')
  }
  return {
    action: parsed.action,
    displayName: parsed.displayName ?? parsed.username,
    role: parsed.role,
    temporaryPassword: parsed.temporaryPassword,
    username: parsed.username,
  }
}

export async function provisionMissingAccounts(): Promise<{
  provisioned: ProvisioningCredential[]
  failures: Array<{ displayName: string; username: string; error: string }>
}> {
  const response = await adminApiRequest('/api/v1/admin/users/provision-missing', {
    body: JSON.stringify({}),
    method: 'POST',
  })
  const payload = provisioningResponseSchema.parse(await parseApiResponse(response))
  return {
    failures: payload.failures ?? [],
    provisioned: payload.provisioned ?? [],
  }
}

export async function sendEmployeeLoginEmail(employeeId: string, temporaryPassword?: string): Promise<LoginEmailResult> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/login-email`, {
    body: JSON.stringify({ temporaryPassword: cleanOptional(temporaryPassword) }),
    method: 'POST',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error.replaceAll('_', ' ')
        : 'The login email could not be sent.'
    throw new Error(message)
  }
  return loginEmailResponseSchema.parse(payload)
}

export async function sendEmployeeWelcomeEmail(employeeId: string): Promise<WelcomeEmailResult> {
  const response = await adminApiRequest(`/api/v1/admin/users/${employeeId}/welcome-email`, {
    body: JSON.stringify({}),
    method: 'POST',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error.replaceAll('_', ' ')
        : 'The welcome email could not be sent.'
    throw new Error(message)
  }
  return welcomeEmailResponseSchema.parse(payload)
}

export async function sendAllEmployeeLoginEmails(): Promise<LoginEmailResult> {
  const response = await adminApiRequest('/api/v1/admin/users/login-emails', {
    body: JSON.stringify({}),
    method: 'POST',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error.replaceAll('_', ' ')
        : 'The login email batch could not be sent.'
    throw new Error(message)
  }
  return loginEmailResponseSchema.parse(payload)
}

export function credentialsToCsv(credentials: ProvisioningCredential[]): string {
  const headers = ['Display Name', 'Username', 'Role', 'Temporary Password', 'Action']
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [
    headers.map(escape).join(','),
    ...credentials.map((credential) => [
      credential.displayName,
      credential.username,
      credential.role,
      credential.temporaryPassword,
      credential.action,
    ].map(escape).join(',')),
  ].join('\n')
}

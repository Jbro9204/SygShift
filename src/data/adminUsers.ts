import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { getTrustedDeviceToken } from '../lib/trustedDeviceToken'

const appRoleSchema = z.enum(['guard', 'dispatcher', 'supervisor', 'admin'])
const employmentTypeSchema = z.enum(['hourly', 'salary'])
const employeeStatusSchema = z.enum(['active', 'leave', 'inactive', 'separated'])
const accountStatusSchema = z.enum(['not_created', 'active', 'disabled'])

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

const welcomeEmailResponseSchema = z.object({
  requestId: z.string(),
  displayName: z.string(),
  delivery: z.unknown().optional(),
  email: z.string().nullable(),
  username: z.string(),
})

export type AppRole = z.infer<typeof appRoleSchema>
export type EmploymentType = z.infer<typeof employmentTypeSchema>
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>
export type AccountStatus = z.infer<typeof accountStatusSchema>
export type AdminUser = z.infer<typeof adminUserSchema>
export type AdminUserDirectory = z.infer<typeof adminUserDirectorySchema>
export type ProvisioningCredential = z.infer<typeof provisioningCredentialSchema>
export type LoginEmailResult = z.infer<typeof loginEmailResponseSchema>
export type WelcomeEmailResult = z.infer<typeof welcomeEmailResponseSchema>

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
  status: EmployeeStatus
  personalEmail?: string | null
  companyEmail?: string | null
  mobilePhone?: string | null
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
  const headers = new Headers()
  headers.set('authorization', `Bearer ${data.session.access_token}`)
  headers.set('content-type', 'application/json')
  const trustedDeviceToken = getTrustedDeviceToken()
  if (trustedDeviceToken) headers.set('x-sygshift-trusted-device', trustedDeviceToken)
  return headers
}

async function parseApiResponse(response: Response) {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.error === 'string'
        ? payload.error.replaceAll('_', ' ')
        : 'The user provisioning request failed.'
    throw new Error(message)
  }
  return provisioningResponseSchema.parse(payload)
}

export async function getAdminUserDirectory(): Promise<AdminUserDirectory> {
  const { data, error } = await getSupabaseClient().rpc('get_admin_user_directory')
  if (error) throw new Error('Admin user directory could not be loaded. Admin MFA is required.')
  return adminUserDirectorySchema.parse(data)
}

export async function createEmployee(input: EmployeeMutationInput): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_create_employee', employeeRpcPayload(input))
  if (error) throw new Error(error.message || 'Employee could not be created.')
  return adminUserSchema.parse(data)
}

export async function updateEmployee(input: EmployeeMutationInput & { employeeId: string }): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_update_employee', {
    target_employee_id: input.employeeId,
    ...employeeRpcPayload(input),
  })
  if (error) throw new Error(error.message || 'Employee could not be updated.')
  return adminUserSchema.parse(data)
}

export async function setEmployeeAccountState(employeeId: string, disabled: boolean): Promise<AdminUser> {
  const { data, error } = await getSupabaseClient().rpc('admin_set_employee_account_state', {
    target_disabled: disabled,
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Account state could not be changed.')
  return adminUserSchema.parse(data)
}

export async function revokeEmployeeTrustedDevices(employeeId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('admin_revoke_employee_trusted_devices', {
    target_employee_id: employeeId,
  })
  if (error) throw new Error(error.message || 'Remembered devices could not be revoked.')
  return z.number().int().nonnegative().parse(data)
}

export async function provisionEmployeeAccount(employeeId: string, temporaryPassword?: string): Promise<ProvisioningCredential> {
  const response = await fetch(`/api/v1/admin/users/${employeeId}/account`, {
    body: JSON.stringify({ temporaryPassword: cleanOptional(temporaryPassword) }),
    headers: await authHeaders(),
    method: 'POST',
  })
  const payload = await parseApiResponse(response)
  if (!payload.username || !payload.role || !payload.temporaryPassword || !payload.action) {
    throw new Error('Provisioning response was incomplete.')
  }
  return {
    action: payload.action,
    displayName: payload.displayName ?? payload.username,
    role: payload.role,
    temporaryPassword: payload.temporaryPassword,
    username: payload.username,
  }
}

export async function provisionMissingAccounts(): Promise<{
  provisioned: ProvisioningCredential[]
  failures: Array<{ displayName: string; username: string; error: string }>
}> {
  const response = await fetch('/api/v1/admin/users/provision-missing', {
    body: JSON.stringify({}),
    headers: await authHeaders(),
    method: 'POST',
  })
  const payload = await parseApiResponse(response)
  return {
    failures: payload.failures ?? [],
    provisioned: payload.provisioned ?? [],
  }
}

export async function sendEmployeeLoginEmail(employeeId: string, temporaryPassword?: string): Promise<LoginEmailResult> {
  const response = await fetch(`/api/v1/admin/users/${employeeId}/login-email`, {
    body: JSON.stringify({ temporaryPassword: cleanOptional(temporaryPassword) }),
    headers: await authHeaders(),
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
  const response = await fetch(`/api/v1/admin/users/${employeeId}/welcome-email`, {
    body: JSON.stringify({}),
    headers: await authHeaders(),
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
  const response = await fetch('/api/v1/admin/users/login-emails', {
    body: JSON.stringify({}),
    headers: await authHeaders(),
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

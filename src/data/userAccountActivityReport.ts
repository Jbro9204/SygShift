import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const nullableText = z.string().nullable()

const accountActivityRowSchema = z.object({
  employeeId: z.string().uuid(),
  employeeNumber: nullableText,
  employeeName: z.string(),
  username: z.string(),
  companyEmail: nullableText,
  employmentStatus: z.enum(['onboarding', 'active', 'leave', 'inactive', 'separated']),
  employmentType: z.enum(['hourly', 'salary', 'flex']),
  jobTitle: nullableText,
  primaryRole: z.string(),
  accessRoles: z.array(z.string()),
  accountState: z.enum(['not_created', 'active', 'disabled', 'setup_incomplete']),
  loginState: z.enum(['never_signed_in', 'recent', 'stale']),
  invitedAt: nullableText,
  activatedAt: nullableText,
  passwordChangedAt: nullableText,
  firstCompletedSignInAt: nullableText,
  lastCompletedSignInAt: nullableText,
  completedSignInCount: z.number().int().nonnegative(),
  completedSources: z.array(z.enum(['native', 'platform', 'sygsphere'])),
  requiresMfa: z.boolean(),
  mfaEnrolled: z.boolean(),
  mfaEnrolledAt: nullableText,
  activeSessionCount: z.number().int().nonnegative(),
  trustedDeviceCount: z.number().int().nonnegative(),
  securityException: z.enum(['none', 'enabled_noncurrent_employee', 'disabled_current_employee', 'mfa_missing']),
  nextAction: z.string(),
})

const accountActivityReportSchema = z.object({
  serverTimestamp: z.string(),
  staleDays: z.union([z.literal(7), z.literal(30), z.literal(60), z.literal(90)]),
  pageSize: z.number().int().positive().max(5000),
  offset: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    activeAccounts: z.number().int().nonnegative(),
    neverSignedIn: z.number().int().nonnegative(),
    pendingSetup: z.number().int().nonnegative(),
    mfaAttention: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
    securityExceptions: z.number().int().nonnegative(),
  }),
  rows: z.array(accountActivityRowSchema).max(5000),
  requestId: z.string().optional(),
})

export type UserAccountActivityRow = z.infer<typeof accountActivityRowSchema>
export type UserAccountActivityReport = z.infer<typeof accountActivityReportSchema>

export interface UserAccountActivityFilters {
  search: string
  employmentStatus: string
  accountStatus: string
  loginStatus: string
  mfaStatus: string
  role: string
  source: string
  staleDays: 7 | 30 | 60 | 90
}

export async function getUserAccountActivityReport(input: UserAccountActivityFilters & {
  pageSize?: 10 | 25 | 50
  offset?: number
  export?: boolean
}) {
  const parameters = new URLSearchParams({
    search: input.search.trim(),
    employmentStatus: input.employmentStatus,
    accountStatus: input.accountStatus,
    loginStatus: input.loginStatus,
    mfaStatus: input.mfaStatus,
    role: input.role,
    source: input.source,
    staleDays: String(input.staleDays),
    pageSize: String(input.pageSize ?? 25),
    offset: String(Math.max(0, input.offset ?? 0)),
  })
  if (input.export) parameters.set('export', 'true')
  const response = await documentApiRequest(`/api/v1/reports/user-account-activity?${parameters}`)
  if (!response.ok) throw await parseApiError(response, 'The user account activity report could not be loaded.')
  return accountActivityReportSchema.parse(await response.json())
}

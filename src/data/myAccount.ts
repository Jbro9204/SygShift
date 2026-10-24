import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

const nullableText = z.string().nullable()

const myAccountSchema = z.object({
  profile: z.object({
    employeeId: z.string().uuid(),
    preferredName: nullableText,
    displayName: z.string(),
    personalEmail: nullableText,
    personalEmailVerifiedAt: nullableText,
    companyEmail: nullableText,
    mobilePhone: nullableText,
    hasPhoto: z.boolean(),
  }),
  employment: z.object({
    legalName: z.string(),
    employeeNumber: nullableText,
    username: z.string(),
    jobTitle: nullableText,
    primaryRole: z.string(),
    employmentType: z.string(),
    status: z.string(),
    hiredOn: nullableText,
  }),
  security: z.object({
    passwordChangedAt: nullableText,
    mfaEnrolledAt: nullableText,
    mfaRequired: z.boolean(),
    lastSignInAt: nullableText,
    trustedDeviceCount: z.number().int().nonnegative(),
  }),
  notifications: z.object({
    schedulePublished: z.boolean(),
    scheduleChanged: z.boolean(),
    timeOffDecision: z.boolean(),
    openShiftAvailable: z.boolean(),
    announcements: z.boolean(),
  }),
  recentActivity: z.array(z.object({
    occurredAt: z.string(),
    operation: z.string(),
    area: z.string(),
  })),
})

const apiResultSchema = z.object({ requestId: z.string().optional() }).passthrough()
const personalEmailVerificationResultSchema = z.object({
  expiresAt: z.string().min(1),
  operationId: z.string().uuid(),
  sent: z.literal(true),
})
const passwordChangeResultSchema = z.object({
  authUserId: z.string().uuid(),
  employeeId: z.string().uuid(),
  passwordAlreadyCurrent: z.boolean(),
  saved: z.literal(true),
})

export const PERSONAL_EMAIL_VERIFICATION_INTENT_STORAGE_KEY = 'sygshift:personal-email-verification-intent:v1'
const PERSONAL_EMAIL_VERIFICATION_INTENT_TTL_MS = 55 * 60 * 1000

export type PersonalEmailVerificationIntent = {
  email: string
  operationId: string
  ownerEmployeeId: string
  startedAt: number
}

export class PersonalEmailVerificationRequestError extends Error {
  readonly ambiguous: boolean

  constructor(message: string, ambiguous: boolean) {
    super(message)
    this.name = 'PersonalEmailVerificationRequestError'
    this.ambiguous = ambiguous
  }
}

function normalizePersonalEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function clearPersonalEmailVerificationIntent(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(PERSONAL_EMAIL_VERIFICATION_INTENT_STORAGE_KEY)
  } catch {
    // A successful or terminal request is still authoritative when browser
    // storage is unavailable; no sensitive token material is stored here.
  }
}

function readPersonalEmailVerificationIntent(): PersonalEmailVerificationIntent | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(PERSONAL_EMAIL_VERIFICATION_INTENT_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersonalEmailVerificationIntent>
    if (typeof value.email !== 'string'
      || typeof value.operationId !== 'string'
      || typeof value.ownerEmployeeId !== 'string'
      || typeof value.startedAt !== 'number'
      || !z.string().uuid().safeParse(value.operationId).success
      || !z.string().uuid().safeParse(value.ownerEmployeeId).success) {
      clearPersonalEmailVerificationIntent()
      return null
    }
    return {
      email: normalizePersonalEmail(value.email),
      operationId: value.operationId,
      ownerEmployeeId: value.ownerEmployeeId,
      startedAt: value.startedAt,
    }
  } catch {
    clearPersonalEmailVerificationIntent()
    return null
  }
}

export function acquirePersonalEmailVerificationIntent(
  ownerEmployeeId: string,
  email: string,
  now = Date.now(),
): PersonalEmailVerificationIntent {
  const normalizedEmail = normalizePersonalEmail(email)
  const stored = readPersonalEmailVerificationIntent()
  if (stored
    && stored.ownerEmployeeId === ownerEmployeeId
    && stored.email === normalizedEmail
    && now - stored.startedAt >= 0
    && now - stored.startedAt < PERSONAL_EMAIL_VERIFICATION_INTENT_TTL_MS) {
    return stored
  }
  if (stored) clearPersonalEmailVerificationIntent()
  const intent = {
    email: normalizedEmail,
    operationId: crypto.randomUUID(),
    ownerEmployeeId,
    startedAt: now,
  }
  persistPersonalEmailVerificationIntent(intent)
  return intent
}

export function persistPersonalEmailVerificationIntent(
  intent: PersonalEmailVerificationIntent,
): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(PERSONAL_EMAIL_VERIFICATION_INTENT_STORAGE_KEY, JSON.stringify(intent))
  } catch {
    // The mounted component still retains the operation in memory. The server
    // remains authoritative, but a browser that disables session storage cannot
    // recover an in-flight operation after a reload.
  }
}

export function personalEmailVerificationFailureIsAmbiguous(error: unknown): boolean {
  return error instanceof PersonalEmailVerificationRequestError && error.ambiguous
}

export type MyAccount = z.infer<typeof myAccountSchema>
export type MyAccountNotifications = MyAccount['notifications']

export async function getMyAccount(): Promise<MyAccount> {
  const { data, error } = await getSupabaseClient().rpc('get_my_account')
  if (error) throw new Error(error.message || 'Your account information could not be loaded.')
  return myAccountSchema.parse(data)
}

export async function updateMyAccountProfile(preferredName: string, mobilePhone: string): Promise<MyAccount> {
  const { data, error } = await getSupabaseClient().rpc('update_my_account_profile', {
    target_mobile_phone: mobilePhone.trim() || null,
    target_preferred_name: preferredName.trim() || null,
  })
  if (error) throw new Error(error.message || 'Your profile could not be saved.')
  return myAccountSchema.parse(data)
}

export async function updateMyNotificationPreferences(preferences: MyAccountNotifications): Promise<MyAccountNotifications> {
  const { data, error } = await getSupabaseClient().rpc('update_my_notification_preferences', {
    target_announcements: preferences.announcements,
    target_open_shift_available: preferences.openShiftAvailable,
    target_schedule_changed: preferences.scheduleChanged,
    target_schedule_published: preferences.schedulePublished,
    target_time_off_decision: preferences.timeOffDecision,
  })
  if (error) throw new Error(error.message || 'Notification preferences could not be saved.')
  return myAccountSchema.shape.notifications.parse(data)
}

async function accountApiHeaders(contentType?: string): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure session is not available.')
  const headers = new Headers({ authorization: `Bearer ${data.session.access_token}` })
  if (contentType) headers.set('content-type', contentType)
  return appendProtectedSessionHeaders(headers)
}

async function parseAccountApi(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : 'Your account change could not be completed.'
    throw new Error(message)
  }
  return apiResultSchema.parse(payload)
}

export async function uploadMyAccountPhoto(file: Blob): Promise<void> {
  const response = await fetch('/api/v1/account/photo', {
    body: file,
    headers: await accountApiHeaders(file.type),
    method: 'PUT',
  })
  await parseAccountApi(response)
}

export async function getMyAccountPhoto(): Promise<Blob> {
  const response = await fetch('/api/v1/account/photo', {
    cache: 'no-store',
    headers: await accountApiHeaders(),
  })
  if (!response.ok) throw new Error('Your profile photo could not be loaded.')
  return response.blob()
}

export async function removeMyAccountPhoto(): Promise<void> {
  const response = await fetch('/api/v1/account/photo', {
    headers: await accountApiHeaders(),
    method: 'DELETE',
  })
  await parseAccountApi(response)
}

export async function requestPersonalEmailVerification(email: string, operationId: string): Promise<void> {
  const headers = await accountApiHeaders('application/json')
  let response: Response
  try {
    response = await fetch('/api/v1/account/email-verification/request', {
      body: JSON.stringify({ email, operationId }),
      headers,
      method: 'POST',
    })
  } catch {
    throw new PersonalEmailVerificationRequestError(
      'The verification request outcome could not be confirmed. Retry the same request.',
      true,
    )
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const code = typeof payload?.error === 'string' ? payload.error : ''
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : 'Your account change could not be completed.'
    const ambiguous = response.status >= 500
      || code === 'email_verification_finalization_pending'
      || code === 'email_delivery_failed'
    throw new PersonalEmailVerificationRequestError(message, ambiguous)
  }
  const parsed = personalEmailVerificationResultSchema.safeParse(payload)
  if (!parsed.success || parsed.data.operationId !== operationId) {
    throw new PersonalEmailVerificationRequestError(
      'The verification request outcome could not be confirmed. Retry the same request.',
      true,
    )
  }
}

export async function confirmPersonalEmailVerification(token: string): Promise<void> {
  const response = await fetch('/api/v1/account/email-verification/confirm', {
    body: JSON.stringify({ token }),
    headers: await accountApiHeaders('application/json'),
    method: 'POST',
  })
  await parseAccountApi(response)
}

export type PasswordChangeResult = z.infer<typeof passwordChangeResultSchema> & {
  sessionStillCurrent: boolean
}

// Pure owner fence shared by both password surfaces. A resolved request may
// belong to a tab whose account changed while the request was in flight; that
// result must not update the new account's UI state.
export function passwordChangeResultIsCurrent(
  operation: number,
  currentOperation: number,
  ownerEmployeeId: string,
  currentEmployeeId: string | null,
  result: PasswordChangeResult,
): boolean {
  return operation === currentOperation
    && ownerEmployeeId === currentEmployeeId
    && result.employeeId === ownerEmployeeId
    && result.sessionStillCurrent
}

export async function updateMyPassword(password: string, expectedEmployeeId: string): Promise<PasswordChangeResult> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.getSession()
  const ownerSession = data.session
  if (error || !ownerSession?.access_token || !ownerSession.user.id) {
    throw new Error('Your secure session is not available.')
  }
  const response = await fetch('/api/v1/account/password', {
    body: JSON.stringify({
      expectedAuthUserId: ownerSession.user.id,
      expectedEmployeeId,
      password,
    }),
    headers: appendProtectedSessionHeaders(new Headers({
      authorization: `Bearer ${ownerSession.access_token}`,
      'content-type': 'application/json',
    })),
    method: 'POST',
  })
  const parsed = passwordChangeResultSchema.parse(await parseAccountApi(response))
  const current = await supabase.auth.getSession()
  return {
    ...parsed,
    sessionStillCurrent: !current.error
      && current.data.session?.access_token === ownerSession.access_token
      && current.data.session.user.id === parsed.authUserId,
  }
}

export async function signOutOtherSessions(): Promise<void> {
  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signOut({ scope: 'others' })
  if (error) throw new Error(error.message || 'Other sessions could not be signed out.')
  const audit = await supabase.rpc('record_my_account_security_action', {
    target_action: 'sign_out_other_sessions',
  })
  if (audit.error) throw new Error(audit.error.message || 'The session change could not be added to account history.')
}

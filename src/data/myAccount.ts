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

export async function requestPersonalEmailVerification(email: string): Promise<void> {
  const response = await fetch('/api/v1/account/email-verification/request', {
    body: JSON.stringify({ email }),
    headers: await accountApiHeaders('application/json'),
    method: 'POST',
  })
  await parseAccountApi(response)
}

export async function confirmPersonalEmailVerification(token: string): Promise<void> {
  const response = await fetch('/api/v1/account/email-verification/confirm', {
    body: JSON.stringify({ token }),
    headers: await accountApiHeaders('application/json'),
    method: 'POST',
  })
  await parseAccountApi(response)
}

export async function updateMyPassword(password: string): Promise<void> {
  const supabase = getSupabaseClient()
  const update = await supabase.auth.updateUser({ password })
  if (update.error) throw new Error(update.error.message || 'Your password could not be changed.')
  const marked = await supabase.rpc('mark_password_changed')
  if (marked.error) throw new Error(marked.error.message || 'Your password change could not be finalized.')
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

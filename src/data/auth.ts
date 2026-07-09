import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { clearTrustedDeviceToken } from '../lib/trustedDeviceToken'

export const AUTH_EMAIL_DOMAIN = 'accounts.sygshift.invalid'
export const USERNAME_PATTERN = /^[a-z][a-z0-9]{1,62}$/
export const SESSION_CONTEXT_REFRESH_EVENT = 'sygshift:session-context-refresh'

const sessionContextSchema = z.object({
  employee_id: z.string().uuid(),
  username: z.string().min(1),
  display_name: z.string().min(1),
  role: z.enum(['guard', 'dispatcher', 'scheduler', 'supervisor', 'admin']),
  must_change_password: z.boolean(),
  password_changed_at: z.string().nullable(),
  mfa_enrolled_at: z.string().nullable(),
  mfa_required: z.boolean(),
  has_mfa: z.boolean(),
})

export type SessionContext = {
  employeeId: string
  username: string
  displayName: string
  role: 'guard' | 'dispatcher' | 'scheduler' | 'supervisor' | 'admin'
  mustChangePassword: boolean
  passwordChangedAt: string | null
  mfaEnrolledAt: string | null
  mfaRequired: boolean
  hasMfa: boolean
}

export type PasswordPolicyResult = {
  valid: boolean
  failures: string[]
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(username))
}

export function usernameToAuthEmail(username: string): string {
  const normalizedUsername = normalizeUsername(username)

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    throw new Error('Enter a valid SygShift username.')
  }

  return `${normalizedUsername}@${AUTH_EMAIL_DOMAIN}`
}

export async function signInWithUsername(username: string, password: string): Promise<void> {
  const { error } = await getSupabaseClient().auth.signInWithPassword({
    email: usernameToAuthEmail(username),
    password,
  })

  if (error) {
    throw new Error('The username or password was not accepted.')
  }
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut()
  if (error) throw new Error('You could not be signed out. Please try again.')
  clearTrustedDeviceToken()
}

export async function getSessionContext(): Promise<SessionContext> {
  const { data, error } = await getSupabaseClient().rpc('get_session_context')
  if (error) throw new Error('Your secure session could not be verified.')

  const parsed = sessionContextSchema.parse(Array.isArray(data) ? data[0] : data)

  return {
    employeeId: parsed.employee_id,
    username: parsed.username,
    displayName: parsed.display_name,
    role: parsed.role,
    mustChangePassword: parsed.must_change_password,
    passwordChangedAt: parsed.password_changed_at,
    mfaEnrolledAt: parsed.mfa_enrolled_at,
    mfaRequired: parsed.mfa_required,
    hasMfa: parsed.has_mfa,
  }
}

export function notifySessionContextChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(SESSION_CONTEXT_REFRESH_EVENT))
}

export function validatePassword(password: string, username?: string): PasswordPolicyResult {
  const failures: string[] = []
  const normalizedUsername = username ? normalizeUsername(username) : ''
  const loweredPassword = password.toLowerCase()

  if (password.length < 12) failures.push('Use at least 12 characters.')
  if (!/[a-z]/.test(password)) failures.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) failures.push('Add an uppercase letter.')
  if (!/[0-9]/.test(password)) failures.push('Add a number.')
  if (!/[^A-Za-z0-9]/.test(password)) failures.push('Add a symbol.')
  if (normalizedUsername && loweredPassword.includes(normalizedUsername)) {
    failures.push('Do not include your username.')
  }

  for (const blockedTerm of ['password', 'sygshift', 'sygilant', 'security', 'welcome', 'temporary']) {
    if (loweredPassword.includes(blockedTerm)) {
      failures.push('Avoid common or company-related words.')
      break
    }
  }

  return {
    valid: failures.length === 0,
    failures,
  }
}

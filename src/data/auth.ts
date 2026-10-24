import { z } from 'zod'
import { deactivateSharedIdentitySupabaseSession, getSupabaseClient } from '../lib/supabase'
import { publishSharedIdentityBrowserEvent } from '../lib/sharedIdentityBrowserSync'
import { clearSecurityKeySession } from '../lib/securityKeySession'
import {
  clearSharedIdentityServerSession,
  clearSharedIdentitySession,
} from '../lib/sharedIdentitySession'
import { clearPushSession } from './pushNotifications'
import { cancelLoginSound } from '../lib/notificationSounds'
import { clearViewDateSelections } from '../lib/sessionViewDateSelection'
import { clearPersonalEmailVerificationIntent } from './myAccount'

export const AUTH_EMAIL_DOMAIN = 'accounts.sygshift.invalid'
export const USERNAME_PATTERN = /^[a-z][a-z0-9]{1,62}$/
export const SESSION_CONTEXT_REFRESH_EVENT = 'sygshift:session-context-refresh'
export const TOTP_SETUP_STORAGE_KEY = 'sygshift:totp-setup'
export const LOCAL_SIGN_OUT_BARRIER_STORAGE_KEY = 'sygshift:local-sign-out-barrier:v1'
export const LOCAL_SIGN_OUT_BARRIER_EVENT = 'sygshift:local-sign-out-barrier-change'

const SIGN_OUT_REMOTE_CLEANUP_TIMEOUT_MS = 3_000
let localSignOutBarrierFallback = false

function publishLocalSignOutBarrierChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(LOCAL_SIGN_OUT_BARRIER_EVENT))
}

function markLocalSignOutBarrier(): void {
  localSignOutBarrierFallback = true
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCAL_SIGN_OUT_BARRIER_STORAGE_KEY, 'blocked')
    } catch {
      // The in-memory fence still protects this document when storage is unavailable.
    }
  }
  publishLocalSignOutBarrierChange()
}

export function beginLocalSignOutBarrier(): void {
  markLocalSignOutBarrier()
}

function clearLocalSignOutBarrier(): void {
  localSignOutBarrierFallback = false
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(LOCAL_SIGN_OUT_BARRIER_STORAGE_KEY)
    } catch {
      // The in-memory fence is authoritative for this document.
    }
  }
  publishLocalSignOutBarrierChange()
}

export function hasLocalSignOutBarrier(): boolean {
  if (localSignOutBarrierFallback) return true
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LOCAL_SIGN_OUT_BARRIER_STORAGE_KEY) === 'blocked'
  } catch {
    return false
  }
}

export function clearPendingTotpEnrollment(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(TOTP_SETUP_STORAGE_KEY)
  } catch {
    // In-memory session teardown must still continue when browser storage is unavailable.
  }
}

async function settleRemoteSignOutCleanup(operation: Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = globalThis.setTimeout(resolve, SIGN_OUT_REMOTE_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout)
  }
}

const sessionContextSchema = z.object({
  employee_id: z.string().uuid(),
  username: z.string().min(1),
  display_name: z.string().min(1),
  role: z.enum(['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin']),
  must_change_password: z.boolean(),
  password_changed_at: z.string().nullable(),
  mfa_enrolled_at: z.string().nullable(),
  mfa_required: z.boolean(),
  has_mfa: z.boolean(),
  time_zone: z.string().default('America/Denver'),
  permissions: z.array(z.string()).optional().default([]),
})

const recoveryRequestSchema = z.object({
  accepted: z.literal(true),
  message: z.string().min(1),
})

export type SessionContext = {
  employeeId: string
  username: string
  displayName: string
  role: 'guard' | 'dispatcher' | 'scheduler' | 'recruiting_licensing' | 'supervisor' | 'admin'
  mustChangePassword: boolean
  passwordChangedAt: string | null
  mfaEnrolledAt: string | null
  mfaRequired: boolean
  hasMfa: boolean
  timeZone: string
  permissions: string[]
}

class SessionContextError extends Error {
  readonly transient: boolean

  constructor(transient: boolean) {
    super('Your secure session could not be verified.')
    this.name = 'SessionContextError'
    this.transient = transient
  }
}

const transientSessionErrorCodes = new Set([
  '40001', '40P01', '53300', '57014', '57P01', '57P02', '57P03',
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'PGRST202',
])

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

export async function requestPasswordReset(username: string): Promise<string> {
  const response = await fetch('/api/v1/auth/password-reset/request', {
    body: JSON.stringify({ username: normalizeUsername(username) }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error('Password recovery is temporarily unavailable. Please try again shortly.')
  }

  const result = recoveryRequestSchema.safeParse(await response.json())
  if (!result.success) {
    throw new Error('Password recovery is temporarily unavailable. Please try again shortly.')
  }
  return result.data.message
}

export async function requestUsernameReminder(email: string): Promise<string> {
  const response = await fetch('/api/v1/auth/username-recovery/request', {
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error('Username recovery is temporarily unavailable. Please try again shortly.')
  }

  const result = recoveryRequestSchema.safeParse(await response.json())
  if (!result.success) {
    throw new Error('Username recovery is temporarily unavailable. Please try again shortly.')
  }
  return result.data.message
}

export async function verifyPasswordRecoveryToken(tokenHash: string): Promise<void> {
  const normalizedTokenHash = tokenHash.trim()
  if (
    normalizedTokenHash.length < 32
    || normalizedTokenHash.length > 512
    || !/^[A-Za-z0-9._~-]+$/.test(normalizedTokenHash)
  ) {
    throw new Error('This password-reset link is invalid or has expired.')
  }

  const { data, error } = await getSupabaseClient().auth.verifyOtp({
    token_hash: normalizedTokenHash,
    type: 'recovery',
  })

  if (error || !data.session) {
    throw new Error('This password-reset link is invalid or has expired. Request a new link and try again.')
  }
}

export async function signOut(options: { sharedIdentityServerSessionCleared?: boolean } = {}): Promise<void> {
  const client = getSupabaseClient()

  cancelLoginSound()

  // Enter the browser-wide fail-closed state before either remote or local
  // session cleanup begins. A shared-cookie outage must not leave reloads or
  // sibling tabs able to rebuild the workspace from the still-valid local
  // Supabase session. The fence is cleared only after both required cleanup
  // steps have succeeded.
  beginLocalSignOutBarrier()

  // The HttpOnly shared-session cookie must be confirmed cleared before the
  // local Supabase credential is removed. Supabase emits SIGNED_OUT as soon as
  // local sign-out runs; doing that first can redirect/unmount the shell before
  // a failed shared-cookie cleanup can lock the workspace and offer a retry.
  // Push cleanup remains best-effort and may run alongside the required fence.
  const pushCleanup = settleRemoteSignOutCleanup(clearPushSession())
  if (!options.sharedIdentityServerSessionCleared) {
    try {
      await clearSharedIdentityServerSession()
    } catch {
      await pushCleanup
      throw new Error('Shared sign-out could not be confirmed. The workspace remains locked; try sign out again before leaving this device.')
    }
  }

  clearPendingTotpEnrollment()
  clearPersonalEmailVerificationIntent()

  let localSignOutError: Error | null = null
  try {
    const { error } = await client.auth.signOut({ scope: 'local' })
    if (error) {
      localSignOutError = new Error('Your local browser session could not be cleared. The workspace remains locked on this device; try sign out again and do not leave this device unattended.')
    }
  } catch {
    localSignOutError = new Error('Your local browser session could not be cleared. The workspace remains locked on this device; try sign out again and do not leave this device unattended.')
  } finally {
    deactivateSharedIdentitySupabaseSession()
    clearSharedIdentitySession()
    clearSecurityKeySession()
    clearViewDateSelections()
    // Always notify callback tabs. A shared-login handoff may still be waiting
    // to finalize even when this tab does not yet hold a shared session.
    publishSharedIdentityBrowserEvent('cleared')
  }

  await pushCleanup
  if (localSignOutError) throw localSignOutError
  // Clear the cross-tab barrier last. A sibling must not be allowed to restore
  // while this tab still holds the shared bearer, enrollment material, cached
  // workspace, or has not yet published the cleared-session notification.
  clearLocalSignOutBarrier()
}

async function requestSessionContext(signal?: AbortSignal): Promise<SessionContext> {
  let response
  try {
    const request = getSupabaseClient().rpc('get_session_context')
    response = signal ? await request.abortSignal(signal) : await request
  } catch {
    throw new SessionContextError(true)
  }
  const { data, error, status } = response
  if (error) {
    const responseStatus = status ?? -1
    const normalizedMessage = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
    const transient = responseStatus === 0
      || transientSessionErrorCodes.has(error.code ?? '')
      || (error.code ?? '').startsWith('08')
      || responseStatus === 408
      || responseStatus === 425
      || responseStatus === 429
      || responseStatus >= 500
      || normalizedMessage.includes('connection pool')
      || normalizedMessage.includes('failed to fetch')
      || normalizedMessage.includes('network')
      || normalizedMessage.includes('timed out')
      || normalizedMessage.includes('timeout')
    throw new SessionContextError(transient)
  }

  const parsedResult = sessionContextSchema.safeParse(Array.isArray(data) ? data[0] : data)
  if (!parsedResult.success) throw new SessionContextError(false)
  const parsed = parsedResult.data

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
    timeZone: parsed.time_zone,
    permissions: parsed.permissions,
  }
}

export async function getSessionContext(): Promise<SessionContext> {
  return requestSessionContext()
}

export async function getSessionContextWithSignal(signal: AbortSignal): Promise<SessionContext> {
  return requestSessionContext(signal)
}

export function isTransientSessionContextError(error: unknown): boolean {
  return error instanceof SessionContextError && error.transient
}

export type CompletedSignInKind = 'native' | 'platform' | 'sygsphere'

export async function recordCompletedSignIn(kind: CompletedSignInKind = 'native'): Promise<void> {
  const rpcName = kind === 'platform'
    ? 'platform_record_completed_sign_in'
    : kind === 'sygsphere'
      ? 'sygsphere_record_completed_sign_in'
      : 'record_completed_sign_in'
  try {
    const { error, status } = await getSupabaseClient().rpc(rpcName)
    if (error) {
      const errorCode = error.code ?? ''
      const responseStatus = status ?? 0
      const transientCodes = new Set([
        '40001', '40P01', '53300', '57014', '57P01', '57P02', '57P03',
        'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'PGRST202',
      ])
      const retryable = transientCodes.has(errorCode)
        || errorCode.startsWith('08')
        || responseStatus === 408
        || responseStatus === 425
        || responseStatus === 429
        || responseStatus >= 500
      throw new CompletedSignInActivityError(retryable)
    }
  } catch (error) {
    if (error instanceof CompletedSignInActivityError) throw error
    throw new CompletedSignInActivityError(true)
  }
}

type CompletedSignInRetryOptions = {
  maxAttempts?: number
  retryDelaysMs?: readonly number[]
  signal?: AbortSignal
}

class CompletedSignInActivityError extends Error {
  readonly retryable: boolean

  constructor(retryable: boolean) {
    super('Completed sign-in activity could not be recorded.')
    this.name = 'CompletedSignInActivityError'
    this.retryable = retryable
  }
}

const DEFAULT_COMPLETED_SIGN_IN_RETRY_DELAYS_MS = [0, 1_000, 4_000, 15_000, 60_000] as const

function waitForCompletedSignInRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, delayMs)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export async function recordCompletedSignInWithRetry(
  kind: CompletedSignInKind = 'native',
  options: CompletedSignInRetryOptions = {},
): Promise<void> {
  const retryDelaysMs = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : DEFAULT_COMPLETED_SIGN_IN_RETRY_DELAYS_MS
  const maximumAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? retryDelaysMs.length),
  )
  let attempt = 0

  while (!options.signal?.aborted && attempt < maximumAttempts) {
    const delayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]
    await waitForCompletedSignInRetry(delayMs, options.signal)
    if (options.signal?.aborted) return
    try {
      await recordCompletedSignIn(kind)
      return
    } catch (error) {
      attempt += 1
      if (!(error instanceof CompletedSignInActivityError) || !error.retryable) throw error
      if (attempt >= maximumAttempts) throw error
    }
  }
}

export function authSessionIdFromAccessToken(accessToken: string): string | null {
  try {
    const encodedPayload = accessToken.split('.')[1]
    if (!encodedPayload) return null
    const base64 = encodedPayload.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=')
    const payload = JSON.parse(globalThis.atob(base64)) as { session_id?: unknown }
    return typeof payload.session_id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.session_id)
      ? payload.session_id
      : null
  } catch {
    return null
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

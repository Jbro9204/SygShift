const tokenPattern = /^[A-Za-z0-9_-]{40,180}$/
export type SharedIdentityScope = 'platform' | 'sygsphere'
const legacyStorageKeys = [
  'sygshift:shared-identity-session-token:v1',
  'sygshift:shared-identity-session-expiry:v1',
  'sygshift:shared-identity-session-persistent:v1',
]

type SharedIdentitySession = {
  expiresAt: string
  persistent: boolean
  scope: SharedIdentityScope
  token: string
}

type SharedIdentitySessionResponse = {
  destination?: unknown
  expiresAt?: unknown
  persistent?: unknown
  scope?: unknown
  sharedIdentityToken?: unknown
  supabaseSession?: {
    accessToken?: unknown
    refreshToken?: unknown
  }
}

export type HydratedSharedIdentitySession = {
  accessToken: string
  refreshToken: string
  scope: SharedIdentityScope
}

export class SharedIdentitySessionRestoreError extends Error {
  readonly retryAfterMs: number | null
  readonly status: number | null
  readonly transient: boolean

  constructor(
    message: string,
    options: { retryAfterMs?: number | null, status?: number | null, transient: boolean },
  ) {
    super(message)
    this.name = 'SharedIdentitySessionRestoreError'
    this.retryAfterMs = options.retryAfterMs ?? null
    this.status = options.status ?? null
    this.transient = options.transient
  }
}

const retryableRestoreStatuses = new Set([408, 425, 429])
const sessionRecoveryBaseDelayMs = 2_000
const sessionRecoveryMaximumDelayMs = 60_000

let currentSession: SharedIdentitySession | null = null

function purgeLegacySharedIdentityStorage(): void {
  if (typeof window === 'undefined') return
  for (const key of legacyStorageKeys) {
    window.localStorage.removeItem(key)
    window.sessionStorage.removeItem(key)
  }
}

purgeLegacySharedIdentityStorage()

export function clearSharedIdentitySession(): void {
  currentSession = null
  purgeLegacySharedIdentityStorage()
}

export function setSharedIdentitySession(
  token: string,
  expiresAt: string,
  persistent: boolean,
  scope: SharedIdentityScope = 'sygsphere',
): void {
  replaceSharedIdentitySession({ expiresAt, persistent, scope, token })
}

export function getSharedIdentitySessionToken(): string | null {
  if (!currentSession) return null
  const expiresAtMs = Date.parse(currentSession.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return null
  }
  return currentSession.token
}

export function getSharedIdentitySessionScope(): SharedIdentityScope | null {
  return currentSession?.scope ?? null
}

export function getSharedIdentitySessionExpiresAt(): string | null {
  return currentSession?.expiresAt ?? null
}

export function sharedIdentityRefreshDelayMs(accessToken: string, now = Date.now()): number {
  const [, encodedPayload] = accessToken.split('.')
  if (!encodedPayload) return 60_000
  try {
    const normalized = encodedPayload.replaceAll('-', '+').replaceAll('_', '/')
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { exp?: unknown }
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) return 60_000
    return Math.max(1_000, decoded.exp * 1000 - now - 90_000)
  } catch {
    return 60_000
  }
}

export async function hydrateSharedIdentitySession(signal?: AbortSignal): Promise<HydratedSharedIdentitySession | null> {
  const response = await requestSharedIdentitySession(signal)
  if (response.status === 204 || response.status === 401 || response.status === 403) {
    clearSharedIdentitySession()
    return null
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: unknown } | null
    throw new SharedIdentitySessionRestoreError(
      'The shared SygShift session could not be restored.',
      {
        retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
        status: response.status,
        transient: isRetryableRestoreFailure(response.status, failure?.error),
      },
    )
  }
  const payload = await response.json().catch(() => null) as SharedIdentitySessionResponse | null
  const scope = sharedIdentityResponseScope(payload)
  if (
    !scope
    ||
    typeof payload?.sharedIdentityToken !== 'string'
    || typeof payload.expiresAt !== 'string'
    || typeof payload.persistent !== 'boolean'
    || typeof payload.supabaseSession?.accessToken !== 'string'
    || typeof payload.supabaseSession.refreshToken !== 'string'
  ) {
    throw new Error('The shared SygShift session response was invalid.')
  }
  if (!replaceSharedIdentitySession({
    expiresAt: payload.expiresAt,
    persistent: payload.persistent,
    scope,
    token: payload.sharedIdentityToken,
  })) {
    throw new Error('The shared SygShift session response was invalid.')
  }
  return {
    accessToken: payload.supabaseSession.accessToken,
    refreshToken: payload.supabaseSession.refreshToken,
    scope,
  }
}

export function shouldPreserveSharedIdentitySessionOnRestoreError(error: unknown): boolean {
  return error instanceof SharedIdentitySessionRestoreError
}

export function isTransientSharedIdentitySessionRestoreError(error: unknown): boolean {
  return error instanceof SharedIdentitySessionRestoreError && error.transient
}

export function sharedIdentitySessionRestoreRetryAfterMs(error: unknown): number | null {
  return error instanceof SharedIdentitySessionRestoreError ? error.retryAfterMs : null
}

export function sharedIdentityRecoveryDelayMs(
  attempt: number,
  retryAfterMs: number | null = null,
  random = Math.random(),
): number {
  const normalizedAttempt = Math.max(0, Math.min(20, Math.floor(attempt)))
  const exponentialDelay = Math.min(
    sessionRecoveryMaximumDelayMs,
    sessionRecoveryBaseDelayMs * 2 ** normalizedAttempt,
  )
  const normalizedRandom = Math.max(0, Math.min(1, random))
  const jitteredDelay = Math.min(
    sessionRecoveryMaximumDelayMs,
    Math.round(exponentialDelay * (1 + normalizedRandom * 0.25)),
  )
  const requestedDelay = retryAfterMs === null
    ? 0
    : Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
  return Math.max(jitteredDelay, requestedDelay)
}

async function requestSharedIdentitySession(signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch('/api/v1/auth/shared-identity/session', {
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'POST',
      signal,
    })
  } catch {
    throw new SharedIdentitySessionRestoreError(
      'The shared SygShift session is temporarily unavailable.',
      { transient: true },
    )
  }
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

function isRetryableRestoreFailure(status: number, code: unknown): boolean {
  const retryableStatus = status >= 500 || retryableRestoreStatuses.has(status)
  if (!retryableStatus) return false
  return code !== 'shared_identity_not_configured'
    && code !== 'shared_identity_disabled'
    && code !== 'shared_identity_upstream_rejected'
}

function isSharedIdentityScope(value: unknown): value is SharedIdentityScope {
  return value === 'platform' || value === 'sygsphere'
}

function replaceSharedIdentitySession(candidate: SharedIdentitySession): boolean {
  const expiresAtMs = Date.parse(candidate.expiresAt)
  if (
    !tokenPattern.test(candidate.token)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()
    || !isSharedIdentityScope(candidate.scope)
  ) return false
  currentSession = candidate
  purgeLegacySharedIdentityStorage()
  return true
}

function sharedIdentityResponseScope(payload: SharedIdentitySessionResponse | null): SharedIdentityScope | null {
  if (!payload) return null
  if (payload.scope === undefined && payload.destination === undefined) return 'sygsphere'
  if (
    payload.scope === 'platform'
    && payload.destination === '/'
  ) return 'platform'
  if (
    payload.scope === 'sygsphere'
    && payload.destination === '/sygsphere'
  ) return 'sygsphere'
  return null
}

export async function clearSharedIdentityServerSession(accessToken?: string): Promise<void> {
  try {
    await fetch('/api/v1/auth/shared-identity/session/logout', {
      cache: 'no-store',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
      keepalive: true,
      method: 'POST',
    }).catch(() => undefined)
  } finally {
    clearSharedIdentitySession()
  }
}

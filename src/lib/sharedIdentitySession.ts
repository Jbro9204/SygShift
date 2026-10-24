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
const sharedIdentityLogoutDeadlineMs = 3_000
// A failed HttpOnly-cookie cleanup must remain fail-closed across reloads. The
// next restore attempt retries the cleanup; the long upper bound only prevents
// abandoned browser metadata from becoming permanent when site data cannot be
// managed normally.
const sharedIdentityLogoutBarrierMs = 365 * 24 * 60 * 60 * 1_000
const sharedIdentityLogoutBarrierKey = 'sygshift:shared-identity-logout-barrier:v1'

let currentSession: SharedIdentitySession | null = null
let pendingLogoutController: AbortController | null = null
let pendingLogoutPromise: Promise<void> | null = null
let inMemoryLogoutBarrier: { expiresAt: number; id: string } | null = null

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
): boolean {
  return replaceSharedIdentitySession({ expiresAt, persistent, scope, token })
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
  await waitForSharedIdentityLogoutBarrier(signal)
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
  if (sharedIdentityLogoutBarrierExpiresAt() > Date.now()) return false
  currentSession = candidate
  purgeLegacySharedIdentityStorage()
  return true
}

function sharedIdentityLogoutBarrierExpiresAt(): number {
  const inMemoryExpiresAt = inMemoryLogoutBarrier?.expiresAt ?? 0
  if (inMemoryExpiresAt <= Date.now()) inMemoryLogoutBarrier = null
  if (typeof window === 'undefined') return inMemoryExpiresAt > Date.now() ? inMemoryExpiresAt : 0
  try {
    const parsed = JSON.parse(window.localStorage.getItem(sharedIdentityLogoutBarrierKey) ?? 'null') as { expiresAt?: unknown } | null
    if (typeof parsed?.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return inMemoryLogoutBarrier?.expiresAt ?? 0
    if (parsed.expiresAt <= Date.now()) {
      window.localStorage.removeItem(sharedIdentityLogoutBarrierKey)
      return inMemoryLogoutBarrier?.expiresAt ?? 0
    }
    return Math.max(parsed.expiresAt, inMemoryLogoutBarrier?.expiresAt ?? 0)
  } catch {
    try { window.localStorage.removeItem(sharedIdentityLogoutBarrierKey) } catch { /* The in-memory barrier remains authoritative in this tab. */ }
    return inMemoryLogoutBarrier?.expiresAt ?? 0
  }
}

function writeSharedIdentityLogoutBarrier(id: string, expiresAt: number): void {
  inMemoryLogoutBarrier = { expiresAt, id }
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(sharedIdentityLogoutBarrierKey, JSON.stringify({ expiresAt, id })) } catch { /* In-memory serialization still applies in this tab. */ }
}

function clearSharedIdentityLogoutBarrier(id: string): void {
  if (inMemoryLogoutBarrier?.id === id) inMemoryLogoutBarrier = null
  if (typeof window === 'undefined') return
  try {
    const parsed = JSON.parse(window.localStorage.getItem(sharedIdentityLogoutBarrierKey) ?? 'null') as { id?: unknown } | null
    if (parsed?.id === id) window.localStorage.removeItem(sharedIdentityLogoutBarrierKey)
  } catch {
    try { window.localStorage.removeItem(sharedIdentityLogoutBarrierKey) } catch { /* The in-memory barrier was already cleared above. */ }
  }
}

export async function waitForSharedIdentityLogoutBarrier(signal?: AbortSignal): Promise<void> {
  if (pendingLogoutPromise) await pendingLogoutPromise
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (sharedIdentityLogoutBarrierExpiresAt() <= Date.now()) return

  // A previous tab may have cleared its in-memory state while the server-side
  // HttpOnly cookie cleanup failed. Reconcile that cleanup before any restore
  // request is allowed to recreate the signed-in identity.
  await clearSharedIdentityServerSession()
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
  // Local bearer material must disappear synchronously. The remote cookie
  // cleanup is required before a shared identity can be restored again. A
  // failed cleanup leaves a persistent browser barrier and is retried before
  // the next shared-session hydration.
  clearSharedIdentitySession()
  pendingLogoutController?.abort()
  const controller = new AbortController()
  pendingLogoutController = controller
  const barrierId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  const barrierExpiresAt = Date.now() + sharedIdentityLogoutBarrierMs
  writeSharedIdentityLogoutBarrier(barrierId, barrierExpiresAt)
  const deadline = globalThis.setTimeout(() => controller.abort(), sharedIdentityLogoutDeadlineMs)
  const remoteLogout = fetch('/api/v1/auth/shared-identity/session/logout', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
      keepalive: true,
      method: 'POST',
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) {
        throw new SharedIdentitySessionRestoreError(
          'The shared sign-out cookie could not be cleared.',
          { status: response.status, transient: response.status >= 500 || retryableRestoreStatuses.has(response.status) },
        )
      }
    }).catch((error: unknown) => {
      if (error instanceof SharedIdentitySessionRestoreError) throw error
      throw new SharedIdentitySessionRestoreError(
        'The shared sign-out cookie could not be cleared.',
        { transient: true },
      )
    })
  pendingLogoutPromise = remoteLogout
  let cleanupConfirmed = false
  try {
    await remoteLogout
    cleanupConfirmed = true
  } finally {
    globalThis.clearTimeout(deadline)
    if (pendingLogoutController === controller) pendingLogoutController = null
    if (pendingLogoutPromise === remoteLogout) pendingLogoutPromise = null
    if (cleanupConfirmed) clearSharedIdentityLogoutBarrier(barrierId)
  }
}

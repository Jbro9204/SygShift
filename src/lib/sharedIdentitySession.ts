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
  clearSharedIdentitySession()
  const expiresAtMs = Date.parse(expiresAt)
  if (
    !tokenPattern.test(token)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()
    || !isSharedIdentityScope(scope)
  ) return
  currentSession = { expiresAt, persistent, scope, token }
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

export async function hydrateSharedIdentitySession(): Promise<HydratedSharedIdentitySession | null> {
  const response = await fetch('/api/v1/auth/shared-identity/session', {
    cache: 'no-store',
    credentials: 'same-origin',
    method: 'POST',
  })
  if (response.status === 204) {
    clearSharedIdentitySession()
    return null
  }
  if (!response.ok) {
    clearSharedIdentitySession()
    throw new Error('The shared SygShift session could not be restored.')
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
    clearSharedIdentitySession()
    throw new Error('The shared SygShift session response was invalid.')
  }
  setSharedIdentitySession(payload.sharedIdentityToken, payload.expiresAt, payload.persistent, scope)
  if (!getSharedIdentitySessionToken()) return null
  return {
    accessToken: payload.supabaseSession.accessToken,
    refreshToken: payload.supabaseSession.refreshToken,
    scope,
  }
}

function isSharedIdentityScope(value: unknown): value is SharedIdentityScope {
  return value === 'platform' || value === 'sygsphere'
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

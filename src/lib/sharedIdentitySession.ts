const tokenPattern = /^[A-Za-z0-9_-]{40,180}$/
const legacyStorageKeys = [
  'sygshift:shared-identity-session-token:v1',
  'sygshift:shared-identity-session-expiry:v1',
  'sygshift:shared-identity-session-persistent:v1',
]

type SharedIdentitySession = {
  expiresAt: string
  persistent: boolean
  token: string
}

type SharedIdentitySessionResponse = {
  expiresAt?: unknown
  persistent?: unknown
  sharedIdentityToken?: unknown
  supabaseSession?: {
    accessToken?: unknown
    refreshToken?: unknown
  }
}

export type HydratedSharedIdentitySession = {
  accessToken: string
  refreshToken: string
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

export function setSharedIdentitySession(token: string, expiresAt: string, persistent: boolean): void {
  clearSharedIdentitySession()
  const expiresAtMs = Date.parse(expiresAt)
  if (!tokenPattern.test(token) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return
  currentSession = { expiresAt, persistent, token }
}

export function getSharedIdentitySessionToken(): string | null {
  if (!currentSession) return null
  const expiresAtMs = Date.parse(currentSession.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    clearSharedIdentitySession()
    return null
  }
  return currentSession.token
}

export async function hydrateSharedIdentitySession(): Promise<HydratedSharedIdentitySession | null> {
  clearSharedIdentitySession()
  const response = await fetch('/api/v1/auth/shared-identity/session', {
    cache: 'no-store',
    credentials: 'same-origin',
    method: 'POST',
  })
  if (response.status === 204) return null
  if (!response.ok) throw new Error('The shared SygSphere session could not be restored.')
  const payload = await response.json().catch(() => null) as SharedIdentitySessionResponse | null
  if (
    typeof payload?.sharedIdentityToken !== 'string'
    || typeof payload.expiresAt !== 'string'
    || typeof payload.persistent !== 'boolean'
    || typeof payload.supabaseSession?.accessToken !== 'string'
    || typeof payload.supabaseSession.refreshToken !== 'string'
  ) throw new Error('The shared SygSphere session response was invalid.')
  setSharedIdentitySession(payload.sharedIdentityToken, payload.expiresAt, payload.persistent)
  if (!getSharedIdentitySessionToken()) return null
  return {
    accessToken: payload.supabaseSession.accessToken,
    refreshToken: payload.supabaseSession.refreshToken,
  }
}

export async function clearSharedIdentityServerSession(accessToken?: string): Promise<void> {
  clearSharedIdentitySession()
  await fetch('/api/v1/auth/shared-identity/session/logout', {
    cache: 'no-store',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
    keepalive: true,
    method: 'POST',
  }).catch(() => undefined)
}

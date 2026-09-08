const TOKEN_KEY = 'sygshift:shared-identity-session-token:v1'
const EXPIRY_KEY = 'sygshift:shared-identity-session-expiry:v1'
const PERSISTENCE_KEY = 'sygshift:shared-identity-session-persistent:v1'

function stores(): Storage[] {
  if (typeof window === 'undefined') return []
  return [window.sessionStorage, window.localStorage]
}

export function clearSharedIdentitySession(): void {
  for (const storage of stores()) {
    storage.removeItem(TOKEN_KEY)
    storage.removeItem(EXPIRY_KEY)
    storage.removeItem(PERSISTENCE_KEY)
  }
}

export function setSharedIdentitySession(token: string, expiresAt: string, persistent: boolean): void {
  clearSharedIdentitySession()
  const expiresAtMs = Date.parse(expiresAt)
  if (!/^[A-Za-z0-9_-]{40,180}$/.test(token) || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return
  const storage = persistent ? window.localStorage : window.sessionStorage
  storage.setItem(TOKEN_KEY, token)
  storage.setItem(EXPIRY_KEY, expiresAt)
  storage.setItem(PERSISTENCE_KEY, String(persistent))
}

export function getSharedIdentitySessionToken(): string | null {
  for (const storage of stores()) {
    const token = storage.getItem(TOKEN_KEY)
    const expiresAt = storage.getItem(EXPIRY_KEY)
    if (!token && !expiresAt) continue
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN
    if (!token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      storage.removeItem(TOKEN_KEY)
      storage.removeItem(EXPIRY_KEY)
      storage.removeItem(PERSISTENCE_KEY)
      continue
    }
    return token
  }
  return null
}

const SECURITY_KEY_TOKEN_KEY = 'sygshift:security-key-session-token:v1'
const SECURITY_KEY_EXPIRY_KEY = 'sygshift:security-key-session-expiry:v1'

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage
}

export function clearSecurityKeySession(): void {
  const target = storage()
  target?.removeItem(SECURITY_KEY_TOKEN_KEY)
  target?.removeItem(SECURITY_KEY_EXPIRY_KEY)
}

export function setSecurityKeySession(token: string, expiresAt: string): void {
  const target = storage()
  if (!target) return

  const expiresAtMs = Date.parse(expiresAt)
  if (!token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    clearSecurityKeySession()
    return
  }

  target.setItem(SECURITY_KEY_TOKEN_KEY, token)
  target.setItem(SECURITY_KEY_EXPIRY_KEY, expiresAt)
}

export function getSecurityKeySessionToken(): string | null {
  const target = storage()
  if (!target) return null

  const token = target.getItem(SECURITY_KEY_TOKEN_KEY)
  const expiresAt = target.getItem(SECURITY_KEY_EXPIRY_KEY)
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN

  if (!token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    clearSecurityKeySession()
    return null
  }

  return token
}

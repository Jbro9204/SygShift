const TRUSTED_DEVICE_STORAGE_KEY = 'sygshift:trusted-device-token:v1'
const TRUSTED_DEVICE_COOKIE_NAME = 'sygshift_trusted_device'
const TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function cookieDomainAttribute(): string {
  if (typeof window === 'undefined') return ''
  const hostname = window.location.hostname.toLowerCase()
  if (hostname === 'sygilant.us' || hostname.endsWith('.sygilant.us')) return '; Domain=.sygilant.us'
  return ''
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix))

  if (!cookie) return null

  try {
    return decodeURIComponent(cookie.slice(prefix.length))
  } catch {
    return null
  }
}

function writeTrustedDeviceCookie(token: string): void {
  if (typeof document === 'undefined') return
  document.cookie = [
    `${TRUSTED_DEVICE_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS}`,
    'Path=/',
    'SameSite=Lax',
    window.location.protocol === 'https:' ? 'Secure' : '',
    cookieDomainAttribute(),
  ].filter(Boolean).join('; ')
}

function clearTrustedDeviceCookie(): void {
  if (typeof document === 'undefined') return
  document.cookie = [
    `${TRUSTED_DEVICE_COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/',
    'SameSite=Lax',
    window.location.protocol === 'https:' ? 'Secure' : '',
    cookieDomainAttribute(),
  ].filter(Boolean).join('; ')
}

export function getTrustedDeviceToken(): string | null {
  return browserStorage()?.getItem(TRUSTED_DEVICE_STORAGE_KEY) ?? readCookie(TRUSTED_DEVICE_COOKIE_NAME)
}

export function setTrustedDeviceToken(token: string): void {
  browserStorage()?.setItem(TRUSTED_DEVICE_STORAGE_KEY, token)
  writeTrustedDeviceCookie(token)
}

export function clearTrustedDeviceToken(): void {
  browserStorage()?.removeItem(TRUSTED_DEVICE_STORAGE_KEY)
  clearTrustedDeviceCookie()
}

export function createTrustedDeviceToken(): string {
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

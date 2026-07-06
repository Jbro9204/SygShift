const TRUSTED_DEVICE_STORAGE_KEY = 'sygshift:trusted-device-token:v1'

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function getTrustedDeviceToken(): string | null {
  return browserStorage()?.getItem(TRUSTED_DEVICE_STORAGE_KEY) ?? null
}

export function setTrustedDeviceToken(token: string): void {
  browserStorage()?.setItem(TRUSTED_DEVICE_STORAGE_KEY, token)
}

export function clearTrustedDeviceToken(): void {
  browserStorage()?.removeItem(TRUSTED_DEVICE_STORAGE_KEY)
}

export function createTrustedDeviceToken(): string {
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

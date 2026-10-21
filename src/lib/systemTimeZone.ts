export const SYSTEM_TIME_ZONE_FALLBACK = 'UTC'

function validTimeZone(value: string | null | undefined): value is string {
  if (typeof Intl === 'undefined' || !value?.trim()) return false

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

export function browserSystemTimeZone(fallback?: string | null): string {
  const safeFallback = validTimeZone(fallback) ? fallback.trim() : SYSTEM_TIME_ZONE_FALLBACK
  if (typeof Intl === 'undefined') return safeFallback

  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
    return validTimeZone(detected) ? detected.trim() : safeFallback
  } catch {
    return safeFallback
  }
}

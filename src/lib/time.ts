export const OPERATIONAL_TIME_ZONE = 'America/Denver'

export function operationalToday(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'numeric',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(now)

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  )

  return new Date(values.year, values.month - 1, values.day, 12)
}

export function formatOperationalDate(now = new Date()): string {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATIONAL_TIME_ZONE,
    weekday: 'long',
  }).format(now)
  const date = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(now)
  return `${weekday}, ${date}`
}

export function formatOperationalTime(now = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    timeZoneName: 'short',
  }).format(now)
}

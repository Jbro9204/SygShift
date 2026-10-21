import { formatTimeZoneClock } from './time'
import { browserSystemTimeZone } from './systemTimeZone'

export function formatSygSphereTimestamp(
  value: Date | string,
  timeZone = browserSystemTimeZone(),
): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (!Number.isFinite(date.valueOf())) return 'Time unavailable'

  try {
    const day = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    }).format(date)
    const display = formatTimeZoneClock(date, timeZone)
    return `${day} · ${display.digitalTime} ${display.abbreviation}`
  } catch {
    return 'Time unavailable'
  }
}

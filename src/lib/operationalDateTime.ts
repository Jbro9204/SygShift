import { OPERATIONAL_TIME_ZONE } from './time'

type DateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedParts(value: Date): DateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(value)
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]),
  )
  return {
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    month: values.month,
    year: values.year,
  }
}

function partsToLocalInput(parts: DateTimeParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

export function toOperationalDateTimeInput(value: Date | string): string {
  return partsToLocalInput(zonedParts(typeof value === 'string' ? new Date(value) : value))
}

export function fromOperationalDateTimeInput(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('Enter a valid Mountain Time date and time.')

  const desired: DateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }
  const desiredAsUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute)
  let candidate = desiredAsUtc

  // Iteratively apply the Denver offset. This stays correct across MST/MDT without
  // depending on the administrator computer's local time zone.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate))
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    candidate += desiredAsUtc - actualAsUtc
  }

  const verified = zonedParts(new Date(candidate))
  if (partsToLocalInput(verified) !== partsToLocalInput(desired)) {
    throw new Error('That Mountain Time does not exist because of daylight saving time. Choose another time.')
  }

  return new Date(candidate).toISOString()
}

export function defaultMaintenanceWindow(now = new Date()): { startsAt: string; endsAt: string } {
  const roundedStart = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * 15 * 60_000)
  const roundedEnd = new Date(roundedStart.getTime() + 60 * 60_000)
  return {
    startsAt: toOperationalDateTimeInput(roundedStart),
    endsAt: toOperationalDateTimeInput(roundedEnd),
  }
}

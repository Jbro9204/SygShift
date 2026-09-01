export const OPERATIONAL_TIME_ZONE = 'America/Denver'

export type TimeZoneClockDisplay = {
  abbreviation: string
  accessibleDate: string
  date: string
  digitalTime: string
  hour24: number
  minute: number
  second: number
}

type TimeZoneClockFormatters = {
  accessibleDate: Intl.DateTimeFormat
  date: Intl.DateTimeFormat
  parts: Intl.DateTimeFormat
  timeZoneName: Intl.DateTimeFormat
}

const timeZoneClockFormatterCache = new Map<string, TimeZoneClockFormatters>()

function getTimeZoneClockFormatters(timeZone: string): TimeZoneClockFormatters {
  const cached = timeZoneClockFormatterCache.get(timeZone)
  if (cached) return cached

  const formatters = {
    accessibleDate: new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'long',
      timeZone,
      weekday: 'long',
      year: 'numeric',
    }),
    date: new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      month: '2-digit',
      timeZone,
      weekday: 'short',
      year: 'numeric',
    }),
    parts: new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      second: '2-digit',
      timeZone,
    }),
    timeZoneName: new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }),
  }
  timeZoneClockFormatterCache.set(timeZone, formatters)
  return formatters
}

function numericTimePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  return Number(parts.find((part) => part.type === type)?.value ?? 0)
}

export function formatTimeZoneClock(value: Date | string, timeZone: string): TimeZoneClockDisplay {
  const dateValue = typeof value === 'string' ? new Date(value) : value
  const formatters = getTimeZoneClockFormatters(timeZone)
  const parts = formatters.parts.formatToParts(dateValue)
  const hour24 = numericTimePart(parts, 'hour')
  const minute = numericTimePart(parts, 'minute')
  const second = numericTimePart(parts, 'second')
  const civilianHour = hour24 % 12 || 12
  const civilian = `${civilianHour}:${String(minute).padStart(2, '0')} ${hour24 >= 12 ? 'PM' : 'AM'}`
  const military = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const showMilitary = hour24 === 0 || hour24 >= 13
  const abbreviation = formatters.timeZoneName
    .formatToParts(dateValue)
    .find((part) => part.type === 'timeZoneName')?.value ?? timeZone

  return {
    abbreviation,
    accessibleDate: formatters.accessibleDate.format(dateValue),
    date: formatters.date.format(dateValue),
    digitalTime: showMilitary ? `${civilian} (${military})` : civilian,
    hour24,
    minute,
    second,
  }
}

export function formatCompactDualTime(
  value: Date | string,
  timeZone = OPERATIONAL_TIME_ZONE,
): string {
  return formatTimeZoneClock(value, timeZone).digitalTime
}

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

export function formatOperationalDate(now = new Date(), timeZone = OPERATIONAL_TIME_ZONE): string {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
  }).format(now)
  const date = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(now)
  return `${weekday}, ${date}`
}

export function formatOperationalTime(now = new Date()): string {
  return formatDualTime(now, { includeTimeZoneName: true })
}

export function formatDualTime(
  value: Date | string,
  {
    includeTimeZoneName = false,
    timeZone = OPERATIONAL_TIME_ZONE,
  }: {
    includeTimeZoneName?: boolean
    timeZone?: string
  } = {},
): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const civilian = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date)
  const military = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone,
  }).format(date)

  if (!includeTimeZoneName) return `${civilian} (${military})`

  const timeZoneName = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value

  return `${civilian} (${military})${timeZoneName ? ` ${timeZoneName}` : ''}`
}

export function formatDualTimeRange(
  startsAt: Date | string,
  endsAt: Date | string,
  timeZone = OPERATIONAL_TIME_ZONE,
): string {
  return `${formatDualTime(startsAt, { timeZone })} – ${formatDualTime(endsAt, { timeZone })}`
}

export function formatDualClockTime(value: string | null): string {
  if (!value) return 'All day'
  const [hoursText, minutesText = '00'] = value.split(':')
  const hours = Number(hoursText)
  const minutes = Number(minutesText)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return value

  const civilianHour = hours % 12 || 12
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const military = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  return `${civilianHour}:${String(minutes).padStart(2, '0')} ${suffix} (${military})`
}

export function formatOperationalDateTime(
  value: Date | string,
  {
    includeTimeZoneName = false,
    timeZone = OPERATIONAL_TIME_ZONE,
  }: {
    includeTimeZoneName?: boolean
    timeZone?: string
  } = {},
): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const day = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date)
  return `${day}, ${formatDualTime(date, { includeTimeZoneName, timeZone })}`
}

export function formatLegacyOperationalTime(now = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    timeZoneName: 'short',
  }).format(now)
}

function addOperationalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12)
}

function formatUsDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date)
}

export function lastCompletedPayrollWeek(now = new Date()): {
  fromDate: Date
  fromLabel: string
  throughDate: Date
  throughLabel: string
} {
  const today = operationalToday(now)
  const dayOfWeek = today.getDay()
  const daysSinceCompletedSaturday = dayOfWeek === 6 ? 7 : (dayOfWeek - 6 + 7) % 7
  const throughDate = addOperationalDays(today, -daysSinceCompletedSaturday)
  const fromDate = addOperationalDays(throughDate, -6)

  return {
    fromDate,
    fromLabel: formatUsDate(fromDate),
    throughDate,
    throughLabel: formatUsDate(throughDate),
  }
}

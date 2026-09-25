import { formatDualTime } from '../lib/time'
import { continentalUsTimeZoneShortLabel } from '../lib/usTimeZones'

export type ScheduleTimeZoneSource = 'site' | 'employee' | 'explicit'

export interface ScheduleWallClockRange {
  endsAt: string
  startsAt: string
}

type LocalDateTimeParts = {
  day: number
  hour: number
  minute: number
  month: number
  year: number
}

function parseDateKey(dateKey: string): { day: number, month: number, year: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) throw new Error('Choose a complete shift date.')

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
}

function parseTimeValue(timeValue: string): { hour: number, minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue)
  if (!match) throw new Error('Choose a complete shift time.')

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error('Choose a valid shift time.')
  return { hour, minute }
}

function dateKeyWithDayOffset(dateKey: string, dayOffset: number): string {
  const { day, month, year } = parseDateKey(dateKey)
  const date = new Date(Date.UTC(year, month - 1, day + dayOffset))
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function zonedParts(value: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(value)
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )

  return {
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    month: values.month,
    year: values.year,
  }
}

function sameLocalDateTime(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
}

export function scheduleWallClockToInstant(dateKey: string, timeValue: string, timeZone: string): string {
  const date = parseDateKey(dateKey)
  const time = parseTimeValue(timeValue)
  const desired: LocalDateTimeParts = { ...date, ...time }
  const desiredAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute)
  let candidate = desiredAsUtc

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone)
    const representedAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    const correction = desiredAsUtc - representedAsUtc
    if (correction === 0) break
    candidate += correction
  }

  if (!sameLocalDateTime(zonedParts(new Date(candidate), timeZone), desired)) {
    throw new Error('That local time does not exist in the selected time zone because of daylight-saving time. Choose another time.')
  }

  return new Date(candidate).toISOString()
}

export function scheduleWallClockRangeToInstants(
  dateKey: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): ScheduleWallClockRange {
  const startMinutes = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3, 5))
  const endMinutes = Number(endTime.slice(0, 2)) * 60 + Number(endTime.slice(3, 5))
  const endDateKey = dateKeyWithDayOffset(dateKey, endMinutes <= startMinutes ? 1 : 0)
  const startsAt = scheduleWallClockToInstant(dateKey, startTime, timeZone)
  const endsAt = scheduleWallClockToInstant(endDateKey, endTime, timeZone)

  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('Shift end must be after shift start.')
  }

  return { startsAt, endsAt }
}

export function scheduleTimeBasisLabel(source: ScheduleTimeZoneSource | null | undefined, timeZone: string): string {
  const prefix = source === 'employee'
    ? 'Employee Time'
    : source === 'site'
      ? 'Site Time'
      : 'Recorded Time'
  return `${prefix} — ${continentalUsTimeZoneShortLabel(timeZone)}`
}

export function formatScheduleTimeZoneRange(startsAt: string, endsAt: string, timeZone: string): string {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  })
  const startDate = dateFormatter.format(new Date(startsAt))
  const endDate = dateFormatter.format(new Date(endsAt))
  const start = formatDualTime(startsAt, { timeZone })
  const end = formatDualTime(endsAt, { timeZone })
  return startDate === endDate
    ? `${startDate} · ${start}–${end}`
    : `${startDate} ${start} – ${endDate} ${end}`
}

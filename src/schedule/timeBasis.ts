import { formatDualTime } from '../lib/time'
import { continentalUsTimeZoneShortLabel } from '../lib/usTimeZones'

export type ScheduleTimeZoneSource = 'site' | 'employee' | 'explicit'

export interface ScheduleWallClockRange {
  endsAt: string
  startsAt: string
}

export interface ScheduleWallClockDateRange extends ScheduleWallClockRange {
  dateKey: string
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

export function scheduleCalendarDateInTimeZone(instant: Date | string, timeZone: string): Date {
  const parsed = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(parsed.getTime())) throw new Error('The trusted schedule time is invalid.')

  const parts = zonedParts(parsed, timeZone)
  return new Date(parts.year, parts.month - 1, parts.day, 12)
}

export function scheduleWallClockToInstant(dateKey: string, timeValue: string, timeZone: string): string {
  const date = parseDateKey(dateKey)
  const time = parseTimeValue(timeValue)
  const desired: LocalDateTimeParts = { ...date, ...time }
  const desiredAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute)
  const possibleOffsets = new Set<number>()

  // Sample both sides of the requested local date so a daylight-saving
  // transition contributes both of its possible UTC offsets. Deriving
  // candidates from offsets keeps this fast while still supporting IANA
  // zones whose offsets are not whole hours.
  for (let sampleHours = -48; sampleHours <= 48; sampleHours += 6) {
    const sample = desiredAsUtc + sampleHours * 60 * 60 * 1_000
    const represented = zonedParts(new Date(sample), timeZone)
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
    )
    possibleOffsets.add(representedAsUtc - sample)
  }

  const candidates = Array.from(possibleOffsets)
    .map((offset) => desiredAsUtc - offset)
    .filter((candidate) => sameLocalDateTime(zonedParts(new Date(candidate), timeZone), desired))

  if (candidates.length === 0) {
    throw new Error('That local time does not exist in the selected time zone because of daylight-saving time. Choose another time.')
  }

  // PostgreSQL's `timestamp AT TIME ZONE` selects the standard-time (later)
  // occurrence when the wall clock repeats during the fall-back transition.
  // Choosing the latest matching instant keeps the preview and saved value
  // identical instead of allowing a silent one-hour shift at publication.
  return new Date(Math.max(...candidates)).toISOString()
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

export function scheduleWallClockRangesForDates(
  dateKeys: string[],
  startTime: string,
  endTime: string,
  timeZone: string,
): ScheduleWallClockDateRange[] {
  return dateKeys.map((dateKey) => {
    try {
      return { dateKey, ...scheduleWallClockRangeToInstants(dateKey, startTime, endTime, timeZone) }
    } catch (error) {
      const { day, month, year } = parseDateKey(dateKey)
      const reason = error instanceof Error ? error.message : 'The shift time could not be converted.'
      throw new Error(`${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}: ${reason}`)
    }
  })
}

export async function runAfterScheduleWallClockPreflight<T>(
  dateKeys: string[],
  startTime: string,
  endTime: string,
  timeZone: string,
  operation: (validatedDateKeys: string[]) => Promise<T>,
): Promise<T> {
  const ranges = scheduleWallClockRangesForDates(dateKeys, startTime, endTime, timeZone)
  return operation(ranges.map((range) => range.dateKey))
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

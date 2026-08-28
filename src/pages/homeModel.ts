import type { AppRole } from '../data/session'
import type { ScheduleShift } from '../data/schedule'

export type HomeMode = 'employee' | 'operations'

export interface TodayCoverageSummary {
  assigned: number
  open: number
  required: number
  shifts: ScheduleShift[]
}

export function homeModeForRole(role: AppRole | null | undefined): HomeMode {
  return role === 'admin' || role === 'supervisor' ? 'operations' : 'employee'
}

export function greetingPeriod(date: Date, timeZone = 'America/Denver'): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).format(date))
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

export function greetingName(displayName: string | null | undefined, username: string | null | undefined): string {
  const cleanDisplayName = displayName?.trim()
  if (cleanDisplayName) return cleanDisplayName.split(/\s+/)[0]
  const cleanUsername = username?.trim()
  return cleanUsername || 'there'
}

export function boundedHomeItems<T>(items: readonly T[] | null | undefined, limit = 3): T[] {
  return [...(items ?? [])].slice(0, Math.max(0, limit))
}

export function dateKeyInTimeZone(date: Date, timeZone = 'America/Denver'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function sundayWeekStart(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) throw new Error('Enter a valid date in YYYY-MM-DD format.')

  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  return date.toISOString().slice(0, 10)
}

export function summarizeTodayCoverage(
  shifts: readonly ScheduleShift[] | null | undefined,
  todayKey: string,
): TodayCoverageSummary {
  const todayShifts = (shifts ?? []).filter((shift) => dateKeyInTimeZone(new Date(shift.starts_at), shift.time_zone) === todayKey)
  const assigned = todayShifts.reduce((total, shift) => total + shift.assignments.length, 0)
  const required = todayShifts.reduce((total, shift) => total + shift.headcount_required, 0)
  return {
    assigned,
    open: Math.max(0, required - assigned),
    required,
    shifts: todayShifts,
  }
}

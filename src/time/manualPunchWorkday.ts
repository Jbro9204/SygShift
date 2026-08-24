import type { TimeEventKind, TimeMaintenanceShiftOption } from '../data/timekeeping'

export type ManualPunchTimestamp = {
  date: string
  time: string
}

function datePart(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(new Date(value))
}

function timePart(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone,
  }).formatToParts(new Date(value))
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

export function recommendedManualPunchTimestamp(
  option: TimeMaintenanceShiftOption,
  kind: TimeEventKind,
): ManualPunchTimestamp | null {
  const boundary = kind === 'clock_in'
    ? option.startsAt
    : kind === 'clock_out'
      ? option.endsAt
      : null

  if (!boundary) return null
  return {
    date: datePart(boundary, option.timeZone),
    time: timePart(boundary, option.timeZone),
  }
}

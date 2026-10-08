export const PAYROLL_BATCH_POLICY_VERSION = 'payroll-batch-v2'

export interface PayrollBoundaryConfig {
  timeZone: string
  weekStartsOn: number
  weekStartMinutes: number
}

export interface PayrollOccurrenceInput {
  employeeId: string
  shiftId?: string | null
  scheduledStart?: string | null
  scheduledEnd?: string | null
  manualClockIn?: string | null
  actualClockIn?: string | null
  actualClockOut?: string | null
  replacementAssignment?: boolean
  manualEntry?: boolean
  locked?: boolean
  lockedWeekStartsOn?: string | null
}

export type PayrollAssignmentSource =
  | 'scheduled_shift'
  | 'replacement_assignment'
  | 'manual_linked_shift'
  | 'manual_entry'
  | 'unscheduled_actual_punch'
  | 'unresolved'

export interface PayrollOccurrenceAssignment {
  source: PayrollAssignmentSource
  anchor: string | null
  weekStartsOn: string | null
  weekEndsOn: string | null
  crossesPayrollBoundary: boolean
  locked: boolean
  reviewReason: string | null
}

export interface PayrollIntervalAllocation {
  minutes: number
  weekEndsOn: string
  weekStartsOn: string
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function localParts(instant: string, timeZone: string): LocalParts {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${instant}`)
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { day: value('day'), hour: value('hour'), minute: value('minute'), month: value('month'), year: value('year') }
}

function dateKeyFromUtc(date: Date): string {
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`
}

function zonedLocalDateTimeToInstant(dateKey: string, minutesSinceMidnight: number, timeZone: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  const hour = Math.floor(minutesSinceMidnight / 60)
  const minute = minutesSinceMidnight % 60
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute)
  let guess = targetUtc

  for (let index = 0; index < 4; index += 1) {
    const rendered = localParts(new Date(guess).toISOString(), timeZone)
    const renderedUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute)
    guess += targetUtc - renderedUtc
  }

  return guess
}

export function payrollDateRangeInstants(
  fromDate: string,
  throughDate: string,
  timeZone: string,
): { endsAtExclusive: string; startsAt: string } {
  const startsAt = zonedLocalDateTimeToInstant(fromDate, 0, timeZone)
  const endsAtExclusive = zonedLocalDateTimeToInstant(shiftDateKey(throughDate, 1), 0, timeZone)
  if (endsAtExclusive <= startsAt) throw new Error('Payroll date range must end on or after it starts.')
  return {
    endsAtExclusive: new Date(endsAtExclusive).toISOString(),
    startsAt: new Date(startsAt).toISOString(),
  }
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return dateKeyFromUtc(new Date(Date.UTC(year, month - 1, day + days)))
}

export function getPayrollBatchWeek(anchor: string, config: PayrollBoundaryConfig): Pick<PayrollOccurrenceAssignment, 'weekStartsOn' | 'weekEndsOn'> {
  if (config.weekStartsOn < 0 || config.weekStartsOn > 6) throw new Error('Payroll week start must be between Sunday (0) and Saturday (6).')
  const parts = localParts(anchor, config.timeZone)
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const minutesSinceMidnight = parts.hour * 60 + parts.minute
  let daysSinceStart = (localDate.getUTCDay() - config.weekStartsOn + 7) % 7
  if (daysSinceStart === 0 && minutesSinceMidnight < config.weekStartMinutes) daysSinceStart = 7
  const weekStartsOn = dateKeyFromUtc(new Date(localDate.getTime() - daysSinceStart * 86_400_000))
  return { weekEndsOn: shiftDateKey(weekStartsOn, 6), weekStartsOn }
}

export function resolvePayrollOccurrenceAssignment(
  input: PayrollOccurrenceInput,
  config: PayrollBoundaryConfig,
): PayrollOccurrenceAssignment {
  if (input.locked && input.lockedWeekStartsOn) {
    return {
      anchor: input.scheduledStart ?? input.manualClockIn ?? input.actualClockIn ?? null,
      crossesPayrollBoundary: false,
      locked: true,
      reviewReason: null,
      source: input.shiftId ? 'scheduled_shift' : input.manualEntry ? 'manual_entry' : 'unscheduled_actual_punch',
      weekEndsOn: shiftDateKey(input.lockedWeekStartsOn, 6),
      weekStartsOn: input.lockedWeekStartsOn,
    }
  }

  let source: PayrollAssignmentSource = 'unresolved'
  let anchor: string | null = null
  if (input.shiftId && input.scheduledStart) {
    anchor = input.scheduledStart
    source = input.manualEntry
      ? 'manual_linked_shift'
      : input.replacementAssignment
        ? 'replacement_assignment'
        : 'scheduled_shift'
  } else if (input.manualEntry && input.manualClockIn) {
    anchor = input.manualClockIn
    source = 'manual_entry'
  } else if (input.actualClockIn) {
    anchor = input.actualClockIn
    source = 'unscheduled_actual_punch'
  }

  if (!anchor) {
    return {
      anchor: null,
      crossesPayrollBoundary: false,
      locked: false,
      reviewReason: 'No scheduled shift start, manual clock-in, or actual clock-in is available.',
      source: 'unresolved',
      weekEndsOn: null,
      weekStartsOn: null,
    }
  }

  const assignedWeek = getPayrollBatchWeek(anchor, config)
  const occurrenceEnd = input.actualClockOut ?? input.scheduledEnd
  const endWeek = occurrenceEnd ? getPayrollBatchWeek(new Date(new Date(occurrenceEnd).getTime() - 1).toISOString(), config) : assignedWeek
  return {
    anchor,
    crossesPayrollBoundary: assignedWeek.weekStartsOn !== endWeek.weekStartsOn,
    locked: false,
    reviewReason: null,
    source,
    ...assignedWeek,
  }
}

export function elapsedMinutes(startsAt: string, endsAt: string): number {
  const milliseconds = new Date(endsAt).getTime() - new Date(startsAt).getTime()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Worked interval must have a valid end after its start.')
  return Math.round(milliseconds / 60_000)
}

export function allocateIntervalByPayrollWeek(
  startsAt: string,
  endsAt: string,
  config: PayrollBoundaryConfig,
): PayrollIntervalAllocation[] {
  const start = new Date(startsAt).getTime()
  const end = new Date(endsAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error('Payroll interval must have a valid end after its start.')
  }
  if (start === end) return []
  if (config.weekStartMinutes < 0 || config.weekStartMinutes >= 1_440) {
    throw new Error('Payroll week start time must be within one local day.')
  }

  const rawAllocations: Array<PayrollIntervalAllocation & { milliseconds: number }> = []
  let cursor = start
  while (cursor < end) {
    const week = getPayrollBatchWeek(new Date(cursor).toISOString(), config)
    const nextWeekStart = shiftDateKey(week.weekStartsOn!, 7)
    const nextBoundary = zonedLocalDateTimeToInstant(nextWeekStart, config.weekStartMinutes, config.timeZone)
    if (nextBoundary <= cursor) throw new Error('Payroll week boundary did not advance.')
    const segmentEnd = Math.min(end, nextBoundary)
    rawAllocations.push({
      milliseconds: segmentEnd - cursor,
      minutes: 0,
      weekEndsOn: week.weekEndsOn!,
      weekStartsOn: week.weekStartsOn!,
    })
    cursor = segmentEnd
  }

  const totalMinutes = Math.round((end - start) / 60_000)
  const floorTotal = rawAllocations.reduce(
    (total, allocation) => total + Math.floor(allocation.milliseconds / 60_000),
    0,
  )
  const remainderWinners = new Set(rawAllocations
    .map((allocation, index) => ({
      index,
      remainder: allocation.milliseconds % 60_000,
    }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .slice(0, Math.max(0, totalMinutes - floorTotal))
    .map(({ index }) => index))

  return rawAllocations.map((allocation, index) => {
    const minutes = Math.floor(allocation.milliseconds / 60_000) + (remainderWinners.has(index) ? 1 : 0)
    return {
      minutes,
      weekEndsOn: allocation.weekEndsOn,
      weekStartsOn: allocation.weekStartsOn,
    }
  })
}

export function reconcilePayrollMinutes(input: {
  paidMinutes: number
  regularMinutes: number
  overtimeMinutes: number
  occurrenceKeys: string[]
}): { passed: boolean; duplicateOccurrenceKeys: string[] } {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const key of input.occurrenceKeys) {
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return {
    duplicateOccurrenceKeys: [...duplicates],
    passed: duplicates.size === 0 && input.paidMinutes === input.regularMinutes + input.overtimeMinutes,
  }
}

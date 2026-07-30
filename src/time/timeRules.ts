import type { PayrollRules } from '../data/timekeeping'
import { OPERATIONAL_TIME_ZONE, operationalToday } from '../lib/time'

export const DEFAULT_TIME_RULES = {
  dailyOvertimeMinutes: 720,
  defaultBreakMinutes: 30,
  payDateAnchor: '2026-07-31',
  payFrequency: 'biweekly',
  salaryWeeklyDefaultMinutes: 2400,
  salaryTimeOffReducesDefault: true,
  timeZone: OPERATIONAL_TIME_ZONE,
  unpaidBreaks: true,
  weeklyOvertimeMinutes: 2400,
  weekStartsOn: 0,
  weekStartsOnLabel: 'Sunday',
} as const

export const TIME_RISK_THRESHOLDS = {
  dailyApproachingOvertimeMinutes: 630,
  weeklyApproachingOvertimeMinutes: 2160,
} as const

export interface TimePeriod {
  daysRemaining: number
  fromDate: string
  status: 'open' | 'under review' | 'approved' | 'locked' | 'exported'
  throughDate: string
}

type PeriodRuleInput = Pick<PayrollRules, 'payDateAnchor' | 'payFrequency' | 'weekStartsOn'>

export function dateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(date)
}

export function formatUsDateKey(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12)
}

function parseDateKey(value: string): Date {
  const [yearText, monthText, dayText] = value.split('-')
  return new Date(Number(yearText), Number(monthText) - 1, Number(dayText), 12)
}

function daysBetween(left: Date, right: Date): number {
  return Math.floor((left.getTime() - right.getTime()) / 86_400_000)
}

function periodLengthDays(rules?: Partial<Pick<PayrollRules, 'payFrequency'>>): number {
  return rules?.payFrequency === 'biweekly' ? 14 : 7
}

function periodFromStart(startDate: Date, lengthDays: number, status: TimePeriod['status'] = 'open', now = new Date()): TimePeriod {
  const today = operationalToday(now)
  const throughDate = addDays(startDate, lengthDays - 1)
  const daysRemaining = Math.max(0, Math.ceil((throughDate.getTime() - today.getTime()) / 86_400_000))

  return {
    daysRemaining,
    fromDate: dateKey(startDate),
    status,
    throughDate: dateKey(throughDate),
  }
}

function anchoredPeriodForDate(now: Date, rules: PeriodRuleInput): TimePeriod {
  const today = operationalToday(now)
  const lengthDays = periodLengthDays(rules)
  const payDate = parseDateKey(rules.payDateAnchor)
  const periodEndDay = ((rules.weekStartsOn ?? DEFAULT_TIME_RULES.weekStartsOn) + 6) % 7
  const daysSincePeriodEnd = (payDate.getDay() - periodEndDay + 7) % 7
  const anchorPeriodEnd = addDays(payDate, -daysSincePeriodEnd)
  const anchorPeriodStart = addDays(anchorPeriodEnd, -(lengthDays - 1))
  const periodOffset = Math.floor(daysBetween(today, anchorPeriodStart) / lengthDays)
  const periodStart = addDays(anchorPeriodStart, periodOffset * lengthDays)

  return periodFromStart(periodStart, lengthDays, 'open', now)
}

export function currentPayrollPeriod(now = new Date(), rules?: Partial<PeriodRuleInput>): TimePeriod {
  if (rules?.payDateAnchor) return anchoredPeriodForDate(now, {
    payDateAnchor: rules.payDateAnchor,
    payFrequency: rules.payFrequency ?? DEFAULT_TIME_RULES.payFrequency,
    weekStartsOn: rules.weekStartsOn ?? DEFAULT_TIME_RULES.weekStartsOn,
  })

  const today = operationalToday(now)
  const weekStartsOn = rules?.weekStartsOn ?? DEFAULT_TIME_RULES.weekStartsOn
  const dayOffset = (today.getDay() - weekStartsOn + 7) % 7
  const weekStart = addDays(today, -dayOffset)
  return periodFromStart(weekStart, periodLengthDays(rules), 'open', now)
}

export function shiftPayrollPeriod(period: Pick<TimePeriod, 'fromDate'>, offsetPeriods: number, rules?: Partial<PeriodRuleInput>): TimePeriod {
  const lengthDays = periodLengthDays(rules)
  const start = addDays(parseDateKey(period.fromDate), offsetPeriods * lengthDays)
  return periodFromStart(start, lengthDays)
}

export function completedPayrollPeriod(now = new Date(), rules?: Partial<PeriodRuleInput>): TimePeriod {
  return shiftPayrollPeriod(currentPayrollPeriod(now, rules), -1, rules)
}

export function minutesToHours(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

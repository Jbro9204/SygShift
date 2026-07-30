import type { PayrollRules } from '../data/timekeeping'
import { OPERATIONAL_TIME_ZONE, operationalToday } from '../lib/time'

export const DEFAULT_TIME_RULES = {
  dailyOvertimeMinutes: 720,
  defaultBreakMinutes: 30,
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

export function currentPayrollPeriod(now = new Date(), rules?: Pick<PayrollRules, 'payFrequency' | 'weekStartsOn'>): TimePeriod {
  const today = operationalToday(now)
  const weekStartsOn = rules?.weekStartsOn ?? DEFAULT_TIME_RULES.weekStartsOn
  const dayOffset = (today.getDay() - weekStartsOn + 7) % 7
  const weekStart = addDays(today, -dayOffset)
  const periodLengthDays = rules?.payFrequency === 'biweekly' ? 14 : 7
  const periodEnd = addDays(weekStart, periodLengthDays - 1)
  const daysRemaining = Math.max(0, Math.ceil((periodEnd.getTime() - today.getTime()) / 86_400_000))

  return {
    daysRemaining,
    fromDate: dateKey(weekStart),
    status: 'open',
    throughDate: dateKey(periodEnd),
  }
}

export function minutesToHours(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

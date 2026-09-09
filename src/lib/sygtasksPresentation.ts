import type { SygTask } from '../data/sygtasks'
import { formatOperationalDateTime, OPERATIONAL_TIME_ZONE } from './time'

function operationalDateKey(value: Date | string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(typeof value === 'string' ? new Date(value) : value)
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

export function formatTaskDue(value: string | null) {
  if (!value) return 'No due date'
  const due = new Date(value)
  if (Number.isNaN(due.valueOf())) return 'No due date'
  return formatOperationalDateTime(due, { includeTimeZoneName: true })
}

export function taskDueState(task: SygTask, reference: Date | string = new Date()): 'none' | 'overdue' | 'today' | 'upcoming' {
  if (!task.dueAt || task.status === 'done' || task.status === 'canceled') return 'none'
  const due = new Date(task.dueAt)
  const referenceDate = typeof reference === 'string' ? new Date(reference) : reference
  if (Number.isNaN(due.valueOf()) || Number.isNaN(referenceDate.valueOf())) return 'none'
  const todayKey = operationalDateKey(referenceDate)
  const dueKey = operationalDateKey(due)
  if (due.valueOf() < referenceDate.valueOf()) return 'overdue'
  if (dueKey === todayKey) return 'today'
  return 'upcoming'
}

export function employeeInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

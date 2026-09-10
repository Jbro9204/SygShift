import {
  formatSygTaskPriority,
  formatSygTaskStatus,
  sygTaskPriorities,
  sygTaskStatuses,
  type SygTaskActivityEvent,
  type SygTaskPriority,
  type SygTaskStatus,
} from '../data/sygtasks'
import { formatOperationalDateTime } from './time'

export type SygTaskActivityChange = {
  label: string
  before: string
  after: string
  long: boolean
}

export type SygTaskActivityPresentation = {
  summary: string
  context: string | null
  changes: SygTaskActivityChange[]
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function valueAt(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key]
  }
  return undefined
}

function readableValue(value: unknown, kind: 'plain' | 'status' | 'priority' | 'date' = 'plain'): string {
  if (value === null || value === undefined || value === '') return 'Not set'
  if (kind === 'status' && typeof value === 'string' && sygTaskStatuses.includes(value as SygTaskStatus)) {
    return formatSygTaskStatus(value as SygTaskStatus)
  }
  if (kind === 'priority' && typeof value === 'string' && sygTaskPriorities.includes(value as SygTaskPriority)) {
    return formatSygTaskPriority(value as SygTaskPriority)
  }
  if (kind === 'date' && (typeof value === 'string' || value instanceof Date)) {
    const date = new Date(value)
    return Number.isNaN(date.valueOf()) ? String(value) : formatOperationalDateTime(date, { includeTimeZoneName: true })
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function change(
  before: JsonRecord,
  after: JsonRecord,
  label: string,
  keys: string[],
  kind: 'plain' | 'status' | 'priority' | 'date' = 'plain',
): SygTaskActivityChange | null {
  const previous = valueAt(before, ...keys)
  const next = valueAt(after, ...keys)
  if (JSON.stringify(previous ?? null) === JSON.stringify(next ?? null)) return null
  const beforeText = readableValue(previous, kind)
  const afterText = readableValue(next, kind)
  return { label, before: beforeText, after: afterText, long: beforeText.length > 90 || afterText.length > 90 || /[\r\n]/.test(`${beforeText}${afterText}`) }
}

function compactChanges(items: Array<SygTaskActivityChange | null>) {
  return items.filter((item): item is SygTaskActivityChange => Boolean(item))
}

function checklistTitle(before: JsonRecord, after: JsonRecord) {
  return readableValue(valueAt(after, 'title') ?? valueAt(before, 'title'))
}

function humanizeAction(action: string) {
  const value = action.replace(/[._]+/g, ' ').trim()
  return value ? value[0].toLowerCase() + value.slice(1) : 'updated this task'
}

export function formatSygTaskActivityMoment(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : formatOperationalDateTime(date, { includeTimeZoneName: true })
}

export function presentSygTaskActivity(event: SygTaskActivityEvent): SygTaskActivityPresentation {
  const details = asRecord(event.details)
  const before = asRecord(details.before)
  const after = asRecord(details.after)
  const subjectName = event.subject?.name ?? 'an employee'
  const labelName = event.label?.name ?? 'a label'
  const relatedTaskTitle = event.relatedTask?.title ?? 'another task'

  switch (event.action) {
    case 'task.created': {
      const changes = compactChanges([
        change({}, after, 'Title', ['title']),
        change({}, after, 'Description', ['description']),
        change({}, after, 'Status', ['status'], 'status'),
        change({}, after, 'Priority', ['priority'], 'priority'),
        change({}, after, 'Due date', ['due_at', 'dueAt'], 'date'),
      ]).filter((item) => item.after !== 'Not set')
      return { summary: 'created this task', context: 'Initial task settings', changes }
    }
    case 'task.updated': {
      const changes = compactChanges([
        change(before, after, 'Title', ['title']),
        change(before, after, 'Description', ['description']),
        change(before, after, 'Status', ['status'], 'status'),
        change(before, after, 'Priority', ['priority'], 'priority'),
        change(before, after, 'Due date', ['due_at', 'dueAt'], 'date'),
        change(before, after, 'Position', ['sort_rank', 'sortRank']),
      ])
      const only = changes.length === 1 ? changes[0]?.label.toLowerCase() : null
      return {
        summary: only ? `changed the ${only}` : `updated ${changes.length || 'the'} task detail${changes.length === 1 ? '' : 's'}`,
        context: changes.length ? `${changes.length} recorded change${changes.length === 1 ? '' : 's'}` : null,
        changes,
      }
    }
    case 'task.archived':
      return { summary: 'archived this task', context: 'The complete task history remains available', changes: [] }
    case 'assignee.added':
      return { summary: `assigned ${subjectName}`, context: event.subject?.username ? `@${event.subject.username}` : null, changes: [] }
    case 'assignee.removed':
      return { summary: `removed ${subjectName} from this task`, context: event.subject?.username ? `@${event.subject.username}` : null, changes: [] }
    case 'watcher.added':
      return { summary: event.subject?.employeeId === event.actorId ? 'started following this task' : `added ${subjectName} as a follower`, context: null, changes: [] }
    case 'watcher.removed':
      return { summary: event.subject?.employeeId === event.actorId ? 'stopped following this task' : `removed ${subjectName} as a follower`, context: null, changes: [] }
    case 'task_label.added':
      return { summary: `added the ${labelName} label`, context: null, changes: [] }
    case 'task_label.removed':
      return { summary: `removed the ${labelName} label`, context: null, changes: [] }
    case 'checklist.added':
      return { summary: `added checklist item “${checklistTitle(before, after)}”`, context: null, changes: [] }
    case 'checklist.updated': {
      const completed = change(before, after, 'Completion', ['completed_at', 'completedAt'], 'date')
      const title = change(before, after, 'Checklist item', ['title'])
      const completedBefore = valueAt(before, 'completed_at', 'completedAt')
      const completedAfter = valueAt(after, 'completed_at', 'completedAt')
      const summary = !completedBefore && completedAfter
        ? `completed “${checklistTitle(before, after)}”`
        : completedBefore && !completedAfter
          ? `reopened “${checklistTitle(before, after)}”`
          : title
            ? `renamed checklist item “${title.before}”`
            : `updated checklist item “${checklistTitle(before, after)}”`
      return { summary, context: null, changes: compactChanges([title, completed]) }
    }
    case 'checklist.archived':
      return { summary: `removed checklist item “${checklistTitle(before, after)}”`, context: null, changes: [] }
    case 'comment.added':
      return { summary: 'added a comment', context: null, changes: [{ label: 'Comment', before: 'Not set', after: readableValue(valueAt(after, 'body')), long: true }] }
    case 'comment.edited':
      return { summary: 'edited a comment', context: null, changes: compactChanges([change(before, after, 'Comment', ['body'])]) }
    case 'comment.archived':
      return { summary: 'removed a comment', context: null, changes: [{ label: 'Removed comment', before: readableValue(valueAt(before, 'body')), after: 'Removed', long: true }] }
    case 'dependency.added':
      return { summary: `added dependency “${relatedTaskTitle}”`, context: 'This task depends on the related task', changes: [] }
    case 'dependency.removed':
      return { summary: `removed dependency “${relatedTaskTitle}”`, context: null, changes: [] }
    case 'reminder.created': {
      const kind = details.kind === 'alarm' ? 'alarm' : 'reminder'
      const scope = details.recipientScope === 'assignees' ? 'all current assignees' : 'the creator'
      const timing = details.timingKind === 'relative'
        ? `${readableValue(details.offsetMinutes)} minutes before the due time`
        : readableValue(details.absoluteAt, 'date')
      return {
        summary: `scheduled ${kind === 'alarm' ? 'an alarm' : 'a reminder'}`,
        context: `${timing} · For ${scope}`,
        changes: [
          { label: 'Alert type', before: 'Not set', after: kind === 'alarm' ? 'Repeating alarm' : 'One-time reminder', long: false },
          { label: 'Recipients', before: 'Not set', after: scope, long: false },
          { label: 'Delivery time', before: 'Not set', after: timing, long: false },
          { label: 'Email copy', before: 'Not set', after: readableValue(details.emailEnabled), long: false },
        ],
      }
    }
    case 'reminder.cancelled':
      return { summary: 'cancelled a task reminder', context: null, changes: [] }
    case 'alarm.snooze':
      return { summary: `snoozed the task alarm for ${readableValue(details.snoozeMinutes)} minutes`, context: null, changes: [] }
    case 'alarm.acknowledge':
      return { summary: 'turned off the task alarm', context: null, changes: [] }
    default:
      return { summary: humanizeAction(event.action), context: `Recorded ${event.entityType} activity`, changes: [] }
  }
}

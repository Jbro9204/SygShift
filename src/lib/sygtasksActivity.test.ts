import { describe, expect, it } from 'vitest'
import type { SygTaskActivityEvent } from '../data/sygtasks'
import { presentSygTaskActivity } from './sygtasksActivity'

const event: SygTaskActivityEvent = {
  id: 18,
  action: 'task.updated',
  entityType: 'task',
  entityId: '44444444-4444-4444-8444-444444444444',
  details: {},
  actorId: '11111111-1111-4111-8111-111111111111',
  actorName: 'Jordan Brown',
  actorSource: 'employee',
  createdAt: '2026-09-10T16:35:00.000Z',
  subject: null,
  label: null,
  relatedTask: null,
}

describe('SygTasks activity presentation', () => {
  it('lists each changed task field with readable previous and new values', () => {
    const result = presentSygTaskActivity({
      ...event,
      details: {
        before: { status: 'ready', priority: 'routine', due_at: null, description: 'Call the client.' },
        after: { status: 'in_progress', priority: 'high', due_at: '2026-09-11T18:00:00.000Z', description: 'Call the client.\nConfirm coverage.' },
      },
    })

    expect(result.summary).toBe('updated 4 task details')
    expect(result.changes.map((item) => item.label)).toEqual(['Description', 'Status', 'Priority', 'Due date'])
    expect(result.changes.find((item) => item.label === 'Status')).toMatchObject({ before: 'Ready', after: 'In progress' })
    expect(result.changes.find((item) => item.label === 'Description')?.long).toBe(true)
    expect(result.changes.find((item) => item.label === 'Due date')?.after).toContain('MDT')
  })

  it('uses enriched employee names for assignment history', () => {
    const result = presentSygTaskActivity({
      ...event,
      action: 'assignee.added',
      details: { employeeId: '22222222-2222-4222-8222-222222222222' },
      subject: { employeeId: '22222222-2222-4222-8222-222222222222', name: 'Michelle Hood', username: 'mhood' },
    })

    expect(result).toMatchObject({ summary: 'assigned Michelle Hood', context: '@mhood' })
  })

  it('distinguishes checklist completion from a rename', () => {
    const result = presentSygTaskActivity({
      ...event,
      action: 'checklist.updated',
      entityType: 'checklist',
      details: {
        before: { title: 'Contact client', completed_at: null },
        after: { title: 'Contact client', completed_at: '2026-09-10T16:35:00.000Z' },
      },
    })

    expect(result.summary).toBe('completed “Contact client”')
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]?.label).toBe('Completion')
  })

  it('describes reminder timing, recipients, and delivery', () => {
    const result = presentSygTaskActivity({
      ...event,
      action: 'reminder.created',
      details: {
        kind: 'alarm', recipientScope: 'assignees', timingKind: 'relative', offsetMinutes: 30, emailEnabled: true,
      },
    })

    expect(result.summary).toBe('scheduled an alarm')
    expect(result.context).toBe('30 minutes before the due time · For all current assignees')
    expect(result.changes.find((item) => item.label === 'Email copy')?.after).toBe('Yes')
  })
})

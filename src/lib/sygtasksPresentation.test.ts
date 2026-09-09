import { describe, expect, it } from 'vitest'
import type { SygTask } from '../data/sygtasks'
import { taskDueState } from './sygtasksPresentation'

function taskDueAt(dueAt: string): SygTask {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    boardId: '22222222-2222-4222-8222-222222222222',
    title: 'Confirm coverage',
    description: '',
    status: 'in_progress',
    priority: 'routine',
    dueAt,
    sortRank: 0,
    createdBy: '33333333-3333-4333-8333-333333333333',
    updatedBy: '33333333-3333-4333-8333-333333333333',
    version: 1,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-09-09T12:00:00.000Z',
    updatedAt: '2026-09-09T12:00:00.000Z',
    canEdit: true,
    canUpdateStatus: true,
    watching: false,
    assignees: [],
    labels: [],
    checklist: { total: 0, completed: 0 },
    watcherCount: 0,
    commentCount: 0,
    dependencyCount: 0,
  }
}

describe('taskDueState', () => {
  it('uses the supplied server reference and marks an earlier time today as overdue', () => {
    const serverReference = '2026-09-09T18:00:00.000Z'

    expect(taskDueState(taskDueAt('2026-09-09T17:59:59.000Z'), serverReference)).toBe('overdue')
    expect(taskDueState(taskDueAt('2026-09-09T18:00:01.000Z'), serverReference)).toBe('today')
  })
})

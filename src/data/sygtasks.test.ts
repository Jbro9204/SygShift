import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSygTask,
  formatSygTaskPriority,
  formatSygTaskStatus,
  getSygTasksWorklist,
  getSygTasksWorkspace,
  mutateSygTasks,
  sygTaskPath,
} from './sygtasks'

const rpc = vi.fn()
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

const employeeId = '11111111-1111-4111-8111-111111111111'
const boardId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'
const assignmentId = '55555555-5555-4555-8555-555555555555'

function workspace() {
  return {
    employeeId, permissions: { viewShared: true, manageShared: false },
    boards: [{ id: boardId, name: 'Operations', description: '', scope: 'team', ownerEmployeeId: employeeId, ownerName: 'Jordan Brown', memberRole: 'member', version: 1, archivedAt: null, updatedAt: '2026-09-08T12:00:00Z', openTaskCount: 1, canManageBoard: false, canCreateTask: true }],
    selectedBoard: { id: boardId, name: 'Operations', description: '', scope: 'team', ownerEmployeeId: employeeId, ownerName: 'Jordan Brown', memberRole: 'member', version: 1, archivedAt: null, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', canManageBoard: false, canCreateTask: true },
    tasks: [], myTasks: [], labels: [], members: [], availableMembers: [], taskDetail: null,
    page: { size: 20, hasMore: false, nextCursor: null },
  }
}

function task() {
  return {
    id: taskId,
    boardId,
    boardName: 'Operations',
    title: 'Review weekly coverage',
    description: 'Confirm every open shift has an owner.',
    status: 'in_progress',
    priority: 'high',
    dueAt: '2026-09-10T16:00:00Z',
    sortRank: 10,
    createdBy: employeeId,
    updatedBy: employeeId,
    version: 2,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-09-08T12:00:00Z',
    updatedAt: '2026-09-09T12:00:00Z',
    canEdit: true,
    canUpdateStatus: true,
    watching: true,
    assignees: [{ id: employeeId, name: 'Jordan Brown', username: 'jordan' }],
    labels: [{ id: assignmentId, name: 'Coverage', color: '#E3AD3B' }],
    checklist: { total: 3, completed: 1 },
    watcherCount: 1,
    commentCount: 2,
    dependencyCount: 0,
  }
}

function worklist() {
  return {
    summary: {
      accessibleBoards: 3,
      current: 12,
      dueToday: 2,
      inProgress: 4,
      upcoming: 6,
      completedThisMonth: 8,
      timezone: 'America/Denver',
      asOf: '2026-09-09T12:00:00Z',
    },
    boards: workspace().boards,
    tasks: [task()],
    counts: {
      status: { backlog: 1, ready: 2, in_progress: 4, blocked: 1, review: 4, done: 8, canceled: 0 },
      priority: { low: 1, routine: 5, high: 4, urgent: 2 },
    },
    filters: {
      mode: 'my_work',
      boardId: null,
      search: 'coverage',
      status: null,
      priority: 'high',
      includeArchived: false,
    },
    page: { number: 1, size: 20, total: 4, totalPages: 1, hasPrevious: false, hasMore: false },
  }
}

describe('SygTasks data boundary', () => {
  beforeEach(() => rpc.mockReset())

  it('requests a bounded workspace and validates the response', async () => {
    rpc.mockResolvedValue({ data: workspace(), error: null })
    await expect(getSygTasksWorkspace({ boardId, taskId, pageSize: 20 })).resolves.toMatchObject({ employeeId, selectedBoard: { id: boardId } })
    expect(rpc).toHaveBeenCalledWith('get_sygtasks_workspace', {
      target_board_id: boardId, target_task_id: taskId, target_cursor_updated_at: null,
      target_cursor_task_id: null, target_page_size: 20, target_include_archived: false,
    })
  })

  it('uses the idempotent mutation RPC and optimistic version', async () => {
    rpc.mockResolvedValue({ data: { taskId, version: 4 }, error: null })
    await expect(mutateSygTasks('update_task', { taskId, status: 'done' }, { expectedVersion: 3, clientRequestId: requestId })).resolves.toEqual({ taskId, version: 4 })
    expect(rpc).toHaveBeenCalledWith('mutate_sygtasks', expect.objectContaining({ target_action: 'update_task', target_expected_version: 3 }))
  })

  it('requests server-filtered authorized work with exact summary and page metadata', async () => {
    rpc.mockResolvedValue({ data: worklist(), error: null })

    await expect(getSygTasksWorklist({ search: 'Coverage', priority: 'high', page: 1 })).resolves.toMatchObject({
      summary: { accessibleBoards: 3, current: 12, completedThisMonth: 8, timezone: 'America/Denver' },
      tasks: [{ id: taskId, boardName: 'Operations' }],
      page: { total: 4 },
    })
    expect(rpc).toHaveBeenCalledWith('get_sygtasks_worklist', {
      target_mode: 'my_work',
      target_board_id: null,
      target_search: 'Coverage',
      target_status: null,
      target_priority: 'high',
      target_page: 1,
      target_page_size: 20,
      target_include_archived: false,
    })
  })

  it('creates and optionally assigns a task through one atomic RPC', async () => {
    rpc.mockResolvedValue({
      data: {
        action: 'create_task_with_assignee',
        boardId,
        taskId,
        version: 1,
        clientRequestId: requestId,
        assignedEmployeeId: employeeId,
        assignmentId,
        assignmentChanged: true,
        changed: true,
      },
      error: null,
    })

    await expect(createSygTask({
      boardId,
      title: '  Review weekly coverage  ',
      description: 'Confirm assignments.',
      status: 'ready',
      priority: 'high',
      dueAt: '2026-09-10T16:00:00Z',
      assigneeId: employeeId,
    }, { clientRequestId: requestId })).resolves.toMatchObject({ taskId, assignedEmployeeId: employeeId })
    expect(rpc).toHaveBeenCalledWith('create_sygtasks_task', {
      target_payload: expect.objectContaining({ title: 'Review weekly coverage', assigneeId: employeeId }),
      target_client_request_id: requestId,
    })
  })

  it('rejects malformed task creation before sending it to the database', async () => {
    await expect(createSygTask({ boardId, title: '' })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('provides readable labels and stable deep links', () => {
    expect(formatSygTaskStatus('in_progress')).toBe('In progress')
    expect(formatSygTaskPriority('urgent')).toBe('Urgent')
    expect(sygTaskPath(boardId, taskId)).toBe(`/tasks?board=${boardId}&task=${taskId}`)
  })

  it('surfaces database failures without inventing task data', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Task access denied.' } })
    await expect(getSygTasksWorkspace()).rejects.toThrow('Task access denied.')
  })

  it('surfaces work-list failures without falling back to partial client filtering', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'This board is not available to your account.' } })
    await expect(getSygTasksWorklist({ mode: 'board', boardId })).rejects.toThrow('This board is not available to your account.')
  })
})

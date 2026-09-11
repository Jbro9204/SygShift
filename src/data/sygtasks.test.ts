import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSygTask,
  createSygTaskRecurringSeries,
  createSygTaskReminder,
  formatSygTaskPriority,
  formatSygTaskStatus,
  getSygTasksWorklist,
  getSygTasksWorkspace,
  getMySygTasksAlarmState,
  getMySygTasksBadge,
  getSygTaskActivity,
  getSygTaskRecurringSeries,
  manageSygTaskRecurringSeries,
  manageMySygTasksAlarm,
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

  it('requests a bounded task activity page and validates enriched names', async () => {
    rpc.mockResolvedValue({
      data: {
        taskId,
        events: [{
          id: 44,
          action: 'assignee.added',
          entityType: 'assignee',
          entityId: assignmentId,
          details: { employeeId },
          actorId: employeeId,
          actorName: 'Jordan Brown',
          actorSource: 'employee',
          createdAt: '2026-09-10T16:35:00Z',
          subject: { employeeId, name: 'Jordan Brown', username: 'jordan' },
          label: null,
          relatedTask: null,
        }],
        page: { size: 50, hasMore: true, nextBeforeId: 44 },
      },
      error: null,
    })

    await expect(getSygTaskActivity(taskId, 90, 50)).resolves.toMatchObject({
      events: [{ actorName: 'Jordan Brown', subject: { name: 'Jordan Brown' } }],
      page: { nextBeforeId: 44 },
    })
    expect(rpc).toHaveBeenCalledWith('get_sygtasks_task_activity', {
      target_task_id: taskId,
      target_before_id: 90,
      target_page_size: 50,
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

  it('creates, reads, and manages a bounded recurring task series through dedicated RPCs', async () => {
    rpc.mockResolvedValueOnce({ data: {
      action: 'create_recurring_series', seriesId: assignmentId, boardId, taskId,
      version: 1, clientRequestId: requestId, changed: true,
    }, error: null })
    await expect(createSygTaskRecurringSeries({
      boardId,
      title: 'Weekly dispatch review',
      description: 'Review uncovered assignments.',
      status: 'ready',
      priority: 'high',
      assigneeId: employeeId,
      firstDueLocal: '2026-09-14T09:00',
      timeZone: 'America/Denver',
      frequency: 'weekly',
      intervalCount: 1,
      endsOn: null,
      maxOccurrences: 12,
      reminderKind: 'alarm',
      reminderOffsetMinutes: 60,
      reminderEmailEnabled: true,
    }, { clientRequestId: requestId })).resolves.toMatchObject({ seriesId: assignmentId, taskId })
    expect(rpc).toHaveBeenLastCalledWith('create_sygtasks_recurring_series', {
      target_payload: expect.objectContaining({ frequency: 'weekly', maxOccurrences: 12, reminderKind: 'alarm' }),
      target_client_request_id: requestId,
    })

    rpc.mockResolvedValueOnce({ data: { taskId, series: null }, error: null })
    await expect(getSygTaskRecurringSeries(taskId)).resolves.toEqual({ taskId, series: null })
    expect(rpc).toHaveBeenLastCalledWith('get_sygtasks_recurring_series', { target_task_id: taskId })

    rpc.mockResolvedValueOnce({ data: { seriesId: assignmentId, action: 'pause', status: 'paused', version: 2, changed: true }, error: null })
    await manageSygTaskRecurringSeries(assignmentId, 'pause', {}, 1, requestId)
    expect(rpc).toHaveBeenLastCalledWith('manage_sygtasks_recurring_series', {
      target_series_id: assignmentId,
      target_action: 'pause',
      target_payload: {},
      target_client_request_id: requestId,
      target_expected_version: 1,
    })
  })

  it('rejects incomplete recurrence settings before they reach the database', async () => {
    await expect(createSygTaskRecurringSeries({
      boardId,
      title: 'Invalid recurrence',
      firstDueLocal: '2026-09-14T09:00',
      timeZone: 'America/Denver',
      frequency: 'weekly',
      intervalCount: 0,
      endsOn: null,
      maxOccurrences: null,
      reminderKind: 'none',
      reminderOffsetMinutes: null,
      reminderEmailEnabled: false,
    })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('creates a bounded task alarm with an idempotency key', async () => {
    rpc.mockResolvedValue({ data: { reminderId: assignmentId, taskId, changed: true }, error: null })
    await expect(createSygTaskReminder({
      taskId,
      kind: 'alarm',
      recipientScope: 'assignees',
      timingKind: 'relative',
      offsetMinutes: 60,
      absoluteAt: null,
      emailEnabled: true,
    }, { clientRequestId: requestId })).resolves.toMatchObject({ reminderId: assignmentId })
    expect(rpc).toHaveBeenCalledWith('create_sygtasks_task_reminder', {
      target_payload: expect.objectContaining({ taskId, kind: 'alarm', offsetMinutes: 60 }),
      target_client_request_id: requestId,
    })
  })

  it('reads and controls only the signed-in employee task alarms', async () => {
    rpc.mockResolvedValueOnce({ data: { serverTime: '2026-09-09T12:00:00Z', alarms: [{
      occurrenceId: assignmentId, reminderId: requestId, taskId, boardId, title: 'Review coverage', priority: 'urgent',
      dueAt: null, scheduledFor: '2026-09-09T11:59:00Z', triggeredAt: '2026-09-09T12:00:00Z', deliveryCount: 1,
      taskVersion: 3, canComplete: true,
    }] }, error: null })
    await expect(getMySygTasksAlarmState()).resolves.toMatchObject({ alarms: [{ occurrenceId: assignmentId, canComplete: true }] })

    rpc.mockResolvedValueOnce({ data: { count: 4, unreadCount: 3, activeAlarmCount: 1 }, error: null })
    await expect(getMySygTasksBadge()).resolves.toEqual({ count: 4, unreadCount: 3, activeAlarmCount: 1 })

    rpc.mockResolvedValueOnce({ data: { changed: true }, error: null })
    await manageMySygTasksAlarm('snooze', assignmentId, 10, requestId)
    expect(rpc).toHaveBeenLastCalledWith('manage_my_sygtasks_alarm', {
      target_action: 'snooze',
      target_occurrence_id: assignmentId,
      target_snooze_minutes: 10,
      target_client_request_id: requestId,
    })
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

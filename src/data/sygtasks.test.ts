import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatSygTaskPriority, formatSygTaskStatus, getSygTasksWorkspace, mutateSygTasks, sygTaskPath } from './sygtasks'

const rpc = vi.fn()
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

const employeeId = '11111111-1111-4111-8111-111111111111'
const boardId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'

function workspace() {
  return {
    employeeId, permissions: { viewShared: true, manageShared: false },
    boards: [{ id: boardId, name: 'Operations', description: '', scope: 'team', ownerEmployeeId: employeeId, ownerName: 'Jordan Brown', memberRole: 'member', version: 1, archivedAt: null, updatedAt: '2026-09-08T12:00:00Z', openTaskCount: 1, canManageBoard: false, canCreateTask: true }],
    selectedBoard: { id: boardId, name: 'Operations', description: '', scope: 'team', ownerEmployeeId: employeeId, ownerName: 'Jordan Brown', memberRole: 'member', version: 1, archivedAt: null, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', canManageBoard: false, canCreateTask: true },
    tasks: [], myTasks: [], labels: [], members: [], availableMembers: [], taskDetail: null,
    page: { size: 20, hasMore: false, nextCursor: null },
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
    await expect(mutateSygTasks('update_task', { taskId, status: 'done' }, { expectedVersion: 3, clientRequestId: '44444444-4444-4444-8444-444444444444' })).resolves.toEqual({ taskId, version: 4 })
    expect(rpc).toHaveBeenCalledWith('mutate_sygtasks', expect.objectContaining({ target_action: 'update_task', target_expected_version: 3 }))
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
})

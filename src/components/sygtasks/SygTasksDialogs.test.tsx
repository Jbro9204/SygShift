import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SygTaskDetail, SygTasksWorkspace } from '../../data/sygtasks'
import { CreateBoardDialog, CreateTaskDialog, TaskDetailDialog } from './SygTasksDialogs'

const employeeId = '11111111-1111-4111-8111-111111111111'
const otherEmployeeId = '22222222-2222-4222-8222-222222222222'
const boardId = '33333333-3333-4333-8333-333333333333'
const taskId = '44444444-4444-4444-8444-444444444444'
const requestIds = [
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
] as const

function member(id: string, name: string, username: string): SygTasksWorkspace['members'][number] {
  return {
    membershipId: id === employeeId
      ? '88888888-8888-4888-8888-888888888888'
      : '99999999-9999-4999-8999-999999999999',
    employeeId: id,
    name,
    username,
    role: 'member',
    addedAt: '2026-09-09T12:00:00.000Z',
  }
}

function detailWorkspace(): { detail: SygTaskDetail; workspace: SygTasksWorkspace } {
  const baseTask = {
    id: taskId,
    boardId,
    boardName: 'Operations',
    title: 'Confirm coverage',
    description: '',
    status: 'in_progress' as const,
    priority: 'routine' as const,
    dueAt: '2026-09-09T18:00:00.000Z',
    sortRank: 0,
    createdBy: employeeId,
    updatedBy: employeeId,
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
  const board = {
    id: boardId,
    name: 'Operations',
    description: '',
    scope: 'team' as const,
    ownerEmployeeId: employeeId,
    ownerName: 'Jordan Brown',
    memberRole: 'owner' as const,
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-09T12:00:00.000Z',
    updatedAt: '2026-09-09T12:00:00.000Z',
    openTaskCount: 1,
    canManageBoard: true,
    canCreateTask: true,
  }
  const members = [
    member(employeeId, 'Jordan Brown', 'jordan'),
    member(otherEmployeeId, 'Zachary Ward', 'zach'),
  ]
  const detail: SygTaskDetail = {
    ...baseTask,
    watchers: [],
    checklistItems: [],
    comments: [],
    dependencies: [],
    activity: [],
  }
  return {
    detail,
    workspace: {
      employeeId,
      permissions: { viewShared: true, manageShared: true },
      boards: [board],
      selectedBoard: board,
      tasks: [baseTask],
      myTasks: [baseTask],
      labels: [],
      members,
      availableMembers: members.map((item) => ({
        employeeId: item.employeeId,
        name: item.name,
        username: item.username,
        isMember: true,
        membershipId: item.membershipId ?? null,
        role: item.role ?? null,
      })),
      taskDetail: detail,
      page: { size: 20, hasMore: true, nextCursor: { updatedAt: baseTask.updatedAt, taskId } },
    },
  }
}

describe('SygTasks dialogs', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
  })

  it('reuses a board request id for an identical retry and changes it with the payload', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(requestIds[0])
      .mockReturnValueOnce(requestIds[1])
    render(<CreateBoardDialog allowShared busy={false} error={null} onClose={vi.fn()} onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText(/Board name/), 'Dispatch priorities')
    await user.click(screen.getByRole('button', { name: 'Create Board' }))
    await user.click(screen.getByRole('button', { name: 'Create Board' }))
    await user.type(screen.getByLabelText(/Description/), 'Shared work')
    await user.click(screen.getByRole('button', { name: 'Create Board' }))

    expect(onSubmit.mock.calls.map((call) => call[1])).toEqual([requestIds[0], requestIds[0], requestIds[1]])
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })

  it('limits non-manager task assignment to self and keeps retry identity payload-stable', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(requestIds[0])
      .mockReturnValueOnce(requestIds[1])
    const members = [
      member(employeeId, 'Jordan Brown', 'jordan'),
      member(otherEmployeeId, 'Zachary Ward', 'zach'),
    ]
    render(
      <CreateTaskDialog
        boardName="Operations"
        busy={false}
        canAssignOthers={false}
        employeeId={employeeId}
        error={null}
        members={members}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )

    const assignee = screen.getByLabelText(/Assignee/)
    expect(within(assignee).getByRole('option', { name: /Jordan Brown/ })).toBeInTheDocument()
    expect(within(assignee).queryByRole('option', { name: /Zachary Ward/ })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/Task title/), 'Prepare payroll review')
    await user.click(screen.getByRole('button', { name: 'Create Task' }))
    await user.click(screen.getByRole('button', { name: 'Create Task' }))
    await user.type(screen.getByLabelText(/Description/), 'Verify timecards')
    await user.click(screen.getByRole('button', { name: 'Create Task' }))

    expect(onSubmit.mock.calls.map((call) => call[1])).toEqual([requestIds[0], requestIds[0], requestIds[1]])
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })

  it('loads another bounded page of dependency candidates only on explicit request', async () => {
    const user = userEvent.setup()
    const onLoadMoreCandidates = vi.fn()
    const { detail, workspace } = detailWorkspace()
    render(
      <TaskDetailDialog
        workspace={workspace}
        detail={detail}
        busy={false}
        error={null}
        canLoadMoreCandidates
        loadingMoreCandidates={false}
        onLoadMoreCandidates={onLoadMoreCandidates}
        onClose={vi.fn()}
        act={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(onLoadMoreCandidates).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Load more dependency candidates' }))
    expect(onLoadMoreCandidates).toHaveBeenCalledTimes(1)
  })
})

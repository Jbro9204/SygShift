import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SygTasksPage } from './SygTasksPage'

const mocks = vi.hoisted(() => ({ getWorkspace: vi.fn(), mutate: vi.fn() }))
const employeeId = '11111111-1111-4111-8111-111111111111'
const boardId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'

vi.mock('../data/sygtasks', async () => {
  const actual = await vi.importActual<typeof import('../data/sygtasks')>('../data/sygtasks')
  return { ...actual, getSygTasksWorkspace: mocks.getWorkspace, mutateSygTasks: mocks.mutate }
})
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({
  auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  realtime: { setAuth: vi.fn().mockResolvedValue(undefined) }, channel: vi.fn(), removeChannel: vi.fn(),
}) }))

function task() {
  return { id: taskId, boardId, boardName: 'Operations', title: 'Confirm weekend coverage', description: 'Review the open post.', status: 'ready', priority: 'high', dueAt: '2026-09-10T18:00:00Z', sortRank: 0, createdBy: employeeId, updatedBy: employeeId, version: 1, completedAt: null, archivedAt: null, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', canEdit: true, canUpdateStatus: true, watching: false, assignees: [{ id: employeeId, name: 'Jordan Brown', username: 'jbrown', assignedAt: '2026-09-08T12:00:00Z' }], labels: [], checklist: { total: 2, completed: 1 }, watcherCount: 0, commentCount: 1, dependencyCount: 0 }
}

function workspace() {
  const board = { id: boardId, name: 'Operations', description: 'Weekly operational work', scope: 'team', ownerEmployeeId: employeeId, ownerName: 'Jordan Brown', memberRole: 'owner', version: 1, archivedAt: null, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', openTaskCount: 1, canManageBoard: true, canCreateTask: true }
  return { employeeId, permissions: { viewShared: true, manageShared: true }, boards: [board], selectedBoard: board, tasks: [task()], myTasks: [task()], labels: [], members: [{ membershipId: '55555555-5555-4555-8555-555555555555', employeeId, name: 'Jordan Brown', username: 'jbrown', role: 'owner', addedAt: '2026-09-08T12:00:00Z' }], availableMembers: [{ employeeId, name: 'Jordan Brown', username: 'jbrown', isMember: true, membershipId: '55555555-5555-4555-8555-555555555555', role: 'owner' }], taskDetail: null, page: { size: 50, hasMore: false, nextCursor: null } }
}

function taskDetail() {
  return { ...task(), watchers: [], checklistItems: [{ id: '66666666-6666-4666-8666-666666666666', title: 'Call site contact', sortRank: 0, completedBy: null, completedAt: null, version: 1, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z' }], comments: [{ id: '77777777-7777-4777-8777-777777777777', authorId: employeeId, authorName: 'Jordan Brown', body: 'Coverage request sent.', version: 1, editedAt: null, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', canEdit: true }], dependencies: [], activity: [{ id: 1, action: 'task.created', entityType: 'task', entityId: taskId, details: {}, actorId: employeeId, actorName: 'Jordan Brown', createdAt: '2026-09-08T12:00:00Z' }] }
}

function renderPage(route = '/tasks') {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><SygTasksPage /></MemoryRouter></QueryClientProvider>)
}

describe('SygTasksPage', () => {
  beforeEach(() => {
    mocks.getWorkspace.mockReset().mockImplementation((input: { taskId?: string | null }) => Promise.resolve({ ...workspace(), taskDetail: input.taskId ? taskDetail() : null }))
    mocks.mutate.mockReset().mockResolvedValue({ changed: true })
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
  })

  it('shows front-line My Work with actionable task progress', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'My Work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm weekend coverage/ })).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('opens the complete board creation workflow', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'My Work' })
    await user.click(screen.getByRole('button', { name: 'New board' }))
    expect(screen.getByRole('dialog', { name: 'Create a SygTasks board' })).toBeInTheDocument()
    expect(screen.getByLabelText('Board name')).toBeInTheDocument()
    expect(screen.getByLabelText('Who is this for?')).toBeInTheDocument()
  })

  it('opens a task with people, checklist, discussion, and activity workspaces', async () => {
    const user = userEvent.setup()
    renderPage(`/tasks?board=${boardId}&task=${taskId}`)
    expect(await screen.findByRole('dialog', { name: 'Confirm weekend coverage' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'People' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Checklist' }))
    expect(screen.getByText('Call site contact')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Comments (1)' }))
    expect(screen.getByText('Coverage request sent.')).toBeInTheDocument()
  })

  it('keeps personal board settings owner-only without member controls', async () => {
    const user = userEvent.setup()
    mocks.getWorkspace.mockImplementation((input: { taskId?: string | null }) => {
      const personal = workspace()
      personal.selectedBoard.scope = 'personal'
      personal.boards[0].scope = 'personal'
      return Promise.resolve({ ...personal, taskDetail: input.taskId ? taskDetail() : null })
    })
    renderPage(`/tasks?board=${boardId}`)

    await user.click(await screen.findByRole('button', { name: 'Board settings' }))
    expect(screen.getByRole('heading', { name: 'Private to you' })).toBeInTheDocument()
    expect(screen.getByText(/Only you can find, open, change, follow, or receive updates/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })
})

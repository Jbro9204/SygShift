import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SygTasksPage } from './SygTasksPage'

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  getActivity: vi.fn(),
  getWorklist: vi.fn(),
  getWorkspace: vi.fn(),
  mutate: vi.fn(),
}))

const employeeId = '11111111-1111-4111-8111-111111111111'
const secondEmployeeId = '12121212-1212-4121-8121-121212121212'
const boardId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'

vi.mock('../data/sygtasks', async () => {
  const actual = await vi.importActual<typeof import('../data/sygtasks')>('../data/sygtasks')
  return {
    ...actual,
    createSygTask: mocks.createTask,
    getSygTaskActivity: mocks.getActivity,
    getSygTasksWorklist: mocks.getWorklist,
    getSygTasksWorkspace: mocks.getWorkspace,
    mutateSygTasks: mocks.mutate,
  }
})

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    channel: vi.fn(),
    realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
    removeChannel: vi.fn(),
  }),
}))

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: taskId,
    boardId,
    boardName: 'Operations',
    title: 'Confirm weekend coverage',
    description: 'Review the open post.',
    status: 'ready',
    priority: 'high',
    dueAt: '2026-09-10T18:00:00Z',
    sortRank: 0,
    createdBy: employeeId,
    updatedBy: employeeId,
    version: 1,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-09-08T12:00:00Z',
    updatedAt: '2026-09-08T12:00:00Z',
    canEdit: true,
    canUpdateStatus: true,
    watching: false,
    assignees: [{ id: employeeId, name: 'Jordan Brown', username: 'jbrown', assignedAt: '2026-09-08T12:00:00Z' }],
    labels: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Coverage', color: '#e3ad3b' }],
    checklist: { total: 2, completed: 1 },
    watcherCount: 0,
    commentCount: 1,
    dependencyCount: 0,
    ...overrides,
  }
}

function workspace(scope: 'personal' | 'team' | 'company' = 'team') {
  const board = {
    id: boardId,
    name: 'Operations',
    description: 'Weekly operational work',
    scope,
    ownerEmployeeId: employeeId,
    ownerName: 'Jordan Brown',
    memberRole: 'owner',
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-08T12:00:00Z',
    updatedAt: '2026-09-08T12:00:00Z',
    openTaskCount: 7,
    canManageBoard: true,
    canCreateTask: true,
  }
  return {
    employeeId,
    permissions: { viewShared: true, manageShared: true },
    boards: [board],
    selectedBoard: board,
    tasks: [task()],
    myTasks: [task()],
    labels: [],
    members: [
      { membershipId: '55555555-5555-4555-8555-555555555555', employeeId, name: 'Jordan Brown', username: 'jbrown', role: 'owner', addedAt: '2026-09-08T12:00:00Z' },
      { membershipId: '56565656-5656-4565-8565-565656565656', employeeId: secondEmployeeId, name: 'Zachary Ward', username: 'zward', role: 'member', addedAt: '2026-09-08T12:00:00Z' },
    ],
    availableMembers: [
      { employeeId, name: 'Jordan Brown', username: 'jbrown', isMember: true, membershipId: '55555555-5555-4555-8555-555555555555', role: 'owner' },
      { employeeId: secondEmployeeId, name: 'Zachary Ward', username: 'zward', isMember: true, membershipId: '56565656-5656-4565-8565-565656565656', role: 'member' },
    ],
    taskDetail: null,
    page: { size: 50, hasMore: false, nextCursor: null },
  }
}

function taskDetail() {
  return {
    ...task(),
    watchers: [],
    checklistItems: [{ id: '66666666-6666-4666-8666-666666666666', title: 'Call site contact', sortRank: 0, completedBy: null, completedAt: null, version: 1, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z' }],
    comments: [{ id: '77777777-7777-4777-8777-777777777777', authorId: employeeId, authorName: 'Jordan Brown', body: 'Coverage request sent.', version: 1, editedAt: null, createdAt: '2026-09-08T12:00:00Z', updatedAt: '2026-09-08T12:00:00Z', canEdit: true }],
    dependencies: [],
    activity: [{ id: 1, action: 'task.created', entityType: 'task', entityId: taskId, details: {}, actorId: employeeId, actorName: 'Jordan Brown', createdAt: '2026-09-08T12:00:00Z' }],
  }
}

function worklist(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      accessibleBoards: 3,
      current: 7,
      dueToday: 2,
      inProgress: 3,
      upcoming: 4,
      completedThisMonth: 5,
      timezone: 'America/Denver',
      asOf: '2026-09-09T12:00:00Z',
    },
    boards: workspace().boards,
    tasks: [task()],
    counts: {
      status: { backlog: 1, ready: 1, in_progress: 2, blocked: 1, review: 2, done: 0, canceled: 0 },
      priority: { low: 1, routine: 2, high: 3, urgent: 1 },
    },
    filters: { mode: 'my_work', boardId: null, search: '', status: null, priority: null, includeArchived: false },
    page: { number: 1, size: 20, total: 7, totalPages: 1, hasPrevious: false, hasMore: false },
    ...overrides,
  }
}

function renderPage(route = '/tasks') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SygTasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function HistoryControls() {
  const navigate = useNavigate()
  return <><button type="button" onClick={() => navigate(-1)}>History Back</button><button type="button" onClick={() => navigate(1)}>History Forward</button></>
}

function renderHistoryPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tasks', `/tasks?board=${boardId}`]} initialIndex={1}>
        <HistoryControls />
        <SygTasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SygTasksPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mocks.getWorkspace.mockReset().mockImplementation((input: { taskId?: string | null }) => Promise.resolve({
      ...workspace(),
      taskDetail: input.taskId ? taskDetail() : null,
    }))
    mocks.getWorklist.mockReset().mockResolvedValue(worklist())
    mocks.getActivity.mockReset().mockResolvedValue({
      taskId,
      events: [{
        id: 1,
        action: 'task.created',
        entityType: 'task',
        entityId: taskId,
        details: { after: { title: 'Confirm weekend coverage', status: 'ready', priority: 'high' } },
        actorId: employeeId,
        actorName: 'Jordan Brown',
        actorSource: 'employee',
        createdAt: '2026-09-08T12:00:00Z',
        subject: null,
        label: null,
        relatedTask: null,
      }],
      page: { size: 50, hasMore: false, nextBeforeId: null },
    })
    mocks.mutate.mockReset().mockResolvedValue({ changed: true })
    mocks.createTask.mockReset().mockResolvedValue({ changed: true, taskId })
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
  })

  it('renders the approved brand header and exact server-provided My Work summary', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'SygTasks', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('SYGSHIFT WORK MANAGEMENT')).toBeInTheDocument()
    expect(screen.getByText('Organize · Own · Progress · Complete')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh SygTasks' })).toBeInTheDocument()
    expect(document.querySelector('.sygtasks-header__logo')).toHaveAttribute('src', '/branding/sygtasks-logo.png')

    const summary = await screen.findByLabelText('My Work summary')
    expect(within(summary).getByText('Due Today').nextElementSibling).toHaveTextContent('2')
    expect(within(summary).getByText('In Progress').nextElementSibling).toHaveTextContent('3')
    expect(within(summary).getByText('Upcoming').nextElementSibling).toHaveTextContent('4')
    expect(within(summary).getByText('Completed This Month').nextElementSibling).toHaveTextContent('5')
    expect(screen.getByRole('button', { name: /My Work 7/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByText('Confirm weekend coverage')).not.toHaveLength(0)
  })

  it('wires My Work search, status, and priority to the authorized server query', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'My Work' })
    mocks.getWorklist.mockClear()

    await user.type(screen.getByPlaceholderText('Tasks, descriptions, people, labels, or boards'), 'coverage')
    await user.selectOptions(screen.getByLabelText('Status'), 'in_progress')
    await user.selectOptions(screen.getByLabelText('Priority'), 'high')

    await waitFor(() => expect(mocks.getWorklist).toHaveBeenCalledWith({
      mode: 'my_work',
      boardId: null,
      search: 'coverage',
      status: 'in_progress',
      priority: 'high',
      page: 1,
      pageSize: 20,
    }))
  })

  it('switches to Boards and supports both kanban and list views', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'My Work' })

    await user.click(screen.getByRole('button', { name: /Boards 3/ }))
    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Kanban board')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
    expect(sessionStorage.getItem('sygtasks.board-view')).toBe('list')
    await waitFor(() => expect(mocks.getWorklist).toHaveBeenCalledWith(expect.objectContaining({ mode: 'board', boardId })))
  })

  it('follows browser Back and Forward between Boards and My Work', async () => {
    const user = userEvent.setup()
    renderHistoryPage()

    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Boards 3/ })).toHaveAttribute('aria-current', 'page')

    await user.click(screen.getByRole('button', { name: 'History Back' }))
    expect(await screen.findByRole('heading', { name: 'My Work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /My Work 7/ })).toHaveAttribute('aria-current', 'page')

    await user.click(screen.getByRole('button', { name: 'History Forward' }))
    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Boards 3/ })).toHaveAttribute('aria-current', 'page')
  })

  it('validates board creation and submits the selected authorized scope once complete', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: 'My Work' })

    await user.click(screen.getByRole('button', { name: 'New Board' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a SygTasks board' })
    await user.click(within(dialog).getByRole('button', { name: 'Create Board' }))
    expect(within(dialog).getByText('Enter at least two characters for the board name.')).toBeInTheDocument()
    expect(mocks.mutate).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText(/Board name/), 'Dispatch priorities')
    await user.click(within(dialog).getByLabelText(/A team/))
    await user.type(within(dialog).getByLabelText(/Description/), 'Shared dispatch work.')
    await user.click(within(dialog).getByRole('button', { name: 'Create Board' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith('create_board', {
      name: 'Dispatch priorities',
      description: 'Shared dispatch work.',
      scope: 'team',
    }, { expectedVersion: undefined, clientRequestId: expect.any(String) })
  })

  it('creates a task with an authorized assignee and blocks duplicate submission while pending', async () => {
    const user = userEvent.setup()
    let finishCreate: ((value: { changed: boolean; taskId: string }) => void) | undefined
    mocks.createTask.mockImplementation(() => new Promise((resolve) => { finishCreate = resolve }))
    renderPage(`/tasks?board=${boardId}`)
    await screen.findByRole('heading', { name: 'Operations' })

    await user.click(screen.getByRole('button', { name: 'New Task' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a task' })
    await user.type(within(dialog).getByLabelText(/Task title/), 'Prepare payroll review')
    await user.type(within(dialog).getByLabelText(/Description/), 'Verify timecards before processing.')
    await user.selectOptions(within(dialog).getByLabelText(/Starting status/), 'ready')
    await user.selectOptions(within(dialog).getByLabelText(/Priority/), 'urgent')
    await user.selectOptions(within(dialog).getByLabelText(/Assignee/), secondEmployeeId)

    const submit = within(dialog).getByRole('button', { name: 'Create Task' })
    await user.dblClick(submit)
    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(1))
    expect(mocks.createTask).toHaveBeenCalledWith({
      boardId,
      title: 'Prepare payroll review',
      description: 'Verify timecards before processing.',
      status: 'ready',
      priority: 'urgent',
      dueAt: null,
      assigneeId: secondEmployeeId,
    }, { clientRequestId: expect.any(String) })
    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled()

    finishCreate?.({ changed: true, taskId })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a task' })).not.toBeInTheDocument())
  })

  it('offers every authorized company employee when a manager creates company work', async () => {
    const user = userEvent.setup()
    const companyWorkspace = workspace('company')
    mocks.getWorkspace.mockResolvedValue({ ...companyWorkspace, members: companyWorkspace.members.slice(0, 1) })

    renderPage(`/tasks?board=${boardId}`)
    await screen.findByRole('heading', { name: 'Operations' })
    await user.click(screen.getByRole('button', { name: 'New Task' }))

    const dialog = screen.getByRole('dialog', { name: 'Create a task' })
    expect(within(dialog).getByLabelText(/Assignee/)).toHaveTextContent('Zachary Ward')
  })

  it('updates task status through the existing versioned mutation boundary', async () => {
    const user = userEvent.setup()
    renderPage()
    const status = await screen.findByLabelText('Status for Confirm weekend coverage')

    await user.selectOptions(status, 'in_progress')

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(
      'update_task',
      { taskId, status: 'in_progress' },
      { expectedVersion: 1 },
    ))
    expect(await screen.findByText('“Confirm weekend coverage” moved to In progress.')).toBeInTheDocument()
  })

  it('opens a task with people, checklist, discussion, and activity workspaces', async () => {
    const user = userEvent.setup()
    renderPage(`/tasks?board=${boardId}&task=${taskId}`)
    const dialog = await screen.findByRole('dialog', { name: 'Confirm weekend coverage' })
    expect(within(dialog).getByRole('button', { name: 'People' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Checklist' }))
    expect(within(dialog).getByText('Call site contact')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Comments (1)' }))
    expect(within(dialog).getByText('Coverage request sent.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Activity' }))
    expect(await within(dialog).findByText((_, node) => node?.tagName === 'P' && node.textContent === 'Jordan Brown created this task')).toBeInTheDocument()
  })

  it('keeps personal board settings owner-only and uses a separate archive confirmation', async () => {
    const user = userEvent.setup()
    mocks.getWorkspace.mockImplementation((input: { taskId?: string | null }) => Promise.resolve({
      ...workspace('personal'),
      taskDetail: input.taskId ? taskDetail() : null,
    }))
    renderPage(`/tasks?board=${boardId}`)

    await user.click(await screen.findByRole('button', { name: 'Board Settings' }))
    const settings = screen.getByRole('dialog', { name: 'Board Settings' })
    expect(within(settings).getByRole('heading', { name: 'Private to you' })).toBeInTheDocument()
    expect(within(settings).getByText(/Only you can find, open, change, follow, or receive updates/)).toBeInTheDocument()
    expect(within(settings).queryByRole('heading', { name: 'Board members' })).not.toBeInTheDocument()
    expect(within(settings).queryByRole('button', { name: 'Add Member' })).not.toBeInTheDocument()

    await user.click(within(settings).getByRole('button', { name: 'Archive Board' }))
    const confirmation = screen.getByRole('alertdialog', { name: 'Archive this board?' })
    expect(within(confirmation).getByText(/history will be preserved/i)).toBeInTheDocument()
    expect(mocks.mutate).not.toHaveBeenCalled()
    await user.click(within(confirmation).getByRole('button', { name: 'Keep Board' }))
    expect(screen.getByRole('dialog', { name: 'Board Settings' })).toBeInTheDocument()
  })
})

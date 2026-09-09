import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Plus, Settings2 } from 'lucide-react'
import {
  BoardRail,
  KanbanBoard,
  SygTasksHeader,
  SygTasksPrimaryTabs,
  SygTasksSummary,
  TaskTable,
  TaskToolbar,
  TasksEmptyState,
  WorklistPagination,
  type SygTasksMode,
  type SygTasksView,
} from '../../src/components/sygtasks/SygTasksElements'
import {
  BoardSettingsDialog,
  CreateBoardDialog,
  CreateTaskDialog,
  SygTasksSuccessNotice,
  type SygTasksAct,
} from '../../src/components/sygtasks/SygTasksDialogs'
import {
  sygTaskStatuses,
  type CreateSygTaskInput,
  type SygTask,
  type SygTaskBoard,
  type SygTaskPriority,
  type SygTaskStatus,
  type SygTasksWorkspace,
} from '../../src/data/sygtasks'
import '../../src/index.css'
import '../../src/theme.css'
import '../../src/App.css'
import '../../src/styles/sygtasks.css'

const actorId = '11111111-1111-4111-8111-111111111111'
const elliotId = '22222222-2222-4222-8222-222222222222'
const sandyId = '33333333-3333-4333-8333-333333333333'
const jadeId = '44444444-4444-4444-8444-444444444444'
const boardId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const secondBoardId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const createdAt = '2026-09-01T14:00:00.000Z'

const people = {
  actor: { id: actorId, name: 'Jordan Brown', username: 'jordan' },
  elliot: { id: elliotId, name: 'Elliot Olivarria', username: 'elliot' },
  sandy: { id: sandyId, name: 'Sandy Caughlan', username: 'sandy' },
}

const labels = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Coverage', color: '#e3ad3b', version: 1 },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Customer', color: '#3377a8', version: 1 },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Payroll', color: '#7b5ea5', version: 1 },
]

const initialBoards: SygTaskBoard[] = [
  {
    id: boardId,
    name: 'Operations Priorities',
    description: 'Coverage, dispatch, and timekeeping work shared by Operations.',
    scope: 'team',
    ownerEmployeeId: actorId,
    ownerName: 'Jordan Brown',
    memberRole: 'owner',
    version: 3,
    archivedAt: null,
    createdAt,
    updatedAt: '2026-09-09T14:00:00.000Z',
    openTaskCount: 6,
    canManageBoard: true,
    canCreateTask: true,
  },
  {
    id: secondBoardId,
    name: 'HR Launch Readiness',
    description: 'Employee record and payroll readiness follow-up.',
    scope: 'company',
    ownerEmployeeId: sandyId,
    ownerName: 'Sandy Caughlan',
    memberRole: 'editor',
    version: 2,
    archivedAt: null,
    createdAt,
    updatedAt: '2026-09-08T17:00:00.000Z',
    openTaskCount: 2,
    canManageBoard: false,
    canCreateTask: true,
  },
]

function task(input: {
  id: string
  board?: SygTaskBoard
  title: string
  description: string
  status: SygTaskStatus
  priority: SygTaskPriority
  dueAt: string | null
  assignees?: SygTask['assignees']
  labelIndexes?: number[]
  checklist?: { total: number; completed: number }
  comments?: number
}): SygTask {
  const targetBoard = input.board ?? initialBoards[0]
  return {
    id: input.id,
    boardId: targetBoard.id,
    boardName: targetBoard.name,
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    dueAt: input.dueAt,
    sortRank: 100,
    createdBy: actorId,
    updatedBy: actorId,
    version: 2,
    completedAt: input.status === 'done' ? '2026-09-08T18:30:00.000Z' : null,
    archivedAt: null,
    createdAt,
    updatedAt: '2026-09-09T15:00:00.000Z',
    canEdit: true,
    canUpdateStatus: true,
    watching: true,
    assignees: input.assignees ?? [people.actor],
    labels: (input.labelIndexes ?? [0]).map((index) => labels[index]),
    checklist: input.checklist ?? { total: 3, completed: 1 },
    watcherCount: 2,
    commentCount: input.comments ?? 1,
    dependencyCount: 0,
  }
}

const initialTasks: SygTask[] = [
  task({ id: '20000000-0000-4000-8000-000000000001', title: 'Confirm weekend coverage', description: 'Review the open post and confirm an available officer before the scheduling cutoff.', status: 'backlog', priority: 'urgent', dueAt: '2026-09-09T18:00:00.000Z', assignees: [people.actor, people.elliot], labelIndexes: [0], checklist: { total: 4, completed: 2 }, comments: 4 }),
  task({ id: '20000000-0000-4000-8000-000000000002', title: 'Publish dispatch handoff', description: 'Finalize the handoff notes and share the approved communication.', status: 'ready', priority: 'high', dueAt: '2026-09-10T16:30:00.000Z', assignees: [people.elliot], labelIndexes: [0, 1] }),
  task({ id: '20000000-0000-4000-8000-000000000003', title: 'Review payroll exception', description: 'Validate the corrected timecard and document the final payroll disposition.', status: 'in_progress', priority: 'high', dueAt: '2026-09-11T19:00:00.000Z', assignees: [people.sandy], labelIndexes: [2], checklist: { total: 5, completed: 3 }, comments: 2 }),
  task({ id: '20000000-0000-4000-8000-000000000004', title: 'Resolve access dependency', description: 'The receiving team is waiting for the approved site access record.', status: 'blocked', priority: 'urgent', dueAt: '2026-09-08T15:00:00.000Z', assignees: [], labelIndexes: [1], checklist: { total: 2, completed: 0 } }),
  task({ id: '20000000-0000-4000-8000-000000000005', title: 'Approve mobile workflow', description: 'Review the completed mobile layout checks and record approval.', status: 'review', priority: 'routine', dueAt: '2026-09-12T20:00:00.000Z', assignees: [people.actor], labelIndexes: [1], checklist: { total: 3, completed: 3 } }),
  task({ id: '20000000-0000-4000-8000-000000000006', title: 'Complete launch checklist', description: 'All required release checks have passed and the handoff is ready.', status: 'done', priority: 'routine', dueAt: '2026-09-08T17:00:00.000Z', assignees: [people.actor], labelIndexes: [0], checklist: { total: 6, completed: 6 } }),
  task({ id: '20000000-0000-4000-8000-000000000007', title: 'Retire duplicate intake', description: 'Canceled after the intake request was consolidated into the primary task.', status: 'canceled', priority: 'low', dueAt: null, assignees: [people.elliot], labelIndexes: [] }),
  task({ id: '20000000-0000-4000-8000-000000000008', board: initialBoards[1], title: 'Verify employee record readiness', description: 'Confirm the employee profile is ready for the next payroll export.', status: 'ready', priority: 'routine', dueAt: '2026-09-14T16:00:00.000Z', assignees: [people.sandy], labelIndexes: [2] }),
]

function SygTasksVisualFixture() {
  const params = new URLSearchParams(window.location.search)
  const [boards, setBoards] = useState(initialBoards)
  const [tasks, setTasks] = useState(initialTasks)
  const [mode, setMode] = useState<SygTasksMode>(params.get('mode') === 'boards' ? 'boards' : 'my-work')
  const [view, setView] = useState<SygTasksView>('kanban')
  const [selectedBoardId, setSelectedBoardId] = useState(boardId)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<SygTaskStatus | 'all'>('all')
  const [priority, setPriority] = useState<SygTaskPriority | 'all'>('all')
  const [dialog, setDialog] = useState<'board' | 'task' | 'settings' | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const selectedBoard = boards.find((board) => board.id === selectedBoardId) ?? boards[0] ?? null
  const normalizedSearch = search.trim().toLocaleLowerCase()

  const filteredTasks = useMemo(() => tasks.filter((item) => {
    if (mode === 'boards' && item.boardId !== selectedBoard?.id) return false
    if (status !== 'all' && item.status !== status) return false
    if (priority !== 'all' && item.priority !== priority) return false
    if (!normalizedSearch) return true
    return [item.title, item.description, item.boardName, ...item.assignees.flatMap((person) => [person.name, person.username]), ...item.labels.map((label) => label.name)]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedSearch)
  }), [mode, normalizedSearch, priority, selectedBoard?.id, status, tasks])

  const counts = Object.fromEntries(sygTaskStatuses.map((item) => [item, filteredTasks.filter((candidate) => candidate.status === item).length])) as Record<SygTaskStatus, number>
  const summary = { accessibleBoards: boards.length, current: tasks.filter((item) => !['done', 'canceled'].includes(item.status)).length, dueToday: 1, inProgress: 1, upcoming: 4, completedThisMonth: 1, timezone: 'America/Denver' as const, asOf: '2026-09-09T16:00:00.000Z' }
  const members: SygTasksWorkspace['members'] = [
    { membershipId: '30000000-0000-4000-8000-000000000001', employeeId: actorId, name: people.actor.name, username: people.actor.username, role: 'owner', addedAt: createdAt },
    { membershipId: '30000000-0000-4000-8000-000000000002', employeeId: elliotId, name: people.elliot.name, username: people.elliot.username, role: 'editor', addedAt: createdAt },
    { membershipId: '30000000-0000-4000-8000-000000000003', employeeId: sandyId, name: people.sandy.name, username: people.sandy.username, role: 'viewer', addedAt: createdAt },
  ]
  const workspace: SygTasksWorkspace = {
    employeeId: actorId,
    permissions: { viewShared: true, manageShared: true },
    boards,
    selectedBoard,
    tasks,
    myTasks: tasks,
    labels,
    members,
    availableMembers: [
      ...members.map((member) => ({ employeeId: member.employeeId, name: member.name, username: member.username, isMember: true, membershipId: member.membershipId ?? null, role: member.role ?? null })),
      { employeeId: jadeId, name: 'Jade Baptist', username: 'jade', isMember: false, membershipId: null, role: null },
    ],
    taskDetail: null,
    page: { size: 20, hasMore: false, nextCursor: null },
  }

  const changeStatus = (target: SygTask, next: SygTaskStatus) => {
    setTasks((current) => current.map((item) => item.id === target.id ? { ...item, status: next, version: item.version + 1 } : item))
    setSuccess(`“${target.title}” moved to ${next.replaceAll('_', ' ')}.`)
  }
  const clearFilters = () => { setSearch(''); setStatus('all'); setPriority('all') }
  const act: SygTasksAct = async (action, payload) => {
    if (action === 'remove_board_member') setSuccess('Board member removed in the isolated fixture.')
    if (action === 'add_board_member') setSuccess('Board member added in the isolated fixture.')
    if (action === 'archive_board') setBoards((current) => current.filter((board) => board.id !== payload.boardId))
  }
  const createTask = (input: Omit<CreateSygTaskInput, 'boardId'>) => {
    if (!selectedBoard) return
    const assigned = input.assigneeId ? members.find((member) => member.employeeId === input.assigneeId) : null
    setTasks((current) => [task({
      id: crypto.randomUUID(),
      board: selectedBoard,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'backlog',
      priority: input.priority ?? 'routine',
      dueAt: input.dueAt ?? null,
      assignees: assigned ? [{ id: assigned.employeeId, name: assigned.name, username: assigned.username }] : [],
    }), ...current])
    setDialog(null)
    setSuccess('Task created in the isolated visual fixture.')
  }

  return (
    <div className="workspace" style={{ marginLeft: 0 }}>
    <main id="main-content" className="sygtasks-fixture-main">
      <section className="sygtasks-workspace" aria-labelledby="sygtasks-title">
        <SygTasksHeader fetching={false} onCreateBoard={() => setDialog('board')} onRefresh={() => setSuccess('SygTasks is up to date.')} />
        <SygTasksPrimaryTabs mode={mode} taskCount={summary.current} boardCount={summary.accessibleBoards} onChange={setMode} />
        <SygTasksSuccessNotice message={success} />
        <div className={`sygtasks-layout${mode === 'my-work' ? ' sygtasks-layout--my-work' : ''}`}>
          {mode === 'boards' ? <BoardRail boards={boards} selectedId={selectedBoard?.id} onAdd={() => setDialog('board')} onSelect={(board) => setSelectedBoardId(board.id)} /> : null}
          <section className="sygtasks-main">
            <header className="sygtasks-main__heading">
              <div>
                <p>{mode === 'my-work' ? 'Personal focus' : selectedBoard?.scope ?? 'Workspace'}</p>
                <h2>{mode === 'my-work' ? 'My Work' : selectedBoard?.name ?? 'Choose a board'}</h2>
                <span>{mode === 'my-work' ? 'Tasks you own, follow, were assigned, or are responsible for reviewing.' : selectedBoard?.description}</span>
              </div>
              {mode === 'boards' && selectedBoard ? <div>
                <button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={() => setDialog('settings')}><Settings2 aria-hidden="true" size={17} />Board Settings</button>
                <button type="button" className="sygtasks-button sygtasks-button--primary" onClick={() => setDialog('task')}><Plus aria-hidden="true" size={17} />New Task</button>
              </div> : null}
            </header>
            {mode === 'my-work' ? <SygTasksSummary summary={summary} /> : null}
            <TaskToolbar mode={mode} search={search} status={status} priority={priority} view={view} onSearch={setSearch} onStatus={setStatus} onPriority={setPriority} onView={setView} />
            {!filteredTasks.length ? <TasksEmptyState filtered={Boolean(normalizedSearch || status !== 'all' || priority !== 'all')} onClear={clearFilters} /> : mode === 'boards' && view === 'kanban' ? <KanbanBoard busy={false} counts={counts} tasks={filteredTasks} onOpen={() => undefined} onStatus={changeStatus} /> : <TaskTable busy={false} tasks={filteredTasks} onOpen={() => undefined} onStatus={changeStatus} />}
            <WorklistPagination page={1} pageSize={20} total={filteredTasks.length} totalPages={filteredTasks.length ? 1 : 0} busy={false} onPage={() => undefined} onPageSize={() => undefined} />
          </section>
        </div>
        {dialog === 'board' ? <CreateBoardDialog allowShared busy={false} error={null} onClose={() => setDialog(null)} onSubmit={(input) => {
          const newBoard: SygTaskBoard = { ...initialBoards[0], id: crypto.randomUUID(), name: input.name, description: input.description, scope: input.scope, version: 1, openTaskCount: 0 }
          setBoards((current) => [...current, newBoard])
          setDialog(null)
          setSuccess('Board created in the isolated visual fixture.')
        }} /> : null}
        {dialog === 'task' && selectedBoard ? <CreateTaskDialog boardName={selectedBoard.name} members={members} employeeId={actorId} canAssignOthers busy={false} error={null} onClose={() => setDialog(null)} onSubmit={createTask} /> : null}
        {dialog === 'settings' ? <BoardSettingsDialog workspace={workspace} busy={false} error={null} onClose={() => setDialog(null)} onArchived={() => { setDialog(null); setMode('my-work'); setSuccess('Board archived in the isolated visual fixture.') }} act={act} /> : null}
      </section>
    </main>
    </div>
  )
}

const params = new URLSearchParams(window.location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme
createRoot(document.getElementById('root')!).render(<SygTasksVisualFixture />)

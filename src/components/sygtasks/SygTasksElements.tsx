import type { CSSProperties } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Ban,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  Columns3,
  List,
  MessageSquare,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  UserRoundX,
} from 'lucide-react'
import {
  formatSygTaskPriority,
  formatSygTaskStatus,
  sygTaskPriorities,
  sygTaskStatuses,
  type SygTask,
  type SygTaskBoard,
  type SygTaskPriority,
  type SygTaskStatus,
  type SygTasksWorklistSummary,
} from '../../data/sygtasks'
import { employeeInitials, formatTaskDue, taskDueState } from '../../lib/sygtasksPresentation'

export type SygTasksMode = 'my-work' | 'boards'
export type SygTasksView = 'kanban' | 'list'

export function TaskStatusBadge({ status }: { status: SygTaskStatus }) {
  return <span className={`sygtasks-chip sygtasks-chip--status-${status}`}><span aria-hidden="true" className="sygtasks-chip__dot" />{formatSygTaskStatus(status)}</span>
}

export function TaskPriorityBadge({ priority }: { priority: SygTaskPriority }) {
  return <span className={`sygtasks-chip sygtasks-chip--priority-${priority}`}>{priority === 'urgent' ? <AlertTriangle aria-hidden="true" size={14} /> : null}{formatSygTaskPriority(priority)}</span>
}

export function AssigneeStack({ task }: { task: SygTask }) {
  if (!task.assignees.length) return <span className="sygtasks-unassigned"><UserRoundX aria-hidden="true" size={15} />Unassigned</span>
  return (
    <span className="sygtasks-assignees" aria-label={`Assigned to ${task.assignees.map((person) => person.name).join(', ')}`}>
      <span className="sygtasks-avatars" aria-hidden="true">
        {task.assignees.slice(0, 3).map((person) => <span key={person.id} title={person.name}>{employeeInitials(person.name)}</span>)}
        {task.assignees.length > 3 ? <span>+{task.assignees.length - 3}</span> : null}
      </span>
      <span className="sygtasks-assignees__names">{task.assignees.map((person) => person.name).join(', ')}</span>
    </span>
  )
}

function TaskAttention({ task, referenceTime }: { task: SygTask; referenceTime?: string }) {
  const dueState = taskDueState(task, referenceTime)
  return (
    <span className="sygtasks-attention">
      {dueState === 'overdue' ? <span className="sygtasks-attention--overdue"><AlertTriangle aria-hidden="true" size={14} />Overdue</span> : null}
      {dueState === 'today' ? <span className="sygtasks-attention--today"><Clock3 aria-hidden="true" size={14} />Due today</span> : null}
      {task.status === 'blocked' ? <span className="sygtasks-attention--blocked"><Ban aria-hidden="true" size={14} />Blocked</span> : null}
    </span>
  )
}

export function SygTasksHeader({ fetching, onCreateBoard, onRefresh }: { fetching: boolean; onCreateBoard: () => void; onRefresh: () => void }) {
  return (
    <header className="sygtasks-header">
      <div className="sygtasks-header__identity">
        <img aria-hidden="true" className="sygtasks-header__logo" src="/branding/sygtasks-logo.png" alt="" />
        <div className="sygtasks-header__copy">
          <p>SYGSHIFT WORK MANAGEMENT</p>
          <h1 id="sygtasks-title">SygTasks</h1>
          <span>Organize · Own · Progress · Complete</span>
        </div>
      </div>
      <div className="sygtasks-header__actions">
        <button type="button" className="sygtasks-button sygtasks-button--secondary" aria-label="Refresh SygTasks" disabled={fetching} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className={fetching ? 'spin' : ''} size={18} />{fetching ? 'Refreshing…' : 'Refresh'}
        </button>
        <button type="button" className="sygtasks-button sygtasks-button--primary" onClick={onCreateBoard}><Plus aria-hidden="true" size={18} />New Board</button>
      </div>
    </header>
  )
}

export function SygTasksPrimaryTabs({ boardCount, mode, taskCount, onChange }: { boardCount: number; mode: SygTasksMode; taskCount: number; onChange: (mode: SygTasksMode) => void }) {
  return (
    <nav className="sygtasks-mode-tabs" aria-label="SygTasks workspaces">
      <button type="button" aria-current={mode === 'my-work' ? 'page' : undefined} onClick={() => onChange('my-work')}>My Work <span>{taskCount}</span></button>
      <button type="button" aria-current={mode === 'boards' ? 'page' : undefined} onClick={() => onChange('boards')}>Boards <span>{boardCount}</span></button>
    </nav>
  )
}

export function SygTasksSummary({ summary }: { summary: SygTasksWorklistSummary }) {
  const cards = [
    { label: 'Due Today', value: summary.dueToday, icon: CalendarClock, tone: 'today' },
    { label: 'In Progress', value: summary.inProgress, icon: PlayCircle, tone: 'progress' },
    { label: 'Upcoming', value: summary.upcoming, icon: CalendarRange, tone: 'upcoming' },
    { label: 'Completed This Month', value: summary.completedThisMonth, icon: BadgeCheck, tone: 'complete' },
  ] as const
  return (
    <section className="sygtasks-summary" aria-label="My Work summary">
      {cards.map(({ icon: Icon, label, tone, value }) => <article className={`sygtasks-summary__card sygtasks-summary__card--${tone}`} key={label}><Icon aria-hidden="true" size={21} /><div><span>{label}</span><strong>{value}</strong></div></article>)}
    </section>
  )
}

export function BoardRail({ boards, selectedId, onAdd, onSelect }: { boards: SygTaskBoard[]; selectedId?: string | null; onAdd: () => void; onSelect: (board: SygTaskBoard) => void }) {
  return (
    <aside className="sygtasks-board-rail">
      <header><div><p>Workspace</p><h2>Boards</h2></div><button type="button" className="sygtasks-icon-button" aria-label="Create board" onClick={onAdd}><Plus aria-hidden="true" /></button></header>
      <nav aria-label="Task boards">
        {boards.map((board) => (
          <button key={board.id} type="button" aria-current={selectedId === board.id ? 'page' : undefined} onClick={() => onSelect(board)}>
            <span className="sygtasks-board-rail__copy"><strong title={board.name}>{board.name}</strong><small><span>{board.scope}</span> · {board.ownerName}</small></span>
            <span className="sygtasks-board-rail__count" aria-label={`${board.openTaskCount ?? 0} open tasks`}>{board.openTaskCount ?? 0}</span>
            <ChevronRight aria-hidden="true" size={17} />
          </button>
        ))}
        {!boards.length ? <div className="sygtasks-board-rail__empty"><ClipboardList aria-hidden="true" size={22} /><span>No authorized boards yet.</span></div> : null}
      </nav>
    </aside>
  )
}

export function TaskToolbar({ mode, priority, search, status, view, onPriority, onSearch, onStatus, onView }: {
  mode: SygTasksMode
  priority: SygTaskPriority | 'all'
  search: string
  status: SygTaskStatus | 'all'
  view: SygTasksView
  onPriority: (value: SygTaskPriority | 'all') => void
  onSearch: (value: string) => void
  onStatus: (value: SygTaskStatus | 'all') => void
  onView: (value: SygTasksView) => void
}) {
  return (
    <div className="sygtasks-toolbar">
      <label className="sygtasks-toolbar__search"><span>Search</span><span className="sygtasks-toolbar__control"><Search aria-hidden="true" size={18} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Tasks, descriptions, people, labels, or boards" /></span></label>
      <label><span>Status</span><select value={status} onChange={(event) => onStatus(event.target.value as SygTaskStatus | 'all')}><option value="all">All statuses</option>{sygTaskStatuses.map((item) => <option key={item} value={item}>{formatSygTaskStatus(item)}</option>)}</select></label>
      <label><span>Priority</span><select value={priority} onChange={(event) => onPriority(event.target.value as SygTaskPriority | 'all')}><option value="all">All priorities</option>{sygTaskPriorities.map((item) => <option key={item} value={item}>{formatSygTaskPriority(item)}</option>)}</select></label>
      {mode === 'boards' ? <div className="sygtasks-view-toggle" role="group" aria-label="Task view"><button type="button" aria-pressed={view === 'kanban'} onClick={() => onView('kanban')}><Columns3 aria-hidden="true" size={17} />Board</button><button type="button" aria-pressed={view === 'list'} onClick={() => onView('list')}><List aria-hidden="true" size={17} />List</button></div> : null}
    </div>
  )
}

function Progress({ task }: { task: SygTask }) {
  const percentage = task.checklist.total ? Math.round((task.checklist.completed / task.checklist.total) * 100) : 0
  return <span className="sygtasks-task-progress"><span className="sygtasks-task-progress__bar" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></span><span>{task.checklist.completed}/{task.checklist.total}</span></span>
}

export function TaskTable({ busy, referenceTime, tasks, onOpen, onStatus }: { busy: boolean; referenceTime?: string; tasks: SygTask[]; onOpen: (task: SygTask) => void; onStatus: (task: SygTask, status: SygTaskStatus) => void }) {
  return (
    <div className="sygtasks-table-wrap">
      <table className="sygtasks-table">
        <thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Board</th><th>Assignee</th><th>Due</th><th>Progress</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
        <tbody>{tasks.map((task) => <tr key={task.id} className={`sygtasks-row sygtasks-row--${taskDueState(task, referenceTime)}`}>
          <th scope="row"><button type="button" className="sygtasks-task-link" onClick={() => onOpen(task)}><strong>{task.title}</strong><span>{task.description || 'No description provided.'}</span><TaskAttention task={task} referenceTime={referenceTime} /></button></th>
          <td>{task.canUpdateStatus ? <label className="sygtasks-inline-status"><span className="visually-hidden">Status for {task.title}</span><select value={task.status} disabled={busy} onChange={(event) => onStatus(task, event.target.value as SygTaskStatus)}>{sygTaskStatuses.map((item) => <option key={item} value={item}>{formatSygTaskStatus(item)}</option>)}</select></label> : <TaskStatusBadge status={task.status} />}</td>
          <td><TaskPriorityBadge priority={task.priority} /></td>
          <td><span className="sygtasks-board-name">{task.boardName || 'Current board'}</span></td>
          <td><AssigneeStack task={task} /></td>
          <td><span className={`sygtasks-due sygtasks-due--${taskDueState(task, referenceTime)}`}>{formatTaskDue(task.dueAt)}</span></td>
          <td><Progress task={task} /></td>
          <td><button type="button" className="sygtasks-row-action" onClick={() => onOpen(task)}>Open<span className="visually-hidden"> {task.title}</span><ArrowRight aria-hidden="true" size={16} /></button></td>
        </tr>)}</tbody>
      </table>
    </div>
  )
}

export function TaskCard({ busy, referenceTime, task, onOpen, onStatus }: { busy: boolean; referenceTime?: string; task: SygTask; onOpen: () => void; onStatus: (status: SygTaskStatus) => void }) {
  const dueState = taskDueState(task, referenceTime)
  return (
    <article className={`sygtasks-card sygtasks-card--${task.priority} sygtasks-card--due-${dueState}`}>
      <div className="sygtasks-card__labels">{task.labels.map((label) => <span key={label.id} style={{ '--task-label': label.color } as CSSProperties}>{label.name}</span>)}</div>
      <button type="button" className="sygtasks-card__open" onClick={onOpen} aria-label={`Open ${task.title}`}><strong>{task.title}</strong><span>{task.description || 'No description provided.'}</span></button>
      <TaskAttention task={task} referenceTime={referenceTime} />
      <div className="sygtasks-card__badges"><TaskPriorityBadge priority={task.priority} /><span className={`sygtasks-due sygtasks-due--${dueState}`}>{formatTaskDue(task.dueAt)}</span></div>
      <div className="sygtasks-card__footer"><AssigneeStack task={task} /><span aria-label={`${task.checklist.completed} of ${task.checklist.total} checklist items complete`}><CheckCircle2 aria-hidden="true" size={15} />{task.checklist.completed}/{task.checklist.total}</span><span aria-label={`${task.commentCount} comments`}><MessageSquare aria-hidden="true" size={15} />{task.commentCount}</span></div>
      {task.canUpdateStatus ? <label className="sygtasks-card__status"><span>Status</span><select value={task.status} disabled={busy} onChange={(event) => onStatus(event.target.value as SygTaskStatus)}>{sygTaskStatuses.map((item) => <option key={item} value={item}>{formatSygTaskStatus(item)}</option>)}</select></label> : <TaskStatusBadge status={task.status} />}
    </article>
  )
}

export function KanbanBoard({ busy, counts, referenceTime, tasks, onOpen, onStatus }: { busy: boolean; counts: Record<SygTaskStatus, number>; referenceTime?: string; tasks: SygTask[]; onOpen: (task: SygTask) => void; onStatus: (task: SygTask, status: SygTaskStatus) => void }) {
  return (
    <div className="sygtasks-kanban-shell">
      <div className="sygtasks-kanban" aria-label="Kanban board">
        {sygTaskStatuses.map((status) => {
          const columnTasks = tasks.filter((task) => task.status === status)
          return <section key={status} className={`sygtasks-column sygtasks-column--${status}`}><header><h3>{formatSygTaskStatus(status)}</h3><span aria-label={`${counts[status]} tasks`}>{counts[status]}</span></header><div>{columnTasks.map((task) => <TaskCard key={task.id} task={task} busy={busy} referenceTime={referenceTime} onOpen={() => onOpen(task)} onStatus={(next) => onStatus(task, next)} />)}{!columnTasks.length ? <p className="sygtasks-column__empty">No tasks on this page</p> : null}{counts[status] > columnTasks.length ? <small className="sygtasks-column__remaining">{counts[status] - columnTasks.length} more in filtered results</small> : null}</div></section>
        })}
      </div>
    </div>
  )
}

export function TasksEmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return <div className="sygtasks-empty"><ClipboardList aria-hidden="true" size={34} /><h3>{filtered ? 'No tasks match these filters' : 'No work here yet'}</h3><p>{filtered ? 'Try a broader search or clear the active filters.' : 'New and assigned work will appear here as it is created.'}</p>{filtered ? <button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={onClear}>Clear filters</button> : null}</div>
}

export function WorklistPagination({ page, pageSize, total, totalPages, busy, onPage, onPageSize }: { page: number; pageSize: 5 | 10 | 20 | 50; total: number; totalPages: number; busy: boolean; onPage: (page: number) => void; onPageSize: (size: 5 | 10 | 20 | 50) => void }) {
  const safePages = Math.max(totalPages, total ? 1 : 0)
  return (
    <footer className="sygtasks-pagination">
      <span>{total ? `Page ${page} of ${safePages} · ${total} task${total === 1 ? '' : 's'}` : '0 tasks'}</span>
      <label><span>Rows</span><select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value) as 5 | 10 | 20 | 50)}><option value="5">5</option><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label>
      <button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft aria-hidden="true" size={17} />Previous</button>
      <button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={busy || !safePages || page >= safePages} onClick={() => onPage(page + 1)}>Next<ChevronRight aria-hidden="true" size={17} /></button>
    </footer>
  )
}

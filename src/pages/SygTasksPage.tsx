import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Archive, Bell, BellOff, Check, CheckCircle2, ChevronRight, Circle, ClipboardList, Columns3, History, List, MessageSquare, Plus, RefreshCw, Search, Settings2, Tag, Users } from 'lucide-react'
import { ModalDialog } from '../components/ModalDialog'
import { formatSygTaskPriority, formatSygTaskStatus, getSygTasksWorkspace, mutateSygTasks, sygTaskPath, sygTaskPriorities, sygTaskStatuses, type SygTask, type SygTaskAction, type SygTaskDetail, type SygTaskPriority, type SygTaskStatus, type SygTasksWorkspace } from '../data/sygtasks'
import { getSupabaseClient } from '../lib/supabase'
import '../styles/sygtasks.css'

type WorkspaceMode = 'my-work' | 'boards'
type BoardView = 'kanban' | 'list'
const formatSTaskStatus = formatSygTaskStatus

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="sygtasks-notice sygtasks-notice--error" role="alert">{error instanceof Error ? error.message : 'SygTasks could not complete this request.'}</p>
}

function SuccessNotice({ message }: { message: string | null }) {
  return message ? <p className="sygtasks-notice sygtasks-notice--success" role="status">{message}</p> : null
}

function TaskStatus({ status }: { status: SygTaskStatus }) {
  return <span className={`sygtasks-chip sygtasks-chip--status-${status}`}>{formatSygTaskStatus(status)}</span>
}

function TaskPriority({ priority }: { priority: SygTaskPriority }) {
  return <span className={`sygtasks-chip sygtasks-chip--priority-${priority}`}>{formatSygTaskPriority(priority)}</span>
}

function formatDue(value: string | null) {
  if (!value) return 'No due date'
  const due = new Date(value)
  if (Number.isNaN(due.valueOf())) return 'No due date'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: '2-digit', day: '2-digit', year: 'numeric' }).format(due)
}

function dueClass(value: string | null, status: SygTaskStatus) {
  if (!value || status === 'done' || status === 'canceled') return ''
  const time = Date.parse(value)
  if (time < Date.now()) return ' sygtasks-due--late'
  if (time - Date.now() < 86_400_000) return ' sygtasks-due--soon'
  return ''
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

function AssigneeStack({ task }: { task: SygTask }) {
  if (!task.assignees.length) return <span className="sygtasks-unassigned">Unassigned</span>
  return <span className="sygtasks-avatars" aria-label={`Assigned to ${task.assignees.map((person) => person.name).join(', ')}`}>
    {task.assignees.slice(0, 3).map((person) => <span key={person.id} aria-hidden="true" title={person.name}>{initials(person.name)}</span>)}
    {task.assignees.length > 3 ? <span aria-hidden="true">+{task.assignees.length - 3}</span> : null}
  </span>
}

function TaskCard({ task, onOpen, onStatus, busy }: { task: SygTask; onOpen: () => void; onStatus: (status: SygTaskStatus) => void; busy: boolean }) {
  return <article className={`sygtasks-card sygtasks-card--${task.priority}`}>
    <button type="button" className="sygtasks-card__open" onClick={onOpen} aria-label={`Open ${task.title}`}>
      <span className="sygtasks-card__labels">{task.labels.map((label) => <span key={label.id} style={{ '--task-label': label.color } as CSSProperties}>{label.name}</span>)}</span>
      <strong>{task.title}</strong>
      {task.description ? <span className="sygtasks-card__description">{task.description}</span> : null}
    </button>
    <div className="sygtasks-card__meta">
      <TaskPriority priority={task.priority} />
      <span className={`sygtasks-due${dueClass(task.dueAt, task.status)}`}>{formatDue(task.dueAt)}</span>
    </div>
    <div className="sygtasks-card__footer">
      <AssigneeStack task={task} />
      <span aria-label={`${task.checklist.completed} of ${task.checklist.total} checklist items complete`}><CheckCircle2 size={15} /> {task.checklist.completed}/{task.checklist.total}</span>
      <span aria-label={`${task.commentCount} comments`}><MessageSquare size={15} /> {task.commentCount}</span>
    </div>
    {task.canUpdateStatus ? <label className="sygtasks-card__status"><span className="sr-only">Change status for {task.title}</span><select value={task.status} disabled={busy} onChange={(event) => onStatus(event.target.value as SygTaskStatus)}>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select></label> : <TaskStatus status={task.status} />}
  </article>
}

function TaskList({ tasks, onOpen, onStatus, busy }: { tasks: SygTask[]; onOpen: (task: SygTask) => void; onStatus: (task: SygTask, status: SygTaskStatus) => void; busy: boolean }) {
  if (!tasks.length) return <div className="sygtasks-empty"><ClipboardList size={32} /><h3>No work here yet</h3><p>New and assigned work will appear here.</p></div>
  return <div className="sygtasks-table-wrap"><table className="sygtasks-table"><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Assignees</th><th>Due</th><th>Progress</th></tr></thead><tbody>
    {tasks.map((task) => <tr key={task.id}>
      <th scope="row"><button type="button" onClick={() => onOpen(task)}>{task.title}<span>{task.boardName ?? task.description}</span></button></th>
      <td>{task.canUpdateStatus ? <select aria-label={`Status for ${task.title}`} value={task.status} disabled={busy} onChange={(event) => onStatus(task, event.target.value as SygTaskStatus)}>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select> : <TaskStatus status={task.status} />}</td>
      <td><TaskPriority priority={task.priority} /></td><td><AssigneeStack task={task} /></td>
      <td><span className={`sygtasks-due${dueClass(task.dueAt, task.status)}`}>{formatDue(task.dueAt)}</span></td>
      <td>{task.checklist.completed}/{task.checklist.total}</td>
    </tr>)}
  </tbody></table></div>
}

function FormField({ label, optional, children }: { label: string; optional?: boolean; children: ReactNode }) {
  return <label className="sygtasks-field"><span>{label}{optional ? <small>Optional</small> : null}</span>{children}</label>
}

function CreateBoardDialog({ allowShared, busy, error, onClose, onSubmit }: { allowShared: boolean; busy: boolean; error: unknown; onClose: () => void; onSubmit: (input: { name: string; description: string; scope: 'personal' | 'team' | 'company' }) => void }) {
  const [scope, setScope] = useState<'personal' | 'team' | 'company'>('personal')
  return <ModalDialog className="sygtasks-dialog" title="Create a SygTasks board" eyebrow="New workspace" description="Organize personal work or coordinate a shared team." busy={busy} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ name: String(data.get('name') ?? ''), description: String(data.get('description') ?? ''), scope }) }}>
      <div className="sygtasks-form-grid"><FormField label="Board name"><input name="name" required maxLength={120} autoFocus /></FormField><FormField label="Who is this for?"><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="personal">Just me</option>{allowShared ? <><option value="team">A team</option><option value="company">The company</option></> : null}</select></FormField></div>
      <FormField label="Description" optional><textarea name="description" maxLength={2000} rows={4} /></FormField>
      <ErrorNotice error={error} /><div className="sygtasks-dialog__actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create board'}</button></div>
    </form>
  </ModalDialog>
}

function CreateTaskDialog({ boardName, busy, error, onClose, onSubmit }: { boardName: string; busy: boolean; error: unknown; onClose: () => void; onSubmit: (input: { title: string; description: string; status: SygTaskStatus; priority: SygTaskPriority; dueAt: string | null }) => void }) {
  return <ModalDialog className="sygtasks-dialog" title="Create a task" eyebrow={boardName} description="Give the work a clear owner, outcome, and due date." busy={busy} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const due = String(data.get('dueAt') ?? ''); onSubmit({ title: String(data.get('title') ?? ''), description: String(data.get('description') ?? ''), status: String(data.get('status')) as SygTaskStatus, priority: String(data.get('priority')) as SygTaskPriority, dueAt: due ? new Date(due).toISOString() : null }) }}>
      <FormField label="Task title"><input name="title" required maxLength={240} autoFocus /></FormField>
      <FormField label="Description" optional><textarea name="description" maxLength={10000} rows={5} placeholder="What needs to be completed? Include the outcome and any important context." /></FormField>
      <div className="sygtasks-form-grid"><FormField label="Starting status"><select name="status" defaultValue="backlog">{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select></FormField><FormField label="Priority"><select name="priority" defaultValue="routine">{sygTaskPriorities.map((priority) => <option key={priority} value={priority}>{formatSygTaskPriority(priority)}</option>)}</select></FormField><FormField label="Due date and time" optional><input name="dueAt" type="datetime-local" /></FormField></div>
      <ErrorNotice error={error} /><div className="sygtasks-dialog__actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button></div>
    </form>
  </ModalDialog>
}

interface DetailProps {
  workspace: SygTasksWorkspace
  detail: SygTaskDetail
  busy: boolean
  error: unknown
  onClose: () => void
  act: (action: SygTaskAction, payload: Record<string, unknown>, expectedVersion?: number) => Promise<void>
}

function TaskDetailDialog({ workspace, detail, busy, error, onClose, act }: DetailProps) {
  const [section, setSection] = useState<'overview' | 'people' | 'checklist' | 'comments' | 'activity'>('overview')
  const [editing, setEditing] = useState(false)
  const assigned = new Set(detail.assignees.map((person) => person.id))
  const appliedLabels = new Set(detail.labels.map((label) => label.id))
  const dependencyIds = new Set(detail.dependencies.map((dependency) => dependency.taskId))
  const boardCandidates = workspace.tasks.filter((task) => task.id !== detail.id && !dependencyIds.has(task.id))
  const dueInput = detail.dueAt ? new Date(detail.dueAt).toISOString().slice(0, 16) : ''
  return <ModalDialog className="sygtasks-detail-dialog" title={detail.title} eyebrow={`${workspace.selectedBoard?.name ?? 'SygTasks'} · ${formatSygTaskStatus(detail.status)}`} description={`${formatSygTaskPriority(detail.priority)} priority · Updated ${formatDue(detail.updatedAt)}`} busy={busy} onClose={onClose}>
    <nav className="sygtasks-detail-tabs" aria-label="Task details">{([['overview', 'Overview'], ['people', 'People'], ['checklist', 'Checklist'], ['comments', `Comments (${detail.commentCount})`], ['activity', 'Activity']] as const).map(([value, label]) => <button type="button" key={value} aria-current={section === value ? 'page' : undefined} onClick={() => setSection(value)}>{label}</button>)}</nav>
    <ErrorNotice error={error} />
    {section === 'overview' ? <div className="sygtasks-detail-section">
      {editing && detail.canEdit ? <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const due = String(data.get('dueAt') ?? ''); void act('update_task', { taskId: detail.id, title: String(data.get('title') ?? ''), description: String(data.get('description') ?? ''), status: data.get('status'), priority: data.get('priority'), dueAt: due ? new Date(due).toISOString() : null }, detail.version).then(() => setEditing(false)) }}>
        <FormField label="Task title"><input name="title" defaultValue={detail.title} maxLength={240} required /></FormField>
        <FormField label="Description" optional><textarea name="description" defaultValue={detail.description} maxLength={10000} rows={6} /></FormField>
        <div className="sygtasks-form-grid"><FormField label="Status"><select name="status" defaultValue={detail.status}>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select></FormField><FormField label="Priority"><select name="priority" defaultValue={detail.priority}>{sygTaskPriorities.map((priority) => <option key={priority} value={priority}>{formatSygTaskPriority(priority)}</option>)}</select></FormField><FormField label="Due date and time" optional><input name="dueAt" type="datetime-local" defaultValue={dueInput} /></FormField></div>
        <div className="sygtasks-inline-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" disabled={busy}>Save changes</button></div>
      </form> : <>
        <div className="sygtasks-detail-summary"><div><span>Status</span><TaskStatus status={detail.status} /></div><div><span>Priority</span><TaskPriority priority={detail.priority} /></div><div><span>Due</span><strong className={`sygtasks-due${dueClass(detail.dueAt, detail.status)}`}>{formatDue(detail.dueAt)}</strong></div><div><span>Progress</span><strong>{detail.checklist.completed} of {detail.checklist.total}</strong></div></div>
        <section className="sygtasks-description"><h3>Description</h3><p>{detail.description || 'No description has been added yet.'}</p></section>
        <div className="sygtasks-inline-actions">{detail.canEdit ? <button type="button" onClick={() => setEditing(true)}>Edit details</button> : null}{detail.canUpdateStatus && !detail.canEdit ? <select aria-label="Update task status" value={detail.status} disabled={busy} onChange={(event) => void act('update_task', { taskId: detail.id, status: event.target.value }, detail.version)}>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select> : null}{detail.canEdit ? <button type="button" className="danger-button" disabled={busy} onClick={() => { if (window.confirm('Archive this task? Its history will be preserved.')) void act('archive_task', { taskId: detail.id }, detail.version).then(onClose) }}><Archive size={16} /> Archive</button> : null}</div>
      </>}
      <section className="sygtasks-labels"><h3><Tag size={17} /> Labels</h3><div>{workspace.labels.map((label) => <button type="button" key={label.id} className={appliedLabels.has(label.id) ? 'is-active' : ''} style={{ '--task-label': label.color } as CSSProperties} disabled={busy || !detail.canEdit} onClick={() => void act(appliedLabels.has(label.id) ? 'remove_label' : 'apply_label', { taskId: detail.id, labelId: label.id })}>{appliedLabels.has(label.id) ? <Check size={14} /> : null}{label.name}</button>)}</div>{detail.canEdit ? <form className="sygtasks-compact-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void act('create_label', { boardId: detail.boardId, name: data.get('name'), color: data.get('color') }).then(() => event.currentTarget.reset()) }}><input name="name" aria-label="New label name" placeholder="New label" maxLength={50} required /><input name="color" aria-label="Label color" type="color" defaultValue="#d7a944" /><button type="submit" disabled={busy}>Add</button></form> : null}</section>
      <section className="sygtasks-dependencies"><h3>Dependencies</h3>{detail.dependencies.length ? <ul>{detail.dependencies.map((dependency) => <li key={dependency.id}><span>{dependency.title} <TaskStatus status={dependency.status} /></span>{detail.canEdit ? <button type="button" className="icon-button" aria-label={`Remove dependency ${dependency.title}`} disabled={busy} onClick={() => void act('remove_dependency', { taskId: detail.id, dependsOnTaskId: dependency.taskId })}>×</button> : null}</li>)}</ul> : <p>No dependencies.</p>}{detail.canEdit && boardCandidates.length ? <form className="sygtasks-compact-form" onSubmit={(event) => { event.preventDefault(); const select = event.currentTarget.elements.namedItem('dependency') as HTMLSelectElement; void act('add_dependency', { taskId: detail.id, dependsOnTaskId: select.value }) }}><select name="dependency" aria-label="Task dependency">{boardCandidates.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button type="submit" disabled={busy}>Add dependency</button></form> : null}</section>
    </div> : null}
    {section === 'people' ? <div className="sygtasks-detail-section"><section><h3><Users size={18} /> Assignees</h3><div className="sygtasks-people-grid">{workspace.members.map((member) => <label key={member.employeeId}><input type="checkbox" checked={assigned.has(member.employeeId)} disabled={busy || !detail.canEdit} onChange={() => void act(assigned.has(member.employeeId) ? 'unassign_task' : 'assign_task', { taskId: detail.id, employeeId: member.employeeId })} /><span>{initials(member.name)}</span><strong>{member.name}<small>@{member.username}</small></strong></label>)}</div></section><section><h3>{detail.watching ? <Bell size={18} /> : <BellOff size={18} />} Following this task</h3><p>Followers receive SygShift notifications when important task details change.</p><button type="button" disabled={busy} onClick={() => void act(detail.watching ? 'unwatch_task' : 'watch_task', { taskId: detail.id })}>{detail.watching ? 'Stop following' : 'Follow task'}</button><p className="sygtasks-muted">{detail.watchers.length} follower{detail.watchers.length === 1 ? '' : 's'}: {detail.watchers.map((watcher) => watcher.name).join(', ') || 'None'}</p></section></div> : null}
    {section === 'checklist' ? <div className="sygtasks-detail-section"><section><h3><CheckCircle2 size={18} /> Checklist</h3><div className="sygtasks-progress"><span style={{ width: `${detail.checklist.total ? (detail.checklist.completed / detail.checklist.total) * 100 : 0}%` }} /></div><ul className="sygtasks-checklist">{detail.checklistItems.map((item) => <li key={item.id}><button type="button" className="icon-button" aria-label={`${item.completedAt ? 'Mark incomplete' : 'Mark complete'}: ${item.title}`} disabled={busy || !detail.canEdit} onClick={() => void act('update_checklist_item', { checklistItemId: item.id, completed: !item.completedAt }, item.version)}>{item.completedAt ? <CheckCircle2 /> : <Circle />}</button><span className={item.completedAt ? 'is-complete' : ''}>{item.title}</span>{detail.canEdit ? <button type="button" className="icon-button" aria-label={`Remove ${item.title}`} onClick={() => void act('archive_checklist_item', { checklistItemId: item.id }, item.version)}>×</button> : null}</li>)}</ul>{detail.canEdit ? <form className="sygtasks-compact-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void act('add_checklist_item', { taskId: detail.id, title: data.get('title') }).then(() => event.currentTarget.reset()) }}><input name="title" placeholder="Add a checklist item" aria-label="Checklist item" maxLength={500} required /><button type="submit" disabled={busy}>Add item</button></form> : null}</section></div> : null}
    {section === 'comments' ? <div className="sygtasks-detail-section"><section><h3><MessageSquare size={18} /> Discussion</h3><ol className="sygtasks-comments">{detail.comments.map((comment) => <li key={comment.id}><span>{initials(comment.authorName)}</span><div><header><strong>{comment.authorName}</strong><time>{formatDue(comment.createdAt)}{comment.editedAt ? ' · edited' : ''}</time></header><p>{comment.body}</p>{comment.canEdit ? <button type="button" className="text-button" disabled={busy} onClick={() => { const body = window.prompt('Edit comment', comment.body); if (body?.trim()) void act('edit_comment', { commentId: comment.id, body }, comment.version) }}>Edit</button> : null}</div></li>)}</ol><form className="sygtasks-comment-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void act('add_comment', { taskId: detail.id, body: data.get('body') }).then(() => event.currentTarget.reset()) }}><FormField label="Add a comment"><textarea name="body" rows={4} maxLength={5000} required placeholder="Share an update, question, or decision." /></FormField><button type="submit" disabled={busy}>Post comment</button></form></section></div> : null}
    {section === 'activity' ? <div className="sygtasks-detail-section"><section><h3><History size={18} /> Activity</h3><ol className="sygtasks-activity">{detail.activity.map((item) => <li key={item.id}><span /><div><strong>{item.actorName}</strong> {item.action.replaceAll('.', ' ')}<time>{formatDue(item.createdAt)}</time></div></li>)}</ol></section></div> : null}
  </ModalDialog>
}

function BoardSettingsDialog({ workspace, busy, error, onClose, act }: { workspace: SygTasksWorkspace; busy: boolean; error: unknown; onClose: () => void; act: DetailProps['act'] }) {
  const board = workspace.selectedBoard
  if (!board) return null
  return <ModalDialog className="sygtasks-dialog" title="Board settings" eyebrow={board.name} description="Manage the board and who can work in it." busy={busy} onClose={onClose}>
    <ErrorNotice error={error} />
    <section><h3>Members</h3><div className="sygtasks-member-admin">{workspace.availableMembers.map((member) => <div key={member.employeeId}><span>{initials(member.name)}</span><strong>{member.name}<small>@{member.username}</small></strong>{member.isMember ? member.role === 'owner' ? <em>Owner</em> : <button type="button" className="secondary-button" disabled={busy} onClick={() => void act('remove_board_member', { boardId: board.id, employeeId: member.employeeId })}>Remove</button> : <button type="button" disabled={busy} onClick={() => void act('add_board_member', { boardId: board.id, employeeId: member.employeeId, memberRole: 'member' })}>Add</button>}</div>)}</div></section>
    <div className="sygtasks-dialog__actions"><button type="button" className="danger-button" disabled={busy} onClick={() => { if (window.confirm('Archive this board? Task history will be preserved.')) void act('archive_board', { boardId: board.id }, board.version).then(onClose) }}><Archive size={16} /> Archive board</button><button type="button" onClick={onClose}>Done</button></div>
  </ModalDialog>
}

export function SygTasksPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const boardId = params.get('board')
  const taskId = params.get('task')
  const [mode, setMode] = useState<WorkspaceMode>(boardId ? 'boards' : 'my-work')
  const [view, setView] = useState<BoardView>('kanban')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<SygTaskStatus | 'all'>('all')
  const [priorityFilter, setPriorityFilter] = useState<SygTaskPriority | 'all'>('all')
  const [createBoard, setCreateBoard] = useState(false)
  const [createTask, setCreateTask] = useState(false)
  const [boardSettings, setBoardSettings] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const workspaceQuery = useInfiniteQuery({
    queryKey: ['sygtasks', boardId, taskId],
    queryFn: ({ pageParam }) => getSygTasksWorkspace({ boardId, taskId, cursor: pageParam, pageSize: 20 }),
    initialPageParam: null as { updatedAt: string; taskId: string } | null,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const action = useMutation({ mutationFn: ({ kind, payload, expectedVersion }: { kind: SygTaskAction; payload: Record<string, unknown>; expectedVersion?: number }) => mutateSygTasks(kind, payload, { expectedVersion }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sygtasks'] }) })
  const workspace = workspaceQuery.data?.pages[0]
  const boardTasks = useMemo(() => {
    const seen = new Set<string>()
    return (workspaceQuery.data?.pages.flatMap((page) => page.tasks) ?? []).filter((task) => !seen.has(task.id) && Boolean(seen.add(task.id)))
  }, [workspaceQuery.data?.pages])
  const act = async (kind: SygTaskAction, payload: Record<string, unknown>, expectedVersion?: number) => { setSuccess(null); await action.mutateAsync({ kind, payload, expectedVersion }) }
  useEffect(() => {
    if (!workspace?.employeeId) return
    const client = getSupabaseClient(); let disposed = false; let channel: ReturnType<typeof client.channel> | undefined
    const refresh = () => { if (!disposed) void queryClient.invalidateQueries({ queryKey: ['sygtasks'] }) }
    void client.auth.getSession().then(({ data }) => { if (disposed || !data.session) return; channel = client.channel(`employee:${data.session.user.id}`, { config: { private: true } }).on('broadcast', { event: 'changed' }, refresh).subscribe((status) => { if (status === 'SUBSCRIBED') refresh() }) }).catch(() => undefined)
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh)
    return () => { disposed = true; window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); if (channel) void client.removeChannel(channel) }
  }, [queryClient, workspace?.employeeId])
  const visibleTasks = useMemo(() => {
    const source = mode === 'my-work' ? workspace?.myTasks ?? [] : boardTasks
    const query = search.trim().toLocaleLowerCase()
    return source.filter((task) => (statusFilter === 'all' || task.status === statusFilter)
      && (priorityFilter === 'all' || task.priority === priorityFilter)
      && (!query || `${task.title} ${task.description} ${task.assignees.map((person) => person.name).join(' ')} ${task.labels.map((label) => label.name).join(' ')}`.toLocaleLowerCase().includes(query)))
  }, [boardTasks, mode, priorityFilter, search, statusFilter, workspace?.myTasks])
  const openTask = (task: SygTask) => { setMode('boards'); navigate(sygTaskPath(task.boardId, task.id)) }
  const changeStatus = (task: SygTask, status: SygTaskStatus) => void act('update_task', { taskId: task.id, status }, task.version)
  if (workspaceQuery.isLoading) return <section className="sygtasks-loading" role="status"><RefreshCw className="spin" /> Opening SygTasks…</section>
  if (workspaceQuery.isError || !workspace) return <section className="sygtasks-unavailable"><ClipboardList size={42} /><h1>SygTasks is unavailable</h1><ErrorNotice error={workspaceQuery.error} /><button type="button" onClick={() => void workspaceQuery.refetch()}>Try again</button><p>Your other SygShift tools remain available.</p></section>
  return <section className="sygtasks-workspace">
    <header className="sygtasks-header"><div><span className="sygtasks-header__icon"><ClipboardList /></span><div><p>SygShift work management</p><h1>SygTasks</h1><span>Plan work, assign ownership, and keep progress visible.</span></div></div><div className="sygtasks-header__actions"><button type="button" className="secondary-button" aria-label="Refresh SygTasks" disabled={workspaceQuery.isFetching} onClick={() => void workspaceQuery.refetch()}><RefreshCw className={workspaceQuery.isFetching ? 'spin' : ''} size={18} /> Refresh</button><button type="button" onClick={() => setCreateBoard(true)}><Plus size={18} /> New board</button></div></header>
    <nav className="sygtasks-mode-tabs" aria-label="SygTasks workspaces"><button type="button" aria-current={mode === 'my-work' ? 'page' : undefined} onClick={() => { setMode('my-work'); navigate('/tasks') }}>My Work <span>{workspace.myTasks.length}</span></button><button type="button" aria-current={mode === 'boards' ? 'page' : undefined} onClick={() => setMode('boards')}>Boards <span>{workspace.boards.length}</span></button></nav>
    <SuccessNotice message={success} /><ErrorNotice error={action.error} />
    <div className="sygtasks-layout">
      {mode === 'boards' ? <aside className="sygtasks-board-rail"><header><h2>Boards</h2><button type="button" className="icon-button" aria-label="Create board" onClick={() => setCreateBoard(true)}><Plus /></button></header><nav aria-label="Task boards">{workspace.boards.map((board) => <button key={board.id} type="button" aria-current={workspace.selectedBoard?.id === board.id ? 'page' : undefined} onClick={() => navigate(sygTaskPath(board.id))}><span>{board.name}<small>{board.scope} · {board.ownerName}</small></span><em>{board.openTaskCount ?? 0}</em><ChevronRight /></button>)}</nav></aside> : null}
      <main className="sygtasks-main">
        <header className="sygtasks-main__heading"><div><p>{mode === 'my-work' ? 'Personal focus' : workspace.selectedBoard?.scope ?? 'Workspace'}</p><h2>{mode === 'my-work' ? 'My Work' : workspace.selectedBoard?.name ?? 'Choose a board'}</h2><span>{mode === 'my-work' ? 'Tasks you own, follow, or were assigned.' : workspace.selectedBoard?.description || 'Work shared with this board.'}</span></div>{mode === 'boards' && workspace.selectedBoard ? <div>{workspace.selectedBoard.canManageBoard ? <button type="button" className="secondary-button" onClick={() => setBoardSettings(true)}><Settings2 size={17} /> Board settings</button> : null}{workspace.selectedBoard.canCreateTask ? <button type="button" onClick={() => setCreateTask(true)}><Plus size={17} /> New task</button> : null}</div> : null}</header>
        <div className="sygtasks-toolbar"><label className="sygtasks-toolbar__search"><Search size={18} /><span className="sr-only">Search tasks</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks, people, or labels" /></label><label className="sygtasks-toolbar__filter"><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSTaskStatus(status)}</option>)}</select></label><label className="sygtasks-toolbar__filter"><span className="sr-only">Filter by priority</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}><option value="all">All priorities</option>{sygTaskPriorities.map((priority) => <option key={priority} value={priority}>{formatSygTaskPriority(priority)}</option>)}</select></label><div role="group" aria-label="Task view"><button type="button" aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}><Columns3 size={17} /> Board</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={17} /> List</button></div></div>
        {view === 'list' || mode === 'my-work' ? <TaskList tasks={visibleTasks} onOpen={openTask} onStatus={changeStatus} busy={action.isPending} /> : <div className="sygtasks-kanban" aria-label="Kanban board">{sygTaskStatuses.map((status) => { const tasks = visibleTasks.filter((task) => task.status === status); return <section key={status} className={`sygtasks-column sygtasks-column--${status}`}><header><h3>{formatSygTaskStatus(status)}</h3><span>{tasks.length}</span></header><div>{tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => openTask(task)} onStatus={(next) => changeStatus(task, next)} busy={action.isPending} />)}{!tasks.length ? <p>Nothing here</p> : null}</div></section> })}</div>}
        {mode === 'boards' && workspaceQuery.hasNextPage ? <div className="sygtasks-load-more"><button type="button" className="secondary-button" disabled={workspaceQuery.isFetchingNextPage} onClick={() => void workspaceQuery.fetchNextPage()}>{workspaceQuery.isFetchingNextPage ? 'Loading…' : 'Load more tasks'}</button></div> : null}
      </main>
    </div>
    {createBoard ? <CreateBoardDialog allowShared={workspace.permissions.manageShared} busy={action.isPending} error={action.error} onClose={() => { setCreateBoard(false); action.reset() }} onSubmit={(input) => void act('create_board', input).then(() => { setCreateBoard(false); setSuccess('Board created.'); setMode('boards') })} /> : null}
    {createTask && workspace.selectedBoard ? <CreateTaskDialog boardName={workspace.selectedBoard.name} busy={action.isPending} error={action.error} onClose={() => { setCreateTask(false); action.reset() }} onSubmit={(input) => void act('create_task', { ...input, boardId: workspace.selectedBoard!.id }).then(() => { setCreateTask(false); setSuccess('Task created.') })} /> : null}
    {taskId && workspace.taskDetail ? <TaskDetailDialog key={`${workspace.taskDetail.id}:${workspace.taskDetail.version}`} workspace={workspace} detail={workspace.taskDetail} busy={action.isPending} error={action.error} onClose={() => { action.reset(); navigate(sygTaskPath(workspace.taskDetail!.boardId)) }} act={act} /> : null}
    {boardSettings ? <BoardSettingsDialog workspace={workspace} busy={action.isPending} error={action.error} onClose={() => { setBoardSettings(false); action.reset() }} act={act} /> : null}
  </section>
}

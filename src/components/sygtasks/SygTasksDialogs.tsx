import { cloneElement, isValidElement, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactElement } from 'react'
import { Archive, Bell, BellOff, CalendarClock, Check, CheckCircle2, Circle, MessageSquare, ShieldAlert, Tag, Users } from 'lucide-react'
import { ModalDialog } from '../ModalDialog'
import {
  formatSygTaskPriority,
  formatSygTaskStatus,
  sygTaskPriorities,
  sygTaskRecurrenceFrequencies,
  sygTaskRecurrenceTimeZones,
  sygTaskStatuses,
  type CreateSygTaskInput,
  type CreateSygTaskRecurringSeriesInput,
  type SygTaskAction,
  type SygTaskDetail,
  type SygTasksWorkspace,
} from '../../data/sygtasks'
import { fromOperationalDateTimeInput, toOperationalDateTimeInput } from '../../lib/operationalDateTime'
import { employeeInitials, formatTaskDue, taskDueState } from '../../lib/sygtasksPresentation'
import { TaskPriorityBadge, TaskStatusBadge } from './SygTasksElements'
import { SygTasksActivityPanel } from './SygTasksActivityPanel'
import { SygTasksRemindersPanel } from './SygTasksRemindersPanel'
import { SygTasksRecurringPanel } from './SygTasksRecurringPanel'

export type SygTasksAct = (action: SygTaskAction, payload: Record<string, unknown>, expectedVersion?: number) => Promise<void>

export function SygTasksErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="sygtasks-notice sygtasks-notice--error" role="alert"><ShieldAlert aria-hidden="true" size={18} /><span>{error instanceof Error ? error.message : 'SygTasks could not complete this request.'}</span></p>
}

export function SygTasksSuccessNotice({ message }: { message: string | null }) {
  return message ? <p className="sygtasks-notice sygtasks-notice--success" role="status"><CheckCircle2 aria-hidden="true" size={18} /><span>{message}</span></p> : null
}

function FormField({ children, error, label, optional }: { children: ReactElement; error?: string | null; label: string; optional?: boolean }) {
  const errorId = useId()
  const control = isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, {
    'aria-describedby': error ? errorId : undefined,
    'aria-invalid': error ? true : undefined,
  }) : children
  return (
    <label className={`sygtasks-field${error ? ' sygtasks-field--error' : ''}`}>
      <span>{label}<small>{optional ? 'Optional' : 'Required'}</small></span>
      <span className="sygtasks-field__control">{control}</span>
      {error ? <small className="sygtasks-field__error" id={errorId}>{error}</small> : null}
    </label>
  )
}

export function CreateBoardDialog({ allowShared, busy, error, onClose, onSubmit }: {
  allowShared: boolean
  busy: boolean
  error: unknown
  onClose: () => void
  onSubmit: (input: { name: string; description: string; scope: 'personal' | 'team' | 'company' }, clientRequestId: string) => void
}) {
  const [scope, setScope] = useState<'personal' | 'team' | 'company'>('personal')
  const [nameError, setNameError] = useState<string | null>(null)
  const lastSubmission = useRef<{ fingerprint: string; id: string } | null>(null)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const name = String(data.get('name') ?? '').trim()
    if (name.length < 2) { setNameError('Enter at least two characters for the board name.'); return }
    setNameError(null)
    const input = { name, description: String(data.get('description') ?? '').trim(), scope }
    const fingerprint = JSON.stringify(input)
    if (!lastSubmission.current || lastSubmission.current.fingerprint !== fingerprint) {
      lastSubmission.current = { fingerprint, id: crypto.randomUUID() }
    }
    onSubmit(input, lastSubmission.current.id)
  }
  const scopes = [
    { value: 'personal', title: 'Just me', description: 'A private board for your own work.' },
    ...(allowShared ? [
      { value: 'team', title: 'A team', description: 'A shared board for authorized members.' },
      { value: 'company', title: 'The company', description: 'A company-wide board for authorized employees.' },
    ] as const : []),
  ] as const
  return (
    <ModalDialog className="sygtasks-dialog" title="Create a SygTasks board" eyebrow="New workspace" description="Choose the right scope now; SygShift will enforce it everywhere." busy={busy} busyLabel="Creating board…" onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <FormField label="Board name" error={nameError}><input name="name" required minLength={2} maxLength={120} autoFocus data-dialog-autofocus onChange={() => setNameError(null)} placeholder="Example: Operations priorities" /></FormField>
        <fieldset className="sygtasks-choice-fieldset"><legend>Who is this for? <small>Required</small></legend><div className="sygtasks-choice-grid">{scopes.map((item) => <label key={item.value} className={scope === item.value ? 'is-selected' : ''}><input type="radio" name="scope" value={item.value} checked={scope === item.value} onChange={() => setScope(item.value)} /><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}</div></fieldset>
        <FormField label="Description" optional><textarea name="description" maxLength={2000} rows={4} placeholder="What work belongs on this board?" /></FormField>
        <SygTasksErrorNotice error={error} />
        <div className="sygtasks-dialog__actions"><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>{busy ? 'Creating…' : 'Create Board'}</button></div>
      </form>
    </ModalDialog>
  )
}

export function CreateTaskDialog({ boardName, busy, canAssignOthers, employeeId, error, members, onClose, onSubmit }: {
  boardName: string
  busy: boolean
  canAssignOthers: boolean
  employeeId: string
  error: unknown
  members: SygTasksWorkspace['members']
  onClose: () => void
  onSubmit: (
    input: Omit<CreateSygTaskInput, 'boardId'>,
    clientRequestId: string,
    recurrence?: Omit<CreateSygTaskRecurringSeriesInput, 'boardId' | 'title' | 'description' | 'status' | 'priority' | 'assigneeId'>,
  ) => void
}) {
  const [validation, setValidation] = useState<{ title?: string; dueAt?: string; recurrence?: string }>({})
  const [repeats, setRepeats] = useState(false)
  const [frequency, setFrequency] = useState<(typeof sygTaskRecurrenceFrequencies)[number]>('weekly')
  const [endRule, setEndRule] = useState<'never' | 'date' | 'count'>('never')
  const [reminderKind, setReminderKind] = useState<'none' | 'reminder' | 'alarm'>('none')
  const lastSubmission = useRef<{ fingerprint: string; requestId: string } | null>(null)
  const assignableMembers = canAssignOthers ? members : members.filter((member) => member.employeeId === employeeId)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const title = String(data.get('title') ?? '').trim()
    const localDueAt = String(data.get('dueAt') ?? '')
    const errors: typeof validation = {}
    if (!title) errors.title = 'Enter a task title.'
    let dueAt: string | null = null
    if (localDueAt && !repeats) {
      try { dueAt = fromOperationalDateTimeInput(localDueAt) } catch (reason) { errors.dueAt = reason instanceof Error ? reason.message : 'Enter a valid Mountain Time date and time.' }
    }
    if (repeats && !localDueAt) errors.dueAt = 'Choose when the first task is due.'
    const intervalCount = Number(data.get('intervalCount') ?? 1)
    const endsOn = endRule === 'date' ? String(data.get('endsOn') ?? '') : ''
    const maxOccurrences = endRule === 'count' ? Number(data.get('maxOccurrences') ?? 0) : null
    if (repeats && (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 12)) errors.recurrence = 'Repeat every 1 to 12 days, weeks, or months.'
    if (repeats && endRule === 'date' && (!endsOn || endsOn < localDueAt.slice(0, 10))) errors.recurrence = 'Choose an end date on or after the first due date.'
    if (repeats && endRule === 'count' && (!maxOccurrences || maxOccurrences < 1 || maxOccurrences > 500)) errors.recurrence = 'Choose between 1 and 500 occurrences.'
    setValidation(errors)
    if (Object.keys(errors).length) return
    const assigneeId = String(data.get('assigneeId') ?? '') || null
    const input = {
      title,
      description: String(data.get('description') ?? '').trim(),
      status: String(data.get('status')) as CreateSygTaskInput['status'],
      priority: String(data.get('priority')) as CreateSygTaskInput['priority'],
      dueAt,
      assigneeId,
    }
    const recurrence = repeats ? {
      firstDueLocal: localDueAt,
      timeZone: String(data.get('timeZone') ?? 'America/Denver') as CreateSygTaskRecurringSeriesInput['timeZone'],
      frequency,
      intervalCount,
      endsOn: endRule === 'date' ? endsOn : null,
      maxOccurrences: endRule === 'count' ? maxOccurrences : null,
      reminderKind,
      reminderOffsetMinutes: reminderKind === 'none' ? null : Number(data.get('reminderOffsetMinutes') ?? 60),
      reminderEmailEnabled: reminderKind === 'none' ? false : data.get('reminderEmailEnabled') === 'on',
    } satisfies Omit<CreateSygTaskRecurringSeriesInput, 'boardId' | 'title' | 'description' | 'status' | 'priority' | 'assigneeId'> : undefined
    const fingerprint = JSON.stringify({ input, recurrence })
    if (!lastSubmission.current || lastSubmission.current.fingerprint !== fingerprint) {
      lastSubmission.current = { fingerprint, requestId: crypto.randomUUID() }
    }
    onSubmit(input, lastSubmission.current.requestId, recurrence)
  }
  return (
    <ModalDialog className="sygtasks-dialog sygtasks-dialog--task" title="Create a task" eyebrow={boardName} description="Define the work, assign ownership, and set a clear operational deadline." busy={busy} busyLabel="Creating task…" onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <FormField label="Task title" error={validation.title}><input name="title" required maxLength={240} autoFocus data-dialog-autofocus onChange={() => setValidation((current) => ({ ...current, title: undefined }))} placeholder="What needs to be completed?" /></FormField>
        <FormField label="Description" optional><textarea name="description" maxLength={10000} rows={5} placeholder="Include the expected outcome and any important context." /></FormField>
        <div className="sygtasks-form-grid sygtasks-form-grid--two"><FormField label="Starting status"><select name="status" defaultValue="backlog">{sygTaskStatuses.filter((status) => !repeats || !['done', 'canceled', 'review', 'blocked'].includes(status)).map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select></FormField><FormField label="Priority"><select name="priority" defaultValue="routine">{sygTaskPriorities.map((priority) => <option key={priority} value={priority}>{formatSygTaskPriority(priority)}</option>)}</select></FormField><FormField label="Assignee" optional><select name="assigneeId" defaultValue=""><option value="">Unassigned</option>{assignableMembers.map((member) => <option key={member.employeeId} value={member.employeeId}>{member.name}{member.username ? ` · @${member.username}` : ''}</option>)}</select></FormField><FormField label={repeats ? 'First due date and time' : 'Due date and time (Mountain Time)'} optional={!repeats} error={validation.dueAt}><input name="dueAt" type="datetime-local" onChange={() => setValidation((current) => ({ ...current, dueAt: undefined }))} /></FormField></div>
        <section className={`sygtasks-recurrence-builder${repeats ? ' is-open' : ''}`}>
          <label className="sygtasks-recurrence-toggle"><input type="checkbox" checked={repeats} onChange={(event) => { setRepeats(event.target.checked); setValidation((current) => ({ ...current, recurrence: undefined })) }} /><CalendarClock aria-hidden="true" size={21} /><span><strong>Repeat this task</strong><small>Create each occurrence as its own task, with separate progress and history.</small></span></label>
          {repeats ? <div className="sygtasks-recurrence-fields">
            <div className="sygtasks-guided-step"><span>1</span><div><strong>Choose the pattern</strong><small>The first due date above anchors the schedule.</small></div></div>
            <div className="sygtasks-form-grid sygtasks-form-grid--three"><FormField label="Repeat"><select name="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)}>{sygTaskRecurrenceFrequencies.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></FormField><FormField label="Repeat every"><input name="intervalCount" type="number" inputMode="numeric" min={1} max={12} defaultValue={1} aria-label={`Repeat every number of ${frequency === 'daily' ? 'days' : frequency === 'weekly' ? 'weeks' : 'months'}`} /></FormField><FormField label="Time zone"><select name="timeZone" defaultValue="America/Denver">{sygTaskRecurrenceTimeZones.map((zone) => <option key={zone} value={zone}>{({ 'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Los_Angeles': 'Pacific' } as const)[zone]}</option>)}</select></FormField></div>
            <div className="sygtasks-guided-step"><span>2</span><div><strong>Choose when it ends</strong><small>Existing occurrences are never rewritten when the series ends.</small></div></div>
            <div className="sygtasks-recurrence-end" role="group" aria-label="Recurring task end rule">{([['never', 'No end date'], ['date', 'On a date'], ['count', 'After a number']] as const).map(([value, label]) => <label key={value} className={endRule === value ? 'is-selected' : ''}><input type="radio" name="endRule" checked={endRule === value} onChange={() => setEndRule(value)} /><span>{label}</span></label>)}</div>
            {endRule === 'date' ? <FormField label="Last occurrence date"><input name="endsOn" type="date" /></FormField> : null}
            {endRule === 'count' ? <FormField label="Number of occurrences"><input name="maxOccurrences" type="number" inputMode="numeric" min={1} max={500} defaultValue={10} /></FormField> : null}
            <div className="sygtasks-guided-step"><span>3</span><div><strong>Add an alert</strong><small>Optional. Alarms repeat until stopped or snoozed.</small></div></div>
            <div className="sygtasks-form-grid sygtasks-form-grid--two"><FormField label="Alert"><select name="reminderKind" value={reminderKind} onChange={(event) => setReminderKind(event.target.value as typeof reminderKind)}><option value="none">No alert</option><option value="reminder">Reminder</option><option value="alarm">Repeating alarm</option></select></FormField>{reminderKind !== 'none' ? <FormField label="Before due time"><select name="reminderOffsetMinutes" defaultValue="60"><option value="0">At due time</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option><option value="10080">1 week</option></select></FormField> : <span />}</div>
            {reminderKind !== 'none' ? <label className="sygtasks-recurrence-email"><input name="reminderEmailEnabled" type="checkbox" /><span><strong>Also send email</strong><small>Each occurrence follows the employee's notification safeguards.</small></span></label> : null}
            <p className="sygtasks-recurrence-review"><CheckCircle2 aria-hidden="true" size={18} /><span><strong>What will happen</strong> SygTasks creates the first task now. Future tasks are created once, keep independent completion, and use this template until you pause or stop the series.</span></p>
            {validation.recurrence ? <p className="sygtasks-field__error" role="alert">{validation.recurrence}</p> : null}
          </div> : null}
        </section>
        <SygTasksErrorNotice error={error} />
        <div className="sygtasks-dialog__actions"><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>{busy ? 'Creating…' : 'Create Task'}</button></div>
      </form>
    </ModalDialog>
  )
}

export function TaskDetailDialog({ workspace, detail, busy, error, referenceTime, canLoadMoreCandidates = false, loadingMoreCandidates = false, onLoadMoreCandidates, onClose, act }: {
  workspace: SygTasksWorkspace
  detail: SygTaskDetail
  busy: boolean
  error: unknown
  referenceTime?: string
  canLoadMoreCandidates?: boolean
  loadingMoreCandidates?: boolean
  onLoadMoreCandidates?: () => void
  onClose: () => void
  act: SygTasksAct
}) {
  const [section, setSection] = useState<'overview' | 'people' | 'recurrence' | 'reminders' | 'checklist' | 'comments' | 'activity'>('overview')
  const [editing, setEditing] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [editingComment, setEditingComment] = useState<{ id: string; body: string; version: number } | null>(null)
  const assigned = useMemo(() => new Set(detail.assignees.map((person) => person.id)), [detail.assignees])
  const appliedLabels = useMemo(() => new Set(detail.labels.map((label) => label.id)), [detail.labels])
  const dependencyIds = useMemo(() => new Set(detail.dependencies.map((dependency) => dependency.taskId)), [detail.dependencies])
  const boardCandidates = workspace.tasks.filter((task) => task.id !== detail.id && !dependencyIds.has(task.id))
  const assignmentCandidates = useMemo(() => {
    const base = workspace.selectedBoard?.scope === 'company' && workspace.permissions.manageShared
      ? workspace.availableMembers
      : workspace.members
    const candidates = new Map(base.map((member) => [member.employeeId, member]))
    for (const assignee of detail.assignees) {
      if (!candidates.has(assignee.id)) {
        candidates.set(assignee.id, { employeeId: assignee.id, name: assignee.name, username: assignee.username ?? '', membershipId: null, role: null })
      }
    }
    return [...candidates.values()]
  }, [detail.assignees, workspace.availableMembers, workspace.members, workspace.permissions.manageShared, workspace.selectedBoard?.scope])
  const dueInput = detail.dueAt ? toOperationalDateTimeInput(detail.dueAt) : ''
  const run = (promise: Promise<void>) => { void promise.catch(() => undefined) }

  function saveOverview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const localDue = String(data.get('dueAt') ?? '')
    let dueAt: string | null = null
    try { dueAt = localDue ? fromOperationalDateTimeInput(localDue) : null } catch (reason) { setOverviewError(reason instanceof Error ? reason.message : 'Enter a valid Mountain Time date and time.'); return }
    setOverviewError(null)
    run(act('update_task', { taskId: detail.id, title: String(data.get('title') ?? '').trim(), description: String(data.get('description') ?? '').trim(), status: data.get('status'), priority: data.get('priority'), dueAt }, detail.version).then(() => setEditing(false)))
  }

  if (confirmArchive) {
    return <ModalDialog className="sygtasks-dialog sygtasks-confirm-dialog" dialogRole="alertdialog" dismissible={!busy} title="Archive this task?" eyebrow="Separate confirmation" description={`“${detail.title}” will leave active views, but its history and audit record will remain intact.`} busy={busy} busyLabel="Archiving task…" onClose={() => setConfirmArchive(false)}><div className="sygtasks-confirm"><ShieldAlert aria-hidden="true" size={34} /><p>This is not a permanent deletion. Authorized users can still include archived records in governed views.</p></div><SygTasksErrorNotice error={error} /><div className="sygtasks-dialog__actions"><button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={busy} onClick={() => setConfirmArchive(false)} autoFocus data-dialog-autofocus>Keep Task</button><button type="button" className="sygtasks-button sygtasks-button--danger" disabled={busy} onClick={() => run(act('archive_task', { taskId: detail.id }, detail.version).then(onClose))}><Archive aria-hidden="true" size={17} />Archive Task</button></div></ModalDialog>
  }

  return (
    <ModalDialog className="sygtasks-detail-dialog" title={detail.title} eyebrow={`${workspace.selectedBoard?.name ?? 'SygTasks'} · ${formatSygTaskStatus(detail.status)}`} description={`${formatSygTaskPriority(detail.priority)} priority · Updated ${formatTaskDue(detail.updatedAt)}`} busy={busy} onClose={onClose}>
      <nav className="sygtasks-detail-tabs" aria-label="Task details">{([['overview', 'Overview'], ['people', 'People'], ['recurrence', 'Repeat'], ['reminders', 'Reminders'], ['checklist', 'Checklist'], ['comments', `Comments (${detail.commentCount})`], ['activity', 'Activity']] as const).map(([value, label]) => <button type="button" key={value} aria-current={section === value ? 'page' : undefined} onClick={() => setSection(value)}>{label}</button>)}</nav>
      <SygTasksErrorNotice error={error} />
      {section === 'overview' ? <div className="sygtasks-detail-section">
        {editing && detail.canEdit ? <form onSubmit={saveOverview}><FormField label="Task title"><input name="title" defaultValue={detail.title} maxLength={240} required autoFocus /></FormField><FormField label="Description" optional><textarea name="description" defaultValue={detail.description} maxLength={10000} rows={6} /></FormField><div className="sygtasks-form-grid"><FormField label="Status"><select name="status" defaultValue={detail.status}>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select></FormField><FormField label="Priority"><select name="priority" defaultValue={detail.priority}>{sygTaskPriorities.map((priority) => <option key={priority} value={priority}>{formatSygTaskPriority(priority)}</option>)}</select></FormField><FormField label="Due date and time (Mountain Time)" optional error={overviewError}><input name="dueAt" type="datetime-local" defaultValue={dueInput} onChange={() => setOverviewError(null)} /></FormField></div><div className="sygtasks-inline-actions"><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={() => { setOverviewError(null); setEditing(false) }}>Cancel</button><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>Save Changes</button></div></form> : <><div className="sygtasks-detail-summary"><div><span>Status</span><TaskStatusBadge status={detail.status} /></div><div><span>Priority</span><TaskPriorityBadge priority={detail.priority} /></div><div><span>Due</span><strong className={referenceTime ? `sygtasks-due sygtasks-due--${taskDueState(detail, referenceTime)}` : 'sygtasks-due'}>{formatTaskDue(detail.dueAt)}</strong></div><div><span>Progress</span><strong>{detail.checklist.completed} of {detail.checklist.total}</strong></div></div><section className="sygtasks-description"><h3>Description</h3><p>{detail.description || 'No description has been added yet.'}</p></section><div className="sygtasks-inline-actions">{detail.canEdit ? <button type="button" className="sygtasks-button sygtasks-button--primary" onClick={() => setEditing(true)}>Edit Details</button> : null}{detail.canUpdateStatus && !detail.canEdit ? <select aria-label="Update task status" value={detail.status} disabled={busy} onChange={(event) => run(act('update_task', { taskId: detail.id, status: event.target.value }, detail.version))}>{sygTaskStatuses.map((status) => <option key={status} value={status}>{formatSygTaskStatus(status)}</option>)}</select> : null}{detail.canEdit ? <button type="button" className="sygtasks-button sygtasks-button--danger" disabled={busy} onClick={() => setConfirmArchive(true)}><Archive aria-hidden="true" size={16} />Archive</button> : null}</div></>}
        <section className="sygtasks-labels"><h3><Tag aria-hidden="true" size={17} />Labels</h3><div>{workspace.labels.map((label) => <button type="button" key={label.id} className={appliedLabels.has(label.id) ? 'is-active' : ''} style={{ '--task-label': label.color } as CSSProperties} disabled={busy || !detail.canEdit} onClick={() => run(act(appliedLabels.has(label.id) ? 'remove_label' : 'apply_label', { taskId: detail.id, labelId: label.id }))}>{appliedLabels.has(label.id) ? <Check aria-hidden="true" size={14} /> : null}{label.name}</button>)}</div>{detail.canEdit ? <form className="sygtasks-compact-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); run(act('create_label', { boardId: detail.boardId, name: data.get('name'), color: data.get('color') }).then(() => form.reset())) }}><input name="name" aria-label="New label name" placeholder="New label" maxLength={50} required /><input name="color" aria-label="Label color" type="color" defaultValue="#e3ad3b" /><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>Add</button></form> : null}</section>
        <section className="sygtasks-dependencies"><h3>Dependencies</h3>{detail.dependencies.length ? <ul>{detail.dependencies.map((dependency) => <li key={dependency.id}><span>{dependency.title}<TaskStatusBadge status={dependency.status} /></span>{detail.canEdit ? <button type="button" className="sygtasks-icon-button" aria-label={`Remove dependency ${dependency.title}`} disabled={busy} onClick={() => run(act('remove_dependency', { taskId: detail.id, dependsOnTaskId: dependency.taskId }))}>×</button> : null}</li>)}</ul> : <p>No dependencies.</p>}{detail.canEdit && boardCandidates.length ? <form className="sygtasks-compact-form" onSubmit={(event) => { event.preventDefault(); const select = event.currentTarget.elements.namedItem('dependency') as HTMLSelectElement; run(act('add_dependency', { taskId: detail.id, dependsOnTaskId: select.value })) }}><select name="dependency" aria-label="Task dependency">{boardCandidates.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>Add Dependency</button></form> : null}{detail.canEdit && canLoadMoreCandidates && onLoadMoreCandidates ? <button type="button" className="sygtasks-button sygtasks-button--secondary sygtasks-load-more-candidates" disabled={busy || loadingMoreCandidates} onClick={onLoadMoreCandidates}>{loadingMoreCandidates ? 'Loading more tasks…' : 'Load more dependency candidates'}</button> : null}</section>
      </div> : null}
      {section === 'people' ? <div className="sygtasks-detail-section"><section><h3><Users aria-hidden="true" size={18} />Assignees</h3><div className="sygtasks-people-grid">{assignmentCandidates.map((member) => { const canChangeAssignee = workspace.permissions.manageShared || member.employeeId === workspace.employeeId; return <label key={member.employeeId}><input type="checkbox" checked={assigned.has(member.employeeId)} disabled={busy || !detail.canEdit || !canChangeAssignee} onChange={() => run(act(assigned.has(member.employeeId) ? 'unassign_task' : 'assign_task', { taskId: detail.id, employeeId: member.employeeId }))} /><span className="sygtasks-person-avatar">{employeeInitials(member.name)}</span><strong>{member.name}<small>@{member.username}</small></strong></label> })}</div></section><section><h3>{detail.watching ? <Bell aria-hidden="true" size={18} /> : <BellOff aria-hidden="true" size={18} />}Following this task</h3><p>Followers receive SygShift notifications when important task details change.</p><button type="button" className="sygtasks-button sygtasks-button--primary" disabled={busy} onClick={() => run(act(detail.watching ? 'unwatch_task' : 'watch_task', { taskId: detail.id }))}>{detail.watching ? 'Stop Following' : 'Follow Task'}</button><p className="sygtasks-muted">{detail.watchers.length} follower{detail.watchers.length === 1 ? '' : 's'}: {detail.watchers.map((watcher) => watcher.name).join(', ') || 'None'}</p></section></div> : null}
      {section === 'recurrence' ? <div className="sygtasks-detail-section"><SygTasksRecurringPanel taskId={detail.id} workspace={workspace} /></div> : null}
      {section === 'reminders' ? <div className="sygtasks-detail-section"><SygTasksRemindersPanel taskId={detail.id} taskHasDueDate={Boolean(detail.dueAt)} /></div> : null}
      {section === 'checklist' ? <div className="sygtasks-detail-section"><section><h3><CheckCircle2 aria-hidden="true" size={18} />Checklist</h3><div className="sygtasks-progress" aria-label={`${detail.checklist.completed} of ${detail.checklist.total} checklist items complete`}><span style={{ width: `${detail.checklist.total ? (detail.checklist.completed / detail.checklist.total) * 100 : 0}%` }} /></div><ul className="sygtasks-checklist">{detail.checklistItems.map((item) => <li key={item.id}><button type="button" className="sygtasks-icon-button" aria-label={`${item.completedAt ? 'Mark incomplete' : 'Mark complete'}: ${item.title}`} disabled={busy || !detail.canEdit} onClick={() => run(act('update_checklist_item', { checklistItemId: item.id, completed: !item.completedAt }, item.version))}>{item.completedAt ? <CheckCircle2 aria-hidden="true" /> : <Circle aria-hidden="true" />}</button><span className={item.completedAt ? 'is-complete' : ''}>{item.title}</span>{detail.canEdit ? <button type="button" className="sygtasks-icon-button" aria-label={`Remove ${item.title}`} disabled={busy} onClick={() => run(act('archive_checklist_item', { checklistItemId: item.id }, item.version))}>×</button> : null}</li>)}</ul>{detail.canEdit ? <form className="sygtasks-compact-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); run(act('add_checklist_item', { taskId: detail.id, title: data.get('title') }).then(() => form.reset())) }}><input name="title" placeholder="Add a checklist item" aria-label="Checklist item" maxLength={500} required /><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>Add Item</button></form> : null}</section></div> : null}
      {section === 'comments' ? <div className="sygtasks-detail-section"><section><h3><MessageSquare aria-hidden="true" size={18} />Discussion</h3><ol className="sygtasks-comments">{detail.comments.map((comment) => <li key={comment.id}><span className="sygtasks-person-avatar">{employeeInitials(comment.authorName)}</span><div><header><strong>{comment.authorName}</strong><time>{formatTaskDue(comment.createdAt)}{comment.editedAt ? ' · edited' : ''}</time></header>{editingComment?.id === comment.id ? <form className="sygtasks-comment-edit" onSubmit={(event) => { event.preventDefault(); run(act('edit_comment', { commentId: comment.id, body: editingComment.body.trim() }, comment.version).then(() => setEditingComment(null))) }}><textarea aria-label={`Edit comment by ${comment.authorName}`} maxLength={5000} rows={4} value={editingComment.body} onChange={(event) => setEditingComment({ ...editingComment, body: event.target.value })} autoFocus /><div><button type="button" className="sygtasks-button sygtasks-button--secondary" onClick={() => setEditingComment(null)}>Cancel</button><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy || !editingComment.body.trim()}>Save</button></div></form> : <><p>{comment.body}</p>{comment.canEdit ? <button type="button" className="sygtasks-text-button" disabled={busy} onClick={() => setEditingComment({ id: comment.id, body: comment.body, version: comment.version })}>Edit</button> : null}</>}</div></li>)}</ol><form className="sygtasks-comment-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); run(act('add_comment', { taskId: detail.id, body: data.get('body') }).then(() => form.reset())) }}><FormField label="Add a comment"><textarea name="body" rows={4} maxLength={5000} required placeholder="Share an update, question, or decision." /></FormField><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy}>Post Comment</button></form></section></div> : null}
      {section === 'activity' ? <div className="sygtasks-detail-section"><SygTasksActivityPanel taskId={detail.id} /></div> : null}
    </ModalDialog>
  )
}

export function BoardSettingsDialog({ workspace, busy, error, onArchived, onClose, act }: { workspace: SygTasksWorkspace; busy: boolean; error: unknown; onArchived: () => void; onClose: () => void; act: SygTasksAct }) {
  const board = workspace.selectedBoard
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [selectedEmployee, setSelectedEmployee] = useState('')
  const [selectedRole, setSelectedRole] = useState<'editor' | 'member' | 'viewer'>('member')
  if (!board) return null
  const nonMembers = workspace.availableMembers.filter((member) => !member.isMember && member.employeeId !== board.ownerEmployeeId)
  const members = workspace.availableMembers.filter((member) => member.isMember || member.employeeId === board.ownerEmployeeId)
  const run = (promise: Promise<void>) => { void promise.catch(() => undefined) }

  if (confirmArchive) {
    return <ModalDialog className="sygtasks-dialog sygtasks-confirm-dialog" dialogRole="alertdialog" dismissible={!busy} title="Archive this board?" eyebrow="Separate confirmation" description={`“${board.name}” and its active tasks will leave normal views. Their history will be preserved.`} busy={busy} busyLabel="Archiving board…" onClose={() => setConfirmArchive(false)}><div className="sygtasks-confirm"><ShieldAlert aria-hidden="true" size={34} /><p>Archive is recoverable database state, not permanent deletion. No task, comment, checklist, or audit history will be erased.</p></div><SygTasksErrorNotice error={error} /><div className="sygtasks-dialog__actions"><button type="button" className="sygtasks-button sygtasks-button--secondary" disabled={busy} onClick={() => setConfirmArchive(false)} autoFocus data-dialog-autofocus>Keep Board</button><button type="button" className="sygtasks-button sygtasks-button--danger" disabled={busy} onClick={() => run(act('archive_board', { boardId: board.id }, board.version).then(onArchived))}><Archive aria-hidden="true" size={17} />Archive Board</button></div></ModalDialog>
  }

  return (
    <ModalDialog className="sygtasks-dialog sygtasks-dialog--settings" title="Board Settings" eyebrow={board.scope} description="Review ownership, membership, and the board lifecycle." busy={busy} onClose={onClose}>
      <section className="sygtasks-board-profile"><div><span>Board name</span><strong>{board.name}</strong></div><div><span>Owner</span><strong>{board.ownerName}</strong></div><div><span>Scope</span><strong>{board.scope}</strong></div><div><span>Open tasks</span><strong>{board.openTaskCount ?? 0}</strong></div></section>
      <SygTasksErrorNotice error={error} />
      {board.scope === 'personal' ? <section className="sygtasks-personal-board-notice"><h3>Private to you</h3><p>Only you can find, open, change, follow, or receive updates from this board and its tasks. Use a team board when other employees need access.</p></section> : <section className="sygtasks-settings-section"><div className="sygtasks-settings-section__heading"><div><p>Access</p><h3>Board members</h3></div><span>{members.length} member{members.length === 1 ? '' : 's'}</span></div><div className="sygtasks-member-admin">{members.map((member) => { const isOwner = member.employeeId === board.ownerEmployeeId; return <article key={member.employeeId}><span className="sygtasks-person-avatar">{employeeInitials(member.name)}</span><div><strong>{member.name}</strong><small>@{member.username}</small></div><span className="sygtasks-member-role">{isOwner ? 'Owner' : member.role ?? 'Member'}</span>{!isOwner && board.canManageBoard ? <button type="button" className="sygtasks-button sygtasks-button--secondary sygtasks-button--small" disabled={busy} onClick={() => run(act('remove_board_member', { boardId: board.id, employeeId: member.employeeId }))}>Remove</button> : null}</article> })}</div>{board.canManageBoard ? <form className="sygtasks-add-member" onSubmit={(event) => { event.preventDefault(); if (!selectedEmployee) return; run(act('add_board_member', { boardId: board.id, employeeId: selectedEmployee, memberRole: selectedRole }).then(() => setSelectedEmployee(''))) }}><FormField label="Employee"><select value={selectedEmployee} onChange={(event) => setSelectedEmployee(event.target.value)} required><option value="">Choose an authorized employee</option>{nonMembers.map((member) => <option key={member.employeeId} value={member.employeeId}>{member.name} · @{member.username}</option>)}</select></FormField><FormField label="Member role"><select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value as typeof selectedRole)}><option value="editor">Editor</option><option value="member">Member</option><option value="viewer">Viewer</option></select></FormField><button type="submit" className="sygtasks-button sygtasks-button--primary" disabled={busy || !selectedEmployee}>Add Member</button></form> : null}</section>}
      <section className="sygtasks-danger-zone"><div><p>Board lifecycle</p><h3>Archive Board</h3><span>Remove this board from active workspaces without deleting its records.</span></div>{board.canManageBoard ? <button type="button" className="sygtasks-button sygtasks-button--danger" disabled={busy} onClick={() => setConfirmArchive(true)}><Archive aria-hidden="true" size={17} />Archive Board</button> : null}</section>
      <div className="sygtasks-dialog__actions"><button type="button" className="sygtasks-button sygtasks-button--primary" onClick={onClose} disabled={busy}>Done</button></div>
    </ModalDialog>
  )
}

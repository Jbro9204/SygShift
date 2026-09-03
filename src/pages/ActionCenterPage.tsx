import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  BookOpenCheck,
  CalendarCheck2,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Download,
  Eye,
  ExternalLink,
  FileCheck2,
  History as HistoryIcon,
  Megaphone,
  Plus,
  Search,
  Workflow,
} from 'lucide-react'
import { getSessionContext } from '../data/auth'
import {
  completeEmployeeAction,
  getEmployeeActionCenter,
  getEmployeeActionComplianceReport,
  getEmployeeActionHistory,
  getTrainingCatalog,
  markEmployeeActionViewed,
  publishTrainingVersion,
  trainingComplianceCsv,
  type EmployeeActionCenter,
  type EmployeeActionHistoryItem,
  type EmployeeActionHistoryStatus,
  type EmployeeActionHistoryType,
  type TrainingAction,
} from '../data/actionCenter'
import { getScheduleBuilderOptions, scheduleEmployeeName } from '../data/schedule'
import { getSites } from '../data/workforce'
import {
  completeHrAutomationTask,
  getMyHrAutomationTasks,
  markHrAutomationTaskViewed,
  type HrAutomationTask,
} from '../data/hrAutomation'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { alignPostNameWithShiftRequirement, shiftRequirementLabel } from '../lib/shiftDisplay'
import { isSupabaseConfigured } from '../lib/supabase'

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No due date'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(value))
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not yet'
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value))
}

function downloadText(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function ActionStatus({ status }: { status: string }) {
  return <span className={`action-status action-status--${status}`}>{status.replaceAll('_', ' ')}</span>
}

type ActionWorkspaceTab = 'attention' | 'in_progress' | 'history'

function filteredEmployeeActions(data: EmployeeActionCenter, tab: Exclude<ActionWorkspaceTab, 'history'>): EmployeeActionCenter {
  const announcements = data.announcements.filter((item) => tab === 'attention' ? item.status === 'pending' : item.status === 'viewed')
  const training = data.training.filter((item) => tab === 'attention' ? ['assigned', 'overdue'].includes(item.status) : item.status === 'in_progress')
  const schedules = data.schedules.filter((item) => tab === 'attention' ? item.status === 'pending' : item.status === 'viewed')
  return {
    ...data,
    announcements,
    training,
    schedules,
    summary: {
      announcementCount: announcements.length,
      trainingCount: training.length,
      scheduleCount: schedules.length,
    },
  }
}

function HrAutomationActions({
  busyId,
  onOpen,
  tasks,
}: {
  busyId: string | null
  onOpen: (task: HrAutomationTask) => void
  tasks: HrAutomationTask[]
}) {
  if (!tasks.length) return null
  return (
    <section className="panel action-section hr-action-section">
      <div className="section-heading"><div><p className="eyebrow">HR actions</p><h2>Items requiring your response</h2><p>Open an item to review its instructions and record completion.</p></div></div>
      <div className="hr-action-list">
        {tasks.map((task) => (
          <button className="hr-action-item" disabled={busyId === task.id} key={task.id} onClick={() => onOpen(task)} type="button">
            <span className="action-item__icon"><Workflow aria-hidden="true" size={21} /></span>
            <span className="hr-action-item__copy"><strong>{task.title}</strong><small>{task.instructions ?? 'Open this action to review the required next step.'}</small></span>
            <span className={`action-status action-status--${task.status}`}>{task.status}</span>
            <span className="hr-action-item__due">Due {formatDate(task.dueAt)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function TrainingMaterial({ item }: { item: TrainingAction }) {
  if (!item.contentUrl) return null
  return (
    <a className="secondary-button secondary-button--small" href={item.contentUrl} rel="noreferrer" target="_blank">
      <ExternalLink aria-hidden="true" size={16} />
      Open {item.contentType.replace('_', ' ')}
    </a>
  )
}

function EmployeeActions({ data, busyId, emptyCopy, onOpen, onComplete, showEmpty = true }: {
  data: EmployeeActionCenter
  busyId: string | null
  emptyCopy: { title: string; body: string }
  onOpen: (type: 'announcement' | 'training' | 'schedule', id: string) => void
  onComplete: (type: 'announcement' | 'training' | 'schedule', id: string, attestation?: string) => void
  showEmpty?: boolean
}) {
  const empty = data.summary.announcementCount + data.summary.trainingCount + data.summary.scheduleCount === 0
  if (empty) {
    if (!showEmpty) return null
    return (
      <section className="panel action-center-empty">
        <CheckCircle2 aria-hidden="true" size={34} />
        <h2>{emptyCopy.title}</h2>
        <p>{emptyCopy.body}</p>
      </section>
    )
  }

  return (
    <div className="action-center-sections">
      {data.announcements.length ? (
        <section className="panel action-section">
          <div className="section-heading"><div><p className="eyebrow">Announcements</p><h2>Required reading</h2></div></div>
          <div className="action-item-list">
            {data.announcements.map((item) => (
              <article className="action-item" key={item.id} onClick={() => onOpen('announcement', item.id)}>
                <div className="action-item__icon"><Megaphone aria-hidden="true" size={22} /></div>
                <div className="action-item__body">
                  <div className="action-item__title"><h3>{item.title}</h3><ActionStatus status={item.status} /></div>
                  <p>{item.body}</p>
                  <small>Version {item.version} · Due {formatDate(item.dueAt)} · Viewed {formatDateTime(item.viewedAt)}</small>
                </div>
                <button className="primary-action" disabled={busyId === item.id} onClick={(event) => {
                  event.stopPropagation()
                  onComplete('announcement', item.id)
                }} type="button">
                  {busyId === item.id ? 'Saving…' : 'I acknowledge that I have received and reviewed this announcement.'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {data.training.length ? (
        <section className="panel action-section">
          <div className="section-heading"><div><p className="eyebrow">Training</p><h2>Assigned training</h2></div></div>
          <div className="action-item-list">
            {data.training.map((item) => (
              <article className="action-item" key={item.id} onClick={() => onOpen('training', item.id)}>
                <div className="action-item__icon"><BookOpenCheck aria-hidden="true" size={22} /></div>
                <div className="action-item__body">
                  <div className="action-item__title"><h3>{item.title}</h3><ActionStatus status={item.status} /></div>
                  {item.description ? <p>{item.description}</p> : null}
                  {item.instructions ? <div className="action-instructions">{item.instructions}</div> : null}
                  <small>Version {item.version} · Effective {formatDate(item.effectiveOn)} · Due {formatDate(item.dueAt)}</small>
                  <TrainingMaterial item={item} />
                </div>
                <button className="primary-action" disabled={busyId === item.id} onClick={(event) => {
                  event.stopPropagation()
                  onComplete('training', item.id, 'I completed and reviewed this training.')
                }} type="button">
                  {busyId === item.id ? 'Saving…' : 'I completed and reviewed this training.'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {data.schedules.length ? (
        <section className="panel action-section">
          <div className="section-heading"><div><p className="eyebrow">Schedules</p><h2>Published schedules to review</h2></div></div>
          <div className="action-item-list">
            {data.schedules.map((item) => (
              <article className="action-item" key={item.id} onClick={() => onOpen('schedule', item.id)}>
                <div className="action-item__icon"><CalendarCheck2 aria-hidden="true" size={22} /></div>
                <div className="action-item__body">
                  <div className="action-item__title"><h3>Week of {formatDate(item.weekStartsOn)}</h3><ActionStatus status={item.status} /></div>
                  <p>Published revision {item.scheduleRevision} on {formatDateTime(item.publishedAt)}.</p>
                  <div className="schedule-ack-shifts">
                    {item.shifts.map((shift) => (
                      <div key={shift.shiftId}>
                        <strong>{formatDateTime(shift.startsAt)} – {formatDateTime(shift.endsAt)}</strong>
                        <span>{shift.siteName ?? shift.eventName ?? 'Assigned location'}{shift.postName ? ` · ${alignPostNameWithShiftRequirement(shift.postName, shift.requiresArmed)}` : ''} · {shiftRequirementLabel(shift.requiresArmed)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <button className="primary-action" disabled={busyId === item.id} onClick={(event) => {
                  event.stopPropagation()
                  onComplete('schedule', item.id)
                }} type="button">
                  {busyId === item.id ? 'Saving…' : 'Acknowledge Schedule'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function historyTypeLabel(type: EmployeeActionHistoryType): string {
  if (type === 'hr_task') return 'HR task'
  return type[0].toUpperCase() + type.slice(1)
}

function historyResolutionLabel(item: EmployeeActionHistoryItem): string {
  if (item.resolutionSource === 'system') return 'Resolved automatically by SygShift'
  if (item.resolutionSource === 'manager') return 'Resolved by an authorized manager'
  return 'Resolved by the employee'
}

function scheduleHistoryLocations(item: EmployeeActionHistoryItem): string[] {
  if (item.actionType !== 'schedule' || !Array.isArray(item.metadata.shifts)) return []
  const locations = item.metadata.shifts.flatMap((shift) => {
    if (!shift || typeof shift !== 'object') return []
    const record = shift as Record<string, unknown>
    const site = typeof record.siteName === 'string' ? record.siteName : typeof record.eventName === 'string' ? record.eventName : 'Assigned location'
    const post = typeof record.postName === 'string' ? record.postName : null
    const requiresArmed = typeof record.requiresArmed === 'boolean' ? record.requiresArmed : null
    const displayPost = post && requiresArmed !== null ? alignPostNameWithShiftRequirement(post, requiresArmed) : post
    return [displayPost ? `${site} · ${displayPost}` : site]
  })
  return [...new Set(locations)]
}

function ActionHistoryDetails({ item, onClose }: { item: EmployeeActionHistoryItem; onClose: () => void }) {
  const locations = scheduleHistoryLocations(item)
  return (
    <ModalDialog className="modal-dialog--action-history" description="This is a read-only audit record. Corrections create a new linked action instead of changing this outcome." onClose={onClose} title={item.title}>
      <div className="action-history-detail">
        <div className="action-history-detail__status"><ActionStatus status={item.status} /><span>{historyResolutionLabel(item)}</span></div>
        <dl>
          <div><dt>Employee</dt><dd>{item.employeeName}</dd></div>
          <div><dt>Action type</dt><dd>{historyTypeLabel(item.actionType)}</dd></div>
          <div><dt>Assigned</dt><dd>{formatDateTime(item.assignedAt)}</dd></div>
          <div><dt>Viewed</dt><dd>{formatDateTime(item.viewedAt)}</dd></div>
          <div><dt>Resolved</dt><dd>{formatDateTime(item.resolvedAt)}</dd></div>
          <div><dt>Resolved by</dt><dd>{item.resolvedByName ?? 'SygShift automation'}</dd></div>
          {item.dueAt ? <div><dt>Due</dt><dd>{formatDateTime(item.dueAt)}</dd></div> : null}
          {item.contextLabel ? <div><dt>Record context</dt><dd>{item.contextLabel}</dd></div> : null}
        </dl>
        {item.description ? <section><p className="eyebrow">Original details</p><p>{item.description}</p></section> : null}
        {locations.length ? <section><p className="eyebrow">Site / post</p><ul>{locations.map((location) => <li key={location}>{location}</li>)}</ul></section> : null}
        <section><p className="eyebrow">Resolution record</p><p>{item.resolutionNote ?? historyResolutionLabel(item)}</p></section>
      </div>
    </ModalDialog>
  )
}

function ActionHistoryWorkspace({ canViewTeam }: { canViewTeam: boolean }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<5 | 10 | 20>(10)
  const [search, setSearch] = useState('')
  const [actionType, setActionType] = useState<'all' | EmployeeActionHistoryType>('all')
  const [status, setStatus] = useState<'all' | EmployeeActionHistoryStatus>('all')
  const [fromDate, setFromDate] = useState('')
  const [throughDate, setThroughDate] = useState('')
  const [scope, setScope] = useState<'self' | 'team'>('self')
  const [selected, setSelected] = useState<EmployeeActionHistoryItem | null>(null)
  const historyQuery = useQuery({
    queryKey: ['employee-action-history', page, pageSize, search, actionType, status, fromDate, throughDate, scope],
    queryFn: () => getEmployeeActionHistory({ page, pageSize, search, actionType, status, fromDate, throughDate, scope }),
  })
  const updateFilter = (callback: () => void) => { callback(); setPage(1) }
  const totalPages = historyQuery.data?.page.totalPages ?? 0

  return (
    <>
      <section className="panel action-history-workspace">
        <div className="section-heading"><div><p className="eyebrow">Audit history</p><h2>Completed Action Center records</h2><p>Completed work leaves the active queue but remains permanently traceable here.</p></div></div>
        <div className="action-history-filters">
          <label className="action-history-search"><span>Search history</span><div><Search aria-hidden="true" size={18} /><input onChange={(event) => updateFilter(() => setSearch(event.target.value))} placeholder="Employee, action, note, or context" value={search} /></div></label>
          {canViewTeam ? <label><span>Records</span><select onChange={(event) => updateFilter(() => setScope(event.target.value as 'self' | 'team'))} value={scope}><option value="self">My history</option><option value="team">Authorized team history</option></select></label> : null}
          <label><span>Action type</span><select onChange={(event) => updateFilter(() => setActionType(event.target.value as 'all' | EmployeeActionHistoryType))} value={actionType}><option value="all">All actions</option><option value="announcement">Announcements</option><option value="training">Training</option><option value="schedule">Schedules</option><option value="hr_task">HR tasks</option></select></label>
          <label><span>Outcome</span><select onChange={(event) => updateFilter(() => setStatus(event.target.value as 'all' | EmployeeActionHistoryStatus))} value={status}><option value="all">All outcomes</option><option value="acknowledged">Acknowledged</option><option value="completed">Completed</option><option value="superseded">Superseded</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option></select></label>
          <label><span>Resolved from</span><input onChange={(event) => updateFilter(() => setFromDate(event.target.value))} type="date" value={fromDate} /></label>
          <label><span>Resolved through</span><input onChange={(event) => updateFilter(() => setThroughDate(event.target.value))} type="date" value={throughDate} /></label>
        </div>
        {historyQuery.isPending ? <DataStatePanel icon={HistoryIcon} title="Loading Action Center history"><p>Retrieving completed records from the protected audit sources.</p></DataStatePanel> : null}
        {historyQuery.isError ? <div className="inline-alert" role="alert">{historyQuery.error.message}</div> : null}
        {historyQuery.data && !historyQuery.data.items.length ? <div className="action-history-empty"><Archive aria-hidden="true" size={28} /><div><strong>No completed actions match these filters.</strong><span>Change the filters or return after an assigned action is resolved.</span></div></div> : null}
        {historyQuery.data?.items.length ? <div className="action-history-list">{historyQuery.data.items.map((item) => (
          <article key={`${item.actionType}-${item.id}`}>
            <div className="action-history-list__main"><span className="action-history-type">{historyTypeLabel(item.actionType)}</span><strong>{item.title}</strong><small>{item.employeeName} · {item.contextLabel ?? 'Action Center record'}</small></div>
            <div><span>Outcome</span><ActionStatus status={item.status} /></div>
            <div><span>Resolved</span><strong>{formatDateTime(item.resolvedAt)}</strong><small>{item.resolvedByName ?? 'SygShift automation'}</small></div>
            <button className="secondary-button" onClick={() => setSelected(item)} type="button"><Eye aria-hidden="true" size={16} />View details</button>
          </article>
        ))}</div> : null}
        <div className="compact-pagination action-history-pagination">
          <span>Page {totalPages === 0 ? 0 : historyQuery.data?.page.number ?? page} of {totalPages} · {historyQuery.data?.page.total ?? 0} records</span>
          <label className="compact-page-size"><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as 5 | 10 | 20); setPage(1) }} value={pageSize}><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
          <button className="secondary-button" disabled={page <= 1 || historyQuery.isFetching} onClick={() => setPage((value) => value - 1)} type="button"><ChevronLeft aria-hidden="true" size={16} />Previous</button>
          <button className="secondary-button" disabled={page >= totalPages || historyQuery.isFetching} onClick={() => setPage((value) => value + 1)} type="button">Next<ChevronRight aria-hidden="true" size={16} /></button>
        </div>
      </section>
      {selected ? <ActionHistoryDetails item={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function TrainingEditor({ onClose, onPublished }: { onClose: () => void; onPublished: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const catalogQuery = useQuery({ queryKey: ['training-catalog'], queryFn: getTrainingCatalog })
  const optionsQuery = useQuery({ queryKey: ['schedule-builder-options'], queryFn: getScheduleBuilderOptions })
  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: getSites })
  const mutation = useMutation({
    mutationFn: publishTrainingVersion,
    onSuccess: onPublished,
    onError: (nextError: Error) => setError(nextError.message),
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const selected = String(form.get('courseId') ?? '')
    mutation.mutate({
      courseId: selected || null,
      code: String(form.get('code') ?? ''),
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      contentType: String(form.get('contentType') ?? 'written') as TrainingAction['contentType'],
      contentUrl: String(form.get('contentUrl') ?? ''),
      instructions: String(form.get('instructions') ?? ''),
      effectiveOn: String(form.get('effectiveOn') ?? ''),
      dueAt: String(form.get('dueAt') ?? '') || null,
      employeeIds: form.getAll('employeeIds').map(String),
      roles: form.getAll('roles').map(String) as never,
      siteIds: form.getAll('siteIds').map(String),
      states: String(form.get('states') ?? '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
    })
  }

  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Publishing training…" className="modal-dialog--training" description="Create a new course or publish a new immutable version of an existing course." onClose={onClose} title="Publish training">
      <form className="training-editor" onSubmit={submit}>
        <label className="form-field form-field--wide"><span>Training record</span><select name="courseId"><option value="">New training item</option>{catalogQuery.data?.map((item) => <option key={item.courseId} value={item.courseId}>{item.title} · version {item.currentVersion}</option>)}</select></label>
        <label className="form-field"><span>Code</span><input name="code" placeholder="Example: CA-BATON-01" required /></label>
        <label className="form-field"><span>Title</span><input name="title" required /></label>
        <label className="form-field"><span>Material type</span><select name="contentType"><option value="written">Written instructions</option><option value="document">Document</option><option value="video">Video</option><option value="external_link">External link</option></select></label>
        <label className="form-field"><span>Material link</span><input name="contentUrl" placeholder="https://…" type="url" /></label>
        <label className="form-field"><span>Effective date</span><input name="effectiveOn" required type="date" /></label>
        <label className="form-field"><span>Due date and time</span><input name="dueAt" type="datetime-local" /></label>
        <label className="form-field form-field--wide"><span>Description</span><textarea name="description" rows={3} /></label>
        <label className="form-field form-field--wide"><span>Completion instructions</span><textarea name="instructions" required rows={4} /></label>
        <fieldset className="training-audience"><legend>Assign by role</legend>{['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'].map((role) => <label className="check-field" key={role}><input name="roles" type="checkbox" value={role} />{role.replace('_', ' ')}</label>)}</fieldset>
        <label className="form-field"><span>Assign specific employees</span><select multiple name="employeeIds" size={6}>{optionsQuery.data?.employees.map((employee) => <option key={employee.id} value={employee.id}>{scheduleEmployeeName(employee)}{employee.employee_number ? ` · ${employee.employee_number}` : ''}</option>)}</select></label>
        <label className="form-field"><span>Assign scheduled sites</span><select multiple name="siteIds" size={6}>{sitesQuery.data?.filter((site) => site.active).map((site) => <option key={site.id} value={site.id}>{site.code ? `${site.code} · ` : ''}{site.name}</option>)}</select></label>
        <label className="form-field form-field--wide"><span>Assign employee states</span><input name="states" placeholder="CA, CO" /></label>
        <p className="form-help form-field--wide">At least one employee, role, site, or state audience is required. Publishing an existing training item creates a new version and supersedes incomplete prior assignments.</p>
        {error ? <div className="inline-alert form-field--wide" role="alert">{error}</div> : null}
        <div className="modal-actions form-field--wide"><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" type="submit"><Plus aria-hidden="true" size={17} />Publish training</button></div>
      </form>
    </ModalDialog>
  )
}

export function ActionCenterPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<ActionWorkspaceTab>('attention')
  const [trainingOpen, setTrainingOpen] = useState(false)
  const [selectedHrTask, setSelectedHrTask] = useState<HrAutomationTask | null>(null)
  const [hrCompletionNote, setHrCompletionNote] = useState('')
  const [hrTaskError, setHrTaskError] = useState<string | null>(null)
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const actionQuery = useQuery({ queryKey: ['employee-action-center'], queryFn: getEmployeeActionCenter, enabled: isSupabaseConfigured && sessionQuery.isSuccess })
  const hrTasksQuery = useQuery({ queryKey: ['hr-automation-actions'], queryFn: getMyHrAutomationTasks, enabled: isSupabaseConfigured && sessionQuery.isSuccess })
  const canManage = Boolean(sessionQuery.data?.permissions.includes('training.manage'))
  const canReport = Boolean(sessionQuery.data?.permissions.some((permission) => ['training.export', 'schedule.acknowledgments.manage', 'announcements.acknowledgments.manage'].includes(permission)))
  const canViewTeamHistory = Boolean(sessionQuery.data?.hasMfa && sessionQuery.data.permissions.some((permission) => ['announcements.acknowledgments.manage', 'training.manage', 'schedule.acknowledgments.manage', 'hr.automation.manage'].includes(permission)))
  const reportQuery = useQuery({ queryKey: ['employee-action-report'], queryFn: getEmployeeActionComplianceReport, enabled: isSupabaseConfigured && canReport })
  const [busyId, setBusyId] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: ({ type, id, attestation, viewed }: { type: 'announcement' | 'training' | 'schedule'; id: string; attestation?: string; viewed?: boolean }) => viewed ? markEmployeeActionViewed(type, id) : completeEmployeeAction(type, id, attestation),
    onMutate: ({ id }) => setBusyId(id),
    onSuccess: async (data) => {
      queryClient.setQueryData(['employee-action-center'], data)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['employee-action-history'] }),
        queryClient.invalidateQueries({ queryKey: ['employee-action-report'] }),
      ])
    },
    onSettled: () => setBusyId(null),
  })

  const hrTaskMutation = useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note: string }) => completeHrAutomationTask(taskId, note),
    onMutate: ({ taskId }) => {
      setBusyId(taskId)
      setHrTaskError(null)
    },
    onSuccess: async () => {
      setSelectedHrTask(null)
      setHrCompletionNote('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hr-automation-actions'] }),
        queryClient.invalidateQueries({ queryKey: ['employee-action-history'] }),
      ])
    },
    onError: (error: Error) => setHrTaskError(error.message),
    onSettled: () => setBusyId(null),
  })

  async function openHrTask(task: HrAutomationTask) {
    setSelectedHrTask(task)
    setHrCompletionNote('')
    setHrTaskError(null)
    if (task.status === 'open') {
      try {
        await markHrAutomationTaskViewed(task.id)
        await queryClient.invalidateQueries({ queryKey: ['hr-automation-actions'] })
      } catch (error) {
        setHrTaskError(error instanceof Error ? error.message : 'The HR action could not be opened.')
      }
    }
  }

  const summary = useMemo(() => actionQuery.data?.summary, [actionQuery.data])
  const attentionActions = useMemo(() => actionQuery.data ? filteredEmployeeActions(actionQuery.data, 'attention') : null, [actionQuery.data])
  const inProgressActions = useMemo(() => actionQuery.data ? filteredEmployeeActions(actionQuery.data, 'in_progress') : null, [actionQuery.data])
  const attentionHrTasks = useMemo(() => (hrTasksQuery.data?.tasks ?? []).filter((task) => task.status === 'open'), [hrTasksQuery.data])
  const inProgressHrTasks = useMemo(() => (hrTasksQuery.data?.tasks ?? []).filter((task) => task.status === 'viewed'), [hrTasksQuery.data])
  const attentionCount = (attentionActions?.summary.announcementCount ?? 0) + (attentionActions?.summary.trainingCount ?? 0) + (attentionActions?.summary.scheduleCount ?? 0) + attentionHrTasks.length
  const inProgressCount = (inProgressActions?.summary.announcementCount ?? 0) + (inProgressActions?.summary.trainingCount ?? 0) + (inProgressActions?.summary.scheduleCount ?? 0) + inProgressHrTasks.length

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Action Center needs the secure connection" tone="setup"><p>Connect Supabase to load employee actions.</p></DataStatePanel>
  if (sessionQuery.isPending || actionQuery.isPending || hrTasksQuery.isPending) return <DataStatePanel icon={FileCheck2} title="Loading Action Center"><p>Checking required employee actions.</p></DataStatePanel>
  if (sessionQuery.isError || actionQuery.isError || hrTasksQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Action Center unavailable" tone="error"><p>{sessionQuery.error?.message ?? actionQuery.error?.message ?? hrTasksQuery.error?.message}</p></DataStatePanel>

  return (
    <div className="page page--action-center">
      <section className="page-intro workforce-intro"><div><p className="eyebrow">Employee actions</p><h1>Action Center</h1><p className="page-summary">Review required announcements, assigned training, and published schedule updates in one clear workspace.</p></div>{canManage ? <button className="primary-action" onClick={() => setTrainingOpen(true)} type="button"><Plus aria-hidden="true" size={18} />Publish training</button> : null}</section>
      <section className="action-summary" aria-label="Pending actions"><article><Megaphone aria-hidden="true" size={20} /><span>Announcements</span><strong>{summary?.announcementCount ?? 0}</strong></article><article><BookOpenCheck aria-hidden="true" size={20} /><span>Training</span><strong>{summary?.trainingCount ?? 0}</strong></article><article><CalendarCheck2 aria-hidden="true" size={20} /><span>Schedules</span><strong>{summary?.scheduleCount ?? 0}</strong></article></section>
      <nav className="action-center-tabs" aria-label="Action Center views">
        <button aria-current={tab === 'attention' ? 'page' : undefined} className={tab === 'attention' ? 'is-active' : ''} onClick={() => setTab('attention')} type="button">Needs Attention<span>{attentionCount}</span></button>
        <button aria-current={tab === 'in_progress' ? 'page' : undefined} className={tab === 'in_progress' ? 'is-active' : ''} onClick={() => setTab('in_progress')} type="button">In Progress<span>{inProgressCount}</span></button>
        <button aria-current={tab === 'history' ? 'page' : undefined} className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')} type="button"><HistoryIcon aria-hidden="true" size={17} />History</button>
      </nav>
      {tab !== 'history' && mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      {tab === 'attention' && attentionActions ? <><HrAutomationActions busyId={busyId} onOpen={openHrTask} tasks={attentionHrTasks} /><EmployeeActions data={attentionActions} busyId={busyId} emptyCopy={{ title: 'Nothing needs your attention', body: 'New required announcements, training, schedules, and HR actions will appear here.' }} onOpen={(type, id) => mutation.mutate({ type, id, viewed: true })} onComplete={(type, id, attestation) => mutation.mutate({ type, id, attestation })} showEmpty={!attentionHrTasks.length} /></> : null}
      {tab === 'in_progress' && inProgressActions ? <><HrAutomationActions busyId={busyId} onOpen={openHrTask} tasks={inProgressHrTasks} /><EmployeeActions data={inProgressActions} busyId={busyId} emptyCopy={{ title: 'Nothing is in progress', body: 'Opening an assigned action moves it here until it is completed.' }} onOpen={(type, id) => mutation.mutate({ type, id, viewed: true })} onComplete={(type, id, attestation) => mutation.mutate({ type, id, attestation })} showEmpty={!inProgressHrTasks.length} /></> : null}
      {tab === 'history' ? <ActionHistoryWorkspace canViewTeam={canViewTeamHistory} /> : null}
      {tab === 'history' && canReport ? <section className="panel action-report"><div className="section-heading"><div><p className="eyebrow">Compliance</p><h2>Completion reporting</h2></div><button className="secondary-button" disabled={!reportQuery.data} onClick={() => reportQuery.data && downloadText(trainingComplianceCsv(reportQuery.data), `sygshift-training-completion-${new Date().toISOString().slice(0, 10)}.csv`)} type="button"><Download aria-hidden="true" size={17} />Export training</button></div><div className="action-report-grid"><article><span>Announcement records</span><strong>{reportQuery.data?.announcements.length ?? 0}</strong></article><article><span>Training records</span><strong>{reportQuery.data?.training.length ?? 0}</strong></article><article><span>Schedule records</span><strong>{reportQuery.data?.schedules.length ?? 0}</strong></article></div></section> : null}
      {trainingOpen ? <TrainingEditor onClose={() => setTrainingOpen(false)} onPublished={async () => { setTrainingOpen(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ['training-catalog'] }), queryClient.invalidateQueries({ queryKey: ['employee-action-center'] }), queryClient.invalidateQueries({ queryKey: ['employee-action-report'] })]) }} /> : null}
      {selectedHrTask ? (
        <ModalDialog busy={hrTaskMutation.isPending} busyLabel="Completing HR action…" className="modal-dialog--hr-action" description="Review the instructions and record a clear completion note. The original workflow and audit history are preserved." onClose={() => { setSelectedHrTask(null); setHrCompletionNote(''); setHrTaskError(null) }} title={selectedHrTask.title}>
          <form className="hr-action-completion" onSubmit={(event) => {
            event.preventDefault()
            const note = hrCompletionNote.trim()
            if (!note) {
              setHrTaskError('A completion note is required.')
              return
            }
            hrTaskMutation.mutate({ taskId: selectedHrTask.id, note })
          }}>
            <section className="hr-action-instructions"><p className="eyebrow">Required action</p><p>{selectedHrTask.instructions ?? 'Complete the requested HR action, then document what was completed.'}</p><small>Due {formatDateTime(selectedHrTask.dueAt)} · Status {selectedHrTask.status}</small></section>
            <label className="form-field"><span>Completion note</span><textarea autoFocus onChange={(event) => setHrCompletionNote(event.target.value)} placeholder="Describe what was completed and include any relevant follow-up." required rows={5} value={hrCompletionNote} /></label>
            {hrTaskError ? <div className="inline-alert" role="alert">{hrTaskError}</div> : null}
            <div className="modal-actions"><button className="secondary-button" onClick={() => { setSelectedHrTask(null); setHrCompletionNote(''); setHrTaskError(null) }} type="button">Cancel</button><button className="primary-action" type="submit"><CheckCircle2 aria-hidden="true" size={17} />Complete action</button></div>
          </form>
        </ModalDialog>
      ) : null}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Pencil, Plus, Search, ShieldAlert, Trash2 } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  acceptVacancyPatrolRecovery,
  getVacancyPatrolRecovery,
  getVacancyPatrolRecoveryWorklist,
  updateVacancyPatrolRecovery,
  type VacancyPatrolRecoveryDetail,
  type VacancyPatrolRecoveryStage,
  type VacancyPatrolRecoveryWorklistStatus,
} from '../data/vacancyPatrolOperations'
import { scheduleWallClockToInstant } from '../schedule/timeBasis'

const pageSizes = [5, 10, 20] as const
const maxPlanWindows = 24
const maxPlanHits = 50
const maxWindowHits = 25

interface EditablePlanWindow {
  key: string
  plannedHits: string
  windowEnd: string
  windowStart: string
}

const stageLabels: Record<VacancyPatrolRecoveryStage, string> = {
  canceled: 'Canceled',
  completed: 'Patrol reconciled',
  declined: 'Declined',
  finance_reviewed: 'Finance reviewed',
  partial: 'Patrol partial',
  patrol_planned: 'Patrol planned',
  requested: 'Patrol review',
}

const statusOptions: Array<{ label: string; value: VacancyPatrolRecoveryWorklistStatus }> = [
  { label: 'All workflow statuses', value: 'all' },
  { label: 'Awaiting Patrol review', value: 'requested' },
  { label: 'Patrol planned', value: 'patrol_planned' },
  { label: 'In progress', value: 'in_progress' },
  { label: 'Reconciled', value: 'completed' },
  { label: 'Declined', value: 'declined' },
  { label: 'Canceled', value: 'canceled' },
]

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dateFromToday(offset: number): string {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return isoDate(date)
}

function formatDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const parsed = new Date(year, month - 1, day, 12)
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(parsed)
}

function formatDateTime(value: string, timeZone: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit', hour: 'numeric', minute: '2-digit', month: '2-digit',
    timeZone, timeZoneName: 'short', year: 'numeric',
  }).format(parsed)
}

function zonedDateTimeInput(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', timeZone, year: 'numeric',
  }).formatToParts(new Date(value))
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`
}

function localInputToInstant(value: string, timeZone: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
  if (!match) throw new Error('Enter a complete date and time for every visit window.')
  return scheduleWallClockToInstant(match[1], match[2], timeZone)
}

function editablePlanWindow(window: VacancyPatrolRecoveryDetail['hitWindows'][number], timeZone: string): EditablePlanWindow {
  return {
    key: crypto.randomUUID(),
    plannedHits: String(window.plannedHits),
    windowEnd: zonedDateTimeInput(window.windowEndAt, timeZone),
    windowStart: zonedDateTimeInput(window.windowStartAt, timeZone),
  }
}

function editablePlanHitCount(windows: EditablePlanWindow[]): number {
  return windows.reduce((total, window) => {
    const plannedHits = Number(window.plannedHits)
    return total + (Number.isInteger(plannedHits) && plannedHits > 0 ? plannedHits : 0)
  }, 0)
}

function hitProgress(detail: Pick<VacancyPatrolRecoveryDetail, 'completedHits' | 'hitWindows'>): string {
  const missedHits = detail.hitWindows.reduce((total, window) => total + window.missedHits, 0)
  const remainingHits = detail.hitWindows.reduce((total, window) => total + window.remainingHits, 0)
  return `${detail.completedHits} completed · ${missedHits} missed · ${remainingHits} remaining`
}

function workflowStatusLabel(status: VacancyPatrolRecoveryDetail['status']): string {
  if (status === 'completed') return 'Patrol reconciled'
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function stageTone(stage: VacancyPatrolRecoveryStage): string {
  if (stage === 'completed' || stage === 'finance_reviewed') return 'completed'
  if (stage === 'declined' || stage === 'canceled') return 'missed'
  if (stage === 'partial') return 'late'
  if (stage === 'patrol_planned') return 'active'
  return 'scheduled'
}

function locationLabel(detail: Pick<VacancyPatrolRecoveryDetail, 'shift'>): string {
  return [detail.shift.clientName, detail.shift.siteName, detail.shift.postName].filter(Boolean).join(' · ') || 'Location not linked'
}

function invalidateRecoveryQueries(queryClient: ReturnType<typeof useQueryClient>, requestId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-worklist'] }),
    queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-detail', requestId] }),
    queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-map'] }),
    queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }),
    queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-finance-report'] }),
  ])
}

function RecoveryReviewDialog({ onClose, requestId }: { onClose: () => void; requestId: string }) {
  const queryClient = useQueryClient()
  const [routeId, setRouteId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [note, setNote] = useState('')
  const [editingPlan, setEditingPlan] = useState(false)
  const [planNote, setPlanNote] = useState('')
  const [planWindows, setPlanWindows] = useState<EditablePlanWindow[]>([])
  const [planValidationError, setPlanValidationError] = useState<string | null>(null)
  const [planSavedMessage, setPlanSavedMessage] = useState<string | null>(null)
  const planKey = useRef(crypto.randomUUID())
  const [acceptKey] = useState(() => crypto.randomUUID())
  const [declineKey] = useState(() => crypto.randomUUID())
  const [cancelKey] = useState(() => crypto.randomUUID())
  const [reconcileKey] = useState(() => crypto.randomUUID())
  const query = useQuery({
    queryKey: ['vacancy-patrol-recovery-detail', requestId],
    queryFn: () => getVacancyPatrolRecovery(requestId),
  })
  const detail = query.data
  const selectedRoute = detail?.routeChoices.find((route) => route.routeId === routeId) ?? null
  const eligibleEmployees = useMemo(
    () => detail?.employeeChoices.filter((employee) => !selectedRoute?.requiresArmed || employee.armedQualified) ?? [],
    [detail?.employeeChoices, selectedRoute?.requiresArmed],
  )

  useEffect(() => {
    if (!detail || routeId) return
    setRouteId(detail.routeChoices.find((route) => route.isRequestedRoute)?.routeId ?? detail.routeChoices[0]?.routeId ?? '')
  }, [detail, routeId])

  useEffect(() => {
    if (!detail || !selectedRoute) return
    if (eligibleEmployees.some((employee) => employee.employeeId === employeeId)) return
    setEmployeeId(eligibleEmployees[0]?.employeeId ?? '')
  }, [detail, eligibleEmployees, employeeId, selectedRoute])

  const acceptMutation = useMutation({
    mutationFn: () => acceptVacancyPatrolRecovery({ employeeId, idempotencyKey: acceptKey, note, requestId, routeId }),
    onSuccess: async () => { await invalidateRecoveryQueries(queryClient, requestId); onClose() },
  })
  const updateMutation = useMutation({
    mutationFn: (action: 'decline' | 'cancel' | 'reconcile') => updateVacancyPatrolRecovery({
      action,
      idempotencyKey: action === 'decline' ? declineKey : action === 'cancel' ? cancelKey : reconcileKey,
      note,
      requestId,
    }),
    onSuccess: async () => { await invalidateRecoveryQueries(queryClient, requestId); onClose() },
  })
  const planMutation = useMutation({
    mutationFn: ({ hitWindows, note: updateNote }: { hitWindows: Array<{ plannedHits: number; windowEndAt: string; windowStartAt: string }>; note: string }) => updateVacancyPatrolRecovery({
      action: 'update_plan',
      hitWindows,
      idempotencyKey: planKey.current,
      note: updateNote,
      requestId,
    }),
    onSuccess: async (receipt) => {
      await invalidateRecoveryQueries(queryClient, requestId)
      planKey.current = crypto.randomUUID()
      setEditingPlan(false)
      setPlanNote('')
      setPlanValidationError(null)
      setPlanSavedMessage(`Visit plan saved with ${receipt.plannedHits} planned hit${receipt.plannedHits === 1 ? '' : 's'}.`)
    },
  })
  const busy = acceptMutation.isPending || updateMutation.isPending || planMutation.isPending
  const error = acceptMutation.error ?? updateMutation.error

  function beginPlanEdit() {
    if (!detail || detail.status !== 'requested' || !detail.permissions.canUpdate) return
    planKey.current = crypto.randomUUID()
    setPlanWindows(detail.hitWindows
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((window) => editablePlanWindow(window, detail.shift.timeZone)))
    setPlanNote('')
    setPlanValidationError(null)
    setPlanSavedMessage(null)
    planMutation.reset()
    setEditingPlan(true)
  }

  function updatePlanWindow(key: string, update: Partial<EditablePlanWindow>) {
    setPlanValidationError(null)
    setPlanSavedMessage(null)
    planMutation.reset()
    setPlanWindows((current) => current.map((window) => window.key === key ? { ...window, ...update } : window))
  }

  function addPlanWindow() {
    if (!detail || planWindows.length >= maxPlanWindows) return
    const lastWindow = planWindows[planWindows.length - 1]
    setPlanValidationError(null)
    planMutation.reset()
    setPlanWindows((current) => [...current, {
      key: crypto.randomUUID(),
      plannedHits: '1',
      windowEnd: zonedDateTimeInput(detail.shift.endsAt, detail.shift.timeZone),
      windowStart: lastWindow?.windowEnd ?? zonedDateTimeInput(detail.shift.startsAt, detail.shift.timeZone),
    }])
  }

  function submitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || detail.status !== 'requested' || !detail.permissions.canUpdate) return
    setPlanValidationError(null)
    planMutation.reset()
    try {
      const updateNote = planNote.trim()
      if (updateNote.length < 5 || updateNote.length > 1000) {
        throw new Error('Add a plan update note between 5 and 1,000 characters.')
      }
      if (planWindows.length < 1 || planWindows.length > maxPlanWindows) {
        throw new Error(`Choose between 1 and ${maxPlanWindows} visit windows.`)
      }
      const shiftStartsAt = new Date(detail.shift.startsAt).getTime()
      const shiftEndsAt = new Date(detail.shift.endsAt).getTime()
      const hitWindows = planWindows.map((window, index) => {
        const plannedHits = Number(window.plannedHits)
        if (!Number.isInteger(plannedHits) || plannedHits < 1 || plannedHits > maxWindowHits) {
          throw new Error(`Visit window ${index + 1} needs between 1 and ${maxWindowHits} planned hits.`)
        }
        const windowStartAt = localInputToInstant(window.windowStart, detail.shift.timeZone)
        const windowEndAt = localInputToInstant(window.windowEnd, detail.shift.timeZone)
        const startsAt = new Date(windowStartAt).getTime()
        const endsAt = new Date(windowEndAt).getTime()
        if (endsAt <= startsAt) throw new Error(`Visit window ${index + 1} must end after it starts.`)
        if (startsAt < shiftStartsAt || endsAt > shiftEndsAt) {
          throw new Error(`Visit window ${index + 1} must stay inside the published shift window.`)
        }
        return { plannedHits, windowEndAt, windowStartAt }
      }).sort((left, right) => left.windowStartAt.localeCompare(right.windowStartAt))
      for (let index = 1; index < hitWindows.length; index += 1) {
        if (new Date(hitWindows[index].windowStartAt).getTime() < new Date(hitWindows[index - 1].windowEndAt).getTime()) {
          throw new Error('Visit windows cannot overlap. Give every window a distinct time range.')
        }
      }
      if (hitWindows.reduce((total, window) => total + window.plannedHits, 0) > maxPlanHits) {
        throw new Error(`A recovery plan cannot contain more than ${maxPlanHits} planned hits.`)
      }
      planMutation.mutate({ hitWindows, note: updateNote })
    } catch (submissionError) {
      setPlanValidationError(submissionError instanceof Error ? submissionError.message : 'Review the visit plan and try again.')
    }
  }

  return <ModalDialog busy={busy} busyLabel={planMutation.isPending ? 'Saving the updated visit plan...' : 'Saving the audited Patrol decision...'} className="reports-detail-modal" description="Review the original published vacancy, requested visit windows, route preference, and decision history before creating Patrol work." onClose={onClose} title={detail?.requestNumber ?? 'Vacancy Patrol recovery'}>
    {query.isPending ? <div className="report-empty">Loading the current recovery request…</div> : null}
    {query.isError ? <div className="inline-alert" role="alert">{query.error.message}</div> : null}
    {detail ? <>
      <div className="reports-detail-grid">
        <div><span>Workflow stage</span><strong>{stageLabels[detail.displayStage]}</strong></div>
        <div><span>Published shift</span><strong>{formatDateTime(detail.shift.startsAt, detail.shift.timeZone)} – {formatDateTime(detail.shift.endsAt, detail.shift.timeZone)}</strong></div>
        <div><span>Client / site / post</span><strong>{locationLabel(detail)}</strong></div>
        <div><span>Requested route</span><strong>{detail.requestedRoute.name} · {detail.requestedRoute.code}</strong></div>
        <div><span>Hit progress</span><strong>{hitProgress(detail)}</strong></div>
        <div><span>Schedule status</span><strong>{detail.shift.isPublished ? 'Published' : 'Not published'} · {detail.shift.isUnassigned ? 'Still unassigned' : 'Assigned'}</strong></div>
        <div className="patrol-form--wide"><span>Operational reason</span><strong>{detail.reason}</strong></div>
      </div>

      <section className="patrol-makeup-work">
        <div className="patrol-section-heading">
          <div><strong>Requested visit windows</strong><p>{detail.hitWindows.length} window{detail.hitWindows.length === 1 ? '' : 's'} · {detail.plannedHits} planned hit{detail.plannedHits === 1 ? '' : 's'}</p></div>
          {detail.status === 'requested' && detail.permissions.canUpdate && !editingPlan ? <button className="secondary-button secondary-button--small" disabled={busy} onClick={beginPlanEdit} type="button"><Pencil aria-hidden="true" size={16} />Edit visit plan</button> : null}
        </div>
        {detail.hitWindows.map((window) => <div className="patrol-operation-row" key={window.hitWindowId}>
          <div><strong>Window {window.sequence}</strong><span>{formatDateTime(window.windowStartAt, detail.shift.timeZone)} – {formatDateTime(window.windowEndAt, detail.shift.timeZone)}</span></div>
          <div><strong>{window.completedHits} completed</strong><span>{window.missedHits} missed · {window.remainingHits} remaining</span></div>
          <span className={`patrol-status patrol-status--${window.status === 'completed' ? 'completed' : window.status === 'missed' ? 'missed' : window.status === 'partial' ? 'late' : 'scheduled'}`}>{window.status.replaceAll('_', ' ')}</span>
        </div>)}
      </section>

      {planSavedMessage ? <div className="schedule-workflow-note schedule-workflow-note--send" role="status"><CheckCircle2 aria-hidden="true" size={20} /><p><strong>{planSavedMessage}</strong><br />Review the refreshed plan, then choose the accepted route and qualified Patrol employee.</p></div> : null}

      {detail.status === 'requested' && detail.permissions.canUpdate && editingPlan ? <form aria-label="Edit requested visit plan" className="patrol-form" onSubmit={submitPlan}>
        <section aria-labelledby="vacancy-patrol-plan-editor-title" className="scheduler-workflow-options patrol-form--wide">
          <div className="panel-heading">
            <div><strong id="vacancy-patrol-plan-editor-title">Edit requested visit plan</strong><p className="form-note">Keep 1–24 non-overlapping windows inside the published shift. Each window allows 1–25 hits, with 50 hits maximum across the plan.</p></div>
            <button className="secondary-button secondary-button--small" disabled={planMutation.isPending || planWindows.length >= maxPlanWindows} onClick={addPlanWindow} type="button"><Plus aria-hidden="true" size={16} />Add window</button>
          </div>
          {planWindows.map((window, index) => <div className="scheduler-workflow-options" key={window.key}>
            <div className="panel-heading">
              <div><strong>Window {index + 1}</strong><p className="form-note">Times use {detail.shift.timeZone}.</p></div>
              {planWindows.length > 1 ? <button aria-label={`Remove visit window ${index + 1}`} className="secondary-button secondary-button--small danger-button" disabled={planMutation.isPending} onClick={() => { setPlanValidationError(null); planMutation.reset(); setPlanWindows((current) => current.filter((item) => item.key !== window.key)) }} type="button"><Trash2 aria-hidden="true" size={16} />Remove</button> : null}
            </div>
            <div className="form-grid form-grid--three">
              <label><span>Window {index + 1} starts</span><input disabled={planMutation.isPending} onChange={(event) => updatePlanWindow(window.key, { windowStart: event.target.value })} required type="datetime-local" value={window.windowStart} /></label>
              <label><span>Window {index + 1} ends</span><input disabled={planMutation.isPending} onChange={(event) => updatePlanWindow(window.key, { windowEnd: event.target.value })} required type="datetime-local" value={window.windowEnd} /></label>
              <label><span>Window {index + 1} planned hits</span><input disabled={planMutation.isPending} inputMode="numeric" max={maxWindowHits} min={1} onChange={(event) => updatePlanWindow(window.key, { plannedHits: event.target.value })} required step={1} type="number" value={window.plannedHits} /></label>
            </div>
          </div>)}
          <p className="form-note" role="status">Current draft: {planWindows.length} window{planWindows.length === 1 ? '' : 's'} · {editablePlanHitCount(planWindows)} planned hit{editablePlanHitCount(planWindows) === 1 ? '' : 's'}.</p>
        </section>
        <label className="patrol-form--wide"><span>Plan update note</span><textarea aria-label="Plan update note" disabled={planMutation.isPending} maxLength={1000} minLength={5} onChange={(event) => { setPlanNote(event.target.value); setPlanValidationError(null); planMutation.reset() }} placeholder="Explain what changed in the requested windows and why." required rows={3} value={planNote} /><small>Required · 5–1,000 characters. The note is preserved in decision history.</small></label>
        {planValidationError ? <div className="inline-alert patrol-form--wide" role="alert">{planValidationError}</div> : null}
        {planMutation.isError ? <div className="inline-alert patrol-form--wide" role="alert">{planMutation.error.message}</div> : null}
        <div className="modal-actions patrol-form--wide"><button className="primary-action" disabled={planMutation.isPending || planNote.trim().length < 5 || planNote.trim().length > 1000 || planWindows.length < 1 || editablePlanHitCount(planWindows) < 1} type="submit">{planMutation.isPending ? 'Saving plan...' : 'Save visit plan'}</button><button className="secondary-button" disabled={planMutation.isPending} onClick={() => { setEditingPlan(false); setPlanValidationError(null); planMutation.reset() }} type="button">Keep current plan</button></div>
      </form> : null}

      {detail.status === 'requested' && detail.permissions.canAccept && !editingPlan ? <form className="patrol-form" onSubmit={(event) => { event.preventDefault(); acceptMutation.mutate() }}>
        <label><span>Accepted Patrol route</span><select data-dialog-autofocus onChange={(event) => setRouteId(event.target.value)} required value={routeId}><option value="">Choose a route</option>{detail.routeChoices.map((route) => <option key={route.routeId} value={route.routeId}>{route.name} · {route.code}{route.isRequestedRoute ? ' · Requested' : ''}{route.requiresArmed ? ' · Armed' : ''}</option>)}</select></label>
        <label><span>Assigned Patrol employee</span><select onChange={(event) => setEmployeeId(event.target.value)} required value={employeeId}><option value="">Choose an employee</option>{detail.employeeChoices.map((employee) => <option disabled={Boolean(selectedRoute?.requiresArmed && !employee.armedQualified)} key={employee.employeeId} value={employee.employeeId}>{employee.name} · {employee.employeeNumber ?? 'ID not recorded'}{employee.armedQualified ? ' · Armed qualified' : ''}</option>)}</select></label>
        <label className="patrol-form--wide"><span>Manager decision note</span><textarea minLength={5} onChange={(event) => { setNote(event.target.value); acceptMutation.reset(); updateMutation.reset() }} placeholder="Document the route, employee, visit-window, and exception review." required rows={4} value={note} /></label>
        {error ? <div className="inline-alert patrol-form--wide" role="alert">{error.message}</div> : null}
        <div className="modal-actions patrol-form--wide"><button className="primary-action" disabled={busy || !routeId || !employeeId || note.trim().length < 5} type="submit"><CheckCircle2 aria-hidden="true" size={18} />Accept and plan Patrol</button>{detail.permissions.canUpdate ? <button className="secondary-button" disabled={busy || note.trim().length < 5} onClick={() => updateMutation.mutate('decline')} type="button">Decline request</button> : null}<button className="secondary-button" disabled={busy} onClick={onClose} type="button">Close</button></div>
      </form> : null}

      {detail.status !== 'requested' ? <div className="patrol-form">
        <label className="patrol-form--wide"><span>Operational update note</span><textarea minLength={5} onChange={(event) => { setNote(event.target.value); updateMutation.reset() }} placeholder="Document why completion is being reconciled." rows={3} value={note} /></label>
        {error ? <div className="inline-alert patrol-form--wide" role="alert">{error.message}</div> : null}
        <div className="modal-actions patrol-form--wide">{detail.permissions.canUpdate && (detail.status === 'patrol_planned' || detail.status === 'in_progress' || detail.status === 'completed') ? <button className="primary-action" disabled={busy || note.trim().length < 5} onClick={() => updateMutation.mutate('reconcile')} type="button"><ClipboardCheck aria-hidden="true" size={18} />Reconcile submitted hits</button> : null}{detail.permissions.canUpdate && (detail.status === 'patrol_planned' || detail.status === 'in_progress') ? <button className="secondary-button" disabled={busy || note.trim().length < 5} onClick={() => updateMutation.mutate('cancel')} type="button">Cancel recovery</button> : null}<button className="secondary-button" disabled={busy} onClick={onClose} type="button">Close</button></div>
      </div> : null}

      <section className="patrol-makeup-work">
        <strong>Decision history</strong>
        {detail.statusHistory.map((event) => <div className="patrol-operation-row" key={event.historyId}>
          <div><strong>{event.action.replaceAll('_', ' ')}</strong><span>{event.actorName ?? 'System'} · {formatDateTime(event.createdAt, detail.shift.timeZone)}</span></div>
          <div><strong>{workflowStatusLabel(event.toStatus)}</strong><span>{event.note ?? 'No note recorded'}</span></div>
        </div>)}
      </section>
    </> : null}
  </ModalDialog>
}

export function VacancyPatrolRecoveryWorkspace() {
  const [from, setFrom] = useState(() => dateFromToday(-30))
  const [through, setThrough] = useState(() => dateFromToday(60))
  const [status, setStatus] = useState<VacancyPatrolRecoveryWorklistStatus>('requested')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(10)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const rangeDays = (Date.parse(through) - Date.parse(from)) / 86_400_000
  const validRange = Boolean(from && through && through >= from && rangeDays <= 93)
  const query = useQuery({
    enabled: validRange,
    queryKey: ['vacancy-patrol-recovery-worklist', from, through, status],
    queryFn: () => getVacancyPatrolRecoveryWorklist({ from, status, through }),
  })
  const rows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (query.data?.requests ?? []).filter((request) => !term || [
      request.requestNumber,
      request.reason,
      request.shift.clientName,
      request.shift.siteName,
      request.shift.postName,
      request.requestedRoute.name,
      request.acceptedRoute?.name,
      request.assignedEmployee?.name,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(term))
  }, [query.data?.requests, search])
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const visibleRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize)
  const counts = query.data?.counts

  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])

  return <section aria-labelledby="vacancy-patrol-recovery-title">
    <section className="operations-panel patrol-priority-panel">
      <div className="patrol-section-heading"><div><p className="eyebrow">Schedule handoff</p><h2 id="vacancy-patrol-recovery-title">Vacancy Patrol recovery</h2><p>Review requested visit windows, choose the accepted route and qualified Patrol employee, and preserve the original open shift and billing handoff as separate records.</p></div></div>
    </section>

    <section aria-label="Vacancy Patrol recovery totals" className="patrol-metrics">
      <article><ClipboardCheck aria-hidden="true" /><div><span>Awaiting review</span><strong>{counts?.requested ?? 0}</strong><small>Need a Patrol decision</small></div></article>
      <article><CheckCircle2 aria-hidden="true" /><div><span>Patrol planned</span><strong>{counts?.patrolPlanned ?? 0}</strong><small>Accepted and assigned</small></div></article>
      <article><AlertTriangle aria-hidden="true" /><div><span>In progress</span><strong>{counts?.inProgress ?? 0}</strong><small>Partially documented</small></div></article>
      <article><CheckCircle2 aria-hidden="true" /><div><span>Reconciled</span><strong>{counts?.completed ?? 0}</strong><small>Ready for Finance review</small></div></article>
    </section>

    <section aria-label="Vacancy Patrol recovery controls" className="operations-panel reports-workspace-controls">
      <div className="reports-range"><label><span>From</span><input max={through} onChange={(event) => { setFrom(event.target.value); setPage(1) }} type="date" value={from} /></label><label><span>Through</span><input min={from} onChange={(event) => { setThrough(event.target.value); setPage(1) }} type="date" value={through} /></label></div>
      <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Request, client, site, route, or employee" type="search" value={search} /></span></label>
      <div className="reports-filter-row"><label><span>Workflow status</span><select onChange={(event) => { setStatus(event.target.value as VacancyPatrolRecoveryWorklistStatus); setPage(1) }} value={status}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as (typeof pageSizes)[number]); setPage(1) }} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label></div>
      {!validRange ? <div className="inline-alert" role="alert">Choose a valid date range of 93 days or fewer.</div> : null}
      {query.data && !query.data.permissions.canAccept && !query.data.permissions.canUpdate ? <div className="reports-export-note"><ShieldAlert aria-hidden="true" size={18} /><span>You can review these requests, but a Patrol Assignment Management permission with verified MFA is required to decide them.</span></div> : null}
    </section>

    <section aria-live="polite" className="operations-panel reports-results">
      <div className="reports-section-heading"><div><p className="eyebrow">Manager worklist</p><h2>{query.isSuccess ? `${rows.length} recovery request${rows.length === 1 ? '' : 's'}` : 'Vacancy recovery requests'}</h2><p>Accepting creates protected Patrol work. It does not fill the original shift, change attendance, or approve a client charge.</p></div></div>
      {validRange && query.isPending ? <div className="report-empty">Loading vacancy recovery requests…</div> : null}
      {query.isError ? <DataStatePanel icon={ShieldAlert} title="Vacancy recovery unavailable" tone="error"><p>{query.error.message}</p></DataStatePanel> : null}
      {query.isSuccess && rows.length === 0 ? <div className="report-empty">No vacancy recovery requests match this date range, status, and search.</div> : null}
      {visibleRows.length ? <div className="reports-result-list">{visibleRows.map((request) => <article className="reports-result-card" key={request.requestId}>
        <dl className="reports-result-summary">
          <div><dt>Request</dt><dd>{request.requestNumber}<small>{formatDate(request.shift.weekStartsOn)} schedule week</small></dd></div>
          <div><dt>Shift</dt><dd>{formatDateTime(request.shift.startsAt, request.shift.timeZone)}<small>{request.shift.scheduleName ?? 'Published schedule'}</small></dd></div>
          <div><dt>Client / location</dt><dd>{locationLabel(request)}<small>{request.shift.requiresArmed ? 'Armed shift' : 'Unarmed shift'}</small></dd></div>
          <div><dt>Recovery plan</dt><dd>{hitProgress(request)}<small>{request.acceptedRoute?.name ?? `${request.requestedRoute.name} requested`}</small></dd></div>
          <div><dt>Status</dt><dd><span className={`patrol-status patrol-status--${stageTone(request.displayStage)}`}>{stageLabels[request.displayStage]}</span><small>{request.assignedEmployee?.name ?? 'No Patrol employee assigned'}</small></dd></div>
        </dl>
        <button className="secondary-button" onClick={() => setSelectedRequestId(request.requestId)} type="button">Review request</button>
      </article>)}</div> : null}
      {totalPages > 1 ? <div aria-label="Vacancy recovery pages" className="reports-pagination"><button className="secondary-button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button"><ChevronLeft aria-hidden="true" size={17} />Previous</button><span>Page {safePage} of {totalPages}</span><button className="secondary-button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} type="button">Next<ChevronRight aria-hidden="true" size={17} /></button></div> : null}
    </section>

    {selectedRequestId ? <RecoveryReviewDialog onClose={() => setSelectedRequestId(null)} requestId={selectedRequestId} /> : null}
  </section>
}

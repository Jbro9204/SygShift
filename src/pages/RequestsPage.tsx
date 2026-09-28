import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  CalendarCheck2,
  CalendarOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  ClipboardCheck,
  Clock3,
  DatabaseZap,
  FileText,
  History,
  Megaphone,
  Plus,
  Route,
  Search,
  ShieldAlert,
  TriangleAlert,
  Umbrella,
  UserCheck,
  UsersRound,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { TimeOffRequestModal, TimeOffReviewDialog } from '../components/TimeOffRequestModal'
import {
  decideShiftRequest,
  employeeName,
  getCallOffCoverageWorkspace,
  getRequestCenter,
  reportCallOff,
  resolveCallOffCoverage,
  requestShiftLocation,
  requestShiftTitle,
  withdrawTimeOff,
  type CallOffReport,
  type CallOffCoverageMode,
  type RequestShift,
  type ShiftWorkRequest,
  type TimeOffRequest,
  type TimeOffRequestKind,
  type UpcomingAssignment,
} from '../data/requests'
import { isSupabaseConfigured } from '../lib/supabase'
import { dateKeyInTimeZone, formatDualTimeRange, OPERATIONAL_TIME_ZONE } from '../lib/time'
import { isContinentalUsTimeZone } from '../lib/usTimeZones'
import { buildCoverageCandidateDirectory } from './coverageCandidates'

type RequestAction =
  | { kind: 'withdraw-time-off'; requestId: string }
  | { kind: 'report-call-off'; shiftId: string; reason: string }
  | { kind: 'decide-shift'; requestId: string; decision: 'approved' | 'declined'; note: string | null }

function useRequestAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (action: RequestAction) => {
      switch (action.kind) {
        case 'withdraw-time-off': return withdrawTimeOff(action.requestId)
        case 'report-call-off': return reportCallOff(action.shiftId, action.reason)
        case 'decide-shift': return decideShiftRequest(action.requestId, action.decision, action.note)
      }
    },
    onMutate: async (action) => {
      if (action.kind !== 'decide-shift') return undefined

      await queryClient.cancelQueries({ queryKey: ['request-center'] })
      const previous = queryClient.getQueryData<Awaited<ReturnType<typeof getRequestCenter>>>(['request-center'])

      if (previous) {
        queryClient.setQueryData<Awaited<ReturnType<typeof getRequestCenter>>>(['request-center'], {
          ...previous,
          timeOff: previous.timeOff,
          shiftRequests: previous.shiftRequests.filter((request) => request.id !== action.requestId),
        })
      }

      return { previous }
    },
    onError: (_error, _action, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['request-center'], context.previous)
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['request-center'] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] }),
      ])
    },
  })
}

function formatShiftDate(shift: RequestShift): string {
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    timeZone: shift.time_zone,
  }).format(new Date(shift.starts_at))
  return `${date} · ${formatDualTimeRange(shift.starts_at, shift.ends_at, shift.time_zone)}`
}

function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    approved: 'Approved',
    canceled: 'Canceled',
    declined: 'Declined',
    pending: 'Pending review',
    withdrawn: 'Withdrawn',
  }
  return <span className={`status-badge status-badge--${status}`}>{labels[status] ?? status.replaceAll('_', ' ')}</span>
}

function formatRequestDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00`))
}

function formatRequestDateRange(request: Pick<TimeOffRequest, 'starts_on' | 'ends_on'>): string {
  const start = formatRequestDate(request.starts_on)
  const end = formatRequestDate(request.ends_on)
  return start === end ? start : `${start} – ${end}`
}

function formatSubmittedDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(new Date(value))
}

function timeOffTypeLabel(value: TimeOffRequestKind | null): string {
  if (value === 'paid_vacation') return 'Paid vacation'
  if (value === 'sick_time') return 'Sick time'
  if (value === 'unpaid_time_off') return 'Unpaid time off'
  return 'Time off'
}

function requestedTimeLabel(minutes: number | null): string {
  if (minutes == null) return 'Calculated during review'
  const hours = minutes / 60
  return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)} hr`
}

function timeOffDurationLabel(request: TimeOffRequest, affectedShiftCount: number): string {
  if (request.partial_day_start && request.partial_day_end) {
    return `${requestedTimeLabel(request.requested_minutes)} partial day`
  }
  const dayLabel = request.starts_on === request.ends_on ? 'Full day' : 'Multiple full days'
  if (affectedShiftCount === 0 || request.requested_minutes === 0) return `${dayLabel} · no scheduled hours affected`
  if (request.requested_minutes == null) return dayLabel
  return `${dayLabel} · ${requestedTimeLabel(request.requested_minutes)} scheduled`
}

interface PendingCallOff {
  assignment: UpcomingAssignment
  reason: string
}

function GuardCallOffForm({
  assignments,
  onConfirm,
}: {
  assignments: UpcomingAssignment[]
  onConfirm: (pending: PendingCallOff) => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const assignment = assignments.find((item) => item.id === String(form.get('assignmentId')))
    if (!assignment) return
    onConfirm({ assignment, reason: String(form.get('reason')).trim() })
  }

  return (
    <section className="request-form-card request-form-card--urgent" aria-labelledby="call-off-form-title">
      <div className="request-card-heading">
        <TriangleAlert aria-hidden="true" size={24} />
        <div>
          <h2 id="call-off-form-title">Report a call-off</h2>
          <p>This is only for a current or upcoming shift already assigned to you.</p>
        </div>
      </div>
      <form className="request-form" onSubmit={submit}>
        <label className="field-stack">
          <span>Assigned shift</span>
          <select disabled={assignments.length === 0} name="assignmentId" required>
            <option value="">Select a shift</option>
            {assignments.map((assignment) => (
              <option value={assignment.id} key={assignment.id}>
                {requestShiftTitle(assignment.shift)} · {formatShiftDate(assignment.shift)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          <span>Reason</span>
          <textarea disabled={assignments.length === 0} maxLength={2000} name="reason" required rows={3} />
        </label>
        {assignments.length === 0 ? <p className="form-note">You have no active assigned shifts to call off.</p> : null}
        <button className="secondary-button danger-button" disabled={assignments.length === 0} type="submit">
          Review call-off
        </button>
      </form>
    </section>
  )
}

function CallOffConfirmation({
  pending,
  mutation,
  onClose,
}: {
  pending: PendingCallOff
  mutation: ReturnType<typeof useRequestAction>
  onClose: () => void
}) {
  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Recording call-off..."
      description="Confirming records the call-off immediately and queues a supervisor alert."
      onClose={onClose}
      title="Confirm this call-off"
    >
      <div className="confirmation-summary">
        <strong>{requestShiftTitle(pending.assignment.shift)}</strong>
        <span>{formatShiftDate(pending.assignment.shift)}</span>
        <span>{requestShiftLocation(pending.assignment.shift)}</span>
      </div>
      <p className="modal-warning">
        SygShift will record the call-off and queue an email alert for supervisors. A supervisor must
        review it before publishing the replacement opening.
      </p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">Go back</button>
        <button
          className="primary-action danger-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({
            kind: 'report-call-off',
            shiftId: pending.assignment.shift.id,
            reason: pending.reason,
          }, { onSuccess: onClose })}
          type="button"
        >
          {mutation.isPending ? 'Reporting…' : 'Confirm call-off'}
        </button>
      </div>
    </ModalDialog>
  )
}

type RequestTab = 'time-off' | 'shift-requests' | 'call-offs'

const requestTabs: Array<{
  description: string
  icon: typeof CalendarOff
  id: RequestTab
  label: string
}> = [
  { id: 'time-off', label: 'Time Off', description: 'Request and track planned time away', icon: Umbrella },
  { id: 'shift-requests', label: 'Shift Requests', description: 'Track requests for open shifts', icon: CalendarCheck2 },
  { id: 'call-offs', label: 'Call-Offs', description: 'Urgent absence and coverage work', icon: TriangleAlert },
]

function RequestWorkspaceTabs({
  activeTab,
  callOffCount,
  onChange,
  shiftRequestCount,
  timeOffCount,
}: {
  activeTab: RequestTab
  callOffCount: number
  onChange: (tab: RequestTab) => void
  shiftRequestCount: number
  timeOffCount: number
}) {
  const counts: Record<RequestTab, number> = {
    'call-offs': callOffCount,
    'shift-requests': shiftRequestCount,
    'time-off': timeOffCount,
  }

  return (
    <nav aria-label="Request workspace" className="request-workspace-tabs">
      {requestTabs.map((tab) => {
        const Icon = tab.icon
        return (
          <button
            aria-current={activeTab === tab.id ? 'page' : undefined}
            className={activeTab === tab.id ? 'is-active' : ''}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            type="button"
          >
            <Icon aria-hidden="true" size={20} />
            <span><strong>{tab.label}</strong><small>{tab.description}</small></span>
            <em aria-label={`${counts[tab.id]} items`}>{counts[tab.id]}</em>
          </button>
        )
      })}
    </nav>
  )
}

function TimeOffRequestCard({
  highlighted = false,
  manager,
  mutationPending,
  onReview,
  onWithdraw,
  ownRequest,
  request,
}: {
  highlighted?: boolean
  manager: boolean
  mutationPending: boolean
  onReview?: (requestId: string) => void
  onWithdraw?: (requestId: string) => void
  ownRequest: boolean
  request: TimeOffRequest
}) {
  const shiftNames = request.affected_shifts
    .slice(0, 2)
    .map((shift) => shift.postName ?? shift.eventName ?? shift.location)
  const partialTime = request.partial_day_start && request.partial_day_end
    ? `${request.partial_day_start.slice(0, 5)} – ${request.partial_day_end.slice(0, 5)}`
    : null
  const affectedShiftCount = Math.max(request.affected_shift_count, request.affected_shifts.length)

  return (
    <article className={`time-off-record${highlighted ? ' time-off-record--highlighted' : ''}`} id={`request-${request.id}`}>
      <header className="time-off-record__header">
        <div>
          {manager ? <span className="time-off-record__employee">{employeeName(request.employee)}{request.employee_number ? ` · ${request.employee_number}` : ''}</span> : null}
          <h3>{timeOffTypeLabel(request.request_type)}</h3>
          <p>{formatRequestDateRange(request)}{partialTime ? ` · ${partialTime}` : ''}</p>
        </div>
        <StatusBadge status={request.status} />
      </header>
      <dl className="time-off-record__details">
        <div><dt>Expected return</dt><dd>{request.return_on ? formatRequestDate(request.return_on) : 'Not provided'}</dd></div>
        <div><dt>Requested time</dt><dd>{timeOffDurationLabel(request, affectedShiftCount)}</dd></div>
        <div>
          <dt>Affected shifts</dt>
          <dd>{affectedShiftCount > 0 ? `${affectedShiftCount} published shift${affectedShiftCount === 1 ? '' : 's'}` : 'No published shifts found'}</dd>
          {shiftNames.length > 0 ? <small>{shiftNames.join(' · ')}{affectedShiftCount > shiftNames.length ? ` +${affectedShiftCount - shiftNames.length} more` : ''}</small> : null}
        </div>
        <div><dt>Submitted</dt><dd>{formatSubmittedDate(request.created_at)}</dd></div>
      </dl>
      <div className="time-off-record__notes">
        <div><span>Reason</span><p>{request.reason || 'No reason was provided.'}</p></div>
        {request.decision_note ? <div><span>Decision note</span><p>{request.decision_note}</p></div> : null}
        {request.decided_at ? <div><span>Decision recorded</span><p>{formatSubmittedDate(request.decided_at)}{request.decided_by_name ? ` by ${request.decided_by_name}` : ''}</p></div> : null}
      </div>
      {request.status === 'pending' ? (
        <footer className="time-off-record__actions">
          {manager && ownRequest ? <span className="time-off-record__self-note">Your request is waiting for a different authorized reviewer.</span> : null}
          {manager && !ownRequest && onReview ? <button className="primary-action" onClick={() => onReview(request.id)} type="button">Review request</button> : null}
          {ownRequest && onWithdraw ? <button className="secondary-button" disabled={mutationPending} onClick={() => onWithdraw(request.id)} type="button">Withdraw request</button> : null}
        </footer>
      ) : null}
    </article>
  )
}

function TimeOffWorkspace({
  historyLimit,
  historyTruncated,
  highlightedRequestId,
  manager,
  mutation,
  onNewRequest,
  onReview,
  onWithdraw,
  requests,
  viewerEmployeeId,
  viewerTimeZone,
}: {
  historyLimit: number | null
  historyTruncated: boolean
  highlightedRequestId: string | null
  manager: boolean
  mutation: ReturnType<typeof useRequestAction>
  onNewRequest: () => void
  onReview: (requestId: string) => void
  onWithdraw: (requestId: string) => void
  requests: TimeOffRequest[]
  viewerEmployeeId: string
  viewerTimeZone: string
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const today = dateKeyInTimeZone(new Date(), viewerTimeZone)
  const pending = requests.filter((request) => request.status === 'pending')
  const approved = requests.filter((request) => request.status === 'approved')
  const completed = requests.filter((request) => ['declined', 'withdrawn', 'canceled'].includes(request.status))
  const pastOrClosed = requests.filter((request) => request.ends_on < today || ['declined', 'withdrawn', 'canceled'].includes(request.status))
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visible = requests.filter((request) => {
    if (status !== 'all' && request.status !== status) return false
    if (!normalizedSearch) return true
    return [
      employeeName(request.employee),
      timeOffTypeLabel(request.request_type),
      request.reason,
      request.decision_note,
      request.starts_on,
      request.ends_on,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch))
  })
  const employeeUpcoming = visible.filter((request) => request.ends_on >= today && ['pending', 'approved'].includes(request.status))
  const employeeHistory = visible.filter((request) => !employeeUpcoming.includes(request))
  const managerPending = visible.filter((request) => request.status === 'pending')
  const managerHistory = visible.filter((request) => request.status !== 'pending')

  const renderRecords = (items: TimeOffRequest[]) => items.map((request) => (
    <TimeOffRequestCard
      highlighted={request.id === highlightedRequestId}
      key={request.id}
      manager={manager}
      mutationPending={mutation.isPending}
      onReview={onReview}
      onWithdraw={onWithdraw}
      ownRequest={request.employee_id === viewerEmployeeId}
      request={request}
    />
  ))

  return (
    <div className="time-off-workspace">
      <section className="time-off-workspace__welcome" aria-labelledby="time-off-workspace-title">
        <div className="time-off-workspace__welcome-icon"><CalendarOff aria-hidden="true" size={28} /></div>
        <div>
          <p className="eyebrow">Planned leave</p>
          <h2 id="time-off-workspace-title">{manager ? 'Time Off workspace' : 'Your time off, all in one place'}</h2>
          <p>{manager ? 'Review new requests, see every decision, and keep the team’s leave record easy to follow.' : 'Submit a request in a few steps, see schedule impact before sending, and follow the decision here.'}</p>
        </div>
        <button className="primary-action" onClick={onNewRequest} type="button"><Plus aria-hidden="true" size={18} />New time-off request</button>
      </section>

      <section className="time-off-status-summary" aria-label={manager ? 'Time-off request totals' : 'My time-off status'}>
        <article className={pending.length > 0 ? 'is-attention' : ''}><Clock3 aria-hidden="true" size={20} /><span>{manager ? 'Awaiting review' : 'Pending'}</span><strong>{pending.length}</strong></article>
        <article><CheckCircle2 aria-hidden="true" size={20} /><span>Approved</span><strong>{approved.length}</strong></article>
        <article><History aria-hidden="true" size={20} /><span>{manager ? 'Closed' : 'Past / closed'}</span><strong>{manager ? completed.length : pastOrClosed.length}</strong></article>
        <article><FileText aria-hidden="true" size={20} /><span>All requests</span><strong>{requests.length}</strong></article>
      </section>

      {manager ? (
        <section className="time-off-workspace__filters" aria-label="Filter time-off requests">
          <label><span>Search requests</span><div><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Employee, date, type, or reason" type="search" value={search} /></div></label>
          <label><span>Status</span><select onChange={(event) => setStatus(event.target.value)} value={status}><option value="all">All statuses</option><option value="pending">Pending review</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="withdrawn">Withdrawn</option><option value="canceled">Canceled</option></select></label>
        </section>
      ) : null}
      {manager && historyTruncated ? <p className="time-off-history-limit" role="note">Showing the newest {historyLimit ?? 100} completed team requests, plus every pending request and your own history.</p> : null}

      {manager ? (
        <div className="time-off-workspace__sections">
          <section className="time-off-request-section" aria-labelledby="pending-time-off-title">
            <div className="time-off-request-section__heading"><div><p className="eyebrow">Needs action</p><h2 id="pending-time-off-title">Pending Time Off review</h2><span>Open each request to confirm dates, return date, estimated time, and affected published shifts.</span></div><strong>{managerPending.length}</strong></div>
            <div className="time-off-record-list">{renderRecords(managerPending)}{managerPending.length === 0 ? <p className="request-list-empty">No pending time-off requests match these filters.</p> : null}</div>
          </section>
          <section className="time-off-request-section" aria-labelledby="time-off-history-title">
            <div className="time-off-request-section__heading"><div><p className="eyebrow">Tracking</p><h2 id="time-off-history-title">Decision history</h2><span>Approved, declined, withdrawn, and canceled requests remain visible here.</span></div><strong>{managerHistory.length}</strong></div>
            <div className="time-off-record-list">{renderRecords(managerHistory)}{managerHistory.length === 0 ? <p className="request-list-empty">No completed requests match these filters.</p> : null}</div>
          </section>
        </div>
      ) : (
        <div className="time-off-workspace__sections">
          <section className="time-off-request-section" aria-labelledby="upcoming-time-off-title">
            <div className="time-off-request-section__heading"><div><p className="eyebrow">Next up</p><h2 id="upcoming-time-off-title">Upcoming requests</h2><span>Pending and approved time away that has not ended yet.</span></div><strong>{employeeUpcoming.length}</strong></div>
            <div className="time-off-record-list">{renderRecords(employeeUpcoming)}{employeeUpcoming.length === 0 ? <p className="request-list-empty">You have no upcoming time-off requests.</p> : null}</div>
          </section>
          <section className="time-off-request-section" aria-labelledby="past-time-off-title">
            <div className="time-off-request-section__heading"><div><p className="eyebrow">History</p><h2 id="past-time-off-title">Past and closed requests</h2><span>Previous requests and their final decisions stay here for reference.</span></div><strong>{employeeHistory.length}</strong></div>
            <div className="time-off-record-list">{renderRecords(employeeHistory)}{employeeHistory.length === 0 ? <p className="request-list-empty">No past or closed time-off requests yet.</p> : null}</div>
          </section>
        </div>
      )}
    </div>
  )
}

function WithdrawTimeOffDialog({
  mutation,
  onClose,
  onWithdrawn,
  request,
}: {
  mutation: ReturnType<typeof useRequestAction>
  onClose: () => void
  onWithdrawn: () => void
  request: TimeOffRequest
}) {
  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Withdrawing your request..."
      description="This removes the request from the approval queue but keeps its history for your records."
      onClose={onClose}
      title="Withdraw time-off request?"
    >
      <div className="time-off-withdraw-summary">
        <strong>{timeOffTypeLabel(request.request_type)}</strong>
        <span>{formatRequestDateRange(request)}</span>
        <small>{request.reason || 'No reason was provided.'}</small>
      </div>
      {mutation.isError ? <div className="inline-alert" role="alert">The request could not be withdrawn. Refresh its status and try again.</div> : null}
      <div className="modal-actions">
        <button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Keep request</button>
        <button
          className="primary-action danger-primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ kind: 'withdraw-time-off', requestId: request.id }, { onSuccess: onWithdrawn })}
          type="button"
        >
          {mutation.isPending ? 'Withdrawing…' : 'Withdraw request'}
        </button>
      </div>
    </ModalDialog>
  )
}

type DecisionDialogState = {
  decision: 'approved' | 'declined'
  id: string
  label: string
}

function DecisionDialog({
  state,
  mutation,
  onClose,
  onDecided,
}: {
  state: DecisionDialogState
  mutation: ReturnType<typeof useRequestAction>
  onClose: () => void
  onDecided: (message: string) => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const note = String(new FormData(event.currentTarget).get('note')).trim() || null
    mutation.mutate({ kind: 'decide-shift', requestId: state.id, decision: state.decision, note }, {
      onSuccess: () => {
        onDecided(`Shift request ${state.decision}.`)
        onClose()
      },
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Saving decision..."
      onClose={onClose}
      title={`${state.decision === 'approved' ? 'Approve' : 'Decline'} ${state.label}`}
    >
      <form className="request-form" onSubmit={submit}>
        <label className="field-stack">
          <span>Decision note {state.decision === 'approved' ? <small>Optional</small> : null}</span>
          <textarea autoFocus maxLength={2000} name="note" required={state.decision === 'declined'} rows={4} />
        </label>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={mutation.isPending} type="submit">
            {mutation.isPending ? 'Saving…' : `Confirm ${state.decision === 'approved' ? 'approval' : 'decline'}`}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

const coverageChoices: Array<{
  description: string
  icon: typeof UserCheck
  label: string
  value: CallOffCoverageMode
}> = [
  { value: 'assigned_guard', label: 'Coverage already found', description: 'Choose the qualified guard who agreed to work this shift.', icon: UserCheck },
  { value: 'open_pool', label: 'Find an available guard', description: 'Open the shift and notify eligible Flex guards first.', icon: UsersRound },
  { value: 'patrol_review', label: 'Request patrol review', description: 'Ask Dispatch to review a one-night patrol fallback without changing the standing route.', icon: Route },
  { value: 'no_replacement', label: 'No replacement needed', description: 'Close the staffing need while preserving the original schedule and absence record.', icon: CircleOff },
]

export function CoverageWorkflowDialog({
  report,
  onClose,
  onSaved,
  initialMode = 'open_pool',
}: {
  report: Pick<CallOffReport, 'id'>
  onClose: () => void
  onSaved: (message: string) => void | Promise<unknown>
  initialMode?: CallOffCoverageMode
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState(1)
  const [mode, setMode] = useState<CallOffCoverageMode>(initialMode)
  const [replacementEmployeeId, setReplacementEmployeeId] = useState('')
  const [search, setSearch] = useState('')
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [title, setTitle] = useState('Open shift available')
  const [body, setBody] = useState('A qualified guard is needed for this opening. Review the shift details and request it if you are available.')
  const [reason, setReason] = useState('')
  const [allowOvertime, setAllowOvertime] = useState(false)
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const workspaceQuery = useQuery({
    queryKey: ['call-off-coverage', report.id],
    queryFn: () => getCallOffCoverageWorkspace(report.id),
  })
  const mutation = useMutation({
    mutationFn: resolveCallOffCoverage,
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['request-center'] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] }),
        queryClient.invalidateQueries({ queryKey: ['call-off-coverage', report.id] }),
      ])
      const label = result.status === 'assigned'
        ? 'Replacement assigned and original schedule preserved.'
        : result.status === 'open_pool'
          ? 'Opening published. Eligible Flex guards will be notified first.'
          : result.status === 'patrol_review'
            ? 'Dispatch was notified to review a one-night patrol fallback.'
            : 'Absence recorded; no replacement is required.'
      await onSaved(label)
      onClose()
    },
  })

  const workspace = workspaceQuery.data
  const candidateDirectory = useMemo(
    () => buildCoverageCandidateDirectory(workspace?.candidates ?? [], search, showUnavailable),
    [search, showUnavailable, workspace?.candidates],
  )
  const selectedCandidate = workspace?.candidates.find((candidate) => candidate.id === replacementEmployeeId) ?? null
  const completed = workspace?.coverageCase?.status === 'assigned' || workspace?.coverageCase?.status === 'no_replacement' || workspace?.coverageCase?.status === 'closed'
  const selectedCandidateReady = Boolean(selectedCandidate?.eligible)
    && (!selectedCandidate?.requiresOvertimeApproval || allowOvertime)
  const canContinueFromChoice = mode !== 'assigned_guard' || selectedCandidateReady
  const canSave = reason.trim().length >= 8
    && canContinueFromChoice
    && (mode !== 'open_pool' || (title.trim().length > 0 && body.trim().length > 0))

  function submit() {
    if (!canSave) return
    mutation.mutate({
      callOffId: report.id,
      mode,
      replacementEmployeeId: mode === 'assigned_guard' ? replacementEmployeeId : null,
      announcementTitle: mode === 'open_pool' ? title.trim() : null,
      announcementBody: mode === 'open_pool' ? body.trim() : null,
      reason,
      allowOvertime: mode === 'assigned_guard' ? Boolean(selectedCandidate?.requiresOvertimeApproval && allowOvertime) : allowOvertime,
      idempotencyKey,
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Saving the coverage decision..."
      className="modal-dialog--coverage-workflow"
      description="The original assignment stays in the permanent history. Follow the three short steps to handle coverage."
      onClose={onClose}
      title="Handle an employee absence"
    >
      {workspaceQuery.isPending ? <DataStatePanel icon={ClipboardCheck} title="Loading the shift"><p>Checking the original assignment and qualified coverage options.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={ShieldAlert} title="Coverage review unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : null}
      {workspace && completed ? (
        <div className="coverage-complete">
          <CheckCircle2 aria-hidden="true" size={28} />
          <div><h3>This coverage case is complete</h3><p>The original assignment and every management action remain in the audit history.</p></div>
          <button className="primary-action" onClick={onClose} type="button">Done</button>
        </div>
      ) : workspace ? (
        <div className="coverage-workflow">
          <ol className="coverage-steps" aria-label="Coverage workflow progress">
            {['Review absence', 'Choose coverage', 'Confirm'].map((label, index) => {
              const number = index + 1
              return <li aria-current={step === number ? 'step' : undefined} className={step >= number ? 'is-active' : ''} key={label}><span>{step > number ? <CheckCircle2 size={16} /> : number}</span><strong>{label}</strong></li>
            })}
          </ol>

          {step === 1 ? <section className="coverage-panel">
            <div className="coverage-original">
              <div><span>Employee</span><strong>{workspace.callOff.employeeName}</strong></div>
              <div><span>Original shift</span><strong>{workspace.shift.title}</strong></div>
              <div><span>When</span><strong>{formatDualTimeRange(workspace.shift.startsAt, workspace.shift.endsAt, workspace.shift.timeZone)}</strong></div>
              <div><span>Location</span><strong>{workspace.shift.location}</strong></div>
            </div>
            <div className="coverage-preservation-note"><ShieldAlert aria-hidden="true" size={20} /><div><strong>The original schedule will not disappear</strong><p>SygShift stores a permanent snapshot of the employee, assignment, shift, site, and times before any coverage change is made.</p></div></div>
            <div className="coverage-reported-note"><span>Reported reason</span><p>{workspace.callOff.reason || 'No reason was recorded.'}</p></div>
          </section> : null}

          {step === 2 ? <section className="coverage-panel">
            <fieldset className="coverage-choice-grid">
              <legend>How should this shift be handled?</legend>
              {coverageChoices.map((choice) => {
                const Icon = choice.icon
                const unavailable = choice.value === 'patrol_review' && !workspace.patrolFallback.available
                return <label className={mode === choice.value ? 'is-selected' : ''} key={choice.value}><input checked={mode === choice.value} disabled={unavailable} name="coverage-mode" onChange={() => setMode(choice.value)} type="radio" value={choice.value} /><Icon aria-hidden="true" size={22} /><span><strong>{choice.label}</strong><small>{choice.description}</small>{unavailable ? <em>{workspace.patrolFallback.message}</em> : null}</span></label>
              })}
            </fieldset>

            {mode === 'assigned_guard' ? <div className="coverage-candidate-picker">
              <label><span>Find the guard</span><div className="coverage-search"><Search aria-hidden="true" size={19} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Name or employee number" value={search} /></div></label>
              <div className="coverage-candidate-summary" aria-live="polite">
                <span><strong>{candidateDirectory.availableCount}</strong> eligible for this shift{candidateDirectory.overtimeCount > 0 ? ` · ${candidateDirectory.overtimeCount} require overtime approval` : ''}</span>
                {candidateDirectory.unavailableCount > 0 && !search.trim() ? <button aria-expanded={showUnavailable} className="coverage-unavailable-toggle" onClick={() => setShowUnavailable((current) => !current)} type="button">{showUnavailable ? 'Hide unavailable' : `Show unavailable (${candidateDirectory.unavailableCount})`}</button> : null}
              </div>
              <div aria-label="Qualified coverage employees" className="coverage-candidate-list" role="radiogroup">
                {candidateDirectory.sections.map((section) => <section aria-labelledby={`coverage-candidate-${section.key}`} className="coverage-candidate-group" key={section.key} role="group">
                  <div className="coverage-candidate-group__heading"><div><h3 id={`coverage-candidate-${section.key}`}>{section.label}</h3><p>{section.description}</p></div><span>{section.candidates.length}</span></div>
                  <div className="coverage-candidate-group__options">
                    {section.candidates.map((candidate) => <label className={replacementEmployeeId === candidate.id ? 'is-selected' : ''} key={candidate.id}><input checked={replacementEmployeeId === candidate.id} disabled={!candidate.eligible} name="replacement-employee" onChange={() => { setReplacementEmployeeId(candidate.id); setAllowOvertime(false) }} type="radio" /><span><strong>{candidate.name}</strong><small>{candidate.employeeNumber ? `${candidate.employeeNumber} · ` : ''}{candidate.isFlex ? 'Flex' : candidate.workClassification || candidate.employmentType} · {candidate.noOverlap ? 'No shift conflict' : 'Schedule conflict'}{candidate.requiresOvertimeApproval ? ` · ${Math.round(candidate.overtimeMinutes / 60 * 10) / 10} projected overtime hr` : ' · No projected overtime'}</small>{candidate.blockReason ? <em>{candidate.blockReason}</em> : null}</span></label>)}
                  </div>
                </section>)}
                {candidateDirectory.matchingCount === 0 ? <p className="coverage-candidate-empty">No employees match that search.</p> : null}
                {candidateDirectory.matchingCount > 0 && candidateDirectory.sections.length === 0 ? <p className="coverage-candidate-empty">No eligible employees are available. Show unavailable employees to review the conflicts.</p> : null}
              </div>
              {selectedCandidate?.requiresOvertimeApproval ? <label className="coverage-overtime-confirm"><input checked={allowOvertime} onChange={(event) => setAllowOvertime(event.target.checked)} type="checkbox" /><span><strong>Overtime is approved for this replacement</strong><small>Required before SygShift can assign this guard.</small></span></label> : null}
            </div> : null}

            {mode === 'open_pool' ? <div className="coverage-opening-fields">
              <div className="coverage-wave-note"><UsersRound aria-hidden="true" size={20} /><div><strong>Flex-first notification order</strong><p>Eligible Flex guards are notified now. Other eligible guards follow after 10 minutes. Overtime candidates are included only if you approve the final wave.</p></div></div>
              <label><span>Opening title</span><input maxLength={160} onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
              <label><span>Message to qualified guards</span><textarea maxLength={4000} onChange={(event) => setBody(event.target.value)} required rows={4} value={body} /></label>
              <label className="coverage-overtime-confirm"><input checked={allowOvertime} onChange={(event) => setAllowOvertime(event.target.checked)} type="checkbox" /><span><strong>Allow an overtime notification wave after 20 minutes</strong><small>No overtime assignment is automatic; management must still approve the guard request.</small></span></label>
            </div> : null}

            {mode === 'patrol_review' ? <div className="coverage-wave-note"><Route aria-hidden="true" size={20} /><div><strong>Dispatch approval is required</strong><p>{workspace.patrolFallback.message} The absent employee’s reason is not included in the guard-facing notice.</p></div></div> : null}
            {mode === 'no_replacement' ? <div className="coverage-wave-note"><CircleOff aria-hidden="true" size={20} /><div><strong>The shift will not enter the open pool</strong><p>The absence and original assignment remain documented, and no replacement notification is sent.</p></div></div> : null}
          </section> : null}

          {step === 3 ? <section className="coverage-panel coverage-review">
            <h3>Review before saving</h3>
            <dl><div><dt>Original assignment</dt><dd>{workspace.callOff.employeeName} · preserved</dd></div><div><dt>Coverage plan</dt><dd>{coverageChoices.find((choice) => choice.value === mode)?.label}</dd></div>{selectedCandidate ? <div><dt>Replacement</dt><dd>{selectedCandidate.name}{selectedCandidate.requiresOvertimeApproval ? ' · overtime approved' : ''}</dd></div> : null}<div><dt>Shift</dt><dd>{workspace.shift.title} · {workspace.shift.location}</dd></div></dl>
            <label htmlFor="coverage-management-note"><span>Required management note</span><textarea aria-label="Required management note" autoFocus id="coverage-management-note" maxLength={2000} minLength={8} onChange={(event) => setReason(event.target.value)} placeholder="Record who confirmed the plan and any operational details needed for the audit history." required rows={4} value={reason} /><small>{reason.trim().length}/2,000 · minimum 8 characters</small></label>
            {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
          </section> : null}

          <div className="coverage-workflow__actions">
            <button className="secondary-button" onClick={step === 1 ? onClose : () => setStep((current) => current - 1)} type="button">{step === 1 ? 'Cancel' : <><ChevronLeft aria-hidden="true" size={18} />Back</>}</button>
            {step < 3 ? <button className="primary-action" disabled={step === 2 && !canContinueFromChoice} onClick={() => setStep((current) => current + 1)} type="button">Continue<ChevronRight aria-hidden="true" size={18} /></button> : <button className="primary-action" disabled={!canSave || mutation.isPending} onClick={submit} type="button">{mutation.isPending ? 'Saving…' : 'Save coverage plan'}</button>}
          </div>
        </div>
      ) : null}
    </ModalDialog>
  )
}

function ShiftRequestsWorkspace({
  highlightedRequestId,
  manager,
  onDecision,
  requests,
}: {
  highlightedRequestId: string | null
  manager: boolean
  onDecision: (state: DecisionDialogState) => void
  requests: ShiftWorkRequest[]
}) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visible = requests.filter((request) => !normalizedSearch || [
    employeeName(request.employee),
    requestShiftTitle(request.shift),
    requestShiftLocation(request.shift),
    request.status,
  ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch)))
  const pending = requests.filter((request) => request.status === 'pending').length

  return (
    <div className="request-secondary-workspace">
      <section className="request-secondary-workspace__intro">
        <div><CalendarCheck2 aria-hidden="true" size={25} /><span><p className="eyebrow">Open coverage</p><h2>{manager ? 'Shift request review' : 'My shift requests'}</h2><small>{manager ? 'Approve qualified employees for open shifts without mixing this queue into planned leave.' : 'See the status of shifts you asked to work.'}</small></span></div>
        <strong>{pending}<small>pending</small></strong>
      </section>
      {manager && requests.length > 0 ? <label className="request-list-search"><span>Search shift requests</span><div><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Employee, shift, or location" type="search" value={search} /></div></label> : null}
      <section className="request-list-panel" aria-labelledby="shift-requests-list-title">
        <div className="request-list-panel__heading"><div><p className="eyebrow">{manager ? 'Review queue' : 'Tracking'}</p><h2 id="shift-requests-list-title">{manager ? 'Open-shift requests' : 'Request history'}</h2></div><strong>{visible.length}</strong></div>
        <div className="request-queue-list">
          {visible.map((request) => (
            <article className={`request-queue-record${request.id === highlightedRequestId ? ' request-queue-record--highlighted' : ''}`} id={`request-${request.id}`} key={request.id}>
              <div className="request-queue-record__main">
                {manager ? <span className="request-queue-record__person">{employeeName(request.employee)}</span> : null}
                <h3>{requestShiftTitle(request.shift)}</h3>
                <p>{formatShiftDate(request.shift)} · {requestShiftLocation(request.shift)}</p>
                {request.employee_note ? <blockquote>{request.employee_note}</blockquote> : null}
                {request.decision_note ? <small>Decision note: {request.decision_note}</small> : null}
              </div>
              <div className="request-queue-record__actions">
                <StatusBadge status={request.status} />
                {manager && request.status === 'pending' ? <div><button className="secondary-button" onClick={() => onDecision({ decision: 'declined', id: request.id, label: 'shift request' })} type="button">Decline</button><button className="primary-action" onClick={() => onDecision({ decision: 'approved', id: request.id, label: 'shift request' })} type="button">Approve & assign</button></div> : null}
              </div>
            </article>
          ))}
          {visible.length === 0 ? <p className="request-list-empty">{search ? 'No shift requests match that search.' : manager ? 'There are no shift requests waiting for review.' : 'You have not requested an open shift yet.'}</p> : null}
        </div>
      </section>
    </div>
  )
}

function callOffStatus(report: CallOffReport): string {
  if (report.resolved_at) return 'Coverage resolved'
  if (report.announcement_id) return 'Opening published'
  if (report.acknowledged_at) return 'Under review'
  return 'Coverage review needed'
}

function CallOffWorkspace({
  assignments,
  callOffs,
  manager,
  onConfirm,
  onReviewCoverage,
}: {
  assignments: UpcomingAssignment[]
  callOffs: CallOffReport[]
  manager: boolean
  onConfirm: (pending: PendingCallOff) => void
  onReviewCoverage: (report: CallOffReport) => void
}) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visible = callOffs.filter((report) => !normalizedSearch || [
    employeeName(report.employee),
    requestShiftTitle(report.shift),
    requestShiftLocation(report.shift),
    report.reason,
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch)))

  return (
    <div className="request-secondary-workspace request-secondary-workspace--call-offs">
      <section className="call-off-purpose-note">
        <ShieldAlert aria-hidden="true" size={23} />
        <div><strong>Call-offs are for urgent attendance changes.</strong><p>Use Time Off for planned leave. A call-off alerts operations and starts the coverage workflow for an assigned shift.</p></div>
      </section>
      {!manager ? <GuardCallOffForm assignments={assignments} onConfirm={onConfirm} /> : null}
      {manager && callOffs.length > 0 ? <label className="request-list-search"><span>Search call-offs</span><div><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Employee, shift, location, or reason" type="search" value={search} /></div></label> : null}
      <section className="request-list-panel" aria-labelledby="call-off-list-title">
        <div className="request-list-panel__heading"><div><p className="eyebrow">{manager ? 'Urgent queue' : 'Tracking'}</p><h2 id="call-off-list-title">{manager ? 'Absences requiring coverage review' : 'My reported call-offs'}</h2><span>{manager ? 'The original assignment stays in history while you choose a coverage plan.' : 'Operations can see these reports and their current coverage status.'}</span></div><strong>{visible.length}</strong></div>
        <div className="request-queue-list">
          {visible.map((report) => (
            <article className="request-queue-record request-queue-record--urgent" key={report.id}>
              <div className="request-queue-record__main">
                {manager ? <span className="request-queue-record__person">{employeeName(report.employee)}</span> : null}
                <h3>{requestShiftTitle(report.shift)}</h3>
                <p>{formatShiftDate(report.shift)} · {requestShiftLocation(report.shift)}</p>
                <blockquote>{report.reason || 'No reason was recorded.'}</blockquote>
              </div>
              <div className="request-queue-record__actions">
                <span className={`status-badge ${report.resolved_at ? 'status-badge--approved' : 'status-badge--pending'}`}>{callOffStatus(report)}</span>
                {manager && !report.resolved_at ? <button className="primary-action" onClick={() => onReviewCoverage(report)} type="button"><Megaphone aria-hidden="true" size={18} />Review coverage</button> : null}
              </div>
            </article>
          ))}
          {visible.length === 0 ? <p className="request-list-empty">{search ? 'No call-offs match that search.' : manager ? 'No absences currently require coverage review.' : 'You have no active call-off reports.'}</p> : null}
        </div>
      </section>
    </div>
  )
}

export function RequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [pendingCallOff, setPendingCallOff] = useState<PendingCallOff | null>(null)
  const [decision, setDecision] = useState<DecisionDialogState | null>(null)
  const [timeOffOpen, setTimeOffOpen] = useState(false)
  const [timeOffReviewId, setTimeOffReviewId] = useState<string | null>(null)
  const [withdrawRequestId, setWithdrawRequestId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<Pick<CallOffReport, 'id'> | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const requestQuery = useQuery({
    queryKey: ['request-center'],
    queryFn: getRequestCenter,
    enabled: isSupabaseConfigured,
  })
  const mutation = useRequestAction()
  const privileged = requestQuery.data?.permissions.canManage ?? false
  const guardAssignments = useMemo(
    () => requestQuery.data?.upcomingAssignments ?? [],
    [requestQuery.data?.upcomingAssignments],
  )
  const linkedCallOffId = searchParams.get('callOff')
  const linkedRequestId = searchParams.get('request')
  const requestedTab = searchParams.get('tab')
  const activeTab: RequestTab = linkedCallOffId
    ? 'call-offs'
    : requestedTab === 'shift-requests' || requestedTab === 'call-offs'
      ? requestedTab
      : 'time-off'
  const withdrawRequest = withdrawRequestId
    ? requestQuery.data?.timeOff.find((request) => request.id === withdrawRequestId) ?? null
    : null
  const viewerTimeZone = isContinentalUsTimeZone(requestQuery.data?.employeeTimeZone)
    ? requestQuery.data.employeeTimeZone
    : OPERATIONAL_TIME_ZONE

  useEffect(() => {
    if (privileged && linkedCallOffId && !announcement) {
      setAnnouncement({ id: linkedCallOffId })
    }
  }, [announcement, linkedCallOffId, privileged])

  useEffect(() => {
    if (searchParams.get('new') === 'time-off') setTimeOffOpen(true)
  }, [searchParams])

  useEffect(() => {
    if (activeTab !== 'time-off' || !linkedRequestId || !requestQuery.data) return
    const linkedRequest = requestQuery.data.timeOff.find((request) => request.id === linkedRequestId)
    if (!linkedRequest) return

    document.getElementById(`request-${linkedRequestId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })

    if (privileged && linkedRequest.status === 'pending' && linkedRequest.employee_id !== requestQuery.data.employeeId && !timeOffReviewId) {
      setTimeOffReviewId(linkedRequestId)
      return
    }
    if (privileged && linkedRequest.status === 'pending' && linkedRequest.employee_id === requestQuery.data.employeeId) {
      if (!actionMessage) {
        setActionMessage('Your request is waiting for a different authorized reviewer. You can withdraw it while it is pending.')
      }
    }
  }, [actionMessage, activeTab, linkedRequestId, privileged, requestQuery.data, timeOffReviewId])

  useEffect(() => {
    if (!linkedRequestId || !requestQuery.data || activeTab !== 'shift-requests') return
    document.getElementById(`request-${linkedRequestId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [activeTab, linkedRequestId, requestQuery.data])

  function updateSearchParams(update: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(searchParams)
    update(next)
    setSearchParams(next, { replace: true })
  }

  function changeTab(tab: RequestTab) {
    updateSearchParams((next) => {
      next.set('tab', tab)
      next.delete('request')
      next.delete('callOff')
      next.delete('new')
    })
    setActionMessage(null)
  }

  function openTimeOffRequest() {
    setTimeOffOpen(true)
    updateSearchParams((next) => {
      next.set('tab', 'time-off')
      next.set('new', 'time-off')
      next.delete('request')
    })
  }

  function closeTimeOffRequest() {
    setTimeOffOpen(false)
    if (searchParams.get('new') !== 'time-off') return
    updateSearchParams((next) => next.delete('new'))
  }

  function openTimeOffReview(requestId: string) {
    setTimeOffReviewId(requestId)
    updateSearchParams((next) => {
      next.set('tab', 'time-off')
      next.set('request', requestId)
    })
  }

  function closeTimeOffReview() {
    setTimeOffReviewId(null)
    if (!linkedRequestId) return
    updateSearchParams((next) => next.delete('request'))
  }

  function openWithdrawRequest(requestId: string) {
    mutation.reset()
    setWithdrawRequestId(requestId)
  }

  function closeWithdrawRequest() {
    if (mutation.isPending) return
    mutation.reset()
    setWithdrawRequestId(null)
  }

  function finishWithdrawRequest() {
    setActionMessage('Your time-off request was withdrawn and remains in your history.')
    setWithdrawRequestId(null)
  }

  function closeCoverageWorkflow() {
    setAnnouncement(null)
    if (!linkedCallOffId) return
    const next = new URLSearchParams(searchParams)
    next.set('tab', 'call-offs')
    next.delete('callOff')
    setSearchParams(next, { replace: true })
  }

  function openCoverageWorkflow(report: CallOffReport) {
    setAnnouncement(report)
    updateSearchParams((next) => {
      next.set('tab', 'call-offs')
      next.set('callOff', report.id)
      next.delete('request')
    })
  }

  return (
    <div className="page page--requests">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Workforce · Self-service</p>
          <h1>Time Off</h1>
          <p className="page-summary">
            {privileged
              ? 'Request your own planned leave and manage the team’s time-off decisions from one dedicated workspace.'
              : 'Request planned time away, follow every decision, and keep urgent call-offs separate.'}
          </p>
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Request workflows ready for the secure connection" tone="setup">
          <p>Requests remain unavailable until authentication and the protected database are connected.</p>
          <ul>
            <li>Guard time-off and call-off forms</li>
            <li>Supervisor approvals protected by MFA</li>
            <li>Durable alert and announcement delivery queues</li>
          </ul>
        </DataStatePanel>
      ) : requestQuery.isPending ? (
        <DataStatePanel icon={ClipboardCheck} title="Loading Time Off">
          <p>Getting your requests, current statuses, and any work waiting for review.</p>
        </DataStatePanel>
      ) : requestQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Time Off could not be loaded" tone="error">
          <p>Your request records are temporarily unavailable. Nothing was changed. Try again in a moment.</p>
          <button className="secondary-button" onClick={() => void requestQuery.refetch()} type="button">Try again</button>
        </DataStatePanel>
      ) : (
        <>
          {mutation.isError && activeTab !== 'time-off' ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
          {actionMessage ? <div className="form-feedback form-feedback--success" role="status">{actionMessage}</div> : null}
          <RequestWorkspaceTabs
            activeTab={activeTab}
            callOffCount={requestQuery.data.callOffs.filter((report) => !report.resolved_at).length}
            onChange={changeTab}
            shiftRequestCount={requestQuery.data.shiftRequests.filter((request) => request.status === 'pending').length}
            timeOffCount={requestQuery.data.timeOff.filter((request) => request.status === 'pending').length}
          />
          {activeTab === 'time-off' ? (
            <TimeOffWorkspace
              historyLimit={requestQuery.data.timeOffHistory?.managerHistoryLimit ?? null}
              historyTruncated={requestQuery.data.timeOffHistory?.truncated ?? false}
              highlightedRequestId={linkedRequestId}
              manager={privileged}
              mutation={mutation}
              onNewRequest={openTimeOffRequest}
              onReview={openTimeOffReview}
              onWithdraw={openWithdrawRequest}
              requests={requestQuery.data.timeOff}
              viewerEmployeeId={requestQuery.data.employeeId}
              viewerTimeZone={viewerTimeZone}
            />
          ) : activeTab === 'shift-requests' ? (
            <ShiftRequestsWorkspace
              highlightedRequestId={linkedRequestId}
              manager={privileged}
              onDecision={setDecision}
              requests={requestQuery.data.shiftRequests}
            />
          ) : (
            <CallOffWorkspace
              assignments={guardAssignments}
              callOffs={requestQuery.data.callOffs}
              manager={privileged}
              onConfirm={setPendingCallOff}
              onReviewCoverage={openCoverageWorkflow}
            />
          )}
        </>
      )}

      {pendingCallOff ? <CallOffConfirmation mutation={mutation} onClose={() => setPendingCallOff(null)} pending={pendingCallOff} /> : null}
      {timeOffOpen ? (
        <TimeOffRequestModal
          employeeTimeZone={viewerTimeZone}
          onClose={closeTimeOffRequest}
          onSubmitted={() => setActionMessage('Time-off request submitted for review.')}
          requestHistoryPath="/time-off?tab=time-off"
        />
      ) : null}
      {timeOffReviewId ? (
        <TimeOffReviewDialog
          onClose={closeTimeOffReview}
          onDecided={setActionMessage}
          requestId={timeOffReviewId}
        />
      ) : null}
      {decision ? (
        <DecisionDialog
          mutation={mutation}
          onClose={() => setDecision(null)}
          onDecided={setActionMessage}
          state={decision}
        />
      ) : null}
      {withdrawRequest ? (
        <WithdrawTimeOffDialog
          mutation={mutation}
          onClose={closeWithdrawRequest}
          onWithdrawn={finishWithdrawRequest}
          request={withdrawRequest}
        />
      ) : null}
      {announcement ? <CoverageWorkflowDialog onClose={closeCoverageWorkflow} onSaved={setActionMessage} report={announcement} /> : null}
    </div>
  )
}

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  CalendarOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  ClipboardCheck,
  DatabaseZap,
  Megaphone,
  Route,
  Search,
  ShieldAlert,
  TriangleAlert,
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
  type UpcomingAssignment,
} from '../data/requests'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatDualTimeRange } from '../lib/time'

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
  return <span className={`status-badge status-badge--${status}`}>{status.replace('_', ' ')}</span>
}

function formatRequestDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00`))
}

function formatRequestDateRange(request: Pick<TimeOffRequest, 'starts_on' | 'ends_on'>): string {
  const start = formatRequestDate(request.starts_on)
  const end = formatRequestDate(request.ends_on)
  return start === end ? start : `${start} – ${end}`
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

function GuardHistory({
  timeOff,
  shiftRequests,
  callOffs,
  mutation,
}: {
  timeOff: TimeOffRequest[]
  shiftRequests: ShiftWorkRequest[]
  callOffs: CallOffReport[]
  mutation: ReturnType<typeof useRequestAction>
}) {
  return (
    <section className="request-history" aria-labelledby="request-history-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">History</p>
          <h2 id="request-history-title">My requests</h2>
        </div>
      </div>
      <div className="request-history-list">
        {timeOff.map((request) => (
          <article className="history-row" key={request.id}>
            <div>
              <strong>Time off · {formatRequestDateRange(request)}</strong>
              <span>{request.reason || 'No note provided'}</span>
            </div>
            <div className="history-row__actions">
              <StatusBadge status={request.status} />
              {request.status === 'pending' ? (
                <button
                  className="text-button"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ kind: 'withdraw-time-off', requestId: request.id })}
                  type="button"
                >
                  Withdraw
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {shiftRequests.map((request) => (
          <article className="history-row" key={request.id}>
            <div>
              <strong>Shift request · {requestShiftTitle(request.shift)}</strong>
              <span>{formatShiftDate(request.shift)}</span>
            </div>
            <StatusBadge status={request.status} />
          </article>
        ))}
        {callOffs.map((report) => (
          <article className="history-row" key={report.id}>
            <div>
              <strong>Call-off · {requestShiftTitle(report.shift)}</strong>
              <span>{formatShiftDate(report.shift)}</span>
            </div>
            <span className="status-badge status-badge--leave">
              {report.announcement_id ? 'Opening published' : 'Supervisor notified'}
            </span>
          </article>
        ))}
        {timeOff.length + shiftRequests.length + callOffs.length === 0 ? (
          <p className="request-list-empty">No requests have been submitted.</p>
        ) : null}
      </div>
    </section>
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
  const normalizedSearch = search.trim().toLowerCase()
  const candidates = workspace?.candidates.filter((candidate) => !normalizedSearch
    || `${candidate.name} ${candidate.employeeNumber ?? ''}`.toLowerCase().includes(normalizedSearch)) ?? []
  const selectedCandidate = workspace?.candidates.find((candidate) => candidate.id === replacementEmployeeId) ?? null
  const completed = workspace?.coverageCase?.status === 'assigned' || workspace?.coverageCase?.status === 'no_replacement' || workspace?.coverageCase?.status === 'closed'
  const canContinueFromChoice = mode !== 'assigned_guard' || Boolean(replacementEmployeeId)
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
              <div className="coverage-candidate-list" role="list">
                {candidates.slice(0, 12).map((candidate) => <label className={replacementEmployeeId === candidate.id ? 'is-selected' : ''} key={candidate.id}><input checked={replacementEmployeeId === candidate.id} disabled={!candidate.eligible} name="replacement-employee" onChange={() => { setReplacementEmployeeId(candidate.id); setAllowOvertime(false) }} type="radio" /><span><strong>{candidate.name}</strong><small>{candidate.isFlex ? 'Flex guard' : candidate.employmentType} · {candidate.requiresOvertimeApproval ? `${Math.round(candidate.overtimeMinutes / 60 * 10) / 10} overtime hr` : 'No scheduled overtime'}</small>{candidate.blockReason ? <em>{candidate.blockReason}</em> : null}</span></label>)}
                {candidates.length === 0 ? <p>No guards match that search.</p> : null}
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

function SupervisorQueue({
  timeOff,
  shiftRequests,
  callOffs,
  onDecision,
  onReviewTimeOff,
  onAnnouncement,
}: {
  timeOff: TimeOffRequest[]
  shiftRequests: ShiftWorkRequest[]
  callOffs: CallOffReport[]
  onDecision: (state: DecisionDialogState) => void
  onReviewTimeOff: (requestId: string) => void
  onAnnouncement: (report: CallOffReport) => void
}) {
  const total = timeOff.length + shiftRequests.length + callOffs.length

  return (
    <>
      <section className="request-metrics" aria-label="Request queue totals">
        <article><span>Time off</span><strong>{timeOff.length}</strong></article>
        <article><span>Shift requests</span><strong>{shiftRequests.length}</strong></article>
        <article><span>Call-offs</span><strong>{callOffs.length}</strong></article>
      </section>
      {total === 0 ? (
        <DataStatePanel icon={ClipboardCheck} title="The action queue is clear">
          <p>New time-off requests, shift requests, and call-offs will appear here.</p>
        </DataStatePanel>
      ) : (
        <div className="approval-sections">
          {callOffs.length > 0 ? (
            <section className="approval-section" aria-labelledby="call-off-queue-title">
              <div className="section-heading"><h2 id="call-off-queue-title">Absences requiring coverage review</h2></div>
              {callOffs.map((report) => (
                <article className="approval-card approval-card--urgent" key={report.id}>
                  <div>
                    <span className="approval-card__person">{employeeName(report.employee)}</span>
                    <h3>{requestShiftTitle(report.shift)}</h3>
                    <p>{formatShiftDate(report.shift)} · {requestShiftLocation(report.shift)}</p>
                    <blockquote>{report.reason}</blockquote>
                  </div>
                  <button className="primary-action" onClick={() => onAnnouncement(report)} type="button">
                    <Megaphone aria-hidden="true" size={18} />
                    Review coverage
                  </button>
                </article>
              ))}
            </section>
          ) : null}
          {timeOff.length > 0 ? (
            <section className="approval-section" aria-labelledby="time-off-queue-title">
              <div className="section-heading"><h2 id="time-off-queue-title">Time-Off Requests</h2></div>
              {timeOff.map((request) => (
                <article className="approval-card" key={request.id}>
                  <div>
                    <span className="approval-card__person">{employeeName(request.employee)}</span>
                    <h3>{formatRequestDateRange(request)}</h3>
                    <p>{request.reason || 'No note provided'}</p>
                  </div>
                  <div className="approval-actions">
                    <button className="primary-action" onClick={() => onReviewTimeOff(request.id)} type="button">Review request</button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}
          {shiftRequests.length > 0 ? (
            <section className="approval-section" aria-labelledby="shift-queue-title">
              <div className="section-heading"><h2 id="shift-queue-title">Open-shift requests</h2></div>
              {shiftRequests.map((request) => (
                <article className="approval-card" key={request.id}>
                  <div>
                    <span className="approval-card__person">{employeeName(request.employee)}</span>
                    <h3>{requestShiftTitle(request.shift)}</h3>
                    <p>{formatShiftDate(request.shift)} · {requestShiftLocation(request.shift)}</p>
                  </div>
                  <div className="approval-actions">
                    <button className="secondary-button" onClick={() => onDecision({ decision: 'declined', id: request.id, label: 'shift request' })} type="button">Decline</button>
                    <button className="primary-action" onClick={() => onDecision({ decision: 'approved', id: request.id, label: 'shift request' })} type="button">Approve & assign</button>
                  </div>
                </article>
              ))}
            </section>
          ) : null}
        </div>
      )}
    </>
  )
}

export function RequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [pendingCallOff, setPendingCallOff] = useState<PendingCallOff | null>(null)
  const [decision, setDecision] = useState<DecisionDialogState | null>(null)
  const [timeOffOpen, setTimeOffOpen] = useState(false)
  const [timeOffReviewId, setTimeOffReviewId] = useState<string | null>(null)
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

  useEffect(() => {
    if (privileged && linkedCallOffId && !announcement) {
      setAnnouncement({ id: linkedCallOffId })
    }
  }, [announcement, linkedCallOffId, privileged])

  function closeCoverageWorkflow() {
    setAnnouncement(null)
    if (!linkedCallOffId) return
    const next = new URLSearchParams(searchParams)
    next.delete('callOff')
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="page page--requests">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>{privileged ? 'Request action queue' : 'Requests & call-offs'}</h1>
          <p className="page-summary">
            {privileged
              ? 'Review time off, assign qualified guards to openings, and publish replacement coverage from one clear queue.'
              : 'Request time away, track open-shift interest, or report an assigned shift you cannot work.'}
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
        <DataStatePanel icon={ClipboardCheck} title="Loading request center">
          <p>Checking your role and retrieving the records you are permitted to manage.</p>
        </DataStatePanel>
      ) : requestQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Requests unavailable" tone="error">
          <p>{requestQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
          {actionMessage ? <div className="form-feedback form-feedback--success" role="status">{actionMessage}</div> : null}
          {privileged ? (
            <SupervisorQueue
              callOffs={requestQuery.data.callOffs}
              onAnnouncement={setAnnouncement}
              onDecision={setDecision}
              onReviewTimeOff={setTimeOffReviewId}
              shiftRequests={requestQuery.data.shiftRequests}
              timeOff={requestQuery.data.timeOff}
            />
          ) : (
            <>
              <div className="guard-request-grid">
                <section className="request-form-card request-form-card--launcher" aria-labelledby="time-off-launcher-title">
                  <div className="request-card-heading">
                    <CalendarOff aria-hidden="true" size={24} />
                    <div>
                      <h2 id="time-off-launcher-title">Request Time Off</h2>
                      <p>Choose planned dates, review affected shifts, and send one clear request for approval.</p>
                    </div>
                  </div>
                  <button className="primary-action" onClick={() => setTimeOffOpen(true)} type="button">Start a time-off request</button>
                </section>
                <GuardCallOffForm assignments={guardAssignments} onConfirm={setPendingCallOff} />
              </div>
              <GuardHistory
                callOffs={requestQuery.data.callOffs}
                mutation={mutation}
                shiftRequests={requestQuery.data.shiftRequests}
                timeOff={requestQuery.data.timeOff}
              />
            </>
          )}
        </>
      )}

      {pendingCallOff ? <CallOffConfirmation mutation={mutation} onClose={() => setPendingCallOff(null)} pending={pendingCallOff} /> : null}
      {timeOffOpen ? (
        <TimeOffRequestModal
          onClose={() => setTimeOffOpen(false)}
          onSubmitted={() => setActionMessage('Time-off request submitted for review.')}
          requestHistoryPath="/requests"
        />
      ) : null}
      {timeOffReviewId ? (
        <TimeOffReviewDialog
          onClose={() => setTimeOffReviewId(null)}
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
      {announcement ? <CoverageWorkflowDialog onClose={closeCoverageWorkflow} onSaved={setActionMessage} report={announcement} /> : null}
    </div>
  )
}

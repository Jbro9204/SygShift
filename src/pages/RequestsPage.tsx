import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  CalendarOff,
  ClipboardCheck,
  DatabaseZap,
  Megaphone,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  decideShiftRequest,
  decideTimeOff,
  employeeName,
  getRequestCenter,
  publishCallOffOpening,
  reportCallOff,
  requestShiftLocation,
  requestShiftTitle,
  submitTimeOff,
  withdrawTimeOff,
  type CallOffReport,
  type RequestShift,
  type ShiftWorkRequest,
  type TimeOffInput,
  type TimeOffRequest,
  type UpcomingAssignment,
} from '../data/requests'
import { isSupabaseConfigured } from '../lib/supabase'
import { operationalToday } from '../lib/time'

type RequestAction =
  | { kind: 'submit-time-off'; input: TimeOffInput }
  | { kind: 'withdraw-time-off'; requestId: string }
  | { kind: 'report-call-off'; shiftId: string; reason: string }
  | { kind: 'decide-time-off'; requestId: string; decision: 'approved' | 'declined'; note: string | null }
  | { kind: 'decide-shift'; requestId: string; decision: 'approved' | 'declined'; note: string | null }
  | { kind: 'publish-call-off'; callOffId: string; title: string; body: string }

function useRequestAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (action: RequestAction) => {
      switch (action.kind) {
        case 'submit-time-off': return submitTimeOff(action.input)
        case 'withdraw-time-off': return withdrawTimeOff(action.requestId)
        case 'report-call-off': return reportCallOff(action.shiftId, action.reason)
        case 'decide-time-off': return decideTimeOff(action.requestId, action.decision, action.note)
        case 'decide-shift': return decideShiftRequest(action.requestId, action.decision, action.note)
        case 'publish-call-off': return publishCallOffOpening(action.callOffId, action.title, action.body)
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
    month: 'short',
    day: 'numeric',
    timeZone: shift.time_zone,
  }).format(new Date(shift.starts_at))
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: shift.time_zone,
  })
  return `${date} · ${time.format(new Date(shift.starts_at))} – ${time.format(new Date(shift.ends_at))}`
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-badge--${status}`}>{status.replace('_', ' ')}</span>
}

function GuardTimeOffForm({ mutation }: { mutation: ReturnType<typeof useRequestAction> }) {
  const [partial, setPartial] = useState(false)
  const minimumDate = format(operationalToday(), 'yyyy-MM-dd')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const startsOn = String(form.get('startsOn'))
    const endsOn = partial ? startsOn : String(form.get('endsOn'))
    mutation.mutate({
      kind: 'submit-time-off',
      input: {
        startsOn,
        endsOn,
        partialStart: partial ? String(form.get('partialStart')) : null,
        partialEnd: partial ? String(form.get('partialEnd')) : null,
        reason: String(form.get('reason')).trim() || null,
      },
    }, {
      onSuccess: () => {
        formElement.reset()
        setPartial(false)
      },
    })
  }

  return (
    <section className="request-form-card" aria-labelledby="time-off-form-title">
      <div className="request-card-heading">
        <CalendarOff aria-hidden="true" size={24} />
        <div>
          <h2 id="time-off-form-title">Request time off</h2>
          <p>Submit full days or part of one day for supervisor review.</p>
        </div>
      </div>
      <form className="request-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            <span>Start date</span>
            <input min={minimumDate} name="startsOn" required type="date" />
          </label>
          {!partial ? (
            <label>
              <span>End date</span>
              <input min={minimumDate} name="endsOn" required type="date" />
            </label>
          ) : (
            <>
              <label>
                <span>Start time</span>
                <input name="partialStart" required type="time" />
              </label>
              <label>
                <span>End time</span>
                <input name="partialEnd" required type="time" />
              </label>
            </>
          )}
        </div>
        <label className="check-field">
          <input checked={partial} onChange={(event) => setPartial(event.target.checked)} type="checkbox" />
          <span>This is part of one day</span>
        </label>
        <label className="field-stack">
          <span>Reason or note <small>Optional</small></span>
          <textarea maxLength={2000} name="reason" rows={3} />
        </label>
        <button className="primary-action" disabled={mutation.isPending} type="submit">
          {mutation.isPending ? 'Saving…' : 'Submit time-off request'}
        </button>
      </form>
    </section>
  )
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
              <strong>Time off · {request.starts_on}{request.ends_on !== request.starts_on ? ` – ${request.ends_on}` : ''}</strong>
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
  category: 'time-off' | 'shift'
  decision: 'approved' | 'declined'
  id: string
  label: string
}

function DecisionDialog({
  state,
  mutation,
  onClose,
}: {
  state: DecisionDialogState
  mutation: ReturnType<typeof useRequestAction>
  onClose: () => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const note = String(new FormData(event.currentTarget).get('note')).trim() || null
    const action: RequestAction = state.category === 'time-off'
      ? { kind: 'decide-time-off', requestId: state.id, decision: state.decision, note }
      : { kind: 'decide-shift', requestId: state.id, decision: state.decision, note }
    mutation.mutate(action, { onSuccess: onClose })
  }

  return (
    <ModalDialog onClose={onClose} title={`${state.decision === 'approved' ? 'Approve' : 'Decline'} ${state.label}`}>
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

function AnnouncementDialog({
  report,
  mutation,
  onClose,
}: {
  report: CallOffReport
  mutation: ReturnType<typeof useRequestAction>
  onClose: () => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      kind: 'publish-call-off',
      callOffId: report.id,
      title: String(form.get('title')).trim(),
      body: String(form.get('body')).trim(),
    }, { onSuccess: onClose })
  }

  return (
    <ModalDialog
      description="Publishing cancels the original assignment, opens the shift, and queues announcement delivery."
      onClose={onClose}
      title="Publish replacement opening"
    >
      <div className="confirmation-summary">
        <strong>{requestShiftTitle(report.shift)}</strong>
        <span>{formatShiftDate(report.shift)}</span>
        <span>{requestShiftLocation(report.shift)}</span>
      </div>
      <form className="request-form" onSubmit={submit}>
        <label className="field-stack">
          <span>Announcement title</span>
          <input autoFocus defaultValue="Open shift available" maxLength={160} name="title" required />
        </label>
        <label className="field-stack">
          <span>Message to qualified guards</span>
          <textarea
            defaultValue="A qualified guard is needed for this opening. Review the shift details and request it if you are available."
            maxLength={4000}
            name="body"
            required
            rows={5}
          />
        </label>
        <p className="form-note">Do not include access codes, alarm details, or other sensitive site instructions.</p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={mutation.isPending} type="submit">
            {mutation.isPending ? 'Publishing…' : 'Publish & queue delivery'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

function SupervisorQueue({
  timeOff,
  shiftRequests,
  callOffs,
  onDecision,
  onAnnouncement,
}: {
  timeOff: TimeOffRequest[]
  shiftRequests: ShiftWorkRequest[]
  callOffs: CallOffReport[]
  onDecision: (state: DecisionDialogState) => void
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
              <div className="section-heading"><h2 id="call-off-queue-title">Call-offs requiring an opening</h2></div>
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
                    Publish opening
                  </button>
                </article>
              ))}
            </section>
          ) : null}
          {timeOff.length > 0 ? (
            <section className="approval-section" aria-labelledby="time-off-queue-title">
              <div className="section-heading"><h2 id="time-off-queue-title">Time-off requests</h2></div>
              {timeOff.map((request) => (
                <article className="approval-card" key={request.id}>
                  <div>
                    <span className="approval-card__person">{employeeName(request.employee)}</span>
                    <h3>{request.starts_on}{request.ends_on !== request.starts_on ? ` – ${request.ends_on}` : ''}</h3>
                    <p>{request.reason || 'No note provided'}</p>
                  </div>
                  <div className="approval-actions">
                    <button className="secondary-button" onClick={() => onDecision({ category: 'time-off', decision: 'declined', id: request.id, label: 'time off' })} type="button">Decline</button>
                    <button className="primary-action" onClick={() => onDecision({ category: 'time-off', decision: 'approved', id: request.id, label: 'time off' })} type="button">Approve</button>
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
                    <button className="secondary-button" onClick={() => onDecision({ category: 'shift', decision: 'declined', id: request.id, label: 'shift request' })} type="button">Decline</button>
                    <button className="primary-action" onClick={() => onDecision({ category: 'shift', decision: 'approved', id: request.id, label: 'shift request' })} type="button">Approve & assign</button>
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
  const [pendingCallOff, setPendingCallOff] = useState<PendingCallOff | null>(null)
  const [decision, setDecision] = useState<DecisionDialogState | null>(null)
  const [announcement, setAnnouncement] = useState<CallOffReport | null>(null)
  const requestQuery = useQuery({
    queryKey: ['request-center'],
    queryFn: getRequestCenter,
    enabled: isSupabaseConfigured,
  })
  const mutation = useRequestAction()
  const privileged = requestQuery.data?.role === 'supervisor' || requestQuery.data?.role === 'admin'
  const guardAssignments = useMemo(
    () => requestQuery.data?.upcomingAssignments ?? [],
    [requestQuery.data?.upcomingAssignments],
  )

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
          {privileged ? (
            <SupervisorQueue
              callOffs={requestQuery.data.callOffs}
              onAnnouncement={setAnnouncement}
              onDecision={setDecision}
              shiftRequests={requestQuery.data.shiftRequests}
              timeOff={requestQuery.data.timeOff}
            />
          ) : (
            <>
              <div className="guard-request-grid">
                <GuardTimeOffForm mutation={mutation} />
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
      {decision ? <DecisionDialog mutation={mutation} onClose={() => setDecision(null)} state={decision} /> : null}
      {announcement ? <AnnouncementDialog mutation={mutation} onClose={() => setAnnouncement(null)} report={announcement} /> : null}
    </div>
  )
}

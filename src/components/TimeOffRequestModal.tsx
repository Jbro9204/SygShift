import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format, isValid, parseISO } from 'date-fns'
import { CalendarDays, CheckCircle2, Clock3, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  decideTimeOffRequestV2,
  getTimeOffRequestContext,
  getTimeOffReviewContext,
  submitTimeOffRequestV2,
  type AffectedTimeOffShift,
  type TimeOffRequestKind,
} from '../data/requests'
import { formatDualTimeRange, operationalToday } from '../lib/time'
import { ModalDialog } from './ModalDialog'

const requestTypeContent: Record<TimeOffRequestKind, { label: string; description: string }> = {
  paid_vacation: {
    label: 'Paid Vacation',
    description: 'Request approved paid vacation hours. Available to salary employees only.',
  },
  sick_time: {
    label: 'Sick Time',
    description: 'Request sick leave under the employee’s applicable sick-time policy.',
  },
  unpaid_time_off: {
    label: 'Unpaid Time Off',
    description: 'Request approved time away without paid hours.',
  },
}

const plannedTimeOffExplanation = 'Use this form for planned time away. If you cannot work a current or imminent shift, use Report Sick / Call-Off so Dispatch is notified immediately.'
const approvalWarning = 'Approval is required. Submitting this request does not remove you from published shifts. Continue to follow the normal call-off process if you cannot work before the request is approved.'

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

function minutesLabel(minutes: number | null | undefined): string {
  if (minutes == null) return 'Not calculated'
  const hours = minutes / 60
  return `${hours.toFixed(hours % 1 === 0 ? 0 : 2)} hr`
}

function employmentLabel(value: string | null): string {
  if (value === 'salary') return 'Salary'
  if (value === 'flex') return 'Flex'
  if (value === 'hourly') return 'Hourly'
  return 'Employee'
}

function treatmentLabel(value: TimeOffRequestKind | null): string {
  if (value === 'paid_vacation') return 'Paid vacation'
  if (value === 'sick_time') return 'Sick-time policy'
  if (value === 'unpaid_time_off') return 'Unpaid time off'
  return 'Choose a request type'
}

function shiftTitle(shift: AffectedTimeOffShift): string {
  return shift.postName ?? shift.eventName ?? 'Scheduled shift'
}

function AffectedShiftList({ shifts }: { shifts: AffectedTimeOffShift[] }) {
  if (shifts.length === 0) {
    return <p className="time-off-empty-shifts">No published assignments fall within these dates.</p>
  }

  return (
    <div className="time-off-shift-list">
      {shifts.map((shift) => (
        <article className="time-off-shift" key={shift.assignmentId}>
          <div>
            <strong>{shiftTitle(shift)}</strong>
            <span>{shift.siteCode ? `${shift.siteCode} · ` : ''}{shift.location}</span>
          </div>
          <div>
            <strong>{dateLabel(shift.workday)}</strong>
            <span>{formatDualTimeRange(shift.startsAt, shift.endsAt, shift.timeZone)}</span>
          </div>
          <span className="time-off-shift__hours">{minutesLabel(shift.estimatedMinutes)}</span>
        </article>
      ))}
    </div>
  )
}

export function TimeOffRequestModal({
  onClose,
  onSubmitted,
  requestHistoryPath,
}: {
  onClose: () => void
  onSubmitted?: () => void
  requestHistoryPath?: string | null
}) {
  const queryClient = useQueryClient()
  const today = format(operationalToday(), 'yyyy-MM-dd')
  const [requestType, setRequestType] = useState<TimeOffRequestKind | null>(null)
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState(today)
  const [returnOn, setReturnOn] = useState(format(addDays(parseISO(today), 1), 'yyyy-MM-dd'))
  const [partialDay, setPartialDay] = useState(false)
  const [partialStart, setPartialStart] = useState('08:00')
  const [partialEnd, setPartialEnd] = useState('12:00')
  const [reason, setReason] = useState('')
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  const [submittedSummary, setSubmittedSummary] = useState<{
    requestType: TimeOffRequestKind
    startsOn: string
    endsOn: string
    estimate: number | null
  } | null>(null)

  const validRange = startsOn.length === 10 && endsOn.length === 10 && endsOn >= startsOn
  const contextQuery = useQuery({
    enabled: validRange,
    queryKey: ['time-off-request-context', startsOn, partialDay ? startsOn : endsOn],
    queryFn: () => getTimeOffRequestContext(startsOn, partialDay ? startsOn : endsOn),
    retry: false,
  })
  const context = contextQuery.data

  useEffect(() => {
    if (!context || (requestType && context.allowedTypes.includes(requestType))) return
    setRequestType(context.allowedTypes[0] ?? null)
  }, [context, requestType])

  useEffect(() => {
    if (partialDay) setEndsOn(startsOn)
    const finalRequestedDate = partialDay ? startsOn : endsOn
    const parsedFinalDate = parseISO(finalRequestedDate)
    if (isValid(parsedFinalDate) && returnOn < finalRequestedDate) {
      setReturnOn(format(addDays(parsedFinalDate, 1), 'yyyy-MM-dd'))
    }
  }, [endsOn, partialDay, returnOn, startsOn])

  const requestedMinutes = useMemo(() => {
    if (!partialDay || partialEnd <= partialStart) return null
    const [startHour, startMinute] = partialStart.split(':').map(Number)
    const [endHour, endMinute] = partialEnd.split(':').map(Number)
    return (endHour * 60 + endMinute) - (startHour * 60 + startMinute)
  }, [partialDay, partialEnd, partialStart])

  const affectedMinutes = context?.affectedShifts.length
    ? context.affectedShifts.reduce((total, shift) => total + shift.estimatedMinutes, 0)
    : null
  const estimate = partialDay ? requestedMinutes : affectedMinutes
  const urgentSickShift = requestType === 'sick_time'
    ? context?.affectedShifts.find((shift) => shift.workday === today && new Date(shift.endsAt).getTime() > Date.now()) ?? null
    : null
  const submitMutation = useMutation({
    mutationFn: submitTimeOffRequestV2,
    onSuccess: async (requestId) => {
      if (requestType) {
        setSubmittedSummary({
          requestType,
          startsOn,
          endsOn: partialDay ? startsOn : endsOn,
          estimate,
        })
      }
      setSubmittedId(requestId)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['request-center'] }),
        queryClient.invalidateQueries({ queryKey: ['time-off-request-context'] }),
        queryClient.invalidateQueries({ queryKey: ['overview-metrics'] }),
      ])
      onSubmitted?.()
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!requestType || !validRange) return
    submitMutation.mutate({
      requestType,
      startsOn,
      endsOn: partialDay ? startsOn : endsOn,
      partialStart: partialDay ? partialStart : null,
      partialEnd: partialDay ? partialEnd : null,
      returnOn: returnOn || null,
      reason: reason.trim() || null,
    })
  }

  if (submittedId) {
    return (
      <ModalDialog className="modal-dialog--time-off-request" onClose={onClose} title="Time-off request submitted">
        <section className="time-off-success" role="status">
          <CheckCircle2 aria-hidden="true" size={42} />
          <div>
            <h3>Your request is waiting for review.</h3>
            <p>The request does not change your schedule until an authorized reviewer approves it.</p>
          </div>
        </section>
        {submittedSummary ? (
          <dl className="time-off-success__summary">
            <div><dt>Request</dt><dd>{requestTypeContent[submittedSummary.requestType].label}</dd></div>
            <div><dt>Dates</dt><dd>{dateLabel(submittedSummary.startsOn)}{submittedSummary.endsOn !== submittedSummary.startsOn ? ` – ${dateLabel(submittedSummary.endsOn)}` : ''}</dd></div>
            <div><dt>Estimated time</dt><dd>{submittedSummary.estimate == null ? 'Calculated during review' : minutesLabel(submittedSummary.estimate)}</dd></div>
            <div><dt>Status</dt><dd>Pending review</dd></div>
          </dl>
        ) : null}
        <div className="modal-actions">
          {requestHistoryPath ? <Link className="secondary-button" to={requestHistoryPath} onClick={onClose}>View request history</Link> : null}
          <button className="primary-action" onClick={onClose} type="button">Done</button>
        </div>
      </ModalDialog>
    )
  }

  return (
    <ModalDialog
      busy={submitMutation.isPending}
      busyLabel="Submitting your request..."
      className="modal-dialog--time-off-request"
      description="Request planned time away for approval. This does not immediately remove you from the schedule."
      onClose={onClose}
      title="Request Time Off"
    >
      <p className="time-off-purpose-note">{plannedTimeOffExplanation}</p>
      {contextQuery.isPending ? <div className="time-off-modal-loading" role="status">Loading your time-off options...</div> : null}
      {contextQuery.isError ? <div className="inline-alert" role="alert">{contextQuery.error.message}</div> : null}
      {context ? (
        <form className="time-off-request-form" onSubmit={submit}>
          <section className="time-off-employee-summary" aria-label="Employee submitting this request">
            <div><span>Employee</span><strong>{context.employee.name}</strong></div>
            <div><span>Employee number</span><strong>{context.employee.employeeNumber ?? 'Not assigned'}</strong></div>
            <div><span>Employment</span><strong>{employmentLabel(context.employee.employmentType)}</strong></div>
            <div><span>Treatment</span><strong>{treatmentLabel(requestType)}</strong></div>
          </section>

          <fieldset className="time-off-type-fieldset">
            <legend>What kind of time off are you requesting?</legend>
            <div className="time-off-type-grid">
              {context.allowedTypes.map((type) => (
                <label className={`time-off-type-card ${requestType === type ? 'time-off-type-card--selected' : ''}`} key={type}>
                  <input checked={requestType === type} name="requestType" onChange={() => setRequestType(type)} type="radio" value={type} />
                  <span><strong>{requestTypeContent[type].label}</strong><small>{requestTypeContent[type].description}</small></span>
                </label>
              ))}
            </div>
          </fieldset>

          <section className="time-off-date-section" aria-labelledby="time-off-dates-title">
            <div className="time-off-section-heading">
              <div><CalendarDays aria-hidden="true" size={22} /><h3 id="time-off-dates-title">Dates and times</h3></div>
              <label className="time-off-partial-toggle">
                <input checked={partialDay} onChange={(event) => setPartialDay(event.target.checked)} type="checkbox" />
                <span>Part of one day</span>
              </label>
            </div>
            <div className="time-off-date-grid">
              <label><span>{partialDay ? 'Date' : 'First day off'}</span><input min={today} onChange={(event) => setStartsOn(event.target.value)} required type="date" value={startsOn} /></label>
              {!partialDay ? <label><span>Last day off</span><input min={startsOn || today} onChange={(event) => setEndsOn(event.target.value)} required type="date" value={endsOn} /></label> : null}
              {partialDay ? <>
                <label><span>Start time</span><input onChange={(event) => setPartialStart(event.target.value)} required type="time" value={partialStart} /></label>
                <label><span>End time</span><input min={partialStart} onChange={(event) => setPartialEnd(event.target.value)} required type="time" value={partialEnd} /></label>
              </> : null}
              <label><span>Expected return date</span><input min={partialDay ? startsOn : endsOn} onChange={(event) => setReturnOn(event.target.value)} type="date" value={returnOn} /></label>
            </div>
          </section>

          <section className="time-off-impact-section" aria-labelledby="time-off-impact-title">
            <div className="time-off-section-heading">
              <div><Clock3 aria-hidden="true" size={22} /><h3 id="time-off-impact-title">Schedule impact</h3></div>
              <span className="time-off-estimate">Estimated requested time: <strong>{estimate == null ? 'Calculated during review' : minutesLabel(estimate)}</strong></span>
            </div>
            {!validRange ? <p className="time-off-empty-shifts">Choose a valid date range to review affected shifts.</p> : contextQuery.isFetching ? <p className="time-off-empty-shifts">Checking published assignments...</p> : <AffectedShiftList shifts={context.affectedShifts} />}
          </section>

          <label className="field-stack">
            <span>Note for the reviewer <small>Optional</small></span>
            <textarea maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Add information that will help the reviewer understand your request." rows={4} value={reason} />
          </label>

          <aside className="time-off-approval-note">
            <ShieldAlert aria-hidden="true" size={22} />
            <div>
              <strong>Approval is required.</strong>
              <p>{approvalWarning}</p>
              {urgentSickShift ? <Link className="danger-button" to="/time/my-time?report=call-off" onClick={onClose}>Use Report Sick / Call-Off</Link> : null}
            </div>
          </aside>

          {submitMutation.isError ? <div className="inline-alert" role="alert">{submitMutation.error.message}</div> : null}
          <div className="modal-actions">
            <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-action" disabled={!requestType || !validRange || (partialDay && (!requestedMinutes || requestedMinutes <= 0)) || submitMutation.isPending} type="submit">
              {submitMutation.isPending ? 'Submitting...' : 'Submit Time-Off Request'}
            </button>
          </div>
        </form>
      ) : null}
    </ModalDialog>
  )
}

export function TimeOffReviewDialog({
  onClose,
  onDecided,
  requestId,
}: {
  onClose: () => void
  onDecided: (message: string) => void
  requestId: string
}) {
  const queryClient = useQueryClient()
  const [decision, setDecision] = useState<'approved' | 'declined' | null>(null)
  const [note, setNote] = useState('')
  const reviewQuery = useQuery({
    queryKey: ['time-off-review-context', requestId],
    queryFn: () => getTimeOffReviewContext(requestId),
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: ({ action, decisionNote }: { action: 'approved' | 'declined'; decisionNote: string }) => decideTimeOffRequestV2(requestId, action, decisionNote),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['request-center'] }),
        queryClient.invalidateQueries({ queryKey: ['time-off-request-context'] }),
        queryClient.invalidateQueries({ queryKey: ['overview-metrics'] }),
      ])
      onDecided(`Time-off request ${variables.action}.`)
      onClose()
    },
  })
  const request = reviewQuery.data

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!decision || !note.trim()) return
    mutation.mutate({ action: decision, decisionNote: note.trim() })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Saving the decision..."
      className="modal-dialog--time-off-review"
      description="Review the submitted details and affected published shifts before recording a decision."
      onClose={onClose}
      title="Review Time-Off Request"
    >
      {reviewQuery.isPending ? <div className="time-off-modal-loading" role="status">Loading the complete request...</div> : null}
      {reviewQuery.isError ? <div className="inline-alert" role="alert">{reviewQuery.error.message}</div> : null}
      {request ? (
        <form className="time-off-review-form" onSubmit={submit}>
          <section className="time-off-review-summary">
            <div><span>Employee</span><strong>{request.employee.name}</strong><small>{request.employee.employeeNumber ?? 'No employee number'}</small></div>
            <div><span>Request</span><strong>{request.requestType ? requestTypeContent[request.requestType].label : 'Legacy time-off request'}</strong><small>{employmentLabel(request.employmentType)}</small></div>
            <div><span>Dates</span><strong>{dateLabel(request.startsOn)}{request.endsOn !== request.startsOn ? ` – ${dateLabel(request.endsOn)}` : ''}</strong><small>{request.partialStart && request.partialEnd ? `${request.partialStart.slice(0, 5)} – ${request.partialEnd.slice(0, 5)}` : 'Full day(s)'}</small></div>
            <div><span>Estimated time</span><strong>{minutesLabel(request.requestedMinutes)}</strong><small>{request.returnOn ? `Return ${dateLabel(request.returnOn)}` : 'Return date not provided'}</small></div>
          </section>

          <section className="time-off-review-detail">
            <div><h3>Employee note</h3><p>{request.reason || 'No note was provided.'}</p></div>
            <div><h3>Pay treatment</h3><p>{request.payTreatment === 'salary_paid_leave' ? 'Salary paid leave' : request.payTreatment === 'sick_policy' ? 'Sick-time policy' : request.payTreatment === 'unpaid' ? 'Unpaid time off' : 'Legacy request—not classified'}</p></div>
          </section>

          <section className="time-off-impact-section" aria-labelledby="review-shifts-title">
            <div className="time-off-section-heading"><div><CalendarDays aria-hidden="true" size={22} /><h3 id="review-shifts-title">Affected published shifts</h3></div></div>
            <AffectedShiftList shifts={request.affectedShifts} />
          </section>

          <fieldset className="time-off-decision-fieldset">
            <legend>Decision</legend>
            <div className="time-off-decision-options">
              <label className={decision === 'approved' ? 'selected' : ''}><input checked={decision === 'approved'} name="decision" onChange={() => setDecision('approved')} type="radio" />Approve request</label>
              <label className={decision === 'declined' ? 'selected' : ''}><input checked={decision === 'declined'} name="decision" onChange={() => setDecision('declined')} type="radio" />Decline request</label>
            </div>
          </fieldset>
          <label className="field-stack"><span>Decision note <small>Required</small></span><textarea maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder="Record why this decision was made." required rows={4} value={note} /></label>
          <p className="form-note">The decision is recorded with the reviewer, time, and original submission snapshot. Approving this request does not rewrite the original schedule.</p>
          {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
          <div className="modal-actions">
            <button className="secondary-button" onClick={onClose} type="button">Leave unresolved</button>
            <button className="primary-action" disabled={!decision || !note.trim() || mutation.isPending} type="submit">Save decision</button>
          </div>
        </form>
      ) : null}
    </ModalDialog>
  )
}

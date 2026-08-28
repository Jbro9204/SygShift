import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileClock,
  ShieldAlert,
  Timer,
  UserRoundCheck,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { canAccessRoute } from '../app/accessPolicy'
import { getSessionContext } from '../data/auth'
import {
  getDailyAttendanceReview,
  payrollHours,
  resolveDailyAttendanceReview,
  type AttendanceClientCreditStatus,
  type AttendanceReconciliationAction,
  type AttendanceReconciliationRow,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { TimeMaintenanceWorkbench, type TimeMaintenanceFocusRequest } from '../pages/TimePage'
import {
  attendanceActionCopy,
  attendanceClientCreditCopy,
  attendanceDiscrepancyCopy,
  recentAttendanceReviewPeriod,
  recommendedAttendanceAction,
  recommendedClientCreditStatus,
  reconciliationNeedsCorrection,
} from './dailyAttendanceReview'
import { formatUsDateKey } from './timeRules'
import { canManageAttendanceReview, canViewAttendanceReview } from './timePermissions'
import { TimeReviewQueueNavigation } from './TimeReviewQueueNavigation'
import {
  TimeAlertCard,
  TimeButton,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

type ReviewFilter = 'unresolved' | 'resolved' | 'all'

function locationLabel(row: AttendanceReconciliationRow): string {
  return [row.siteCode, row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' · ') || row.locationName
}

function reviewStatusLabel(row: AttendanceReconciliationRow): string {
  if (row.reviewStatus === 'unresolved') return 'Unresolved'
  return attendanceActionCopy[row.reviewStatus]
}

function varianceLabel(minutes: number): string {
  if (minutes === 0) return 'Matches plan'
  const direction = minutes > 0 ? 'over' : 'under'
  return `${payrollHours(Math.abs(minutes))} hr ${direction}`
}

export function DailyAttendanceReviewPage() {
  const queryClient = useQueryClient()
  const initialPeriod = recentAttendanceReviewPeriod()
  const [fromDate, setFromDate] = useState(initialPeriod.fromDate)
  const [throughDate, setThroughDate] = useState(initialPeriod.throughDate)
  const [filter, setFilter] = useState<ReviewFilter>('unresolved')
  const [selectedRow, setSelectedRow] = useState<AttendanceReconciliationRow | null>(null)
  const [correctionEmployeeId, setCorrectionEmployeeId] = useState<string | null>(null)
  const [decisionAction, setDecisionAction] = useState<AttendanceReconciliationAction>('approved_variance')
  const [clientCreditStatus, setClientCreditStatus] = useState<AttendanceClientCreditStatus>('not_required')
  const [decisionReason, setDecisionReason] = useState('')

  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const viewAllowed = canViewAttendanceReview(sessionQuery.data)
  const manageAllowed = canManageAttendanceReview(sessionQuery.data)
  const reviewQueueAllowed = canAccessRoute('/time/review', sessionQuery.data)
  const dailyReviewAllowed = canAccessRoute('/time/daily-review', sessionQuery.data)
  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && viewAllowed,
    queryFn: () => getDailyAttendanceReview({ fromDate, includeResolved: true, throughDate }),
    queryKey: ['daily-attendance-review', fromDate, throughDate],
    refetchInterval: 60_000,
  })
  const decisionMutation = useMutation({
    mutationFn: resolveDailyAttendanceReview,
    onSuccess: async () => {
      closeModal()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['daily-attendance-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-payroll-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-team-review'] }),
      ])
    },
  })

  const rows = reviewQuery.data?.rows ?? []
  const visibleRows = rows.filter((row) => {
    if (filter === 'all') return true
    if (filter === 'resolved') return row.reviewStatus !== 'unresolved'
    return row.reviewStatus === 'unresolved'
  })
  const unresolvedCount = rows.filter((row) => row.reviewStatus === 'unresolved').length
  const resolvedCount = rows.length - unresolvedCount
  const callOffCount = rows.filter((row) => row.discrepancyCodes.includes('call_off_reported')).length
  const correctionCount = rows.filter(reconciliationNeedsCorrection).length

  function openReview(row: AttendanceReconciliationRow) {
    const action = row.reviewStatus === 'unresolved' ? recommendedAttendanceAction(row) : 'reopened'
    setSelectedRow(row)
    setCorrectionEmployeeId(null)
    setDecisionAction(action)
    setClientCreditStatus(recommendedClientCreditStatus(action))
    setDecisionReason('')
    decisionMutation.reset()
  }

  function closeModal() {
    setSelectedRow(null)
    setCorrectionEmployeeId(null)
    setDecisionReason('')
    decisionMutation.reset()
  }

  function selectAction(action: AttendanceReconciliationAction) {
    setDecisionAction(action)
    setClientCreditStatus(recommendedClientCreditStatus(action))
  }

  function startCorrection(employeeId: string) {
    setCorrectionEmployeeId(employeeId)
  }

  async function finishCorrection() {
    setCorrectionEmployeeId(null)
    await queryClient.invalidateQueries({ queryKey: ['daily-attendance-review'] })
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader eyebrow="Attendance Review" summary="Secure database connection is required before post-shift review can load." title="Daily Attendance Review" />
        <DataStatePanel icon={ShieldAlert} title="Secure attendance data is not connected" tone="setup">
          <p>Connect Supabase before schedule, punch, and call-off reconciliation can run.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isPending) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading Daily Attendance Review">
          <p>Verifying access and comparing ended shifts with recorded time.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isError || !viewAllowed) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader eyebrow="Attendance Review" summary="Daily review is controlled by Time and Accountability permissions." title="Daily Attendance Review" />
        <DataStatePanel icon={ShieldAlert} title="Daily Attendance Review is not available" tone="error">
          <p>Your account needs accountability.view, accountability.manage, time.view, time.manage, or payroll access with MFA.</p>
        </DataStatePanel>
      </main>
    )
  }

  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={reviewQueueAllowed ? <Link className="time-button time-button--secondary" to="/time/review"><AlertTriangle aria-hidden="true" size={18} /><span>Exceptions</span></Link> : undefined}
        eyebrow="Review Queue"
        summary="Compare the published plan with SygShift punches and call-off records without rewriting schedule history or deleting valid time."
        title="Daily Attendance Review"
      />

      <TimeReviewQueueNavigation canAccessDailyReview={dailyReviewAllowed} canAccessExceptions={reviewQueueAllowed} />

      <TimeAlertCard icon={ClipboardCheck} title="The published schedule remains unchanged" tone="neutral">
        <p>Review decisions document what actually happened. A two-hour grace period prevents a shift from appearing before normal clock-out cleanup is complete.</p>
      </TimeAlertCard>

      <section className="time-card time-team-controls attendance-review-controls" aria-label="Daily attendance review controls">
        <TimeSectionHeader
          eyebrow="Review range"
          summary={`Showing shifts that ended at least ${reviewQuery.data?.graceMinutes ?? 120} minutes ago.`}
          title="Choose the days to reconcile"
        />
        <div className="time-team-controls__grid">
          <label><span>From</span><input max={throughDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
          <label>
            <span>Status</span>
            <select onChange={(event) => setFilter(event.target.value as ReviewFilter)} value={filter}>
              <option value="unresolved">Unresolved only</option>
              <option value="resolved">Resolved only</option>
              <option value="all">All findings</option>
            </select>
          </label>
        </div>
      </section>

      <section className="time-command-grid" aria-label="Daily attendance review summary">
        <TimeMetricCard detail="Schedule-versus-actual findings waiting for a decision." icon={AlertTriangle} label="Unresolved" tone={unresolvedCount > 0 ? 'warning' : 'good'} value={unresolvedCount} />
        <TimeMetricCard detail="Call-offs linked to ended scheduled shifts." icon={UserRoundCheck} label="Call-Offs" tone={callOffCount > 0 ? 'warning' : 'neutral'} value={callOffCount} />
        <TimeMetricCard detail="Punch sequences that must be corrected before payroll." icon={FileClock} label="Time Corrections" tone={correctionCount > 0 ? 'danger' : 'good'} value={correctionCount} />
        <TimeMetricCard detail="Audited outcomes recorded for the current review range." icon={CheckCircle2} label="Resolved" tone="good" value={resolvedCount} />
      </section>

      <section className="time-card time-team-panel attendance-review-panel" aria-label="Attendance review queue">
        <TimeSectionHeader
          eyebrow="Daily queue"
          summary="Open a shift to see its planned employees, actual workers, paid segments, unpaid gaps, call-offs, and the rule that placed it here."
          title="Schedule and time discrepancies"
        />
        {reviewQuery.isPending ? (
          <DataStatePanel icon={Timer} title="Comparing ended shifts"><p>Building the review queue from current schedule and time records.</p></DataStatePanel>
        ) : reviewQuery.isError ? (
          <DataStatePanel icon={ShieldAlert} title="Daily review could not be loaded" tone="error"><p>{reviewQuery.error.message}</p></DataStatePanel>
        ) : visibleRows.length === 0 ? (
          <DataStatePanel icon={CheckCircle2} title="No findings match this view"><p>{filter === 'unresolved' ? 'No ended shifts need a decision in this date range.' : 'Choose another status or date range.'}</p></DataStatePanel>
        ) : (
          <div className="attendance-review-list">
            {visibleRows.map((row) => (
              <article className="attendance-review-row" key={`${row.shiftId}-${row.occurrenceFingerprint}`}>
                <div className="attendance-review-row__identity">
                  <div className="attendance-review-row__title">
                    <TimeStatusBadge tone={row.reviewStatus === 'unresolved' ? 'warning' : 'good'}>{reviewStatusLabel(row)}</TimeStatusBadge>
                    {reconciliationNeedsCorrection(row) ? <TimeStatusBadge tone="danger">Punch correction required</TimeStatusBadge> : null}
                  </div>
                  <strong>{locationLabel(row)}</strong>
                  <span>{formatUsDateKey(row.operationalDate)} · {formatOperationalDateTime(row.startsAt, { timeZone: row.timeZone })} – {formatOperationalDateTime(row.endsAt, { timeZone: row.timeZone })}</span>
                </div>
                <div className="attendance-review-row__metrics">
                  <span><strong>{row.scheduledEmployeeCount}/{row.headcountRequired}</strong> scheduled</span>
                  <span><strong>{row.actualEmployeeCount}/{row.headcountRequired}</strong> recorded</span>
                  <span><strong>{payrollHours(row.actualPaidMinutes)} hr</strong> worked</span>
                  <span><strong>{varianceLabel(row.varianceMinutes)}</strong> variance</span>
                </div>
                <div className="attendance-review-row__flags">
                  {row.discrepancyCodes.map((code) => <TimeStatusBadge key={code} tone={code === 'incomplete_punch_sequence' ? 'danger' : 'warning'}>{attendanceDiscrepancyCopy[code].label}</TimeStatusBadge>)}
                </div>
                <TimeButton onClick={() => openReview(row)} variant="secondary">Review shift</TimeButton>
              </article>
            ))}
          </div>
        )}
      </section>

      {selectedRow ? (
        <ModalDialog
          busy={decisionMutation.isPending}
          busyLabel="Recording the audited attendance decision..."
          className="modal-dialog--wide modal-dialog--attendance-review"
          description={`${formatUsDateKey(selectedRow.operationalDate)} · ${locationLabel(selectedRow)}`}
          onClose={closeModal}
          title={correctionEmployeeId ? 'Correct employee time' : 'Review scheduled shift outcome'}
        >
          {correctionEmployeeId ? (
            <div className="time-maintenance-modal-body">
              <TimeMaintenanceWorkbench
                defaultDate={selectedRow.operationalDate}
                defaultPeriod={{ fromDate: selectedRow.operationalDate, throughDate: selectedRow.operationalDate }}
                focusRequest={{ employeeId: correctionEmployeeId, fromDate: selectedRow.operationalDate, requestId: Date.now(), throughDate: selectedRow.operationalDate } satisfies TimeMaintenanceFocusRequest}
                headingEyebrow="Attendance reconciliation"
                headingSummary="Correct missing or inaccurate punches while preserving the original audit trail."
                headingTitle="Work this employee's time"
                initialEmployeeId={correctionEmployeeId}
                lockEmployeeFilter
                onClose={() => void finishCorrection()}
              />
            </div>
          ) : (
            <div className="attendance-review-detail">
              <section className="attendance-review-detail__summary" aria-label="Shift comparison">
                <article><span>Published plan</span><strong>{rowHours(selectedRow.scheduledCoverageMinutes)} · {selectedRow.headcountRequired} position{selectedRow.headcountRequired === 1 ? '' : 's'}</strong></article>
                <article><span>Recorded work</span><strong>{rowHours(selectedRow.actualPaidMinutes)} · {selectedRow.actualEmployeeCount} worker{selectedRow.actualEmployeeCount === 1 ? '' : 's'}</strong></article>
                <article><span>Difference</span><strong>{varianceLabel(selectedRow.varianceMinutes)}</strong></article>
                <article><span>Review state</span><strong>{reviewStatusLabel(selectedRow)}</strong></article>
              </section>

              {reconciliationNeedsCorrection(selectedRow) ? (
                <TimeAlertCard icon={ShieldAlert} title="A hard payroll blocker still requires a time correction" tone="danger">
                  <p>An attendance decision documents the operational outcome, but it cannot bypass an incomplete or impossible punch sequence. Correct the affected employee's time below.</p>
                </TimeAlertCard>
              ) : null}

              <section className="attendance-review-detail__grid">
                <ReviewPeoplePanel
                  emptyCopy="No employees were assigned on the published schedule."
                  title="Published schedule"
                  people={selectedRow.scheduledEmployees.map((employee) => ({ id: employee.employeeId, name: employee.employeeName, detail: employee.assignmentStatus }))}
                />
                <section className="attendance-review-detail__section">
                  <h3>Actual SygShift time</h3>
                  {selectedRow.actualEmployees.length === 0 ? <p>No punches are linked to this shift.</p> : selectedRow.actualEmployees.map((employee) => (
                    <article className="attendance-review-worker" key={employee.employeeId}>
                      <div>
                        <strong>{employee.employeeName}</strong>
                        <span>{rowHours(employee.paidMinutes)} worked · {rowHours(employee.unpaidGapMinutes)} unpaid gaps</span>
                        <small>{employee.segmentCount} work segment{employee.segmentCount === 1 ? '' : 's'} · {employee.sequenceComplete ? 'Complete sequence' : 'Incomplete sequence'}</small>
                      </div>
                      {manageAllowed ? <TimeButton onClick={() => startCorrection(employee.employeeId)} variant="secondary">Correct time</TimeButton> : null}
                      <div className="attendance-review-worker__segments">
                        {employee.workedSegments.map((segment) => (
                          <span key={segment.segmentNumber}>Segment {segment.segmentNumber}: {formatOperationalDateTime(segment.startsAt, { timeZone: selectedRow.timeZone })} – {segment.endsAt ? formatOperationalDateTime(segment.endsAt, { timeZone: selectedRow.timeZone }) : 'Open'} ({rowHours(segment.paidMinutes)})</span>
                        ))}
                        {employee.unpaidGaps.map((gap) => (
                          <span className="attendance-review-worker__gap" key={`${gap.startsAt}-${gap.endsAt}`}>Unpaid gap: {formatOperationalDateTime(gap.startsAt, { timeZone: selectedRow.timeZone })} – {formatOperationalDateTime(gap.endsAt, { timeZone: selectedRow.timeZone })} ({rowHours(gap.minutes)})</span>
                        ))}
                      </div>
                    </article>
                  ))}
                  {manageAllowed ? selectedRow.scheduledEmployees.filter((employee) => !selectedRow.actualEmployees.some((actual) => actual.employeeId === employee.employeeId)).map((employee) => (
                    <TimeButton key={employee.employeeId} onClick={() => startCorrection(employee.employeeId)} variant="secondary">Add or correct {employee.employeeName}'s time</TimeButton>
                  )) : null}
                </section>
              </section>

              {selectedRow.callOffs.length > 0 ? (
                <section className="attendance-review-detail__section">
                  <h3>Call-off and attendance records</h3>
                  <div className="attendance-review-calloffs">
                    {selectedRow.callOffs.map((callOff) => (
                      <article key={callOff.id}>
                        <strong>{callOff.employeeName}</strong>
                        <span>{callOff.eventType.replaceAll('_', ' ')} · {formatOperationalDateTime(callOff.reportedAt, { includeTimeZoneName: true })}</span>
                        <p>{callOff.note}</p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="attendance-review-detail__section">
                <h3>Why this shift needs review</h3>
                <div className="attendance-review-rules">
                  {selectedRow.discrepancyCodes.map((code) => (
                    <article key={code}>
                      <TimeStatusBadge tone={code === 'incomplete_punch_sequence' ? 'danger' : 'warning'}>{attendanceDiscrepancyCopy[code].label}</TimeStatusBadge>
                      <p>{attendanceDiscrepancyCopy[code].help}</p>
                    </article>
                  ))}
                </div>
              </section>

              {selectedRow.resolution ? (
                <section className="attendance-review-detail__section attendance-review-audit">
                  <h3>Recorded decision</h3>
                  <strong>{attendanceActionCopy[selectedRow.resolution.action]}</strong>
                  <span>{attendanceClientCreditCopy[selectedRow.resolution.clientCreditStatus]} · {selectedRow.resolution.resolvedByName ?? 'Authorized reviewer'} · {formatOperationalDateTime(selectedRow.resolution.resolvedAt, { includeTimeZoneName: true })}</span>
                  <p>{selectedRow.resolution.reason}</p>
                </section>
              ) : null}

              {manageAllowed ? (
                <section className="attendance-review-decision">
                  <h3>{selectedRow.reviewStatus === 'unresolved' ? 'Record the operational outcome' : 'Reopen this reviewed occurrence'}</h3>
                  <p>The decision applies only to this exact schedule, punch, and call-off snapshot. Later changes automatically require another review.</p>
                  <div className="attendance-review-decision__grid">
                    <label>
                      <span>Decision</span>
                      <select onChange={(event) => selectAction(event.target.value as AttendanceReconciliationAction)} value={decisionAction}>
                        {selectedRow.reviewStatus === 'unresolved' ? (
                          <>
                            <option value="confirmed_replacement">Confirm replacement coverage</option>
                            <option value="confirmed_call_off">Confirm call-off</option>
                            <option value="confirmed_uncovered">Confirm uncovered work</option>
                            <option value="approved_variance">Approve legitimate variance</option>
                            <option value="dismissed_false_positive">Dismiss incorrect flag</option>
                          </>
                        ) : <option value="reopened">Reopen review</option>}
                      </select>
                    </label>
                    <label>
                      <span>Client impact</span>
                      <select disabled={decisionAction === 'reopened'} onChange={(event) => setClientCreditStatus(event.target.value as AttendanceClientCreditStatus)} value={clientCreditStatus}>
                        <option value="not_required">Not required</option>
                        <option value="review_required">Client-credit review required</option>
                        <option value="approved_credit">Client credit approved</option>
                        <option value="no_credit">No client credit</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    <span>Required review note</span>
                    <textarea maxLength={1000} minLength={8} onChange={(event) => setDecisionReason(event.target.value)} placeholder="Explain who worked, what happened, and why this decision is correct." rows={4} value={decisionReason} />
                  </label>
                  {decisionMutation.isError ? <p className="form-error">{decisionMutation.error.message}</p> : null}
                  <div className="attendance-review-decision__actions">
                    <TimeButton onClick={closeModal} variant="secondary">Leave unresolved</TimeButton>
                    <TimeButton
                      disabled={decisionReason.trim().length < 8 || (decisionAction === 'confirmed_uncovered' && clientCreditStatus === 'not_required')}
                      loading={decisionMutation.isPending}
                      onClick={() => decisionMutation.mutate({
                        action: decisionAction,
                        clientCreditStatus,
                        occurrenceFingerprint: selectedRow.occurrenceFingerprint,
                        reason: decisionReason.trim(),
                        shiftId: selectedRow.shiftId,
                      })}
                      variant="primary"
                    >
                      Save audited decision
                    </TimeButton>
                  </div>
                </section>
              ) : (
                <div className="attendance-review-detail__footer"><TimeButton onClick={closeModal} variant="secondary">Close</TimeButton></div>
              )}
            </div>
          )}
        </ModalDialog>
      ) : null}
    </main>
  )
}

function ReviewPeoplePanel({ emptyCopy, people, title }: { emptyCopy: string; people: Array<{ detail: string; id: string; name: string }>; title: string }) {
  return (
    <section className="attendance-review-detail__section">
      <h3>{title}</h3>
      {people.length === 0 ? <p>{emptyCopy}</p> : (
        <div className="attendance-review-people">
          {people.map((person) => <article key={person.id}><strong>{person.name}</strong><span>{person.detail}</span></article>)}
        </div>
      )}
    </section>
  )
}

function rowHours(minutes: number): string {
  return `${payrollHours(minutes)} hr`
}

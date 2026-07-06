import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Coffee,
  Download,
  FileClock,
  FileWarning,
  History,
  LockKeyhole,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  activeTimeState,
  createPayrollExportBatch,
  getPayrollExportHistory,
  getTimekeepingDashboard,
  getTimekeepingReview,
  nextTimeEventKinds,
  payrollHours,
  recordTimeEvent,
  reviewRowsToPayrollCsv,
  reviewTimeEventCorrection,
  verifiedTimekeepingBaseline,
  type PendingCorrection,
  type PayrollExportBatch,
  type TimeEventKind,
  type TimekeepingDashboard,
  type TimekeepingEvent,
  type TimekeepingReview,
  type TimekeepingReviewRow,
  type TimekeepingShift,
  type TimekeepingState,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { OPERATIONAL_TIME_ZONE, operationalToday } from '../lib/time'

const actionLabels: Record<TimeEventKind, string> = {
  clock_in: 'Clock in',
  break_start: 'Start break',
  break_end: 'End break',
  clock_out: 'Clock out',
}

const eventLabels: Record<TimeEventKind, string> = {
  clock_in: 'Clocked in',
  break_start: 'Break started',
  break_end: 'Break ended',
  clock_out: 'Clocked out',
}

const stateCopy: Record<TimekeepingState, { title: string; body: string }> = {
  off_clock: {
    title: 'You are currently off the clock.',
    body: 'Choose the correct assigned shift when one is available. If no shift is listed, the punch is recorded as unscheduled time for supervisor review.',
  },
  working: {
    title: 'You are clocked in.',
    body: 'You can start a break or clock out. The official time is recorded by the secure server.',
  },
  on_break: {
    title: 'You are on break.',
    body: 'End the break before clocking out so payroll can calculate the paid and unpaid time correctly.',
  },
}

function formatDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(date)
}

function addDaysKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day + days, 12)
  return formatDateKey(date)
}

function formatTime(value: string, timeZone = OPERATIONAL_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(value))
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: OPERATIONAL_TIME_ZONE,
    weekday: 'short',
  }).format(new Date(value))
}

function shortDigest(digest: string): string {
  return `${digest.slice(0, 10)}…${digest.slice(-6)}`
}

function shiftTitle(shift: TimekeepingShift): string {
  return shift.postName ?? shift.eventName ?? shift.locationName ?? 'Assigned shift'
}

function shiftLocation(shift: TimekeepingShift): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' · ') || 'Location pending'
}

function activeShift(dashboard: TimekeepingDashboard): TimekeepingShift | null {
  const activeShiftId = dashboard.lastEvent?.shiftId
  if (!activeShiftId) return null
  return dashboard.eligibleShifts.find((shift) => shift.shiftId === activeShiftId) ?? null
}

function VerifiedTimekeepingSetup() {
  return (
    <>
      <section className="time-hero-card" aria-labelledby="timekeeping-foundation-title">
        <div className="time-hero-card__icon"><Timer aria-hidden="true" size={31} /></div>
        <div>
          <p className="eyebrow">Timekeeping foundation</p>
          <h2 id="timekeeping-foundation-title">Clock-in rules are ready for the secure database.</h2>
          <p>
            SygShift is built around schedule-linked punches, server-recorded official time, audit-only
            device timestamps, break tracking, and correction records that cannot quietly overwrite history.
          </p>
        </div>
        <span className="import-state-pill"><CheckCircle2 aria-hidden="true" size={17} /> Controlled</span>
      </section>

      <section className="time-rule-grid" aria-label="Timekeeping safeguards">
        {verifiedTimekeepingBaseline.guarantees.map((guarantee) => (
          <article key={guarantee}>
            <BadgeCheck aria-hidden="true" size={22} />
            <span>{guarantee}</span>
          </article>
        ))}
      </section>

      <section className="time-layout">
        <article className="time-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Punch window</p>
              <h2>Easy for guards, strict for payroll</h2>
            </div>
          </div>
          <p className="time-panel__lead">{verifiedTimekeepingBaseline.punchWindow}</p>
          <div className="time-action-row">
            <button className="primary-action" disabled type="button">Clock in</button>
            <button className="secondary-button" disabled type="button">Start break</button>
            <button className="secondary-button" disabled type="button">Clock out</button>
          </div>
        </article>

        <DataStatePanel icon={FileClock} title="Connect Supabase to record live punches" tone="setup">
          <p>
            The page is ready, but live time punches stay disabled until a signed-in employee account is connected.
            Direct table writes remain closed; employees punch only through the controlled workflow.
          </p>
        </DataStatePanel>
      </section>
    </>
  )
}

function ShiftPicker({
  selectedShiftId,
  shifts,
  onSelect,
}: {
  selectedShiftId: string | null
  shifts: TimekeepingShift[]
  onSelect: (shiftId: string | null) => void
}) {
  if (shifts.length === 0) {
    return (
      <div className="time-shift-empty">
        <CalendarClock aria-hidden="true" size={25} />
        <div>
          <strong>No assigned shift is available for today.</strong>
          <p>An unscheduled clock-in can still be recorded for supervisor review.</p>
        </div>
      </div>
    )
  }

  return (
    <fieldset className="time-shift-list">
      <legend>Choose the shift you are clocking into</legend>
      {shifts.map((shift) => (
        <label className={selectedShiftId === shift.shiftId ? 'time-shift-option time-shift-option--selected' : 'time-shift-option'} key={shift.shiftId}>
          <input
            checked={selectedShiftId === shift.shiftId}
            name="time-shift"
            onChange={() => onSelect(shift.shiftId)}
            type="radio"
          />
          <span>
            <strong>{shiftTitle(shift)}</strong>
            <small>{shiftLocation(shift)}</small>
            <em>{formatTime(shift.startsAt, shift.timeZone)} - {formatTime(shift.endsAt, shift.timeZone)}</em>
          </span>
          {shift.requiresArmed ? <b>Armed</b> : null}
          {shift.isOvertime ? <b>OT</b> : null}
        </label>
      ))}
      <label className={selectedShiftId === null ? 'time-shift-option time-shift-option--selected' : 'time-shift-option'}>
        <input checked={selectedShiftId === null} name="time-shift" onChange={() => onSelect(null)} type="radio" />
        <span>
          <strong>Unscheduled time</strong>
          <small>Use only when a supervisor expects you to work outside a listed shift.</small>
        </span>
      </label>
    </fieldset>
  )
}

function PunchControls({
  dashboard,
  pending,
  onPunch,
}: {
  dashboard: TimekeepingDashboard
  pending: boolean
  onPunch: (kind: TimeEventKind, shiftId?: string | null) => void
}) {
  const state = activeTimeState(dashboard.lastEvent)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(
    dashboard.eligibleShifts.length === 1 ? dashboard.eligibleShifts[0]?.shiftId ?? null : null,
  )
  const copy = stateCopy[state]
  const currentShift = activeShift(dashboard)
  const actions = nextTimeEventKinds(state)

  return (
    <section className={`time-clock-card time-clock-card--${state}`} aria-labelledby="time-clock-title">
      <div className="time-clock-card__header">
        <div>
          <p className="eyebrow">Current status</p>
          <h2 id="time-clock-title">{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
        <div className="time-server-box">
          <span>Official server time</span>
          <strong>{formatTime(dashboard.serverTimestamp)}</strong>
        </div>
      </div>

      {state === 'off_clock' ? (
        <ShiftPicker onSelect={setSelectedShiftId} selectedShiftId={selectedShiftId} shifts={dashboard.eligibleShifts} />
      ) : currentShift ? (
        <div className="active-shift-card">
          <Clock3 aria-hidden="true" size={23} />
          <div>
            <strong>{shiftTitle(currentShift)}</strong>
            <span>{shiftLocation(currentShift)} · {formatTime(currentShift.startsAt, currentShift.timeZone)} - {formatTime(currentShift.endsAt, currentShift.timeZone)}</span>
          </div>
        </div>
      ) : (
        <div className="active-shift-card">
          <Clock3 aria-hidden="true" size={23} />
          <div>
            <strong>Unscheduled active time</strong>
            <span>This session will stay visible for supervisor payroll review.</span>
          </div>
        </div>
      )}

      <div className="time-action-row">
        {actions.map((kind) => (
          <button
            className={kind === 'clock_in' || kind === 'clock_out' ? 'primary-action' : 'secondary-button'}
            disabled={pending}
            key={kind}
            onClick={() => onPunch(kind, kind === 'clock_in' ? selectedShiftId : undefined)}
            type="button"
          >
            {kind === 'break_start' || kind === 'break_end' ? <Coffee aria-hidden="true" size={18} /> : <Timer aria-hidden="true" size={18} />}
            {pending ? 'Recording...' : actionLabels[kind]}
          </button>
        ))}
      </div>
    </section>
  )
}

function RecentEvents({ events }: { events: TimekeepingEvent[] }) {
  if (events.length === 0) {
    return (
      <DataStatePanel icon={History} title="No punches recorded today">
        <p>Your clock-in, break, and clock-out events will appear here as soon as they are recorded.</p>
      </DataStatePanel>
    )
  }

  return (
    <section className="time-panel" aria-labelledby="recent-time-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Today</p>
          <h2 id="recent-time-title">Recorded time events</h2>
        </div>
      </div>
      <ol className="time-event-list">
        {events.map((event) => (
          <li className={event.voided ? 'time-event time-event--voided' : 'time-event'} key={event.id}>
            <span><Clock3 aria-hidden="true" size={18} /></span>
            <div>
              <strong>{eventLabels[event.kind]}</strong>
              <small>{formatDate(event.recordedAt)} · {formatTime(event.recordedAt)} · {event.source.replaceAll('_', ' ')}</small>
            </div>
            {event.voided ? <em>Voided</em> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

function exceptionLabel(code: string): string {
  return code.replaceAll('_', ' ')
}

function exportPayrollCsv(review: TimekeepingReview) {
  const csv = reviewRowsToPayrollCsv(review.rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `sygshift-payroll-${review.fromDate}-to-${review.throughDate}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function PayrollReviewTable({ rows }: { rows: TimekeepingReviewRow[] }) {
  if (rows.length === 0) {
    return (
      <DataStatePanel icon={FileClock} title="No time records in this range">
        <p>Recorded punches will appear here once employees begin using the time clock.</p>
      </DataStatePanel>
    )
  }

  return (
    <div className="time-review-table-wrap">
      <table className="time-review-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Date</th>
            <th>Location</th>
            <th>Clock in</th>
            <th>Clock out</th>
            <th>Paid</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.employeeId}-${row.shiftId ?? 'unscheduled'}-${row.operationalDate}`}>
              <td>
                <strong>{row.employeeName}</strong>
                <span>@{row.username}</span>
              </td>
              <td>{row.operationalDate}</td>
              <td>
                <strong>{row.locationName}</strong>
                <span>{[row.siteCode, row.postName ?? row.eventName].filter(Boolean).join(' · ') || 'Time clock'}</span>
              </td>
              <td>{row.firstClockIn ? formatTime(row.firstClockIn, row.timeZone) : 'Missing'}</td>
              <td>{row.lastClockOut ? formatTime(row.lastClockOut, row.timeZone) : 'Missing'}</td>
              <td>
                <strong>{payrollHours(row.paidMinutes)} hr</strong>
                <span>{row.breakMinutes} break min</span>
              </td>
              <td>
                {row.payrollReady ? (
                  <span className="payroll-status payroll-status--ready">Ready</span>
                ) : (
                  <span className="payroll-status payroll-status--hold">Needs review</span>
                )}
                {row.exceptionCodes.length > 0 ? (
                  <small>{row.exceptionCodes.map(exceptionLabel).join(', ')}</small>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CorrectionReviewCard({
  correction,
  pending,
  onDecision,
}: {
  correction: PendingCorrection
  pending: boolean
  onDecision: (approved: boolean, note: string | null) => void
}) {
  const [declineNote, setDeclineNote] = useState('')

  return (
    <article className="correction-card">
      <div>
        <span className="payroll-status payroll-status--hold">{correction.voided ? 'Void requested' : 'Time change requested'}</span>
        <h3>{correction.employeeName}</h3>
        <p>
          {eventLabels[correction.kind]} at {formatTime(correction.recordedAt)}
          {correction.replacementTime ? ` → ${formatTime(correction.replacementTime)}` : ''}
        </p>
        <blockquote>{correction.reason}</blockquote>
      </div>
      <div className="correction-card__actions">
        <button
          className="secondary-button"
          disabled={pending}
          onClick={() => onDecision(true, null)}
          type="button"
        >
          Approve
        </button>
        <label>
          <span className="visually-hidden">Decline reason for {correction.employeeName}</span>
          <textarea
            maxLength={700}
            onChange={(event) => setDeclineNote(event.target.value)}
            placeholder="Reason if declined"
            rows={2}
            value={declineNote}
          />
        </label>
        <button
          className="danger-primary"
          disabled={pending || declineNote.trim().length === 0}
          onClick={() => onDecision(false, declineNote.trim())}
          type="button"
        >
          Decline
        </button>
      </div>
    </article>
  )
}

function PendingCorrections({
  corrections,
  pending,
  onDecision,
}: {
  corrections: PendingCorrection[]
  pending: boolean
  onDecision: (correctionId: string, approved: boolean, note: string | null) => void
}) {
  if (corrections.length === 0) {
    return (
      <DataStatePanel icon={CheckCircle2} title="No correction requests are waiting">
        <p>Employee correction requests will appear here before they affect payroll-ready totals.</p>
      </DataStatePanel>
    )
  }

  return (
    <div className="correction-list">
      {corrections.map((correction) => (
        <CorrectionReviewCard
          correction={correction}
          key={correction.id}
          onDecision={(approved, note) => onDecision(correction.id, approved, note)}
          pending={pending}
        />
      ))}
    </div>
  )
}

function payrollLockBlocker(review: TimekeepingReview | undefined): string {
  if (!review) return 'Load the payroll review before locking an export.'
  if (review.summary.rowCount === 0) return 'There are no time records in this range yet.'
  if (review.summary.pendingCorrectionCount > 0) return 'Resolve every pending correction request first.'
  if (review.summary.exceptionCount > 0) return 'Fix every row marked “Needs review” before locking payroll.'
  if (review.summary.readyCount !== review.summary.rowCount) return 'Every row must be marked Ready before payroll can be locked.'
  return ''
}

function PayrollExportHistoryList({ batches }: { batches: PayrollExportBatch[] }) {
  if (batches.length === 0) {
    return (
      <DataStatePanel icon={Archive} title="No locked payroll exports yet">
        <p>Locked batches will appear here after a supervisor exports a clean review range.</p>
      </DataStatePanel>
    )
  }

  return (
    <ol className="payroll-export-history-list">
      {batches.map((batch) => (
        <li className="payroll-export-history-item" key={batch.id}>
          <div>
            <strong>{batch.fromDate} to {batch.throughDate}</strong>
            <span>{batch.rowCount} rows · {payrollHours(batch.paidMinutes)} paid hours · locked by {batch.createdByName ?? 'Unknown'}</span>
            <small>{formatDate(batch.createdAt)} · {formatTime(batch.createdAt)} · {shortDigest(batch.digest)}</small>
          </div>
          <p>{batch.note}</p>
        </li>
      ))}
    </ol>
  )
}

function SupervisorTimeReview({ defaultDate }: { defaultDate: string }) {
  const queryClient = useQueryClient()
  const [fromDate, setFromDate] = useState(() => addDaysKey(defaultDate, -6))
  const [throughDate, setThroughDate] = useState(defaultDate)
  const [exportNote, setExportNote] = useState('')
  const [lastExport, setLastExport] = useState<PayrollExportBatch | null>(null)
  const reviewQuery = useQuery({
    queryKey: ['timekeeping-review', fromDate, throughDate],
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
  })
  const exportHistoryQuery = useQuery({
    queryKey: ['payroll-export-history'],
    queryFn: () => getPayrollExportHistory(12),
  })
  const correctionMutation = useMutation({
    mutationFn: (input: { correctionId: string; approved: boolean; note: string | null }) => reviewTimeEventCorrection(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timekeeping-review'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
      ])
    },
  })
  const exportMutation = useMutation({
    mutationFn: (note: string) => createPayrollExportBatch({ fromDate, throughDate, note }),
    onSuccess: async (batch) => {
      setLastExport(batch)
      setExportNote('')
      await queryClient.invalidateQueries({ queryKey: ['payroll-export-history'] })
    },
  })
  const review = reviewQuery.data
  const lockBlockedReason = payrollLockBlocker(review)
  const canLockExport = Boolean(review && lockBlockedReason === '' && exportNote.trim().length > 0 && !exportMutation.isPending)

  return (
    <section className="time-review-workbench" aria-labelledby="supervisor-time-title">
      <div className="time-review-workbench__heading">
        <div>
          <p className="eyebrow">Supervisor payroll review</p>
          <h2 id="supervisor-time-title">Review time before payroll export</h2>
          <p>Rows stay marked “Needs review” until the punch sequence is complete and correction requests are resolved.</p>
        </div>
        <div className="time-review-range" aria-label="Time review date range">
          <label><span>From</span><input max={throughDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
        </div>
      </div>

      {reviewQuery.isPending ? (
        <DataStatePanel icon={FileClock} title="Loading payroll review"><p>Calculating paid time, breaks, corrections, and exception flags.</p></DataStatePanel>
      ) : reviewQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Payroll review unavailable" tone="error"><p>{reviewQuery.error.message}</p></DataStatePanel>
      ) : review ? (
        <>
          <section className="time-review-metrics" aria-label="Payroll review totals">
            <article><span>Total rows</span><strong>{review.summary.rowCount}</strong><small>Time groups in range</small></article>
            <article><span>Ready</span><strong>{review.summary.readyCount}</strong><small>Clean payroll rows</small></article>
            <article className={review.summary.exceptionCount ? 'import-metric--attention' : ''}><span>Needs review</span><strong>{review.summary.exceptionCount}</strong><small>Exceptions or missing punches</small></article>
            <article><span>Paid hours</span><strong>{payrollHours(review.summary.paidMinutes)}</strong><small>Export preview total</small></article>
          </section>

          <div className="inline-note">
            Salary employees are included in the review when they have schedule or punch activity. SygShift does not
            automatically add 40 hours to payroll; that requires an approved salary-payroll rule before it is automated.
          </div>

          {correctionMutation.isError ? <div className="inline-alert" role="alert">{correctionMutation.error.message}</div> : null}

          <div className="time-review-actions">
            <p><FileWarning aria-hidden="true" size={18} /> CSV is a preview for checking totals. Locking creates the official payroll audit batch.</p>
            <button className="secondary-button" disabled={review.rows.length === 0} onClick={() => exportPayrollCsv(review)} type="button">
              <Download aria-hidden="true" size={18} /> Export CSV preview
            </button>
          </div>

          <section className="payroll-lock-panel" aria-labelledby="payroll-lock-title">
            <div className="payroll-lock-panel__copy">
              <p className="eyebrow">Controlled export</p>
              <h3 id="payroll-lock-title">Lock clean payroll for this range</h3>
              <p>
                The database rechecks the review before saving anything. If a correction is pending,
                a clock-out is missing, or any row is not ready, the export is blocked.
              </p>
              {lastExport ? (
                <div className="payroll-lock-success" role="status">
                  <CheckCircle2 aria-hidden="true" size={18} />
                  <span>
                    {lastExport.duplicate ? 'This exact payroll batch was already locked.' : 'Payroll export locked.'}
                    {' '}Batch {shortDigest(lastExport.digest)} · {lastExport.rowCount} rows · {payrollHours(lastExport.paidMinutes)} paid hours.
                  </span>
                </div>
              ) : null}
              {exportMutation.isError ? <div className="inline-alert" role="alert">{exportMutation.error.message}</div> : null}
            </div>
            <div className="payroll-lock-controls">
              <label>
                <span>Audit note</span>
                <textarea
                  maxLength={240}
                  onChange={(event) => setExportNote(event.target.value)}
                  placeholder="Example: Reviewed and ready for payroll."
                  rows={3}
                  value={exportNote}
                />
              </label>
              <button
                className="primary-action"
                disabled={!canLockExport}
                onClick={() => exportMutation.mutate(exportNote.trim())}
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={18} />
                {exportMutation.isPending ? 'Locking payroll…' : 'Lock payroll export'}
              </button>
              <small>{lockBlockedReason || (exportNote.trim() ? 'Ready to lock. The server will verify it one more time.' : 'Add a short note before locking payroll.')}</small>
            </div>
          </section>

          <PayrollReviewTable rows={review.rows} />

          <section className="time-panel time-corrections-panel" aria-labelledby="pending-corrections-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Corrections</p>
                <h2 id="pending-corrections-title">Pending correction requests</h2>
              </div>
            </div>
            <PendingCorrections
              corrections={review.pendingCorrections}
              onDecision={(correctionId, approved, note) => correctionMutation.mutate({ correctionId, approved, note })}
              pending={correctionMutation.isPending}
            />
          </section>

          <section className="time-panel payroll-history-panel" aria-labelledby="payroll-history-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Payroll history</p>
                <h2 id="payroll-history-title">Recent locked export batches</h2>
              </div>
            </div>
            {exportHistoryQuery.isPending ? (
              <DataStatePanel icon={Archive} title="Loading locked exports"><p>Retrieving recent payroll batches from the audit history.</p></DataStatePanel>
            ) : exportHistoryQuery.isError ? (
              <DataStatePanel icon={ShieldAlert} title="Payroll history unavailable" tone="error"><p>{exportHistoryQuery.error.message}</p></DataStatePanel>
            ) : (
              <PayrollExportHistoryList batches={exportHistoryQuery.data} />
            )}
          </section>
        </>
      ) : null}
    </section>
  )
}

function LiveTimekeeping() {
  const queryClient = useQueryClient()
  const punchLocked = useRef(false)
  const operationalDate = useMemo(() => formatDateKey(operationalToday()), [])
  const dashboardQuery = useQuery({
    queryKey: ['timekeeping-dashboard', operationalDate],
    queryFn: () => getTimekeepingDashboard(operationalDate),
    refetchInterval: 15_000,
  })
  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSettled: async () => {
      punchLocked.current = false
      await queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'], refetchType: 'active' })
      await queryClient.refetchQueries({ queryKey: ['timekeeping-dashboard'], type: 'active' })
    },
  })

  function recordPunch(kind: TimeEventKind, shiftId?: string | null) {
    if (punchLocked.current || punchMutation.isPending) return
    punchLocked.current = true
    punchMutation.mutate({ kind, shiftId })
  }

  if (dashboardQuery.isPending) {
    return <DataStatePanel icon={Timer} title="Loading timekeeping"><p>Retrieving your assigned shifts, current status, and today&apos;s recorded punches.</p></DataStatePanel>
  }

  if (dashboardQuery.isError) {
    return <DataStatePanel icon={ShieldAlert} title="Timekeeping unavailable" tone="error"><p>{dashboardQuery.error.message}</p></DataStatePanel>
  }

  const dashboard = dashboardQuery.data
  const canReviewPayroll = dashboard.employee.role === 'dispatcher' || dashboard.employee.role === 'supervisor' || dashboard.employee.role === 'admin'

  return (
    <>
      <section className="time-hero-card" aria-labelledby="live-time-title">
        <div className="time-hero-card__icon"><FileClock aria-hidden="true" size={31} /></div>
        <div>
          <p className="eyebrow">Time & Attendance</p>
          <h2 id="live-time-title">{dashboard.employee.displayName}</h2>
          <p>
            @{dashboard.employee.username} · {dashboard.employee.role} · {dashboard.employee.employmentType}
            {' '}employee · Official day {dashboard.operationalDate}
          </p>
        </div>
        <span className={dashboard.pendingCorrectionCount ? 'import-state-pill import-state-pill--attention' : 'import-state-pill'}>
          {dashboard.pendingCorrectionCount ? <CircleAlert aria-hidden="true" size={17} /> : <CheckCircle2 aria-hidden="true" size={17} />}
          {dashboard.pendingCorrectionCount ? `${dashboard.pendingCorrectionCount} correction pending` : 'No pending corrections'}
        </span>
      </section>

      {punchMutation.isError ? <div className="inline-alert" role="alert">{punchMutation.error.message}</div> : null}

      <div className="time-layout">
        <PunchControls
          dashboard={dashboard}
          onPunch={recordPunch}
          pending={punchMutation.isPending}
        />

        <section className="time-panel time-panel--guardrails" aria-labelledby="time-rules-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payroll guardrails</p>
              <h2 id="time-rules-title">What SygShift protects</h2>
            </div>
          </div>
          <ul>
            <li>Server time is the official payroll time.</li>
            <li>Device time is stored only for audit comparison.</li>
            <li>Breaks must be closed before clock-out.</li>
            <li>Corrections never overwrite the original punch.</li>
          </ul>
        </section>
      </div>

      <RecentEvents events={dashboard.recentEvents} />

      {canReviewPayroll ? <SupervisorTimeReview defaultDate={operationalDate} /> : null}
    </>
  )
}

export function TimePage() {
  return (
    <div className="page page--timekeeping">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Time & Attendance</h1>
          <p className="page-summary">
            Clock into scheduled shifts, record breaks, preserve original punch history, and prepare clean
            payroll evidence without making employees fight the system.
          </p>
        </div>
        <div className="access-note"><ShieldAlert aria-hidden="true" size={19} /> Server time is official</div>
      </section>
      {isSupabaseConfigured ? <LiveTimekeeping /> : <VerifiedTimekeepingSetup />}
    </div>
  )
}

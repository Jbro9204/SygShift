import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format, subDays } from 'date-fns'
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileClock,
  History,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  formatTimeOperationsPostLabel,
  getMissingTimeRequestWorkspace,
  submitMissingTimeRequest,
  zonedLocalDateTimeToUtc,
  type MissingTimeRequestWorkspace,
  type TimeAdjustmentRequest,
} from '../data/timeOperations'
import {
  getOwnTimekeepingReview,
  getPayrollPeriodContext,
  getTimekeepingDashboard,
  payrollHours,
  reportAttendanceIssue,
  requestTimeEventCorrection,
  type PendingCorrection,
  type AttendanceReportResult,
  type TimeEventKind,
  type TimekeepingDashboard,
  type TimekeepingEvent,
  type TimekeepingReviewRow,
  type TimekeepingShift,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatDualTimeRange, formatOperationalDateTime } from '../lib/time'
import { canViewOwnTime } from './timePermissions'
import { isActiveInProgressTimeRow } from './timePayroll'
import { currentPayrollPeriod, formatUsDateKey, payrollPeriodFromBoundary } from './timeRules'
import {
  TimeAlertCard,
  TimeButton,
  TimeEmptyState,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

type AttendanceIssueType = 'called_in_sick' | 'call_off'
type TimeCorrectionMode = 'change_time' | 'void' | 'review_note'

const OPERATIONAL_TIME_ZONE = 'America/Denver'

const eventLabels: Record<TimeEventKind, string> = {
  break_end: 'Break ended',
  break_start: 'Break started',
  clock_in: 'Clocked in',
  clock_out: 'Clocked out',
}

export function MyTimePage() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [attendanceReportOpen, setAttendanceReportOpen] = useState(false)
  const [attendanceReportType, setAttendanceReportType] = useState<AttendanceIssueType>('called_in_sick')
  const [attendanceReportShiftId, setAttendanceReportShiftId] = useState('')
  const [attendanceReportDate, setAttendanceReportDate] = useState('')
  const [attendanceReportNote, setAttendanceReportNote] = useState('')
  const [correctionEvent, setCorrectionEvent] = useState<TimekeepingEvent | null>(null)
  const [missingTimeRequestOpen, setMissingTimeRequestOpen] = useState(false)
  const sessionQuery = useQuery({
    queryFn: getSessionContext,
    queryKey: ['session-context'],
    enabled: isSupabaseConfigured,
  })
  const ownTimeAllowed = canViewOwnTime(sessionQuery.data)
  const dashboardQuery = useQuery({
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['my-time-dashboard'],
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    refetchInterval: 15_000,
  })

  const dashboard = dashboardQuery.data
  const periodQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    queryFn: getPayrollPeriodContext,
    queryKey: ['my-time-payroll-period'],
  })
  const payrollPeriod = periodQuery.data
    ? payrollPeriodFromBoundary(periodQuery.data)
    : currentPayrollPeriod(dashboard?.serverTimestamp ? new Date(dashboard.serverTimestamp) : undefined)
  const missingTimeHistoryFromDate = format(
    subDays(new Date(`${payrollPeriod.throughDate}T12:00:00`), 365),
    'yyyy-MM-dd',
  )
  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && ownTimeAllowed && Boolean(dashboard?.employee.id) && periodQuery.isSuccess,
    queryFn: () => getOwnTimekeepingReview({
      employeeId: dashboard?.employee.id ?? '',
      fromDate: payrollPeriod.fromDate,
      throughDate: payrollPeriod.throughDate,
    }),
    queryKey: ['my-time-review', dashboard?.employee.id, payrollPeriod.fromDate, payrollPeriod.throughDate],
  })
  const missingTimeWorkspaceQuery = useQuery({
    enabled: isSupabaseConfigured && ownTimeAllowed && periodQuery.isSuccess,
    queryFn: () => getMissingTimeRequestWorkspace(missingTimeHistoryFromDate, payrollPeriod.throughDate),
    queryKey: ['my-missing-time-workspace', missingTimeHistoryFromDate, payrollPeriod.throughDate],
  })

  const reviewPeriod = reviewQuery.data
    ? { fromDate: reviewQuery.data.fromDate, throughDate: reviewQuery.data.throughDate }
    : payrollPeriod
  const rows = useMemo(() => reviewQuery.data?.rows ?? [], [reviewQuery.data?.rows])
  const todayRows = useMemo(
    () => dashboard ? rows.filter((row) => row.operationalDate === dashboard.operationalDate) : [],
    [dashboard, rows],
  )
  useEffect(() => {
    if (dashboard?.operationalDate && !attendanceReportDate) setAttendanceReportDate(dashboard.operationalDate)
  }, [attendanceReportDate, dashboard?.operationalDate])

  useEffect(() => {
    if (!ownTimeAllowed || searchParams.get('report') !== 'call-off') return

    setAttendanceReportOpen(true)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('report')
    setSearchParams(nextParams, { replace: true })
  }, [ownTimeAllowed, searchParams, setSearchParams])

  const attendanceReportMutation = useMutation({
    mutationFn: () => reportAttendanceIssue({
      eventType: attendanceReportType,
      note: attendanceReportNote,
      operationalDate: attendanceReportShiftId ? null : attendanceReportDate,
      shiftId: attendanceReportShiftId || null,
    }),
    onSuccess: async () => {
      setAttendanceReportNote('')
      setAttendanceReportOpen(false)
      setAttendanceReportShiftId('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-time-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['my-time-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-payroll-accountability'] }),
      ])
    },
  })

  const correctionMutation = useMutation({
    mutationFn: (input: { timeEventId: string; replacementTime: string | null; voided: boolean; reason: string }) => requestTimeEventCorrection(input),
    onSuccess: async () => {
      setCorrectionEvent(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-time-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['my-time-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
      ])
    },
  })
  const missingTimeMutation = useMutation({
    mutationFn: submitMissingTimeRequest,
    onSuccess: async () => {
      setMissingTimeRequestOpen(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-missing-time-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['time-operations-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['missing-time-request-workspace'] }),
      ])
    },
  })

  const totals = useMemo(() => {
    const activeWeek = rows.find((row) => row.operationalDate === dashboard?.operationalDate)?.weekStartsOn
    return {
      payPeriod: sumPaidMinutes(rows),
      pendingCorrections: reviewQuery.data?.pendingCorrections.length ?? dashboard?.pendingCorrectionCount ?? 0,
      today: sumPaidMinutes(todayRows),
      week: activeWeek ? sumPaidMinutes(rows.filter((row) => row.weekStartsOn === activeWeek)) : sumPaidMinutes(rows),
    }
  }, [dashboard?.operationalDate, dashboard?.pendingCorrectionCount, reviewQuery.data?.pendingCorrections.length, rows, todayRows])

  if (!isSupabaseConfigured) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader
          eyebrow="SygShift Time"
          summary="My Time is ready for the secure database connection. Existing punch history will be preserved."
          title="My Time"
        />
        <TimeEmptyState icon={ShieldAlert} title="Secure time data is not connected">
          <p>Connect Supabase before live clock status, punch history, or pay-period totals can load.</p>
        </TimeEmptyState>
      </main>
    )
  }

  if (sessionQuery.isPending || (ownTimeAllowed && (dashboardQuery.isPending || periodQuery.isPending))) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading My Time">
          <p>Loading your clock status, assigned shifts, recent punches, and pay-period summary.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isError || !ownTimeAllowed) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader
          eyebrow="My Time"
          summary="Time & Attendance access is controlled by permissions."
          title="My Time"
        />
        <TimeEmptyState icon={ShieldAlert} title="My Time is not enabled for your account">
          <p>Ask an admin to add time.self.view or time.punch if you should be able to view or use the time clock.</p>
        </TimeEmptyState>
      </main>
    )
  }

  if (dashboardQuery.isError || periodQuery.isError || !dashboard) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={ShieldAlert} title="My Time unavailable" tone="error">
          <p>{dashboardQuery.error?.message ?? periodQuery.error?.message ?? 'Your time dashboard could not be loaded.'}</p>
        </DataStatePanel>
      </main>
    )
  }

  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        eyebrow="My Time"
        summary="Review your current pay period, recent punches, and correction requests. Your time clock remains available above while you work."
        title="My Time"
      />

      {reviewQuery.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Pay-period details could not be loaded" tone="warning">
          <p>Your live clock status is still shown. Advanced review details may require account access to be refreshed.</p>
        </TimeAlertCard>
      ) : null}

      {attendanceReportMutation.isError ? (
        <TimeAlertCard icon={CircleAlert} title="Attendance report could not be sent" tone="danger">
          <p>{attendanceReportMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {correctionMutation.isError ? (
        <TimeAlertCard icon={CircleAlert} title="Correction request could not be saved" tone="danger">
          <p>{correctionMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {missingTimeMutation.isError ? (
        <TimeAlertCard icon={CircleAlert} title="Missing-time request could not be saved" tone="danger">
          <p>{missingTimeMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {attendanceReportMutation.isSuccess ? (
        <AttendanceReportSuccess result={attendanceReportMutation.data} />
      ) : null}
      {correctionMutation.isSuccess ? (
        <TimeAlertCard icon={CheckCircle2} title="Correction request sent" tone="good">
          <p>Your request was saved for supervisor/admin review. The original punch remains unchanged until it is approved.</p>
        </TimeAlertCard>
      ) : null}
      {missingTimeMutation.isSuccess ? (
        <TimeAlertCard icon={CheckCircle2} title="Missing-time request sent" tone="good">
          <p>Your request is pending authorized review. It will not change payroll until it is approved.</p>
        </TimeAlertCard>
      ) : null}

      <section className="my-time-dashboard-grid">
        <section className="time-card my-time-summary-card">
          <TimeSectionHeader
            eyebrow="Current pay period"
            summary={`${formatUsDateKey(reviewPeriod.fromDate)} - ${formatUsDateKey(reviewPeriod.throughDate)}`}
            title="Your Hours"
          />
          <div className="time-command-grid my-time-summary-card__metrics" aria-busy={periodQuery.isPending || reviewQuery.isPending}>
            <TimeMetricCard detail="Paid time recorded today." icon={Clock3} label="Today" value={`${payrollHours(totals.today)} hrs`} />
            <TimeMetricCard detail="Paid time for the current week." icon={CalendarDays} label="This Week" value={`${payrollHours(totals.week)} hrs`} />
            <TimeMetricCard detail="Paid time in the current pay period." icon={FileClock} label="Pay Period" value={`${payrollHours(totals.payPeriod)} hrs`} />
            <TimeMetricCard
              detail="Correction requests waiting for review."
              icon={AlertTriangle}
              label="Needs Review"
              tone={totals.pendingCorrections > 0 ? 'warning' : 'good'}
              value={totals.pendingCorrections}
            />
          </div>
        </section>
        <section className="time-card my-time-self-service-card">
          <TimeSectionHeader
            eyebrow="Self-service"
            summary="Send the right request without changing the original time record."
            title="Report or correct time"
          />
          <div className="my-time-self-service-card__actions">
            <TimeButton icon={AlertTriangle} onClick={() => setAttendanceReportOpen(true)} variant="secondary">
              Report sick / call-off
            </TimeButton>
            <p>Use this if you cannot work. Dispatch is notified immediately.</p>
            <TimeButton icon={FileClock} onClick={() => setMissingTimeRequestOpen(true)} variant="secondary">
              Request missing time
            </TimeButton>
            <p>Use this when an entire worked shift is missing. An explanation is required for review.</p>
          </div>
        </section>
      </section>

      <MyTimeRows
        loading={reviewQuery.isPending}
        onRequestCorrection={setCorrectionEvent}
        recentEvents={dashboard.recentEvents}
        rows={rows}
        serverTimestamp={reviewQuery.data?.serverTimestamp}
      />

      <section className="my-time-two-column">
        <RecentPunchesPanel dashboard={dashboard} onRequestCorrection={setCorrectionEvent} />
        <CorrectionPanel
          corrections={reviewQuery.data?.pendingCorrections ?? []}
          loading={reviewQuery.isPending || missingTimeWorkspaceQuery.isPending}
          missingRequests={missingTimeWorkspaceQuery.data?.requests ?? []}
        />
      </section>

      {attendanceReportOpen ? (
        <AttendanceReportModal
          date={attendanceReportDate || dashboard.operationalDate}
          eventType={attendanceReportType}
          note={attendanceReportNote}
          onChangeDate={setAttendanceReportDate}
          onChangeEventType={setAttendanceReportType}
          onChangeNote={setAttendanceReportNote}
          onChangeShiftId={setAttendanceReportShiftId}
          onClose={() => setAttendanceReportOpen(false)}
          onSubmit={() => attendanceReportMutation.mutate()}
          pending={attendanceReportMutation.isPending}
          selectedShiftId={attendanceReportShiftId}
          shifts={dashboard.eligibleShifts}
        />
      ) : null}
      {correctionEvent ? (
        <TimeCorrectionRequestModal
          event={correctionEvent}
          onClose={() => setCorrectionEvent(null)}
          onSubmit={(input) => correctionMutation.mutate(input)}
          pending={correctionMutation.isPending}
        />
      ) : null}
      {missingTimeRequestOpen ? (
        <MissingTimeRequestModal
          employeeName={dashboard.employee.displayName}
          onClose={() => setMissingTimeRequestOpen(false)}
          onSubmit={(input) => missingTimeMutation.mutate(input)}
          operationalDate={dashboard.operationalDate}
          pending={missingTimeMutation.isPending}
          posts={missingTimeWorkspaceQuery.data?.posts ?? []}
        />
      ) : null}
    </main>
  )
}

function AttendanceReportSuccess({ result }: { result: AttendanceReportResult }) {
  return (
    <TimeAlertCard icon={CheckCircle2} title="Attendance report saved" tone={result.dispatchNotified ? 'good' : 'warning'}>
      <p>
        {result.dispatchNotified
          ? 'Dispatch was notified automatically.'
          : `The report was saved, but Dispatch email needs follow-up${result.dispatchError ? `: ${result.dispatchError}` : '.'}`}
      </p>
    </TimeAlertCard>
  )
}

function AttendanceReportModal({
  date,
  eventType,
  note,
  onChangeDate,
  onChangeEventType,
  onChangeNote,
  onChangeShiftId,
  onClose,
  onSubmit,
  pending,
  selectedShiftId,
  shifts,
}: {
  date: string
  eventType: AttendanceIssueType
  note: string
  onChangeDate: (value: string) => void
  onChangeEventType: (value: AttendanceIssueType) => void
  onChangeNote: (value: string) => void
  onChangeShiftId: (value: string) => void
  onClose: () => void
  onSubmit: () => void
  pending: boolean
  selectedShiftId: string
  shifts: TimekeepingShift[]
}) {
  const noteReady = note.trim().length > 0
  const canSubmit = noteReady && (selectedShiftId || date)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canSubmit) onSubmit()
  }

  return (
    <ModalDialog
      busy={pending}
      busyLabel="Saving report and notifying Dispatch..."
      className="modal-dialog--attendance-report"
      description="Report a sick call or call-off without removing yourself from the shift until coverage is handled."
      onClose={onClose}
      title="Report sick or call-off"
    >
      <form className="attendance-report-form" onSubmit={submit}>
        <TimeAlertCard icon={AlertTriangle} title="Important coverage rule" tone="warning">
          <p>Your shift remains your responsibility until coverage is approved. This report alerts Dispatch so coverage can be worked immediately.</p>
        </TimeAlertCard>

        <fieldset className="attendance-report-choice-grid">
          <legend>What are you reporting?</legend>
          <label className={eventType === 'called_in_sick' ? 'attendance-report-choice attendance-report-choice--selected' : 'attendance-report-choice'}>
            <input
              checked={eventType === 'called_in_sick'}
              disabled={pending}
              name="attendance-report-type"
              onChange={() => onChangeEventType('called_in_sick')}
              type="radio"
            />
            <span>
              <strong>Called in sick</strong>
              <small>Use this for illness or sickness-related absence.</small>
            </span>
          </label>
          <label className={eventType === 'call_off' ? 'attendance-report-choice attendance-report-choice--selected' : 'attendance-report-choice'}>
            <input
              checked={eventType === 'call_off'}
              disabled={pending}
              name="attendance-report-type"
              onChange={() => onChangeEventType('call_off')}
              type="radio"
            />
            <span>
              <strong>Call-off / cannot work</strong>
              <small>Use this for other last-minute coverage issues.</small>
            </span>
          </label>
        </fieldset>

        <div className="attendance-report-grid">
          <label>
            <span>Shift</span>
            <select disabled={pending} onChange={(event) => onChangeShiftId(event.target.value)} value={selectedShiftId}>
              <option value="">No specific shift / date only</option>
              {shifts.map((shift) => (
                <option key={shift.assignmentId} value={shift.shiftId}>
                  {formatUsDateKey(shift.startsAt.slice(0, 10))} - {shiftTitle(shift)} - {shiftLocation(shift)} - {formatDualTimeRange(shift.startsAt, shift.endsAt, shift.timeZone)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Date</span>
            <input disabled={pending || Boolean(selectedShiftId)} onChange={(event) => onChangeDate(event.target.value)} type="date" value={date} />
          </label>
        </div>

        <label className="attendance-report-note">
          <span>Short note</span>
          <textarea
            disabled={pending}
            maxLength={2000}
            onChange={(event) => onChangeNote(event.target.value)}
            placeholder="Example: I am sick and cannot work tonight. I will be available by phone if Dispatch needs details."
            rows={5}
            value={note}
          />
          <small>{note.trim().length}/2000 characters</small>
        </label>

        <div className="modal-actions attendance-report-actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <TimeButton disabled={!canSubmit} loading={pending} type="submit" variant="primary">
            Send to Dispatch
          </TimeButton>
        </div>
      </form>
    </ModalDialog>
  )
}

function RecentPunchesPanel({
  dashboard,
  onRequestCorrection,
}: {
  dashboard: TimekeepingDashboard
  onRequestCorrection: (event: TimekeepingEvent) => void
}) {
  const recentPunchDays = useMemo(() => groupRecentPunchesByDay(dashboard.recentEvents), [dashboard.recentEvents])
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null)
  const selectedDay = recentPunchDays.find((day) => day.dateKey === selectedDateKey) ?? recentPunchDays[0] ?? null

  return (
    <section className="time-card">
      <TimeSectionHeader
        eyebrow="Recent activity"
        summary={`Updated ${formatOperationalDateTime(dashboard.serverTimestamp, { includeTimeZoneName: true })}`}
        title="Recent Punches"
      />
      {recentPunchDays.length > 0 && selectedDay ? (
        <>
          <div className="recent-punch-day-tabs" role="tablist" aria-label="Recent punch days">
            {recentPunchDays.map((day) => {
              const selected = day.dateKey === selectedDay.dateKey
              return (
                <button
                  aria-selected={selected}
                  className={`recent-punch-day-tab${selected ? ' recent-punch-day-tab--active' : ''}`}
                  key={day.dateKey}
                  onClick={() => setSelectedDateKey(day.dateKey)}
                  role="tab"
                  type="button"
                >
                  <strong>{recentPunchDayLabel(day.dateKey, dashboard.operationalDate)}</strong>
                  <span>{day.events.length} {day.events.length === 1 ? 'punch' : 'punches'}</span>
                </button>
              )
            })}
          </div>
          <ul className="time-event-list time-event-list--day">
            {selectedDay.events.map((event) => (
              <li className={`time-event${event.voided ? ' time-event--voided' : ''}`} key={event.id}>
                <span><History aria-hidden="true" size={18} /></span>
                <div>
                  <strong>{eventLabels[event.kind]}</strong>
                  <small>{formatOperationalDateTime(event.effectiveAt ?? event.recordedAt, { includeTimeZoneName: true })}</small>
                  <small>{event.workType === 'training' ? 'Paid training' : 'Worked time'}</small>
                </div>
                {event.voided ? <em>Voided</em> : null}
                <button
                  className="secondary-button secondary-button--small time-event__correction-button"
                  disabled={Boolean(event.voided)}
                  onClick={() => onRequestCorrection(event)}
                  type="button"
                >
                  Request correction
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <TimeEmptyState icon={History} title="No recent punches">
          <p>Your recent clock activity will appear here after time is recorded.</p>
        </TimeEmptyState>
      )}
    </section>
  )
}

type RecentPunchDay = {
  dateKey: string
  events: TimekeepingEvent[]
}

function groupRecentPunchesByDay(events: TimekeepingEvent[]): RecentPunchDay[] {
  const grouped = new Map<string, TimekeepingEvent[]>()

  for (const event of events) {
    const dateKey = operationalDateKey(event.effectiveAt ?? event.recordedAt)
    const dayEvents = grouped.get(dateKey) ?? []
    dayEvents.push(event)
    grouped.set(dateKey, dayEvents)
  }

  return [...grouped.entries()]
    .map(([dateKey, dayEvents]) => ({
      dateKey,
      events: dayEvents.sort((left, right) => new Date(right.effectiveAt ?? right.recordedAt).getTime() - new Date(left.effectiveAt ?? left.recordedAt).getTime()),
    }))
    .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
    .slice(0, 7)
}

function operationalDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function recentPunchDayLabel(dateKey: string, operationalToday: string): string {
  if (dateKey === operationalToday) return 'Today'
  const yesterday = format(subDays(new Date(`${operationalToday}T12:00:00`), 1), 'yyyy-MM-dd')
  if (dateKey === yesterday) return 'Yesterday'
  return format(new Date(`${dateKey}T12:00:00`), 'EEE MM/dd')
}

function CorrectionPanel({
  corrections,
  loading,
  missingRequests,
}: {
  corrections: PendingCorrection[]
  loading: boolean
  missingRequests: TimeAdjustmentRequest[]
}) {
  const pendingMissingRequests = missingRequests.filter((request) => request.status === 'submitted' || request.status === 'under_review')
  const hasPendingRequests = corrections.length > 0 || pendingMissingRequests.length > 0

  return (
    <section className="time-card">
      <TimeSectionHeader
        eyebrow="Corrections"
        summary="Corrections never overwrite the original punch. They remain visible until reviewed."
        title="Correction Status"
      />
      {loading ? (
        <DataStatePanel icon={Timer} title="Loading corrections">
          <p>Checking your correction requests.</p>
        </DataStatePanel>
      ) : hasPendingRequests ? (
        <div className="my-time-correction-list">
          {corrections.map((correction) => (
            <article className="my-time-correction-card" key={correction.id}>
              <TimeStatusBadge tone="warning">Pending</TimeStatusBadge>
              <strong>{eventLabels[correction.kind]}</strong>
              <span>{formatOperationalDateTime(correction.replacementTime ?? correction.recordedAt, { includeTimeZoneName: true })}</span>
              <p>{correction.reason}</p>
            </article>
          ))}
          {pendingMissingRequests.map((request) => (
            <article className="my-time-correction-card" key={request.id}>
              <TimeStatusBadge tone="warning">{request.status === 'under_review' ? 'Under Review' : 'Pending'}</TimeStatusBadge>
              <strong>Missing worked time</strong>
              <span>{formatUsDateKey(request.workDate)} · {request.requestedLocation ?? 'Site/Post pending'}</span>
              <p>{request.reason}</p>
              <small>
                {request.requestedClockInAt ? formatOperationalDateTime(request.requestedClockInAt, { timeZone: request.requestedTimeZone ?? OPERATIONAL_TIME_ZONE }) : 'Clock-in pending'}
                {' – '}
                {request.requestedClockOutAt ? formatOperationalDateTime(request.requestedClockOutAt, { timeZone: request.requestedTimeZone ?? OPERATIONAL_TIME_ZONE }) : 'Clock-out pending'}
                {request.requestedUnpaidBreakMinutes > 0 ? ` · ${request.requestedUnpaidBreakMinutes} unpaid break min` : ''}
              </small>
            </article>
          ))}
        </div>
      ) : (
        <TimeAlertCard icon={CheckCircle2} title="No pending correction requests" tone="good">
          <p>If something looks wrong later, open Advanced Time Tools and request a correction.</p>
        </TimeAlertCard>
      )}
    </section>
  )
}

function MissingTimeRequestModal({
  employeeName,
  onClose,
  onSubmit,
  operationalDate,
  pending,
  posts,
}: {
  employeeName: string
  onClose: () => void
  onSubmit: (input: {
    workDate: string
    requestedClockInAt: string
    requestedClockOutAt: string
    postId: string
    unpaidBreakMinutes: number
    reason: string
  }) => void
  operationalDate: string
  pending: boolean
  posts: MissingTimeRequestWorkspace['posts']
}) {
  const [workDate, setWorkDate] = useState(operationalDate)
  const [clockInTime, setClockInTime] = useState('08:00')
  const [clockOutTime, setClockOutTime] = useState('16:00')
  const [postId, setPostId] = useState('')
  const [unpaidBreakMinutes, setUnpaidBreakMinutes] = useState(0)
  const [reason, setReason] = useState('')
  const selectedPost = posts.find((post) => post.id === postId)
  const ready = Boolean(selectedPost && workDate && clockInTime && clockOutTime && reason.trim().length >= 10)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || !selectedPost) return

    const startLocal = `${workDate}T${clockInTime}`
    const startMinutes = Number(clockInTime.slice(0, 2)) * 60 + Number(clockInTime.slice(3, 5))
    const endMinutes = Number(clockOutTime.slice(0, 2)) * 60 + Number(clockOutTime.slice(3, 5))
    const endDate = endMinutes <= startMinutes
      ? format(addDays(new Date(`${workDate}T12:00:00`), 1), 'yyyy-MM-dd')
      : workDate

    onSubmit({
      postId,
      reason: reason.trim(),
      requestedClockInAt: zonedLocalDateTimeToUtc(startLocal, selectedPost.timeZone),
      requestedClockOutAt: zonedLocalDateTimeToUtc(`${endDate}T${clockOutTime}`, selectedPost.timeZone),
      unpaidBreakMinutes,
      workDate,
    })
  }

  return (
    <ModalDialog
      busy={pending}
      busyLabel="Submitting missing-time request..."
      className="modal-dialog--missing-time-request"
      description="Report an entire worked shift that is missing. Your identity is filled automatically. No punches or payroll hours are created until an authorized reviewer approves this request."
      onClose={onClose}
      title="Request missing time"
    >
      <form className="missing-time-request-form" onSubmit={submit}>
        <section className="missing-time-request-identity" aria-label="Requesting employee">
          <span>Employee</span>
          <strong>{employeeName}</strong>
          <small>This request is securely tied to your signed-in account.</small>
        </section>

        <div className="missing-time-request-grid">
          <label>
            <span>Work date</span>
            <input disabled={pending} max={operationalDate} onChange={(event) => setWorkDate(event.target.value)} required type="date" value={workDate} />
          </label>
          <label>
            <span>Clock-in time</span>
            <input disabled={pending} onChange={(event) => setClockInTime(event.target.value)} required type="time" value={clockInTime} />
          </label>
          <label>
            <span>Clock-out time</span>
            <input disabled={pending} onChange={(event) => setClockOutTime(event.target.value)} required type="time" value={clockOutTime} />
            <small>Choose the morning time for an overnight shift. SygShift will use the next day automatically.</small>
          </label>
          <label>
            <span>Unpaid break</span>
            <select disabled={pending} onChange={(event) => setUnpaidBreakMinutes(Number(event.target.value))} value={unpaidBreakMinutes}>
              <option value={0}>No unpaid break</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={45}>45 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
          </label>
        </div>

        <label className="missing-time-request-post">
          <span>Site / Post</span>
          <select disabled={pending} onChange={(event) => setPostId(event.target.value)} required value={postId}>
            <option value="">Choose where you worked</option>
            {posts.map((post) => <option key={post.id} value={post.id}>{formatTimeOperationsPostLabel(post)}</option>)}
          </select>
        </label>

        <label className="missing-time-request-reason">
          <span>Explanation <strong>Required</strong></span>
          <textarea
            disabled={pending}
            maxLength={1000}
            minLength={10}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why the time is missing and any details the reviewer should verify."
            required
            rows={5}
            value={reason}
          />
          <small>{reason.trim().length}/1000 characters · minimum 10</small>
        </label>

        {posts.length === 0 ? (
          <TimeAlertCard icon={AlertTriangle} title="Site/Post list unavailable" tone="warning">
            <p>The request cannot be submitted until the active Site/Post list loads. Close this window and try again.</p>
          </TimeAlertCard>
        ) : null}

        <div className="missing-time-request-actions">
          <TimeButton disabled={pending} onClick={onClose} type="button" variant="secondary">Cancel</TimeButton>
          <TimeButton disabled={!ready} loading={pending} type="submit" variant="primary">Submit for review</TimeButton>
        </div>
      </form>
    </ModalDialog>
  )
}

function MyTimeRows({
  loading,
  onRequestCorrection,
  recentEvents,
  rows,
  serverTimestamp,
}: {
  loading: boolean
  onRequestCorrection: (event: TimekeepingEvent) => void
  recentEvents: TimekeepingEvent[]
  rows: TimekeepingReviewRow[]
  serverTimestamp?: string
}) {
  const reviewNow = serverTimestamp ? new Date(serverTimestamp) : new Date()

  return (
    <section className="my-time-history">
      <div className="my-time-history__heading">
        <div>
          <p className="eyebrow">Pay-period detail</p>
          <h2>My Timecards</h2>
          <p>These rows are the current payroll preview for your own time. Final payroll review remains controlled by approved operations users.</p>
        </div>
      </div>
      {loading ? (
        <DataStatePanel icon={Timer} title="Loading timecards">
          <p>Retrieving your current pay-period records.</p>
        </DataStatePanel>
      ) : rows.length > 0 ? (
        <div className="my-time-history__list">
          {rows.map((row) => (
            <MyTimecardRow
              key={`${row.rowKind}-${row.employeeId}-${row.operationalDate}-${row.shiftId ?? row.locationName}`}
              onRequestCorrection={onRequestCorrection}
              recentEvents={recentEvents}
              row={row}
              serverNow={reviewNow}
            />
          ))}
        </div>
      ) : (
        <TimeEmptyState icon={FileClock} title="No timecards in this pay period">
          <p>Your own pay-period rows will appear here after punches, salary defaults, or approved time records exist.</p>
        </TimeEmptyState>
      )}
    </section>
  )
}

function MyTimecardRow({
  onRequestCorrection,
  recentEvents,
  row,
  serverNow,
}: {
  onRequestCorrection: (event: TimekeepingEvent) => void
  recentEvents: TimekeepingEvent[]
  row: TimekeepingReviewRow
  serverNow: Date
}) {
  const activeInProgress = isActiveInProgressTimeRow(row, serverNow)
  const visibleExceptions = activeInProgress
    ? row.exceptionCodes.filter((code) => code !== 'missing_clock_out' && code !== 'zero_paid_minutes')
    : row.exceptionCodes
  const ready = row.payrollReady || activeInProgress
  const correctionEvent = findCorrectionEventForRow(row, recentEvents)

  return (
    <article className="my-time-row">
      <div className="my-time-row__date">
        <strong>{formatUsDateKey(row.operationalDate)}</strong>
        <span>{row.rowKind === 'salary_default' ? 'Salary default' : 'Time clock'}</span>
      </div>
      <div>
        <strong>{row.locationName}</strong>
        <span>{[row.siteCode, row.siteName, row.postName, row.eventName].filter(Boolean).join(' - ') || 'Location pending'}</span>
        <small>{formatRowWindow(row, activeInProgress)}{row.mixedWorkTypes ? ' · Needs classification review' : row.workType === 'training' ? ' · Paid training' : ''}</small>
      </div>
      <div className="my-time-row__hours">
        <strong>{payrollHours(row.paidMinutes)} hrs</strong>
        <span>{row.breakMinutes} unpaid break min</span>
      </div>
      <div className="my-time-row__status">
        <TimeStatusBadge tone={ready ? 'good' : 'warning'}>{activeInProgress ? 'In progress' : ready ? 'Ready' : 'Needs review'}</TimeStatusBadge>
        {visibleExceptions.length > 0 ? <small>{visibleExceptions.join(', ')}</small> : null}
      </div>
      <div className="my-time-row__actions">
        {correctionEvent ? (
          <button
            className="secondary-button secondary-button--small"
            disabled={correctionEvent.voided}
            onClick={() => onRequestCorrection(correctionEvent)}
            type="button"
          >
            Request correction
          </button>
        ) : (
          <small>Open Recent Punches for correction options.</small>
        )}
      </div>
    </article>
  )
}

function findCorrectionEventForRow(row: TimekeepingReviewRow, events: TimekeepingEvent[]): TimekeepingEvent | null {
  if (row.rowKind !== 'time_event') return null
  const rowDate = row.operationalDate
  const candidates = events.filter((event) => {
    const eventDate = dateInputValue(event.effectiveAt ?? event.recordedAt)
    if (eventDate !== rowDate) return false
    if (row.shiftId && event.shiftId === row.shiftId) return true
    return !row.shiftId
  })
  return candidates.find((event) => event.kind === 'clock_out')
    ?? candidates.find((event) => event.kind === 'clock_in')
    ?? candidates[0]
    ?? null
}

function TimeCorrectionRequestModal({
  event,
  onClose,
  onSubmit,
  pending,
}: {
  event: TimekeepingEvent
  onClose: () => void
  onSubmit: (input: { timeEventId: string; replacementTime: string | null; voided: boolean; reason: string }) => void
  pending: boolean
}) {
  const [mode, setMode] = useState<TimeCorrectionMode>('change_time')
  const [date, setDate] = useState(dateInputValue(event.effectiveAt ?? event.recordedAt))
  const [time, setTime] = useState(timeInputValue(event.effectiveAt ?? event.recordedAt))
  const [reason, setReason] = useState('')
  const reasonReady = reason.trim().length >= 8
  const canSubmit = reasonReady && !pending

  function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    if (!canSubmit) return
    onSubmit({
      reason: correctionReason(mode, reason),
      replacementTime: mode === 'void' ? null : mode === 'review_note' ? (event.effectiveAt ?? event.recordedAt) : zonedDateTimeToIso(date, time),
      timeEventId: event.id,
      voided: mode === 'void',
    })
  }

  return (
    <ModalDialog
      busy={pending}
      busyLabel="Sending correction request..."
      className="modal-dialog--time-correction-request"
      description="Request a supervisor/admin review without changing the original punch until it is approved."
      onClose={onClose}
      title="Request a time-card correction"
    >
      <form className="time-correction-request-form" onSubmit={submit}>
        <article className="time-correction-request-punch">
          <span>{eventLabels[event.kind]}</span>
          <strong>{formatOperationalDateTime(event.effectiveAt ?? event.recordedAt, { includeTimeZoneName: true })}</strong>
          <small>Original punch remains protected while this request is reviewed.</small>
        </article>

        <fieldset className="time-correction-request-modes">
          <legend>What needs to change?</legend>
          <label className={mode === 'change_time' ? 'time-correction-request-mode time-correction-request-mode--selected' : 'time-correction-request-mode'}>
            <input checked={mode === 'change_time'} disabled={pending} name="time-correction-mode" onChange={() => setMode('change_time')} type="radio" />
            <span><strong>Wrong time</strong><small>Request a corrected date/time for this punch.</small></span>
          </label>
          <label className={mode === 'void' ? 'time-correction-request-mode time-correction-request-mode--selected' : 'time-correction-request-mode'}>
            <input checked={mode === 'void'} disabled={pending} name="time-correction-mode" onChange={() => setMode('void')} type="radio" />
            <span><strong>Wrong punch</strong><small>Ask for this punch to be voided.</small></span>
          </label>
          <label className={mode === 'review_note' ? 'time-correction-request-mode time-correction-request-mode--selected' : 'time-correction-request-mode'}>
            <input checked={mode === 'review_note'} disabled={pending} name="time-correction-mode" onChange={() => setMode('review_note')} type="radio" />
            <span><strong>Other issue</strong><small>Use for break, missing punch, or location issues that need supervisor help.</small></span>
          </label>
        </fieldset>

        {mode === 'change_time' ? (
          <div className="time-correction-request-fields">
            <label>
              <span>Correct date</span>
              <input disabled={pending} onChange={(inputEvent) => setDate(inputEvent.target.value)} required type="date" value={date} />
            </label>
            <label>
              <span>Correct time / Mountain</span>
              <input disabled={pending} onChange={(inputEvent) => setTime(inputEvent.target.value)} required type="time" value={time} />
            </label>
          </div>
        ) : null}

        <label className="time-correction-request-reason">
          <span>Explain the request</span>
          <textarea
            disabled={pending}
            maxLength={2000}
            onChange={(inputEvent) => setReason(inputEvent.target.value)}
            placeholder="Example: I forgot to clock out at the end of my shift. I left at 6:00 PM."
            rows={5}
            value={reason}
          />
          <small>{reason.trim().length < 8 ? 'Enter at least 8 characters so payroll has context.' : `${reason.trim().length}/2000 characters`}</small>
        </label>

        <div className="modal-actions time-correction-request-actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <TimeButton disabled={!canSubmit} loading={pending} type="submit" variant="primary">
            Send correction request
          </TimeButton>
        </div>
      </form>
    </ModalDialog>
  )
}

function correctionReason(mode: TimeCorrectionMode, reason: string): string {
  const prefix = mode === 'change_time'
    ? 'Employee requested time correction'
    : mode === 'void'
      ? 'Employee requested punch void'
      : 'Employee requested time-card review'
  return `${prefix}: ${reason.trim()}`
}

function dateInputValue(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(new Date(value))
}

function timeInputValue(value: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
  }).formatToParts(new Date(value))
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

function zonedDateTimeToIso(dateKey: string, timeValue: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute)
  let guess = targetUtc
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  })

  for (let index = 0; index < 3; index += 1) {
    const parts = formatter.formatToParts(new Date(guess))
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '0'
    const renderedUtc = Date.UTC(
      Number(part('year')),
      Number(part('month')) - 1,
      Number(part('day')),
      Number(part('hour')),
      Number(part('minute')),
    )
    guess += targetUtc - renderedUtc
  }

  return new Date(guess).toISOString()
}

function formatRowWindow(row: TimekeepingReviewRow, activeInProgress = false): string {
  if (row.firstClockIn || row.lastClockOut) {
    const clockIn = row.firstClockIn ? formatOperationalDateTime(row.firstClockIn, { includeTimeZoneName: true }) : 'Missing clock-in'
    const clockOut = row.lastClockOut ? formatOperationalDateTime(row.lastClockOut, { includeTimeZoneName: true }) : activeInProgress ? 'Clocked in now' : 'Missing clock-out'
    return `${clockIn} - ${clockOut}`
  }
  if (row.scheduledStartsAt && row.scheduledEndsAt) return formatDualTimeRange(row.scheduledStartsAt, row.scheduledEndsAt, row.timeZone)
  return 'No punch window recorded yet.'
}

function shiftLocation(shift: TimekeepingShift): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' - ') || 'Location pending'
}

function shiftTitle(shift: TimekeepingShift): string {
  return shift.postName ?? shift.eventName ?? shift.locationName ?? 'Assigned shift'
}

function sumPaidMinutes(rows: TimekeepingReviewRow[]): number {
  return rows.reduce((total, row) => total + row.paidMinutes, 0)
}

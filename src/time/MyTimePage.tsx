import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Coffee,
  FileClock,
  History,
  MapPin,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  activeTimeState,
  getOwnTimekeepingReview,
  getTimekeepingDashboard,
  nextTimeEventKinds,
  payrollHours,
  recordTimeEvent,
  type PendingCorrection,
  type TimeEventKind,
  type TimekeepingDashboard,
  type TimekeepingReviewRow,
  type TimekeepingShift,
  type TimekeepingState,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatDualTimeRange, formatOperationalDateTime } from '../lib/time'
import { currentPayrollPeriod, formatUsDateKey } from './timeRules'
import {
  TimeAlertCard,
  TimeButton,
  TimeEmptyState,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

const actionLabels: Record<TimeEventKind, string> = {
  break_end: 'End break',
  break_start: 'Start break',
  clock_in: 'Clock in',
  clock_out: 'Clock out',
}

const eventLabels: Record<TimeEventKind, string> = {
  break_end: 'Break ended',
  break_start: 'Break started',
  clock_in: 'Clocked in',
  clock_out: 'Clocked out',
}

export function MyTimePage() {
  const queryClient = useQueryClient()
  const punchLocked = useRef(false)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null)
  const defaultPeriod = currentPayrollPeriod()

  const dashboardQuery = useQuery({
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['my-time-dashboard'],
    refetchInterval: 15_000,
  })

  const dashboard = dashboardQuery.data
  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(dashboard?.employee.id),
    queryFn: () => getOwnTimekeepingReview({
      employeeId: dashboard?.employee.id ?? '',
      fromDate: defaultPeriod.fromDate,
      throughDate: defaultPeriod.throughDate,
    }),
    queryKey: ['my-time-review', dashboard?.employee.id, defaultPeriod.fromDate, defaultPeriod.throughDate],
  })

  const reviewPeriod = reviewQuery.data?.payrollRules ? currentPayrollPeriod(undefined, reviewQuery.data.payrollRules) : defaultPeriod
  const rows = useMemo(() => reviewQuery.data?.rows ?? [], [reviewQuery.data?.rows])
  const todayRows = useMemo(
    () => dashboard ? rows.filter((row) => row.operationalDate === dashboard.operationalDate) : [],
    [dashboard, rows],
  )
  const currentShift = dashboard ? activeShift(dashboard) : null
  const state = activeTimeState(dashboard?.lastEvent ?? null)
  const nextKinds = nextTimeEventKinds(state)
  const defaultShiftId = selectedShiftId ?? dashboard?.eligibleShifts[0]?.shiftId ?? null

  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSettled: async () => {
      punchLocked.current = false
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-time-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['my-time-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
      ])
    },
    onSuccess: () => {
      setSelectedShiftId(null)
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

  function record(kind: TimeEventKind) {
    if (punchLocked.current || punchMutation.isPending) return
    punchLocked.current = true
    punchMutation.mutate({
      kind,
      shiftId: kind === 'clock_in' ? defaultShiftId : undefined,
    })
  }

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

  if (dashboardQuery.isPending) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading My Time">
          <p>Loading your clock status, assigned shifts, recent punches, and pay-period summary.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (dashboardQuery.isError || !dashboard) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={ShieldAlert} title="My Time unavailable" tone="error">
          <p>{dashboardQuery.error?.message ?? 'Your time dashboard could not be loaded.'}</p>
        </DataStatePanel>
      </main>
    )
  }

  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={
          <>
            <Link className="time-button time-button--secondary" to="/time"><ArrowRight aria-hidden="true" size={18} /><span>Time Command Center</span></Link>
            <Link className="time-button time-button--secondary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Advanced Time Tools</span></Link>
          </>
        }
        eyebrow="My Time"
        summary="A simple place to see your clock status, current pay period, recent punches, and any correction items tied to your time."
        title="My Time"
      />

      {reviewQuery.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Pay-period details could not be loaded" tone="warning">
          <p>Your live clock status is still shown. Advanced review details may require account access to be refreshed.</p>
        </TimeAlertCard>
      ) : null}

      {punchMutation.isError ? (
        <TimeAlertCard icon={CircleAlert} title="The punch could not be recorded" tone="danger">
          <p>{punchMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}

      <section className="my-time-dashboard-grid">
        <ClockStatusPanel
          currentShift={currentShift}
          dashboard={dashboard}
          nextKinds={nextKinds}
          onPunch={record}
          pending={punchMutation.isPending}
          selectedShiftId={selectedShiftId}
          setSelectedShiftId={setSelectedShiftId}
          state={state}
        />
        <section className="time-card my-time-summary-card">
          <TimeSectionHeader
            eyebrow="Current pay period"
            summary={`${formatUsDateKey(reviewPeriod.fromDate)} - ${formatUsDateKey(reviewPeriod.throughDate)}`}
            title="Your Hours"
          />
          <div className="time-command-grid my-time-summary-card__metrics" aria-busy={reviewQuery.isPending}>
            <TimeMetricCard detail="Paid time recorded today." icon={Clock3} label="Today" value={`${payrollHours(totals.today)} hrs`} />
            <TimeMetricCard detail="Paid time for the current week." icon={CalendarDays} label="This Week" value={`${payrollHours(totals.week)} hrs`} />
            <TimeMetricCard detail="Paid time in the current pay period." icon={FileClock} label="Pay Period" value={`${payrollHours(totals.payPeriod)} hrs`} />
            <TimeMetricCard
              detail="Correction requests waiting for review."
              icon={AlertTriangle}
              label="Corrections"
              tone={totals.pendingCorrections > 0 ? 'warning' : 'good'}
              value={totals.pendingCorrections}
            />
          </div>
        </section>
      </section>

      <section className="my-time-two-column">
        <RecentPunchesPanel dashboard={dashboard} />
        <CorrectionPanel corrections={reviewQuery.data?.pendingCorrections ?? []} loading={reviewQuery.isPending} />
      </section>

      <MyTimeRows loading={reviewQuery.isPending} rows={rows} />
    </main>
  )
}

function ClockStatusPanel({
  currentShift,
  dashboard,
  nextKinds,
  onPunch,
  pending,
  selectedShiftId,
  setSelectedShiftId,
  state,
}: {
  currentShift: TimekeepingShift | null
  dashboard: TimekeepingDashboard
  nextKinds: TimeEventKind[]
  onPunch: (kind: TimeEventKind) => void
  pending: boolean
  selectedShiftId: string | null
  setSelectedShiftId: (value: string | null) => void
  state: TimekeepingState
}) {
  const clockInMode = state === 'off_clock'

  return (
    <section className={`time-clock-card time-clock-card--${state}`}>
      <div className="time-clock-card__header">
        <div>
          <p className="eyebrow">Clock status</p>
          <h2>{statusTitle(state)}</h2>
          <p>{stateCopy(state)}</p>
        </div>
        <TimeStatusBadge tone={state === 'off_clock' ? 'neutral' : 'good'}>{state.replace('_', ' ')}</TimeStatusBadge>
      </div>

      {currentShift ? (
        <article className="active-shift-card">
          <MapPin aria-hidden="true" size={22} />
          <div>
            <strong>{shiftTitle(currentShift)}</strong>
            <span>{shiftLocation(currentShift)} - {formatDualTimeRange(currentShift.startsAt, currentShift.endsAt, currentShift.timeZone)}</span>
          </div>
        </article>
      ) : null}

      {clockInMode ? (
        <fieldset className="time-shift-list">
          <legend>Clock into</legend>
          {dashboard.eligibleShifts.length > 0 ? dashboard.eligibleShifts.map((shift) => {
            const checked = selectedShiftId === shift.shiftId || (!selectedShiftId && dashboard.eligibleShifts[0]?.shiftId === shift.shiftId)
            return (
              <label className={`time-shift-option${checked ? ' time-shift-option--selected' : ''}`} key={shift.assignmentId}>
                <input
                  checked={checked}
                  disabled={pending}
                  name="my-time-shift"
                  onChange={() => setSelectedShiftId(shift.shiftId)}
                  type="radio"
                />
                <span>
                  <strong>{shiftTitle(shift)}</strong>
                  <small>{shiftLocation(shift)}</small>
                  <em>{formatDualTimeRange(shift.startsAt, shift.endsAt, shift.timeZone)}</em>
                </span>
                {shift.requiresArmed ? <b>Armed</b> : null}
                {shift.isOvertime ? <b>OT</b> : null}
              </label>
            )
          }) : (
            <article className="time-shift-empty">
              <AlertTriangle aria-hidden="true" size={21} />
              <div>
                <strong>No assigned shift is currently available.</strong>
                <p>If you clock in anyway, it will be recorded as unscheduled time for supervisor review.</p>
              </div>
            </article>
          )}
        </fieldset>
      ) : null}

      <div className="time-action-row">
        {nextKinds.map((kind) => (
          <TimeButton
            icon={kind === 'break_start' || kind === 'break_end' ? Coffee : Timer}
            key={kind}
            loading={pending}
            onClick={() => onPunch(kind)}
            variant={kind === 'clock_out' ? 'danger' : 'primary'}
          >
            {actionLabels[kind]}
          </TimeButton>
        ))}
      </div>

      <small className="my-time-official-note">Official time is recorded by the secure server. The page refreshes after each saved punch.</small>
    </section>
  )
}

function RecentPunchesPanel({ dashboard }: { dashboard: TimekeepingDashboard }) {
  return (
    <section className="time-card">
      <TimeSectionHeader
        eyebrow="Recent activity"
        summary={`Updated ${formatOperationalDateTime(dashboard.serverTimestamp, { includeTimeZoneName: true })}`}
        title="Recent Punches"
      />
      {dashboard.recentEvents.length > 0 ? (
        <ul className="time-event-list">
          {dashboard.recentEvents.slice(0, 6).map((event) => (
            <li className={`time-event${event.voided ? ' time-event--voided' : ''}`} key={event.id}>
              <span><History aria-hidden="true" size={18} /></span>
              <div>
                <strong>{eventLabels[event.kind]}</strong>
                <small>{formatOperationalDateTime(event.effectiveAt ?? event.recordedAt, { includeTimeZoneName: true })}</small>
              </div>
              {event.voided ? <em>Voided</em> : null}
            </li>
          ))}
        </ul>
      ) : (
        <TimeEmptyState icon={History} title="No recent punches">
          <p>Your recent clock activity will appear here after time is recorded.</p>
        </TimeEmptyState>
      )}
    </section>
  )
}

function CorrectionPanel({
  corrections,
  loading,
}: {
  corrections: PendingCorrection[]
  loading: boolean
}) {
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
      ) : corrections.length > 0 ? (
        <div className="my-time-correction-list">
          {corrections.map((correction) => (
            <article className="my-time-correction-card" key={correction.id}>
              <TimeStatusBadge tone="warning">Pending</TimeStatusBadge>
              <strong>{eventLabels[correction.kind]}</strong>
              <span>{formatOperationalDateTime(correction.replacementTime ?? correction.recordedAt, { includeTimeZoneName: true })}</span>
              <p>{correction.reason}</p>
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

function MyTimeRows({
  loading,
  rows,
}: {
  loading: boolean
  rows: TimekeepingReviewRow[]
}) {
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
            <article className="my-time-row" key={`${row.rowKind}-${row.employeeId}-${row.operationalDate}-${row.shiftId ?? row.locationName}`}>
              <div className="my-time-row__date">
                <strong>{formatUsDateKey(row.operationalDate)}</strong>
                <span>{row.rowKind === 'salary_default' ? 'Salary default' : 'Time clock'}</span>
              </div>
              <div>
                <strong>{row.locationName}</strong>
                <span>{[row.siteCode, row.siteName, row.postName, row.eventName].filter(Boolean).join(' - ') || 'Location pending'}</span>
                <small>{formatRowWindow(row)}</small>
              </div>
              <div className="my-time-row__hours">
                <strong>{payrollHours(row.paidMinutes)} hrs</strong>
                <span>{row.breakMinutes} unpaid break min</span>
              </div>
              <div className="my-time-row__status">
                <TimeStatusBadge tone={row.payrollReady ? 'good' : 'warning'}>{row.payrollReady ? 'Ready' : 'Needs review'}</TimeStatusBadge>
                {row.exceptionCodes.length > 0 ? <small>{row.exceptionCodes.join(', ')}</small> : null}
              </div>
            </article>
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

function activeShift(dashboard: TimekeepingDashboard): TimekeepingShift | null {
  const activeShiftId = dashboard.lastEvent?.shiftId
  if (!activeShiftId) return null
  return dashboard.eligibleShifts.find((shift) => shift.shiftId === activeShiftId) ?? null
}

function formatRowWindow(row: TimekeepingReviewRow): string {
  if (row.firstClockIn || row.lastClockOut) {
    const clockIn = row.firstClockIn ? formatOperationalDateTime(row.firstClockIn, { includeTimeZoneName: true }) : 'Missing clock-in'
    const clockOut = row.lastClockOut ? formatOperationalDateTime(row.lastClockOut, { includeTimeZoneName: true }) : 'Missing clock-out'
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

function stateCopy(state: TimekeepingState): string {
  if (state === 'working') return 'You are clocked in. Start a break or clock out when your work status changes.'
  if (state === 'on_break') return 'You are on break. End the break before clocking out so unpaid break time is calculated correctly.'
  return 'You are currently off the clock. Choose the correct assigned shift when available.'
}

function statusTitle(state: TimekeepingState): string {
  if (state === 'working') return 'Clocked in'
  if (state === 'on_break') return 'On break'
  return 'Off the clock'
}

function sumPaidMinutes(rows: TimekeepingReviewRow[]): number {
  return rows.reduce((total, row) => total + row.paidMinutes, 0)
}

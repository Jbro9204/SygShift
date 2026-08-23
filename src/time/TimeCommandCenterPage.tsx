import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileClock,
  History,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  Timer,
  UserRoundCheck,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import {
  getTeamAttendanceSummary,
  getOwnTimekeepingReview,
  getPayrollExportHistory,
  getPayrollRules,
  getTimekeepingDashboard,
  getTimekeepingReview,
  payrollHours,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { buildTimeCommandCenterModel, canExportPayroll, canViewTeamTime } from './timeCommandCenter'
import { canUseOwnTimeClock, canViewAccountability, canViewAttendanceReview, canViewOwnTime } from './timePermissions'
import { currentPayrollPeriod, formatUsDateKey } from './timeRules'
import {
  TimeAlertCard,
  TimeEmptyState,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

export function TimeCommandCenterPage() {
  const sessionQuery = useQuery({
    queryKey: ['session-context'],
    queryFn: getSessionContext,
    enabled: isSupabaseConfigured,
  })
  const ownTimeAllowed = canViewOwnTime(sessionQuery.data)
  const punchAllowed = canUseOwnTimeClock(sessionQuery.data)
  const dashboardQuery = useQuery({
    queryKey: ['time-command-dashboard'],
    queryFn: () => getTimekeepingDashboard(),
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    refetchInterval: 15_000,
  })
  const rulesQuery = useQuery({
    enabled: isSupabaseConfigured && canViewTeamTime(sessionQuery.data),
    queryKey: ['time-command-rules'],
    queryFn: getPayrollRules,
  })
  const fallbackPeriod = currentPayrollPeriod()
  const activePeriod = currentPayrollPeriod(undefined, rulesQuery.data)
  const fromDate = activePeriod.fromDate || fallbackPeriod.fromDate
  const throughDate = activePeriod.throughDate || fallbackPeriod.throughDate
  const teamAllowed = canViewTeamTime(sessionQuery.data)
  const payrollAllowed = canExportPayroll(sessionQuery.data)
  const attendanceReviewAllowed = canViewAttendanceReview(sessionQuery.data)
  const accountabilityAllowed = canViewAccountability(sessionQuery.data)

  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(dashboardQuery.data),
    queryKey: ['time-command-review', teamAllowed ? 'team' : 'self', dashboardQuery.data?.employee.id, fromDate, throughDate],
    queryFn: () => {
      if (teamAllowed) return getTimekeepingReview({ fromDate, throughDate })
      return getOwnTimekeepingReview({
        employeeId: dashboardQuery.data?.employee.id ?? '',
        fromDate,
        throughDate,
      })
    },
  })
  const attendanceSummaryQuery = useQuery({
    enabled: isSupabaseConfigured && teamAllowed,
    queryKey: ['time-command-attendance-summary', fromDate, throughDate],
    queryFn: () => getTeamAttendanceSummary({ fromDate, throughDate }),
    refetchInterval: 30_000,
  })
  const exportHistoryQuery = useQuery({
    enabled: isSupabaseConfigured && payrollAllowed,
    queryKey: ['time-command-export-history'],
    queryFn: () => getPayrollExportHistory(10),
  })

  if (!isSupabaseConfigured) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader
          eyebrow="SygShift Time"
          summary="The Time module is ready for the secure database connection. Existing punch workflows are preserved."
          title="Time Command Center"
        />
        <TimeEmptyState icon={ShieldAlert} title="Secure time data is not connected">
          <p>Connect Supabase before live punches, payroll readiness, or command-center metrics can load.</p>
        </TimeEmptyState>
      </main>
    )
  }

  if (sessionQuery.isPending || (ownTimeAllowed && dashboardQuery.isPending)) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading SygShift Time">
          <p>Building your Time Command Center from current punch, review, and payroll data.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isError || !ownTimeAllowed) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={ShieldAlert} title="Time & Attendance is not enabled" tone="error">
          <p>Your account does not currently have Time & Attendance access. Ask an admin to add time.self.view or time.punch if this is incorrect.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (dashboardQuery.isError) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={ShieldAlert} title="Time Command Center unavailable" tone="error">
          <p>{dashboardQuery.error.message}</p>
        </DataStatePanel>
      </main>
    )
  }

  const dashboard = dashboardQuery.data
  if (!dashboard) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading SygShift Time">
          <p>Waiting for your current clock and schedule data to finish loading.</p>
        </DataStatePanel>
      </main>
    )
  }

  const model = buildTimeCommandCenterModel({
    attendanceSummary: attendanceSummaryQuery.data,
    dashboard,
    exportHistory: exportHistoryQuery.data,
    payrollRules: rulesQuery.data,
    review: reviewQuery.data,
    session: sessionQuery.data,
  })
  const loadingMetrics = reviewQuery.isPending || (teamAllowed && attendanceSummaryQuery.isPending)
  const partialError = reviewQuery.isError || attendanceSummaryQuery.isError || rulesQuery.isError || exportHistoryQuery.isError
  const employeeView = model.roleMode === 'employee' || model.roleMode === 'salary'

  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={
          <>
            <Link className="time-button time-button--secondary" to="/time/my-time"><UserRoundCheck aria-hidden="true" size={18} /><span>My Time</span></Link>
            {punchAllowed ? <Link className="time-button time-button--primary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Time Maintenance</span></Link> : null}
          </>
        }
        eyebrow="SygShift Time"
        summary="A calm command center for clock status, exceptions, payroll readiness, and time maintenance."
        title="Time Command Center"
      />

      {partialError ? (
        <TimeAlertCard icon={AlertTriangle} title="Some time data could not be loaded" tone="warning">
          <p>The page is showing the safe data that loaded successfully. Open Time Maintenance if you need to work a record directly.</p>
        </TimeAlertCard>
      ) : null}

      <section className="time-command-grid time-command-grid--period" aria-label="Current pay period">
        <article className="time-card time-period-card">
          <div>
            <p className="eyebrow">Current Pay Period</p>
            <h2>{formatUsDateKey(model.period.fromDate)} – {formatUsDateKey(model.period.throughDate)}</h2>
            <p>{model.period.daysRemaining} day{model.period.daysRemaining === 1 ? '' : 's'} remaining. Payroll rules use {rulesQuery.data?.weekStartsOnLabel ?? 'Sunday'} through Saturday.</p>
          </div>
          <TimeStatusBadge tone={model.period.status === 'exported' ? 'good' : 'neutral'}>{model.period.status}</TimeStatusBadge>
        </article>
        <article className="time-card time-period-card">
          <div>
            <p className="eyebrow">Your Clock Status</p>
            <h2>{statusTitle(model.self.clockState)}</h2>
            <p>{model.self.displayName} · {model.self.employmentType} employee · Updated {formatOperationalDateTime(dashboard.serverTimestamp)}</p>
          </div>
          <TimeStatusBadge tone={model.self.clockState === 'off_clock' ? 'neutral' : 'good'}>{model.self.clockState.replace('_', ' ')}</TimeStatusBadge>
        </article>
      </section>

      {employeeView ? (
        <EmployeeTimeOverview model={model} loadingMetrics={loadingMetrics} punchAllowed={punchAllowed} />
      ) : (
        <OperationsTimeOverview
          attendanceReviewAllowed={attendanceReviewAllowed}
          accountabilityAllowed={accountabilityAllowed}
          model={model}
          loadingMetrics={loadingMetrics}
          payrollAllowed={payrollAllowed}
          teamAllowed={teamAllowed}
        />
      )}
    </main>
  )
}

function EmployeeTimeOverview({
  loadingMetrics,
  model,
  punchAllowed,
}: {
  loadingMetrics: boolean
  model: ReturnType<typeof buildTimeCommandCenterModel>
  punchAllowed: boolean
}) {
  return (
    <>
      <TimeSectionHeader
        eyebrow="Employee view"
        summary="Only your own time, corrections, and pay-period summary are shown here."
        title="My Time Snapshot"
      />
      <section className="time-command-grid" aria-busy={loadingMetrics}>
        <TimeMetricCard detail="Paid time recorded for today." icon={Clock3} label="Today" to="/time/my-time" value={`${payrollHours(model.self.todayPaidMinutes)} hrs`} />
        <TimeMetricCard detail="Current workweek total from reviewed rows." icon={CalendarDays} label="This Week" to="/time/my-time" value={`${payrollHours(model.self.weeklyPaidMinutes)} hrs`} />
        <TimeMetricCard detail="Current pay-period total from your rows." icon={FileClock} label="Pay Period" to="/time/my-time" value={`${payrollHours(model.self.payPeriodPaidMinutes)} hrs`} />
        <TimeMetricCard
          detail="Correction requests tied to your time records."
          icon={AlertTriangle}
          label="Needs Review"
          tone={model.self.pendingCorrections > 0 ? 'warning' : 'good'}
          to="/time/my-time"
          value={model.self.pendingCorrections}
        />
      </section>
      <section className="time-action-panel">
        <TimeSectionHeader title="What you can do next" summary="Keep it simple: check your hours or open Time Maintenance if you need to clock in, clock out, or review details." />
        <div className="time-action-panel__actions">
          {punchAllowed ? <Link className="time-button time-button--primary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Clock / Review My Time</span></Link> : null}
          <Link className="time-button time-button--secondary" to="/time/my-time"><ArrowRight aria-hidden="true" size={18} /><span>Open My Time</span></Link>
          <Link className="time-button time-button--secondary" to="/time/operations"><FileClock aria-hidden="true" size={18} /><span>Request Time Change</span></Link>
        </div>
      </section>
    </>
  )
}

function OperationsTimeOverview({
  accountabilityAllowed,
  attendanceReviewAllowed,
  loadingMetrics,
  model,
  payrollAllowed,
  teamAllowed,
}: {
  accountabilityAllowed: boolean
  attendanceReviewAllowed: boolean
  loadingMetrics: boolean
  model: ReturnType<typeof buildTimeCommandCenterModel>
  payrollAllowed: boolean
  teamAllowed: boolean
}) {
  return (
    <>
      <TimeSectionHeader
        eyebrow="Operations view"
        summary="Summary cards show what needs attention without turning the command center into a giant editable table."
        title="Payroll and Attendance Readiness"
      />
      <section className="time-command-grid" aria-busy={loadingMetrics}>
        <TimeMetricCard
          detail={model.payrollReadiness.percent === null ? 'No review rows are available yet.' : `${model.payrollReadiness.ready} of ${model.payrollReadiness.total} rows ready.`}
          icon={CheckCircle2}
          label="Payroll Ready"
          tone={model.payrollReadiness.blocked > 0 ? 'warning' : 'good'}
          to={payrollAllowed ? '/time/payroll' : undefined}
          value={model.payrollReadiness.percent === null ? 'Not ready' : `${model.payrollReadiness.percent}%`}
        />
        <TimeMetricCard
          detail={`${model.exceptions.highPriority} high priority · ${model.exceptions.adminAction} admin action.`}
          icon={AlertTriangle}
          label="Exceptions"
          tone={model.exceptions.total > 0 ? 'warning' : 'good'}
          to={teamAllowed ? '/time/exceptions' : undefined}
          value={model.exceptions.total}
        />
        <TimeMetricCard
          detail={`${model.clockedIn.atScheduledLocation} scheduled · ${model.clockedIn.atUnexpectedLocation} unexpected${model.clockedIn.longShiftCount > 0 ? ` · ${model.clockedIn.longShiftCount} over 14h` : ''}.`}
          icon={Timer}
          label="Clocked In Now"
          tone={model.clockedIn.atUnexpectedLocation > 0 || model.clockedIn.longShiftCount > 0 ? 'warning' : 'neutral'}
          to={teamAllowed ? '/time/team?status=working' : undefined}
          value={teamAllowed ? model.clockedIn.count : 'Self only'}
        />
        <TimeMetricCard
          detail={`${model.missingPunches.correctionsAwaitingReview} corrections awaiting review.`}
          icon={FileClock}
          label="Missing Punches"
          tone={model.missingPunches.incompleteShifts > 0 ? 'danger' : 'good'}
          to={teamAllowed ? '/time/exceptions?show=missing_punches' : undefined}
          value={model.missingPunches.incompleteShifts}
        />
        <TimeMetricCard
          detail={`${model.overtimeRisk.approachingDaily} daily risk · ${model.overtimeRisk.approachingWeekly} weekly risk.`}
          icon={History}
          label="Overtime Risk"
          tone={model.overtimeRisk.alreadyInOvertime > 0 ? 'warning' : 'neutral'}
          to={teamAllowed ? '/time/team' : undefined}
          value={model.overtimeRisk.alreadyInOvertime}
        />
        <TimeMetricCard
          detail="Export status comes from locked payroll export history."
          icon={LockKeyhole}
          label="Payroll Lock"
          tone={model.period.status === 'exported' ? 'good' : 'neutral'}
          to={payrollAllowed ? '/time/payroll' : undefined}
          value={model.period.status === 'exported' ? 'Exported' : 'Open'}
        />
      </section>

      <section className="time-action-panel">
        <TimeSectionHeader title="Quick actions" summary="Actions are shown only when your role or permissions allow them." />
        <div className="time-action-panel__actions">
          <Link className="time-button time-button--primary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Open Time Maintenance</span></Link>
          {teamAllowed ? <Link className="time-button time-button--secondary" to="/time/team"><UserRoundCheck aria-hidden="true" size={18} /><span>Team Attendance</span></Link> : null}
          {attendanceReviewAllowed ? <Link className="time-button time-button--secondary" to="/time/daily-review"><ClipboardCheck aria-hidden="true" size={18} /><span>Daily Attendance Review</span></Link> : null}
          {accountabilityAllowed ? <Link className="time-button time-button--secondary" to="/time/accountability"><ShieldCheck aria-hidden="true" size={18} /><span>Accountability Tracker</span></Link> : null}
          {teamAllowed ? <Link className="time-button time-button--secondary" to="/time/exceptions"><AlertTriangle aria-hidden="true" size={18} /><span>Review Exceptions</span></Link> : null}
          {teamAllowed ? <Link className="time-button time-button--secondary" to="/time/operations"><ClipboardCheck aria-hidden="true" size={18} /><span>Time Operations</span></Link> : null}
          {payrollAllowed ? <Link className="time-button time-button--secondary" to="/time/payroll"><FileClock aria-hidden="true" size={18} /><span>Payroll</span></Link> : null}
        </div>
      </section>
    </>
  )
}

function statusTitle(status: 'off_clock' | 'working' | 'on_break'): string {
  if (status === 'working') return 'Clocked in'
  if (status === 'on_break') return 'On break'
  return 'Off the clock'
}

export function TimeFuturePage({ area }: { area: 'My Time' | 'Team Attendance' | 'Exceptions' | 'Timecards' | 'Payroll' | 'Time Rules' }) {
  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={<Link className="time-button time-button--secondary" to="/time"><ArrowRight aria-hidden="true" size={18} /><span>Back to Time Command Center</span></Link>}
        eyebrow="SygShift Time"
        summary="This area is intentionally reserved for the next dedicated build phase. The current production tools remain available."
        title={area}
      />
      <TimeAlertCard icon={ShieldAlert} title={`${area} is staged for a future phase`} tone="neutral">
        <p>Phase 1 created the structure without pretending this screen is finished. Use Time Maintenance until this dedicated area is built and validated.</p>
      </TimeAlertCard>
      <div className="time-action-panel__actions">
        <Link className="time-button time-button--primary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Open Time Maintenance</span></Link>
      </div>
    </main>
  )
}

import {
  ArrowRight,
  CalendarDays,
  ClipboardCheck,
  Coffee,
  DatabaseZap,
  Clock3,
  FileClock,
  Megaphone,
  Timer,
  TimerReset,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { getSessionContext } from '../data/auth'
import { getActiveAnnouncementBanners } from '../data/announcements'
import { getOverviewMetrics, overviewMetricNote, type OverviewMetrics } from '../data/overview'
import {
  activeTimeState,
  getClockableShiftChoices,
  getTimekeepingDashboard,
  recordTimeEvent,
  type TimeEventKind,
  type TimekeepingDashboard,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { canUseOwnTimeClock, canViewOwnTime, canViewTeamTime } from '../time/timePermissions'
import { applyTimeEventToCachedDashboards, refreshTimekeepingQueriesAfterPunch } from '../time/timeQuerySync'

const metrics: Array<{ label: string, key: keyof OverviewMetrics, icon: typeof UsersRound }> = [
  { label: 'On duty now', key: 'onDutyNow', icon: UsersRound },
  { label: 'Open shifts', key: 'openShifts', icon: CalendarDays },
  { label: 'Pending requests', key: 'pendingRequests', icon: ClipboardCheck },
  { label: 'Clock exceptions', key: 'clockExceptions', icon: TimerReset },
]

function overviewTimeAction(dashboard: TimekeepingDashboard | undefined): {
  kind: TimeEventKind | null
  label: string
  requiresTimePage: boolean
} {
  if (!dashboard) return { kind: null, label: 'Open time clock', requiresTimePage: true }

  const state = activeTimeState(dashboard.lastEvent)
  if (state === 'working') return { kind: 'clock_out', label: 'Clock out', requiresTimePage: false }
  if (state === 'on_break') return { kind: 'break_end', label: 'End break', requiresTimePage: false }
  const clockableChoices = getClockableShiftChoices(dashboard.eligibleShifts, dashboard.serverTimestamp)
  if (clockableChoices.shifts.length > 1) return { kind: null, label: 'Choose shift to clock in', requiresTimePage: true }
  return { kind: 'clock_in', label: 'Clock in', requiresTimePage: false }
}

export function OverviewPage() {
  const queryClient = useQueryClient()
  const punchLocked = useRef(false)
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const role = sessionQuery.data?.role
  const operationsOverviewAllowed = Boolean(
    sessionQuery.data
    && (
      role === 'admin'
      || role === 'supervisor'
      || role === 'scheduler'
      || role === 'dispatcher'
      || canViewTeamTime(sessionQuery.data)
    ),
  )
  const employeeLanding = sessionQuery.isSuccess && !operationsOverviewAllowed
  const overviewQuery = useQuery({
    queryKey: ['overview-metrics'],
    queryFn: () => getOverviewMetrics(),
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && operationsOverviewAllowed,
    refetchInterval: 60_000,
  })
  const employeeAnnouncementQuery = useQuery({
    enabled: isSupabaseConfigured && employeeLanding,
    queryFn: getActiveAnnouncementBanners,
    queryKey: ['active-announcement-banners', 'overview'],
    refetchInterval: 60_000,
    retry: false,
  })
  const ownTimeAllowed = canViewOwnTime(sessionQuery.data)
  const punchAllowed = canUseOwnTimeClock(sessionQuery.data)
  const timekeepingQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['timekeeping-dashboard', 'overview'],
    refetchInterval: 15_000,
    retry: false,
  })
  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSuccess: (event) => {
      applyTimeEventToCachedDashboards(queryClient, event)
    },
    onSettled: async () => {
      punchLocked.current = false
      await refreshTimekeepingQueriesAfterPunch(queryClient)
    },
  })
  const overview = overviewQuery.data
  const timeAction = overviewTimeAction(timekeepingQuery.data)

  function quickPunch(kind = timeAction.kind) {
    if (!kind || !timekeepingQuery.data) return
    if (!punchAllowed || punchLocked.current || punchMutation.isPending) return
    punchLocked.current = true
    const clockableChoices = getClockableShiftChoices(timekeepingQuery.data.eligibleShifts, timekeepingQuery.data.serverTimestamp)
    const shiftId = kind === 'clock_in'
      ? clockableChoices.shifts[0]?.shiftId ?? null
      : undefined
    punchMutation.mutate({ kind, shiftId })
  }

  const timeState = activeTimeState(timekeepingQuery.data?.lastEvent ?? null)
  const breakAction: { kind: TimeEventKind; label: string } | null = timeState === 'working'
    ? { kind: 'break_start', label: 'Start break' }
    : null
  const activeShift = timekeepingQuery.data?.eligibleShifts.find((shift) => shift.shiftId === timekeepingQuery.data?.lastEvent?.shiftId) ?? null
  const nextShift = activeShift ?? timekeepingQuery.data?.eligibleShifts
    .filter((shift) => new Date(shift.endsAt).getTime() >= new Date(timekeepingQuery.data?.serverTimestamp ?? Date.now()).getTime())
    .sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime())[0] ?? null

  return (
    <div className="page page--overview">
      <section className="page-intro">
        <div>
          <p className="eyebrow">{employeeLanding ? 'My dashboard' : 'Operations home'}</p>
          <h1>{employeeLanding ? 'Your shift day, simple.' : 'One clear view of the day.'}</h1>
          <p className="page-summary">
            {employeeLanding
              ? 'Clock in, manage breaks, check your schedule, and request time-card help without digging through operations data.'
              : 'Coverage, requests, timekeeping, and events stay connected without making the schedule harder to read.'}
          </p>
        </div>
        <div className="overview-intro-actions">
          <div className="overview-time-actions" role="group" aria-label="Quick time actions">
            {ownTimeAllowed && timeAction.requiresTimePage ? (
              <Link className="primary-action overview-clock-action" to="/time/my-time">
                <Timer aria-hidden="true" size={19} />
                {timeAction.label}
              </Link>
            ) : ownTimeAllowed && punchAllowed ? (
              <button
                className={`primary-action overview-clock-action${timeAction.kind === 'clock_out' ? ' overview-clock-action--danger' : ''}`}
                disabled={punchMutation.isPending || timekeepingQuery.isPending || (timeState === 'on_break' && timeAction.kind === 'clock_out')}
                onClick={() => quickPunch(timeAction.kind)}
                type="button"
              >
                <Timer aria-hidden="true" size={19} />
                {punchMutation.isPending && timeAction.kind !== 'break_start' && timeAction.kind !== 'break_end' ? 'Recording...' : timeAction.label}
              </button>
            ) : null}
            {breakAction && punchAllowed ? (
              <button
                className="secondary-button overview-break-action"
                disabled={punchMutation.isPending || timekeepingQuery.isPending}
                onClick={() => quickPunch(breakAction.kind)}
                type="button"
              >
                <Coffee aria-hidden="true" size={18} />
                {punchMutation.isPending ? 'Recording...' : breakAction.label}
              </button>
            ) : null}
          </div>
          <Link className="secondary-button overview-schedule-action" to="/schedule">
            Schedule
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
      </section>

      {punchMutation.isError ? (
        <div className="inline-alert" role="alert">{punchMutation.error.message}</div>
      ) : null}

      {overviewQuery.isError && operationsOverviewAllowed ? (
        <div className="inline-alert" role="alert">{overviewQuery.error.message}</div>
      ) : null}

      {timekeepingQuery.data ? (
        <section className="overview-time-card" aria-label="Quick time clock">
          <Clock3 aria-hidden="true" size={22} />
          <div>
            <strong>
              {activeTimeState(timekeepingQuery.data.lastEvent) === 'off_clock'
                ? 'You are off the clock'
                : activeTimeState(timekeepingQuery.data.lastEvent) === 'on_break'
                  ? 'You are on break'
                  : 'You are clocked in'}
            </strong>
            <span>Official time is recorded by the secure server. Full time tools remain under Time & Attendance.</span>
          </div>
        </section>
      ) : null}

      {ownTimeAllowed ? (
        <section className="overview-call-off-panel" aria-labelledby="overview-call-off-title">
          <div className="overview-call-off-panel__icon">
            <ClipboardCheck aria-hidden="true" size={24} />
          </div>
          <div className="overview-call-off-panel__copy">
            <p className="eyebrow">Need immediate coverage help?</p>
            <h2 id="overview-call-off-title">Can’t work your shift?</h2>
            <p>Report sickness or another call-off now. Dispatch is notified immediately, and your shift stays assigned until coverage is approved.</p>
          </div>
          <Link className="overview-call-off-action" to="/time/my-time?report=call-off">
            Report Sick / Call-Off
            <ArrowRight aria-hidden="true" size={19} />
          </Link>
        </section>
      ) : null}

      {employeeLanding ? (
        <section className="overview-employee-grid" aria-label="Employee dashboard">
          <article className="overview-employee-card overview-employee-card--primary">
            <div className="overview-employee-card__icon"><UserRoundCheck aria-hidden="true" size={24} /></div>
            <div className="overview-employee-card__copy">
              <p className="eyebrow">Next shift</p>
              <h2>{nextShift ? shiftTitle(nextShift) : 'No immediate shift shown'}</h2>
              <p>
                {nextShift
                  ? `${shiftLocation(nextShift)} - ${formatShiftTime(nextShift.startsAt, nextShift.endsAt, nextShift.timeZone)}`
                  : 'Open Schedule to review your upcoming work.'}
              </p>
            </div>
            <div className="overview-employee-card__actions">
              <Link className="secondary-button" to="/schedule">Open Schedule</Link>
            </div>
          </article>
          <article className="overview-employee-card">
            <div className="overview-employee-card__icon"><FileClock aria-hidden="true" size={24} /></div>
            <div className="overview-employee-card__copy">
              <p className="eyebrow">Time card</p>
              <h2>{timekeepingQuery.data?.pendingCorrectionCount ? `${timekeepingQuery.data.pendingCorrectionCount} pending request${timekeepingQuery.data.pendingCorrectionCount === 1 ? '' : 's'}` : 'No pending requests'}</h2>
              <p>Review punches, breaks, and request a correction if something looks wrong.</p>
            </div>
            <div className="overview-employee-card__actions">
              <Link className="secondary-button" to="/time/my-time">Open My Time</Link>
              <Link className="secondary-button" to="/time/operations">Request Time Change</Link>
            </div>
          </article>
          <article className="overview-employee-card">
            <div className="overview-employee-card__icon"><ClipboardCheck aria-hidden="true" size={24} /></div>
            <div className="overview-employee-card__copy">
              <p className="eyebrow">Requests</p>
              <h2>Time off and shift pool</h2>
              <p>Request time off, report a call-off, or review open shifts from clear employee tools.</p>
            </div>
            <div className="overview-employee-card__actions">
              <Link className="secondary-button" to="/requests">Time-Off Requests</Link>
              <Link className="secondary-button" to="/events">Shift Pool</Link>
            </div>
          </article>
          <article className="overview-employee-card overview-employee-card--updates">
            <div className="overview-employee-card__icon"><Megaphone aria-hidden="true" size={24} /></div>
            <div className="overview-employee-card__copy">
              <p className="eyebrow">Updates</p>
              <h2>Announcements</h2>
              <p>Current messages, open coverage notices, and company updates stay here so they are easy to find.</p>
            </div>
            {employeeAnnouncementQuery.isPending ? (
              <p className="overview-employee-updates__empty">Checking for current updates...</p>
            ) : employeeAnnouncementQuery.data?.length ? (
              <div className="overview-employee-updates" aria-label="Current announcements">
                {employeeAnnouncementQuery.data.slice(0, 3).map((banner) => (
                  <article className={`overview-employee-update overview-employee-update--${banner.tone}`} key={banner.id}>
                    <strong>{banner.title}</strong>
                    <span>{banner.message}</span>
                    {banner.ctaHref && banner.ctaLabel ? (
                      <Link to={banner.ctaHref}>{banner.ctaLabel}</Link>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="overview-employee-updates__empty">No active announcements right now.</p>
            )}
          </article>
        </section>
      ) : (
        <>
          <section className="connection-banner" aria-labelledby="connection-title">
        <div className="connection-icon">
          <DatabaseZap aria-hidden="true" size={24} />
        </div>
        <div>
          <h2 id="connection-title">
            {isSupabaseConfigured ? 'Secure data connection configured' : 'Protected setup in progress'}
          </h2>
          <p>
            {isSupabaseConfigured
              ? 'The application is using protected authentication, operational schedule data, and exact source reconciliation safeguards.'
              : 'No employee or schedule information will appear until the protected database is connected.'}
          </p>
        </div>
        <span className="status-pill">{isSupabaseConfigured ? 'Connected' : 'No data loaded'}</span>
      </section>

      <section aria-label="Operational totals" className="metric-grid">
        {metrics.map((metric) => {
          const Icon = metric.icon
          const value = overview?.[metric.key] ?? null
          return (
            <article className="metric" key={metric.label}>
              <div className="metric-heading">
                <span>{metric.label}</span>
                <Icon aria-hidden="true" size={21} />
              </div>
              <strong aria-label={`${metric.label}: ${value ?? 'not available'}`}>
                {overviewQuery.isPending && isSupabaseConfigured ? '…' : value ?? '—'}
              </strong>
              <p>{overviewMetricNote(metric.key, value)}</p>
            </article>
          )
        })}
      </section>

      <div className="overview-grid">
        <section className="panel coverage-panel" aria-labelledby="coverage-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Command check</p>
              <h2 id="coverage-heading">What needs attention</h2>
            </div>
          </div>
          <div className="empty-state empty-state--schedule">
            <CalendarDays aria-hidden="true" size={28} />
            <div>
              <strong>
                {isSupabaseConfigured
                  ? `${overview?.openShifts ?? '—'} current/upcoming open shift${overview?.openShifts === 1 ? '' : 's'}`
                  : 'Schedule data is not connected yet.'}
              </strong>
              <p>
                {isSupabaseConfigured
                  ? 'This count excludes past openings. Use Events & Openings to fill them, or Schedule to review the full week.'
                  : 'Published coverage will appear here after the secure schedule is ready.'}
              </p>
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="queue-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Attention</p>
              <h2 id="queue-heading">Action queue</h2>
            </div>
          </div>
          <div className="empty-state">
            <ClipboardCheck aria-hidden="true" size={28} />
            <div>
              <strong>
                {overview?.pendingRequests && overview.pendingRequests > 0
                  ? `${overview.pendingRequests} item${overview.pendingRequests === 1 ? '' : 's'} waiting`
                  : 'Nothing to review right now.'}
              </strong>
              <p>Time off, call-offs, shift requests, and exceptions route to the protected review areas.</p>
            </div>
          </div>
        </section>
      </div>
        </>
      )}
    </div>
  )
}

function formatShiftTime(startsAt: string, endsAt: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
  })
  return `${formatter.format(new Date(startsAt))} - ${formatter.format(new Date(endsAt))}`
}

function shiftLocation(shift: { siteCode?: string | null; siteName?: string | null; locationName?: string | null }): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' - ') || 'Location pending'
}

function shiftTitle(shift: { postName?: string | null; eventName?: string | null; locationName?: string | null }): string {
  return shift.postName ?? shift.eventName ?? shift.locationName ?? 'Assigned shift'
}

import {
  ArrowRight,
  BadgeDollarSign,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Coffee,
  FileClock,
  Megaphone,
  ShieldAlert,
  Timer,
  TimerReset,
  UserCog,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { canAccessRoute } from '../app/accessPolicy'
import { EarlyClockInWarningDialog } from '../components/EarlyClockInWarningDialog'
import { TimeOffRequestModal } from '../components/TimeOffRequestModal'
import { getActiveAnnouncementBanners } from '../data/announcements'
import { getSessionContext, type SessionContext } from '../data/auth'
import { getOpenOpportunities, opportunityLocation, opportunityTitle } from '../data/opportunities'
import { getOverviewMetrics, overviewMetricNote, type OverviewMetrics } from '../data/overview'
import { getRequestCenter, type RequestCenter } from '../data/requests'
import { getWeeklySchedule } from '../data/schedule'
import {
  activeTimeState,
  clockInWindowOpensAt,
  getClockableShiftChoices,
  getTimekeepingDashboard,
  recordTimeEvent,
  type TimeEventKind,
  type TimekeepingDashboard,
  type TimekeepingShift,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  formatDualTime,
  formatOperationalDate,
  formatOperationalDateTime,
  operationalToday,
} from '../lib/time'
import { canUseOwnTimeClock, canViewOwnTime } from '../time/timePermissions'
import { applyTimeEventToCachedDashboards, refreshTimekeepingQueriesAfterPunch } from '../time/timeQuerySync'
import {
  boundedHomeItems,
  dateKeyInTimeZone,
  greetingName,
  greetingPeriod,
  homeModeForRole,
  sundayWeekStart,
  summarizeTodayCoverage,
} from './homeModel'

type HomeLink = {
  label: string
  description: string
  path: string
  icon: typeof CalendarDays
}

const operationsMetrics: Array<{
  label: string
  key: keyof OverviewMetrics
  icon: typeof UsersRound
  path: string
}> = [
  { label: 'On duty now', key: 'onDutyNow', icon: UsersRound, path: '/time/operations' },
  { label: 'Open coverage', key: 'openShifts', icon: CalendarClock, path: '/scheduler' },
  { label: 'Pending reviews', key: 'pendingRequests', icon: ClipboardCheck, path: '/requests' },
  { label: 'Clock exceptions', key: 'clockExceptions', icon: TimerReset, path: '/time/exceptions' },
]

const workspaceLinks: HomeLink[] = [
  { label: 'Schedule', description: 'Review personal or team coverage.', path: '/schedule', icon: CalendarDays },
  { label: 'Scheduler', description: 'Build and publish staffing plans.', path: '/scheduler', icon: CalendarClock },
  { label: 'Time review', description: 'Review attendance and time records.', path: '/time/team', icon: FileClock },
  { label: 'Payroll', description: 'Prepare and export approved payroll.', path: '/payroll', icon: BadgeDollarSign },
  { label: 'Licensing', description: 'Maintain credentials and eligibility.', path: '/licensing', icon: CheckCircle2 },
  { label: 'User accounts', description: 'Manage employee sign-in access.', path: '/users', icon: UserCog },
]

function weekStartKey(now = operationalToday()): string {
  const operationalDateKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  return sundayWeekStart(operationalDateKey)
}

function routePathFromHref(href: string): string {
  return href.split(/[?#]/, 1)[0] || '/'
}

function overviewTimeAction(dashboard: TimekeepingDashboard | undefined): {
  kind: TimeEventKind | null
  label: string
  requiresTimePage: boolean
} {
  if (!dashboard) return { kind: null, label: 'Open time clock', requiresTimePage: true }
  const state = activeTimeState(dashboard.lastEvent)
  if (state === 'working') return { kind: 'clock_out', label: 'Clock out', requiresTimePage: false }
  if (state === 'on_break') return { kind: 'break_end', label: 'End break', requiresTimePage: false }
  const choices = getClockableShiftChoices(dashboard.eligibleShifts, dashboard.serverTimestamp)
  if (choices.shifts.length !== 1) return { kind: null, label: choices.shifts.length ? 'Choose shift' : 'View next shift', requiresTimePage: true }
  return { kind: 'clock_in', label: 'Clock in', requiresTimePage: false }
}

function shiftLocation(shift: Pick<TimekeepingShift, 'siteCode' | 'siteName' | 'locationName'>): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' · ') || 'Location pending'
}

function shiftTitle(shift: Pick<TimekeepingShift, 'postName' | 'eventName' | 'locationName'>): string {
  return shift.postName ?? shift.eventName ?? shift.locationName ?? 'Assigned shift'
}

function pendingRequestCount(center: RequestCenter | undefined): number {
  if (!center) return 0
  return center.timeOff.filter((item) => item.status === 'pending').length
    + center.shiftRequests.filter((item) => item.status === 'pending').length
    + center.callOffs.filter((item) => !item.resolved_at).length
}

function activeShiftForDashboard(dashboard: TimekeepingDashboard | undefined): TimekeepingShift | null {
  if (!dashboard?.lastEvent?.shiftId) return null
  return dashboard.eligibleShifts.find((shift) => shift.shiftId === dashboard.lastEvent?.shiftId) ?? null
}

function nextShiftForDashboard(dashboard: TimekeepingDashboard | undefined): TimekeepingShift | null {
  if (!dashboard) return null
  const activeShift = activeShiftForDashboard(dashboard)
  if (activeShift) return activeShift
  const serverTime = new Date(dashboard.serverTimestamp).getTime()
  return [...dashboard.eligibleShifts]
    .filter((shift) => new Date(shift.endsAt).getTime() >= serverTime)
    .sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime())[0] ?? null
}

export function OverviewPage() {
  const queryClient = useQueryClient()
  const punchLocked = useRef(false)
  const [timeOffOpen, setTimeOffOpen] = useState(false)
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const session = sessionQuery.data
  const homeMode = session ? homeModeForRole(session.role) : 'employee'
  const operationsHome = homeMode === 'operations'
  const ownTimeAllowed = canViewOwnTime(session)
  const punchAllowed = canUseOwnTimeClock(session)
  const requestsAllowed = canAccessRoute('/requests', session)
  const opportunitiesAllowed = canAccessRoute('/events', session)
  const scheduleAllowed = canAccessRoute('/schedule', session)
  const actionCenterAllowed = canAccessRoute('/actions', session)
  const availableWorkspaces = session ? workspaceLinks.filter((item) => canAccessRoute(item.path, session)) : []
  const announcementArchivePath = canAccessRoute('/notifications', session)
    ? '/notifications'
    : canAccessRoute('/announcements', session)
      ? '/announcements'
      : actionCenterAllowed
        ? '/actions'
        : null
  const currentWeek = weekStartKey()

  const overviewQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && operationsHome,
    queryFn: () => getOverviewMetrics(),
    queryKey: ['overview-metrics'],
    refetchInterval: 60_000,
  })
  const timekeepingQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['timekeeping-dashboard', 'overview'],
    refetchInterval: 15_000,
    retry: false,
  })
  const requestsQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && requestsAllowed,
    queryFn: getRequestCenter,
    queryKey: ['request-center', 'home'],
    refetchInterval: 60_000,
    retry: false,
  })
  const opportunitiesQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && opportunitiesAllowed && !operationsHome,
    queryFn: getOpenOpportunities,
    queryKey: ['open-opportunities', 'home'],
    refetchInterval: 60_000,
    retry: false,
  })
  const announcementsQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess,
    queryFn: getActiveAnnouncementBanners,
    queryKey: ['active-announcement-banners', 'home'],
    refetchInterval: 60_000,
    retry: false,
  })
  const scheduleQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && operationsHome && scheduleAllowed,
    queryFn: () => getWeeklySchedule(currentWeek),
    queryKey: ['weekly-schedule', currentWeek, 'home'],
    refetchInterval: 60_000,
    retry: false,
  })
  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSuccess: (event) => applyTimeEventToCachedDashboards(queryClient, event),
    onSettled: async () => {
      punchLocked.current = false
      await refreshTimekeepingQueriesAfterPunch(queryClient)
    },
  })

  const timeAction = overviewTimeAction(timekeepingQuery.data)
  const timeState = activeTimeState(timekeepingQuery.data?.lastEvent ?? null)
  const activeShift = activeShiftForDashboard(timekeepingQuery.data)
  const nextShift = nextShiftForDashboard(timekeepingQuery.data)

  function quickPunch(kind = timeAction.kind) {
    if (!kind || !timekeepingQuery.data || !punchAllowed || punchLocked.current || punchMutation.isPending) return
    punchLocked.current = true
    const choices = getClockableShiftChoices(timekeepingQuery.data.eligibleShifts, timekeepingQuery.data.serverTimestamp)
    punchMutation.mutate({ kind, shiftId: kind === 'clock_in' ? choices.shifts[0]?.shiftId ?? null : undefined })
  }

  if (sessionQuery.isPending) {
    return <div className="page home-page"><div className="home-loading" role="status">Preparing your Home page...</div></div>
  }

  if (sessionQuery.isError || !session) {
    return <div className="page home-page"><div className="inline-alert" role="alert">Your Home page could not be loaded. Refresh and try again.</div></div>
  }

  return (
    <div className={`page home-page home-page--${homeMode}`}>
      <HomeGreeting mode={homeMode} session={session} />
      {ownTimeAllowed ? (
        <TimeStatusStrip
          activeShift={activeShift}
          dashboard={timekeepingQuery.data}
          error={punchMutation.isError ? punchMutation.error.message : null}
          onPunch={quickPunch}
          pending={punchMutation.isPending || timekeepingQuery.isPending}
          punchAllowed={punchAllowed}
          scheduleAllowed={scheduleAllowed}
          showPersonalLinks={operationsHome}
          state={timeState}
          timeAction={timeAction}
        />
      ) : null}

      <section className="home-planned-time-off" aria-labelledby="home-time-off-title">
        <div>
          <CalendarDays aria-hidden="true" size={22} />
          <span>
            <strong id="home-time-off-title">Planning time away?</strong>
            <small>Request future vacation, sick time, or unpaid time off for review.</small>
          </span>
        </div>
        <button className="secondary-button" onClick={() => setTimeOffOpen(true)} type="button">Request Time Off</button>
      </section>

      {operationsHome ? (
        <OperationsHome
          announcementArchivePath={announcementArchivePath}
          announcements={boundedHomeItems((announcementsQuery.data ?? []).filter((item) => item.tone !== 'urgent'))}
          announcementsError={announcementsQuery.isError}
          onRetryAnnouncements={() => void announcementsQuery.refetch()}
          onRetryMetrics={() => void overviewQuery.refetch()}
          onRetryRequests={() => void requestsQuery.refetch()}
          onRetrySchedule={() => void scheduleQuery.refetch()}
          metrics={overviewQuery.data}
          metricsError={overviewQuery.isError}
          metricsPending={overviewQuery.isPending}
          requestCenter={requestsQuery.data}
          requestsError={requestsQuery.isError}
          schedule={scheduleQuery.data?.shifts ?? []}
          scheduleAllowed={scheduleAllowed}
          scheduleError={scheduleQuery.isError}
          session={session}
          workspaces={availableWorkspaces}
        />
      ) : (
        <EmployeeHome
          announcements={boundedHomeItems((announcementsQuery.data ?? []).filter((item) => item.tone !== 'urgent'))}
          announcementArchivePath={announcementArchivePath}
          announcementsError={announcementsQuery.isError}
          nextShift={nextShift}
          onRetryAnnouncements={() => void announcementsQuery.refetch()}
          onRetryOpportunities={() => void opportunitiesQuery.refetch()}
          onRetryRequests={() => void requestsQuery.refetch()}
          opportunity={opportunitiesQuery.data?.opportunities
            .filter((item) => new Date(item.ends_at).getTime() >= Date.now())
            .sort((left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime())[0] ?? null}
          pendingRequests={pendingRequestCount(requestsQuery.data)}
          requestsAllowed={requestsAllowed}
          requestsError={requestsQuery.isError}
          opportunitiesError={opportunitiesQuery.isError}
          scheduleAllowed={scheduleAllowed}
          session={session}
          workspaces={availableWorkspaces.filter((item) => item.path !== '/schedule')}
        />
      )}
      {timeOffOpen ? (
        <TimeOffRequestModal
          onClose={() => setTimeOffOpen(false)}
          onSubmitted={() => void requestsQuery.refetch()}
          requestHistoryPath="/requests"
        />
      ) : null}
    </div>
  )
}

function HomeGreeting({ mode, session }: { mode: 'employee' | 'operations'; session: SessionContext }) {
  const now = new Date()
  return (
    <section className="home-greeting">
      <div>
        <p className="eyebrow">{mode === 'operations' ? 'Operations Home' : 'My Home'}</p>
        <h1>Good {greetingPeriod(now)}, {greetingName(session.displayName, session.username)}.</h1>
        <p>{mode === 'operations' ? 'Lead clearly, act early, and keep the team safe.' : 'Stay alert, stay prepared, and have a safe shift.'}</p>
      </div>
      <div className="home-greeting__date" aria-label="Current Mountain Time">
        <strong>{formatOperationalDate(now)}</strong>
        <span>{formatDualTime(now, { includeTimeZoneName: true })}</span>
      </div>
    </section>
  )
}

function TimeStatusStrip({ activeShift, dashboard, error, onPunch, pending, punchAllowed, scheduleAllowed, showPersonalLinks, state, timeAction }: {
  activeShift: TimekeepingShift | null
  dashboard: TimekeepingDashboard | undefined
  error: string | null
  onPunch: (kind: TimeEventKind | null) => void
  pending: boolean
  punchAllowed: boolean
  scheduleAllowed: boolean
  showPersonalLinks: boolean
  state: ReturnType<typeof activeTimeState>
  timeAction: ReturnType<typeof overviewTimeAction>
}) {
  const [earlyClockInWarningOpen, setEarlyClockInWarningOpen] = useState(false)
  const clockableChoices = dashboard
    ? getClockableShiftChoices(dashboard.eligibleShifts, dashboard.serverTimestamp)
    : null
  const upcomingShift = dashboard && state === 'off_clock' && clockableChoices?.shifts.length === 0
    ? nextShiftForDashboard(dashboard)
    : null
  const clockInOpensAt = upcomingShift ? clockInWindowOpensAt(upcomingShift) : null
  const earlyClockInAttemptAvailable = Boolean(
    punchAllowed
    && state === 'off_clock'
    && upcomingShift
    && clockableChoices?.shifts.length === 0,
  )
  const statusLabel = error
    ? 'Time action needs attention'
    : pending
      ? 'Saving your time...'
      : state === 'working'
        ? 'You are working'
        : state === 'on_break'
          ? 'You are on break'
          : clockInOpensAt
            ? `Clock-in opens at ${formatDualTime(clockInOpensAt, { timeZone: upcomingShift?.timeZone })}`
            : 'You are off the clock'
  const lastEventTime = dashboard?.lastEvent
    ? formatOperationalDateTime(dashboard.lastEvent.effectiveAt ?? dashboard.lastEvent.recordedAt, { includeTimeZoneName: true })
    : null

  return (
    <section className={`home-time-strip home-time-strip--${error ? 'error' : state}`} aria-label="Current time status">
      <div className="home-time-strip__status">
        <Timer aria-hidden="true" size={22} />
        <div>
          <strong>{statusLabel}</strong>
          <span>{error ?? (activeShift
            ? `${shiftLocation(activeShift)} · ${lastEventTime ?? 'Time recorded'}`
            : upcomingShift
              ? `Your shift begins at ${formatDualTime(upcomingShift.startsAt, { timeZone: upcomingShift.timeZone })} at ${shiftLocation(upcomingShift)}. This status updates automatically.`
              : 'Ready for your next scheduled shift.')}</span>
        </div>
      </div>
      <div className="home-time-strip__actions" role="group" aria-label="Time clock actions">
        {earlyClockInAttemptAvailable && upcomingShift && dashboard ? (
          <button className="primary-action" disabled={pending} onClick={() => setEarlyClockInWarningOpen(true)} type="button">
            <Timer aria-hidden="true" size={18} />Clock in
          </button>
        ) : timeAction.requiresTimePage ? (
          <Link className="primary-action" to="/time/my-time"><Timer aria-hidden="true" size={18} />{timeAction.label}</Link>
        ) : punchAllowed ? (
          <button className={timeAction.kind === 'clock_out' ? 'danger-button' : 'primary-action'} disabled={pending} onClick={() => onPunch(timeAction.kind)} type="button">
            <Timer aria-hidden="true" size={18} />{pending ? 'Saving...' : timeAction.label}
          </button>
        ) : null}
        {state === 'working' && punchAllowed ? (
          <button className="secondary-button" disabled={pending} onClick={() => onPunch('break_start')} type="button"><Coffee aria-hidden="true" size={18} />Start break</button>
        ) : null}
        {scheduleAllowed ? <Link className="secondary-button" to="/schedule"><CalendarDays aria-hidden="true" size={18} />Schedule</Link> : null}
        {showPersonalLinks ? (
          <Link className="home-call-off-button" to="/time/my-time?report=call-off">
            <span className="home-call-off-button__icon"><ShieldAlert aria-hidden="true" size={20} /></span>
            <span className="home-call-off-button__copy"><strong>Report Sick / Call-Off</strong><small>Urgent coverage help</small></span>
          </Link>
        ) : null}
      </div>
      {earlyClockInWarningOpen && upcomingShift && dashboard ? (
        <EarlyClockInWarningDialog
          locationName={shiftLocation(upcomingShift)}
          onAcknowledge={() => setEarlyClockInWarningOpen(false)}
          serverTimestamp={dashboard.serverTimestamp}
          shiftStartsAt={upcomingShift.startsAt}
          timeZone={upcomingShift.timeZone}
        />
      ) : null}
    </section>
  )
}

function EmployeeHome({ announcementArchivePath, announcements, announcementsError, nextShift, onRetryAnnouncements, onRetryOpportunities, onRetryRequests, opportunitiesError, opportunity, pendingRequests, requestsAllowed, requestsError, scheduleAllowed, session, workspaces }: {
  announcementArchivePath: string | null
  announcements: Awaited<ReturnType<typeof getActiveAnnouncementBanners>>
  announcementsError: boolean
  nextShift: TimekeepingShift | null
  onRetryAnnouncements: () => void
  onRetryOpportunities: () => void
  onRetryRequests: () => void
  opportunitiesError: boolean
  opportunity: Awaited<ReturnType<typeof getOpenOpportunities>>['opportunities'][number] | null
  pendingRequests: number
  requestsAllowed: boolean
  requestsError: boolean
  scheduleAllowed: boolean
  session: SessionContext
  workspaces: HomeLink[]
}) {
  return (
    <>
      <section className="home-quick-actions" aria-labelledby="home-quick-actions-title">
        <div><p className="eyebrow">Quick actions</p><h2 id="home-quick-actions-title">What do you need to do?</h2></div>
        <div className="home-quick-actions__buttons">
          <Link className="home-quick-action home-quick-action--danger" to="/time/my-time?report=call-off"><ShieldAlert aria-hidden="true" size={20} /><span><strong>Report sick / call-off</strong><small>Notify Dispatch and request coverage.</small></span><ArrowRight aria-hidden="true" size={17} /></Link>
        </div>
      </section>

      <section className="home-section" aria-labelledby="today-heading">
        <div className="home-section__heading"><div><p className="eyebrow">Today</p><h2 id="today-heading">Your workday</h2></div></div>
        <div className="home-card-grid">
          <HomeCard icon={UserRoundCheck} title="Next shift" value={nextShift ? shiftTitle(nextShift) : 'No upcoming shift'}>
            <p>{nextShift ? `${shiftLocation(nextShift)} · ${formatOperationalDateTime(nextShift.startsAt)} – ${formatDualTime(nextShift.endsAt, { timeZone: nextShift.timeZone })}` : 'Your next published assignment will appear here.'}</p>
            {nextShift ? <span className="home-card__status"><CheckCircle2 aria-hidden="true" size={15} />Published assignment</span> : null}
            {scheduleAllowed ? <Link className="text-link" to="/schedule">Open Schedule <ArrowRight aria-hidden="true" size={16} /></Link> : null}
          </HomeCard>
          <HomeCard icon={ClipboardCheck} title="My requests" value={pendingRequests ? `${pendingRequests} pending` : 'No pending requests'}>
            {requestsError ? <ModuleRetry label="Requests could not be loaded." onRetry={onRetryRequests} /> : <p>Review time-off, coverage, and shift-request status.</p>}
            {requestsAllowed ? <Link className="text-link" to="/requests">Open requests <ArrowRight aria-hidden="true" size={16} /></Link> : null}
          </HomeCard>
          {opportunity ? <HomeCard icon={CalendarClock} title="Available opportunity" value={opportunityTitle(opportunity)}>
            <p>{`${opportunityLocation(opportunity)} · ${formatOperationalDateTime(opportunity.starts_at)} – ${formatDualTime(opportunity.ends_at, { timeZone: opportunity.time_zone })}`}</p>
            <span className="home-card__status">{opportunity.requires_armed ? 'Armed shift' : opportunity.event ? 'Event' : 'Open shift'}</span>
            <Link className="text-link" to="/events">View shift <ArrowRight aria-hidden="true" size={16} /></Link>
          </HomeCard> : opportunitiesError ? <HomeCard icon={CalendarClock} title="Available opportunity" value="Could not load opportunities"><ModuleRetry label="Shift Pool data is temporarily unavailable." onRetry={onRetryOpportunities} /></HomeCard> : null}
          <HomeCard className="home-card--announcements" icon={Megaphone} title="Announcements" value={announcements.length ? `${announcements.length} current` : 'No current announcements'}>
            {announcementsError ? <ModuleRetry label="Announcements could not be loaded." onRetry={onRetryAnnouncements} /> : announcements.length ? (
              <div className="home-announcement-list">
                {announcements.map((item) => {
                  const ctaAllowed = item.ctaHref && canAccessRoute(routePathFromHref(item.ctaHref), session)
                  return <article key={item.id}><strong>{item.title}</strong><span>{item.message}</span>{ctaAllowed && item.ctaLabel ? <Link to={item.ctaHref!}>{item.ctaLabel}</Link> : null}</article>
                })}
              </div>
            ) : <p>Company updates will appear here when posted.</p>}
            {announcementArchivePath ? <Link className="text-link" to={announcementArchivePath}>View all <ArrowRight aria-hidden="true" size={16} /></Link> : null}
          </HomeCard>
        </div>
      </section>

      {workspaces.length ? <WorkspaceSection items={workspaces} title="Your workspaces" /> : null}
    </>
  )
}

function OperationsHome({ announcementArchivePath, announcements, announcementsError, metrics, metricsError, metricsPending, onRetryAnnouncements, onRetryMetrics, onRetryRequests, onRetrySchedule, requestCenter, requestsError, schedule, scheduleAllowed, scheduleError, session, workspaces }: {
  announcementArchivePath: string | null
  announcements: Awaited<ReturnType<typeof getActiveAnnouncementBanners>>
  announcementsError: boolean
  metrics: OverviewMetrics | undefined
  metricsError: boolean
  metricsPending: boolean
  onRetryAnnouncements: () => void
  onRetryMetrics: () => void
  onRetryRequests: () => void
  onRetrySchedule: () => void
  requestCenter: RequestCenter | undefined
  requestsError: boolean
  schedule: NonNullable<Awaited<ReturnType<typeof getWeeklySchedule>>>['shifts']
  scheduleAllowed: boolean
  scheduleError: boolean
  session: SessionContext
  workspaces: HomeLink[]
}) {
  const todayKey = dateKeyInTimeZone(new Date())
  const coverage = summarizeTodayCoverage(schedule, todayKey)
  const openCallOffs = requestCenter?.callOffs.filter((item) => !item.resolved_at).length ?? 0
  const pendingTimeOff = requestCenter?.timeOff.filter((item) => item.status === 'pending').length ?? 0
  const pendingShiftRequests = requestCenter?.shiftRequests.filter((item) => item.status === 'pending').length ?? 0
  const authorizedQueue = [
    ...(openCallOffs ? [{ label: 'Call-offs awaiting review', value: openCallOffs, path: '/time/operations' }] : []),
    ...(pendingTimeOff ? [{ label: 'Time-off requests', value: pendingTimeOff, path: '/requests' }] : []),
    ...(pendingShiftRequests ? [{ label: 'Shift requests', value: pendingShiftRequests, path: '/requests' }] : []),
    ...(metrics?.clockExceptions ? [{ label: 'Time exceptions', value: metrics.clockExceptions, path: '/time/exceptions' }] : []),
  ].filter((item) => canAccessRoute(item.path, session))
  const queue = boundedHomeItems(authorizedQueue)
  const queueTotal = authorizedQueue.reduce((total, item) => total + item.value, 0)
  const actionCenterPath = canAccessRoute('/time/operations', session)
    ? '/time/operations'
    : canAccessRoute('/requests', session)
      ? '/requests'
      : canAccessRoute('/time/exceptions', session)
        ? '/time/exceptions'
        : null
  const coverageGaps = boundedHomeItems(coverage.shifts.filter((shift) => shift.assignments.length < shift.headcount_required))
  const coverageActionPath = canAccessRoute('/scheduler', session) ? '/scheduler' : '/schedule'

  return (
    <>
      <section className="home-metric-grid" aria-label="Today's operations metrics">
        {operationsMetrics.filter((item) => canAccessRoute(item.path, session)).map((item) => {
          const Icon = item.icon
          const value = metrics?.[item.key] ?? null
          const content = <><div><span>{item.label}</span><Icon aria-hidden="true" size={20} /></div><strong>{metricsPending ? '…' : value ?? '—'}</strong><small>{metricsError ? 'Metric temporarily unavailable' : overviewMetricNote(item.key, value)}</small></>
          return <Link className={`home-metric-card home-metric-card--${value ? 'attention' : 'clear'}`} key={item.key} to={item.path}>{content}</Link>
        })}
      </section>
      {metricsError ? <ModuleRetry className="home-module-retry--standalone" label="Operations metrics could not be refreshed." onRetry={onRetryMetrics} /> : null}
      <section className="home-operations-grid">
        <article className="home-priority-card">
          <div className="home-section__heading"><div><p className="eyebrow">Priority queue</p><h2>What needs attention</h2></div><span className="home-count-label">{queueTotal} total</span></div>
          {requestsError ? <ModuleRetry label="Request queues could not be loaded." onRetry={onRetryRequests} /> : queue.length ? <div className="home-priority-list">{queue.map((item) => <Link key={item.label} to={item.path}><span><strong>{item.label}</strong><small>Open the authorized workspace to review this item.</small></span><b>{item.value}</b><ArrowRight aria-hidden="true" size={17} /></Link>)}</div> : <div className="home-empty-state"><CheckCircle2 aria-hidden="true" size={22} /><span>No priority items right now.</span></div>}
          {actionCenterPath ? <Link className="text-link home-card-action" to={actionCenterPath}>View Full Action Center <ArrowRight aria-hidden="true" size={16} /></Link> : null}
        </article>
        <article className="home-coverage-card">
          <div className="home-section__heading"><div><p className="eyebrow">Coverage today</p><h2>{coverage.assigned} of {coverage.required} posts covered</h2></div>{scheduleAllowed ? <Link className="text-link" to="/schedule">Open Schedule <ArrowRight aria-hidden="true" size={16} /></Link> : null}</div>
          {scheduleError ? <ModuleRetry label="Today's coverage could not be loaded." onRetry={onRetrySchedule} /> : <>
            <div className="home-coverage-meter" aria-label={`${coverage.assigned} of ${coverage.required} required assignments covered`}><span style={{ width: `${coverage.required ? Math.min(100, (coverage.assigned / coverage.required) * 100) : 100}%` }} /></div>
            <div className="home-coverage-summary"><div><span>Required</span><strong>{coverage.required}</strong></div><div><span>Assigned</span><strong>{coverage.assigned}</strong></div><div><span>Open</span><strong>{coverage.open}</strong></div></div>
            {coverageGaps.length ? <div className="home-gap-list">{coverageGaps.map((shift) => <div key={shift.id}><span><strong>{shift.post?.site.name ?? shift.event?.site?.name ?? shift.event?.location_name ?? 'Coverage location'}</strong><small>{shift.post?.name ?? shift.event?.name ?? 'Shift'} · {formatDualTime(shift.starts_at, { timeZone: shift.time_zone })}</small></span><Link to={coverageActionPath}>{canAccessRoute('/scheduler', session) ? 'Fill' : 'Review'}</Link></div>)}</div> : <div className="home-empty-state"><CheckCircle2 aria-hidden="true" size={22} /><span>No immediate coverage gaps.</span></div>}
          </>}
        </article>
      </section>
      {workspaces.length ? <WorkspaceSection items={workspaces} metrics={metrics} title="Operations work modules" /> : null}
      <AnnouncementSection announcementArchivePath={announcementArchivePath} announcements={announcements} error={announcementsError} onRetry={onRetryAnnouncements} session={session} />
    </>
  )
}

function HomeCard({ children, className = '', icon: Icon, title, value }: { children: ReactNode; className?: string; icon: typeof CalendarDays; title: string; value: string }) {
  return <article className={`home-card ${className}`.trim()}><div className="home-card__title"><Icon aria-hidden="true" size={20} /><span>{title}</span></div><h3>{value}</h3><div className="home-card__body">{children}</div></article>
}

function AnnouncementSection({ announcementArchivePath, announcements, error, onRetry, session }: {
  announcementArchivePath: string | null
  announcements: Awaited<ReturnType<typeof getActiveAnnouncementBanners>>
  error: boolean
  onRetry: () => void
  session: SessionContext
}) {
  return <section className="home-section" aria-labelledby="operations-announcements-heading"><div className="home-section__heading"><div><p className="eyebrow">Updates</p><h2 id="operations-announcements-heading">Announcements</h2></div>{announcementArchivePath ? <Link className="text-link" to={announcementArchivePath}>View all <ArrowRight aria-hidden="true" size={16} /></Link> : null}</div>{error ? <ModuleRetry label="Announcements could not be loaded." onRetry={onRetry} /> : announcements.length ? <div className="home-announcement-list home-announcement-list--wide">{announcements.map((item) => { const ctaAllowed = item.ctaHref && canAccessRoute(routePathFromHref(item.ctaHref), session); return <article key={item.id}><strong>{item.title}</strong><span>{item.message}</span>{ctaAllowed && item.ctaLabel ? <Link to={item.ctaHref!}>{item.ctaLabel}</Link> : null}</article> })}</div> : <div className="home-empty-state"><Megaphone aria-hidden="true" size={22} /><span>No current announcements.</span></div>}</section>
}

function ModuleRetry({ className = '', label, onRetry }: { className?: string; label: string; onRetry: () => void }) {
  return <div className={`home-module-retry ${className}`.trim()} role="alert"><span>{label}</span><button className="secondary-button" onClick={onRetry} type="button">Retry</button></div>
}

function WorkspaceSection({ items, metrics, title }: { items: HomeLink[]; metrics?: OverviewMetrics; title: string }) {
  function workspacePreview(item: HomeLink): string {
    if (item.path === '/scheduler') return metrics?.openShifts ? `${metrics.openShifts} open shift${metrics.openShifts === 1 ? '' : 's'} need coverage.` : 'No open shifts need attention.'
    if (item.path === '/time/team') return metrics?.clockExceptions ? `${metrics.clockExceptions} clock exception${metrics.clockExceptions === 1 ? '' : 's'} need review.` : 'No clock exceptions need review.'
    if (item.path === '/payroll') return metrics?.clockExceptions ? 'Resolve time exceptions before payroll handoff.' : 'Payroll review is ready for its next step.'
    return item.description
  }

  return <section className="home-section" aria-labelledby="home-workspaces-heading"><div className="home-section__heading"><div><p className="eyebrow">Access</p><h2 id="home-workspaces-heading">{title}</h2></div></div><div className="home-workspace-grid">{items.map((item) => { const Icon = item.icon; return <Link key={item.path} to={item.path}><Icon aria-hidden="true" size={21} /><div><strong>{item.label}</strong><span>{workspacePreview(item)}</span></div><ArrowRight aria-hidden="true" size={17} /></Link> })}</div></section>
}

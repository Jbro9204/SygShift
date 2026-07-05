import {
  ArrowRight,
  CalendarDays,
  ClipboardCheck,
  DatabaseZap,
  Clock3,
  Timer,
  TimerReset,
  UsersRound,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { getOverviewMetrics, overviewMetricNote, type OverviewMetrics } from '../data/overview'
import {
  activeTimeState,
  getTimekeepingDashboard,
  recordTimeEvent,
  type TimeEventKind,
  type TimekeepingDashboard,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'

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
  if (dashboard.eligibleShifts.length > 1) return { kind: null, label: 'Choose shift to clock in', requiresTimePage: true }
  return { kind: 'clock_in', label: 'Clock in', requiresTimePage: false }
}

export function OverviewPage() {
  const queryClient = useQueryClient()
  const punchLocked = useRef(false)
  const overviewQuery = useQuery({
    queryKey: ['overview-metrics'],
    queryFn: () => getOverviewMetrics(),
    enabled: isSupabaseConfigured,
    refetchInterval: 60_000,
  })
  const timekeepingQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['timekeeping-dashboard', 'overview'],
    refetchInterval: 15_000,
    retry: false,
  })
  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSettled: async () => {
      punchLocked.current = false
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['overview-metrics'], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'], refetchType: 'active' }),
      ])
      await queryClient.refetchQueries({ queryKey: ['timekeeping-dashboard'], type: 'active' })
    },
  })
  const overview = overviewQuery.data
  const timeAction = overviewTimeAction(timekeepingQuery.data)

  function quickPunch() {
    if (!timeAction.kind || !timekeepingQuery.data) return
    if (punchLocked.current || punchMutation.isPending) return
    punchLocked.current = true
    const shiftId = timeAction.kind === 'clock_in'
      ? timekeepingQuery.data.eligibleShifts[0]?.shiftId ?? null
      : undefined
    punchMutation.mutate({ kind: timeAction.kind, shiftId })
  }

  return (
    <div className="page page--overview">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Operations overview</p>
          <h1>One clear view of the day.</h1>
          <p className="page-summary">
            Coverage, requests, timekeeping, and events stay connected without making the schedule
            harder to read.
          </p>
        </div>
        <div className="overview-intro-actions">
          {timeAction.requiresTimePage ? (
            <Link className="primary-action overview-clock-action" to="/time">
              <Timer aria-hidden="true" size={19} />
              {timeAction.label}
            </Link>
          ) : (
            <button
              className="primary-action overview-clock-action"
              disabled={punchMutation.isPending || timekeepingQuery.isPending}
              onClick={quickPunch}
              type="button"
            >
              <Timer aria-hidden="true" size={19} />
              {punchMutation.isPending ? 'Recording...' : timeAction.label}
            </button>
          )}
          <Link className="secondary-button overview-schedule-action" to="/schedule">
            Master schedule
            <ArrowRight aria-hidden="true" size={18} />
          </Link>
        </div>
      </section>

      {punchMutation.isError ? (
        <div className="inline-alert" role="alert">{punchMutation.error.message}</div>
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
            <span>Official time is recorded by the secure server. Full time tools remain under Time & attendance.</span>
          </div>
        </section>
      ) : null}

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
              : 'No employee or schedule information will appear until the protected database is connected and the source workbook passes reconciliation.'}
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
                  ? 'This count excludes past openings. Use Events & openings to fill them, or Master schedule to review the full week.'
                  : 'Imported coverage will appear here only after every source value is verified.'}
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
    </div>
  )
}

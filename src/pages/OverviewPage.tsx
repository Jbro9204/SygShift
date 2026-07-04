import {
  ArrowRight,
  CalendarDays,
  ClipboardCheck,
  DatabaseZap,
  TimerReset,
  UsersRound,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getOverviewMetrics, overviewMetricNote, type OverviewMetrics } from '../data/overview'
import { isSupabaseConfigured } from '../lib/supabase'

const metrics: Array<{ label: string, key: keyof OverviewMetrics, icon: typeof UsersRound }> = [
  { label: 'On duty now', key: 'onDutyNow', icon: UsersRound },
  { label: 'Open shifts', key: 'openShifts', icon: CalendarDays },
  { label: 'Pending requests', key: 'pendingRequests', icon: ClipboardCheck },
  { label: 'Clock exceptions', key: 'clockExceptions', icon: TimerReset },
]

export function OverviewPage() {
  const overviewQuery = useQuery({
    queryKey: ['overview-metrics'],
    queryFn: () => getOverviewMetrics(),
    enabled: isSupabaseConfigured,
    refetchInterval: 60_000,
  })
  const overview = overviewQuery.data

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
        <Link className="primary-action" to="/schedule">
          Open master schedule
          <ArrowRight aria-hidden="true" size={20} />
        </Link>
      </section>

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
              <p className="eyebrow">Today</p>
              <h2 id="coverage-heading">Coverage at a glance</h2>
            </div>
            <Link to="/schedule">View schedule</Link>
          </div>
          <div className="empty-state empty-state--schedule">
            <CalendarDays aria-hidden="true" size={28} />
            <div>
              <strong>{isSupabaseConfigured ? 'The Bible schedule is operational.' : 'No schedule has been published.'}</strong>
              <p>
                {isSupabaseConfigured
                  ? 'Use the master schedule for the full weekly board, open coverage, and source-review markers.'
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

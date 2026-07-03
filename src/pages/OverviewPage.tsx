import {
  ArrowRight,
  CalendarDays,
  ClipboardCheck,
  DatabaseZap,
  TimerReset,
  UsersRound,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { isSupabaseConfigured } from '../lib/supabase'

const metrics = [
  { label: 'On duty now', icon: UsersRound, note: 'Available after schedule import' },
  { label: 'Open shifts', icon: CalendarDays, note: 'No published openings' },
  { label: 'Pending requests', icon: ClipboardCheck, note: 'Approval queue not connected' },
  { label: 'Clock exceptions', icon: TimerReset, note: 'Timekeeping not active' },
]

export function OverviewPage() {
  return (
    <div className="page page--overview">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Operations overview</p>
          <h1>One clear view of the day.</h1>
          <p className="page-summary">
            Coverage, requests, timekeeping, and events will stay connected without making the
            schedule harder to read.
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
              ? 'The application is ready for authenticated data access and exact source reconciliation.'
              : 'No employee or schedule information will appear until the protected database is connected and the source workbook passes reconciliation.'}
          </p>
        </div>
        <span className="status-pill">{isSupabaseConfigured ? 'Connected' : 'No data loaded'}</span>
      </section>

      <section aria-label="Operational totals" className="metric-grid">
        {metrics.map((metric) => {
          const Icon = metric.icon
          return (
            <article className="metric" key={metric.label}>
              <div className="metric-heading">
                <span>{metric.label}</span>
                <Icon aria-hidden="true" size={21} />
              </div>
              <strong aria-label={`${metric.label} is unavailable`}>—</strong>
              <p>{metric.note}</p>
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
              <strong>No schedule has been published.</strong>
              <p>Imported coverage will appear here only after every source value is verified.</p>
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
              <strong>Nothing to review yet.</strong>
              <p>Time off, call-offs, shift requests, and exceptions will arrive in one queue.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

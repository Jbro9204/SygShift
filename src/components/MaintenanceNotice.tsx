import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, Wrench } from 'lucide-react'
import {
  maintenanceFeatureLabel,
  type MaintenanceFeatureCode,
  type MaintenanceWindow,
} from '../data/maintenance'
import { formatOperationalDateTime } from '../lib/time'

function featureSummary(featureCodes: MaintenanceFeatureCode[]): string {
  const labels = featureCodes.map(maintenanceFeatureLabel)
  if (labels.length <= 3) return labels.join(', ')
  return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`
}

export function MaintenanceNotice({
  active,
  completed,
  upcoming,
}: {
  active: MaintenanceWindow | null
  completed: MaintenanceWindow | null
  upcoming: MaintenanceWindow | null
}) {
  const window = active ?? upcoming ?? completed
  if (!window) return null

  const isActive = Boolean(active)
  const isUpcoming = !active && Boolean(upcoming)
  const Icon = isActive ? Wrench : isUpcoming ? CalendarClock : CheckCircle2
  const title = isActive
    ? `${window.title} is in progress`
    : isUpcoming
      ? window.title
      : window.completionMessage || 'SygShift maintenance is complete'
  const timing = isActive
    ? `Expected to end automatically by ${formatOperationalDateTime(window.endsAt, { includeTimeZoneName: true })}.`
    : isUpcoming
      ? `Starts ${formatOperationalDateTime(window.startsAt, { includeTimeZoneName: true })} and ends ${formatOperationalDateTime(window.endsAt, { includeTimeZoneName: true })}.`
      : 'Refresh when convenient if an update notice appears.'

  return (
    <section
      aria-label="SygShift maintenance notice"
      aria-live="polite"
      className={`maintenance-notice maintenance-notice--${isActive ? window.accessMode : isUpcoming ? 'upcoming' : 'complete'}`}
      role="status"
    >
      <div className="maintenance-notice__icon"><Icon aria-hidden="true" size={24} /></div>
      <div className="maintenance-notice__copy">
        <strong>{title}</strong>
        <span>{isActive || isUpcoming ? window.message : window.completionMessage}</span>
        <small>{timing} {isActive || isUpcoming ? `Affected: ${featureSummary(window.featureCodes)}.` : ''}</small>
      </div>
      {isActive && window.accessMode !== 'notice' ? (
        <span className="maintenance-notice__mode"><AlertTriangle aria-hidden="true" size={16} />{window.accessMode === 'read_only' ? 'Read-only' : 'Unavailable'}</span>
      ) : isUpcoming ? (
        <span className="maintenance-notice__mode"><Clock3 aria-hidden="true" size={16} />Upcoming</span>
      ) : null}
    </section>
  )
}

export function MaintenanceUnavailablePanel({ window }: { window: MaintenanceWindow }) {
  return (
    <section className="maintenance-unavailable-panel" role="status">
      <div className="maintenance-unavailable-panel__icon"><Wrench aria-hidden="true" size={34} /></div>
      <p className="eyebrow">Temporary maintenance</p>
      <h1>{window.title}</h1>
      <p>{window.message}</p>
      <dl>
        <div><dt>Affected workspace</dt><dd>{featureSummary(window.featureCodes)}</dd></div>
        <div><dt>Expected availability</dt><dd>{formatOperationalDateTime(window.endsAt, { includeTimeZoneName: true })}</dd></div>
      </dl>
      <small>This window ends automatically. You do not need to sign out.</small>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, Wrench, X } from 'lucide-react'
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
  const isActive = Boolean(active)
  const isUpcoming = !active && Boolean(upcoming)
  const selectedWindow = active ?? upcoming ?? completed
  const noticeKind = isActive ? 'active' : isUpcoming ? 'upcoming' : 'complete'
  const dismissalKey = useMemo(
    () => selectedWindow ? `sygshift:maintenance-notice-dismissed:${selectedWindow.id}:${noticeKind}` : null,
    [noticeKind, selectedWindow],
  )
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!dismissalKey || isActive) return

    try {
      if (window.localStorage.getItem(dismissalKey) === 'true') {
        setDismissedKey(dismissalKey)
      }
    } catch {
      // Storage may be unavailable in restricted browser modes; the notice remains usable.
    }
  }, [dismissalKey, isActive])

  useEffect(() => {
    if (!dismissalKey || isActive || isUpcoming || dismissedKey === dismissalKey) return
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(dismissalKey, 'true')
      } catch {
        // Dismissing the visible notice still works when browser storage is unavailable.
      }
      setDismissedKey(dismissalKey)
    }, 15_000)

    return () => window.clearTimeout(timeout)
  }, [dismissalKey, dismissedKey, isActive, isUpcoming])

  if (!selectedWindow || dismissedKey === dismissalKey) return null

  function dismissNotice() {
    if (!dismissalKey || isActive) return
    try {
      window.localStorage.setItem(dismissalKey, 'true')
    } catch {
      // The current notice can still close even if dismissal cannot persist.
    }
    setDismissedKey(dismissalKey)
  }

  const Icon = isActive ? Wrench : isUpcoming ? CalendarClock : CheckCircle2
  const title = isActive
    ? `${selectedWindow.title} is in progress`
    : isUpcoming
      ? selectedWindow.title
      : 'Maintenance complete. SygShift is available normally.'
  const timing = isActive
    ? `Expected to end automatically by ${formatOperationalDateTime(selectedWindow.endsAt, { includeTimeZoneName: true })}.`
    : isUpcoming
      ? `Starts ${formatOperationalDateTime(selectedWindow.startsAt, { includeTimeZoneName: true })} and ends ${formatOperationalDateTime(selectedWindow.endsAt, { includeTimeZoneName: true })}.`
      : 'Refresh when convenient if an update notice appears.'

  return (
    <section
      aria-label="SygShift maintenance notice"
      aria-live="polite"
      className={`maintenance-notice maintenance-notice--${isActive ? selectedWindow.accessMode : isUpcoming ? 'upcoming' : 'complete'}`}
      role="status"
    >
      <div className="maintenance-notice__icon"><Icon aria-hidden="true" size={24} /></div>
      <div className="maintenance-notice__copy">
        <strong>{title}</strong>
        <span>{isActive || isUpcoming ? selectedWindow.message : 'No action is required.'}</span>
        <small>{timing} {isActive || isUpcoming ? `Affected: ${featureSummary(selectedWindow.featureCodes)}.` : ''}</small>
      </div>
      {isActive && selectedWindow.accessMode !== 'notice' ? (
        <span className="maintenance-notice__mode"><AlertTriangle aria-hidden="true" size={16} />{selectedWindow.accessMode === 'read_only' ? 'Read-only' : 'Unavailable'}</span>
      ) : isUpcoming ? (
        <span className="maintenance-notice__mode"><Clock3 aria-hidden="true" size={16} />Upcoming</span>
      ) : null}
      {!isActive ? (
        <button aria-label="Dismiss maintenance notice" className="maintenance-notice__dismiss" onClick={dismissNotice} type="button">
          <X aria-hidden="true" size={18} />
        </button>
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

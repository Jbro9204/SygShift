import { Clock3 } from 'lucide-react'
import { formatDualTime } from '../lib/time'
import { formatScheduleInstantOffset, formatScheduleTimeZoneRange, scheduleElapsedTimeLabel, type ScheduleRepeatedTime } from '../schedule/timeBasis'

export interface ScheduleTimePreviewRow {
  label: string
  timeZone: string
}

export function ScheduleTimeBasisPanel({
  basisLabel,
  description,
  endsAt,
  previewError,
  previewRows,
  repeatedTimes = [],
  repeatedTimeConfirmation,
  startsAt,
}: {
  basisLabel: string
  description: string
  endsAt?: string
  previewError?: string | null
  previewRows: ScheduleTimePreviewRow[]
  repeatedTimes?: ScheduleRepeatedTime[]
  repeatedTimeConfirmation?: { checked: boolean, onChange: (checked: boolean) => void }
  startsAt?: string
}) {
  const uniquePreviewRows = previewRows.filter((row, index, rows) => (
    rows.findIndex((candidate) => candidate.timeZone === row.timeZone) === index
  ))

  return (
    <section className="schedule-time-basis" aria-label="Schedule time basis">
      <header>
        <Clock3 aria-hidden="true" size={19} />
        <div>
          <span>Time basis</span>
          <strong>{basisLabel}</strong>
        </div>
      </header>
      <p>{description}</p>
      {startsAt && endsAt && uniquePreviewRows.length ? (
        <div className="schedule-time-basis__preview" aria-label="Converted shift times">
          {uniquePreviewRows.map((row) => (
            <div key={`${row.label}:${row.timeZone}`}>
              <span>{row.label}</span>
              <strong>{formatScheduleTimeZoneRange(startsAt, endsAt, row.timeZone)}</strong>
              <small>Start: {formatScheduleInstantOffset(startsAt, row.timeZone)} · End: {formatScheduleInstantOffset(endsAt, row.timeZone)} · {scheduleElapsedTimeLabel(startsAt, endsAt)}</small>
            </div>
          ))}
        </div>
      ) : null}
      {repeatedTimes.length ? (
        <section className="form-note" aria-label="Repeated clock hour">
          <strong>This clock time happens twice.</strong>
          <p>The current scheduling service saves the second (standard-time) occurrence. The first occurrence is not selectable in this editor.</p>
          <ul>{repeatedTimes.map((item) => (
            <li key={`${item.endpoint}:${item.dateKey}:${item.timeZone}`}>
              {item.endpoint} · {item.dateKey.slice(5, 7)}/{item.dateKey.slice(8, 10)}/{item.dateKey.slice(0, 4)} · {formatDualTime(item.selectedInstant, { timeZone: item.timeZone })} · {formatScheduleInstantOffset(item.selectedInstant, item.timeZone)}
            </li>
          ))}</ul>
          {repeatedTimeConfirmation ? (
            <label className="check-field">
              <input checked={repeatedTimeConfirmation.checked} onChange={(event) => repeatedTimeConfirmation.onChange(event.target.checked)} type="checkbox" />
              Use the second (standard-time) occurrence shown above.
            </label>
          ) : <p>The saved range already identifies the occurrence; its stored time is not being reinterpreted.</p>}
        </section>
      ) : null}
      {previewError ? <p className="schedule-time-basis__error" role="alert">{previewError}</p> : null}
    </section>
  )
}

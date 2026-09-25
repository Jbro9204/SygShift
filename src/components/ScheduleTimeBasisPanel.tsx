import { Clock3 } from 'lucide-react'
import { formatScheduleTimeZoneRange } from '../schedule/timeBasis'

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
  startsAt,
}: {
  basisLabel: string
  description: string
  endsAt?: string
  previewError?: string | null
  previewRows: ScheduleTimePreviewRow[]
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
            </div>
          ))}
        </div>
      ) : null}
      {previewError ? <p className="schedule-time-basis__error" role="alert">{previewError}</p> : null}
    </section>
  )
}

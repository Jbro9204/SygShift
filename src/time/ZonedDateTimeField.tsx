import { useEffect, useId, useState } from 'react'
import { possibleZonedLocalDateTimeInstants, toZonedLocalDateTimeInput } from '../data/timeOperations'

interface OccurrenceProps {
  label: string
  name: string
  value: string
  timeZone?: string
  originalInstant?: string
  originalTimeZone?: string
  disabled?: boolean
  showError?: boolean
}

export function ZonedTimeOccurrenceChoice({
  label, name, value, timeZone = 'America/Denver', originalInstant, originalTimeZone, disabled = false, showError = true,
}: OccurrenceProps) {
  const id = useId()
  const scope = `${timeZone}|${value}`
  const [selection, setSelection] = useState<{ scope: string; instant: string } | null>(null)
  useEffect(() => { setSelection(null) }, [scope])
  let candidates: string[] = []
  let error = ''
  if (value) {
    try { candidates = possibleZonedLocalDateTimeInstants(value, timeZone) }
    catch (failure) { error = failure instanceof Error ? failure.message : 'Check this date and time.' }
  }
  if (error) return showError ? <small className="inline-alert" role="alert">{error}</small> : null
  if (candidates.length < 2) return null
  const originalMatches = originalInstant && (originalTimeZone ?? timeZone) === timeZone
    && toZonedLocalDateTimeInput(originalInstant, timeZone) === value
  const preservedOccurrence = originalMatches
    ? new Date(Math.floor(Date.parse(originalInstant) / 60_000) * 60_000).toISOString() : ''
  const selected = selection?.scope === scope ? selection.instant
    : candidates.includes(preservedOccurrence) ? preservedOccurrence : ''
  return <label htmlFor={id}>
    <span id={`${id}-label`}>{label} clock occurrence</span>
    <select aria-describedby={`${id}-help`} aria-labelledby={`${id}-label`} disabled={disabled} id={id} name={`${name}Occurrence`} onChange={(event) => setSelection({ scope, instant: event.target.value })} required value={selected}>
      <option value="">Choose first or second occurrence</option>
      {candidates.map((candidate, index) => <option key={candidate} value={candidate}>
        {index === 0 ? 'First occurrence' : 'Second occurrence'} — {new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'shortOffset' }).format(new Date(candidate))}
      </option>)}
    </select>
    <small className="field-help" id={`${id}-help`}>This time occurs twice in {timeZone}. Choose the occurrence that actually happened; reading the clock alone cannot distinguish them.</small>
  </label>
}

export function ZonedDateTimeField({
  label, name, timeZone = 'America/Denver', defaultValue, originalInstant, originalTimeZone, required = false, disabled = false, showError = true,
}: Omit<OccurrenceProps, 'value'> & { defaultValue?: string; required?: boolean }) {
  const id = useId()
  const [value, setValue] = useState(defaultValue ?? (originalInstant ? toZonedLocalDateTimeInput(originalInstant, originalTimeZone ?? timeZone) : ''))
  return <div>
    <label htmlFor={id}><span>{label}</span><input disabled={disabled} id={id} name={name} onChange={(event) => setValue(event.target.value)} required={required} type="datetime-local" value={value} /></label>
    <ZonedTimeOccurrenceChoice disabled={disabled} label={label} name={name} originalInstant={originalInstant} originalTimeZone={originalTimeZone} showError={showError} timeZone={timeZone} value={value} />
  </div>
}

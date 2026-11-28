import type { FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ShieldAlert, Timer } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { canAccessRoute } from '../app/accessPolicy'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import { getTimekeepingDashboard, type AttendanceReportResult, type TimekeepingShift } from '../data/timekeeping'
import { shiftDisplayTitle, shiftRequirementLabel } from '../lib/shiftDisplay'
import { isSupabaseConfigured } from '../lib/supabase'
import { dateKeyInTimeZone, formatDualTimeRange } from '../lib/time'
import { continentalUsTimeZoneShortLabel } from '../lib/usTimeZones'
import { TimeAlertCard, TimeButton, TimePageHeader } from './TimeKit'
import { useAttendanceReport, type AttendanceIssueType } from './useAttendanceReport'

export function UrgentCallOffPage() {
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const session = sessionQuery.data

  if (isSupabaseConfigured && sessionQuery.isPending) {
    return <DataStatePanel icon={Timer} title="Opening call-off form"><p>Checking your account access.</p></DataStatePanel>
  }

  if (!isSupabaseConfigured || sessionQuery.isError || !session || !canAccessRoute('/time/my-time', session)) {
    return (
      <DataStatePanel icon={ShieldAlert} title="Call-off form unavailable" tone="error">
        <p>We could not verify access to the call-off form. Contact Dispatch directly if you cannot work.</p>
        <Link className="secondary-button" to="/">Return to Home</Link>
      </DataStatePanel>
    )
  }

  return <UrgentCallOffForm employeeId={session.employeeId} key={session.employeeId} timeZone={session.timeZone} />
}

function UrgentCallOffForm({ employeeId, timeZone }: { employeeId: string; timeZone: string }) {
  const navigate = useNavigate()
  const dashboardQuery = useQuery({
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['urgent-call-off-shifts', employeeId],
  })
  // The existing date-only option remains available even if the optional shift list cannot load.
  const dashboard = dashboardQuery.data
  const report = useAttendanceReport(dashboard?.operationalDate)
  const shiftLookupMessage = dashboardQuery.isPending
    ? 'Looking for your assigned shifts. You can select a date and send the report without waiting.'
    : dashboardQuery.isError && !dashboard
      ? 'Assigned shifts could not be loaded. Select the date to send this report without a specific shift.'
      : undefined

  return (
    <section className="page page--sygshift-time">
      <TimePageHeader eyebrow="Time & Attendance" title="Call-off" summary="Tell Dispatch if you cannot work." />
      {report.mutation.isSuccess ? (
        <AttendanceReportSuccess result={report.mutation.data} />
      ) : (
        <AttendanceReportModal
          {...report.form}
          errorMessage={report.mutation.isError ? 'We could not confirm that the report was sent. Your entries are still here. If you cannot confirm delivery, contact Dispatch directly.' : undefined}
          onClose={() => navigate('/', { replace: true })}
          shiftLookupMessage={shiftLookupMessage}
          shifts={dashboard?.eligibleShifts ?? []}
          timeZone={dashboard?.employee.timeZone ?? timeZone}
        />
      )}
      <Link className="secondary-button" to="/">Return to Home</Link>
    </section>
  )
}

export function AttendanceReportSuccess({ result }: { result: AttendanceReportResult }) {
  return (
    <TimeAlertCard icon={CheckCircle2} title="Attendance report saved" tone={result.dispatchNotified ? 'good' : 'warning'}>
      <p>
        {result.dispatchNotified
          ? 'Dispatch was notified automatically.'
          : `The report was saved, but Dispatch email needs follow-up${result.dispatchError ? `: ${result.dispatchError}` : '.'}`}
      </p>
    </TimeAlertCard>
  )
}

export function AttendanceReportModal({
  date,
  errorMessage,
  eventType,
  note,
  onChangeDate,
  onChangeEventType,
  onChangeNote,
  onChangeShiftId,
  onClose,
  onSubmit,
  pending,
  selectedShiftId,
  shiftLookupMessage,
  shifts,
  timeZone,
}: {
  date: string
  errorMessage?: string
  eventType: AttendanceIssueType
  note: string
  onChangeDate: (value: string) => void
  onChangeEventType: (value: AttendanceIssueType) => void
  onChangeNote: (value: string) => void
  onChangeShiftId: (value: string) => void
  onClose: () => void
  onSubmit: () => void
  pending: boolean
  selectedShiftId: string
  shiftLookupMessage?: string
  shifts: TimekeepingShift[]
  timeZone: string
}) {
  const selectedShift = shifts.find((shift) => shift.shiftId === selectedShiftId)
  // The attendance RPC records a linked absence on the shift's local start date.
  const reportDate = selectedShift
    ? dateKeyInTimeZone(new Date(selectedShift.startsAt), selectedShift.timeZone)
    : date
  const noteReady = note.trim().length > 0
  const canSubmit = noteReady && (selectedShiftId || date)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canSubmit && !pending) onSubmit()
  }

  return (
    <ModalDialog
      busy={pending}
      busyLabel="Saving report and notifying Dispatch..."
      className="modal-dialog--attendance-report"
      description="Report a sick call or call-off without removing yourself from the shift until coverage is handled."
      onClose={onClose}
      title="Report sick or call-off"
    >
      <form className="attendance-report-form" onSubmit={submit}>
        <TimeAlertCard icon={AlertTriangle} title="Important coverage rule" tone="warning">
          <p>Your shift remains your responsibility until coverage is approved. This report alerts Dispatch so coverage can be worked immediately.</p>
        </TimeAlertCard>

        {errorMessage ? <p className="inline-alert" role="alert">{errorMessage}</p> : null}
        {shiftLookupMessage ? <p role="status">{shiftLookupMessage}</p> : null}

        <fieldset className="attendance-report-choice-grid">
          <legend>What are you reporting?</legend>
          <label className={eventType === 'called_in_sick' ? 'attendance-report-choice attendance-report-choice--selected' : 'attendance-report-choice'}>
            <input
              checked={eventType === 'called_in_sick'}
              disabled={pending}
              name="attendance-report-type"
              onChange={() => onChangeEventType('called_in_sick')}
              type="radio"
            />
            <span>
              <strong>Called in sick</strong>
              <small>Use this for illness or sickness-related absence.</small>
            </span>
          </label>
          <label className={eventType === 'call_off' ? 'attendance-report-choice attendance-report-choice--selected' : 'attendance-report-choice'}>
            <input
              checked={eventType === 'call_off'}
              disabled={pending}
              name="attendance-report-type"
              onChange={() => onChangeEventType('call_off')}
              type="radio"
            />
            <span>
              <strong>Call-off / cannot work</strong>
              <small>Use this for other last-minute coverage issues.</small>
            </span>
          </label>
        </fieldset>

        <div className="attendance-report-grid">
          <label>
            <span>Shift</span>
            <select disabled={pending} onChange={(event) => onChangeShiftId(event.target.value)} value={selectedShiftId}>
              <option value="">No specific shift / date only</option>
              {shifts.map((shift) => (
                <option key={shift.assignmentId} value={shift.shiftId}>
                  {formatShiftDate(shift.startsAt, timeZone)} - {shiftTitle(shift)} - {shiftRequirementLabel(shift.requiresArmed)} - {shiftLocation(shift)} - {employeeShiftTimeLabel(shift, timeZone)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Date</span>
            <input disabled={pending || Boolean(selectedShiftId)} onChange={(event) => onChangeDate(event.target.value)} type="date" value={reportDate} />
          </label>
        </div>

        <label className="attendance-report-note">
          <span>Short note</span>
          <textarea
            disabled={pending}
            maxLength={2000}
            onChange={(event) => onChangeNote(event.target.value)}
            placeholder="Example: I am sick and cannot work tonight. I will be available by phone if Dispatch needs details."
            rows={5}
            value={note}
          />
          <small>{note.trim().length}/2000 characters</small>
        </label>

        <div className="modal-actions attendance-report-actions">
          <button className="secondary-button" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <TimeButton disabled={!canSubmit} loading={pending} type="submit" variant="primary">
            Send to Dispatch
          </TimeButton>
        </div>
      </form>
    </ModalDialog>
  )
}

function formatShiftDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(new Date(value))
}

function shiftLocation(shift: TimekeepingShift): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' - ') || 'Location pending'
}

function shiftTitle(shift: TimekeepingShift): string {
  return shiftDisplayTitle(shift)
}

function employeeShiftTimeLabel(shift: TimekeepingShift, employeeTimeZone: string): string {
  const employeeTime = `Employee Time — ${continentalUsTimeZoneShortLabel(employeeTimeZone)}: ${formatDualTimeRange(shift.startsAt, shift.endsAt, employeeTimeZone)}`
  if (shift.timeZone === employeeTimeZone) return employeeTime
  const employeeDate = formatShiftDate(shift.startsAt, employeeTimeZone)
  const siteDate = formatShiftDate(shift.startsAt, shift.timeZone)
  const siteDateLabel = siteDate === employeeDate ? '' : `${siteDate} `
  return `${employeeTime} · Site Time — ${continentalUsTimeZoneShortLabel(shift.timeZone)}: ${siteDateLabel}${formatDualTimeRange(shift.startsAt, shift.endsAt, shift.timeZone)}`
}

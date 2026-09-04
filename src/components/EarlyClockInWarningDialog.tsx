import { ClockAlert, ShieldCheck } from 'lucide-react'
import {
  formatClockInDurationUntil,
  formatClockInWaitDuration,
  type EarlyClockInBlockedDetails,
} from '../data/timekeeping'
import { formatDualTime, formatOperationalDate } from '../lib/time'
import {
  continentalUsTimeZoneLabel,
  personalDisplayTimeZone,
} from '../lib/usTimeZones'
import { ModalDialog } from './ModalDialog'

export function EarlyClockInWarningDialog({
  details,
  onAcknowledge,
}: {
  details: EarlyClockInBlockedDetails
  onAcknowledge: () => void
}) {
  const shiftDuration = formatClockInWaitDuration(details.scheduledShiftStart, details.trustedServerTime)
  const eligibilityDuration = formatClockInDurationUntil(details.clockInEligibleAt, details.trustedServerTime)
  const employeeTimeZone = personalDisplayTimeZone(details.employeeTimeZone ?? details.timeZone)
  const employeeTimeZoneLabel = continentalUsTimeZoneLabel(employeeTimeZone)
  const currentTime = formatDualTime(details.trustedServerTime, { includeTimeZoneName: true, timeZone: employeeTimeZone })
  const eligibleTime = formatDualTime(details.clockInEligibleAt, { includeTimeZoneName: true, timeZone: employeeTimeZone })
  const shiftStartTime = formatDualTime(details.scheduledShiftStart, { includeTimeZoneName: true, timeZone: employeeTimeZone })
  const shiftEndTime = details.scheduledShiftEnd
    ? formatDualTime(details.scheduledShiftEnd, { includeTimeZoneName: true, timeZone: employeeTimeZone })
    : null
  const systemTime = formatDualTime(details.trustedServerTime, {
    includeTimeZoneName: true,
    timeZone: 'America/Denver',
  })
  const siteLine = [details.siteCode, details.siteName].filter(Boolean).join(' · ')

  return (
    <ModalDialog
      className="modal-dialog--early-clock-in"
      description={`Your scheduled shift starts in ${shiftDuration}.`}
      dialogRole="alertdialog"
      dismissible={false}
      eyebrow="CLOCK-IN UNAVAILABLE"
      headingIcon={<ClockAlert size={24} />}
      onClose={onAcknowledge}
      title="Your shift hasn’t started yet"
    >
      <div
        aria-label="Early clock-in restriction details"
        className="early-clock-in-restriction"
        tabIndex={0}
      >
        <section className="early-clock-in-availability" aria-labelledby="clock-in-window-title">
          <div>
            <span id="clock-in-window-title">Your clock-in window opens at</span>
            <strong>{eligibleTime}</strong>
          </div>
          <span className="early-clock-in-availability__pill">In {eligibilityDuration}</span>
          <p>You may clock in up to 5 minutes early. Please return at or after {eligibleTime}.</p>
        </section>

        <ol aria-label="Clock-in timing" className="early-clock-in-timeline">
          <li>
            <span>Your current time · {employeeTimeZoneLabel}</span>
            <strong>{currentTime}</strong>
          </li>
          <li>
            <span>Clock-in opens</span>
            <strong>{eligibleTime}</strong>
          </li>
          <li>
            <span>Shift starts</span>
            <strong>{shiftStartTime}</strong>
          </li>
        </ol>

        <section className="early-clock-in-shift" aria-labelledby="scheduled-shift-title">
          <span className="early-clock-in-shift__eyebrow" id="scheduled-shift-title">SCHEDULED SHIFT</span>
          <strong>{details.shiftDisplayName}</strong>
          <p>{[siteLine || details.locationName, details.coverageType].filter(Boolean).join(' · ')}</p>
          <p>{formatOperationalDate(new Date(details.scheduledShiftStart), employeeTimeZone)}</p>
          <p>{shiftStartTime}{shiftEndTime ? ` – ${shiftEndTime}` : ''}</p>
        </section>

        <p className="early-clock-in-server-note">
          Your schedule is shown in {employeeTimeZoneLabel}. SygShift verified this attempt at {systemTime} using trusted server time.
        </p>

        <div className="early-clock-in-footer-note">
          <ShieldCheck aria-hidden="true" size={21} />
          <strong>Acknowledging this notice will not clock you in.</strong>
        </div>
      </div>
      <div className="early-clock-in-restriction__actions">
        <button autoFocus className="primary-action" onClick={onAcknowledge} type="button">
          Acknowledge &amp; close
        </button>
      </div>
    </ModalDialog>
  )
}

export function EarlyClockInAcknowledgmentNotice({ details }: { details: EarlyClockInBlockedDetails }) {
  return (
    <div className="early-clock-in-acknowledged" role="status">
      <ShieldCheck aria-hidden="true" size={20} />
      <span>
        <strong>Notice acknowledged</strong>
        You can try clocking in again at {formatDualTime(details.clockInEligibleAt, {
          includeTimeZoneName: true,
          timeZone: personalDisplayTimeZone(details.employeeTimeZone ?? details.timeZone),
        })}.
      </span>
    </div>
  )
}

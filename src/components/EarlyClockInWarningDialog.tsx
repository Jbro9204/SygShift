import { ShieldAlert } from 'lucide-react'
import { formatClockInWaitDuration } from '../data/timekeeping'
import { formatDualTime } from '../lib/time'
import { ModalDialog } from './ModalDialog'

export function EarlyClockInWarningDialog({
  locationName,
  onAcknowledge,
  serverTimestamp,
  shiftStartsAt,
  timeZone,
}: {
  locationName: string
  onAcknowledge: () => void
  serverTimestamp: string
  shiftStartsAt: string
  timeZone: string
}) {
  const waitDuration = formatClockInWaitDuration(shiftStartsAt, serverTimestamp)

  return (
    <ModalDialog
      className="modal-dialog--early-clock-in"
      description="Clock-in is not available yet. Review the scheduled start time before continuing."
      dismissible={false}
      onClose={onAcknowledge}
      title="Too early to clock in"
    >
      <div className="early-clock-in-warning" role="alert">
        <ShieldAlert aria-hidden="true" size={42} />
        <div>
          <strong>Your shift does not start for {waitDuration}.</strong>
          <p>
            Your shift begins at {formatDualTime(shiftStartsAt, { timeZone })} at {locationName}.
            Clock-in becomes available five minutes before the scheduled start.
          </p>
        </div>
      </div>
      <div className="early-clock-in-warning__actions">
        <button autoFocus className="danger-button" onClick={onAcknowledge} type="button">
          I understand
        </button>
      </div>
    </ModalDialog>
  )
}

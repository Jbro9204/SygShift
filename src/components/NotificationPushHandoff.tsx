import { useEffect, useRef, useState } from 'react'
import {
  isOfficialSygShiftOrigin,
  launchSygilantPlatform,
  parseSygilantPlatformDestination,
  submitSygilantPlatformLaunch,
} from '../data/platformLaunch'
import { markMyNotificationRead } from '../data/notifications'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function NotificationPushHandoff({
  destinationValue,
  notificationId,
}: {
  destinationValue: string
  notificationId: string | null
}) {
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const destination = parseSygilantPlatformDestination(destinationValue)

  useEffect(() => {
    if (started.current || !destination) return
    started.current = true

    if (!isOfficialSygShiftOrigin()) {
      setError('Open this notification from the official SygShift address to continue securely.')
      return
    }

    // Read-state synchronization is intentionally independent of the operational handoff.
    if (notificationId && uuidPattern.test(notificationId)) {
      void markMyNotificationRead(notificationId).catch(() => undefined)
    }

    void launchSygilantPlatform(destination)
      .then(submitSygilantPlatformLaunch)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Sygilant could not be opened securely. Please try again.')
      })
  }, [destination, notificationId])

  if (!destination) {
    return <div className="inline-alert" role="alert">This notification link is invalid. Open the related item from your notification inbox.</div>
  }
  if (error) return <div className="inline-alert" role="alert">{error}</div>
  return <div className="inline-alert" role="status">Opening the related Sygilant item securely…</div>
}

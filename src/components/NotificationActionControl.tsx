import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  isOfficialSygShiftOrigin,
  launchSygilantPlatform,
  submitSygilantPlatformLaunch,
} from '../data/platformLaunch'
import {
  resolveNotificationAction,
  type NotificationActionReference,
} from '../data/notificationActions'

type NotificationActionControlProps = NotificationActionReference & {
  children: ReactNode
  className?: string
  disabled?: boolean
  inactiveClassName?: string
  onBeforeLaunch?: () => Promise<void> | void
  onLaunchPrepared?: () => Promise<void> | void
  showInactive?: boolean
}

export function NotificationActionControl({
  actionPath,
  children,
  className,
  disabled = false,
  inactiveClassName,
  onBeforeLaunch,
  onLaunchPrepared,
  showInactive = false,
  sourceId,
  sourceType,
}: NotificationActionControlProps) {
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const action = resolveNotificationAction({ actionPath, sourceId, sourceType })

  if (action.kind === 'local') {
    return <Link className={className} onClick={() => {
      try { void Promise.resolve(onBeforeLaunch?.()).catch(() => undefined) } catch { /* Best-effort UI state. */ }
      try { void Promise.resolve(onLaunchPrepared?.()).catch(() => undefined) } catch { /* Best-effort UI state. */ }
    }} to={action.path}>{children}</Link>
  }
  if (action.kind === 'none') {
    return showInactive ? <div className={inactiveClassName}>{children}</div> : null
  }
  const destination = action.destination

  async function openSygilant() {
    if (launching) return
    if (!isOfficialSygShiftOrigin()) {
      setError('Open this notification from the official SygShift address to continue securely.')
      return
    }
    setLaunching(true)
    setError(null)
    try {
      try { void Promise.resolve(onBeforeLaunch?.()).catch(() => undefined) } catch {
        // Read-state synchronization must never block an operational handoff.
      }
      const launch = await launchSygilantPlatform(destination)
      submitSygilantPlatformLaunch(launch)
      try { await onLaunchPrepared?.() } catch { /* The prepared handoff already succeeded. */ }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sygilant could not be opened securely. Please try again.')
      setLaunching(false)
    }
  }

  return <>
    <button
      aria-busy={launching}
      className={className}
      disabled={disabled || launching}
      onClick={() => void openSygilant()}
      type="button"
    >
      {children}
    </button>
    {error ? <span className="notification-action-error" role="alert">{error}</span> : null}
  </>
}

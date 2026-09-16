import { useEffect } from 'react'
import { recordPlatformPresence, type PlatformApplication } from '../data/platformPresence'
import {
  PLATFORM_PRESENCE_HEARTBEAT_MS,
  PLATFORM_PRESENCE_THROTTLE_MS,
  platformPresenceState,
} from '../lib/platformPresenceState'

const CLIENT_INSTANCE_KEY = 'syg.platform-presence.client.v1'

function presenceClientId(): string {
  const next = crypto.randomUUID()
  try {
    const existing = window.sessionStorage.getItem(CLIENT_INSTANCE_KEY)
    if (existing) return existing
    window.sessionStorage.setItem(CLIENT_INSTANCE_KEY, next)
  } catch { /* A memory-only ID still gives this mounted tab an isolated presence record. */ }
  return next
}

export function PlatformPresenceReporter({ application = 'sygshift' }: { application?: PlatformApplication }) {
  useEffect(() => {
    const clientId = presenceClientId()
    let disposed = false
    let lastInteractionAt = Date.now()
    let lastSentAt = 0
    let lastSentState: 'active' | 'away' | null = null
    let requestPending = false

    const send = (force = false) => {
      if (disposed || !navigator.onLine || requestPending) return
      const now = Date.now()
      const state = platformPresenceState(document.visibilityState, lastInteractionAt, now)
      if (!force && state === lastSentState && now - lastSentAt < PLATFORM_PRESENCE_THROTTLE_MS) return
      requestPending = true
      void recordPlatformPresence(clientId, application, state)
        .then(() => {
          lastSentAt = Date.now()
          lastSentState = state
        })
        .catch(() => undefined)
        .finally(() => { requestPending = false })
    }

    const noteInteraction = () => {
      lastInteractionAt = Date.now()
      if (lastSentState !== 'active') send(true)
    }
    const handleVisibility = () => send(true)
    const handleFocus = () => { lastInteractionAt = Date.now(); send(true) }
    const handleOnline = () => send(true)

    const interval = window.setInterval(() => send(), PLATFORM_PRESENCE_HEARTBEAT_MS)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('online', handleOnline)
    window.addEventListener('pointerdown', noteInteraction, { passive: true })
    window.addEventListener('keydown', noteInteraction)
    window.addEventListener('touchstart', noteInteraction, { passive: true })
    document.addEventListener('visibilitychange', handleVisibility)
    send(true)

    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('pointerdown', noteInteraction)
      window.removeEventListener('keydown', noteInteraction)
      window.removeEventListener('touchstart', noteInteraction)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [application])

  return null
}

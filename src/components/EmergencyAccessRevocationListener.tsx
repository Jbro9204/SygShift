import { useEffect, useRef } from 'react'
import { notifySessionContextChanged } from '../data/auth'
import { acknowledgeEmergencyPlatformSessionRevocation } from '../data/emergencyAccessSession'
import { getSupabaseClient } from '../lib/supabase'

const REVOCATION_ACKNOWLEDGEMENT_TIMEOUT_MS = 4_000
const LIFECYCLE_REVALIDATION_DELAY_MS = 150

type EmergencyAccessRevocationListenerProps = {
  onRevoking: () => Promise<void> | void
  onRevoked: () => Promise<void> | void
}

export function EmergencyAccessRevocationListener({ onRevoked, onRevoking }: EmergencyAccessRevocationListenerProps) {
  const onRevokedRef = useRef(onRevoked)
  const onRevokingRef = useRef(onRevoking)

  useEffect(() => {
    onRevokedRef.current = onRevoked
    onRevokingRef.current = onRevoking
  }, [onRevoked, onRevoking])

  useEffect(() => {
    const client = getSupabaseClient()
    let active = true
    let handled = false
    let revalidationTimer: number | undefined
    let channel: ReturnType<typeof client.channel> | undefined

    const revalidate = () => {
      if (document.visibilityState !== 'visible') return
      if (revalidationTimer !== undefined) window.clearTimeout(revalidationTimer)
      revalidationTimer = window.setTimeout(() => {
        revalidationTimer = undefined
        if (active && document.visibilityState === 'visible') notifySessionContextChanged()
      }, LIFECYCLE_REVALIDATION_DELAY_MS)
    }

    const connect = async () => {
      const { data } = await client.auth.getSession()
      if (!active || !data.session) return
      const authUserId = data.session.user.id
      await client.realtime.setAuth(data.session.access_token)
      if (!active) return
      channel = client.channel(`employee:${authUserId}`, { config: { private: true } })
        .on('broadcast', { event: 'access-revoked' }, (event) => {
          if (!active || handled) return
          const payload = event.payload && typeof event.payload === 'object'
            ? event.payload as Record<string, unknown>
            : {}
          if (typeof payload.authUserId === 'string' && payload.authUserId !== authUserId) return
          handled = true
          void (async () => {
            try {
              await Promise.resolve(onRevokingRef.current())
            } catch {
              // A UI teardown failure must not prevent acknowledgement or credential clearing.
            }
            const operationId = typeof payload.operationId === 'string' ? payload.operationId : ''
            const accessGeneration = typeof payload.accessGeneration === 'number'
              ? payload.accessGeneration
              : 0
            const controller = new AbortController()
            const timeout = window.setTimeout(() => controller.abort(), REVOCATION_ACKNOWLEDGEMENT_TIMEOUT_MS)
            try {
              await acknowledgeEmergencyPlatformSessionRevocation(
                operationId,
                accessGeneration,
                data.session.access_token,
                controller.signal,
              )
            } catch {
              // Authorization is already closed centrally. Local teardown must still complete.
            } finally {
              window.clearTimeout(timeout)
              await Promise.resolve(onRevokedRef.current())
            }
          })()
        })
        .subscribe()
    }

    void connect().catch(() => {
      // Focus, reconnect, and protected requests still revalidate the central session authority.
    })
    window.addEventListener('focus', revalidate)
    window.addEventListener('online', revalidate)
    document.addEventListener('visibilitychange', revalidate)

    return () => {
      active = false
      if (revalidationTimer !== undefined) window.clearTimeout(revalidationTimer)
      if (channel) void client.removeChannel(channel)
      window.removeEventListener('focus', revalidate)
      window.removeEventListener('online', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [])

  return null
}

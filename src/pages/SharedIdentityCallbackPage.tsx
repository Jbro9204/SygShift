import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { activateSharedIdentitySupabaseSession, deactivateSharedIdentitySupabaseSession } from '../lib/supabase'
import {
  publishSharedIdentityBrowserEvent,
  subscribeToSharedIdentityBrowserEvents,
} from '../lib/sharedIdentityBrowserSync'
import {
  clearSharedIdentityServerSession,
  setSharedIdentitySession,
  waitForSharedIdentityLogoutBarrier,
  type SharedIdentityScope,
} from '../lib/sharedIdentitySession'

type SharedIdentityDestination = '/' | '/sygsphere'

type FinalizationResponse = {
  destination: SharedIdentityDestination
  expiresAt: string
  persistent: boolean
  scope: SharedIdentityScope
  sharedIdentityToken: string
  supabaseSession: {
    accessToken: string
    refreshToken: string
  }
}

export function SharedIdentityCallbackPage() {
  const [error, setError] = useState<string | null>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const handoffFailed = new URLSearchParams(location.search).get('handoff') === 'failed'

  useEffect(() => {
    let active = true
    const barrierController = new AbortController()
    const stopForBrowserSignOut = subscribeToSharedIdentityBrowserEvents((action) => {
      if (action !== 'cleared') return
      active = false
      barrierController.abort()
    })
    void (async () => {
      try {
        window.history.replaceState(null, '', '/auth/shared-identity/callback')
        if (handoffFailed) {
          throw new Error('Sygilant could not complete the shared sign-in. Return to Sygilant and try the SygShift button again.')
        }
        await waitForSharedIdentityLogoutBarrier(barrierController.signal)
        if (!active) return
        const response = await fetch('/api/v1/auth/shared-identity/finalize', {
          cache: 'no-store',
          credentials: 'same-origin',
          method: 'POST',
        })
        const payload = await response.json().catch(() => null) as Partial<FinalizationResponse> | null
        if (!response.ok || !isFinalizationResponse(payload)) {
          throw new Error('The shared SygShift session could not be verified.')
        }
        if (!active) throw new Error('The shared sign-in was cancelled.')
        await activateSharedIdentitySupabaseSession(
          payload.supabaseSession.accessToken,
          payload.supabaseSession.refreshToken,
        )
        if (!active) throw new Error('The shared sign-in was cancelled.')
        if (!setSharedIdentitySession(
          payload.sharedIdentityToken,
          payload.expiresAt,
          payload.persistent,
          payload.scope,
        )) throw new Error('A previous sign-out is still completing. Try opening SygShift again.')
        if (!active) throw new Error('The shared sign-in was cancelled.')
        publishSharedIdentityBrowserEvent('updated')
        navigate(payload.destination, { replace: true })
      } catch (callbackError) {
        // Never let remote cookie cleanup strand the callback on its loading
        // screen. Local bearer material is cleared synchronously; the durable
        // logout barrier keeps a later sign-in from restoring the cookie until
        // the server cleanup can be retried successfully.
        deactivateSharedIdentitySupabaseSession()
        if (active) setError(callbackError instanceof Error ? callbackError.message : 'SygShift could not be opened.')
        void clearSharedIdentityServerSession().catch(() => undefined)
      }
    })()
    return () => {
      active = false
      barrierController.abort()
      stopForBrowserSignOut()
    }
  }, [handoffFailed, navigate])

  return (
    <main className="security-page">
      <section className="security-card security-card--compact" role={error ? 'alert' : 'status'}>
        <ShieldCheck aria-hidden="true" size={36} />
        <h1>{error ? 'SygShift could not open.' : 'Opening SygShift…'}</h1>
        <p>{error ?? 'SygShift is completing your protected shared session.'}</p>
        {error ? (
          <div className="shared-identity-callback__actions">
            <a className="primary-action" href="/login">Sign in directly to SygShift</a>
            <a className="secondary-button" href="https://sygilant.us">Return to Sygilant</a>
          </div>
        ) : null}
      </section>
    </main>
  )
}

function isFinalizationResponse(payload: Partial<FinalizationResponse> | null): payload is FinalizationResponse {
  if (!payload) return false
  const expectedScope = payload.destination === '/'
    ? 'platform'
    : payload.destination === '/sygsphere'
      ? 'sygsphere'
      : null
  return Boolean(
    expectedScope
    && payload.scope === expectedScope
    && typeof payload.sharedIdentityToken === 'string'
    && typeof payload.expiresAt === 'string'
    && typeof payload.persistent === 'boolean'
    && typeof payload.supabaseSession?.accessToken === 'string'
    && typeof payload.supabaseSession.refreshToken === 'string',
  )
}

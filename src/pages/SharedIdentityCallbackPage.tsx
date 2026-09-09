import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { activateSharedIdentitySupabaseSession, deactivateSharedIdentitySupabaseSession } from '../lib/supabase'
import { publishSharedIdentityBrowserEvent } from '../lib/sharedIdentityBrowserSync'
import {
  clearSharedIdentityServerSession,
  setSharedIdentitySession,
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
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        window.history.replaceState(null, '', '/auth/shared-identity/callback')
        const response = await fetch('/api/v1/auth/shared-identity/finalize', {
          cache: 'no-store',
          credentials: 'same-origin',
          method: 'POST',
        })
        const payload = await response.json().catch(() => null) as Partial<FinalizationResponse> | null
        if (!response.ok || !isFinalizationResponse(payload)) {
          throw new Error('The shared SygShift session could not be verified.')
        }
        await activateSharedIdentitySupabaseSession(
          payload.supabaseSession.accessToken,
          payload.supabaseSession.refreshToken,
        )
        setSharedIdentitySession(
          payload.sharedIdentityToken,
          payload.expiresAt,
          payload.persistent,
          payload.scope,
        )
        publishSharedIdentityBrowserEvent('updated')
        navigate(payload.destination, { replace: true })
      } catch (callbackError) {
        await clearSharedIdentityServerSession()
        deactivateSharedIdentitySupabaseSession()
        if (active) setError(callbackError instanceof Error ? callbackError.message : 'SygShift could not be opened.')
      }
    })()
    return () => { active = false }
  }, [navigate])

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

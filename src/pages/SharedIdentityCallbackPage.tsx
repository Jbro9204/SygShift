import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { activateSharedIdentitySupabaseSession } from '../lib/supabase'
import { setSharedIdentitySession } from '../lib/sharedIdentitySession'

type FinalizationResponse = {
  destination: '/sygsphere'
  expiresAt: string
  persistent: boolean
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
        if (
          !response.ok
          || payload?.destination !== '/sygsphere'
          || typeof payload.sharedIdentityToken !== 'string'
          || typeof payload.expiresAt !== 'string'
          || typeof payload.persistent !== 'boolean'
          || typeof payload.supabaseSession?.accessToken !== 'string'
          || typeof payload.supabaseSession.refreshToken !== 'string'
        ) throw new Error('The shared SygSphere session could not be verified.')
        await activateSharedIdentitySupabaseSession(
          payload.supabaseSession.accessToken,
          payload.supabaseSession.refreshToken,
        )
        setSharedIdentitySession(payload.sharedIdentityToken, payload.expiresAt, payload.persistent)
        navigate(payload.destination, { replace: true })
      } catch (callbackError) {
        if (active) setError(callbackError instanceof Error ? callbackError.message : 'SygSphere could not be opened.')
      }
    })()
    return () => { active = false }
  }, [navigate])

  return (
    <main className="security-page">
      <section className="security-card security-card--compact" role={error ? 'alert' : 'status'}>
        <ShieldCheck aria-hidden="true" size={36} />
        <h1>{error ? 'SygSphere could not open.' : 'Opening SygSphere…'}</h1>
        <p>{error ?? 'SygShift is completing your protected shared session.'}</p>
        {error ? <a className="secondary-button" href="https://sygilant.us/sygsphere">Return to Sygilant</a> : null}
      </section>
    </main>
  )
}

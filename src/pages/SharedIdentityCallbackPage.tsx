import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getSupabaseClient } from '../lib/supabase'
import { setSharedIdentitySession } from '../lib/sharedIdentitySession'

type FinalizationResponse = {
  destination: '/sygsphere'
  expiresAt: string
  persistent: boolean
  sharedIdentityToken: string
}

export function SharedIdentityCallbackPage() {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const { data, error: sessionError } = await getSupabaseClient().auth.getSession()
        const accessToken = data.session?.access_token
        if (sessionError || !accessToken) throw new Error('The SygShift session could not be established.')
        window.history.replaceState(null, '', '/auth/shared-identity/callback')
        const response = await fetch('/api/v1/auth/shared-identity/finalize', {
          headers: { authorization: `Bearer ${accessToken}` },
          method: 'POST',
        })
        const payload = await response.json().catch(() => null) as Partial<FinalizationResponse> | null
        if (
          !response.ok
          || payload?.destination !== '/sygsphere'
          || typeof payload.sharedIdentityToken !== 'string'
          || typeof payload.expiresAt !== 'string'
          || typeof payload.persistent !== 'boolean'
        ) throw new Error('The shared SygSphere session could not be verified.')
        setSharedIdentitySession(payload.sharedIdentityToken, payload.expiresAt, payload.persistent)
        window.location.replace(payload.destination)
      } catch (callbackError) {
        if (active) setError(callbackError instanceof Error ? callbackError.message : 'SygSphere could not be opened.')
      }
    })()
    return () => { active = false }
  }, [])

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

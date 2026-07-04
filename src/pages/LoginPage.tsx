import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react'
import { getSessionContext, signInWithUsername } from '../data/auth'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'

type LoginLocationState = {
  from?: {
    pathname?: string
    search?: string
    hash?: string
  }
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(isSupabaseConfigured)
  const [alreadySignedIn, setAlreadySignedIn] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const returnPath = useMemo(() => {
    const state = location.state as LoginLocationState | null
    const from = state?.from
    return `${from?.pathname ?? '/'}${from?.search ?? ''}${from?.hash ?? ''}`
  }, [location.state])

  useEffect(() => {
    let active = true

    async function checkSession() {
      if (!isSupabaseConfigured) {
        setCheckingSession(false)
        return
      }

      const { data } = await getSupabaseClient().auth.getSession()
      if (!active) return

      if (!data.session) {
        setCheckingSession(false)
        return
      }

      try {
        await getSessionContext()
        if (active) setAlreadySignedIn(true)
      } catch {
        await getSupabaseClient().auth.signOut()
      } finally {
        if (active) setCheckingSession(false)
      }
    }

    void checkSession()

    return () => {
      active = false
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setLoading(true)

    try {
      await signInWithUsername(username, password)
      navigate(returnPath, { replace: true })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The sign-in request failed.')
    } finally {
      setLoading(false)
    }
  }

  if (alreadySignedIn) {
    return <Navigate to={returnPath} replace />
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card__brand">
          <img src="/brand/sygshift-logo.png" alt="SygShift" />
          <span>Secure workforce access</span>
        </div>

        <div className="login-card__heading">
          <p className="eyebrow">SygShift</p>
          <h1 id="login-title">Sign in to your schedule workspace.</h1>
          <p>
            Use the username assigned in the employee directory. Administrators and supervisors
            will be asked for an authenticator code before protected tools open.
          </p>
        </div>

        {!isSupabaseConfigured ? (
          <div className="auth-notice auth-notice--warning" role="status">
            <ShieldCheck aria-hidden="true" size={22} />
            <div>
              <strong>Supabase is not configured on this workstation yet.</strong>
              <span>Add the browser-safe Supabase URL and publishable key to activate login.</span>
            </div>
          </div>
        ) : null}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="field-label">
            <span>Username</span>
            <input
              autoCapitalize="none"
              autoComplete="username"
              disabled={!isSupabaseConfigured || checkingSession || loading}
              inputMode="text"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="jbrown"
              required
              type="text"
              value={username}
            />
          </label>

          <label className="field-label">
            <span>Password</span>
            <input
              autoComplete="current-password"
              disabled={!isSupabaseConfigured || checkingSession || loading}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>

          {errorMessage ? (
            <div className="auth-notice auth-notice--error" role="alert">
              <LockKeyhole aria-hidden="true" size={21} />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <button
            className="primary-action login-submit"
            disabled={!isSupabaseConfigured || checkingSession || loading}
            type="submit"
          >
            <KeyRound aria-hidden="true" size={20} />
            {loading ? 'Checking access…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}

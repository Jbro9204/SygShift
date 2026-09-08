import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Eye, EyeOff, KeyRound, LockKeyhole, MailCheck, ShieldCheck } from 'lucide-react'
import { getSessionContext, requestPasswordReset, signInWithUsername, signOut } from '../data/auth'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { beginLoginSound, cancelLoginSound } from '../lib/notificationSounds'

type LoginLocationState = {
  from?: {
    pathname?: string
    search?: string
    hash?: string
  }
  message?: string
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
  const [showPassword, setShowPassword] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)

  const returnPath = useMemo(() => {
    const state = location.state as LoginLocationState | null
    const from = state?.from
    return `${from?.pathname ?? '/'}${from?.search ?? ''}${from?.hash ?? ''}`
  }, [location.state])
  const completionMessage = (location.state as LoginLocationState | null)?.message ?? null

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
        await signOut()
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
    beginLoginSound(username)
    setErrorMessage(null)
    setLoading(true)

    try {
      await signInWithUsername(username, password)
      navigate(returnPath, { replace: true })
    } catch (error) {
      cancelLoginSound()
      setErrorMessage(error instanceof Error ? error.message : 'The sign-in request failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handlePasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setRecoveryMessage(null)
    setLoading(true)

    try {
      setRecoveryMessage(await requestPasswordReset(username))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Password recovery is temporarily unavailable.')
    } finally {
      setLoading(false)
    }
  }

  function openPasswordRecovery() {
    setErrorMessage(null)
    setRecoveryMessage(null)
    setRecoveryMode(true)
  }

  function closePasswordRecovery() {
    setErrorMessage(null)
    setRecoveryMessage(null)
    setRecoveryMode(false)
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

        <form className="login-form" onSubmit={recoveryMode ? handlePasswordReset : handleSubmit}>
          {recoveryMode ? (
            <div className="login-recovery__intro">
              <p className="eyebrow">Password recovery</p>
              <h2>Reset your password</h2>
              <p>
                Enter your SygShift username. If the account is active, we’ll send a secure,
                single-use reset link to the approved personal email on file.
              </p>
            </div>
          ) : null}

          {completionMessage && !recoveryMode ? (
            <div className="auth-notice auth-notice--success" role="status">
              <MailCheck aria-hidden="true" size={21} />
              <span>{completionMessage}</span>
            </div>
          ) : null}

          <label className="field-label">
            <span>Username</span>
            <input
              autoCapitalize="none"
              autoComplete="username"
              disabled={!isSupabaseConfigured || checkingSession || loading}
              inputMode="text"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username"
              required
              type="text"
              value={username}
            />
          </label>

          {!recoveryMode ? (
            <div className="field-label">
              <label htmlFor="login-password">Password</label>
              <span className="password-input">
                <input
                  autoComplete="current-password"
                  disabled={!isSupabaseConfigured || checkingSession || loading}
                  id="login-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="password-input__toggle"
                  onClick={() => setShowPassword((current) => !current)}
                  type="button"
                >
                  {showPassword ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
                </button>
              </span>
              <button className="login-recovery__link" onClick={openPasswordRecovery} type="button">
                Forgot password?
              </button>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="auth-notice auth-notice--error" role="alert">
              <LockKeyhole aria-hidden="true" size={21} />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {recoveryMessage ? (
            <div className="auth-notice auth-notice--success" role="status">
              <MailCheck aria-hidden="true" size={21} />
              <span>{recoveryMessage}</span>
            </div>
          ) : null}

          <button
            className="primary-action login-submit"
            disabled={!isSupabaseConfigured || checkingSession || loading}
            type="submit"
          >
            {recoveryMode ? <MailCheck aria-hidden="true" size={20} /> : <KeyRound aria-hidden="true" size={20} />}
            {loading ? (recoveryMode ? 'Sending secure link…' : 'Checking access…') : (recoveryMode ? 'Send reset link' : 'Sign in')}
          </button>

          {recoveryMode ? (
            <>
              <button className="login-recovery__back" onClick={closePasswordRecovery} type="button">
                <ArrowLeft aria-hidden="true" size={18} />
                Back to sign in
              </button>
              <p className="login-recovery__help">
                If no email arrives, ask an administrator to confirm the personal email on your employee record.
              </p>
            </>
          ) : null}
        </form>
      </section>
    </main>
  )
}

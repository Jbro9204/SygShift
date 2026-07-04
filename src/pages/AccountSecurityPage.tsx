import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2, KeyRound, Loader2, QrCode, ShieldCheck } from 'lucide-react'
import { getSessionContext, type SessionContext, validatePassword } from '../data/auth'
import {
  createMfaChallenge,
  listTotpFactors,
  startTotpEnrollment,
  verifyMfaChallenge,
  verifyTotpEnrollment,
  type MfaEnrollment,
  type MfaFactorSummary,
} from '../data/mfa'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'

type AccountSecurityLocationState = {
  from?: {
    pathname?: string
    search?: string
    hash?: string
  }
}

export function AccountSecurityPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [context, setContext] = useState<SessionContext | null>(null)
  const [factors, setFactors] = useState<MfaFactorSummary[]>([])
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null)
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const returnPath = useMemo(() => {
    const state = location.state as AccountSecurityLocationState | null
    const from = state?.from
    return `${from?.pathname ?? '/'}${from?.search ?? ''}${from?.hash ?? ''}`
  }, [location.state])

  const passwordPolicy = useMemo(
    () => validatePassword(password, context?.username),
    [context?.username, password],
  )
  const verifiedFactor = factors.find((factor) => factor.status === 'verified') ?? null
  const needsPassword = Boolean(context?.mustChangePassword)
  const needsMfa = Boolean(context?.mfaRequired && !context.hasMfa)
  const isComplete = Boolean(context && !needsPassword && !needsMfa)

  useEffect(() => {
    let active = true

    async function loadSecurityState() {
      if (!isSupabaseConfigured) {
        setLoading(false)
        return
      }

      try {
        const nextContext = await getSessionContext()
        if (!active) return
        setContext(nextContext)

        if (nextContext.mfaRequired) {
          const nextFactors = await listTotpFactors()
          if (active) setFactors(nextFactors)
        }
      } catch {
        await getSupabaseClient().auth.signOut()
        if (active) setContext(null)
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadSecurityState()

    return () => {
      active = false
    }
  }, [])

  async function refreshContext() {
    const nextContext = await getSessionContext()
    setContext(nextContext)

    if (nextContext.mfaRequired) {
      setFactors(await listTotpFactors())
    }
  }

  async function handlePasswordUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setMessage(null)

    if (!passwordPolicy.valid) {
      setErrorMessage('The new password does not meet the security requirements.')
      return
    }

    if (password !== passwordConfirmation) {
      setErrorMessage('The password confirmation does not match.')
      return
    }

    setBusyAction('password')
    try {
      const update = await getSupabaseClient().auth.updateUser({ password })
      if (update.error) throw new Error('The password could not be updated.')

      const marked = await getSupabaseClient().rpc('mark_password_changed')
      if (marked.error) throw new Error('The password change could not be recorded.')

      setPassword('')
      setPasswordConfirmation('')
      setMessage('Password updated. Continue with the remaining security step.')
      await refreshContext()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The password update failed.')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleStartEnrollment() {
    setErrorMessage(null)
    setMessage(null)
    setBusyAction('start-mfa')

    try {
      setEnrollment(await startTotpEnrollment())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Authenticator setup failed.')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleMfaVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setMessage(null)
    setBusyAction('verify-mfa')

    try {
      if (enrollment) {
        await verifyTotpEnrollment(enrollment.factorId, mfaCode)
      } else if (verifiedFactor) {
        const challengeId = await createMfaChallenge(verifiedFactor.id)
        await verifyMfaChallenge(verifiedFactor.id, challengeId, mfaCode)
      } else {
        throw new Error('Start authenticator setup before entering a code.')
      }

      const marked = await getSupabaseClient().rpc('mark_mfa_enrolled')
      if (marked.error) throw new Error('MFA enrollment could not be recorded.')

      setEnrollment(null)
      setMfaCode('')
      setMessage('Authenticator verified. Your account security is ready.')
      await refreshContext()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Authenticator verification failed.')
    } finally {
      setBusyAction(null)
    }
  }

  if (!isSupabaseConfigured) return <Navigate to="/login" replace />
  if (!loading && !context) return <Navigate to="/login" replace />

  return (
    <main className="security-page">
      <section className="security-card" aria-labelledby="security-title">
        <div className="security-card__heading">
          <div>
            <p className="eyebrow">Account security</p>
            <h1 id="security-title">Finish securing your SygShift account.</h1>
            <p>
              This checkpoint keeps protected schedules, employee records, and import tools behind
              verified access before the workspace opens.
            </p>
          </div>
          <ShieldCheck aria-hidden="true" size={42} />
        </div>

        {loading ? (
          <div className="security-loading" role="status">
            <Loader2 aria-hidden="true" size={26} />
            Checking your secure session…
          </div>
        ) : null}

        {context ? (
          <div className="security-steps">
            <article className={needsPassword ? 'security-step security-step--active' : 'security-step'}>
              <div className="security-step__icon">
                <KeyRound aria-hidden="true" size={24} />
              </div>
              <div>
                <h2>Password</h2>
                <p>
                  {needsPassword
                    ? 'Replace the temporary password with a stronger private password.'
                    : 'Your password setup is complete.'}
                </p>
              </div>
              {!needsPassword ? <CheckCircle2 aria-hidden="true" size={24} /> : null}
            </article>

            <article className={needsMfa ? 'security-step security-step--active' : 'security-step'}>
              <div className="security-step__icon">
                <QrCode aria-hidden="true" size={24} />
              </div>
              <div>
                <h2>Authenticator</h2>
                <p>
                  {context.mfaRequired
                    ? needsMfa
                      ? 'Verify an authenticator code before protected tools open.'
                      : 'Authenticator verification is complete for this session.'
                    : 'Your role does not require an authenticator code.'}
                </p>
              </div>
              {!needsMfa ? <CheckCircle2 aria-hidden="true" size={24} /> : null}
            </article>
          </div>
        ) : null}

        {message ? (
          <div className="auth-notice auth-notice--success" role="status">
            <CheckCircle2 aria-hidden="true" size={21} />
            <span>{message}</span>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="auth-notice auth-notice--error" role="alert">
            <ShieldCheck aria-hidden="true" size={21} />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {context && needsPassword ? (
          <form className="security-panel" onSubmit={handlePasswordUpdate}>
            <h2>Create your permanent password</h2>
            <div className="security-form-grid">
              <label className="field-label">
                <span>New password</span>
                <input
                  autoComplete="new-password"
                  disabled={busyAction === 'password'}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>

              <label className="field-label">
                <span>Confirm password</span>
                <input
                  autoComplete="new-password"
                  disabled={busyAction === 'password'}
                  onChange={(event) => setPasswordConfirmation(event.target.value)}
                  required
                  type="password"
                  value={passwordConfirmation}
                />
              </label>
            </div>

            <ul className="password-rules" aria-label="Password requirements">
              {passwordPolicy.failures.length > 0 ? (
                passwordPolicy.failures.map((failure) => <li key={failure}>{failure}</li>)
              ) : (
                <li>Password requirements are met.</li>
              )}
            </ul>

            <button className="primary-action" disabled={busyAction === 'password'} type="submit">
              {busyAction === 'password' ? 'Saving password…' : 'Save password'}
            </button>
          </form>
        ) : null}

        {context && !needsPassword && needsMfa ? (
          <section className="security-panel">
            <h2>{verifiedFactor ? 'Verify your authenticator' : 'Set up an authenticator'}</h2>
            <p>
              Use an authenticator app such as Microsoft Authenticator, Google Authenticator, or
              1Password. Enter the six-digit code when it appears.
            </p>

            {!verifiedFactor && !enrollment ? (
              <button
                className="primary-action"
                disabled={busyAction === 'start-mfa'}
                onClick={handleStartEnrollment}
                type="button"
              >
                {busyAction === 'start-mfa' ? 'Preparing setup…' : 'Start authenticator setup'}
              </button>
            ) : null}

            {enrollment ? (
              <div className="mfa-setup">
                <img src={enrollment.qrCode} alt="Authenticator setup QR code" />
                <div>
                  <strong>Can’t scan the QR code?</strong>
                  <span>Enter this setup key manually:</span>
                  <code>{enrollment.secret}</code>
                </div>
              </div>
            ) : null}

            {verifiedFactor || enrollment ? (
              <form className="mfa-form" onSubmit={handleMfaVerification}>
                <label className="field-label">
                  <span>Six-digit authenticator code</span>
                  <input
                    autoComplete="one-time-code"
                    disabled={busyAction === 'verify-mfa'}
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(event) => setMfaCode(event.target.value)}
                    pattern="[0-9 ]{6,8}"
                    required
                    type="text"
                    value={mfaCode}
                  />
                </label>
                <button className="primary-action" disabled={busyAction === 'verify-mfa'} type="submit">
                  {busyAction === 'verify-mfa' ? 'Verifying…' : 'Verify authenticator'}
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        {isComplete ? (
          <section className="security-complete">
            <CheckCircle2 aria-hidden="true" size={34} />
            <div>
              <h2>Security check complete.</h2>
              <p>Your account is ready. Continue to the SygShift workspace.</p>
            </div>
            <button className="primary-action" onClick={() => navigate(returnPath, { replace: true })} type="button">
              Continue
            </button>
          </section>
        ) : null}
      </section>
    </main>
  )
}

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, QrCode, ShieldCheck } from 'lucide-react'
import {
  getSessionContext,
  notifySessionContextChanged,
  type SessionContext,
  validatePassword,
} from '../data/auth'
import {
  createMfaChallenge,
  listTotpFactors,
  startTotpEnrollment,
  verifyMfaChallenge,
  verifyTotpEnrollment,
  type MfaEnrollment,
  type MfaFactorSummary,
} from '../data/mfa'
import {
  clearRememberedDeviceOnThisBrowser,
  getCurrentTrustedDevices,
  rememberCurrentDevice,
  revokeCurrentTrustedDevice,
  type TrustedDevice,
} from '../data/trustedDevices'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'

function isAlreadyCurrentPasswordError(error: unknown): boolean {
  const message =
    typeof error === 'object' && error && 'message' in error && typeof error.message === 'string'
      ? error.message.toLowerCase()
      : ''

  return (
    message.includes('different from the old password') ||
    message.includes('same as the old password') ||
    message.includes('same password') ||
    message.includes('new password should be different')
  )
}

async function markPasswordChangedWithRetry(): Promise<void> {
  const supabase = getSupabaseClient()
  let marked = await supabase.rpc('mark_password_changed')

  if (!marked.error) return

  await supabase.auth.refreshSession()
  marked = await supabase.rpc('mark_password_changed')

  if (marked.error) {
    throw new Error(
      'Your password was accepted, but SygShift could not finish clearing the temporary-password checkpoint. Please sign out and try again, or contact an administrator.',
    )
  }
}

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
  const [checkpointVersion, setCheckpointVersion] = useState(0)
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([])

  const returnPath = useMemo(() => {
    const state = location.state as AccountSecurityLocationState | null
    const from = state?.from
    const path = `${from?.pathname ?? '/'}${from?.search ?? ''}${from?.hash ?? ''}`
    return path === '/account-security' ? '/' : path
  }, [location.state])

  const passwordPolicy = useMemo(
    () => validatePassword(password, context?.username),
    [context?.username, password],
  )
  const verifiedFactor = factors.find((factor) => factor.status === 'verified') ?? null
  const unverifiedFactor = factors.find((factor) => factor.status !== 'verified') ?? null
  const needsPassword = Boolean(context?.mustChangePassword)
  const needsMfa = Boolean(context?.mfaRequired && !context.hasMfa)
  const passwordWaitingForMfa = needsPassword && needsMfa
  const isComplete = Boolean(context && !needsPassword && !needsMfa)
  const canRememberDevice = Boolean(context?.mfaRequired && (context.role === 'admin' || context.role === 'supervisor'))

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

  async function refreshContext(): Promise<SessionContext> {
    const nextContext = await getSessionContext()
    setContext(nextContext)

    if (nextContext.mfaRequired) {
      setFactors(await listTotpFactors())
    } else {
      setFactors([])
    }

    notifySessionContextChanged()
    return nextContext
  }

  async function refreshTrustedDevices(): Promise<void> {
    if (!canRememberDevice) {
      setTrustedDevices([])
      return
    }

    try {
      setTrustedDevices(await getCurrentTrustedDevices())
    } catch {
      setTrustedDevices([])
    }
  }

  useEffect(() => {
    let active = true

    async function loadTrustedDevices() {
      if (!context || needsMfa || !canRememberDevice) {
        setTrustedDevices([])
        return
      }

      try {
        const devices = await getCurrentTrustedDevices()
        if (active) setTrustedDevices(devices)
      } catch {
        if (active) setTrustedDevices([])
      }
    }

    void loadTrustedDevices()

    return () => {
      active = false
    }
  }, [canRememberDevice, context, needsMfa])

  async function handlePasswordUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setMessage(null)

    const form = new FormData(event.currentTarget)
    const submittedPassword = String(form.get('password') ?? '')
    const submittedPasswordConfirmation = String(form.get('passwordConfirmation') ?? '')
    const submittedPolicy = validatePassword(submittedPassword, context?.username)

    setPassword(submittedPassword)
    setPasswordConfirmation(submittedPasswordConfirmation)

    if (!submittedPolicy.valid) {
      setErrorMessage('The new password does not meet the security requirements.')
      return
    }

    if (submittedPassword !== submittedPasswordConfirmation) {
      setErrorMessage('The password confirmation does not match.')
      return
    }

    setBusyAction('password')
    try {
      const update = await getSupabaseClient().auth.updateUser({ password: submittedPassword })
      if (update.error) {
        if (isAlreadyCurrentPasswordError(update.error)) {
          await markPasswordChangedWithRetry()
        } else {
          throw new Error(update.error.message || 'The password could not be updated.')
        }
      } else {
        await markPasswordChangedWithRetry()
      }

      await getSupabaseClient().auth.refreshSession()
      const nextContext = await refreshContext()
      setPassword('')
      setPasswordConfirmation('')
      setShowPassword(false)
      setShowPasswordConfirmation(false)
      setCheckpointVersion((version) => version + 1)

      const nextNeedsMfa = nextContext.mfaRequired && !nextContext.hasMfa
      if (nextNeedsMfa) {
        setMessage('Password saved. Continue with authenticator verification.')
      } else {
        setMessage('Password saved. Opening your workspace.')
        navigate(returnPath, { replace: true })
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The password update failed.')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleStartEnrollment() {
    setErrorMessage(null)
    setEnrollment(null)
    setMfaCode('')
    setMessage(
      unverifiedFactor
        ? 'Restarting authenticator setup and clearing the unfinished attempt.'
        : 'Preparing authenticator setup.',
    )
    setBusyAction('start-mfa')

    try {
      const nextEnrollment = await startTotpEnrollment()
      setEnrollment(nextEnrollment)
      setMessage('Authenticator setup is ready. Scan the QR code, then enter the six-digit code from the app.')
      try {
        setFactors(await listTotpFactors())
      } catch {
        // The QR code is already available; do not block setup on a secondary list refresh.
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Authenticator setup failed. Refresh the page and try again.',
      )
      try {
        setFactors(await listTotpFactors())
      } catch {
        // Keep the original setup error visible instead of replacing it with a secondary refresh error.
      }
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

      let rememberDeviceFailed = false
      if (rememberDevice && canRememberDevice) {
        try {
          await rememberCurrentDevice(14)
        } catch {
          rememberDeviceFailed = true
        }
      }

      const nextContext = await refreshContext()
      setEnrollment(null)
      setMfaCode('')
      setRememberDevice(true)
      setPassword('')
      setPasswordConfirmation('')
      setShowPassword(false)
      setShowPasswordConfirmation(false)
      setCheckpointVersion((version) => version + 1)
      await refreshTrustedDevices()

      if (!nextContext.mustChangePassword && !(nextContext.mfaRequired && !nextContext.hasMfa)) {
        setMessage(
          rememberDeviceFailed
            ? 'Authenticator verified. This device could not be remembered, but your workspace is opening.'
            : 'Authenticator verified. Opening your workspace.',
        )
        navigate(returnPath, { replace: true })
      } else {
        setMessage(
          rememberDeviceFailed
            ? 'Authenticator verified. This device could not be remembered; continue with the remaining security step.'
            : 'Authenticator verified. Continue with the remaining security step.',
        )
      }
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
                  {passwordWaitingForMfa
                    ? 'Verify your authenticator first, then save your permanent password.'
                    : needsPassword
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
                      ? needsPassword
                        ? 'Verify an authenticator code before saving the new password.'
                        : 'Verify an authenticator code before protected tools open.'
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

        {context && passwordWaitingForMfa ? (
          <div className="auth-notice auth-notice--warning" role="status">
            <ShieldCheck aria-hidden="true" size={21} />
            <span>
              This account is protected by MFA. Verify the authenticator code first, then the
              permanent password form will open.
            </span>
          </div>
        ) : null}

        {context && needsPassword && !needsMfa ? (
          <form className="security-panel" key={`password-${context.employeeId}-${checkpointVersion}`} onSubmit={handlePasswordUpdate}>
            <h2>Create your permanent password</h2>
            <div className="security-form-grid">
              <div className="field-label">
                <label htmlFor="new-password">New password</label>
                <span className="password-input">
                  <input
                    autoComplete="new-password"
                    disabled={busyAction === 'password'}
                    id="new-password"
                    name="password"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                  />
                  <button
                    aria-label={showPassword ? 'Hide new password' : 'Show new password'}
                    className="password-input__toggle"
                    disabled={busyAction === 'password'}
                    onClick={() => setShowPassword((current) => !current)}
                    type="button"
                  >
                    {showPassword ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
                  </button>
                </span>
              </div>

              <div className="field-label">
                <label htmlFor="confirm-password">Confirm password</label>
                <span className="password-input">
                  <input
                    autoComplete="new-password"
                    disabled={busyAction === 'password'}
                    id="confirm-password"
                    name="passwordConfirmation"
                    onChange={(event) => setPasswordConfirmation(event.target.value)}
                    required
                    type={showPasswordConfirmation ? 'text' : 'password'}
                    value={passwordConfirmation}
                  />
                  <button
                    aria-label={showPasswordConfirmation ? 'Hide confirmation password' : 'Show confirmation password'}
                    className="password-input__toggle"
                    disabled={busyAction === 'password'}
                    onClick={() => setShowPasswordConfirmation((current) => !current)}
                    type="button"
                  >
                    {showPasswordConfirmation ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
                  </button>
                </span>
              </div>
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

        {context && needsMfa ? (
          <section className="security-panel">
            <h2>{verifiedFactor ? 'Verify your authenticator' : 'Set up an authenticator'}</h2>
            <p>
              Use an authenticator app such as Microsoft Authenticator, Google Authenticator, or
              1Password. Enter the six-digit code when it appears.
            </p>

            {unverifiedFactor && !enrollment && !verifiedFactor ? (
              <div className="auth-notice auth-notice--warning auth-notice--inline" role="status">
                <ShieldCheck aria-hidden="true" size={21} />
                <span>
                  An authenticator setup was started but not finished. Restarting setup will clear the unfinished attempt
                  and show a fresh QR code.
                </span>
              </div>
            ) : null}

            {!verifiedFactor && !enrollment ? (
              <button
                className="primary-action"
                disabled={busyAction === 'start-mfa'}
                onClick={handleStartEnrollment}
                type="button"
              >
                {busyAction === 'start-mfa' ? (
                  <>
                    <Loader2 aria-hidden="true" size={18} />
                    Preparing setup…
                  </>
                ) : unverifiedFactor ? 'Restart authenticator setup' : 'Start authenticator setup'}
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
                {canRememberDevice ? (
                  <label className="check-field trusted-device-check">
                    <input
                      checked={rememberDevice}
                      disabled={busyAction === 'verify-mfa'}
                      onChange={(event) => setRememberDevice(event.target.checked)}
                      type="checkbox"
                    />
                    <span>Remember this device for 14 days</span>
                  </label>
                ) : null}
                <button className="primary-action" disabled={busyAction === 'verify-mfa'} type="submit">
                  {busyAction === 'verify-mfa' ? 'Verifying…' : 'Verify authenticator'}
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        {canRememberDevice && !needsMfa ? (
          <section className="security-panel trusted-device-panel" aria-labelledby="trusted-devices-title">
            <div>
              <h2 id="trusted-devices-title">Remembered devices</h2>
              <p>
                These browsers can open supervisor/admin tools without another authenticator prompt until they expire.
                Signing out removes the remembered device from this browser.
              </p>
            </div>
            {trustedDevices.length === 0 ? (
              <p className="trusted-device-empty">No active remembered devices are on file for this account.</p>
            ) : (
              <div className="trusted-device-list">
                {trustedDevices.map((device) => (
                  <article className="trusted-device-item" key={device.id}>
                    <div>
                      <strong>{device.deviceLabel ?? 'Remembered browser'}</strong>
                      <span>
                        Expires {new Intl.DateTimeFormat('en-US', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(device.expiresAt))}
                        {device.isCurrentDevice ? ' · this device' : ''}
                      </span>
                    </div>
                    <button
                      className="secondary-button secondary-button--small"
                      onClick={async () => {
                        await revokeCurrentTrustedDevice(device.id)
                        if (device.isCurrentDevice) clearRememberedDeviceOnThisBrowser()
                        await refreshTrustedDevices()
                        const nextContext = await refreshContext()
                        if (nextContext.mfaRequired && !nextContext.hasMfa) {
                          setMessage('This remembered device was removed. Verify your authenticator to continue.')
                        }
                      }}
                      type="button"
                    >
                      Remove
                    </button>
                  </article>
                ))}
              </div>
            )}
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

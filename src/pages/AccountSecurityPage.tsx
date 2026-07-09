import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, MessageSquareText, QrCode, ShieldCheck } from 'lucide-react'
import {
  getSessionContext,
  notifySessionContextChanged,
  type SessionContext,
  validatePassword,
} from '../data/auth'
import {
  createMfaChallenge,
  listMfaFactors,
  startTotpEnrollment,
  startPhoneEnrollment,
  verifyMfaChallenge,
  verifyTotpEnrollment,
  type MfaEnrollment,
  type MfaFactorType,
  type MfaFactorSummary,
  type MfaPhoneEnrollment,
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

type MfaMethod = MfaFactorType
const SMS_MFA_ENABLED = import.meta.env.VITE_ENABLE_SMS_MFA === 'true'
const TOTP_SETUP_STORAGE_KEY = 'sygshift:totp-setup'

function readStoredTotpEnrollment(): MfaEnrollment | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(TOTP_SETUP_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MfaEnrollment>
    if (!parsed.factorId || !parsed.qrCode || !parsed.secret) return null
    return {
      factorId: parsed.factorId,
      qrCode: parsed.qrCode,
      secret: parsed.secret,
    }
  } catch {
    return null
  }
}

function storeTotpEnrollment(enrollment: MfaEnrollment | null): void {
  if (typeof window === 'undefined') return
  if (!enrollment) {
    window.sessionStorage.removeItem(TOTP_SETUP_STORAGE_KEY)
    return
  }
  window.sessionStorage.setItem(TOTP_SETUP_STORAGE_KEY, JSON.stringify(enrollment))
}

export function AccountSecurityPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [context, setContext] = useState<SessionContext | null>(null)
  const [factors, setFactors] = useState<MfaFactorSummary[]>([])
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null)
  const [phoneEnrollment, setPhoneEnrollment] = useState<MfaPhoneEnrollment | null>(null)
  const [selectedMfaMethod, setSelectedMfaMethod] = useState<MfaMethod | null>(null)
  const [phoneNumber, setPhoneNumber] = useState('')
  const [phoneChallengeId, setPhoneChallengeId] = useState<string | null>(null)
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
  const verifiedFactors = factors.filter((factor) => factor.status === 'verified')
  const availableVerifiedFactors = verifiedFactors.filter((factor) => SMS_MFA_ENABLED || factor.factorType === 'totp')
  const verifiedTotpFactor = verifiedFactors.find((factor) => factor.factorType === 'totp') ?? null
  const verifiedPhoneFactor = SMS_MFA_ENABLED
    ? verifiedFactors.find((factor) => factor.factorType === 'phone') ?? null
    : null
  const unverifiedTotpFactor = factors.find((factor) => factor.factorType === 'totp' && factor.status !== 'verified') ?? null
  const unverifiedPhoneFactor = SMS_MFA_ENABLED
    ? factors.find((factor) => factor.factorType === 'phone' && factor.status !== 'verified') ?? null
    : null
  const activeVerifiedFactor = selectedMfaMethod
    ? availableVerifiedFactors.find((factor) => factor.factorType === selectedMfaMethod) ?? null
    : availableVerifiedFactors.length === 1
      ? availableVerifiedFactors[0]
      : null
  const needsPassword = Boolean(context?.mustChangePassword)
  const needsMfa = Boolean(context?.mfaRequired && !context.hasMfa)
  const passwordWaitingForMfa = needsPassword && needsMfa
  const isComplete = Boolean(context && !needsPassword && !needsMfa)
  const canRememberDevice = Boolean(
    context?.mfaRequired
    && (context.role === 'admin'
      || context.role === 'supervisor'
      || context.role === 'scheduler'
      || context.role === 'dispatcher'),
  )

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
          const nextFactors = await listMfaFactors()
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
      setFactors(await listMfaFactors())
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

  useEffect(() => {
    if (!needsMfa || selectedMfaMethod) return
    if (!SMS_MFA_ENABLED) {
      setSelectedMfaMethod('totp')
      return
    }
    if (availableVerifiedFactors.length !== 1) return
    setSelectedMfaMethod(availableVerifiedFactors[0].factorType)
  }, [availableVerifiedFactors, needsMfa, selectedMfaMethod])

  useEffect(() => {
    if (!needsMfa || enrollment || verifiedTotpFactor) return
    const storedEnrollment = readStoredTotpEnrollment()
    if (!storedEnrollment) return
    setSelectedMfaMethod('totp')
    setEnrollment(storedEnrollment)
    setMessage('Authenticator setup is still active. Enter the six-digit code from your app to finish.')
  }, [enrollment, needsMfa, verifiedTotpFactor])

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
        setMessage('Password saved. Continue with MFA verification.')
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

  function handleSelectMfaMethod(method: MfaMethod) {
    if (method === 'phone' && !SMS_MFA_ENABLED) return
    setSelectedMfaMethod(method)
    setEnrollment(null)
    if (method !== 'totp') storeTotpEnrollment(null)
    setPhoneEnrollment(null)
    setPhoneChallengeId(null)
    setMfaCode('')
    setErrorMessage(null)
    setMessage(null)
  }

  async function handleStartEnrollment() {
    setErrorMessage(null)
    setEnrollment(null)
    storeTotpEnrollment(null)
    setPhoneEnrollment(null)
    setPhoneChallengeId(null)
    setSelectedMfaMethod('totp')
    setMfaCode('')
    setMessage(
      unverifiedTotpFactor
        ? 'Restarting authenticator setup and clearing the unfinished attempt.'
        : 'Preparing authenticator setup.',
    )
    setBusyAction('start-mfa')

    try {
      const nextEnrollment = await startTotpEnrollment()
      setEnrollment(nextEnrollment)
      storeTotpEnrollment(nextEnrollment)
      setMessage('Authenticator setup is ready. Scan the QR code, then enter the six-digit code from the app.')
      try {
        setFactors(await listMfaFactors())
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
        setFactors(await listMfaFactors())
      } catch {
        // Keep the original setup error visible instead of replacing it with a secondary refresh error.
      }
    } finally {
      setBusyAction(null)
    }
  }

  async function handleStartPhoneEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!SMS_MFA_ENABLED) {
      setErrorMessage('Text message MFA is turned off for now. Use Authenticator App to finish account security.')
      return
    }
    setErrorMessage(null)
    setMessage(null)
    setEnrollment(null)
    storeTotpEnrollment(null)
    setPhoneEnrollment(null)
    setPhoneChallengeId(null)
    setSelectedMfaMethod('phone')
    setMfaCode('')
    setBusyAction('start-phone-mfa')

    try {
      const nextEnrollment = await startPhoneEnrollment(phoneNumber)
      setPhoneEnrollment(nextEnrollment)
      setPhoneNumber(nextEnrollment.phone)
      setMessage(`Text code sent to ${nextEnrollment.phone}. Enter the code to finish SMS MFA setup.`)
      try {
        setFactors(await listMfaFactors())
      } catch {
        // The SMS challenge is already active; do not block setup on a secondary list refresh.
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'SMS verification setup failed. Check the mobile number and try again.',
      )
      try {
        setFactors(await listMfaFactors())
      } catch {
        // Keep the original setup error visible instead of replacing it with a secondary refresh error.
      }
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSendPhoneChallenge() {
    if (!SMS_MFA_ENABLED) {
      setErrorMessage('Text message MFA is turned off for now. Use Authenticator App to finish account security.')
      return
    }
    if (!verifiedPhoneFactor) {
      setErrorMessage('Set up SMS verification before requesting a text code.')
      return
    }

    setErrorMessage(null)
    setMessage(null)
    setSelectedMfaMethod('phone')
    setEnrollment(null)
    setPhoneEnrollment(null)
    setMfaCode('')
    setBusyAction('send-phone-code')

    try {
      const challengeId = await createMfaChallenge(verifiedPhoneFactor.id, 'phone')
      setPhoneChallengeId(challengeId)
      setMessage(
        verifiedPhoneFactor.phone
          ? `Text code sent to ${verifiedPhoneFactor.phone}.`
          : 'Text code sent. Enter the code when it arrives.',
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Text code could not be sent.')
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
      let verifiedMethod: MfaMethod = selectedMfaMethod ?? 'totp'

      if (enrollment) {
        await verifyTotpEnrollment(enrollment.factorId, mfaCode)
        verifiedMethod = 'totp'
      } else if (phoneEnrollment) {
        await verifyMfaChallenge(phoneEnrollment.factorId, phoneEnrollment.challengeId, mfaCode, 'phone')
        verifiedMethod = 'phone'
      } else if (activeVerifiedFactor) {
        if (activeVerifiedFactor.factorType === 'phone') {
          if (!phoneChallengeId) throw new Error('Send a text code before verifying SMS MFA.')
          await verifyMfaChallenge(activeVerifiedFactor.id, phoneChallengeId, mfaCode, 'phone')
          verifiedMethod = 'phone'
        } else {
          const challengeId = await createMfaChallenge(activeVerifiedFactor.id, 'totp')
          await verifyMfaChallenge(activeVerifiedFactor.id, challengeId, mfaCode, 'totp')
          verifiedMethod = 'totp'
        }
      } else {
        throw new Error('Choose an MFA method before entering a code.')
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
      storeTotpEnrollment(null)
      setPhoneEnrollment(null)
      setPhoneChallengeId(null)
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
            ? `${verifiedMethod === 'phone' ? 'Text message' : 'Authenticator'} verified. This device could not be remembered, but your workspace is opening.`
            : `${verifiedMethod === 'phone' ? 'Text message' : 'Authenticator'} verified. Opening your workspace.`,
        )
        navigate(returnPath, { replace: true })
      } else {
        setMessage(
          rememberDeviceFailed
            ? `${verifiedMethod === 'phone' ? 'Text message' : 'Authenticator'} verified. This device could not be remembered; continue with the remaining security step.`
            : `${verifiedMethod === 'phone' ? 'Text message' : 'Authenticator'} verified. Continue with the remaining security step.`,
        )
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'MFA verification failed.')
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
                    ? 'Verify MFA first, then save your permanent password.'
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
                <h2>MFA</h2>
                <p>
                  {context.mfaRequired
                    ? needsMfa
                      ? needsPassword
                        ? SMS_MFA_ENABLED
                          ? 'Verify by authenticator app or text message before saving the new password.'
                          : 'Verify with an authenticator app before saving the new password.'
                        : SMS_MFA_ENABLED
                          ? 'Verify by authenticator app or text message before protected tools open.'
                          : 'Verify with an authenticator app before protected tools open.'
                      : 'MFA verification is complete for this session.'
                    : 'Your role does not require MFA.'}
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
              This account is protected by MFA. Verify with an authenticator app first, then the
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
            <h2>{availableVerifiedFactors.length > 0 ? 'Verify your account' : SMS_MFA_ENABLED ? 'Choose your MFA method' : 'Set up an authenticator app'}</h2>
            <p>
              {SMS_MFA_ENABLED
                ? 'You can use either an authenticator app or a text message code. Set up one method now; add the other later if you want a backup.'
                : 'Use an authenticator app such as Microsoft Authenticator, Google Authenticator, 1Password, Authy, or Apple Passwords.'}
            </p>

            <div className={SMS_MFA_ENABLED ? 'mfa-method-grid' : 'mfa-method-grid mfa-method-grid--single'} role="list" aria-label="MFA method options">
              <button
                aria-pressed={selectedMfaMethod === 'totp'}
                className={selectedMfaMethod === 'totp' ? 'mfa-method-card mfa-method-card--active' : 'mfa-method-card'}
                disabled={busyAction !== null}
                onClick={() => handleSelectMfaMethod('totp')}
                type="button"
              >
                <QrCode aria-hidden="true" size={24} />
                <strong>Authenticator app</strong>
                <span>{verifiedTotpFactor ? 'Use your existing app code.' : 'Scan a QR code with an app.'}</span>
              </button>

              {SMS_MFA_ENABLED ? (
                <button
                  aria-pressed={selectedMfaMethod === 'phone'}
                  className={selectedMfaMethod === 'phone' ? 'mfa-method-card mfa-method-card--active' : 'mfa-method-card'}
                  disabled={busyAction !== null}
                  onClick={() => handleSelectMfaMethod('phone')}
                  type="button"
                >
                  <MessageSquareText aria-hidden="true" size={24} />
                  <strong>Text message</strong>
                  <span>{verifiedPhoneFactor ? 'Send a code to your phone.' : 'Use a mobile number that receives texts.'}</span>
                </button>
              ) : null}
            </div>

            {(!SMS_MFA_ENABLED || selectedMfaMethod === 'totp') && unverifiedTotpFactor && !enrollment && !verifiedTotpFactor ? (
              <div className="auth-notice auth-notice--warning auth-notice--inline" role="status">
                <ShieldCheck aria-hidden="true" size={21} />
                <span>
                  An authenticator setup was started but not finished. Restarting setup will clear the unfinished attempt
                  and show a fresh QR code.
                </span>
              </div>
            ) : null}

            {(!SMS_MFA_ENABLED || selectedMfaMethod === 'totp') && !verifiedTotpFactor && !enrollment ? (
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
                ) : unverifiedTotpFactor ? 'Restart authenticator setup' : 'Start authenticator setup'}
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

            {SMS_MFA_ENABLED && selectedMfaMethod === 'phone' ? (
              <div className="mfa-method-body">
                <h3>{verifiedPhoneFactor ? 'Send a text message code' : 'Set up text message MFA'}</h3>
                <p>SMS is often easiest on a phone. Use a mobile number that can receive text messages.</p>

                {unverifiedPhoneFactor && !phoneEnrollment && !verifiedPhoneFactor ? (
                  <div className="auth-notice auth-notice--warning auth-notice--inline" role="status">
                    <ShieldCheck aria-hidden="true" size={21} />
                    <span>
                      An SMS setup was started but not finished. Starting again will clear the unfinished attempt and send
                      a fresh code.
                    </span>
                  </div>
                ) : null}

                {verifiedPhoneFactor ? (
                  <button
                    className="primary-action"
                    disabled={busyAction === 'send-phone-code'}
                    onClick={handleSendPhoneChallenge}
                    type="button"
                  >
                    {busyAction === 'send-phone-code' ? (
                      <>
                        <Loader2 aria-hidden="true" size={18} />
                        Sending text...
                      </>
                    ) : phoneChallengeId ? 'Send a new text code' : 'Send text code'}
                  </button>
                ) : null}

                {!verifiedPhoneFactor && !phoneEnrollment ? (
                  <form className="sms-setup-form" onSubmit={handleStartPhoneEnrollment}>
                    <label className="field-label">
                      <span>Mobile number</span>
                      <input
                        autoComplete="tel"
                        disabled={busyAction === 'start-phone-mfa'}
                        inputMode="tel"
                        onChange={(event) => setPhoneNumber(event.target.value)}
                        placeholder="720-555-1234"
                        required
                        type="tel"
                        value={phoneNumber}
                      />
                    </label>
                    <button className="primary-action" disabled={busyAction === 'start-phone-mfa'} type="submit">
                      {busyAction === 'start-phone-mfa' ? (
                        <>
                          <Loader2 aria-hidden="true" size={18} />
                          Sending text...
                        </>
                      ) : unverifiedPhoneFactor ? 'Restart SMS setup' : 'Send setup text'}
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}

            {enrollment || phoneEnrollment || activeVerifiedFactor?.factorType === 'totp' || phoneChallengeId ? (
              <form className="mfa-form" onSubmit={handleMfaVerification}>
                <label className="field-label">
                  <span>{selectedMfaMethod === 'phone' ? 'Six-digit text message code' : 'Six-digit authenticator code'}</span>
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
                  {busyAction === 'verify-mfa'
                    ? 'Verifying...'
                    : selectedMfaMethod === 'phone'
                      ? 'Verify text code'
                      : 'Verify authenticator'}
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
                These browsers can open protected operations tools without another MFA prompt until they expire.
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
                          setMessage('This remembered device was removed. Verify MFA to continue.')
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

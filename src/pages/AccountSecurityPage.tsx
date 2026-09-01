import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Copy, Download, Eye, EyeOff, KeyRound, Loader2, MessageSquareText, QrCode, ShieldCheck, Usb } from 'lucide-react'
import {
  getSessionContext,
  notifySessionContextChanged,
  signOut,
  type SessionContext,
  validatePassword,
} from '../data/auth'
import {
  createMfaChallenge,
  getAuthenticatorLevel,
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
import { generateMfaRecoveryCodes, recoverMfaWithCode } from '../data/mfaRecovery'
import {
  authenticateWithSecurityKey,
  getSecurityKeyDirectory,
  type SecurityKeySummary,
} from '../data/securityKeys'
import {
  clearRememberedDeviceOnThisBrowser,
  getCurrentTrustedDevices,
  rememberCurrentDevice,
  revokeCurrentTrustedDevice,
  type TrustedDevice,
} from '../data/trustedDevices'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'

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
    if (!parsed.factorId || !parsed.qrCode || !parsed.secret || !parsed.uri) return null
    return {
      factorId: parsed.factorId,
      qrCode: parsed.qrCode,
      secret: parsed.secret,
      uri: parsed.uri,
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
  const [searchParams] = useSearchParams()
  const [context, setContext] = useState<SessionContext | null>(null)
  const [factors, setFactors] = useState<MfaFactorSummary[]>([])
  const [securityKeys, setSecurityKeys] = useState<SecurityKeySummary[]>([])
  const [securityKeyLoadError, setSecurityKeyLoadError] = useState<string | null>(null)
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
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [recoveryCode, setRecoveryCode] = useState('')
  const [showRecoveryEntry, setShowRecoveryEntry] = useState(false)
  const [showRecoveryRegeneration, setShowRecoveryRegeneration] = useState(false)
  const [recoveryVerificationCode, setRecoveryVerificationCode] = useState('')
  const [rawAuthenticatorLevel, setRawAuthenticatorLevel] = useState<string | null>(null)

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
  const isPasswordRecovery = searchParams.get('mode') === 'password-recovery'
  const isSecurityKeyManagement = searchParams.get('mode') === 'security-key-management'
  const verifiedFactors = factors.filter((factor) => factor.status === 'verified')
  const verifiedSecurityKeys = isSecurityKeyManagement ? [] : securityKeys
  const availableVerifiedFactors = verifiedFactors.filter((factor) => factor.factorType === 'totp' || (SMS_MFA_ENABLED && factor.factorType === 'phone'))
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
  const needsPassword = Boolean(context?.mustChangePassword || isPasswordRecovery)
  const needsMfa = Boolean(
    !isPasswordRecovery
      && (isSecurityKeyManagement
        ? rawAuthenticatorLevel !== 'aal2'
        : context?.mfaRequired && !context.hasMfa),
  )
  const passwordWaitingForMfa = needsPassword && needsMfa
  const isComplete = Boolean(context && !needsPassword && !needsMfa)
  const canRememberDevice = Boolean(
    context?.mfaRequired,
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
        const [nextFactors, level] = await Promise.all([
          listMfaFactors(),
          getAuthenticatorLevel(),
        ])
        let nextSecurityKeys: SecurityKeySummary[] = []
        let nextSecurityKeyLoadError: string | null = null
        try {
          nextSecurityKeys = (await getSecurityKeyDirectory()).keys
        } catch {
          nextSecurityKeyLoadError = 'Your registered security key could not be checked. Retry the key check or use your authenticator.'
        }
        if (active) {
          setContext(nextContext)
          setFactors(nextFactors)
          setRawAuthenticatorLevel(level.currentLevel)
          setSecurityKeys(nextSecurityKeys)
          setSecurityKeyLoadError(nextSecurityKeyLoadError)
        }
      } catch {
        await signOut()
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

    const [nextFactors, level] = await Promise.all([
      listMfaFactors(),
      getAuthenticatorLevel(),
    ])
    const nextSecurityKeys = (await getSecurityKeyDirectory()).keys
    setFactors(nextFactors)
    setRawAuthenticatorLevel(level.currentLevel)
    setSecurityKeys(nextSecurityKeys)
    setSecurityKeyLoadError(null)

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

  async function retrySecurityKeyLookup(): Promise<void> {
    setBusyAction('security-key-lookup')
    setSecurityKeyLoadError(null)
    try {
      setSecurityKeys((await getSecurityKeyDirectory()).keys)
    } catch {
      setSecurityKeyLoadError('Your registered security key still could not be checked. Use your authenticator for this session and contact an administrator if the key remains unavailable.')
    } finally {
      setBusyAction(null)
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
    const factorType = availableVerifiedFactors[0].factorType
    if (factorType === 'totp' || factorType === 'phone') setSelectedMfaMethod(factorType)
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
          if (context?.mustChangePassword) await markPasswordChangedWithRetry()
        } else {
          throw new Error(update.error.message || 'The password could not be updated.')
        }
      } else if (context?.mustChangePassword) {
        await markPasswordChangedWithRetry()
      }

      await getSupabaseClient().auth.refreshSession()
      const nextContext = await refreshContext()
      setPassword('')
      setPasswordConfirmation('')
      setShowPassword(false)
      setShowPasswordConfirmation(false)
      setCheckpointVersion((version) => version + 1)

      if (isPasswordRecovery) {
        setMessage('Password reset complete. Opening your account.')
        navigate('/account', { replace: true })
        return
      }

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
      const completedNewEnrollment = Boolean(enrollment || phoneEnrollment)

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
      if (completedNewEnrollment) {
        const batch = await generateMfaRecoveryCodes()
        setRecoveryCodes(batch.codes)
      }
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

      if (completedNewEnrollment) {
        setMessage('MFA is active. Save your one-time recovery codes before continuing.')
      } else if (!nextContext.mustChangePassword && !(nextContext.mfaRequired && !nextContext.hasMfa)) {
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

  async function handleSecurityKeyVerification() {
    setErrorMessage(null)
    setMessage(null)
    setBusyAction('security-key')

    try {
      await authenticateWithSecurityKey()
      const nextContext = await refreshContext()
      setCheckpointVersion((version) => version + 1)
      await refreshTrustedDevices()

      if (!nextContext.mustChangePassword && !(nextContext.mfaRequired && !nextContext.hasMfa)) {
        setMessage('Security key verified. Opening your workspace.')
        navigate(returnPath, { replace: true })
      } else {
        setMessage('Security key verified. Continue with the remaining security step.')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Security key verification failed.')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setMessage(null)
    setBusyAction('recover-mfa')
    try {
      await recoverMfaWithCode(recoveryCode)
      clearRememberedDeviceOnThisBrowser()
      setRecoveryCode('')
      setShowRecoveryEntry(false)
      setEnrollment(null)
      storeTotpEnrollment(null)
      await refreshContext()
      setFactors(await listMfaFactors())
      setSelectedMfaMethod('totp')
      setMessage('Recovery code accepted. Set up a new authenticator now; the remaining codes in that set have been revoked.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The recovery code could not be used.')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRegenerateRecoveryCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage(null)
    setMessage(null)
    setBusyAction('regenerate-recovery')
    try {
      const factor = verifiedTotpFactor ?? verifiedPhoneFactor
      if (!factor) throw new Error('No verified code-based MFA method is available for identity confirmation.')
      const challengeId = await createMfaChallenge(factor.id, factor.factorType)
      await verifyMfaChallenge(factor.id, challengeId, recoveryVerificationCode, factor.factorType)
      const batch = await generateMfaRecoveryCodes()
      setRecoveryCodes(batch.codes)
      setRecoveryVerificationCode('')
      setShowRecoveryRegeneration(false)
      setMessage('A new recovery-code set was created. All previous unused recovery codes are revoked.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Recovery codes could not be regenerated.')
    } finally {
      setBusyAction(null)
    }
  }

  async function copyRecoveryCodes(): Promise<void> {
    await navigator.clipboard.writeText(recoveryCodes.join('\n'))
    setMessage('Recovery codes copied. Store them somewhere private and separate from this device.')
  }

  function downloadRecoveryCodes(): void {
    const content = [
      'SygShift one-time MFA recovery codes',
      'Each code can be used once. Store these privately.',
      '',
      ...recoveryCodes,
    ].join('\n')
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'sygshift-mfa-recovery-codes.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (!isSupabaseConfigured) return <Navigate to="/login" replace />
  if (!loading && !context) return <Navigate to="/login" replace />

  return (
    <main className="security-page">
      <section className="security-card" aria-labelledby="security-title">
        <div className="security-card__heading">
          <div>
            <p className="eyebrow">Account security</p>
            <h1 id="security-title">{isPasswordRecovery ? 'Reset your SygShift password.' : isSecurityKeyManagement ? 'Verify before changing security keys.' : 'Finish securing your SygShift account.'}</h1>
            <p>
              {isPasswordRecovery
                ? 'Choose a new private password for your account. The recovery link can be used only once.'
                : isSecurityKeyManagement
                  ? 'For your protection, security-key registration and removal require a fresh authenticator verification. A key cannot authorize changes to itself.'
                : 'This checkpoint keeps protected schedules, employee records, and administrative tools behind verified access before the workspace opens.'}
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
                      ? isPasswordRecovery
                        ? 'Choose a new private password for your account.'
                        : 'Replace the temporary password with a stronger private password.'
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
                        : !isSecurityKeyManagement && verifiedSecurityKeys.length > 0
                          ? 'Verify with your security key or authenticator app before protected tools open.'
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
            <h2>{isPasswordRecovery ? 'Choose a new password' : 'Create your permanent password'}</h2>
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
            <h2>{isSecurityKeyManagement ? 'Verify with your authenticator' : verifiedFactors.length > 0 ? 'Verify your account' : SMS_MFA_ENABLED ? 'Choose your MFA method' : 'Set up an authenticator app'}</h2>
            <p>
              {isSecurityKeyManagement
                ? 'Enter a current authenticator code. This prevents a stolen or unattended security key from changing the account’s registered keys.'
                : verifiedSecurityKeys.length > 0
                ? 'Use a registered security key, or continue with your authenticator app. Your password and normal account protections remain in place.'
                : SMS_MFA_ENABLED
                ? 'You can use either an authenticator app or a text message code. Set up one method now; add the other later if you want a backup.'
                : 'Use an authenticator app such as Microsoft Authenticator, Google Authenticator, 1Password, Authy, or Apple Passwords.'}
            </p>

            {!isSecurityKeyManagement && securityKeyLoadError ? (
              <div className="auth-notice auth-notice--warning" role="alert">
                <Usb aria-hidden="true" size={21} />
                <span>{securityKeyLoadError}</span>
                <button className="secondary-button" disabled={busyAction !== null} onClick={() => void retrySecurityKeyLookup()} type="button">
                  {busyAction === 'security-key-lookup' ? 'Checking key…' : 'Retry key check'}
                </button>
              </div>
            ) : null}

            {verifiedSecurityKeys.length > 0 ? (
              <div className="security-key-checkpoint" aria-label="Registered security keys">
                <div className="security-key-checkpoint__heading">
                  <span><Usb aria-hidden="true" size={24} /></span>
                  <div>
                    <strong>Security key</strong>
                    <p>Insert or tap your registered key. A successful key check completes MFA for this session.</p>
                  </div>
                </div>
                <div className="security-key-checkpoint__actions">
                  <button
                    className="primary-action"
                    disabled={busyAction !== null}
                    onClick={() => void handleSecurityKeyVerification()}
                    type="button"
                  >
                    {busyAction === 'security-key' ? (
                      <><Loader2 aria-hidden="true" size={18} />Waiting for key…</>
                    ) : (
                      <><Usb aria-hidden="true" size={18} />Use security key</>
                    )}
                  </button>
                </div>
              </div>
            ) : null}

            <div className={SMS_MFA_ENABLED ? 'mfa-method-grid' : 'mfa-method-grid mfa-method-grid--single'} role="list" aria-label="Other MFA method options">
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
                <div className="mfa-setup__instructions">
                  <strong>Setting up MFA on this phone?</strong>
                  <span>
                    Install or open Microsoft Authenticator, Google Authenticator, 1Password, Authy,
                    or another TOTP-compatible authenticator app.
                  </span>
                  <a className="primary-action mfa-app-link" href={enrollment.uri}>Open authenticator app</a>
                  <span>If the app does not open, copy this setup key and add it manually:</span>
                  <div className="mfa-setup__key-row">
                    <code>{enrollment.secret}</code>
                    <button
                      className="secondary-button secondary-button--small"
                      onClick={() => void navigator.clipboard.writeText(enrollment.secret)}
                      type="button"
                    >
                      <Copy aria-hidden="true" size={17} /> Copy key
                    </button>
                  </div>
                  <small>
                    Return to SygShift and enter the six-digit code from the authenticator app.
                    The setup key will not be shown again after verification.
                  </small>
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

            {availableVerifiedFactors.length > 0 && !enrollment && !phoneEnrollment ? (
              <div className="mfa-recovery-entry">
                <button className="text-action" onClick={() => setShowRecoveryEntry((current) => !current)} type="button">
                  {showRecoveryEntry ? 'Use authenticator instead' : 'Use a one-time recovery code'}
                </button>
                {showRecoveryEntry ? (
                  <form className="mfa-form" onSubmit={handleRecovery}>
                    <label className="field-label">
                      <span>Recovery code</span>
                      <input
                        autoComplete="one-time-code"
                        disabled={busyAction === 'recover-mfa'}
                        onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())}
                        placeholder="SYG-XXXX-XXXX"
                        required
                        value={recoveryCode}
                      />
                    </label>
                    <button className="primary-action" disabled={busyAction === 'recover-mfa'} type="submit">
                      Use recovery code
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {recoveryCodes.length > 0 ? (
          <section className="security-panel recovery-code-panel" aria-labelledby="recovery-code-title">
            <div>
              <p className="eyebrow">One-time account recovery</p>
              <h2 id="recovery-code-title">Save these recovery codes now.</h2>
              <p>
                Each code works once. SygShift stores only protected hashes, so this is the only time
                the complete codes can be shown.
              </p>
            </div>
            <div className="recovery-code-grid" aria-label="MFA recovery codes">
              {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
            </div>
            <div className="button-row">
              <button className="secondary-button" onClick={() => void copyRecoveryCodes()} type="button">
                <Copy aria-hidden="true" size={18} /> Copy all
              </button>
              <button className="secondary-button" onClick={downloadRecoveryCodes} type="button">
                <Download aria-hidden="true" size={18} /> Download
              </button>
              <button
                className="primary-action"
                onClick={() => {
                  setRecoveryCodes([])
                  navigate(returnPath, { replace: true })
                }}
                type="button"
              >
                I saved these codes
              </button>
            </div>
          </section>
        ) : null}

        {canRememberDevice && !needsMfa ? (
          <section className="security-panel trusted-device-panel" aria-labelledby="trusted-devices-title">
            <div>
              <h2 id="trusted-devices-title">Remembered devices</h2>
              <p>
                These browsers can open protected SygShift tools without another MFA prompt until they expire.
                Signing out keeps this browser remembered. Use Remove, or an admin revoke, when this device should require MFA again.
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
                        Expires {formatOperationalDateTime(device.expiresAt)}
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

        {context?.mfaRequired && !needsMfa && recoveryCodes.length === 0 ? (
          <section className="security-panel recovery-regeneration-panel">
            <div>
              <h2>Recovery codes</h2>
              <p>
                Generate a fresh set after confirming your identity with your current authenticator.
                Existing unused codes will be revoked.
              </p>
            </div>
            {!showRecoveryRegeneration ? (
              <button className="secondary-button" onClick={() => setShowRecoveryRegeneration(true)} type="button">
                Regenerate recovery codes
              </button>
            ) : (
              <form className="mfa-form" onSubmit={handleRegenerateRecoveryCodes}>
                <label className="field-label">
                  <span>Current authenticator code</span>
                  <input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(event) => setRecoveryVerificationCode(event.target.value)}
                    pattern="[0-9 ]{6,8}"
                    required
                    value={recoveryVerificationCode}
                  />
                </label>
                <button className="primary-action" disabled={busyAction === 'regenerate-recovery'} type="submit">
                  Verify and regenerate
                </button>
              </form>
            )}
          </section>
        ) : null}

        {isComplete && recoveryCodes.length === 0 ? (
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

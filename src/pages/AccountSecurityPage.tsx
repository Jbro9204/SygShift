import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Copy, Eye, EyeOff, KeyRound, Loader2, MessageSquareText, QrCode, ShieldCheck, Usb } from 'lucide-react'
import {
  clearPendingTotpEnrollment,
  getSessionContext,
  isTransientSessionContextError,
  notifySessionContextChanged,
  signOut,
  TOTP_SETUP_STORAGE_KEY,
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
import { passwordChangeResultIsCurrent, updateMyPassword } from '../data/myAccount'
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'

type AccountSecurityLocationState = {
  from?: {
    pathname?: string
    search?: string
    hash?: string
  }
}

type MfaMethod = MfaFactorType
type TrustedDeviceLoadState = 'idle' | 'loading' | 'ready' | 'error'
const SMS_MFA_ENABLED = import.meta.env.VITE_ENABLE_SMS_MFA === 'true'

export type OwnedTotpEnrollment = {
  enrollment: MfaEnrollment
  ownerId: string
}

// oxlint-disable-next-line react/only-export-components -- Pure owner-bound state helper is exported for focused regression coverage.
export function totpEnrollmentForEmployee(
  ownedEnrollment: OwnedTotpEnrollment | null,
  employeeId: string | null | undefined,
): MfaEnrollment | null {
  return ownedEnrollment && employeeId && ownedEnrollment.ownerId === employeeId
    ? ownedEnrollment.enrollment
    : null
}

function readStoredTotpEnrollment(ownerId: string): MfaEnrollment | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(TOTP_SETUP_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      enrollment?: Partial<MfaEnrollment>
      ownerId?: unknown
    }
    if (parsed.ownerId !== ownerId || !parsed.enrollment) {
      clearPendingTotpEnrollment()
      return null
    }
    const enrollment = parsed.enrollment
    if (!enrollment.factorId || !enrollment.qrCode || !enrollment.secret || !enrollment.uri) {
      clearPendingTotpEnrollment()
      return null
    }
    return {
      factorId: enrollment.factorId,
      qrCode: enrollment.qrCode,
      secret: enrollment.secret,
      uri: enrollment.uri,
    }
  } catch {
    clearPendingTotpEnrollment()
    return null
  }
}

function storeTotpEnrollment(enrollment: MfaEnrollment | null, ownerId: string | null = null): void {
  if (typeof window === 'undefined') return
  if (!enrollment || !ownerId) {
    clearPendingTotpEnrollment()
    return
  }
  try {
    window.sessionStorage.setItem(TOTP_SETUP_STORAGE_KEY, JSON.stringify({ enrollment, ownerId }))
  } catch {
    // The active component still owns the secret; unavailable storage should
    // not misreport a successfully started enrollment as a server failure.
  }
}

// oxlint-disable-next-line react/only-export-components -- Pure ownership check is exported for account-switch race coverage.
export function totpEnrollmentResultIsCurrent(
  operation: number,
  currentOperation: number,
  ownerId: string | null,
  activeEmployeeId: string | null,
): boolean {
  return ownerId !== null && operation === currentOperation && activeEmployeeId === ownerId
}

// oxlint-disable-next-line react/only-export-components -- Pure owner/session fence is exported for cross-account verification regression coverage.
export function mfaVerificationResultIsCurrent(
  operation: number,
  currentOperation: number,
  ownerEmployeeId: string | null,
  activeEmployeeId: string | null,
  ownerAuthUserId: string | null,
  activeAuthUserId: string | null,
): boolean {
  return ownerEmployeeId !== null
    && ownerAuthUserId !== null
    && operation === currentOperation
    && activeEmployeeId === ownerEmployeeId
    && activeAuthUserId === ownerAuthUserId
}

export function AccountSecurityPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [context, setContext] = useState<SessionContext | null>(null)
  const [factors, setFactors] = useState<MfaFactorSummary[]>([])
  const [securityKeys, setSecurityKeys] = useState<SecurityKeySummary[]>([])
  const [securityKeyLoadError, setSecurityKeyLoadError] = useState<string | null>(null)
  const [ownedEnrollment, setOwnedEnrollment] = useState<OwnedTotpEnrollment | null>(null)
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
  const [sessionCheckVersion, setSessionCheckVersion] = useState(0)
  const [sessionRetryAvailable, setSessionRetryAvailable] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([])
  const [trustedDeviceLoadState, setTrustedDeviceLoadState] = useState<TrustedDeviceLoadState>('idle')
  const [trustedDeviceLoadError, setTrustedDeviceLoadError] = useState<string | null>(null)
  const [rawAuthenticatorLevel, setRawAuthenticatorLevel] = useState<string | null>(null)
  const totpEnrollmentOperation = useRef(0)
  const mfaVerificationOperation = useRef(0)
  const passwordChangeOperation = useRef(0)
  const activeEmployeeIdRef = useRef<string | null>(null)
  const lastEnrollmentEmployeeIdRef = useRef<string | null | undefined>(undefined)
  activeEmployeeIdRef.current = context?.employeeId ?? null
  const enrollment = totpEnrollmentForEmployee(ownedEnrollment, context?.employeeId)

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
          setSessionRetryAvailable(false)
          setContext(nextContext)
          setFactors(nextFactors)
          setRawAuthenticatorLevel(level.currentLevel)
          setSecurityKeys(nextSecurityKeys)
          setSecurityKeyLoadError(nextSecurityKeyLoadError)
        }
      } catch (error) {
        if (isTransientSessionContextError(error)) {
          if (active) {
            setErrorMessage('SygShift could not verify your secure session yet. Your sign-in was kept; retry the check when the connection recovers.')
            setSessionRetryAvailable(true)
          }
          return
        }
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
  }, [sessionCheckVersion])

  function retrySessionCheck() {
    setErrorMessage(null)
    setSessionRetryAvailable(false)
    setLoading(true)
    setSessionCheckVersion((current) => current + 1)
  }

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

  async function refreshTrustedDevices(): Promise<boolean> {
    if (!canRememberDevice) {
      setTrustedDevices([])
      setTrustedDeviceLoadError(null)
      setTrustedDeviceLoadState('ready')
      return true
    }

    setTrustedDeviceLoadError(null)
    setTrustedDeviceLoadState('loading')
    try {
      setTrustedDevices(await getCurrentTrustedDevices())
      setTrustedDeviceLoadState('ready')
      return true
    } catch {
      setTrustedDeviceLoadError('Remembered devices could not be loaded. Please retry the protected check.')
      setTrustedDeviceLoadState('error')
      return false
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
        if (active) {
          setTrustedDevices([])
          setTrustedDeviceLoadError(null)
          setTrustedDeviceLoadState('idle')
        }
        return
      }

      setTrustedDeviceLoadError(null)
      setTrustedDeviceLoadState('loading')
      try {
        const devices = await getCurrentTrustedDevices()
        if (active) {
          setTrustedDevices(devices)
          setTrustedDeviceLoadState('ready')
        }
      } catch {
        if (active) {
          setTrustedDeviceLoadError('Remembered devices could not be loaded. Please retry the protected check.')
          setTrustedDeviceLoadState('error')
        }
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
    return () => {
      totpEnrollmentOperation.current += 1
      mfaVerificationOperation.current += 1
    }
  }, [])

  useEffect(() => {
    const employeeId = context?.employeeId ?? null
    const previousEmployeeId = lastEnrollmentEmployeeIdRef.current
    if (previousEmployeeId === undefined) {
      // The first resolved employee owns any resumable session enrollment.
      // Do not clear it while the initial session context is still loading.
      if (employeeId) lastEnrollmentEmployeeIdRef.current = employeeId
      return
    }
    if (previousEmployeeId === employeeId) return
    lastEnrollmentEmployeeIdRef.current = employeeId
    totpEnrollmentOperation.current += 1
    mfaVerificationOperation.current += 1
    passwordChangeOperation.current += 1
    setOwnedEnrollment(null)
    clearPendingTotpEnrollment()
    setPassword('')
    setPasswordConfirmation('')
    setMfaCode('')
    setMessage(null)
    setErrorMessage(null)
    setBusyAction(null)
  }, [context?.employeeId])

  useEffect(() => {
    if (!needsMfa || enrollment || verifiedTotpFactor) return
    if (!context?.employeeId) return
    const storedEnrollment = readStoredTotpEnrollment(context.employeeId)
    if (!storedEnrollment) return
    setSelectedMfaMethod('totp')
    setOwnedEnrollment({ enrollment: storedEnrollment, ownerId: context.employeeId })
    setMessage('Authenticator setup is still active. Enter the six-digit code from your app to finish.')
  }, [context?.employeeId, enrollment, needsMfa, verifiedTotpFactor])

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

    const ownerEmployeeId = context?.employeeId ?? null
    if (!ownerEmployeeId) {
      setErrorMessage('Reload your secure account before changing the password.')
      return
    }
    const operation = ++passwordChangeOperation.current
    setBusyAction('password')
    try {
      const result = await updateMyPassword(submittedPassword, ownerEmployeeId)
      if (!passwordChangeResultIsCurrent(
        operation,
        passwordChangeOperation.current,
        ownerEmployeeId,
        activeEmployeeIdRef.current,
        result,
      )) return

      setPassword('')
      setPasswordConfirmation('')
      setShowPassword(false)
      setShowPasswordConfirmation(false)
      setCheckpointVersion((version) => version + 1)

      if (isPasswordRecovery) {
        await signOut()
        navigate('/login', {
          replace: true,
          state: { message: 'Password reset complete. Sign in with your new password.' },
        })
        return
      }

      await getSupabaseClient().auth.refreshSession()
      const nextContext = await refreshContext()

      const nextNeedsMfa = nextContext.mfaRequired && !nextContext.hasMfa
      if (nextNeedsMfa) {
        setMessage('Password saved. Continue with MFA verification.')
      } else {
        setMessage('Password saved. Opening your workspace.')
        navigate(returnPath, { replace: true })
      }
    } catch (error) {
      if (operation === passwordChangeOperation.current && activeEmployeeIdRef.current === ownerEmployeeId) {
        setErrorMessage(error instanceof Error ? error.message : 'The password update failed.')
      }
    } finally {
      if (operation === passwordChangeOperation.current && activeEmployeeIdRef.current === ownerEmployeeId) {
        setBusyAction(null)
      }
    }
  }

  function handleSelectMfaMethod(method: MfaMethod) {
    if (method === 'phone' && !SMS_MFA_ENABLED) return
    setSelectedMfaMethod(method)
    totpEnrollmentOperation.current += 1
    setOwnedEnrollment(null)
    if (method !== 'totp') storeTotpEnrollment(null)
    setPhoneEnrollment(null)
    setPhoneChallengeId(null)
    setMfaCode('')
    setErrorMessage(null)
    setMessage(null)
  }

  async function handleStartEnrollment() {
    const ownerId = context?.employeeId ?? null
    setErrorMessage(null)
    const operation = ++totpEnrollmentOperation.current
    setOwnedEnrollment(null)
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
      if (!ownerId) throw new Error('Your account could not be verified for authenticator setup. Refresh the page and try again.')
      const nextEnrollment = await startTotpEnrollment()
      // A stale account A response must not clear the newer account B setup
      // from session storage. Account A's unfinished remote factor is removed
      // the next time A starts enrollment; it is never exposed to B.
      if (!totpEnrollmentResultIsCurrent(operation, totpEnrollmentOperation.current, ownerId, activeEmployeeIdRef.current)) return
      setOwnedEnrollment({ enrollment: nextEnrollment, ownerId })
      storeTotpEnrollment(nextEnrollment, ownerId)
      setMessage('Authenticator setup is ready. Scan the QR code, then enter the six-digit code from the app.')
      try {
        const nextFactors = await listMfaFactors()
        if (totpEnrollmentResultIsCurrent(operation, totpEnrollmentOperation.current, ownerId, activeEmployeeIdRef.current)) {
          setFactors(nextFactors)
        }
      } catch {
        // The QR code is already available; do not block setup on a secondary list refresh.
      }
    } catch (error) {
      if (!totpEnrollmentResultIsCurrent(operation, totpEnrollmentOperation.current, ownerId, activeEmployeeIdRef.current)) return
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Authenticator setup failed. Refresh the page and try again.',
      )
      try {
        const nextFactors = await listMfaFactors()
        if (totpEnrollmentResultIsCurrent(operation, totpEnrollmentOperation.current, ownerId, activeEmployeeIdRef.current)) {
          setFactors(nextFactors)
        }
      } catch {
        // Keep the original setup error visible instead of replacing it with a secondary refresh error.
      }
    } finally {
      if (totpEnrollmentResultIsCurrent(operation, totpEnrollmentOperation.current, ownerId, activeEmployeeIdRef.current)) {
        setBusyAction(null)
      }
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
    totpEnrollmentOperation.current += 1
    setOwnedEnrollment(null)
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
    totpEnrollmentOperation.current += 1
    setOwnedEnrollment(null)
    storeTotpEnrollment(null)
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
    const ownerEmployeeId = context?.employeeId ?? null
    const operation = ++mfaVerificationOperation.current
    const supabase = getSupabaseClient()
    let ownerAuthUserId: string | null = null
    setErrorMessage(null)
    setMessage(null)
    setBusyAction('verify-mfa')

    try {
      if (!ownerEmployeeId) throw new Error('Your account could not be verified for MFA. Refresh the page and try again.')

      // Bind the entire multi-request transaction to both the verified employee
      // and the authenticated Supabase user. An account switch must stop the
      // flow before any later RPC, remembered-device write, or UI commit.
      const sessionBefore = await supabase.auth.getSession()
      if (sessionBefore.error || !sessionBefore.data.session?.user.id) {
        throw new Error('Your secure session could not be verified. Refresh the page and try again.')
      }
      ownerAuthUserId = sessionBefore.data.session.user.id
      const ownerContext = await getSessionContext()
      const sessionAfter = await supabase.auth.getSession()
      if (
        ownerContext.employeeId !== ownerEmployeeId
        || sessionAfter.error
        || sessionAfter.data.session?.user.id !== ownerAuthUserId
        || !mfaVerificationResultIsCurrent(
          operation,
          mfaVerificationOperation.current,
          ownerEmployeeId,
          activeEmployeeIdRef.current,
          ownerAuthUserId,
          sessionAfter.data.session?.user.id ?? null,
        )
      ) {
        throw new Error('Your signed-in account changed while MFA was being verified. Start the verification again for the current account.')
      }

      async function verificationIsCurrent(): Promise<boolean> {
        if (!mfaVerificationResultIsCurrent(
          operation,
          mfaVerificationOperation.current,
          ownerEmployeeId,
          activeEmployeeIdRef.current,
          ownerAuthUserId,
          ownerAuthUserId,
        )) return false
        const activeSession = await supabase.auth.getSession()
        return !activeSession.error && mfaVerificationResultIsCurrent(
          operation,
          mfaVerificationOperation.current,
          ownerEmployeeId,
          activeEmployeeIdRef.current,
          ownerAuthUserId,
          activeSession.data.session?.user.id ?? null,
        )
      }

      let verifiedMethod: MfaMethod = selectedMfaMethod ?? 'totp'
      const completedNewEnrollment = Boolean(enrollment || phoneEnrollment)

      if (enrollment) {
        await verifyTotpEnrollment(enrollment.factorId, mfaCode)
        if (!await verificationIsCurrent()) return
        verifiedMethod = 'totp'
      } else if (phoneEnrollment) {
        await verifyMfaChallenge(phoneEnrollment.factorId, phoneEnrollment.challengeId, mfaCode, 'phone')
        if (!await verificationIsCurrent()) return
        verifiedMethod = 'phone'
      } else if (activeVerifiedFactor) {
        if (activeVerifiedFactor.factorType === 'phone') {
          if (!phoneChallengeId) throw new Error('Send a text code before verifying SMS MFA.')
          await verifyMfaChallenge(activeVerifiedFactor.id, phoneChallengeId, mfaCode, 'phone')
          if (!await verificationIsCurrent()) return
          verifiedMethod = 'phone'
        } else {
          const challengeId = await createMfaChallenge(activeVerifiedFactor.id, 'totp')
          if (!await verificationIsCurrent()) return
          await verifyMfaChallenge(activeVerifiedFactor.id, challengeId, mfaCode, 'totp')
          if (!await verificationIsCurrent()) return
          verifiedMethod = 'totp'
        }
      } else {
        throw new Error('Choose an MFA method before entering a code.')
      }

      if (!await verificationIsCurrent()) return
      const marked = await supabase.rpc('mark_mfa_enrolled')
      if (!await verificationIsCurrent()) return
      if (marked.error) throw new Error('MFA enrollment could not be recorded.')

      let rememberDeviceFailed = false
      if (rememberDevice && canRememberDevice) {
        try {
          if (!await verificationIsCurrent()) return
          await rememberCurrentDevice(14)
          if (!await verificationIsCurrent()) return
        } catch {
          if (!await verificationIsCurrent()) return
          rememberDeviceFailed = true
        }
      }

      if (!await verificationIsCurrent()) return
      const nextContext = await getSessionContext()
      if (nextContext.employeeId !== ownerEmployeeId || !await verificationIsCurrent()) return
      const [nextFactors, level, nextSecurityKeyDirectory] = await Promise.all([
        listMfaFactors(),
        getAuthenticatorLevel(),
        getSecurityKeyDirectory(),
      ])
      if (!await verificationIsCurrent()) return
      setContext(nextContext)
      setFactors(nextFactors)
      setRawAuthenticatorLevel(level.currentLevel)
      setSecurityKeys(nextSecurityKeyDirectory.keys)
      setSecurityKeyLoadError(null)
      notifySessionContextChanged()
      totpEnrollmentOperation.current += 1
      setOwnedEnrollment(null)
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

      if (completedNewEnrollment) {
        setMessage('MFA is active. One-time recovery codes are paused; use password recovery or contact an administrator if you lose access to your authenticator.')
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
      if (ownerAuthUserId) {
        const activeSession = await supabase.auth.getSession().catch(() => null)
        if (!activeSession || !mfaVerificationResultIsCurrent(
          operation,
          mfaVerificationOperation.current,
          ownerEmployeeId,
          activeEmployeeIdRef.current,
          ownerAuthUserId,
          activeSession.data.session?.user.id ?? null,
        )) return
      } else if (operation !== mfaVerificationOperation.current || activeEmployeeIdRef.current !== ownerEmployeeId) {
        return
      }
      setErrorMessage(error instanceof Error ? error.message : 'MFA verification failed.')
    } finally {
      if (operation === mfaVerificationOperation.current && activeEmployeeIdRef.current === ownerEmployeeId) {
        setBusyAction(null)
      }
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

  if (!isSupabaseConfigured) return <Navigate to="/login" replace />
  if (!loading && !context && !sessionRetryAvailable) return <Navigate to="/login" replace />

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

        {sessionRetryAvailable ? (
          <div className="auth-notice auth-notice--warning" role="alert">
            <ShieldCheck aria-hidden="true" size={21} />
            <div>
              <span>{errorMessage}</span>
              <button className="primary-action" onClick={retrySessionCheck} type="button">
                Retry secure session check
              </button>
            </div>
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

        {errorMessage && !sessionRetryAvailable ? (
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
              <div className="auth-notice auth-notice--warning auth-notice--inline" role="status">
                <ShieldCheck aria-hidden="true" size={21} />
                <span>One-time MFA recovery is temporarily paused until it can safely invalidate every active session. Use password recovery or contact an administrator.</span>
              </div>
            ) : null}
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
            {trustedDeviceLoadState === 'loading' || trustedDeviceLoadState === 'idle' ? (
              <p className="trusted-device-empty" role="status">Checking remembered devices…</p>
            ) : trustedDeviceLoadState === 'error' ? (
              <div className="security-key-error" role="alert">
                <p>
                  Remembered devices could not be verified. No device changes are available until this check succeeds.
                  {trustedDeviceLoadError ? ` ${trustedDeviceLoadError}` : ''}
                </p>
                <button
                  className="secondary-button secondary-button--small"
                  onClick={() => { void refreshTrustedDevices() }}
                  type="button"
                >
                  Retry device check
                </button>
              </div>
            ) : trustedDevices.length === 0 ? (
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
                      disabled={busyAction !== null || trustedDeviceLoadState !== 'ready'}
                      onClick={async () => {
                        const action = `remove-trusted-device:${device.id}`
                        setBusyAction(action)
                        setErrorMessage(null)
                        setMessage(null)
                        try {
                          await revokeCurrentTrustedDevice(device.id)
                          if (device.isCurrentDevice) clearRememberedDeviceOnThisBrowser()
                          if (!await refreshTrustedDevices()) {
                            setMessage('This remembered device was removed, but the remaining device list could not be verified. Retry the device check before making another change.')
                            return
                          }
                          const nextContext = await refreshContext()
                          setMessage(nextContext.mfaRequired && !nextContext.hasMfa
                            ? 'This remembered device was removed. Verify MFA to continue.'
                            : 'This remembered device was removed.')
                        } catch (error) {
                          setErrorMessage(error instanceof Error ? error.message : 'The remembered device could not be removed.')
                        } finally {
                          setBusyAction((current) => current === action ? null : current)
                        }
                      }}
                      type="button"
                    >
                      {busyAction === `remove-trusted-device:${device.id}` ? 'Removing…' : 'Remove'}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {context?.mfaRequired && !needsMfa ? (
          <section className="security-panel recovery-regeneration-panel">
            <div>
              <h2>Recovery codes</h2>
              <p>
                One-time recovery-code generation is paused until recovery can safely invalidate every active session.
                Existing protected code records are preserved. Use password recovery or contact an administrator if you lose access to your authenticator.
              </p>
            </div>
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

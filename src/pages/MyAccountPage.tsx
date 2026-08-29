import {
  Bell,
  CalendarDays,
  Camera,
  Check,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  ShieldCheck,
  Smartphone,
  Trash2,
  Usb,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { canAccessRoute } from '../app/accessPolicy'
import {
  confirmPersonalEmailVerification,
  getMyAccount,
  getMyAccountPhoto,
  type MyAccount,
  type MyAccountNotifications,
  removeMyAccountPhoto,
  requestPersonalEmailVerification,
  signOutOtherSessions,
  updateMyAccountProfile,
  updateMyNotificationPreferences,
  updateMyPassword,
  uploadMyAccountPhoto,
} from '../data/myAccount'
import {
  clearRememberedDeviceOnThisBrowser,
  getCurrentTrustedDevices,
  revokeCurrentTrustedDevice,
  type TrustedDevice,
} from '../data/trustedDevices'
import {
  getSessionContext,
  notifySessionContextChanged,
  type SessionContext,
  validatePassword,
} from '../data/auth'
import {
  getAuthenticatorLevel,
  listMfaFactors,
  type MfaFactorSummary,
} from '../data/mfa'
import {
  getSecurityKeyDirectory,
  isSecurityKeySupported,
  registerSecurityKey,
  removeSecurityKey,
  renameSecurityKey,
  type SecurityKeySummary,
} from '../data/securityKeys'
import { formatOperationalDateTime } from '../lib/time'

type AccountTab = 'profile' | 'employment' | 'security' | 'notifications'
type Feedback = { kind: 'error' | 'success'; text: string } | null

const tabs: Array<{ id: AccountTab; label: string; icon: typeof UserRound }> = [
  { id: 'profile', label: 'Profile & Contact', icon: UserRound },
  { id: 'employment', label: 'Employment', icon: ShieldCheck },
  { id: 'security', label: 'Security', icon: KeyRound },
  { id: 'notifications', label: 'Notifications', icon: Bell },
]

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  guard: 'Guard',
  recruiting_licensing: 'Recruiting & Licensing',
  scheduler: 'Scheduler',
  supervisor: 'Supervisor',
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'SS'
}

function displayValue(value: string | null | undefined): string {
  return value?.trim() || 'Not on file'
}

function formatDate(value: string | null): string {
  if (!value) return 'Not on file'
  const date = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

function friendlyActivity(operation: string): string {
  const names: Record<string, string> = {
    personal_email_verified: 'Personal email verified',
    self_notification_preferences_update: 'Notification preferences changed',
    self_other_sessions_signed_out: 'Other sessions signed out',
    self_password_changed: 'Password changed',
    self_photo_update: 'Profile photo changed',
    self_profile_update: 'Profile information changed',
    self_trusted_device_revoked: 'Remembered device removed',
  }
  return names[operation] || operation.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function StatusMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null
  return <div className={`account-feedback account-feedback--${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</div>
}

function LoadingButton({ busy, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={busy || props.disabled}>
      {busy ? <LoaderCircle aria-hidden="true" className="account-spinner" size={18} /> : null}
      {children}
    </button>
  )
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return <div className="account-readonly"><dt>{label}</dt><dd>{value}</dd></div>
}

function PhotoEditor({
  account,
  photoUrl,
  onChanged,
}: {
  account: MyAccount
  photoUrl: string | null
  onChanged: (hasPhoto: boolean) => Promise<void>
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const cropStage = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [sourceSize, setSourceSize] = useState({ height: 1, width: 1 })
  const [zoom, setZoom] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl) }, [sourceUrl])

  function choosePhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setFeedback({ kind: 'error', text: 'Choose a valid JPG or PNG photo no larger than 5 MB.' })
      return
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    setSourceUrl(URL.createObjectURL(file))
    setZoom(1)
    setPosition({ x: 0, y: 0 })
    setFeedback(null)
  }

  function resetFraming() {
    setZoom(1)
    setPosition({ x: 0, y: 0 })
  }

  function startDragging(event: React.PointerEvent<HTMLDivElement>) {
    if (!sourceUrl) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragState.current = {
      originX: position.x,
      originY: position.y,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    }
    setDragging(true)
  }

  function movePhoto(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setPosition({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    })
  }

  function stopDragging(event: React.PointerEvent<HTMLDivElement>) {
    if (dragState.current?.pointerId !== event.pointerId) return
    dragState.current = null
    setDragging(false)
  }

  async function croppedPhoto(): Promise<Blob> {
    if (!sourceUrl) throw new Error('Choose a photo first.')
    const image = new Image()
    image.src = sourceUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 800
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The photo editor could not be opened.')
    const baseScale = Math.min(800 / image.naturalWidth, 800 / image.naturalHeight)
    const scale = baseScale * zoom
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    const stageSize = cropStage.current?.clientWidth || 320
    const offsetScale = 800 / stageSize
    const x = (800 - width) / 2 + position.x * offsetScale
    const y = (800 - height) / 2 + position.y * offsetScale
    context.fillStyle = '#f4efe5'
    context.fillRect(0, 0, 800, 800)
    context.drawImage(image, x, y, width, height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('The edited photo could not be prepared.')),
      'image/jpeg',
      0.9,
    ))
  }

  async function savePhoto() {
    setBusy(true)
    setFeedback(null)
    try {
      await uploadMyAccountPhoto(await croppedPhoto())
      setSourceUrl(null)
      await onChanged(true)
      notifySessionContextChanged()
      setFeedback({ kind: 'success', text: 'Your profile photo was updated.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Your photo could not be saved.' })
    } finally {
      setBusy(false)
    }
  }

  async function removePhoto() {
    if (!window.confirm('Remove your SygShift profile photo?')) return
    setBusy(true)
    setFeedback(null)
    try {
      await removeMyAccountPhoto()
      await onChanged(false)
      notifySessionContextChanged()
      setFeedback({ kind: 'success', text: 'Your profile photo was removed.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Your photo could not be removed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="account-photo-panel" aria-labelledby="account-photo-title">
      <header className="account-photo-panel__heading">
        <div><h3 id="account-photo-title">Profile photo</h3><p>Use a clear, recent JPG or PNG photo up to 5 MB.</p></div>
      </header>
      <input accept="image/jpeg,image/png" className="visually-hidden" onChange={choosePhoto} ref={fileInput} type="file" />
      {sourceUrl ? (
        <div className="account-photo-editing">
          <div className="account-photo-editing__heading">
            <div>
              <strong>Position your photo</strong>
              <p>Drag the image inside the circle and adjust the zoom if needed.</p>
            </div>
            <button className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()} type="button"><Camera size={18} />Choose different photo</button>
          </div>
          <div className="account-photo-cropper">
            <div
              aria-label="Drag the photo to position it in the frame"
              className={dragging ? 'account-photo-cropper__stage account-photo-cropper__stage--dragging' : 'account-photo-cropper__stage'}
              onPointerCancel={stopDragging}
              onPointerDown={startDragging}
              onPointerMove={movePhoto}
              onPointerUp={stopDragging}
              ref={cropStage}
              role="img"
            >
              <img
                alt="Position your selected profile photo"
                draggable="false"
                onLoad={(event) => setSourceSize({ height: event.currentTarget.naturalHeight, width: event.currentTarget.naturalWidth })}
                src={sourceUrl}
                style={{
                  height: sourceSize.height >= sourceSize.width ? `${100 * zoom}%` : 'auto',
                  transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
                  width: sourceSize.width > sourceSize.height ? `${100 * zoom}%` : 'auto',
                }}
              />
              <span className="account-photo-cropper__guide" aria-hidden="true" />
            </div>
            <div className="account-photo-cropper__controls">
              <label><span>Zoom</span><input max="3" min="1" onChange={(event) => setZoom(Number(event.target.value))} step="0.05" type="range" value={zoom} /></label>
              <button className="text-action" onClick={resetFraming} type="button">Reset framing</button>
            </div>
            <div className="account-actions account-actions--start">
              <LoadingButton busy={busy} className="primary-action" onClick={savePhoto} type="button">Save photo</LoadingButton>
              <button className="secondary-button" disabled={busy} onClick={() => setSourceUrl(null)} type="button">Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="account-photo-summary">
          <div className="account-photo-panel__preview">
            {photoUrl ? <img alt="Your current SygShift profile" src={photoUrl} /> : <span>{initials(account.profile.displayName)}</span>}
          </div>
          <div className="account-photo-summary__copy">
            <strong>{photoUrl ? 'Current profile photo' : 'Add a profile photo'}</strong>
            <p>{photoUrl ? 'This photo appears with your SygShift account.' : 'A profile photo helps your team identify you.'}</p>
          </div>
          <div className="account-photo-summary__actions">
            <button className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()} type="button"><Camera size={18} />{photoUrl ? 'Change photo' : 'Add photo'}</button>
            {photoUrl ? <LoadingButton busy={busy} className="quiet-danger-button" onClick={removePhoto} type="button"><Trash2 size={17} />Remove</LoadingButton> : null}
          </div>
        </div>
      )}
      <div className="account-photo-panel__body">
        <StatusMessage feedback={feedback} />
      </div>
    </section>
  )
}

function ProfileTab({ account, refreshAccount, refreshPhoto, photoUrl }: {
  account: MyAccount
  refreshAccount: (account?: MyAccount) => Promise<void>
  refreshPhoto: (hasPhoto: boolean) => Promise<void>
  photoUrl: string | null
}) {
  const [preferredName, setPreferredName] = useState(account.profile.preferredName || '')
  const [mobilePhone, setMobilePhone] = useState(account.profile.mobilePhone || '')
  const [personalEmail, setPersonalEmail] = useState(account.profile.personalEmail || '')
  const [profileBusy, setProfileBusy] = useState(false)
  const [emailBusy, setEmailBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [emailFeedback, setEmailFeedback] = useState<Feedback>(null)
  const emailAlreadyVerified = Boolean(
    account.profile.personalEmailVerifiedAt
    && personalEmail.trim().toLowerCase() === account.profile.personalEmail?.trim().toLowerCase(),
  )

  useEffect(() => {
    setPreferredName(account.profile.preferredName || '')
    setMobilePhone(account.profile.mobilePhone || '')
    setPersonalEmail(account.profile.personalEmail || '')
  }, [account])

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    setProfileBusy(true)
    setFeedback(null)
    try {
      const updated = await updateMyAccountProfile(preferredName, mobilePhone)
      await refreshAccount(updated)
      notifySessionContextChanged()
      setFeedback({ kind: 'success', text: 'Your profile and contact information was saved.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Your profile could not be saved.' })
    } finally {
      setProfileBusy(false)
    }
  }

  async function verifyEmail(event: React.FormEvent) {
    event.preventDefault()
    setEmailBusy(true)
    setEmailFeedback(null)
    try {
      await requestPersonalEmailVerification(personalEmail)
      setEmailFeedback({ kind: 'success', text: 'Verification sent. Your current personal email stays in place until you confirm the new address.' })
    } catch (error) {
      setEmailFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Verification could not be sent.' })
    } finally {
      setEmailBusy(false)
    }
  }

  return (
    <div className="account-tab-content">
      <PhotoEditor account={account} onChanged={refreshPhoto} photoUrl={photoUrl} />
      <div className="account-form-grid">
        <form className="account-card" onSubmit={saveProfile}>
          <div className="account-card__heading"><div><p className="eyebrow">Personal details</p><h2>Name and phone</h2></div><Smartphone size={22} /></div>
          <label className="form-field"><span>Preferred name</span><input autoComplete="nickname" maxLength={80} onChange={(event) => setPreferredName(event.target.value)} value={preferredName} /></label>
          <p className="field-help">Used in schedules and everyday displays. Your legal name and payroll records do not change.</p>
          <label className="form-field"><span>Mobile phone</span><input autoComplete="tel" inputMode="tel" maxLength={24} onChange={(event) => setMobilePhone(event.target.value)} value={mobilePhone} /></label>
          <p className="field-help">Saved as contact information. SMS verification is not enabled.</p>
          <StatusMessage feedback={feedback} />
          <div className="account-actions"><LoadingButton busy={profileBusy} className="primary-action" type="submit">Save profile</LoadingButton></div>
        </form>

        <form className="account-card" onSubmit={verifyEmail}>
          <div className="account-card__heading"><div><p className="eyebrow">Contact email</p><h2>Personal email</h2></div><Mail size={22} /></div>
          <label className="form-field"><span>Personal email</span><input autoComplete="email" inputMode="email" onChange={(event) => setPersonalEmail(event.target.value)} required type="email" value={personalEmail} /></label>
          <div className="account-verification-state">
            {account.profile.personalEmailVerifiedAt ? <><Check size={17} />Verified {formatOperationalDateTime(account.profile.personalEmailVerifiedAt)}</> : 'Not yet verified'}
          </div>
          <p className="field-help">A new address is not saved until you open its verification link. Use a personal address; company-domain delivery is currently disabled.</p>
          <label className="form-field"><span>Company email</span><input readOnly value={account.profile.companyEmail || 'Not on file'} /></label>
          <p className="field-help">Company email is maintained by an administrator.</p>
          <StatusMessage feedback={emailFeedback} />
          <div className="account-actions"><LoadingButton busy={emailBusy} className="primary-action" disabled={emailAlreadyVerified} type="submit">{emailAlreadyVerified ? 'Email verified' : 'Send verification'}</LoadingButton></div>
        </form>
      </div>
    </div>
  )
}

function EmploymentTab({ account }: { account: MyAccount }) {
  const employment = account.employment
  return (
    <section className="account-card account-card--wide">
      <div className="account-card__heading"><div><p className="eyebrow">Official record</p><h2>Employment information</h2></div><ShieldCheck size={24} /></div>
      <p className="account-card__intro">These details are read-only. Contact an administrator if an official record needs to be corrected.</p>
      <dl className="account-readonly-grid">
        <ReadonlyField label="Legal name" value={employment.legalName} />
        <ReadonlyField label="Employee ID" value={displayValue(employment.employeeNumber)} />
        <ReadonlyField label="Username" value={`@${employment.username}`} />
        <ReadonlyField label="Job title" value={displayValue(employment.jobTitle)} />
        <ReadonlyField label="Primary role" value={roleLabels[employment.primaryRole] || employment.primaryRole} />
        <ReadonlyField label="Employment type" value={employment.employmentType.replace(/^./, (letter) => letter.toUpperCase())} />
        <ReadonlyField label="Employment status" value={employment.status.replace(/^./, (letter) => letter.toUpperCase())} />
        <ReadonlyField label="Hire date" value={formatDate(employment.hiredOn)} />
      </dl>
    </section>
  )
}

function SecurityTab({ account, refreshAccount }: { account: MyAccount; refreshAccount: () => Promise<void> }) {
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [factors, setFactors] = useState<MfaFactorSummary[]>([])
  const [securityKeys, setSecurityKeys] = useState<SecurityKeySummary[]>([])
  const [securityKeyPilotEligible, setSecurityKeyPilotEligible] = useState(false)
  const [securityMethodsLoading, setSecurityMethodsLoading] = useState(true)
  const [rawAuthenticatorLevel, setRawAuthenticatorLevel] = useState<string | null>(null)
  const [securityKeyName, setSecurityKeyName] = useState('Primary security key')
  const [editingSecurityKeyId, setEditingSecurityKeyId] = useState<string | null>(null)
  const [securityKeyRename, setSecurityKeyRename] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const policy = validatePassword(password, account.employment.username)
  const verifiedFactors = factors.filter((factor) => factor.status === 'verified')
  const verifiedAuthenticatorFactors = verifiedFactors.filter((factor) => factor.factorType === 'totp' || factor.factorType === 'phone')
  const securityKeySupported = isSecurityKeySupported()
  const needsFreshMfaForManagement = rawAuthenticatorLevel !== 'aal2'

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true)
    try { setDevices(await getCurrentTrustedDevices()) } catch { setDevices([]) } finally { setDevicesLoading(false) }
  }, [])

  const loadSecurityMethods = useCallback(async () => {
    setSecurityMethodsLoading(true)
    try {
      const [nextFactors, level, securityKeyDirectory] = await Promise.all([
        listMfaFactors(),
        getAuthenticatorLevel(),
        getSecurityKeyDirectory(),
      ])
      setFactors(nextFactors)
      setRawAuthenticatorLevel(level.currentLevel)
      setSecurityKeyPilotEligible(securityKeyDirectory.pilotEligible)
      setSecurityKeys(securityKeyDirectory.keys)
    } catch {
      setFactors([])
      setRawAuthenticatorLevel(null)
      setSecurityKeyPilotEligible(false)
      setSecurityKeys([])
    } finally {
      setSecurityMethodsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDevices()
    void loadSecurityMethods()
  }, [loadDevices, loadSecurityMethods])

  async function addSecurityKey(event: React.FormEvent) {
    event.preventDefault()
    setFeedback(null)

    if (needsFreshMfaForManagement) {
      setFeedback({ kind: 'error', text: 'Verify an existing MFA method before adding a security key.' })
      return
    }

    setBusy('security-key-add')
    try {
      await registerSecurityKey(securityKeyName)
      setSecurityKeyName('Primary security key')
      await Promise.all([loadSecurityMethods(), refreshAccount()])
      notifySessionContextChanged()
      setFeedback({ kind: 'success', text: 'Your security key is registered and can now verify SygShift sign-ins.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'The security key could not be added.' })
    } finally {
      setBusy(null)
    }
  }

  async function handleRemoveSecurityKey(key: SecurityKeySummary) {
    setFeedback(null)

    if (rawAuthenticatorLevel !== 'aal2') {
      setFeedback({ kind: 'error', text: 'Verify MFA before removing a security key.' })
      return
    }
    if (!window.confirm(`Remove ${key.label || 'this security key'} from your SygShift account?`)) return

    setBusy(`security-key-remove-${key.id}`)
    try {
      await removeSecurityKey(key.id)
      await Promise.all([loadSecurityMethods(), refreshAccount()])
      notifySessionContextChanged()
      setFeedback({ kind: 'success', text: 'The security key was removed.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'The security key could not be removed.' })
    } finally {
      setBusy(null)
    }
  }

  function beginRenameSecurityKey(key: SecurityKeySummary) {
    setFeedback(null)
    if (rawAuthenticatorLevel !== 'aal2') {
      setFeedback({ kind: 'error', text: 'Verify MFA before renaming a security key.' })
      return
    }
    setEditingSecurityKeyId(key.id)
    setSecurityKeyRename(key.label)
  }

  async function handleRenameSecurityKey(event: React.FormEvent, key: SecurityKeySummary) {
    event.preventDefault()
    setFeedback(null)
    if (rawAuthenticatorLevel !== 'aal2') {
      setFeedback({ kind: 'error', text: 'Verify MFA before renaming a security key.' })
      return
    }
    setBusy(`security-key-rename-${key.id}`)
    try {
      await renameSecurityKey(key.id, securityKeyRename)
      setEditingSecurityKeyId(null)
      setSecurityKeyRename('')
      await loadSecurityMethods()
      setFeedback({ kind: 'success', text: 'The security key name was updated.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'The security key name could not be updated.' })
    } finally {
      setBusy(null)
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault()
    setFeedback(null)
    if (!policy.valid || password !== confirmPassword) {
      setFeedback({ kind: 'error', text: password !== confirmPassword ? 'The passwords do not match.' : policy.failures.join(' ') })
      return
    }
    setBusy('password')
    try {
      await updateMyPassword(password)
      setPassword('')
      setConfirmPassword('')
      await refreshAccount()
      notifySessionContextChanged()
      setFeedback({ kind: 'success', text: 'Your password was changed.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Your password could not be changed.' })
    } finally { setBusy(null) }
  }

  async function revoke(device: TrustedDevice) {
    if (!window.confirm(`Remove ${device.deviceLabel || 'this browser device'} from remembered devices?`)) return
    setBusy(device.id)
    setFeedback(null)
    try {
      await revokeCurrentTrustedDevice(device.id)
      if (device.isCurrentDevice) clearRememberedDeviceOnThisBrowser()
      await loadDevices()
      await refreshAccount()
      setFeedback({ kind: 'success', text: 'The remembered device was removed.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'The device could not be removed.' })
    } finally { setBusy(null) }
  }

  async function signOutOthers() {
    if (!window.confirm('Sign out every other active SygShift session? This device will remain signed in.')) return
    setBusy('sessions')
    setFeedback(null)
    try {
      await signOutOtherSessions()
      setFeedback({ kind: 'success', text: 'Other signed-in sessions were ended.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Other sessions could not be ended.' })
    } finally { setBusy(null) }
  }

  return (
    <div className="account-tab-content">
      <div className="account-security-summary">
        <div><ShieldCheck size={22} /><span>MFA</span><strong>{account.security.mfaEnrolledAt ? 'Enabled' : account.security.mfaRequired ? 'Required' : 'Not enabled'}</strong></div>
        <div><KeyRound size={22} /><span>Password</span><strong>{account.security.passwordChangedAt ? 'Set' : 'Action needed'}</strong></div>
        <div><Smartphone size={22} /><span>Remembered devices</span><strong>{account.security.trustedDeviceCount}</strong></div>
      </div>
      <StatusMessage feedback={feedback} />

      <div className="account-form-grid">
        <form className="account-card" onSubmit={changePassword}>
          <div className="account-card__heading"><div><p className="eyebrow">Password</p><h2>Change password</h2></div><KeyRound size={22} /></div>
          <label className="form-field"><span>New password</span><span className="password-input"><input autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} type={showPassword ? 'text' : 'password'} value={password} /><button aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)} type="button">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
          <label className="form-field"><span>Confirm new password</span><span className="password-input"><input autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} type={showPassword ? 'text' : 'password'} value={confirmPassword} /></span></label>
          {password && !policy.valid ? <ul className="account-policy-list">{policy.failures.map((failure) => <li key={failure}>{failure}</li>)}</ul> : null}
          <div className="account-actions"><LoadingButton busy={busy === 'password'} className="primary-action" type="submit">Change password</LoadingButton></div>
        </form>

        <section className="account-card">
          <div className="account-card__heading"><div><p className="eyebrow">Authenticator</p><h2>MFA and recovery</h2></div><ShieldCheck size={22} /></div>
          <p className="account-card__intro">Use the protected security tools to set up or replace an authenticator, create recovery codes, or recover MFA.</p>
          <div className="account-security-row"><span>Authenticator status</span><strong>{account.security.mfaEnrolledAt ? 'Enabled' : 'Not enabled'}</strong></div>
          <div className="account-security-row"><span>Last sign-in</span><strong>{account.security.lastSignInAt ? formatOperationalDateTime(account.security.lastSignInAt) : 'No recorded sign-in'}</strong></div>
          <div className="account-actions account-actions--start"><Link className="secondary-button" to="/account-security">Open security tools</Link><LoadingButton busy={busy === 'sessions'} className="secondary-button" onClick={signOutOthers} type="button"><LogOut size={17} />Sign out other sessions</LoadingButton></div>
        </section>
      </div>

      {securityKeyPilotEligible ? <section className="account-card account-card--wide account-security-keys">
        <div className="account-card__heading"><div><p className="eyebrow">Phishing-resistant MFA</p><h2>Security keys</h2></div><Usb size={22} /></div>
        <p className="account-card__intro">Register a FIDO2 security key to complete SygShift MFA with a physical key. Your password remains required, and your authenticator app stays available as a backup. Verify your authenticator before adding or removing security keys.</p>

        {securityMethodsLoading ? (
          <p className="account-loading-inline"><LoaderCircle className="account-spinner" size={18} />Loading security methods…</p>
        ) : (
          <div className="account-security-key-layout">
            <div className="account-security-key-list" aria-label="Registered security keys">
              <div className="account-security-key-list__heading">
                <strong>Registered keys</strong>
                <span>{securityKeys.length}</span>
              </div>
              {securityKeys.length ? securityKeys.map((key) => (
                <div className="account-security-key-row" key={key.id}>
                  <span className="account-security-key-row__icon"><Usb aria-hidden="true" size={19} /></span>
                  {editingSecurityKeyId === key.id ? (
                    <form className="account-security-key-rename" onSubmit={(event) => void handleRenameSecurityKey(event, key)}>
                      <label className="form-field"><span>Key name</span><input autoComplete="off" autoFocus maxLength={60} onChange={(event) => setSecurityKeyRename(event.target.value)} value={securityKeyRename} /></label>
                      <div className="account-security-key-row__actions">
                        <LoadingButton busy={busy === `security-key-rename-${key.id}`} className="secondary-button" type="submit">Save name</LoadingButton>
                        <button className="secondary-button" onClick={() => { setEditingSecurityKeyId(null); setSecurityKeyRename('') }} type="button">Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div>
                        <strong>{key.label}</strong>
                        <span>
                          Added {formatOperationalDateTime(key.createdAt)}
                          {key.lastUsedAt ? ` · Last used ${formatOperationalDateTime(key.lastUsedAt)}` : ' · Not used yet'}
                        </span>
                      </div>
                      <div className="account-security-key-row__actions">
                        <button className="secondary-button" disabled={rawAuthenticatorLevel !== 'aal2'} onClick={() => beginRenameSecurityKey(key)} type="button">Rename</button>
                        <LoadingButton busy={busy === `security-key-remove-${key.id}`} className="quiet-danger-button" disabled={rawAuthenticatorLevel !== 'aal2'} onClick={() => void handleRemoveSecurityKey(key)} type="button">Remove</LoadingButton>
                      </div>
                    </>
                  )}
                </div>
              )) : <p className="account-empty">No security keys are registered.</p>}
            </div>

            <form className="account-security-key-enrollment" onSubmit={addSecurityKey}>
              <div><strong>Add a security key</strong><p>Use a unique name so you can identify the key later.</p></div>
              {!securityKeySupported ? (
                <div className="account-feedback account-feedback--error" role="alert">This browser or connection cannot use security keys. Use a current browser at the secure SygShift address.</div>
              ) : verifiedAuthenticatorFactors.length === 0 ? (
                <div className="account-security-key-verification">
                  <p>Set up an authenticator app before registering a security key. The authenticator remains your protected recovery path.</p>
                  <Link className="primary-action" to="/account-security">
                    <ShieldCheck size={17} />Set up authenticator
                  </Link>
                </div>
              ) : needsFreshMfaForManagement ? (
                <div className="account-security-key-verification">
                  <p>For protection, verify an existing MFA method before changing registered keys.</p>
                  <Link
                    className="primary-action"
                    state={{ from: { pathname: '/account', search: '?tab=security' } }}
                    to="/account-security?mode=security-key-management"
                  >
                    <ShieldCheck size={17} />Verify identity
                  </Link>
                </div>
              ) : (
                <>
                  <label className="form-field"><span>Key name</span><input autoComplete="off" maxLength={60} onChange={(event) => setSecurityKeyName(event.target.value)} value={securityKeyName} /></label>
                  <LoadingButton busy={busy === 'security-key-add'} className="primary-action" disabled={securityKeys.length >= 5} type="submit"><Usb size={17} />{securityKeys.length >= 5 ? 'Key limit reached' : 'Add security key'}</LoadingButton>
                </>
              )}
            </form>
          </div>
        )}
      </section> : null}

      <section className="account-card account-card--wide">
        <div className="account-card__heading"><div><p className="eyebrow">Trusted access</p><h2>Remembered devices</h2></div><Smartphone size={22} /></div>
        {devicesLoading ? <p className="account-loading-inline"><LoaderCircle className="account-spinner" size={18} />Loading devices…</p> : devices.length ? (
          <div className="account-device-list">{devices.map((device) => <div className="account-device-row" key={device.id}><div><strong>{device.deviceLabel || 'Browser device'}{device.isCurrentDevice ? ' · This device' : ''}</strong><span>Last used {device.lastSeenAt ? formatOperationalDateTime(device.lastSeenAt) : 'not recorded'} · Expires {formatOperationalDateTime(device.expiresAt)}</span></div><LoadingButton busy={busy === device.id} className="quiet-danger-button" onClick={() => revoke(device)} type="button">Remove</LoadingButton></div>)}</div>
        ) : <p className="account-empty">No remembered devices are active.</p>}
      </section>

      <section className="account-card account-card--wide">
        <div className="account-card__heading"><div><p className="eyebrow">Audit history</p><h2>Recent account activity</h2></div><Clock3 size={22} /></div>
        {account.recentActivity.length ? <div className="account-activity-list">{account.recentActivity.map((item, index) => <div key={`${item.occurredAt}-${index}`}><span>{item.area}</span><strong>{friendlyActivity(item.operation)}</strong><time>{formatOperationalDateTime(item.occurredAt)}</time></div>)}</div> : <p className="account-empty">No recent account changes are recorded.</p>}
      </section>
    </div>
  )
}

function NotificationsTab({ account, refreshAccount }: { account: MyAccount; refreshAccount: () => Promise<void> }) {
  const [preferences, setPreferences] = useState(account.notifications)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const optional: Array<{ key: keyof MyAccountNotifications; title: string; detail: string }> = [
    { key: 'schedulePublished', title: 'Schedule published', detail: 'When a new schedule is finalized.' },
    { key: 'scheduleChanged', title: 'Schedule changed', detail: 'When a published assignment changes.' },
    { key: 'timeOffDecision', title: 'Time-off decision', detail: 'When a request is approved or denied.' },
    { key: 'openShiftAvailable', title: 'Open shifts', detail: 'When qualified coverage is available.' },
    { key: 'announcements', title: 'Announcements', detail: 'General company and operational announcements.' },
  ]

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFeedback(null)
    try {
      const updated = await updateMyNotificationPreferences(preferences)
      setPreferences(updated)
      await refreshAccount()
      setFeedback({ kind: 'success', text: 'Your notification preferences were saved.' })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Notification preferences could not be saved.' })
    } finally { setBusy(false) }
  }

  return (
    <form className="account-card account-card--wide" onSubmit={save}>
      <div className="account-card__heading"><div><p className="eyebrow">Communication</p><h2>Notification preferences</h2></div><Bell size={24} /></div>
      <p className="account-card__intro">In-app notifications remain available. Email uses your verified personal address: <strong>{account.profile.personalEmailVerifiedAt ? account.profile.personalEmail : 'No verified personal email on file'}</strong>.</p>
      <div className="account-preference-list">
        {optional.map((item) => <label className="account-preference-row" key={item.key}><span><strong>{item.title}</strong><small>{item.detail}</small></span><input checked={preferences[item.key]} onChange={(event) => setPreferences((current) => ({ ...current, [item.key]: event.target.checked }))} type="checkbox" /></label>)}
        <div className="account-preference-row account-preference-row--required"><span><strong>Security and account notices</strong><small>Password, MFA, and critical account alerts cannot be disabled.</small></span><span className="status-chip">Required</span></div>
      </div>
      <StatusMessage feedback={feedback} />
      <div className="account-actions"><LoadingButton busy={busy} className="primary-action" type="submit">Save notification preferences</LoadingButton></div>
    </form>
  )
}

export function MyAccountPage() {
  const [sessionContext, setSessionContext] = useState<SessionContext | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const verificationToken = searchParams.get('verify')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [activeTab, setActiveTab] = useState<AccountTab>(() => {
    const requested = searchParams.get('tab') as AccountTab | null
    return tabs.some((tab) => tab.id === requested) ? requested! : 'profile'
  })
  const [account, setAccount] = useState<MyAccount | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<Feedback>(null)

  const loadPhoto = useCallback(async (hasPhoto: boolean) => {
    setPhotoUrl((current) => { if (current) URL.revokeObjectURL(current); return null })
    if (!hasPhoto) return
    try { setPhotoUrl(URL.createObjectURL(await getMyAccountPhoto())) } catch { setPhotoUrl(null) }
  }, [])

  const loadAccount = useCallback(async (provided?: MyAccount) => {
    const next = provided || await getMyAccount()
    setAccount(next)
    if (!provided) await loadPhoto(next.profile.hasPhoto)
  }, [loadPhoto])

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        if (verificationToken) {
          await confirmPersonalEmailVerification(verificationToken)
          if (!mounted) return
          setSearchParams({ tab: 'profile' }, { replace: true })
          setFeedback({ kind: 'success', text: 'Your personal email was verified and saved.' })
        }
        const [loaded, context] = await Promise.all([getMyAccount(), getSessionContext()])
        if (!mounted) return
        setAccount(loaded)
        setSessionContext(context)
        await loadPhoto(loaded.profile.hasPhoto)
      } catch (error) {
        if (mounted) setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Your account could not be loaded.' })
      } finally { if (mounted) setLoading(false) }
    })()
    return () => { mounted = false }
  }, [loadPhoto, setSearchParams, verificationToken])

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl) }, [photoUrl])

  const quickLinks = useMemo(() => [
    { icon: CalendarDays, label: 'My Schedule', path: '/schedule' },
    { icon: Clock3, label: 'My Time', path: '/time/my-time' },
    { icon: CalendarDays, label: 'Time-Off Requests', path: '/requests' },
    { icon: CalendarDays, label: 'Availability', path: '/availability' },
  ].filter((item) => canAccessRoute(item.path, sessionContext)), [sessionContext])

  function chooseTab(tab: AccountTab) {
    setActiveTab(tab)
    setSearchParams({ tab }, { replace: true })
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    chooseTab(tabs[nextIndex].id)
    tabRefs.current[nextIndex]?.focus()
  }

  if (loading) return <section className="page page--my-account"><div className="account-page-loading" role="status"><LoaderCircle className="account-spinner" />Loading your account…</div></section>
  if (!account) return <section className="page page--my-account"><StatusMessage feedback={feedback || { kind: 'error', text: 'Your account could not be loaded.' }} /></section>

  return (
    <section className="page page--my-account">
      <div className="account-shell">
        <header className="account-hero">
          <div className="account-identity">
            <div className="account-avatar">{photoUrl ? <img alt="" src={photoUrl} /> : <span>{initials(account.profile.displayName)}</span>}</div>
            <div><p className="eyebrow">My Account</p><h1>{account.profile.displayName}</h1><p>@{account.employment.username} · {account.profile.companyEmail || 'No company email on file'}</p><div className="account-statuses"><span className={`status-chip ${account.employment.status === 'active' ? 'status-chip--success' : ''}`}>{account.employment.status.replace(/^./, (letter) => letter.toUpperCase())}</span><span className={`status-chip ${account.security.mfaEnrolledAt ? 'status-chip--success' : ''}`}>MFA {account.security.mfaEnrolledAt ? 'enabled' : 'not enabled'}</span><span className={`status-chip ${account.security.passwordChangedAt ? 'status-chip--success' : ''}`}>{account.security.passwordChangedAt ? 'Password set' : 'Password setup needed'}</span></div></div>
          </div>
          {quickLinks.length ? <nav aria-label="Account quick links" className="account-quick-links">{quickLinks.map((item) => <Link key={item.path} to={item.path}><item.icon size={18} />{item.label}</Link>)}</nav> : null}
        </header>

        <StatusMessage feedback={feedback} />

        <div className="account-tabs" role="tablist" aria-label="Account sections">
          {tabs.map((tab, index) => <button aria-controls={`account-panel-${tab.id}`} aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'account-tab account-tab--active' : 'account-tab'} id={`account-tab-${tab.id}`} key={tab.id} onClick={() => chooseTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)} ref={(element) => { tabRefs.current[index] = element }} role="tab" tabIndex={activeTab === tab.id ? 0 : -1} type="button"><tab.icon size={18} />{tab.label}</button>)}
        </div>

        <div aria-labelledby={`account-tab-${activeTab}`} aria-live="polite" className="account-workspace" id={`account-panel-${activeTab}`} role="tabpanel" tabIndex={0}>
          {activeTab === 'profile' ? <ProfileTab account={account} photoUrl={photoUrl} refreshAccount={loadAccount} refreshPhoto={async (hasPhoto) => { await loadPhoto(hasPhoto); setAccount((current) => current ? { ...current, profile: { ...current.profile, hasPhoto } } : current) }} /> : null}
          {activeTab === 'employment' ? <EmploymentTab account={account} /> : null}
          {activeTab === 'security' ? <SecurityTab account={account} refreshAccount={loadAccount} /> : null}
          {activeTab === 'notifications' ? <NotificationsTab account={account} refreshAccount={loadAccount} /> : null}
        </div>
      </div>
    </section>
  )
}

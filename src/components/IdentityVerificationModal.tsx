import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound, LoaderCircle, ShieldCheck, Usb } from 'lucide-react'
import { createMfaChallenge, listMfaFactors, verifyMfaChallenge, type MfaFactorSummary } from '../data/mfa'
import { authenticateWithSecurityKey, getSecurityKeyDirectory, type SecurityKeySummary } from '../data/securityKeys'
import { ModalDialog } from './ModalDialog'

type VerificationMethod = 'authenticator' | 'security_key'

interface IdentityVerificationModalProps {
  context?: 'general' | 'licensing'
  onCancel: () => void
  onVerified: (method: VerificationMethod) => Promise<void> | void
}

export function IdentityVerificationModal({ context = 'general', onCancel, onVerified }: IdentityVerificationModalProps) {
  const [factors, setFactors] = useState<MfaFactorSummary[]>([])
  const [securityKeys, setSecurityKeys] = useState<SecurityKeySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busyMethod, setBusyMethod] = useState<VerificationMethod | null>(null)
  const [code, setCode] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [securityKeyLookupFailed, setSecurityKeyLookupFailed] = useState(false)

  const verifiedAuthenticator = factors.find((factor) => factor.factorType === 'totp' && factor.status === 'verified') ?? null

  useEffect(() => {
    let active = true

    async function loadMethods() {
      const [factorResult, securityKeyResult] = await Promise.allSettled([
        listMfaFactors(),
        getSecurityKeyDirectory(),
      ])
      if (!active) return

      if (factorResult.status === 'fulfilled') setFactors(factorResult.value)
      if (securityKeyResult.status === 'fulfilled') {
        setSecurityKeys(securityKeyResult.value.keys)
      } else {
        setSecurityKeyLookupFailed(true)
      }

      if (factorResult.status === 'rejected' && securityKeyResult.status === 'rejected') {
        setErrorMessage('Your verification methods could not be loaded. Close this window and try again.')
      }
      setLoading(false)
    }

    void loadMethods()
    return () => { active = false }
  }, [])

  async function complete(method: VerificationMethod) {
    await onVerified(method)
  }

  async function verifySecurityKey() {
    setBusyMethod('security_key')
    setErrorMessage(null)
    try {
      await authenticateWithSecurityKey()
      await complete('security_key')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The security key could not be verified.')
    } finally {
      setBusyMethod(null)
    }
  }

  async function verifyAuthenticator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!verifiedAuthenticator || code.trim().length !== 6) return

    setBusyMethod('authenticator')
    setErrorMessage(null)
    try {
      const challengeId = await createMfaChallenge(verifiedAuthenticator.id, 'totp')
      await verifyMfaChallenge(verifiedAuthenticator.id, challengeId, code, 'totp')
      await complete('authenticator')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The authenticator code could not be verified.')
    } finally {
      setBusyMethod(null)
    }
  }

  const busy = busyMethod !== null
  const hasMethod = securityKeys.length > 0 || Boolean(verifiedAuthenticator)
  const isLicensing = context === 'licensing'

  return (
    <ModalDialog
      busy={busy}
      busyLabel={busyMethod === 'security_key' ? 'Waiting for your security key…' : 'Verifying your authenticator code…'}
      className="identity-verification-modal"
      description={isLicensing
        ? 'Licensing documents contain protected employee information. Confirm your identity to continue; the pending document action will resume automatically.'
        : 'This area contains protected SygShift information. Confirm your identity to continue; the action that brought you here will resume automatically.'}
      dismissible={!busy}
      onClose={onCancel}
      title="Verify your identity"
    >
      <div className="identity-verification-modal__content">
        <div className="identity-verification-modal__notice">
          <ShieldCheck aria-hidden="true" size={22} />
          <div>
            <strong>{isLicensing ? 'Protected document checkpoint' : 'Protected access checkpoint'}</strong>
            <span>{isLicensing
              ? 'Verification remains valid for 15 minutes. Your selected file and licensing information will remain in place.'
              : 'Verification remains valid for 15 minutes. Your current page and entered information will remain in place.'}</span>
          </div>
        </div>

        {loading ? <div className="identity-verification-modal__loading" role="status"><LoaderCircle aria-hidden="true" size={20} />Loading verification methods…</div> : null}

        {!loading && securityKeys.length > 0 ? (
          <section className="identity-verification-method identity-verification-method--primary">
            <span className="identity-verification-method__icon"><Usb aria-hidden="true" size={22} /></span>
            <div><strong>Security key</strong><p>Insert or tap your registered FIDO key, then follow the browser prompt.</p></div>
            <button className="primary-action" disabled={busy} onClick={() => void verifySecurityKey()} type="button"><Usb aria-hidden="true" size={17} />Verify with security key</button>
          </section>
        ) : null}

        {!loading && verifiedAuthenticator ? (
          <form className="identity-verification-method" onSubmit={(event) => void verifyAuthenticator(event)}>
            <span className="identity-verification-method__icon"><KeyRound aria-hidden="true" size={22} /></span>
            <div><strong>Authenticator app</strong><p>Enter the current six-digit code from your enrolled authenticator app.</p></div>
            <label><span>Six-digit code</span><input autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} pattern="[0-9]{6}" required value={code} /></label>
            <button className={securityKeys.length > 0 ? 'secondary-button' : 'primary-action'} disabled={busy || code.length !== 6} type="submit">Verify authenticator</button>
          </form>
        ) : null}

        {!loading && !hasMethod ? (
          <div className="inline-alert" role="alert">No verified identity method is available for this account. An administrator must restore your MFA setup before protected documents can be accessed.</div>
        ) : null}

        {!loading && securityKeyLookupFailed && verifiedAuthenticator ? <p className="form-note">Security-key status could not be loaded. Authenticator verification remains available.</p> : null}
        {errorMessage ? <div className="inline-alert" role="alert">{errorMessage}</div> : null}

        <div className="modal-actions">
          <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">{isLicensing ? 'Cancel' : 'Not now'}</button>
        </div>
      </div>
    </ModalDialog>
  )
}

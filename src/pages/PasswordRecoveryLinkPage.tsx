import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react'
import { verifyPasswordRecoveryToken } from '../data/auth'

function readRecoveryToken(): string {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const query = new URLSearchParams(window.location.search)
  return fragment.get('token_hash') ?? query.get('token_hash') ?? ''
}

export function PasswordRecoveryLinkPage() {
  const navigate = useNavigate()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const tokenHash = readRecoveryToken()

    window.history.replaceState(window.history.state, document.title, '/password-recovery')

    async function verifyLink() {
      try {
        await verifyPasswordRecoveryToken(tokenHash)
        if (active) navigate('/account-security?mode=password-recovery', { replace: true })
      } catch (error) {
        if (!active) return
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'This password-reset link could not be verified. Request a new link and try again.',
        )
      }
    }

    void verifyLink()

    return () => {
      active = false
    }
  }, [navigate])

  return (
    <main className="security-page">
      <section className="security-card security-card--compact" aria-labelledby="recovery-link-title">
        {errorMessage ? (
          <>
            <ShieldAlert aria-hidden="true" size={38} />
            <h1 id="recovery-link-title">This reset link cannot be used.</h1>
            <p role="alert">{errorMessage}</p>
            <Link className="primary-action" to="/login">Return to sign in</Link>
          </>
        ) : (
          <>
            <KeyRound aria-hidden="true" size={38} />
            <h1 id="recovery-link-title">Verifying your secure reset link.</h1>
            <p>This will take only a moment.</p>
            <Loader2 aria-hidden="true" className="spin" size={24} />
            <span className="sr-only" role="status">Verifying password-reset link</span>
          </>
        )}
      </section>
    </main>
  )
}

import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IdentityVerificationHost } from '../../src/components/IdentityVerificationHost'
import { fetchWithIdentityVerification, setIdentityVerificationSurface } from '../../src/lib/identityVerificationCoordinator'
import { refreshFixtureActor, signOutFixtureActor, switchFixtureActor } from './identity-verification-data'
import '../../src/index.css'
import '../../src/App.css'

function Fixture() {
  const [surface, setSurface] = useState('/operations')
  const [actor, setActor] = useState('Supervisor')
  const [result, setResult] = useState('Ready')
  const [attempts, setAttempts] = useState(0)
  const [release, setRelease] = useState<(() => void) | null>(null)
  useLayoutEffect(() => setIdentityVerificationSurface(surface, ''), [surface])
  async function request(kind: 'protected' | 'denied' | 'delayed' | 'schedule') {
    let count = 0
    setAttempts(0)
    setResult('Pending')
    const response = await fetchWithIdentityVerification(async () => {
      count += 1
      setAttempts(count)
      if (kind === 'delayed' && count === 1) await new Promise<void>((resolve) => setRelease(() => resolve))
      const denied = kind === 'denied'
      const needsMfa = kind !== 'schedule' && !denied && count === 1
      return new Response(JSON.stringify({ error: denied ? 'admin_users_permission_required' : needsMfa ? 'operations_mfa_required' : null }), {
        status: denied || needsMfa ? 403 : 200, headers: { 'content-type': 'application/json' },
      })
    })
    setResult(`HTTP ${response.status}`)
  }
  return <main style={{ maxWidth: 900, padding: 16, margin: 'auto' }}>
    <h1>Identity verification regression fixture</h1>
    <p>No production connection. Actual verification host and modal, isolated transport.</p>
    <p>Signed in: <strong>{actor}</strong> · Page: <strong>{surface}</strong></p>
    <div className="modal-actions">
      <button onClick={() => { switchFixtureActor(true); setActor('Guard'); setSurface('/schedule') }}>Switch to Guard</button>
      <button onClick={() => { switchFixtureActor(false); setActor('Supervisor'); setSurface('/operations') }}>Switch to Supervisor</button>
      <button onClick={() => { signOutFixtureActor(); setActor('Signed out') }}>Sign out</button>
      <button onClick={() => setSurface('/schedule')}>Navigate to Schedule</button>
      <button onClick={refreshFixtureActor}>Refresh same session</button>
    </div>
    <div className="modal-actions">
      <button onClick={() => void request('schedule')}>Read my schedule</button>
      <button onClick={() => void request('protected')}>Protected action</button>
      <button onClick={() => void request('denied')}>Permission denied action</button>
      <button onClick={() => void request('delayed')}>Start delayed protected response</button>
      {release ? <button onClick={() => { release(); setRelease(null) }}>Release delayed response</button> : null}
    </div>
    <output aria-label="Request result">{result}</output>
    <output aria-label="Request attempts">{attempts}</output>
    <IdentityVerificationHost />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

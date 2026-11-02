import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityVerificationHost } from './IdentityVerificationHost'
import { fetchWithIdentityVerification, setIdentityVerificationSurface } from '../lib/identityVerificationCoordinator'

type ModalProps = {
  actor?: unknown
  onCancel: () => void
  onVerified: (method: 'authenticator' | 'security_key') => Promise<void> | void
}
const fixture = vi.hoisted(() => ({
  session: null as Session | null,
  listener: null as ((event: AuthChangeEvent, session: Session | null) => void) | null,
  rendered: [] as ModalProps[],
}))
vi.mock('../lib/supabase', () => {
  const client = { auth: {
    getSession: async () => ({ data: { session: fixture.session }, error: null }),
    onAuthStateChange: (listener: typeof fixture.listener) => {
      fixture.listener = listener
      return { data: { subscription: { unsubscribe: () => { if (fixture.listener === listener) fixture.listener = null } } } }
    },
  } }
  return { getSupabaseClient: () => client }
})
vi.mock('../lib/sharedIdentitySession', () => ({ getSharedIdentitySessionScope: () => null }))
vi.mock('./IdentityVerificationModal', () => ({ IdentityVerificationModal: (props: ModalProps) => {
  fixture.rendered.push(props)
  return <div role="dialog" aria-label="Verify your identity"><button type="button" onClick={props.onCancel}>Cancel verification</button><button type="button" onClick={() => void props.onVerified('authenticator')}>Verify current session</button></div>
} }))

function session(user = '10000000-0000-4000-8000-000000000001'): Session {
  return {
    access_token: `header.${btoa(JSON.stringify({ sub: user, session_id: crypto.randomUUID() }))}.signature`,
    refresh_token: 'local-test-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: user, factors: [], app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-02T12:00:00.000Z' },
  }
}
function denied() { return Response.json({ error: 'recent_document_mfa_required' }, { status: 403 }) }

beforeEach(() => {
  fixture.session = session()
  fixture.rendered = []
  setIdentityVerificationSurface('/hr/documents', `?test=${crypto.randomUUID()}`)
})

describe('IdentityVerificationHost ownership', () => {
  it('removes the old account modal and ignores its delayed verified/cancel callbacks against a new account', async () => {
    render(<IdentityVerificationHost />)
    const oldRequest = vi.fn().mockResolvedValue(denied())
    const first = fetchWithIdentityVerification(oldRequest)
    await screen.findByRole('dialog', { name: 'Verify your identity' })
    const old = fixture.rendered.at(-1)!
    expect(old.actor).toBeDefined()
    act(() => {
      fixture.session = session('10000000-0000-4000-8000-000000000002')
      fixture.listener?.('SIGNED_IN', fixture.session)
    })
    await first
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const newRequest = vi.fn().mockResolvedValueOnce(denied()).mockResolvedValueOnce(Response.json({ ok: true }))
    const second = fetchWithIdentityVerification(newRequest)
    await screen.findByRole('dialog')
    await act(async () => { await old.onVerified('authenticator'); old.onCancel() })
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(newRequest).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Verify current session' }))
    await expect(second).resolves.toMatchObject({ status: 200 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(oldRequest).toHaveBeenCalledTimes(1)
    expect(newRequest).toHaveBeenCalledTimes(2)
  })

  it('dismisses the protected-page modal when navigating to the Guard schedule', async () => {
    render(<IdentityVerificationHost />)
    const request = vi.fn().mockResolvedValue(denied())
    const result = fetchWithIdentityVerification(request)
    await screen.findByRole('dialog')
    act(() => setIdentityVerificationSurface('/schedule', '?week=2026-11-01'))
    await result
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('removes the pending modal on provider sign-out without requiring user cancellation', async () => {
    render(<IdentityVerificationHost />)
    const request = vi.fn().mockResolvedValue(denied())
    const result = fetchWithIdentityVerification(request)
    await screen.findByRole('dialog')
    act(() => { fixture.session = null; fixture.listener?.('SIGNED_OUT', null) })
    await result
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })
})

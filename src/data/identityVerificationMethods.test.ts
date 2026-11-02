import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureIdentityVerificationActor,
  clearIdentityVerificationSession,
  setIdentityVerificationSurface,
  type IdentityVerificationActor,
} from '../lib/identityVerificationCoordinator'
import { createMfaChallenge, verifyMfaChallenge } from './mfa'
import { authenticateWithSecurityKey } from './securityKeys'

const selected = vi.hoisted(() => ({ client: null as unknown as SupabaseClient }))
const webAuthn = vi.hoisted(() => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }))
const securityKeySession = vi.hoisted(() => ({ set: vi.fn() }))

vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => selected.client }))
vi.mock('../lib/sharedIdentitySession', () => ({ getSharedIdentitySessionScope: () => null }))
vi.mock('../lib/protectedSessionHeaders', () => ({ appendProtectedSessionHeaders: (headers: HeadersInit) => new Headers(headers) }))
vi.mock('../lib/securityKeySession', () => ({ setSecurityKeySession: securityKeySession.set }))
vi.mock('@simplewebauthn/browser', () => webAuthn)

const userA = '10000000-0000-4000-8000-000000000001'
const userB = '10000000-0000-4000-8000-000000000002'
const changedSessionMessage = 'The signed-in session changed. Retry from the current page.'

function session(userId = userA, sessionId: string = crypto.randomUUID(), aal = 'aal1'): Session {
  return {
    access_token: `fixture.${btoa(JSON.stringify({ sub: userId, session_id: sessionId, aal }))}.not-a-real-token`,
    refresh_token: 'local-fixture-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: userId, aud: 'authenticated', factors: [], app_metadata: {}, user_metadata: {}, created_at: '2026-11-02T12:00:00.000Z' },
  }
}

function client(initial = session()) {
  let current = initial
  const listeners = new Set<(event: AuthChangeEvent, value: Session | null) => void>()
  const getSession = vi.fn(async () => ({ data: { session: current }, error: null }))
  const challenge = vi.fn(async () => ({ data: { id: 'fixture-challenge' }, error: null }))
  const verify = vi.fn(async () => ({ data: {}, error: null }))
  const refreshSession = vi.fn(async () => ({ data: { session: current }, error: null }))
  const value = {
    auth: {
      getSession, refreshSession, mfa: { challenge, verify },
      onAuthStateChange: vi.fn((listener: (event: AuthChangeEvent, value: Session | null) => void) => {
        listeners.add(listener)
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }
      }),
    },
  } as unknown as SupabaseClient
  return {
    value, getSession, challenge, verify, refreshSession,
    emit(event: AuthChangeEvent, next: Session) {
      current = next
      listeners.forEach((listener) => listener(event, next))
    },
    current: () => current,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function actor(): Promise<IdentityVerificationActor> {
  const captured = await captureIdentityVerificationActor()
  if (!captured) throw new Error('The local authenticated actor fixture was not captured.')
  return captured
}

function keyOptionsResponse() {
  return Response.json({
    challengeId: '20000000-0000-4000-8000-000000000001',
    options: { challenge: 'fixture-webauthn-challenge' }, requestId: 'fixture-request',
  })
}

function keyVerifiedResponse() {
  return Response.json({
    securityKeyToken: 'synthetic-local-key-session-token-not-a-real-credential',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), requestId: 'fixture-request',
  })
}

let original: ReturnType<typeof client>
let replacement: ReturnType<typeof client>
beforeEach(() => {
  vi.clearAllMocks()
  original = client()
  replacement = client(session(userB))
  selected.client = original.value
  setIdentityVerificationSurface('/account/security', `?fixture=${crypto.randomUUID()}`)
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class PublicKeyCredential {} })
  webAuthn.startAuthentication.mockResolvedValue({ id: 'fixture-assertion' })
})

afterEach(() => {
  clearIdentityVerificationSession()
  vi.unstubAllGlobals()
})

describe('actor-bound identity verification methods', () => {
  it('uses the captured client to create and verify an authenticator challenge', async () => {
    const captured = await actor()

    await expect(createMfaChallenge('fixture-factor', 'totp', captured)).resolves.toBe('fixture-challenge')
    await expect(verifyMfaChallenge('fixture-factor', 'fixture-challenge', ' 123456 ', 'totp', captured)).resolves.toBeUndefined()

    expect(original.challenge).toHaveBeenCalledWith({ factorId: 'fixture-factor' })
    expect(original.verify).toHaveBeenCalledWith({ factorId: 'fixture-factor', challengeId: 'fixture-challenge', code: '123456' })
    expect(original.refreshSession).toHaveBeenCalledTimes(1)
    expect(replacement.challenge).not.toHaveBeenCalled()
    expect(replacement.verify).not.toHaveBeenCalled()
    expect(replacement.refreshSession).not.toHaveBeenCalled()
  })

  it('rejects a late authenticator challenge after the account changes', async () => {
    const captured = await actor()
    const delayed = deferred<Awaited<ReturnType<typeof original.challenge>>>()
    original.challenge.mockReturnValueOnce(delayed.promise)
    const pending = createMfaChallenge('fixture-factor', 'totp', captured)
    const rejected = expect(pending).rejects.toThrow(changedSessionMessage)
    await vi.waitFor(() => expect(original.challenge).toHaveBeenCalledTimes(1))

    original.emit('SIGNED_IN', session(userB))
    delayed.resolve({ data: { id: 'old-account-challenge' }, error: null })

    await rejected
    expect(original.verify).not.toHaveBeenCalled()
    expect(replacement.challenge).not.toHaveBeenCalled()
  })

  it.each(['account', 'client'] as const)('does not refresh either account after a %s change during authenticator verification', async (change) => {
    const captured = await actor()
    const delayed = deferred<Awaited<ReturnType<typeof original.verify>>>()
    original.verify.mockReturnValueOnce(delayed.promise)
    const pending = verifyMfaChallenge('fixture-factor', 'fixture-challenge', '123456', 'totp', captured)
    const rejected = expect(pending).rejects.toThrow(changedSessionMessage)
    await vi.waitFor(() => expect(original.verify).toHaveBeenCalledTimes(1))

    if (change === 'account') original.emit('SIGNED_IN', session(userB))
    else selected.client = replacement.value
    delayed.resolve({ data: {}, error: null })

    await rejected
    expect(original.refreshSession).not.toHaveBeenCalled()
    expect(replacement.verify).not.toHaveBeenCalled()
    expect(replacement.refreshSession).not.toHaveBeenCalled()
  })

  it('rejects a late refresh result without refreshing the replacement client', async () => {
    const captured = await actor()
    const delayed = deferred<Awaited<ReturnType<typeof original.refreshSession>>>()
    original.refreshSession.mockReturnValueOnce(delayed.promise)
    const pending = verifyMfaChallenge('fixture-factor', 'fixture-challenge', '123456', 'totp', captured)
    const rejected = expect(pending).rejects.toThrow(changedSessionMessage)
    await vi.waitFor(() => expect(original.refreshSession).toHaveBeenCalledTimes(1))

    selected.client = replacement.value
    delayed.resolve({ data: { session: original.current() }, error: null })

    await rejected
    expect(replacement.refreshSession).not.toHaveBeenCalled()
  })

  it('allows a same-session assurance upgrade and refreshes only its captured client', async () => {
    const current = original.current()
    const sessionId = JSON.parse(atob(current.access_token.split('.')[1])).session_id as string
    const captured = await actor()
    original.verify.mockImplementationOnce(async () => {
      original.emit('MFA_CHALLENGE_VERIFIED', session(userA, sessionId, 'aal2'))
      return { data: {}, error: null }
    })

    await expect(verifyMfaChallenge('fixture-factor', 'fixture-challenge', '123456', 'totp', captured)).resolves.toBeUndefined()
    expect(original.refreshSession).toHaveBeenCalledTimes(1)
    expect(replacement.refreshSession).not.toHaveBeenCalled()
  })

  it('retains unscoped authenticator and SMS verification for the existing account-security flow', async () => {
    await expect(createMfaChallenge('fixture-phone-factor', 'phone')).resolves.toBe('fixture-challenge')
    await expect(verifyMfaChallenge('fixture-factor', 'fixture-challenge', '123456')).resolves.toBeUndefined()
    await expect(verifyMfaChallenge('fixture-phone-factor', 'fixture-challenge', '654321', 'phone')).resolves.toBeUndefined()

    expect(original.challenge).toHaveBeenCalledWith({ factorId: 'fixture-phone-factor', channel: 'sms' })
    expect(original.verify).toHaveBeenCalledTimes(2)
    expect(original.refreshSession).toHaveBeenCalledTimes(2)
  })

  it('persists a verified security-key session only for the same captured actor', async () => {
    const captured = await actor()
    const fetch = vi.fn().mockResolvedValueOnce(keyOptionsResponse()).mockResolvedValueOnce(keyVerifiedResponse())
    vi.stubGlobal('fetch', fetch)

    await expect(authenticateWithSecurityKey(captured)).resolves.toBeUndefined()

    expect(webAuthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'fixture-webauthn-challenge' } })
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${original.current().access_token}`)
    }
    expect(replacement.getSession).not.toHaveBeenCalled()
    expect(securityKeySession.set).toHaveBeenCalledTimes(1)
  })

  it.each(['account', 'client'] as const)('does not persist a late FIDO verification response after a %s change', async (change) => {
    const captured = await actor()
    const delayed = deferred<Response>()
    const fetch = vi.fn().mockResolvedValueOnce(keyOptionsResponse()).mockReturnValueOnce(delayed.promise)
    vi.stubGlobal('fetch', fetch)
    const pending = authenticateWithSecurityKey(captured)
    const rejected = expect(pending).rejects.toThrow(changedSessionMessage)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    if (change === 'account') original.emit('SIGNED_IN', session(userB))
    else selected.client = replacement.value
    delayed.resolve(keyVerifiedResponse())

    await rejected
    expect(securityKeySession.set).not.toHaveBeenCalled()
    expect(replacement.getSession).not.toHaveBeenCalled()
  })

  it('does not send a FIDO assertion to the replacement account after the browser challenge finishes late', async () => {
    const captured = await actor()
    const delayed = deferred<{ id: string }>()
    webAuthn.startAuthentication.mockReturnValueOnce(delayed.promise)
    const fetch = vi.fn().mockResolvedValueOnce(keyOptionsResponse())
    vi.stubGlobal('fetch', fetch)
    const pending = authenticateWithSecurityKey(captured)
    const rejected = expect(pending).rejects.toThrow(changedSessionMessage)
    await vi.waitFor(() => expect(webAuthn.startAuthentication).toHaveBeenCalledTimes(1))

    selected.client = replacement.value
    delayed.resolve({ id: 'late-old-account-assertion' })

    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(securityKeySession.set).not.toHaveBeenCalled()
    expect(replacement.getSession).not.toHaveBeenCalled()
  })

  it('retains the existing unscoped security-key authentication flow', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(keyOptionsResponse()).mockResolvedValueOnce(keyVerifiedResponse())
    vi.stubGlobal('fetch', fetch)

    await expect(authenticateWithSecurityKey()).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(original.getSession).toHaveBeenCalledTimes(2)
    expect(securityKeySession.set).toHaveBeenCalledTimes(1)
  })
})

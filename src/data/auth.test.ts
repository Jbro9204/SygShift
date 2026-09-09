import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_EMAIL_DOMAIN,
  authSessionIdFromAccessToken,
  isValidUsername,
  normalizeUsername,
  recordCompletedSignIn,
  recordCompletedSignInWithRetry,
  signOut,
  usernameToAuthEmail,
  validatePassword,
  verifyPasswordRecoveryToken,
} from './auth'
import {
  clearTrustedDeviceToken,
  getTrustedDeviceToken,
  setTrustedDeviceToken,
} from '../lib/trustedDeviceToken'

const supabaseMock = vi.hoisted(() => ({
  deactivateSharedIdentitySupabaseSession: vi.fn(),
  client: {
    auth: {
      signOut: vi.fn(),
      verifyOtp: vi.fn(),
    },
    rpc: vi.fn(),
  },
}))

vi.mock('../lib/supabase', () => ({
  deactivateSharedIdentitySupabaseSession: supabaseMock.deactivateSharedIdentitySupabaseSession,
  getSupabaseClient: () => supabaseMock.client,
}))

describe('auth helpers', () => {
  it('normalizes directory usernames before creating Supabase auth identifiers', () => {
    expect(normalizeUsername(' JBrown ')).toBe('jbrown')
    expect(usernameToAuthEmail(' JBrown ')).toBe(`jbrown@${AUTH_EMAIL_DOMAIN}`)
  })

  it('rejects malformed usernames', () => {
    expect(isValidUsername('jbrown')).toBe(true)
    expect(isValidUsername('1brown')).toBe(false)
    expect(isValidUsername('j.brown')).toBe(false)
    expect(() => usernameToAuthEmail('j brown')).toThrow('valid SygShift username')
  })

  it('requires permanent passwords to be strong and account-specific', () => {
    expect(validatePassword('short', 'jbrown').valid).toBe(false)
    expect(validatePassword('JBrown-Schedule-2026!', 'jbrown').valid).toBe(false)
    expect(validatePassword('Copper!River!4729', 'jbrown').valid).toBe(true)
  })
})

describe('signOut', () => {
  it('keeps remembered-device trust available for the next login', async () => {
    localStorage.setItem('sygshift:trusted-device-token:v1', 'remembered-device-token')
    supabaseMock.client.auth.signOut.mockResolvedValueOnce({ error: null })

    await signOut()

    expect(supabaseMock.deactivateSharedIdentitySupabaseSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem('sygshift:trusted-device-token:v1')).toBe('remembered-device-token')
  })
})

describe('password recovery verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('establishes a recovery session from a valid one-time token hash', async () => {
    const tokenHash = 'a'.repeat(64)
    supabaseMock.client.auth.verifyOtp.mockResolvedValueOnce({
      data: { session: { access_token: 'recovery-session' } },
      error: null,
    })

    await verifyPasswordRecoveryToken(tokenHash)

    expect(supabaseMock.client.auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: tokenHash,
      type: 'recovery',
    })
  })

  it('rejects malformed recovery tokens without calling Supabase', async () => {
    await expect(verifyPasswordRecoveryToken('not a token')).rejects.toThrow('invalid or has expired')
    expect(supabaseMock.client.auth.verifyOtp).not.toHaveBeenCalled()
  })
})

describe('completed sign-in activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    supabaseMock.client.rpc.mockResolvedValue({ data: null, error: null })
  })

  it('records native and shared SygSphere sessions through separate guarded RPCs', async () => {
    await recordCompletedSignIn()
    await recordCompletedSignIn(true)

    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(1, 'record_completed_sign_in')
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(2, 'sygsphere_record_completed_sign_in')
  })

  it('does not silently accept a failed activity record', async () => {
    supabaseMock.client.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'checkpoint incomplete' },
      status: 403,
    })

    await expect(recordCompletedSignIn()).rejects.toThrow('could not be recorded')
  })

  it('retries a temporary activity-recording failure without creating another sign-in', async () => {
    supabaseMock.client.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'schema cache refreshing' }, status: 404 })
      .mockResolvedValueOnce({ data: null, error: null, status: 200 })

    await recordCompletedSignInWithRetry(false, { retryDelaysMs: [0, 0] })

    expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(2)
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(1, 'record_completed_sign_in')
    expect(supabaseMock.client.rpc).toHaveBeenNthCalledWith(2, 'record_completed_sign_in')
  })

  it('does not retry a rejected or incomplete security checkpoint', async () => {
    supabaseMock.client.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'required MFA incomplete' },
      status: 403,
    })

    await expect(recordCompletedSignInWithRetry(false, {
      maxAttempts: 4,
      retryDelaysMs: [0],
    })).rejects.toThrow('could not be recorded')

    expect(supabaseMock.client.rpc).toHaveBeenCalledOnce()
  })

  it('bounds persistent transient retries at the configured release backoff', async () => {
    vi.useFakeTimers()
    supabaseMock.client.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'schema cache refreshing' },
      status: 404,
    })

    try {
      const rejection = expect(recordCompletedSignInWithRetry()).rejects.toThrow('could not be recorded')
      await vi.runAllTimersAsync()
      await rejection
      expect(supabaseMock.client.rpc).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('extracts the auth session identity used to trigger one record per login session', () => {
    const sessionId = '7c21701a-56ed-4c64-8c47-c9dc516e4398'
    const payload = globalThis.btoa(JSON.stringify({ session_id: sessionId }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')

    expect(authSessionIdFromAccessToken(`header.${payload}.signature`)).toBe(sessionId)
    expect(authSessionIdFromAccessToken('not-a-jwt')).toBeNull()
  })
})

describe('trusted device token storage', () => {
  it('keeps a secure cookie backup when remembering MFA on this browser', () => {
    clearTrustedDeviceToken()

    setTrustedDeviceToken('remembered-device-token')

    expect(getTrustedDeviceToken()).toBe('remembered-device-token')
    expect(document.cookie).toContain('sygshift_trusted_device=remembered-device-token')

    localStorage.removeItem('sygshift:trusted-device-token:v1')
    expect(getTrustedDeviceToken()).toBe('remembered-device-token')

    clearTrustedDeviceToken()
    expect(getTrustedDeviceToken()).toBeNull()
  })
})

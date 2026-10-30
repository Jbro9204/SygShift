import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeEmergencyPlatformSessionRevocation,
  EMERGENCY_PLATFORM_SESSION_ACKNOWLEDGEMENT_ENDPOINT,
  EMERGENCY_PLATFORM_SESSION_REGISTER_ENDPOINT,
  isExplicitEmergencyPlatformSessionRevocationError,
  isTransientEmergencyPlatformSessionError,
  registerEmergencyPlatformSession,
} from './emergencyAccessSession'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: mocks.getSession } }),
}))

describe('central emergency platform session client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'verified-access-token' } },
      error: null,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers the verified access generation through the same-origin Worker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      accessGeneration: 4,
      application: 'sygshift',
      expiresAt: '2026-10-29T23:00:00.000Z',
      id: '359c4100-06f1-4e37-8b40-b264ff10f009',
      registered: true,
      requestId: 'a134497f-c911-43db-94d6-5bacf385f001',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(registerEmergencyPlatformSession(4, 'verified-access-token')).resolves.toMatchObject({
      accessGeneration: 4,
      application: 'sygshift',
      registered: true,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      EMERGENCY_PLATFORM_SESSION_REGISTER_ENDPOINT,
      expect.objectContaining({
        body: JSON.stringify({ expectedAccessGeneration: 4 }),
        method: 'POST',
      }),
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer verified-access-token')
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('rejects a registration response for a different generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      accessGeneration: 5,
      application: 'sygshift',
      expiresAt: '2026-10-29T23:00:00.000Z',
      id: '359c4100-06f1-4e37-8b40-b264ff10f009',
      registered: true,
    })))

    const rejection = await registerEmergencyPlatformSession(4, 'verified-access-token').catch((error: unknown) => error)
    expect(isTransientEmergencyPlatformSessionError(rejection)).toBe(false)
    expect(isExplicitEmergencyPlatformSessionRevocationError(rejection)).toBe(false)
  })

  it('acknowledges the exact forced-logout operation with the captured revoked token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      accessGeneration: 7,
      acknowledged: true,
      acknowledgedAt: '2026-10-29T22:15:00.000Z',
      application: 'sygshift',
      closed: true,
      operationId: 'b019d590-b606-4b59-91f4-87311169ca2c',
      requestId: 'f8cb2739-abce-43c0-a974-3b55de37d8d5',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(acknowledgeEmergencyPlatformSessionRevocation(
      'b019d590-b606-4b59-91f4-87311169ca2c',
      7,
      'captured-revoked-access-token',
    )).resolves.toMatchObject({ acknowledged: true, closed: true })

    expect(fetchMock).toHaveBeenCalledWith(
      EMERGENCY_PLATFORM_SESSION_ACKNOWLEDGEMENT_ENDPOINT,
      expect.objectContaining({
        body: JSON.stringify({
          accessGeneration: 7,
          operationId: 'b019d590-b606-4b59-91f4-87311169ca2c',
        }),
        method: 'POST',
      }),
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer captured-revoked-access-token')
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('classifies upstream registration unavailability as transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { error: 'platform_session_registration_unavailable' },
      { status: 503 },
    )))

    const rejection = await registerEmergencyPlatformSession(4, 'verified-access-token').catch((error: unknown) => error)
    expect(isTransientEmergencyPlatformSessionError(rejection)).toBe(true)
    expect(isExplicitEmergencyPlatformSessionRevocationError(rejection)).toBe(false)
  })

  it('distinguishes explicit revocation from a compatibility response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'access_generation_changed' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: 'access_revoked' }, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const compatibilityFailure = await registerEmergencyPlatformSession(4, 'verified-access-token').catch((error: unknown) => error)
    expect(isTransientEmergencyPlatformSessionError(compatibilityFailure)).toBe(false)
    expect(isExplicitEmergencyPlatformSessionRevocationError(compatibilityFailure)).toBe(false)

    const revoked = await registerEmergencyPlatformSession(4, 'verified-access-token').catch((error: unknown) => error)
    expect(isExplicitEmergencyPlatformSessionRevocationError(revoked)).toBe(true)
  })
})

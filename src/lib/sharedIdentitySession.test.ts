import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSharedIdentitySession,
  clearSharedIdentityServerSession,
  getSharedIdentitySessionExpiresAt,
  getSharedIdentitySessionScope,
  getSharedIdentitySessionToken,
  hydrateSharedIdentitySession,
  setSharedIdentitySession,
  sharedIdentityRecoveryDelayMs,
  sharedIdentityRefreshDelayMs,
  sharedIdentitySessionRestoreRetryAfterMs,
} from './sharedIdentitySession'

const sharedToken = 'shared-token'.repeat(5)

afterEach(async () => {
  vi.useRealTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  await clearSharedIdentityServerSession().catch(() => undefined)
  clearSharedIdentitySession()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared identity browser session', () => {
  it('keeps the shared bearer in module memory and never Web Storage', () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)

    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
    expect(getSharedIdentitySessionScope()).toBe('sygsphere')
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('clears local shared credentials immediately and bounds remote logout', async () => {
    vi.useFakeTimers()
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const logout = clearSharedIdentityServerSession('access-token')

    expect(getSharedIdentitySessionToken()).toBeNull()
    expect(getSharedIdentitySessionScope()).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/shared-identity/session/logout',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const rejectedLogout = expect(logout).rejects.toThrow('could not be cleared')
    await vi.advanceTimersByTimeAsync(3_000)
    await rejectedLogout
  })

  it('keeps the logout barrier in memory when browser storage is unavailable', async () => {
    vi.useFakeTimers()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage unavailable', 'SecurityError') })
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const logout = clearSharedIdentityServerSession('access-token')
    const rejectedLogout = expect(logout).rejects.toThrow('could not be cleared')
    await vi.advanceTimersByTimeAsync(3_000)
    await rejectedLogout

    const replacementToken = 'replacement-shared-token'.repeat(4)
    expect(setSharedIdentitySession(replacementToken, new Date(Date.now() + 120_000).toISOString(), false, 'platform')).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await clearSharedIdentityServerSession()
    expect(setSharedIdentitySession(replacementToken, new Date(Date.now() + 120_000).toISOString(), false, 'platform')).toBe(true)
  })

  it('keeps shared-session restoration blocked after an HTTP logout failure and retries cleanup first', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: 'upstream_unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(clearSharedIdentityServerSession()).rejects.toMatchObject({ status: 503, transient: true })
    expect(setSharedIdentitySession('replacement-shared-token'.repeat(4), new Date(Date.now() + 60_000).toISOString(), false)).toBe(false)

    await expect(hydrateSharedIdentitySession()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      '/api/v1/auth/shared-identity/session/logout',
      expect.objectContaining({ credentials: 'same-origin', method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      '/api/v1/auth/shared-identity/session',
      expect.objectContaining({ credentials: 'same-origin', method: 'POST' }),
    )
  })

  it('serializes a replacement session behind an older remote logout', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    let finishLogout: ((response: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finishLogout = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const logout = clearSharedIdentityServerSession('old-access-token')
    const replacementToken = 'replacement-shared-token'.repeat(4)
    expect(setSharedIdentitySession(replacementToken, new Date(Date.now() + 120_000).toISOString(), false, 'platform')).toBe(false)
    expect(getSharedIdentitySessionToken()).toBeNull()

    finishLogout?.(new Response(null, { status: 204 }))
    await expect(logout).resolves.toBeUndefined()
    expect(setSharedIdentitySession(replacementToken, new Date(Date.now() + 120_000).toISOString(), false, 'platform')).toBe(true)
    expect(getSharedIdentitySessionToken()).toBe(replacementToken)
    expect(getSharedIdentitySessionScope()).toBe('platform')
  })

  it('purges bearer material left by the released storage implementation', () => {
    window.localStorage.setItem('sygshift:shared-identity-session-token:v1', sharedToken)
    window.sessionStorage.setItem('sygshift:shared-identity-session-expiry:v1', new Date(Date.now() + 60_000).toISOString())

    clearSharedIdentitySession()

    expect(window.localStorage.getItem('sygshift:shared-identity-session-token:v1')).toBeNull()
    expect(window.sessionStorage.getItem('sygshift:shared-identity-session-expiry:v1')).toBeNull()
  })

  it('expires invalid memory state and treats a missing HttpOnly cookie as normal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T12:00:00.000Z'))
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 1_000).toISOString(), false)
    vi.advanceTimersByTime(1_001)
    expect(getSharedIdentitySessionToken()).toBeNull()
    expect(getSharedIdentitySessionScope()).toBe('sygsphere')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(hydrateSharedIdentitySession()).resolves.toBeNull()
    expect(getSharedIdentitySessionToken()).toBeNull()
    expect(getSharedIdentitySessionScope()).toBeNull()
  })

  it('refreshes through the server before the browser access token expires', () => {
    const now = Date.now()
    const payload = btoa(JSON.stringify({ exp: Math.floor((now + 10 * 60_000) / 1000) }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    expect(sharedIdentityRefreshDelayMs(`header.${payload}.signature`, now)).toBeGreaterThanOrEqual(509_000)
    expect(sharedIdentityRefreshDelayMs(`header.${payload}.signature`, now)).toBeLessThanOrEqual(510_000)
  })

  it('hydrates a verified cookie-backed session into memory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      persistent: false,
      sharedIdentityToken: sharedToken,
      supabaseSession: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      },
    })))

    await expect(hydrateSharedIdentitySession()).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scope: 'sygsphere',
    })
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
    expect(getSharedIdentitySessionScope()).toBe('sygsphere')
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith('/api/v1/auth/shared-identity/session', expect.objectContaining({
      credentials: 'same-origin',
    }))
  })

  it('passes the secure-access abort signal to the Worker restore request', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))

    await hydrateSharedIdentitySession(controller.signal)

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      '/api/v1/auth/shared-identity/session',
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('makes one restore request per recovery cycle and honors Retry-After', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: 'shared_identity_upstream_unavailable' },
        { headers: { 'retry-after': '7' }, status: 503 },
      ))
      .mockResolvedValueOnce(Response.json({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        persistent: true,
        sharedIdentityToken: sharedToken,
        supabaseSession: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        },
      }))
    vi.stubGlobal('fetch', fetchMock)

    let firstError: unknown
    try {
      await hydrateSharedIdentitySession()
    } catch (error) {
      firstError = error
    }
    expect(firstError).toMatchObject({ status: 503, transient: true })
    expect(sharedIdentitySessionRestoreRetryAfterMs(firstError)).toBe(7_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(hydrateSharedIdentitySession()).resolves.toMatchObject({
      accessToken: 'access-token',
      scope: 'sygsphere',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
  })

  it('preserves the local shared session after a transient restore failure', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    const fetchMock = vi.fn(async () => Response.json(
      { error: 'shared_identity_upstream_unavailable' },
      { status: 503 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hydrateSharedIdentitySession()).rejects.toMatchObject({
      status: 503,
      transient: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
    expect(getSharedIdentitySessionScope()).toBe('sygsphere')
  })

  it('preserves a valid shared session when a 200 response contains malformed session values', async () => {
    const originalToken = 'original-shared-token'.repeat(4)
    const originalExpiry = new Date(Date.now() + 120_000).toISOString()
    setSharedIdentitySession(originalToken, originalExpiry, true, 'platform')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      destination: '/sygsphere',
      expiresAt: 'not-a-date',
      persistent: false,
      scope: 'sygsphere',
      sharedIdentityToken: 'too-short',
      supabaseSession: {
        accessToken: 'candidate-access-token',
        refreshToken: 'candidate-refresh-token',
      },
    })))

    await expect(hydrateSharedIdentitySession()).rejects.toThrow('response was invalid')
    expect(getSharedIdentitySessionToken()).toBe(originalToken)
    expect(getSharedIdentitySessionExpiresAt()).toBe(originalExpiry)
    expect(getSharedIdentitySessionScope()).toBe('platform')
  })

  it('preserves a valid shared session when a 200 response contains an expired candidate', async () => {
    const originalToken = 'original-shared-token'.repeat(4)
    const originalExpiry = new Date(Date.now() + 120_000).toISOString()
    setSharedIdentitySession(originalToken, originalExpiry, true, 'platform')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      destination: '/sygsphere',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      persistent: false,
      scope: 'sygsphere',
      sharedIdentityToken: 'candidate-shared-token'.repeat(4),
      supabaseSession: {
        accessToken: 'candidate-access-token',
        refreshToken: 'candidate-refresh-token',
      },
    })))

    await expect(hydrateSharedIdentitySession()).rejects.toThrow('response was invalid')
    expect(getSharedIdentitySessionToken()).toBe(originalToken)
    expect(getSharedIdentitySessionExpiresAt()).toBe(originalExpiry)
    expect(getSharedIdentitySessionScope()).toBe('platform')
  })

  it('preserves but does not retry a non-transient endpoint contract error', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    const fetchMock = vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hydrateSharedIdentitySession()).rejects.toMatchObject({
      status: 404,
      transient: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
  })

  it('preserves a network failure for the next recovery cycle without an inline retry', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), false)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('The operation timed out.', 'AbortError'))
      .mockResolvedValueOnce(Response.json({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        persistent: false,
        sharedIdentityToken: sharedToken,
        supabaseSession: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hydrateSharedIdentitySession()).rejects.toMatchObject({ transient: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)

    await expect(hydrateSharedIdentitySession()).resolves.toMatchObject({
      accessToken: 'access-token',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
  })

  it.each([401, 403])('clears the local session when the Worker confirms status %s', async (status) => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_session' }, { status })))

    await expect(hydrateSharedIdentitySession()).resolves.toBeNull()
    expect(getSharedIdentitySessionToken()).toBeNull()
    expect(getSharedIdentitySessionScope()).toBeNull()
  })

  it('uses exponential jittered recovery delays with a cap and honors Retry-After', () => {
    expect(sharedIdentityRecoveryDelayMs(0, null, 0)).toBe(2_000)
    expect(sharedIdentityRecoveryDelayMs(1, null, 1)).toBe(5_000)
    expect(sharedIdentityRecoveryDelayMs(2, 12_000, 0)).toBe(12_000)
    expect(sharedIdentityRecoveryDelayMs(20, null, 1)).toBe(60_000)
    expect(sharedIdentityRecoveryDelayMs(20, 90_000, 1)).toBe(90_000)
  })

  it('does not schedule recovery for a deterministic Worker 502', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'shared_identity_upstream_rejected' },
      { status: 502 },
    )))

    await expect(hydrateSharedIdentitySession()).rejects.toMatchObject({
      status: 502,
      transient: false,
    })
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
  })

  it('preserves and retries a generic gateway 502 without a deterministic Worker code', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Bad gateway</body></html>',
      { headers: { 'content-type': 'text/html' }, status: 502 },
    )))

    await expect(hydrateSharedIdentitySession()).rejects.toMatchObject({
      status: 502,
      transient: true,
    })
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
  })

  it('does not schedule recovery for deterministic Worker configuration failures', async () => {
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'shared_identity_not_configured' },
      { status: 503 },
    )))

    await expect(hydrateSharedIdentitySession()).rejects.toMatchObject({
      status: 503,
      transient: false,
    })
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
  })

  it('hydrates an exact platform destination and preserves it when a later response has a mismatched scope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      destination: '/',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      persistent: true,
      scope: 'platform',
      sharedIdentityToken: sharedToken,
      supabaseSession: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      },
    })))

    await expect(hydrateSharedIdentitySession()).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scope: 'platform',
    })
    expect(getSharedIdentitySessionScope()).toBe('platform')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      destination: '/sygsphere',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      persistent: false,
      scope: 'platform',
      sharedIdentityToken: sharedToken,
      supabaseSession: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      },
    })))

    await expect(hydrateSharedIdentitySession()).rejects.toThrow('response was invalid')
    expect(getSharedIdentitySessionScope()).toBe('platform')
  })
})

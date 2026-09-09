import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSharedIdentitySession,
  getSharedIdentitySessionScope,
  getSharedIdentitySessionToken,
  hydrateSharedIdentitySession,
  setSharedIdentitySession,
  sharedIdentityRefreshDelayMs,
} from './sharedIdentitySession'

const sharedToken = 'shared-token'.repeat(5)

afterEach(() => {
  clearSharedIdentitySession()
  vi.useRealTimers()
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

  it('hydrates an exact platform destination and rejects a mismatched scope', async () => {
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
    expect(getSharedIdentitySessionScope()).toBeNull()
  })
})

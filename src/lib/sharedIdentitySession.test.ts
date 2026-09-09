import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearSharedIdentitySession,
  getSharedIdentitySessionToken,
  hydrateSharedIdentitySession,
  setSharedIdentitySession,
} from './sharedIdentitySession'

const sharedToken = 'shared-token'.repeat(5)

afterEach(() => {
  clearSharedIdentitySession()
  vi.unstubAllGlobals()
})

describe('shared identity browser session', () => {
  it('keeps the shared bearer in module memory and never Web Storage', () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    setSharedIdentitySession(sharedToken, new Date(Date.now() + 60_000).toISOString(), true)

    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
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
    setSharedIdentitySession(sharedToken, new Date(Date.now() - 1_000).toISOString(), false)
    expect(getSharedIdentitySessionToken()).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(hydrateSharedIdentitySession()).resolves.toBeNull()
    expect(getSharedIdentitySessionToken()).toBeNull()
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
    })
    expect(getSharedIdentitySessionToken()).toBe(sharedToken)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith('/api/v1/auth/shared-identity/session', expect.objectContaining({
      credentials: 'same-origin',
    }))
  })
})

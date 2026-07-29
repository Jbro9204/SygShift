import { describe, expect, it, vi } from 'vitest'
import {
  AUTH_EMAIL_DOMAIN,
  isValidUsername,
  normalizeUsername,
  signOut,
  usernameToAuthEmail,
  validatePassword,
} from './auth'
import {
  clearTrustedDeviceToken,
  getTrustedDeviceToken,
  setTrustedDeviceToken,
} from '../lib/trustedDeviceToken'

const supabaseMock = vi.hoisted(() => ({
  client: {
    auth: {
      signOut: vi.fn(),
    },
  },
}))

vi.mock('../lib/supabase', () => ({
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

    expect(localStorage.getItem('sygshift:trusted-device-token:v1')).toBe('remembered-device-token')
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSecurityKeySession,
  getSecurityKeySessionToken,
  setSecurityKeySession,
} from './securityKeySession'

describe('security-key browser session', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T16:00:00.000Z'))
  })

  afterEach(() => {
    window.sessionStorage.clear()
    vi.useRealTimers()
  })

  it('keeps a valid security-key session in session storage only', () => {
    setSecurityKeySession('session-token', '2026-08-30T04:00:00.000Z')

    expect(getSecurityKeySessionToken()).toBe('session-token')
    expect(window.localStorage.getItem('sygshift:security-key-session-token:v1')).toBeNull()
  })

  it('fails closed and removes an expired session', () => {
    setSecurityKeySession('session-token', '2026-08-29T16:05:00.000Z')
    vi.setSystemTime(new Date('2026-08-29T16:05:01.000Z'))

    expect(getSecurityKeySessionToken()).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('clears the session explicitly during sign-out', () => {
    setSecurityKeySession('session-token', '2026-08-30T04:00:00.000Z')
    clearSecurityKeySession()

    expect(getSecurityKeySessionToken()).toBeNull()
  })
})

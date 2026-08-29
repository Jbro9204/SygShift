import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendProtectedSessionHeaders } from './protectedSessionHeaders'
import { clearSecurityKeySession, setSecurityKeySession } from './securityKeySession'
import { clearTrustedDeviceToken, setTrustedDeviceToken } from './trustedDeviceToken'

describe('protected-session request headers', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    document.cookie = 'sygshift_trusted_device=; Max-Age=0; Path=/'
  })

  afterEach(() => {
    clearSecurityKeySession()
    clearTrustedDeviceToken()
  })

  it('preserves existing headers and attaches both independent assurance methods', () => {
    setTrustedDeviceToken('trusted-token')
    setSecurityKeySession('key-token', new Date(Date.now() + 60_000).toISOString())

    const headers = appendProtectedSessionHeaders({ authorization: 'Bearer access-token' })

    expect(headers.get('authorization')).toBe('Bearer access-token')
    expect(headers.get('x-sygshift-trusted-device')).toBe('trusted-token')
    expect(headers.get('x-sygshift-security-key')).toBe('key-token')
  })

  it('does not invent assurance headers when no verified session exists', () => {
    const headers = appendProtectedSessionHeaders()

    expect(headers.has('x-sygshift-trusted-device')).toBe(false)
    expect(headers.has('x-sygshift-security-key')).toBe(false)
  })
})

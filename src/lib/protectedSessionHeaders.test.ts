import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendProtectedSessionHeaders } from './protectedSessionHeaders'
import { clearSecurityKeySession, setSecurityKeySession } from './securityKeySession'
import { clearSharedIdentitySession, setSharedIdentitySession } from './sharedIdentitySession'
import { clearTrustedDeviceToken, setTrustedDeviceToken } from './trustedDeviceToken'

describe('protected-session request headers', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    document.cookie = 'sygshift_trusted_device=; Max-Age=0; Path=/'
  })

  afterEach(() => {
    clearSecurityKeySession()
    clearSharedIdentitySession()
    clearTrustedDeviceToken()
  })

  it('preserves existing headers and attaches each independent assurance method', () => {
    setTrustedDeviceToken('trusted-token')
    setSecurityKeySession('key-token', new Date(Date.now() + 60_000).toISOString())
    setSharedIdentitySession('shared-token'.repeat(5), new Date(Date.now() + 60_000).toISOString(), false)

    const headers = appendProtectedSessionHeaders({ authorization: 'Bearer access-token' })

    expect(headers.get('authorization')).toBe('Bearer access-token')
    expect(headers.get('x-sygshift-trusted-device')).toBe('trusted-token')
    expect(headers.get('x-sygshift-security-key')).toBe('key-token')
    expect(headers.get('x-sygshift-shared-identity')).toBe('shared-token'.repeat(5))
  })

  it('does not invent assurance headers when no verified session exists', () => {
    const headers = appendProtectedSessionHeaders()

    expect(headers.has('x-sygshift-trusted-device')).toBe(false)
    expect(headers.has('x-sygshift-security-key')).toBe(false)
    expect(headers.has('x-sygshift-shared-identity')).toBe(false)
  })
})

import { getSecurityKeySessionToken } from './securityKeySession'
import { getTrustedDeviceToken } from './trustedDeviceToken'

export function appendProtectedSessionHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source)
  const trustedDeviceToken = getTrustedDeviceToken()
  const securityKeyToken = getSecurityKeySessionToken()

  if (trustedDeviceToken) headers.set('x-sygshift-trusted-device', trustedDeviceToken)
  if (securityKeyToken) headers.set('x-sygshift-security-key', securityKeyToken)

  return headers
}


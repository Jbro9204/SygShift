import { getSecurityKeySessionToken } from './securityKeySession'
import { getSharedIdentitySessionScope, getSharedIdentitySessionToken } from './sharedIdentitySession'
import { getTrustedDeviceToken } from './trustedDeviceToken'

export function appendProtectedSessionHeaders(
  source?: HeadersInit,
  options: { includeSharedIdentity?: boolean } = {},
): Headers {
  const headers = new Headers(source)
  const trustedDeviceToken = getTrustedDeviceToken()
  const securityKeyToken = getSecurityKeySessionToken()
  const sharedIdentityScope = getSharedIdentitySessionScope()
  const includeSharedIdentity = sharedIdentityScope === 'platform'
    || (sharedIdentityScope === 'sygsphere' && options.includeSharedIdentity === true)
  const sharedIdentityToken = includeSharedIdentity ? getSharedIdentitySessionToken() : null

  if (trustedDeviceToken) headers.set('x-sygshift-trusted-device', trustedDeviceToken)
  if (securityKeyToken) headers.set('x-sygshift-security-key', securityKeyToken)
  if (sharedIdentityToken) headers.set('x-sygshift-shared-identity', sharedIdentityToken)

  return headers
}

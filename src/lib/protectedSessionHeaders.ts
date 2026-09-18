import { getSecurityKeySessionToken } from './securityKeySession'
import { getSharedIdentitySessionScope, getSharedIdentitySessionToken } from './sharedIdentitySession'
import { getTrustedDeviceTokens } from './trustedDeviceToken'

export function appendProtectedSessionHeaders(
  source?: HeadersInit,
  options: { includeSharedIdentity?: boolean } = {},
): Headers {
  const headers = new Headers(source)
  const trustedDeviceTokens = getTrustedDeviceTokens()
  const securityKeyToken = getSecurityKeySessionToken()
  const sharedIdentityScope = getSharedIdentitySessionScope()
  const includeSharedIdentity = sharedIdentityScope === 'platform'
    || (sharedIdentityScope === 'sygsphere' && options.includeSharedIdentity === true)
  const sharedIdentityToken = includeSharedIdentity ? getSharedIdentitySessionToken() : null

  if (trustedDeviceTokens[0]) headers.set('x-sygshift-trusted-device', trustedDeviceTokens[0])
  if (trustedDeviceTokens[1]) headers.set('x-sygshift-trusted-device-fallback', trustedDeviceTokens[1])
  if (securityKeyToken) headers.set('x-sygshift-security-key', securityKeyToken)
  if (sharedIdentityToken) headers.set('x-sygshift-shared-identity', sharedIdentityToken)

  return headers
}

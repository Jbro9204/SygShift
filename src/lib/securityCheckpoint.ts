import type { SessionContext } from '../data/auth'
import type { SharedIdentityScope } from './sharedIdentitySession'

export function isSygSpherePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === '/sygsphere'
}

export function requiresSecurityCheckpoint(
  sessionContext: SessionContext | null,
  pathname: string,
  sharedIdentityScope: SharedIdentityScope | null,
): boolean {
  if (!sessionContext) return false
  if (!sharedIdentityScopeAllowsPath(pathname, sharedIdentityScope)) return true
  if (sessionContext.mustChangePassword) return true
  if (!sessionContext.mfaRequired || sessionContext.hasMfa) return false
  return !sharedIdentityAssuranceApplies(pathname, sharedIdentityScope)
}

export function sharedIdentityScopeAllowsPath(
  pathname: string,
  scope: SharedIdentityScope | null,
): boolean {
  return scope !== 'sygsphere' || isSygSpherePath(pathname)
}

export function sharedIdentityAssuranceApplies(
  pathname: string,
  scope: SharedIdentityScope | null,
): boolean {
  if (scope === 'platform') return true
  return scope === 'sygsphere' && isSygSpherePath(pathname)
}

export function completedSignInRecordKind(
  sessionContext: SessionContext | null,
  pathname: string,
  sharedIdentityScope: SharedIdentityScope | null,
): 'native' | 'platform' | 'sygsphere' | null {
  if (!sessionContext || requiresSecurityCheckpoint(sessionContext, pathname, sharedIdentityScope)) return null
  return sharedIdentityAssuranceApplies(pathname, sharedIdentityScope) ? sharedIdentityScope : 'native'
}

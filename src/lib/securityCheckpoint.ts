import type { SessionContext } from '../data/auth'

export function isSygSpherePath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === '/sygsphere'
}

export function requiresSecurityCheckpoint(
  sessionContext: SessionContext | null,
  pathname: string,
  hasSharedIdentitySession: boolean,
): boolean {
  if (!sessionContext) return false
  if (sessionContext.mustChangePassword) return true
  if (!sessionContext.mfaRequired || sessionContext.hasMfa) return false
  return !(isSygSpherePath(pathname) && hasSharedIdentitySession)
}

export function completedSignInRecordKind(
  sessionContext: SessionContext | null,
  pathname: string,
  hasSharedIdentitySession: boolean,
): 'native' | 'sygsphere' | null {
  if (!sessionContext || requiresSecurityCheckpoint(sessionContext, pathname, hasSharedIdentitySession)) return null
  return isSygSpherePath(pathname) && hasSharedIdentitySession ? 'sygsphere' : 'native'
}

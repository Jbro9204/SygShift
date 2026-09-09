import type { SessionContext } from '../data/auth'

export function requiresSecurityCheckpoint(
  sessionContext: SessionContext | null,
  pathname: string,
  hasSharedIdentitySession: boolean,
): boolean {
  if (!sessionContext) return false
  if (sessionContext.mustChangePassword) return true
  if (!sessionContext.mfaRequired || sessionContext.hasMfa) return false
  return !(pathname === '/sygsphere' && hasSharedIdentitySession)
}

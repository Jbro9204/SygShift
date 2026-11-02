import { useEffect, useState } from 'react'
import {
  cancelIdentityVerification,
  completeIdentityVerification,
  monitorIdentityVerificationSession,
  pendingIdentityVerificationActor,
  subscribeToIdentityVerification,
  type IdentityVerificationContext,
} from '../lib/identityVerificationCoordinator'
import { IdentityVerificationModal } from './IdentityVerificationModal'

export function IdentityVerificationHost() {
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [verificationContext, setVerificationContext] = useState<IdentityVerificationContext>('general')
  const [requestId, setRequestId] = useState<string | null>(null)

  useEffect(monitorIdentityVerificationSession, [])
  useEffect(() => subscribeToIdentityVerification((required, context, id) => {
    setRequestId(id)
    setVerificationContext(context)
    setVerificationRequired(required)
  }), [])

  const actor = requestId ? pendingIdentityVerificationActor(requestId) : undefined
  return verificationRequired && requestId && actor ? (
    <IdentityVerificationModal
      key={requestId}
      actor={actor}
      context={verificationContext}
      onCancel={() => cancelIdentityVerification(requestId)}
      onVerified={(method) => completeIdentityVerification(method, requestId)}
    />
  ) : null
}

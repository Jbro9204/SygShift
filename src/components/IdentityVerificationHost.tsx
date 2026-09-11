import { useEffect, useState } from 'react'
import {
  cancelIdentityVerification,
  completeIdentityVerification,
  subscribeToIdentityVerification,
  type IdentityVerificationContext,
} from '../lib/identityVerificationCoordinator'
import { IdentityVerificationModal } from './IdentityVerificationModal'

export function IdentityVerificationHost() {
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [verificationContext, setVerificationContext] = useState<IdentityVerificationContext>('general')

  useEffect(() => subscribeToIdentityVerification((required, context) => {
    setVerificationContext(context)
    setVerificationRequired(required)
  }), [])

  return verificationRequired ? (
    <IdentityVerificationModal
      context={verificationContext}
      onCancel={cancelIdentityVerification}
      onVerified={(method) => completeIdentityVerification(method)}
    />
  ) : null
}

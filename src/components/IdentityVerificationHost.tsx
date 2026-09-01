import { useEffect, useState } from 'react'
import {
  cancelIdentityVerification,
  completeIdentityVerification,
  subscribeToIdentityVerification,
} from '../lib/identityVerificationCoordinator'
import { IdentityVerificationModal } from './IdentityVerificationModal'

export function IdentityVerificationHost() {
  const [verificationRequired, setVerificationRequired] = useState(false)

  useEffect(() => subscribeToIdentityVerification(setVerificationRequired), [])

  return verificationRequired ? (
    <IdentityVerificationModal
      onCancel={cancelIdentityVerification}
      onVerified={(method) => completeIdentityVerification(method)}
    />
  ) : null
}

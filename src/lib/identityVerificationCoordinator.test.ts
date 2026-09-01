import { describe, expect, it, vi } from 'vitest'
import {
  cancelIdentityVerification,
  completeIdentityVerification,
  fetchWithIdentityVerification,
  responseRequiresIdentityVerification,
  subscribeToIdentityVerification,
} from './identityVerificationCoordinator'

function jsonResponse(status: number, error?: string): Response {
  return Response.json(error ? { error } : { status: 'ok' }, { status })
}

describe('identity verification coordinator', () => {
  it('recognizes protected MFA responses without treating ordinary permission denials as verification prompts', async () => {
    await expect(responseRequiresIdentityVerification(jsonResponse(403, 'hr_compensation_mfa_required'))).resolves.toBe(true)
    await expect(responseRequiresIdentityVerification(jsonResponse(403, 'recent_document_mfa_required'))).resolves.toBe(true)
    await expect(responseRequiresIdentityVerification(jsonResponse(403, 'permission_required'))).resolves.toBe(false)
    await expect(responseRequiresIdentityVerification(jsonResponse(401, 'auth_required'))).resolves.toBe(false)
  })

  it('opens one verification checkpoint and retries the blocked request after success', async () => {
    const makeRequest = vi.fn()
      .mockResolvedValueOnce(jsonResponse(403, 'hr_compensation_mfa_required'))
      .mockResolvedValueOnce(jsonResponse(200))
    let verificationRequested!: () => void
    const requested = new Promise<void>((resolve) => { verificationRequested = resolve })
    const unsubscribe = subscribeToIdentityVerification((required) => { if (required) verificationRequested() })

    const responsePromise = fetchWithIdentityVerification(makeRequest)
    await requested
    completeIdentityVerification('security_key')

    await expect(responsePromise).resolves.toMatchObject({ ok: true, status: 200 })
    expect(makeRequest).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('returns the original protected response when the employee cancels verification', async () => {
    const makeRequest = vi.fn().mockResolvedValue(jsonResponse(403, 'operations_mfa_required'))
    let verificationRequested!: () => void
    const requested = new Promise<void>((resolve) => { verificationRequested = resolve })
    const unsubscribe = subscribeToIdentityVerification((required) => { if (required) verificationRequested() })

    const responsePromise = fetchWithIdentityVerification(makeRequest)
    await requested
    cancelIdentityVerification()

    await expect(responsePromise).resolves.toMatchObject({ ok: false, status: 403 })
    expect(makeRequest).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

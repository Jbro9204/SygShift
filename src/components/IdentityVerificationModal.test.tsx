import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as mfaData from '../data/mfa'
import * as securityKeyData from '../data/securityKeys'
import { IdentityVerificationModal } from './IdentityVerificationModal'

vi.mock('../data/mfa', () => ({
  createMfaChallenge: vi.fn(),
  listMfaFactors: vi.fn(),
  verifyMfaChallenge: vi.fn(),
}))

vi.mock('../data/securityKeys', () => ({
  authenticateWithSecurityKey: vi.fn(),
  getSecurityKeyDirectory: vi.fn(),
}))

describe('IdentityVerificationModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
    vi.mocked(mfaData.listMfaFactors).mockResolvedValue([{
      factorType: 'totp',
      friendlyName: 'SygShift Authenticator',
      id: 'factor-1',
      phone: null,
      status: 'verified',
    }])
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockResolvedValue({
      featureEnabled: true,
      keys: [],
      pilotEligible: false,
      requestId: 'request-1',
    })
    vi.mocked(mfaData.createMfaChallenge).mockResolvedValue('challenge-1')
    vi.mocked(mfaData.verifyMfaChallenge).mockResolvedValue()
    vi.mocked(securityKeyData.authenticateWithSecurityKey).mockResolvedValue()
  })

  it('forces authenticator verification and completes the protected action', async () => {
    const verified = vi.fn()
    render(<IdentityVerificationModal onCancel={vi.fn()} onVerified={verified} />)

    const code = await screen.findByLabelText('Six-digit code')
    fireEvent.change(code, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator' }))

    await waitFor(() => expect(mfaData.verifyMfaChallenge).toHaveBeenCalledWith('factor-1', 'challenge-1', '123456', 'totp'))
    expect(verified).toHaveBeenCalledWith('authenticator')
  })

  it('offers a registered FIDO key as the primary verification method', async () => {
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockResolvedValue({
      featureEnabled: true,
      pilotEligible: true,
      requestId: 'request-2',
      keys: [{
        backedUp: false,
        createdAt: '2026-08-29T12:00:00.000Z',
        credentialId: 'credential-1',
        deviceType: 'singleDevice',
        id: '10000000-0000-4000-8000-000000000001',
        label: 'Jordan office key',
        lastUsedAt: null,
      }],
    })
    const verified = vi.fn()
    render(<IdentityVerificationModal onCancel={vi.fn()} onVerified={verified} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Verify with security key' }))

    await waitFor(() => expect(securityKeyData.authenticateWithSecurityKey).toHaveBeenCalledTimes(1))
    expect(verified).toHaveBeenCalledWith('security_key')
    expect(screen.getByRole('button', { name: 'Verify authenticator' })).toBeInTheDocument()
  })
})

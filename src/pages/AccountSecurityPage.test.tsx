import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as mfaData from '../data/mfa'
import * as securityKeyData from '../data/securityKeys'
import { AccountSecurityPage } from './AccountSecurityPage'

const authMock = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
  notifySessionContextChanged: vi.fn(),
}))

const supabaseMock = vi.hoisted(() => ({
  client: {
    auth: {
      refreshSession: vi.fn(),
      signOut: vi.fn(),
      updateUser: vi.fn(),
    },
    rpc: vi.fn(),
  },
}))

vi.mock('../data/auth', async () => {
  const actual = await vi.importActual<typeof import('../data/auth')>('../data/auth')
  return {
    ...actual,
    getSessionContext: authMock.getSessionContext,
    notifySessionContextChanged: authMock.notifySessionContextChanged,
  }
})

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => supabaseMock.client,
  isSupabaseConfigured: true,
}))

vi.mock('../data/mfa', () => ({
  createMfaChallenge: vi.fn(),
  getAuthenticatorLevel: vi.fn(),
  listMfaFactors: vi.fn(),
  listTotpFactors: vi.fn(),
  startPhoneEnrollment: vi.fn(),
  startTotpEnrollment: vi.fn(),
  verifyMfaChallenge: vi.fn(),
  verifyTotpEnrollment: vi.fn(),
}))

vi.mock('../data/securityKeys', () => ({
  authenticateWithSecurityKey: vi.fn(),
  getSecurityKeyDirectory: vi.fn(),
}))

function sessionContext(overrides: Partial<Awaited<ReturnType<typeof authMock.getSessionContext>>> = {}) {
  return {
    employeeId: '10000000-0000-4000-8000-000000000001',
    username: 'testadmin',
    displayName: 'Test Admin',
    role: 'admin',
    mustChangePassword: true,
    passwordChangedAt: null,
    mfaEnrolledAt: '2026-07-05T21:00:00.000Z',
    mfaRequired: false,
    hasMfa: true,
    ...overrides,
  }
}

describe('AccountSecurityPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.getSessionContext
      .mockResolvedValueOnce(sessionContext())
      .mockResolvedValueOnce(sessionContext({
        mustChangePassword: false,
        passwordChangedAt: '2026-07-05T21:05:00.000Z',
      }))
    supabaseMock.client.auth.refreshSession.mockResolvedValue({ data: {}, error: null })
    supabaseMock.client.auth.signOut.mockResolvedValue({ error: null })
    supabaseMock.client.auth.updateUser.mockResolvedValue({ data: {}, error: null })
    supabaseMock.client.rpc.mockResolvedValue({ data: true, error: null })
    vi.mocked(mfaData.listMfaFactors).mockResolvedValue([])
    vi.mocked(mfaData.getAuthenticatorLevel).mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' })
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockResolvedValue({
      featureEnabled: true,
      keys: [],
      pilotEligible: true,
      requestId: 'request-1',
    })
  })

  it('submits the actual password field values even when browser autofill bypasses React change state', async () => {
    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    const newPassword = await screen.findByLabelText('New password')
    const confirmPassword = screen.getByLabelText('Confirm password')
    const saveButton = screen.getByRole('button', { name: 'Save password' })

    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    inputValueSetter?.call(newPassword, 'StrongAdmin123!')
    inputValueSetter?.call(confirmPassword, 'StrongAdmin123!')

    fireEvent.submit(saveButton.closest('form')!)

    await waitFor(() => {
      expect(supabaseMock.client.auth.updateUser).toHaveBeenCalledWith({ password: 'StrongAdmin123!' })
    })
    expect(screen.queryByText('The password confirmation does not match.')).not.toBeInTheDocument()
  })

  it('uses the recovery checkpoint without changing onboarding password state', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({
      mustChangePassword: false,
      passwordChangedAt: '2026-07-05T21:05:00.000Z',
    }))

    render(
      <MemoryRouter initialEntries={['/account-security?mode=password-recovery']}>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'Reset your SygShift password.' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'StrongAdmin123!' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'StrongAdmin123!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }))

    await waitFor(() => {
      expect(supabaseMock.client.auth.updateUser).toHaveBeenCalledWith({ password: 'StrongAdmin123!' })
    })
    expect(supabaseMock.client.rpc).not.toHaveBeenCalledWith('mark_password_changed')
    expect(mfaData.listMfaFactors).toHaveBeenCalled()
  })

  it('allows permanent password fields to be shown and hidden independently', async () => {
    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    const newPassword = await screen.findByLabelText('New password')
    const confirmPassword = screen.getByLabelText('Confirm password')

    expect(newPassword).toHaveAttribute('type', 'password')
    expect(confirmPassword).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show new password' }))
    expect(newPassword).toHaveAttribute('type', 'text')
    expect(confirmPassword).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show confirmation password' }))
    expect(newPassword).toHaveAttribute('type', 'text')
    expect(confirmPassword).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Hide new password' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide confirmation password' }))
    expect(newPassword).toHaveAttribute('type', 'password')
    expect(confirmPassword).toHaveAttribute('type', 'password')
  })

  it('does not show SMS MFA when the feature is turned off', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({
      hasMfa: false,
      mfaRequired: true,
    }))

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    await screen.findByText('Authenticator app')
    expect(screen.queryByText('Text message')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Start authenticator setup/i })).toBeInTheDocument()
  })

  it('lets Recruiting and Licensing remember an MFA-verified browser', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({
      hasMfa: false,
      mfaRequired: true,
      role: 'recruiting_licensing',
    }))
    vi.mocked(mfaData.listMfaFactors).mockResolvedValue([{
      factorType: 'totp',
      friendlyName: 'SygShift',
      id: 'factor-1',
      phone: null,
      status: 'verified',
    }])

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByLabelText('Remember this device for 14 days')).toBeInTheDocument()
  })

  it('offers and verifies a registered FIDO2 security key without removing authenticator fallback', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext
      .mockResolvedValueOnce(sessionContext({ hasMfa: false, mfaRequired: true }))
      .mockResolvedValue(sessionContext({ hasMfa: true, mfaRequired: true }))
    vi.mocked(mfaData.getAuthenticatorLevel)
      .mockResolvedValueOnce({ currentLevel: 'aal1', nextLevel: 'aal2' })
      .mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' })
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockResolvedValue({
      featureEnabled: true,
      pilotEligible: true,
      requestId: 'request-1',
      keys: [{
        id: 'key-1',
        credentialId: 'credential-key-1',
        label: 'Jordan office key',
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: '2026-08-29T12:00:00.000Z',
        lastUsedAt: null,
      }],
    })
    vi.mocked(securityKeyData.authenticateWithSecurityKey).mockResolvedValue()

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Use security key' })).toBeInTheDocument()
    expect(screen.getByText('Authenticator app')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use security key' }))

    await waitFor(() => expect(securityKeyData.authenticateWithSecurityKey).toHaveBeenCalledTimes(1))
    expect(supabaseMock.client.rpc).not.toHaveBeenCalledWith('mark_mfa_enrolled')
  })

  it('keeps authenticator fallback available when security-key discovery fails', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({ hasMfa: false, mfaRequired: true }))
    vi.mocked(mfaData.listMfaFactors).mockResolvedValue([{
      factorType: 'totp',
      friendlyName: 'SygShift',
      id: 'factor-1',
      phone: null,
      status: 'verified',
    }])
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockRejectedValue(new Error('temporary lookup failure'))

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Retry key check' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify authenticator' })).toBeInTheDocument()
    expect(supabaseMock.client.auth.signOut).not.toHaveBeenCalled()
  })

  it('requires a fresh authenticator instead of a security key before key-management changes', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({ hasMfa: true, mfaRequired: true }))
    vi.mocked(mfaData.getAuthenticatorLevel).mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' })
    vi.mocked(mfaData.listMfaFactors).mockResolvedValue([{
      factorType: 'totp',
      friendlyName: 'SygShift',
      id: 'factor-1',
      phone: null,
      status: 'verified',
    }])
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockResolvedValue({
      featureEnabled: true,
      keys: [{
        backedUp: false,
        createdAt: '2026-08-29T12:00:00.000Z',
        credentialId: 'credential-key-1',
        deviceType: 'singleDevice',
        id: 'key-1',
        label: 'Jordan office key',
        lastUsedAt: null,
      }],
      pilotEligible: true,
      requestId: 'request-1',
    })

    render(
      <MemoryRouter initialEntries={['/account-security?mode=security-key-management']}>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'Verify before changing security keys.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify authenticator' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use security key' })).not.toBeInTheDocument()
  })
})

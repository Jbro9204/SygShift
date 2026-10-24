import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as mfaData from '../data/mfa'
import * as securityKeyData from '../data/securityKeys'
import * as trustedDeviceData from '../data/trustedDevices'
import { TOTP_SETUP_STORAGE_KEY } from '../data/auth'
import { AccountSecurityPage, mfaVerificationResultIsCurrent, totpEnrollmentForEmployee, totpEnrollmentResultIsCurrent } from './AccountSecurityPage'

const authMock = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
  notifySessionContextChanged: vi.fn(),
  signOut: vi.fn(),
  transientError: new Error('connection pool timeout'),
}))

const passwordMock = vi.hoisted(() => ({
  updateMyPassword: vi.fn(),
}))

const supabaseMock = vi.hoisted(() => ({
  client: {
    auth: {
      getSession: vi.fn(),
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
    isTransientSessionContextError: vi.fn((error: unknown) => error === authMock.transientError),
    notifySessionContextChanged: authMock.notifySessionContextChanged,
    signOut: authMock.signOut,
  }
})

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => supabaseMock.client,
  isSupabaseConfigured: true,
}))

vi.mock('../data/myAccount', async () => {
  const actual = await vi.importActual<typeof import('../data/myAccount')>('../data/myAccount')
  return { ...actual, updateMyPassword: passwordMock.updateMyPassword }
})

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

vi.mock('../data/trustedDevices', () => ({
  clearRememberedDeviceOnThisBrowser: vi.fn(),
  getCurrentTrustedDevices: vi.fn(),
  rememberCurrentDevice: vi.fn(),
  revokeCurrentTrustedDevice: vi.fn(),
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
    sessionStorage.clear()
    authMock.getSessionContext
      .mockResolvedValueOnce(sessionContext())
      .mockResolvedValueOnce(sessionContext({
        mustChangePassword: false,
        passwordChangedAt: '2026-07-05T21:05:00.000Z',
      }))
    authMock.signOut.mockResolvedValue(undefined)
    supabaseMock.client.auth.refreshSession.mockResolvedValue({ data: {}, error: null })
    supabaseMock.client.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: '30000000-0000-4000-8000-000000000003' } } },
      error: null,
    })
    supabaseMock.client.auth.signOut.mockResolvedValue({ error: null })
    supabaseMock.client.auth.updateUser.mockResolvedValue({ data: {}, error: null })
    supabaseMock.client.rpc.mockResolvedValue({ data: true, error: null })
    passwordMock.updateMyPassword.mockResolvedValue({
      authUserId: '30000000-0000-4000-8000-000000000003',
      employeeId: '10000000-0000-4000-8000-000000000001',
      passwordAlreadyCurrent: false,
      saved: true,
      sessionStillCurrent: true,
    })
    vi.mocked(mfaData.listMfaFactors).mockResolvedValue([])
    vi.mocked(mfaData.getAuthenticatorLevel).mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' })
    vi.mocked(securityKeyData.getSecurityKeyDirectory).mockResolvedValue({
      featureEnabled: true,
      keys: [],
      pilotEligible: true,
      requestId: 'request-1',
    })
    vi.mocked(trustedDeviceData.getCurrentTrustedDevices).mockResolvedValue([])
    vi.mocked(trustedDeviceData.revokeCurrentTrustedDevice).mockResolvedValue()
  })

  it('keeps the authenticated session and offers retry when the security checkpoint is temporarily unavailable', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext
      .mockRejectedValueOnce(authMock.transientError)
      .mockResolvedValue(sessionContext())

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    const retry = await screen.findByRole('button', { name: 'Retry secure session check' })
    expect(screen.getByText(/Your sign-in was kept/i)).toBeInTheDocument()
    expect(authMock.signOut).not.toHaveBeenCalled()

    fireEvent.click(retry)

    expect(await screen.findByLabelText('New password')).toBeInTheDocument()
    expect(authMock.getSessionContext).toHaveBeenCalledTimes(2)
    expect(authMock.signOut).not.toHaveBeenCalled()
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
      expect(passwordMock.updateMyPassword).toHaveBeenCalledWith(
        'StrongAdmin123!',
        '10000000-0000-4000-8000-000000000001',
      )
    })
    expect(supabaseMock.client.auth.updateUser).not.toHaveBeenCalled()
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
      expect(passwordMock.updateMyPassword).toHaveBeenCalledWith(
        'StrongAdmin123!',
        '10000000-0000-4000-8000-000000000001',
      )
    })
    expect(supabaseMock.client.auth.updateUser).not.toHaveBeenCalled()
    expect(supabaseMock.client.rpc).not.toHaveBeenCalledWith('mark_password_changed')
    expect(authMock.signOut).toHaveBeenCalledTimes(1)
    expect(supabaseMock.client.auth.refreshSession).not.toHaveBeenCalled()
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

  it('resumes a pending authenticator enrollment only for the same employee', async () => {
    const ownerId = '10000000-0000-4000-8000-000000000001'
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({
      employeeId: ownerId,
      hasMfa: false,
      mfaRequired: true,
      mustChangePassword: false,
    }))
    sessionStorage.setItem(TOTP_SETUP_STORAGE_KEY, JSON.stringify({
      enrollment: {
        factorId: 'factor-private',
        qrCode: 'data:image/svg+xml;base64,PHN2Zy8+',
        secret: 'SAME-EMPLOYEE-SECRET',
        uri: 'otpauth://totp/SygShift:testadmin?secret=SAMEEMPLOYEESECRET',
      },
      ownerId,
    }))

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('SAME-EMPLOYEE-SECRET')).toBeInTheDocument()
    expect(screen.getByText(/Authenticator setup is still active/i)).toBeInTheDocument()
  })

  it('discards a pending authenticator secret owned by a different employee', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({
      employeeId: '10000000-0000-4000-8000-000000000001',
      hasMfa: false,
      mfaRequired: true,
      mustChangePassword: false,
    }))
    sessionStorage.setItem(TOTP_SETUP_STORAGE_KEY, JSON.stringify({
      enrollment: {
        factorId: 'factor-private',
        qrCode: 'data:image/svg+xml;base64,PHN2Zy8+',
        secret: 'OTHER-EMPLOYEE-SECRET',
        uri: 'otpauth://totp/SygShift:other?secret=OTHEREMPLOYEESECRET',
      },
      ownerId: '20000000-0000-4000-8000-000000000002',
    }))

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: /Start authenticator setup/i })).toBeInTheDocument()
    expect(screen.queryByText('OTHER-EMPLOYEE-SECRET')).not.toBeInTheDocument()
    expect(sessionStorage.getItem(TOTP_SETUP_STORAGE_KEY)).toBeNull()
  })

  it('never exposes an in-memory authenticator enrollment to a different employee', () => {
    const enrollment = {
      factorId: 'factor-private',
      qrCode: 'data:image/svg+xml;base64,PHN2Zy8+',
      secret: 'PRIVATE-EMPLOYEE-SECRET',
      uri: 'otpauth://totp/SygShift:testadmin?secret=PRIVATEEMPLOYEESECRET',
    }

    expect(totpEnrollmentForEmployee({
      enrollment,
      ownerId: '10000000-0000-4000-8000-000000000001',
    }, '10000000-0000-4000-8000-000000000001')).toBe(enrollment)
    expect(totpEnrollmentForEmployee({
      enrollment,
      ownerId: '10000000-0000-4000-8000-000000000001',
    }, '20000000-0000-4000-8000-000000000002')).toBeNull()
  })

  it('rejects a late authenticator enrollment result after the active account changes', () => {
    expect(totpEnrollmentResultIsCurrent(
      4,
      5,
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
    )).toBe(false)
    expect(totpEnrollmentResultIsCurrent(
      5,
      5,
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
    )).toBe(true)
  })

  it('rejects every later MFA verification step after either employee or auth-session ownership changes', () => {
    const employeeA = '10000000-0000-4000-8000-000000000001'
    const employeeB = '20000000-0000-4000-8000-000000000002'
    const authA = '30000000-0000-4000-8000-000000000003'
    const authB = '40000000-0000-4000-8000-000000000004'

    expect(mfaVerificationResultIsCurrent(7, 7, employeeA, employeeA, authA, authA)).toBe(true)
    expect(mfaVerificationResultIsCurrent(7, 8, employeeA, employeeA, authA, authA)).toBe(false)
    expect(mfaVerificationResultIsCurrent(7, 7, employeeA, employeeB, authA, authA)).toBe(false)
    expect(mfaVerificationResultIsCurrent(7, 7, employeeA, employeeA, authA, authB)).toBe(false)
  })

  it('does not present a failed remembered-device lookup as an empty verified list', async () => {
    authMock.getSessionContext.mockReset()
    authMock.getSessionContext.mockResolvedValue(sessionContext({
      hasMfa: true,
      mfaRequired: true,
      mustChangePassword: false,
    }))
    vi.mocked(trustedDeviceData.getCurrentTrustedDevices)
      .mockRejectedValueOnce(new Error('Device directory timed out.'))
      .mockResolvedValueOnce([])

    render(
      <MemoryRouter>
        <AccountSecurityPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(/Remembered devices could not be verified/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/Remembered devices could not be loaded/i)
    expect(screen.getByRole('alert')).not.toHaveTextContent('Device directory timed out.')
    expect(screen.queryByText(/No active remembered devices/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry device check' }))

    expect(await screen.findByText(/No active remembered devices/i)).toBeInTheDocument()
    expect(trustedDeviceData.getCurrentTrustedDevices).toHaveBeenCalledTimes(2)
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

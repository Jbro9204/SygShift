import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SecurityTab } from './MyAccountPage'
import { getCurrentTrustedDevices } from '../data/trustedDevices'
import { getAuthenticatorLevel, listMfaFactors } from '../data/mfa'
import { getSecurityKeyDirectory } from '../data/securityKeys'
import type { MyAccount } from '../data/myAccount'

vi.mock('../data/trustedDevices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/trustedDevices')>()
  return { ...actual, getCurrentTrustedDevices: vi.fn() }
})

vi.mock('../data/mfa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/mfa')>()
  return {
    ...actual,
    getAuthenticatorLevel: vi.fn().mockResolvedValue({ currentLevel: 'aal1', nextLevel: 'aal2' }),
    listMfaFactors: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../data/securityKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/securityKeys')>()
  return {
    ...actual,
    getSecurityKeyDirectory: vi.fn().mockResolvedValue({ featureEnabled: false, pilotEligible: false, keys: [], requestId: 'test' }),
  }
})

const account: MyAccount = {
  profile: {
    employeeId: '11111111-1111-4111-8111-111111111111',
    preferredName: null,
    displayName: 'Jordan Brown',
    personalEmail: null,
    personalEmailVerifiedAt: null,
    companyEmail: null,
    mobilePhone: null,
    hasPhoto: false,
  },
  employment: {
    legalName: 'Jordan Brown',
    employeeNumber: 'SYG-1001',
    username: 'jbrown',
    jobTitle: 'Owner',
    primaryRole: 'admin',
    employmentType: 'salary',
    status: 'active',
    hiredOn: '2026-01-01',
  },
  security: {
    passwordChangedAt: '2026-10-01T12:00:00Z',
    mfaEnrolledAt: '2026-10-01T12:00:00Z',
    mfaRequired: true,
    lastSignInAt: '2026-10-24T12:00:00Z',
    trustedDeviceCount: 1,
  },
  notifications: {
    schedulePublished: true,
    scheduleChanged: true,
    timeOffDecision: true,
    openShiftAvailable: true,
    announcements: true,
  },
  recentActivity: [],
}

describe('My Account remembered-device truthfulness', () => {
  beforeEach(() => {
    vi.mocked(getCurrentTrustedDevices).mockReset()
    vi.mocked(getAuthenticatorLevel).mockReset()
    vi.mocked(getAuthenticatorLevel).mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' })
    vi.mocked(listMfaFactors).mockReset()
    vi.mocked(listMfaFactors).mockResolvedValue([])
    vi.mocked(getSecurityKeyDirectory).mockReset()
    vi.mocked(getSecurityKeyDirectory).mockResolvedValue({ featureEnabled: false, pilotEligible: false, keys: [], requestId: 'test' })
  })

  it('does not present a failed device lookup as an authoritative empty list and allows retry', async () => {
    vi.mocked(getCurrentTrustedDevices)
      .mockRejectedValueOnce(new Error('relation trusted_devices does not exist'))
      .mockResolvedValueOnce([{
        id: '22222222-2222-4222-8222-222222222222',
        deviceLabel: 'Office laptop',
        createdAt: '2026-10-01T12:00:00Z',
        expiresAt: '2026-11-01T12:00:00Z',
        lastSeenAt: '2026-10-24T12:00:00Z',
        isCurrentDevice: true,
      }])
    const user = userEvent.setup()

    render(<MemoryRouter><SecurityTab account={account} refreshAccount={vi.fn().mockResolvedValue(undefined)} /></MemoryRouter>)

    expect(await screen.findByRole('alert')).toHaveTextContent('The device list has not been verified.')
    expect(screen.getByRole('alert')).not.toHaveTextContent('relation trusted_devices does not exist')
    expect(screen.queryByText('No remembered devices are active.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText(/Office laptop/)).toBeVisible()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(getCurrentTrustedDevices).toHaveBeenCalledTimes(2)
  })

  it('hides stale devices and their Remove actions when a later device refresh fails', async () => {
    vi.mocked(getCurrentTrustedDevices)
      .mockResolvedValueOnce([{
        id: '22222222-2222-4222-8222-222222222222',
        deviceLabel: 'Office laptop',
        createdAt: '2026-10-01T12:00:00Z',
        expiresAt: '2026-11-01T12:00:00Z',
        lastSeenAt: '2026-10-24T12:00:00Z',
        isCurrentDevice: true,
      }])
      .mockRejectedValueOnce(new Error('Remembered devices could not be loaded.'))
    const user = userEvent.setup()

    render(<MemoryRouter><SecurityTab account={account} refreshAccount={vi.fn().mockResolvedValue(undefined)} /></MemoryRouter>)

    expect(await screen.findByText(/Office laptop/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Refresh remembered devices' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The device list has not been verified.')
    expect(screen.queryByText(/Office laptop/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(screen.queryByText('No remembered devices are active.')).not.toBeInTheDocument()
  })
})

describe('My Account security-method truthfulness', () => {
  beforeEach(() => {
    vi.mocked(getCurrentTrustedDevices).mockReset()
    vi.mocked(getCurrentTrustedDevices).mockResolvedValue([])
    vi.mocked(getAuthenticatorLevel).mockReset()
    vi.mocked(getAuthenticatorLevel).mockResolvedValue({ currentLevel: 'aal2', nextLevel: 'aal2' })
    vi.mocked(listMfaFactors).mockReset()
    vi.mocked(listMfaFactors).mockResolvedValue([])
    vi.mocked(getSecurityKeyDirectory).mockReset()
  })

  it('shows an initial verification failure instead of an authoritative empty inventory', async () => {
    vi.mocked(getSecurityKeyDirectory)
      .mockRejectedValueOnce(new Error('Security key directory timed out.'))
      .mockResolvedValueOnce({ featureEnabled: true, pilotEligible: true, keys: [], requestId: 'retry' })
    const user = userEvent.setup()

    render(<MemoryRouter><SecurityTab account={account} refreshAccount={vi.fn().mockResolvedValue(undefined)} /></MemoryRouter>)

    expect(await screen.findByRole('alert')).toHaveTextContent('Registered security methods have not been verified.')
    expect(screen.queryByText('No security keys are registered.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try security methods again' }))
    expect(await screen.findByText('No security keys are registered.')).toBeVisible()
    await waitFor(() => expect(screen.queryByText(/Registered security methods have not been verified/)).not.toBeInTheDocument())
  })

  it('keeps the last verified key visible but disables changes after a refresh failure', async () => {
    vi.mocked(getSecurityKeyDirectory)
      .mockResolvedValueOnce({
        featureEnabled: true,
        pilotEligible: true,
        keys: [{
          backedUp: false,
          createdAt: '2026-10-01T12:00:00Z',
          credentialId: 'credential-1',
          deviceType: 'single_device',
          id: 'key-1',
          label: 'Office key',
          lastUsedAt: null,
        }],
        requestId: 'initial',
      })
      .mockRejectedValueOnce(new Error('Security key directory timed out.'))
    const user = userEvent.setup()

    render(<MemoryRouter><SecurityTab account={account} refreshAccount={vi.fn().mockResolvedValue(undefined)} /></MemoryRouter>)
    expect(await screen.findByText('Office key')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Refresh security methods' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Registered security methods have not been verified.')
    expect(screen.getByText('Office key')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
  })
})

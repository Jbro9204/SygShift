import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  listTotpFactors: vi.fn(),
  startTotpEnrollment: vi.fn(),
  verifyMfaChallenge: vi.fn(),
  verifyTotpEnrollment: vi.fn(),
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
})

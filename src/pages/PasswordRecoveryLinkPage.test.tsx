import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PasswordRecoveryLinkPage } from './PasswordRecoveryLinkPage'

const authMock = vi.hoisted(() => ({
  verifyPasswordRecoveryToken: vi.fn(),
}))

vi.mock('../data/auth', () => ({
  verifyPasswordRecoveryToken: authMock.verifyPasswordRecoveryToken,
}))

describe('PasswordRecoveryLinkPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/password-recovery')
  })

  it('removes the bearer token from the address bar before verifying it', async () => {
    authMock.verifyPasswordRecoveryToken.mockResolvedValue(undefined)
    window.history.replaceState(null, '', '/password-recovery#token_hash=abcdefghijklmnopqrstuvwxyz123456')

    render(
      <MemoryRouter initialEntries={['/password-recovery']}>
        <Routes>
          <Route path="/password-recovery" element={<PasswordRecoveryLinkPage />} />
          <Route path="/account-security" element={<p>Recovery checkpoint</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(authMock.verifyPasswordRecoveryToken).toHaveBeenCalledWith('abcdefghijklmnopqrstuvwxyz123456')
    })
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('')
    expect(await screen.findByText('Recovery checkpoint')).toBeInTheDocument()
  })

  it('shows a safe recovery action when the token is missing or expired', async () => {
    authMock.verifyPasswordRecoveryToken.mockRejectedValue(new Error('This password-reset link is invalid or has expired.'))

    render(
      <MemoryRouter initialEntries={['/password-recovery']}>
        <Routes>
          <Route path="/password-recovery" element={<PasswordRecoveryLinkPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'This reset link cannot be used.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Return to sign in' })).toHaveAttribute('href', '/login')
  })
})

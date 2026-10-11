import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const loginMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionContext: vi.fn(),
  signOut: vi.fn(),
  transientError: new Error('connection pool timeout'),
}))

vi.mock('../data/auth', async () => {
  const actual = await vi.importActual<typeof import('../data/auth')>('../data/auth')
  return {
    ...actual,
    getSessionContext: loginMocks.getSessionContext,
    isTransientSessionContextError: vi.fn((error: unknown) => error === loginMocks.transientError),
    signOut: loginMocks.signOut,
  }
})

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: loginMocks.getSession } }),
  isSupabaseConfigured: true,
}))

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loginMocks.getSession.mockResolvedValue({ data: { session: null } })
    loginMocks.getSessionContext.mockResolvedValue({})
    loginMocks.signOut.mockResolvedValue(undefined)
  })

  it('uses a generic username placeholder', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('Username')).toHaveAttribute('placeholder', 'Username')
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('placeholder', 'jbrown')
  })

  it('allows the login password to be shown and hidden', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )

    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('opens a username-based password recovery form and returns to sign in', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.getByText(/approved personal email on file/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('opens an enumeration-safe username reminder form without asking for a username', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Forgot username?' }))

    expect(screen.getByRole('heading', { name: 'Find your username' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email on your employee record')).toHaveAttribute('type', 'email')
    expect(screen.getByRole('button', { name: 'Send username reminder' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
  })

  it('confirms a completed password reset without exposing recovery details', () => {
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/login',
        state: { message: 'Password reset complete. Sign in with your new password.' },
      }]}>
        <LoginPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Password reset complete. Sign in with your new password.')).toBeInTheDocument()
  })

  it('keeps the authenticated session and offers retry when account verification is temporarily unavailable', async () => {
    loginMocks.getSession.mockResolvedValue({ data: { session: { access_token: 'active-session' } } })
    loginMocks.getSessionContext
      .mockRejectedValueOnce(loginMocks.transientError)
      .mockResolvedValueOnce({})

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )

    const retry = await screen.findByRole('button', { name: 'Retry secure session check' })
    expect(screen.getByText(/Your sign-in was kept/i)).toBeInTheDocument()
    expect(loginMocks.signOut).not.toHaveBeenCalled()

    fireEvent.click(retry)

    await waitFor(() => expect(loginMocks.getSessionContext).toHaveBeenCalledTimes(2))
    expect(loginMocks.signOut).not.toHaveBeenCalled()
  })
})

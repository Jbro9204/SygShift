import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { LoginPage } from './LoginPage'

describe('LoginPage', () => {
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
})

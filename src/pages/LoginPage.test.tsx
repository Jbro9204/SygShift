import { render, screen } from '@testing-library/react'
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
})

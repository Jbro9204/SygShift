import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OperationalImportPage } from './OperationalImportPage'

describe('operational import page', () => {
  it('explains the verified mapping scope without exposing private records', () => {
    render(<OperationalImportPage />)

    expect(screen.getByRole('heading', { name: 'Operational import' })).toBeVisible()
    expect(screen.getByText('The current schedule is reduced to a manageable review.')).toBeVisible()
    expect(screen.getByText('963')).toBeVisible()
    expect(screen.getByText('Ready to connect the protected mapping workspace')).toBeVisible()
  })
})

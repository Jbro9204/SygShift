import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkforceRoleSelect } from './WorkforceRoleSelect'

describe('WorkforceRoleSelect', () => {
  it('keeps Guard available while disabling elevated choices without role-management authority', () => {
    render(<WorkforceRoleSelect actor={{ permissions: ['hr.onboarding.manage'], role: 'supervisor' }} aria-label="Workforce role" />)

    expect(screen.getByRole('combobox', { name: 'Workforce role' })).toHaveValue('guard')
    expect(screen.getByRole('option', { name: 'Guard' })).toBeEnabled()
    expect(screen.getByRole('option', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Admin' })).toBeDisabled()
  })

  it('allows non-Admin workforce roles to role managers but reserves Admin for a primary Admin', () => {
    const { rerender } = render(<WorkforceRoleSelect actor={{ permissions: ['admin.roles.manage'], role: 'supervisor' }} aria-label="Workforce role" />)

    expect(screen.getByRole('option', { name: 'Supervisor' })).toBeEnabled()
    expect(screen.getByRole('option', { name: 'Recruiting & Licensing' })).toBeEnabled()
    expect(screen.getByRole('option', { name: 'Admin' })).toBeDisabled()

    rerender(<WorkforceRoleSelect actor={{ permissions: ['admin.roles.manage'], role: 'admin' }} aria-label="Workforce role" />)
    expect(screen.getByRole('option', { name: 'Admin' })).toBeEnabled()
  })

  it('preserves an imported elevated suggestion until the user explicitly chooses Guard', () => {
    render(
      <WorkforceRoleSelect
        actor={{ permissions: ['imports.operations.manage'], role: 'supervisor' }}
        aria-label="Workforce role"
        defaultValue="supervisor"
      />,
    )

    const role = screen.getByRole('combobox', { name: 'Workforce role' })
    expect(role).toHaveValue('supervisor')
    expect(screen.getByRole('option', { name: 'Supervisor' })).toBeDisabled()

    fireEvent.change(role, { target: { value: 'guard' } })
    expect(role).toHaveValue('guard')
  })

  it('does not silently change a controlled selection after assignment authority is removed', () => {
    const { rerender } = render(
      <WorkforceRoleSelect
        actor={{ permissions: ['admin.roles.manage'], role: 'supervisor' }}
        aria-label="Workforce role"
        value="supervisor"
      />,
    )

    rerender(
      <WorkforceRoleSelect
        actor={{ permissions: [], role: 'supervisor' }}
        aria-label="Workforce role"
        value="supervisor"
      />,
    )

    expect(screen.getByRole('combobox', { name: 'Workforce role' })).toHaveValue('supervisor')
    expect(screen.getByRole('option', { name: 'Supervisor' })).toBeDisabled()
  })
})

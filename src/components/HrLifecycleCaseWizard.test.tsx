import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HrOffboardingOptions } from '../data/hrOffboarding'
import { HrLifecycleCaseWizard } from './HrLifecycleCaseWizard'

const options: HrOffboardingOptions = {
  enabled: true,
  employees: [
    { id: '10000000-0000-4000-8000-000000000001', name: 'Ernesto Munguia', username: 'emunguia', employeeNumber: 'SYG-1058', status: 'active' },
    { id: '10000000-0000-4000-8000-000000000002', name: 'Alex Rivera', username: 'arivera', employeeNumber: 'SYG-1060', status: 'active' },
    { id: '10000000-0000-4000-8000-000000000003', name: 'Alex Morgan', username: 'amorgan', employeeNumber: 'SYG-1061', status: 'active' },
    { id: '10000000-0000-4000-8000-000000000004', name: 'Former Employee', username: 'former', employeeNumber: 'SYG-1000', status: 'separated' },
  ],
  owners: [],
}

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <HrLifecycleCaseWizard onClose={vi.fn()} onCreated={vi.fn()} options={options} />
    </QueryClientProvider>,
  )
}

describe('HrLifecycleCaseWizard employee picker', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  })

  it('automatically selects and confirms one unique employee match', async () => {
    const user = userEvent.setup()
    renderWizard()

    const continueButton = screen.getByRole('button', { name: /continue/i })
    expect(continueButton).toBeDisabled()

    await user.type(screen.getByRole('combobox', { name: /find employee/i }), 'Ernesto')

    const selected = screen.getByText('Selected employee').parentElement
    expect(selected).not.toBeNull()
    expect(within(selected!).getByText('Ernesto Munguia')).toBeInTheDocument()
    expect(within(selected!).getByText('@emunguia · SYG-1058')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Ernesto Munguia/ })).toHaveAttribute('aria-selected', 'true')
    expect(continueButton).toBeEnabled()
  })

  it('shows ambiguous matches without guessing which employee was intended', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.type(screen.getByRole('combobox', { name: /find employee/i }), 'Alex')

    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.queryByText('Selected employee')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })

  it('clears the selected employee so the workflow cannot continue with a stale identity', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.type(screen.getByRole('combobox', { name: /find employee/i }), 'SYG-1058')
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Change' }))

    expect(screen.getByRole('combobox', { name: /find employee/i })).toHaveValue('')
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })
})

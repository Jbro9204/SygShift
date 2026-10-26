import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { HrisOnboardingPage } from './HrisOnboardingPage'

const getSessionContext = vi.hoisted(() => vi.fn())
const getHrOnboardingWorkspace = vi.hoisted(() => vi.fn())
const getHrOnboardingOptions = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: true }))
vi.mock('../data/auth', () => ({ getSessionContext }))
vi.mock('../data/hrOnboarding', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/hrOnboarding')>(),
  getHrOnboardingCase: vi.fn(),
  getHrOnboardingOptions,
  getHrOnboardingWorkspace,
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <HrisOnboardingPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('HR onboarding wizard', () => {
  beforeEach(() => {
    getSessionContext.mockReset().mockResolvedValue({
      permissions: ['hr.onboarding.manage'],
      role: 'supervisor',
    })
    getHrOnboardingWorkspace.mockReset().mockResolvedValue({
      cases: [],
      counts: { activeCases: 0, overdueTasks: 0, readyCases: 0 },
      enabled: true,
      offset: 0,
      pageSize: 10,
      templates: [],
    })
    getHrOnboardingOptions.mockReset().mockResolvedValue({
      employees: [{
        employeeName: 'Existing Employee',
        employeeNumber: 'SYG-1999',
        employmentType: 'hourly',
        hiredOn: '2026-09-28',
        id: '10000000-0000-4000-8000-000000000099',
        positionTitle: 'Guard',
        role: 'guard',
        status: 'active',
      }],
    })
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
  })

  it('advances an existing employee without asking HR to replace the stored time zone', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Start onboarding' }))
    fireEvent.click(screen.getByRole('button', { name: /Already in SygShift/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Existing Employee/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('group', { name: 'Employment setup' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Employee time zone')).not.toBeInTheDocument()
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    await waitFor(() => expect(continueButton).toBeEnabled())
    fireEvent.click(continueButton)

    expect(screen.getByRole('group', { name: 'Requirements that apply' })).toBeInTheDocument()
  })

  it('requires the time zone to be confirmed again after a new employee work-state change', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Start onboarding' }))
    fireEvent.change(screen.getByLabelText('Legal first name'), { target: { value: 'Misty' } })
    fireEvent.change(screen.getByLabelText('Legal last name'), { target: { value: 'Kimbal' } })
    fireEvent.change(screen.getByLabelText('Personal email'), { target: { value: 'misty-regression@example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    fireEvent.change(screen.getByLabelText('Position title'), { target: { value: 'Guard' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-28' } })
    const timeZone = screen.getByRole('combobox', { name: /Employee time zone/ })
    fireEvent.change(timeZone, { target: { value: 'America/Denver' } })
    expect(timeZone).toHaveValue('America/Denver')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Work state'), { target: { value: 'NC' } })

    expect(timeZone).toHaveValue('')
    expect(screen.getByText(/Suggested for NC: Eastern Time/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('keeps Guard available while disabling unauthorized elevated pre-hire roles', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Start onboarding' }))
    fireEvent.change(screen.getByLabelText('Legal first name'), { target: { value: 'New' } })
    fireEvent.change(screen.getByLabelText('Legal last name'), { target: { value: 'Guard' } })
    fireEvent.change(screen.getByLabelText('Personal email'), { target: { value: 'new.guard@example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const role = screen.getByRole('combobox', { name: /Primary workforce role/ })
    expect(role).toHaveValue('guard')
    expect(within(role).getByRole('option', { name: 'Guard' })).toBeEnabled()
    expect(within(role).getByRole('option', { name: 'Supervisor' })).toBeDisabled()
    expect(within(role).getByRole('option', { name: 'Admin' })).toBeDisabled()
    expect(screen.getByText(/Assigning another workforce role requires Manage roles permission/)).toBeInTheDocument()
  })

  it('keeps the exact Recruiting & Licensing label from selection through review', async () => {
    getSessionContext.mockResolvedValue({
      permissions: ['admin.roles.manage', 'hr.onboarding.manage'],
      role: 'supervisor',
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Start onboarding' }))
    fireEvent.change(screen.getByLabelText('Legal first name'), { target: { value: 'Riley' } })
    fireEvent.change(screen.getByLabelText('Legal last name'), { target: { value: 'Recruiter' } })
    fireEvent.change(screen.getByLabelText('Personal email'), { target: { value: 'riley.recruiter@example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    fireEvent.change(screen.getByLabelText('Position title'), { target: { value: 'Recruiter' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Employee time zone/ }), { target: { value: 'America/Denver' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Primary workforce role/ }), { target: { value: 'recruiting_licensing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const review = screen.getByRole('group', { name: 'Review and create' })
    expect(within(review).getByText('Recruiting & Licensing')).toBeInTheDocument()
    expect(within(review).queryByText('Recruiting Licensing')).not.toBeInTheDocument()
  })
})

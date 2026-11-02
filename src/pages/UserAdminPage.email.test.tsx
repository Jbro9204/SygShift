import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UserAdminPage } from './UserAdminPage'
import { AdminEmailRequestError, type AdminUser } from '../data/adminUsers'
import { employeeRoleTestUser } from '../test/employeeRoleFixtures'

const api = vi.hoisted(() => ({ directory: vi.fn(), login: vi.fn(), welcome: vi.fn(), session: vi.fn() }))
vi.mock('../data/adminUsers', async (original) => ({
  ...await original<typeof import('../data/adminUsers')>(),
  getAdminUserDirectory: api.directory,
  sendEmployeeLoginEmail: api.login,
  sendEmployeeWelcomeEmail: api.welcome,
}))
vi.mock('../data/auth', () => ({ getSessionContext: api.session }))
vi.mock('../data/platformPresence', async (original) => ({
  ...await original<typeof import('../data/platformPresence')>(), getPlatformPresenceDirectory: async () => ({ people: [] }),
}))

const requestId = '20000000-0000-4000-8000-000000000001'
const employee: AdminUser = { ...employeeRoleTestUser, role: 'guard', personalEmail: 'employee@example.invalid' }
const created: AdminUser = { ...employee, accountStatus: 'active', account: {
  authUserId: '20000000-0000-4000-8000-000000000002', invitedAt: '2026-11-02T20:00:00Z', activatedAt: null,
  disabledAt: null, lastSignInAt: null, mustChangePassword: true, passwordChangedAt: null,
  mfaEnrolledAt: null, isBootstrapAdmin: false, status: 'active',
} }
const directory = (user = employee) => ({ serverTimestamp: '2026-11-02T20:00:00Z', currentEmployeeId: '90000000-0000-4000-8000-000000000001', users: [user] })
const accepted = () => ({ requestId, email: employee.personalEmail, username: employee.username, displayName: employee.displayName, action: 'created_auth_user' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function openOnboarding() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: 3, retryDelay: 1 } } })
  const user = userEvent.setup()
  render(<MemoryRouter><QueryClientProvider client={queryClient}><UserAdminPage /></QueryClientProvider></MemoryRouter>)
  await user.click(await screen.findByRole('button', { name: 'Manage' }))
  await user.click(screen.getByRole('button', { name: 'Onboarding' }))
  return { user, queryClient, dialog: screen.getByRole('dialog') }
}

beforeEach(() => {
  api.directory.mockReset().mockResolvedValue(directory())
  api.login.mockReset().mockResolvedValue(accepted())
  api.welcome.mockReset().mockResolvedValue(accepted())
  api.session.mockReset().mockResolvedValue({ employeeId: '90000000-0000-4000-8000-000000000001', role: 'admin', permissions: ['admin.users.basic', 'admin.users.manage', 'admin.users.invite'] })
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

describe('per-employee onboarding email outcome handling', () => {
  it('guards duplicate taps synchronously and disables competing actions and close until readback finishes', async () => {
    const pending = deferred<ReturnType<typeof accepted>>()
    const readback = deferred<ReturnType<typeof directory>>()
    api.login.mockReturnValue(pending.promise)
    api.directory.mockResolvedValueOnce(directory()).mockReturnValueOnce(readback.promise)
    const { dialog } = await openOnboarding()
    const button = within(dialog).getByRole('button', { name: 'Email login instructions' })
    act(() => { button.click(); button.click() })
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1))
    expect(within(dialog).getByRole('button', { name: 'Send welcome email' })).toBeDisabled()
    for (const name of ['Profile', 'Login & Security', 'Onboarding', 'Close dialog']) expect(within(dialog).getByRole('button', { name })).toBeDisabled()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(dialog).toBeVisible()
    await act(async () => pending.resolve(accepted()))
    await waitFor(() => expect(api.directory).toHaveBeenCalledTimes(2))
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    await act(async () => readback.resolve(directory(created)))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Email login instructions' })).toBeEnabled())
    expect(within(dialog).getByText(`Login instructions accepted for delivery to ${employee.personalEmail}. Request ${requestId}.`)).toBeVisible()
    expect(within(dialog).getByText('Created', { selector: '.user-account-onboarding-summary strong' })).toBeVisible()
    expect(api.login).toHaveBeenCalledTimes(1)
  })

  it('refreshes after a partial failure, preserves the request reference, and never automatically retries a send', async () => {
    api.login.mockRejectedValue(new AdminEmailRequestError('Account preparation could not be confirmed.', 500, 'login_instructions_auth_create_failed', requestId))
    api.directory.mockResolvedValueOnce(directory()).mockResolvedValue(directory(created))
    const { user, dialog } = await openOnboarding()
    await user.click(within(dialog).getByRole('button', { name: 'Email login instructions' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Request ${requestId}`)
    await waitFor(() => expect(api.directory).toHaveBeenCalledTimes(2))
    expect(within(dialog).getByText('Created', { selector: '.user-account-onboarding-summary strong' })).toBeVisible()
    expect(within(dialog).queryByText(/Login instructions accepted/)).not.toBeInTheDocument()
    expect(api.login).toHaveBeenCalledTimes(1)
    expect(api.welcome).not.toHaveBeenCalled()
  })

  it('preserves a successful welcome receipt when login instructions fail and clears only stale login success on retry', async () => {
    const retry = deferred<ReturnType<typeof accepted>>()
    api.login.mockResolvedValueOnce(accepted()).mockReturnValueOnce(retry.promise)
    const { user, dialog } = await openOnboarding()
    await user.click(within(dialog).getByRole('button', { name: 'Send welcome email' }))
    expect(await within(dialog).findByText(/Welcome email accepted for delivery/)).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Email login instructions' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Email login instructions' }))
    expect(await within(dialog).findByText(/Login instructions accepted for delivery/)).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Email login instructions' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Email login instructions' }))
    expect(within(dialog).queryByText(/Login instructions accepted for delivery/)).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Welcome email accepted for delivery/)).toBeVisible()
    await act(async () => retry.reject(new AdminEmailRequestError('Login-instructions delivery could not be confirmed.', 502, 'login_instructions_email_failed', requestId)))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Request ${requestId}`)
    expect(within(dialog).getByText(/Welcome email accepted for delivery/)).toBeVisible()
    expect(api.welcome).toHaveBeenCalledTimes(1)
    expect(api.login).toHaveBeenCalledTimes(2)
  })

  it('requires explicit readback recovery after refresh fails and never resends while refreshing', async () => {
    api.login.mockRejectedValue(new AdminEmailRequestError('Email outcome could not be confirmed.', 500, null, requestId))
    api.directory.mockResolvedValueOnce(directory()).mockRejectedValueOnce(new Error('readback failed')).mockResolvedValue(directory(created))
    const { user, dialog } = await openOnboarding()
    await user.click(within(dialog).getByRole('button', { name: 'Email login instructions' }))
    const refresh = await within(dialog).findByRole('button', { name: 'Refresh account status' })
    expect(within(dialog).getByRole('button', { name: 'Email login instructions' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Send welcome email' })).toBeDisabled()
    await user.click(refresh)
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Refresh account status' })).not.toBeInTheDocument())
    expect(within(dialog).getByRole('button', { name: 'Email login instructions' })).toBeEnabled()
    expect(api.directory).toHaveBeenCalledTimes(3)
    expect(api.login).toHaveBeenCalledTimes(1)
    expect(api.welcome).not.toHaveBeenCalled()
  })

  it('does not carry a prior email outcome into a closed and reopened employee workspace', async () => {
    const { user, dialog } = await openOnboarding()
    await user.click(within(dialog).getByRole('button', { name: 'Email login instructions' }))
    expect(await within(dialog).findByText(/Login instructions accepted for delivery/)).toBeVisible()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    await user.click(screen.getByRole('button', { name: 'Manage' }))
    await user.click(screen.getByRole('button', { name: 'Onboarding' }))
    expect(screen.queryByText(/Login instructions accepted for delivery/)).not.toBeInTheDocument()
    expect(api.login).toHaveBeenCalledTimes(1)
  })

  it('keeps invitation authorization and blocked-recipient safeguards unchanged', async () => {
    api.session.mockResolvedValue({ employeeId: '90000000-0000-4000-8000-000000000001', role: 'supervisor', permissions: ['admin.users.basic'] })
    api.directory.mockResolvedValue(directory({ ...employee, personalEmail: null, companyEmail: 'employee@guardianshipsecurity.net' }))
    const { dialog } = await openOnboarding()
    expect(within(dialog).getByRole('button', { name: 'Email login instructions' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Send welcome email' })).toBeDisabled()
    expect(api.login).not.toHaveBeenCalled()
    expect(api.welcome).not.toHaveBeenCalled()
  })
})

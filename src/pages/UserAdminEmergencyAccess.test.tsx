import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as adminUsersData from '../data/adminUsers'
import type {
  AdminUser,
  EmployeeEmergencyAccessResult,
  EmployeeEmergencyAccessState,
} from '../data/adminUsers'
import { EmployeeEmergencyAccessModal, ManageUserModal } from './UserAdminPage'

vi.mock('../data/adminUsers', async () => {
  const actual = await vi.importActual<typeof import('../data/adminUsers')>('../data/adminUsers')
  return {
    ...actual,
    getEmployeeEmergencyAccessState: vi.fn(),
    restoreEmployeeEmergencyAccess: vi.fn(),
    revokeEmployeeEmergencyAccess: vi.fn(),
  }
})

const EMPLOYEE_ID = '10000000-0000-4000-8000-000000000001'
const AUTH_USER_ID = '20000000-0000-4000-8000-000000000002'
const ACTOR_ID = '30000000-0000-4000-8000-000000000003'
const OPERATION_ID = '40000000-0000-4000-8000-000000000004'
const REVOCATION_ID = '50000000-0000-4000-8000-000000000005'

function employee(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    account: {
      activatedAt: '2026-10-01T12:00:00.000Z',
      authUserId: AUTH_USER_ID,
      disabledAt: null,
      invitedAt: '2026-09-30T12:00:00.000Z',
      isBootstrapAdmin: false,
      lastSignInAt: '2026-10-28T12:00:00.000Z',
      mfaEnrolledAt: '2026-10-01T12:30:00.000Z',
      mustChangePassword: false,
      passwordChangedAt: '2026-10-01T12:15:00.000Z',
      status: 'active',
      trustedDeviceCount: 1,
    },
    accountStatus: 'active',
    companyEmail: 'employee@guardianshipsecurity.net',
    credentials: [],
    displayName: 'Taylor Employee',
    employeeNumber: 'SYG-1001',
    employmentType: 'hourly',
    firstName: 'Taylor',
    hiredOn: '2026-01-01',
    id: EMPLOYEE_ID,
    jobTitle: 'Security Officer',
    lastName: 'Employee',
    middleName: null,
    mobilePhone: null,
    personalEmail: 'taylor@example.com',
    photoPath: null,
    preferredName: null,
    role: 'guard',
    separatedOn: null,
    status: 'active',
    timeZone: 'America/Denver',
    username: 'temployee',
    ...overrides,
  }
}

function emergencyState(
  accountState: EmployeeEmergencyAccessState['accountState'],
  overrides: Partial<EmployeeEmergencyAccessState> = {},
): EmployeeEmergencyAccessState {
  return {
    accountState,
    activeSessionCounts: {},
    authBanned: accountState === 'revoked' ? true : false,
    counts: {},
    disabledAt: accountState === 'active' ? null : '2026-10-29T12:00:00.000Z',
    displayName: 'Taylor Employee',
    employeeId: EMPLOYEE_ID,
    operation: undefined,
    recoveryEmailMasked: 't***@example.com',
    revocationId: accountState === 'active' ? null : REVOCATION_ID,
    username: 'temployee',
    ...overrides,
  }
}

function result(
  action: 'revoke' | 'restore',
  state: EmployeeEmergencyAccessState,
  overrides: Partial<EmployeeEmergencyAccessResult> = {},
): EmployeeEmergencyAccessResult {
  return {
    action,
    operationId: OPERATION_ID,
    requestId: `request-${action}`,
    state,
    status: state.accountState === 'active' || state.accountState === 'revoked' ? 'completed' : 'partial',
    ...overrides,
  }
}

function renderWithQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function renderEmergencyModal(
  action: 'revoke' | 'restore',
  state: EmployeeEmergencyAccessState,
) {
  const onClose = vi.fn()
  const onRecheck = vi.fn().mockResolvedValue(undefined)
  const onStateChanged = vi.fn().mockResolvedValue(undefined)
  renderWithQueryClient(
    <EmployeeEmergencyAccessModal
      action={action}
      employee={employee()}
      onClose={onClose}
      onRecheck={onRecheck}
      onStateChanged={onStateChanged}
      state={state}
    />,
  )
  return { onClose, onRecheck, onStateChanged }
}

function completeRequiredConfirmation(action: 'revoke' | 'restore', reason = 'Immediate security access review requested.') {
  fireEvent.change(screen.getByLabelText(/Required security reason/), { target: { value: reason } })
  fireEvent.change(screen.getByLabelText(/Type temployee exactly to confirm/), { target: { value: 'temployee' } })
  fireEvent.click(screen.getByRole('checkbox'))
  return screen.getByRole('button', {
    name: action === 'revoke' ? 'Revoke and verify all access' : 'Send recovery and restore access',
  })
}

describe('employee emergency access UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) { this.open = true })
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) { this.open = false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gates an active-account revocation on reason, exact username, and acknowledgment', async () => {
    const revoked = emergencyState('revoked', {
      activeSessionCounts: { authSessions: 0, refreshTokens: 0 },
      authBanned: true,
      counts: { authSessions: 2, refreshTokens: 3, trustedDevices: 1 },
    })
    vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess).mockResolvedValue(result('revoke', revoked))
    const { onStateChanged } = renderEmergencyModal('revoke', emergencyState('active'))
    const submit = screen.getByRole('button', { name: 'Revoke and verify all access' })

    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Required security reason/), { target: { value: 'Too short' } })
    fireEvent.change(screen.getByLabelText(/Type temployee exactly to confirm/), { target: { value: 'TEmployee' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Required security reason/), { target: { value: 'Immediate security access review requested.' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Type temployee exactly to confirm/), { target: { value: 'temployee' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(adminUsersData.revokeEmployeeEmergencyAccess).toHaveBeenCalledTimes(1))
    const input = vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess).mock.calls[0][1]
    expect(input).toMatchObject({
      acknowledged: true,
      confirmationUsername: 'temployee',
      reason: 'Immediate security access review requested.',
    })
    expect(input.operationRequestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(await screen.findByRole('heading', { name: 'Access revocation verified' })).toBeInTheDocument()
    expect(screen.getByLabelText('Verified access cleanup counts')).toHaveTextContent('2 auth Sessions')
    expect(onStateChanged).toHaveBeenCalledWith(revoked)
  })

  it('restores a revoked account only through the recovery workflow and renders the verified receipt', async () => {
    const active = emergencyState('active', {
      activeSessionCounts: { authSessions: 0, refreshTokens: 0 },
      authBanned: false,
      disabledAt: null,
      recoveryEmailMasked: 't***@example.com',
      revocationId: null,
    })
    vi.mocked(adminUsersData.restoreEmployeeEmergencyAccess).mockResolvedValue(result('restore', active, {
      recoveryEmailMasked: 't***@example.com',
    }))
    renderEmergencyModal('restore', emergencyState('revoked', { authBanned: true }))

    fireEvent.click(completeRequiredConfirmation('restore', 'Approved after identity and employment review.'))

    await waitFor(() => expect(adminUsersData.restoreEmployeeEmergencyAccess).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('heading', { name: 'Access restoration verified' })).toBeInTheDocument()
    expect(screen.getByText('t***@example.com')).toBeInTheDocument()
    expect(screen.getByText('Access is active')).toBeInTheDocument()
  })

  it('shows a partial receipt and retries with the original operation UUID and reason', async () => {
    const reason = 'Immediate access cleanup requires another provider verification.'
    const attention = emergencyState('revocation_attention', {
      activeSessionCounts: { refreshTokens: 1 },
      counts: { authSessions: 1 },
    })
    const completed = emergencyState('revoked', {
      activeSessionCounts: { refreshTokens: 0 },
      authBanned: true,
      counts: { authSessions: 1, refreshTokens: 1 },
    })
    vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess)
      .mockResolvedValueOnce(result('revoke', attention, {
        detail: 'Provider cleanup remains blocked. The account remains inaccessible.',
        status: 'partial',
      }))
      .mockResolvedValueOnce(result('revoke', completed))
    renderEmergencyModal('revoke', emergencyState('active'))

    fireEvent.click(completeRequiredConfirmation('revoke', reason))

    expect(await screen.findByRole('heading', { name: 'Operation needs attention' })).toBeInTheDocument()
    expect(screen.getByText('Provider cleanup remains blocked. The account remains inaccessible.')).toBeInTheDocument()
    expect(screen.getByLabelText('Remaining active access counts')).toHaveTextContent('1 refresh Tokens')
    fireEvent.click(screen.getByRole('button', { name: 'Retry same operation' }))

    await waitFor(() => expect(adminUsersData.revokeEmployeeEmergencyAccess).toHaveBeenCalledTimes(2))
    const firstInput = vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess).mock.calls[0][1]
    const retryInput = vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess).mock.calls[1][1]
    expect(retryInput).toEqual(firstInput)
    expect(retryInput.reason).toBe(reason)
    expect(retryInput.operationRequestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(await screen.findByRole('heading', { name: 'Access revocation verified' })).toBeInTheDocument()
  })

  it('resumes a provider-failed operation with its persisted UUID and reason', async () => {
    const originalReason = 'Security administrator requested immediate access removal.'
    const failed = emergencyState('revocation_attention', {
      operation: {
        action: 'revoke',
        operationRequestId: OPERATION_ID,
        reason: originalReason,
        status: 'provider_failed',
      },
    })
    vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess).mockResolvedValue(result('revoke', emergencyState('revoked')))
    renderEmergencyModal('revoke', failed)

    expect(screen.getByLabelText(/Required security reason/)).toHaveValue(originalReason)
    fireEvent.change(screen.getByLabelText(/Type temployee exactly to confirm/), { target: { value: 'temployee' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke and verify all access' }))

    await waitFor(() => expect(adminUsersData.revokeEmployeeEmergencyAccess).toHaveBeenCalledTimes(1))
    expect(vi.mocked(adminUsersData.revokeEmployeeEmergencyAccess).mock.calls[0][1]).toMatchObject({
      operationRequestId: OPERATION_ID,
      reason: originalReason,
    })
  })

  it('renders a legacy-disabled account without revoke or restore actions', async () => {
    const legacyEmployee = employee({
      account: {
        ...employee().account!,
        disabledAt: '2026-10-20T12:00:00.000Z',
        status: 'disabled',
      },
      accountStatus: 'disabled',
    })
    vi.mocked(adminUsersData.getEmployeeEmergencyAccessState).mockResolvedValue(emergencyState('legacy_disabled', {
      authBanned: null,
      disabledAt: '2026-10-20T12:00:00.000Z',
      recoveryEmailMasked: null,
      revocationId: null,
    }))

    renderWithQueryClient(
      <ManageUserModal
        accessRoles={[]}
        accessRolesReady
        actorEmployeeId={ACTOR_ID}
        actorIsPrimaryAdmin
        assignedAccessRoleIds={[]}
        canDeleteUsers={false}
        canEditAdminRole={false}
        canEditBasic={false}
        canManageEmergencyAccess
        canManageLogin={false}
        canResetPassword={false}
        canSendNewUserInvites={false}
        canSeparate={false}
        canViewAdminRoles={false}
        employee={legacyEmployee}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Login & Security' }))

    expect(await screen.findByText('Legacy disabled account')).toBeInTheDocument()
    expect(screen.getByText(/Emergency restoration will not erase it/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review access restoration' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revoke all access|Resume full revocation/ })).not.toBeInTheDocument()
  })
})

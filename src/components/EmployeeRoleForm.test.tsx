import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmployee, updateEmployee, type AdminUser, type EmployeeMutationInput } from '../data/adminUsers'
import type { AccessControlCenter, AccessControlUser, AccessRoleDefinition, PermissionDefinition } from '../data/accessControl'
import { RolePermissionEditor } from '../pages/AccessControlPage'
import { EmployeeForm } from '../pages/UserAdminPage'
import { employeeRoleFixtures, employeeRoleTestUser } from '../test/employeeRoleFixtures'
import { EmployeeAccessWorkspace } from './EmployeeAccessWorkspace'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: employeeRoleTestUser, error: null })
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})

function props(overrides: Partial<{
  accessRoles: AccessRoleDefinition[]
  accessRolesReady: boolean
  actorEmployeeId: string | null
  actorIsPrimaryAdmin: boolean
  assignedAccessRoleIds: string[]
  canEditAdminRole: boolean
  canEditBasic: boolean
  canViewAdminRoles: boolean
  employee: AdminUser | undefined
  pending: boolean
}> = {}) {
  return {
    accessRoles: employeeRoleFixtures,
    accessRolesReady: true,
    actorEmployeeId: '90000000-0000-4000-8000-000000000001',
    actorIsPrimaryAdmin: true,
    assignedAccessRoleIds: ['hr-manager-role'],
    canEditAdminRole: true,
    canEditBasic: true,
    canViewAdminRoles: true,
    canSeparate: true,
    employee: employeeRoleTestUser as AdminUser | undefined,
    onCancel: vi.fn(),
    onSubmit: vi.fn<(payload: EmployeeMutationInput) => void>(),
    onDirty: vi.fn(),
    pending: false,
    ...overrides,
  }
}

const openRoles = () => fireEvent.click(screen.getByRole('button', { name: /Manage roles|View roles/ }))
const confirmRoleChange = (reason = 'Approved workforce role update.') => {
  fireEvent.change(screen.getByLabelText('Required audit reason'), { target: { value: reason } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm & save employee' }))
}

describe('actual employee role form and RPC serialization', () => {
  it('shows one searchable list and saves profile edits without touching memberships', async () => {
    const input = props()
    render(<EmployeeForm {...input} />)
    expect(screen.getAllByRole('group', { name: 'Roles' })).toHaveLength(1)
    expect(screen.getByText('Primary: Supervisor')).toBeInTheDocument()
    expect(screen.getByText('1 additional role assigned.')).toBeInTheDocument()
    openRoles()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Make Guard the primary workforce role' })).toBeEnabled()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'human' } })
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '555-0100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    const payload = input.onSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({ role: 'supervisor', mobilePhone: '555-0100', accessRoleIds: undefined })
    await updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })
    expect(rpc).toHaveBeenCalledWith('admin_update_employee_with_time_zone', expect.not.objectContaining({ target_access_role_ids: expect.anything() }))
  })

  it('uses the actual Make primary action for Guard to Supervisor and excludes both primary memberships', async () => {
    const guardEmployee = { ...employeeRoleTestUser, role: 'guard' as const }
    const input = props({ employee: guardEmployee, assignedAccessRoleIds: ['admin-role', 'hr-manager-role'] })
    render(<EmployeeForm {...input} />)
    openRoles()

    expect(screen.getByRole('checkbox', { name: 'Guard' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Make Supervisor the primary workforce role' }))
    expect(screen.getByRole('checkbox', { name: 'Guard' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Admin' })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    confirmRoleChange('Promote guard to supervisor.')
    const payload = input.onSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({ role: 'supervisor', accessRoleIds: ['admin-role', 'hr-manager-role'] })
    expect(payload.accessRoleIds).not.toContain('guard-role')
    expect(payload.accessRoleIds).not.toContain('super-role')

    await updateEmployee({ ...payload, employeeId: guardEmployee.id })
    expect(rpc).toHaveBeenCalledWith('admin_update_employee_with_time_zone_and_access_roles', expect.objectContaining({
      target_access_role_ids: ['admin-role', 'hr-manager-role'],
      target_role: 'supervisor',
    }))
  })

  it('uses the actual Make primary action for Supervisor to Guard without dropping unrelated additions', async () => {
    const input = props({ assignedAccessRoleIds: ['admin-role', 'ops-role'] })
    render(<EmployeeForm {...input} />)
    openRoles()

    fireEvent.click(screen.getByRole('button', { name: 'Make Guard the primary workforce role' }))
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.getByText('Save before adding as extra')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make Supervisor the primary workforce role' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    const review = screen.getByRole('dialog', { name: 'Review role changes' })
    expect(within(review).getByRole('region', { name: 'Roles to add' })).toHaveTextContent('Guard')
    expect(within(review).getByRole('region', { name: 'Roles to remove' })).toHaveTextContent('Supervisor')
    confirmRoleChange('Return supervisor to guard.')

    const payload = input.onSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({ role: 'guard', accessRoleIds: ['admin-role', 'ops-role'] })
    expect(payload.accessRoleIds).not.toContain('super-role')
    expect(payload.accessRoleIds).not.toContain('guard-role')
    await updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })
    expect(rpc).toHaveBeenCalledWith('admin_update_employee_with_time_zone_and_access_roles', expect.objectContaining({
      target_access_role_ids: ['admin-role', 'ops-role'],
      target_role: 'guard',
    }))
  })

  it('reviews custom additions and removals and atomically saves the final selection', async () => {
    const input = props()
    render(<EmployeeForm {...input} />)
    openRoles()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Human Resources Manager' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Operations Manager' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    const review = screen.getByRole('dialog', { name: 'Review role changes' })
    expect(within(review).getByRole('region', { name: 'Roles to add' })).toHaveTextContent('Operations Manager')
    expect(within(review).getByRole('region', { name: 'Roles to remove' })).toHaveTextContent('Human Resources Manager')
    confirmRoleChange('Adjust additional operational access.')
    const payload = input.onSubmit.mock.calls[0][0]
    await updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })
    expect(rpc).toHaveBeenCalledWith('admin_update_employee_with_time_zone_and_access_roles', expect.objectContaining({ target_role: 'supervisor', target_access_role_ids: ['ops-role'] }))
  })

  it('keeps profile edits and role transitions in separate audited saves', () => {
    const input = props()
    render(<EmployeeForm {...input} />)
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '555-0199' } })
    openRoles()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Operations Manager' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Save profile detail changes first')
    expect(screen.queryByRole('dialog', { name: 'Review role changes' })).not.toBeInTheDocument()
    expect(input.onSubmit).not.toHaveBeenCalled()
  })

  it('keeps role assignments fully read-only for profile-only editors', () => {
    const input = props({ canEditAdminRole: false, accessRoles: [], accessRolesReady: false })
    render(<EmployeeForm {...input} />)
    openRoles()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: 'Guard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Make .* primary workforce role/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    expect(input.onSubmit.mock.calls[0][0]).toMatchObject({ role: 'supervisor', accessRoleIds: undefined })
  })

  it('shows assigned custom roles to roles.view-only User Accounts viewers without enabling changes', () => {
    const input = props({ canEditAdminRole: false, canEditBasic: false, canViewAdminRoles: true })
    render(<EmployeeForm {...input} />)
    openRoles()

    expect(screen.getByRole('searchbox', { name: 'Search roles' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Make .* primary workforce role/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save employee' })).toBeDisabled()
  })

  it('allows a roles.manage-only actor to promote or demote without enabling profile fields', () => {
    const input = props({ canEditAdminRole: true, canEditBasic: false })
    render(<EmployeeForm {...input} />)

    expect(screen.getByLabelText('Mobile phone')).toBeDisabled()
    openRoles()
    fireEvent.click(screen.getByRole('button', { name: 'Make Guard the primary workforce role' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    confirmRoleChange('Approved role-only demotion.')

    expect(input.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      accessRoleIds: ['hr-manager-role'],
      firstName: employeeRoleTestUser.firstName,
      role: 'guard',
      status: employeeRoleTestUser.status,
      timeZone: employeeRoleTestUser.timeZone,
    }), 'Approved role-only demotion.')
  })

  it('preserves additive Admin access but locks Admin controls for non-primary-Admin actors', () => {
    const input = props({ actorIsPrimaryAdmin: false, assignedAccessRoleIds: ['admin-role', 'hr-manager-role'] })
    render(<EmployeeForm {...input} />)
    openRoles()

    expect(screen.getByRole('checkbox', { name: 'Admin' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Admin' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Make Admin the primary workforce role' })).toBeDisabled()
    expect(screen.getByText('Primary Admin only')).toHaveAttribute('title', expect.stringContaining('primary workforce role is Admin'))
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeEnabled()
  })

  it('keeps a primary Admin employee profile read-only for a non-primary-Admin role manager', () => {
    const input = props({
      actorIsPrimaryAdmin: false,
      employee: { ...employeeRoleTestUser, role: 'admin' } as AdminUser,
    })
    render(<EmployeeForm {...input} />)

    expect(screen.getByLabelText('First name')).toBeDisabled()
    expect(screen.getByLabelText('Status')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save employee' })).toBeDisabled()
    openRoles()
    expect(screen.getByText(/primary Admin role is read-only/)).toBeInTheDocument()
  })

  it('keeps a manager’s own role assignments read-only while allowing unrelated profile edits', () => {
    const input = props({ actorEmployeeId: employeeRoleTestUser.id })
    render(<EmployeeForm {...input} />)
    openRoles()

    expect(screen.getByText(/Your own role assignments are read-only/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /primary workforce role/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '555-0111' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    expect(input.onSubmit.mock.calls[0][0]).toMatchObject({ mobilePhone: '555-0111', accessRoleIds: undefined })
  })

  it('allows profile saves during catalog failure and disables role mutation', () => {
    const input = props({ accessRoles: [], accessRolesReady: false })
    render(<EmployeeForm {...input} />)
    openRoles()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    expect(input.onSubmit.mock.calls[0][0].accessRoleIds).toBeUndefined()
  })

  it('does not permit edits or duplicate submissions while saving', () => {
    const input = props({ pending: true })
    render(<EmployeeForm {...input} />)
    openRoles()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.getByLabelText('Mobile phone')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  })

  it('creates employees with the same complete selection and preserves server denials', async () => {
    const input = props({ employee: undefined, assignedAccessRoleIds: [] })
    render(<EmployeeForm {...input} />)
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sample' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Employee' } })
    fireEvent.change(screen.getByLabelText('Employee time zone'), { target: { value: 'America/New_York' } })
    openRoles()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Human Resources Employee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }))
    expect(screen.queryByLabelText('Required audit reason')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save employee' }))
    const payload = input.onSubmit.mock.calls[0][0]
    await createEmployee(payload)
    expect(rpc).toHaveBeenCalledWith('admin_create_employee_with_time_zone_and_access_roles', expect.objectContaining({ target_role: 'guard', target_time_zone: 'America/New_York', target_access_role_ids: ['hr-role'] }))
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Only an Admin can manage access roles.' } })
    await expect(updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })).rejects.toThrow('Only an Admin')
  })
})

const permission = (code: string, name: string): PermissionDefinition => ({
  active: true,
  category: 'Operations',
  code,
  description: `${name} access.`,
  locked: false,
  name,
  requiresMfa: false,
  riskLevel: 'standard',
})

const workspaceRoles: AccessRoleDefinition[] = [
  {
    ...employeeRoleFixtures[0],
    id: '20000000-0000-4000-8000-000000000001',
    code: 'system_guard',
    permissionCodes: ['time.view'],
  },
  {
    ...employeeRoleFixtures[1],
    id: '20000000-0000-4000-8000-000000000002',
    code: 'system_supervisor',
    permissionCodes: ['team.view', 'shared.grant'],
  },
  {
    ...employeeRoleFixtures[6],
    id: '20000000-0000-4000-8000-000000000003',
    code: 'human_resources_employee',
    permissionCodes: ['hr.view'],
  },
  {
    ...employeeRoleFixtures[2],
    id: '20000000-0000-4000-8000-000000000004',
    code: 'system_admin',
    permissionCodes: ['admin.view'],
  },
]

const workspaceUser: AccessControlUser = {
  assignedRoleIds: ['20000000-0000-4000-8000-000000000003'],
  displayName: 'Sample Employee',
  effectivePermissionCodes: ['time.view', 'hr.view', 'shared.grant'],
  id: employeeRoleTestUser.id,
  jobTitle: 'Guard',
  overrides: [{
    createdAt: '2026-09-30T12:00:00.000Z',
    effect: 'grant',
    id: '30000000-0000-4000-8000-000000000001',
    permissionCode: 'shared.grant',
    reason: 'Existing direct grant.',
  }],
  primaryRole: 'guard',
  status: 'active',
  username: 'sample.employee',
}

const workspacePermissions = [
  permission('time.view', 'View time'),
  permission('team.view', 'View team'),
  permission('hr.view', 'View HR'),
  permission('shared.grant', 'Shared direct grant'),
]

function renderAccessWorkspace(user: AccessControlUser = workspaceUser, actor: { employeeId: string; primaryAdmin: boolean } = {
  employeeId: '90000000-0000-4000-8000-000000000001',
  primaryAdmin: true,
}, canManageAccess = true) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  return {
    ...render(
    <QueryClientProvider client={queryClient}>
      <EmployeeAccessWorkspace
        actorEmployeeId={actor.employeeId}
        actorIsPrimaryAdmin={actor.primaryAdmin}
        canManageAccess={canManageAccess}
        onDirtyChange={vi.fn()}
        onSelectUser={vi.fn()}
        permissions={workspacePermissions}
        roles={workspaceRoles}
        selectedUserId={user.id}
        users={[user]}
      />
    </QueryClientProvider>,
    ),
    queryClient,
  }
}

function WorkspaceSelectionHarness({ onDirtyChange, permissions = workspacePermissions, users }: {
  onDirtyChange: (dirty: boolean) => void
  permissions?: PermissionDefinition[]
  users: AccessControlUser[]
}) {
  const [selectedUserId, setSelectedUserId] = useState(users[0]?.id ?? '')
  return (
    <EmployeeAccessWorkspace
      actorEmployeeId="90000000-0000-4000-8000-000000000001"
      actorIsPrimaryAdmin
      canManageAccess
      onDirtyChange={onDirtyChange}
      onSelectUser={setSelectedUserId}
      permissions={permissions}
      roles={workspaceRoles}
      selectedUserId={selectedUserId}
      users={users}
    />
  )
}

describe('employee permissions workspace role contract', () => {
  it('switches employees with isolated editor state while preserving the directory search', async () => {
    const guardEmployee: AccessControlUser = {
      ...workspaceUser,
      displayName: 'Danny Dallash',
      id: '10000000-0000-4000-8000-000000000002',
      username: 'danny.dallash',
    }
    const recruitingEmployee: AccessControlUser = {
      ...workspaceUser,
      assignedRoleIds: [
        '20000000-0000-4000-8000-000000000003',
        '20000000-0000-4000-8000-000000000004',
      ],
      displayName: 'Zach Ward',
      id: '10000000-0000-4000-8000-000000000003',
      overrides: [{
        createdAt: '2026-09-30T12:05:00.000Z',
        effect: 'grant',
        id: '30000000-0000-4000-8000-000000000002',
        permissionCode: 'team.view',
        reason: 'Existing Zach-specific access.',
      }],
      primaryRole: 'recruiting_licensing',
      username: 'zward',
    }
    const sensitivePermissions: PermissionDefinition[] = workspacePermissions.map((entry) => (
      entry.code === 'team.view' ? { ...entry, riskLevel: 'sensitive' } : entry
    ))
    const onDirtyChange = vi.fn()
    const confirmDiscard = vi.spyOn(window, 'confirm').mockReturnValue(true)
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Danny access save failed.' } })
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSelectionHarness onDirtyChange={onDirtyChange} permissions={sensitivePermissions} users={[guardEmployee, recruitingEmployee]} />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Guard', { selector: '.access-summary-strip strong' })).toBeInTheDocument()
    const employeeEditor = container.querySelector('.access-employee-editor')
    expect(employeeEditor).not.toBeNull()
    const directorySearch = screen.getByPlaceholderText('Search name, username, role, or title')
    const directoryList = screen.getByLabelText('Employee search results')
    directoryList.scrollTop = 64
    fireEvent.change(directorySearch, { target: { value: 'active' } })
    fireEvent.click(screen.getByRole('button', { name: /Operations.*available/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add View team' }))
    fireEvent.change(screen.getByPlaceholderText('Why is this access changing?'), { target: { value: 'Temporary sensitive access.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save employee permissions' }))
    expect(screen.getByRole('dialog', { name: 'Confirm sensitive access' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Danny access save failed.'))

    onDirtyChange.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /Zach Ward/ }))

    expect(confirmDiscard).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'Confirm sensitive access' })).not.toBeInTheDocument()
    expect(screen.queryByText('Danny access save failed.')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search name, username, role, or title')).toBe(directorySearch)
    expect(screen.getByLabelText('Employee search results')).toBe(directoryList)
    expect(container.querySelector('.access-employee-editor')).not.toBe(employeeEditor)
    expect(directorySearch).toHaveValue('active')
    expect(directoryList.scrollTop).toBe(64)
    const summary = screen.getByLabelText('Employee access summary')
    expect(within(summary).getByText('Recruiting & Licensing')).toBeInTheDocument()
    expect(within(summary).getByText('Additional role memberships').previousElementSibling).toHaveTextContent('2')
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.queryByText(/unsaved changes?/)).not.toBeInTheDocument()
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
    confirmDiscard.mockRestore()
  })

  it('saves primary role, additive memberships, and preserved direct grants through the unified RPC', async () => {
    const updatedUser = { ...workspaceUser, primaryRole: 'supervisor' as const }
    const center: AccessControlCenter = {
      generatedAt: '2026-09-30T12:30:00.000Z',
      permissions: workspacePermissions,
      roles: workspaceRoles,
      users: [updatedUser],
    }
    rpc.mockResolvedValueOnce({ data: center, error: null })
    const { queryClient } = renderAccessWorkspace()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    fireEvent.click(screen.getByRole('button', { name: 'Manage roles' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make Supervisor the primary workforce role' }))
    fireEvent.change(screen.getByPlaceholderText('Why is this access changing?'), { target: { value: 'Promote to supervisor.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save employee permissions' }))

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('set_employee_access_profile_with_primary_role', {
      target_employee_id: workspaceUser.id,
      target_permission_codes: ['shared.grant'],
      target_primary_role: 'supervisor',
      target_reason: 'Promote to supervisor.',
      target_role_ids: ['20000000-0000-4000-8000-000000000003'],
    }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-user-directory'], refetchType: 'active' })
  })

  it('shows separated employees for audit while keeping assignments read-only', () => {
    renderAccessWorkspace({ ...workspaceUser, status: 'separated' })
    expect(screen.getByText('Separated')).toBeInTheDocument()
    expect(screen.getByText(/Separated employee access is read-only/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View roles' }))
    expect(screen.getByRole('checkbox', { name: 'Guard' })).toBeDisabled()
  })

  it('keeps the actor’s own employee-access profile entirely read-only', () => {
    renderAccessWorkspace(workspaceUser, { employeeId: workspaceUser.id, primaryAdmin: true })
    expect(screen.getByText(/Your own access is read-only here/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View roles' }))
    expect(screen.getByRole('checkbox', { name: 'Human Resources Employee' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /primary workforce role/ })).not.toBeInTheDocument()
  })

  it('keeps a primary-Admin target read-only for a non-primary-Admin actor', () => {
    const adminTarget = { ...workspaceUser, primaryRole: 'admin' as const }
    renderAccessWorkspace(adminTarget, { employeeId: '90000000-0000-4000-8000-000000000001', primaryAdmin: false })
    expect(screen.getByText(/primary Admin account is read-only/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View roles' }))
    expect(screen.getByRole('checkbox', { name: 'Admin' })).toBeDisabled()
  })

  it('keeps employee roles and direct additions read-only for a view-only actor', () => {
    renderAccessWorkspace(workspaceUser, {
      employeeId: '90000000-0000-4000-8000-000000000001',
      primaryAdmin: false,
    }, false)

    expect(screen.getByText(/You have view-only access/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View roles' }))
    expect(screen.getByRole('checkbox', { name: 'Human Resources Employee' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Operations.*available/ }))
    expect(screen.getByRole('checkbox', { name: 'Add View team' })).toBeDisabled()
  })
})

describe('role permission viewer boundary', () => {
  it('allows role browsing but disables every mutation control for roles.view-only actors', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    const role = workspaceRoles.find((candidate) => candidate.baseAppRole === 'guard')!
    render(
      <QueryClientProvider client={queryClient}>
        <RolePermissionEditor canManage={false} onDirtyChange={vi.fn()} permissions={workspacePermissions} role={role} />
      </QueryClientProvider>,
    )

    expect(screen.getByText(/You have view-only access/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Basic Home/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Operations Home/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Operations.*enabled/ }))
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /View time/ })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save role permissions' })).not.toBeInTheDocument()
  })
})

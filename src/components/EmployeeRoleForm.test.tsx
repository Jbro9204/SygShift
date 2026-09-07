import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { EmployeeForm } from '../pages/UserAdminPage'
import { employeeRoleFixtures, employeeRoleTestUser } from '../test/employeeRoleFixtures'
import { createEmployee, updateEmployee, type EmployeeMutationInput } from '../data/adminUsers'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))
beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: employeeRoleTestUser, error: null })
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})
const props = () => ({
  accessRoles: employeeRoleFixtures, accessRolesReady: true, assignedAccessRoleIds: ['hr-manager-role'],
  canEditAdminRole: true, canEditBasic: true, canSeparate: true, employee: employeeRoleTestUser,
  onCancel: vi.fn(), onSubmit: vi.fn<(payload: EmployeeMutationInput) => void>(), onDirty: vi.fn(), pending: false,
})

describe('actual employee role form and RPC serialization', () => {
  it('shows one searchable list and saves phone edits without touching memberships', async () => {
    const input = props()
    render(<EmployeeForm {...input} />)
    expect(screen.getAllByRole('group', { name: 'Roles' })).toHaveLength(1)
    expect(screen.queryByText('Workforce role')).not.toBeInTheDocument()
    expect(screen.queryByText('Add specialized access')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeChecked()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'human' } })
    expect(input.onDirty).not.toHaveBeenCalled()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '555-0100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    const payload = input.onSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({ role: 'supervisor', mobilePhone: '555-0100', accessRoleIds: undefined })
    await updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })
    expect(rpc).toHaveBeenCalledWith('admin_update_employee_with_time_zone', expect.not.objectContaining({ target_access_role_ids: expect.anything() }))
  })
  it('reviews additions and removals, supports cancel, and atomically saves the final selection', async () => {
    const input = props()
    render(<EmployeeForm {...input} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Human Resources Manager' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Operations Manager' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    const review = screen.getByRole('dialog', { name: 'Review role changes' })
    expect(within(review).getByRole('region', { name: 'Roles to add' })).toHaveTextContent('Operations Manager')
    expect(within(review).getByRole('region', { name: 'Roles to remove' })).toHaveTextContent('Human Resources Manager')
    expect(input.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(within(review).getByRole('button', { name: 'Back to editing' }))
    expect(input.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save employee' }))
    const payload = input.onSubmit.mock.calls[0][0]
    await updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })
    expect(rpc).toHaveBeenCalledWith('admin_update_employee_with_time_zone_and_access_roles', expect.objectContaining({ target_role: 'supervisor', target_access_role_ids: ['ops-role'] }))
  })
  it('blocks an empty or department-only selection instead of inventing inherited access', () => {
    const input = props()
    render(<EmployeeForm {...input} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Supervisor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Keep one scheduling role')
    expect(input.onSubmit).not.toHaveBeenCalled()
  })
  it('allows safe profile saves during catalog failure and never submits role IDs', () => {
    const input = { ...props(), accessRoles: [], accessRolesReady: false }
    render(<EmployeeForm {...input} />)
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    expect(input.onSubmit.mock.calls[0][0].accessRoleIds).toBeUndefined()
  })
  it('loads late-arriving role data without dirtying or losing unrelated profile edits', () => {
    const input = props()
    const view = render(<EmployeeForm {...input} accessRoles={[]} accessRolesReady={false} />)
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '555-0123' } })
    view.rerender(<EmployeeForm {...input} />)
    expect(screen.getByRole('checkbox', { name: 'Human Resources Manager' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    expect(input.onSubmit.mock.calls[0][0]).toMatchObject({ mobilePhone: '555-0123', accessRoleIds: undefined })
  })
  it('keeps limited editors out of Admin and specialized assignments', () => {
    const input = { ...props(), canEditAdminRole: false, accessRoles: [], accessRolesReady: false }
    render(<EmployeeForm {...input} />)
    expect(screen.getByRole('checkbox', { name: 'Admin' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: 'Human Resources Manager' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Guard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save employee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save employee' }))
    expect(input.onSubmit.mock.calls[0][0]).toMatchObject({ role: 'guard', accessRoleIds: undefined })
  })
  it('does not permit edits or duplicate submissions while saving', () => {
    const input = { ...props(), pending: true }
    render(<EmployeeForm {...input} />)
    expect(screen.getByRole('checkbox', { name: 'Supervisor' })).toBeDisabled()
    expect(screen.getByLabelText('Mobile phone')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  })
  it('creates employees with the same complete selection and preserves server denials', async () => {
    const input = { ...props(), employee: undefined, assignedAccessRoleIds: [] }
    render(<EmployeeForm {...input} />)
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Sample' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Employee' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Human Resources Employee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & save employee' }))
    const payload = input.onSubmit.mock.calls[0][0]
    await createEmployee(payload)
    expect(rpc).toHaveBeenCalledWith('admin_create_employee_with_time_zone_and_access_roles', expect.objectContaining({ target_role: 'guard', target_access_role_ids: ['hr-role'] }))
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Only an Admin can manage access roles.' } })
    await expect(updateEmployee({ ...payload, employeeId: employeeRoleTestUser.id })).rejects.toThrow('Only an Admin')
  })
})

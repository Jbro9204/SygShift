export type WorkforceRole = 'guard' | 'dispatcher' | 'scheduler' | 'recruiting_licensing' | 'supervisor' | 'admin'

export interface WorkforceRoleAssignmentActor {
  permissions?: readonly string[] | null
  role?: WorkforceRole | null
}

export const workforceRoleOptions: ReadonlyArray<{ label: string; value: WorkforceRole }> = [
  { label: 'Guard', value: 'guard' },
  { label: 'Dispatcher', value: 'dispatcher' },
  { label: 'Scheduler', value: 'scheduler' },
  { label: 'Recruiting & Licensing', value: 'recruiting_licensing' },
  { label: 'Supervisor', value: 'supervisor' },
  { label: 'Admin', value: 'admin' },
]

export function canAssignWorkforceRole(actor: WorkforceRoleAssignmentActor, targetRole: WorkforceRole): boolean {
  if (targetRole === 'guard') return true
  if (!actor.permissions?.includes('admin.roles.manage')) return false
  return targetRole !== 'admin' || actor.role === 'admin'
}

export function isWorkforceRole(value: string | null | undefined): value is WorkforceRole {
  return workforceRoleOptions.some((option) => option.value === value)
}

export function initialWorkforceRoleValue(requestedRole: string | null | undefined): string {
  return requestedRole?.trim() || 'guard'
}

export function workforceRoleSelectionError(
  actor: WorkforceRoleAssignmentActor,
  selectedRole: string | null | undefined,
): string | null {
  const role = initialWorkforceRoleValue(selectedRole)
  if (!isWorkforceRole(role)) {
    return `The existing role “${role}” is not supported. Choose Guard or ask an authorized role manager to choose the correct workforce role.`
  }
  if (canAssignWorkforceRole(actor, role)) return null
  const label = workforceRoleOptions.find((option) => option.value === role)?.label ?? role
  if (role === 'admin' && actor.permissions?.includes('admin.roles.manage')) {
    return `${label} remains selected but cannot be assigned by this account. Only an employee whose primary workforce role is Admin may assign it.`
  }
  return `${label} remains selected but cannot be saved with your current access. Choose Guard or ask an authorized role manager to complete this change.`
}

export function workforceRoleAssignmentGuidance(actor: WorkforceRoleAssignmentActor): string | null {
  if (!actor.permissions?.includes('admin.roles.manage')) {
    return 'Guard is available here. Assigning another workforce role requires Manage roles permission.'
  }
  if (actor.role !== 'admin') {
    return 'Admin can only be assigned by an employee whose primary workforce role is Admin.'
  }
  return null
}

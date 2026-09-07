import type { AccessRoleDefinition } from '../data/accessControl'
import type { AppRole } from '../data/adminUsers'

export const employeeRoleLabels: Record<AppRole, string> = {
  admin: 'Admin', dispatcher: 'Dispatcher', guard: 'Guard',
  recruiting_licensing: 'Recruiting & Licensing', scheduler: 'Scheduler', supervisor: 'Supervisor',
}

export type EmployeeRoleOption = Pick<AccessRoleDefinition,
  'id' | 'name' | 'description' | 'baseAppRole' | 'systemRole' | 'active' | 'mfaRequired'> & { unavailable?: boolean }

export interface EmployeeRoleDraft {
  ids: string[]
  primaryRole: AppRole | null
}

// The single visible list is the union of the inherited role and explicit memberships.
// Keep their existing storage contract; this UI must not change authorization rules.
export function employeeRoleOptions(
  roles: AccessRoleDefinition[], primaryRole: AppRole, assignedIds: string[], canManage: boolean,
): EmployeeRoleOption[] {
  const options: EmployeeRoleOption[] = canManage ? [...roles] : []
  for (const [base, name] of Object.entries(employeeRoleLabels)) {
    const baseAppRole = base as AppRole
    if (!options.some((role) => role.systemRole && role.baseAppRole === baseAppRole)
      && (!canManage || baseAppRole === primaryRole)) {
      options.push({ id: `system:${baseAppRole}`, name, baseAppRole, systemRole: true,
        active: !canManage, unavailable: canManage, mfaRequired: baseAppRole !== 'guard', description: null })
    }
  }
  if (canManage) {
    for (const id of assignedIds) {
      if (!options.some((role) => role.id === id)) {
        options.push({ id, name: 'Unavailable assigned role', description: 'Existing assignment retained. Remove only after reviewing it in Roles & Permissions.',
          baseAppRole: null, systemRole: false, active: false, unavailable: true, mfaRequired: false })
      }
    }
  }
  return options.filter((role) => role.active || assignedIds.includes(role.id)
    || (role.systemRole && role.baseAppRole === primaryRole))
}

export function initialEmployeeRoles(options: EmployeeRoleOption[], primaryRole: AppRole, assignedIds: string[]): EmployeeRoleDraft {
  const primary = options.find((role) => role.systemRole && role.baseAppRole === primaryRole)
  return { primaryRole, ids: [...new Set([...assignedIds, ...(primary ? [primary.id] : [])])] }
}

export function toggleEmployeeRole(draft: EmployeeRoleDraft, option: EmployeeRoleOption,
  options: EmployeeRoleOption[], canManage: boolean): EmployeeRoleDraft {
  if (!canManage) {
    // Limited profile editors retain their existing single operational-role authority.
    if (!option.systemRole || !option.baseAppRole || option.baseAppRole === 'admin') return draft
    return { primaryRole: option.baseAppRole, ids: [option.id] }
  }
  const ids = draft.ids.includes(option.id) ? draft.ids.filter((id) => id !== option.id) : [...draft.ids, option.id]
  const operationalRoles = options.filter((role) => ids.includes(role.id) && role.systemRole && role.baseAppRole)
  const primaryRole = operationalRoles.some((role) => role.baseAppRole === draft.primaryRole)
    ? draft.primaryRole
    : operationalRoles[0]?.baseAppRole ?? null
  return { ids, primaryRole }
}

export function employeeRoleChange(initial: EmployeeRoleDraft, draft: EmployeeRoleDraft,
  options: EmployeeRoleOption[], canManage: boolean) {
  const added = options.filter((role) => draft.ids.includes(role.id) && !initial.ids.includes(role.id))
  const removed = options.filter((role) => initial.ids.includes(role.id) && !draft.ids.includes(role.id))
  const changed = initial.primaryRole !== draft.primaryRole
    || initial.ids.some((id) => !draft.ids.includes(id)) || draft.ids.some((id) => !initial.ids.includes(id))
  let error: string | null = null
  if (changed && !draft.primaryRole) {
    error = 'Keep one scheduling role selected, such as Guard or Supervisor. Department roles can be selected alongside it in this same list.'
  } else if (changed && canManage && draft.ids.some((id) => {
    const role = options.find((option) => option.id === id)
    return !role || !role.active || role.unavailable
  })) {
    error = 'An unavailable role is still selected. Review and remove that assignment before changing roles, or cancel the role changes to keep existing access.'
  }
  const primary = options.find((role) => role.systemRole && role.baseAppRole === draft.primaryRole)
  return {
    changed, added, removed, error,
    // Omit memberships on no-op/profile-only saves. Even legacy redundant assignments stay intact.
    accessRoleIds: changed && canManage ? draft.ids.filter((id) => id !== primary?.id) : undefined,
    mfaRequired: options.some((role) => draft.ids.includes(role.id) && role.mfaRequired),
  }
}

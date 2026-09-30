import type { AccessRoleDefinition } from '../data/accessControl'
import type { AppRole } from '../data/adminUsers'
import { workforceRoleLabels } from './workforceRoleAssignment'

export const employeeRoleLabels: Record<AppRole, string> = workforceRoleLabels

export type EmployeeRoleOption = Pick<AccessRoleDefinition,
  'id' | 'name' | 'description' | 'baseAppRole' | 'systemRole' | 'active' | 'mfaRequired'> & { unavailable?: boolean }

export interface EmployeeRoleDraft {
  ids: string[]
  primaryRole: AppRole | null
}

export function employeeAdditionalRoleIds(draft: EmployeeRoleDraft, options: EmployeeRoleOption[]): string[] {
  const primary = options.find((role) => role.systemRole && role.baseAppRole === draft.primaryRole)
  return draft.ids.filter((id) => id !== primary?.id)
}

// The visible list combines the one primary workforce role with explicit, additive access roles.
export function employeeRoleOptions(
  roles: AccessRoleDefinition[], primaryRole: AppRole, assignedIds: string[], canManage: boolean,
): EmployeeRoleOption[] {
  const options: EmployeeRoleOption[] = canManage ? [...roles] : []
  for (const [base, name] of Object.entries(employeeRoleLabels)) {
    const baseAppRole = base as AppRole
    if (!options.some((role) => role.systemRole && role.baseAppRole === baseAppRole)
      && baseAppRole === primaryRole) {
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
  const additionalIds = employeeAdditionalRoleIds({ primaryRole, ids: assignedIds }, options)
  return { primaryRole, ids: [...new Set([...(primary ? [primary.id] : []), ...additionalIds])] }
}

export function makeEmployeeRolePrimary(draft: EmployeeRoleDraft, option: EmployeeRoleOption,
  options: EmployeeRoleOption[], canManage: boolean): EmployeeRoleDraft {
  if (!canManage || !option.systemRole || !option.baseAppRole || !option.active || option.unavailable) return draft
  const oldPrimary = options.find((role) => role.systemRole && role.baseAppRole === draft.primaryRole)
  const retainedIds = draft.ids.filter((id) => id !== oldPrimary?.id && id !== option.id)
  return {
    primaryRole: option.baseAppRole,
    ids: [option.id, ...retainedIds],
  }
}

export function toggleEmployeeRole(draft: EmployeeRoleDraft, option: EmployeeRoleOption,
  _options: EmployeeRoleOption[], canManage: boolean): EmployeeRoleDraft {
  if (!canManage) return draft
  if (option.systemRole && option.baseAppRole === draft.primaryRole) return draft
  if ((!option.active || option.unavailable) && !draft.ids.includes(option.id)) return draft
  const ids = draft.ids.includes(option.id) ? draft.ids.filter((id) => id !== option.id) : [...draft.ids, option.id]
  return { ids, primaryRole: draft.primaryRole }
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
    if (initial.ids.includes(id)) return false
    const role = options.find((option) => option.id === id)
    return !role || !role.active || role.unavailable
  })) {
    error = 'An unavailable role cannot be newly assigned. Refresh the role library or choose an active role.'
  }
  return {
    changed, added, removed, error,
    // Primary workforce roles live on employees.role, never in additive role memberships.
    // Omit memberships on no-op/profile-only saves so unrelated profile edits stay isolated.
    accessRoleIds: changed && canManage ? employeeAdditionalRoleIds(draft, options) : undefined,
    mfaRequired: options.some((role) => draft.ids.includes(role.id) && role.mfaRequired),
  }
}

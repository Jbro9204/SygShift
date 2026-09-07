import { describe, expect, it } from 'vitest'
import { employeeRoleFixtures as roles } from '../test/employeeRoleFixtures'
import { employeeRoleChange, employeeRoleOptions, initialEmployeeRoles, toggleEmployeeRole } from './employeeRoleSelection'

const options = employeeRoleOptions(roles, 'supervisor', ['hr-manager-role'], true)
const initial = initialEmployeeRoles(options, 'supervisor', ['hr-manager-role'])
const option = (id: string) => options.find((role) => role.id === id)!

describe('unified employee role assignments', () => {
  it('includes each inherited and explicit role once, with the complete active library', () => {
    expect(options).toHaveLength(9)
    expect(initialEmployeeRoles(options, 'supervisor', ['super-role', 'super-role', 'hr-manager-role']).ids.sort())
      .toEqual(['hr-manager-role', 'super-role'])
  })
  it('does not write memberships on unchanged profiles, including redundant legacy memberships', () => {
    expect(employeeRoleChange(initial, initial, options, true).accessRoleIds).toBeUndefined()
    const legacy = initialEmployeeRoles(options, 'supervisor', ['super-role', 'hr-manager-role'])
    expect(employeeRoleChange(legacy, legacy, options, true).changed).toBe(false)
  })
  it('adds access without removing the inherited role or other explicit roles', () => {
    const next = toggleEmployeeRole(initial, option('ops-role'), options, true)
    expect(next.primaryRole).toBe('supervisor')
    expect(employeeRoleChange(initial, next, options, true).accessRoleIds).toEqual(['hr-manager-role', 'ops-role'])
  })
  it('removes all additional access with an explicit empty array, not a no-op', () => {
    const next = toggleEmployeeRole(initial, option('hr-manager-role'), options, true)
    expect(employeeRoleChange(initial, next, options, true).accessRoleIds).toEqual([])
  })
  it('preserves additional built-in assignments, then deliberately transfers scheduling default', () => {
    const added = toggleEmployeeRole(initial, option('guard-role'), options, true)
    expect(added.primaryRole).toBe('supervisor')
    const replacement = toggleEmployeeRole(added, option('super-role'), options, true)
    const change = employeeRoleChange(initial, replacement, options, true)
    expect(replacement.primaryRole).toBe('guard')
    expect(change.accessRoleIds).toEqual(['hr-manager-role'])
    expect(change.removed.map((role) => role.name)).toEqual(['Supervisor'])
  })
  it('never silently supplies a hidden guard role for a department-only selection', () => {
    const next = toggleEmployeeRole(initial, option('super-role'), options, true)
    expect(next.primaryRole).toBeNull()
    expect(employeeRoleChange(initial, next, options, true).error).toContain('Keep one scheduling role')
  })
  it('cancels a role edit without normalizing existing assignments', () => {
    const added = toggleEmployeeRole(initial, option('ops-role'), options, true)
    const undone = toggleEmployeeRole(added, option('ops-role'), options, true)
    expect(employeeRoleChange(initial, undone, options, true).accessRoleIds).toBeUndefined()
  })
  it('preserves unknown or inactive assignments on unrelated saves but blocks silent removal during role edits', () => {
    const unavailable = employeeRoleOptions(roles.map((role) => role.id === 'hr-manager-role' ? { ...role, active: false } : role),
      'supervisor', ['hr-manager-role', 'missing-role'], true)
    const original = initialEmployeeRoles(unavailable, 'supervisor', ['hr-manager-role', 'missing-role'])
    expect(employeeRoleChange(original, original, unavailable, true).error).toBeNull()
    expect(employeeRoleChange(original, original, unavailable, true).accessRoleIds).toBeUndefined()
    const edited = toggleEmployeeRole(original, option('ops-role'), unavailable, true)
    expect(employeeRoleChange(original, edited, unavailable, true).error).toContain('unavailable role')
  })
  it('retains the authorization boundary for limited editors', () => {
    const limited = employeeRoleOptions([], 'supervisor', [], false)
    const original = initialEmployeeRoles(limited, 'supervisor', [])
    const admin = limited.find((role) => role.baseAppRole === 'admin')!
    expect(toggleEmployeeRole(original, admin, limited, false)).toEqual(original)
    expect(toggleEmployeeRole(original, option('hr-role'), limited, false)).toEqual(original)
    const next = toggleEmployeeRole(original, limited.find((role) => role.baseAppRole === 'guard')!, limited, false)
    expect(next.primaryRole).toBe('guard')
    expect(employeeRoleChange(original, next, limited, false).accessRoleIds).toBeUndefined()
  })
  it('can remove an admin assignment only through an explicit reviewed selection', () => {
    const original = initialEmployeeRoles(options, 'admin', [])
    const next = toggleEmployeeRole(toggleEmployeeRole(original, option('guard-role'), options, true), option('admin-role'), options, true)
    expect(next.primaryRole).toBe('guard')
    expect(employeeRoleChange(original, next, options, true).removed.map((role) => role.name)).toEqual(['Admin'])
  })
})

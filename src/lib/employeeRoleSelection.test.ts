import { describe, expect, it } from 'vitest'
import { employeeRoleFixtures as roles } from '../test/employeeRoleFixtures'
import {
  employeeRoleChange,
  employeeRoleOptions,
  initialEmployeeRoles,
  makeEmployeeRolePrimary,
  toggleEmployeeRole,
} from './employeeRoleSelection'

type PrimaryRole = 'admin' | 'dispatcher' | 'guard' | 'recruiting_licensing' | 'scheduler' | 'supervisor'

function setup(primaryRole: PrimaryRole, assignedIds: string[] = []) {
  const options = employeeRoleOptions(roles, primaryRole, assignedIds, true)
  const initial = initialEmployeeRoles(options, primaryRole, assignedIds)
  const option = (id: string) => options.find((role) => role.id === id)!
  return { initial, option, options }
}

describe('unified employee role assignments', () => {
  it('shows one primary workforce role while preserving deliberate additional built-in and custom roles', () => {
    const { initial } = setup('supervisor', ['super-role', 'super-role', 'guard-role', 'hr-manager-role'])
    expect(initial.ids).toEqual(['super-role', 'guard-role', 'hr-manager-role'])
    expect(initial.primaryRole).toBe('supervisor')
  })

  it('does not write memberships on an unchanged profile, including a redundant primary membership', () => {
    const { initial, options } = setup('supervisor', ['super-role', 'hr-manager-role'])
    expect(employeeRoleChange(initial, initial, options, true)).toMatchObject({ changed: false, accessRoleIds: undefined })
  })

  it('adds and removes custom access without changing the primary workforce role', () => {
    const { initial, option, options } = setup('supervisor', ['hr-manager-role'])
    const added = toggleEmployeeRole(initial, option('ops-role'), options, true)
    expect(added.primaryRole).toBe('supervisor')
    expect(employeeRoleChange(initial, added, options, true).accessRoleIds).toEqual(['hr-manager-role', 'ops-role'])
    const removed = toggleEmployeeRole(added, option('ops-role'), options, true)
    expect(employeeRoleChange(initial, removed, options, true).accessRoleIds).toBeUndefined()
  })

  it('serializes an explicit empty array when the final additional role is removed', () => {
    const { initial, option, options } = setup('supervisor', ['hr-manager-role'])
    const next = toggleEmployeeRole(initial, option('hr-manager-role'), options, true)
    expect(employeeRoleChange(initial, next, options, true)).toMatchObject({ changed: true, accessRoleIds: [] })
  })

  it('promotes Guard to Supervisor, removes only the old primary, and preserves unrelated additions', () => {
    const { initial, option, options } = setup('guard', ['admin-role', 'hr-manager-role'])
    const next = makeEmployeeRolePrimary(initial, option('super-role'), options, true)
    const change = employeeRoleChange(initial, next, options, true)

    expect(next).toEqual({ primaryRole: 'supervisor', ids: ['super-role', 'admin-role', 'hr-manager-role'] })
    expect(change.accessRoleIds).toEqual(['admin-role', 'hr-manager-role'])
    expect(change.accessRoleIds).not.toContain('guard-role')
    expect(change.accessRoleIds).not.toContain('super-role')
  })

  it('demotes Supervisor to Guard, removes only the old primary, and preserves unrelated additions', () => {
    const { initial, option, options } = setup('supervisor', ['admin-role', 'ops-role'])
    const next = makeEmployeeRolePrimary(initial, option('guard-role'), options, true)
    const change = employeeRoleChange(initial, next, options, true)

    expect(next).toEqual({ primaryRole: 'guard', ids: ['guard-role', 'admin-role', 'ops-role'] })
    expect(change.accessRoleIds).toEqual(['admin-role', 'ops-role'])
    expect(change.accessRoleIds).not.toContain('super-role')
    expect(change.accessRoleIds).not.toContain('guard-role')
  })

  it('keeps a non-primary system role as deliberate additive access during serialization', () => {
    const { initial, option, options } = setup('supervisor', ['guard-role', 'hr-manager-role'])
    const next = toggleEmployeeRole(initial, option('ops-role'), options, true)
    expect(employeeRoleChange(initial, next, options, true).accessRoleIds)
      .toEqual(['guard-role', 'hr-manager-role', 'ops-role'])
  })

  it('does not allow the current primary checkbox to clear the required workforce role', () => {
    const { initial, option, options } = setup('supervisor', ['hr-manager-role'])
    expect(toggleEmployeeRole(initial, option('super-role'), options, true)).toEqual(initial)
  })

  it('rejects a manually malformed draft without a primary workforce role', () => {
    const { initial, options } = setup('supervisor', ['hr-manager-role'])
    expect(employeeRoleChange(initial, { ids: ['hr-manager-role'], primaryRole: null }, options, true).error)
      .toContain('Keep one scheduling role')
  })

  it('preserves unavailable assignments through active role changes but blocks re-adding one after removal', () => {
    const unavailableRoles = roles.map((role) => role.id === 'hr-manager-role' ? { ...role, active: false } : role)
    const options = employeeRoleOptions(unavailableRoles, 'supervisor', ['hr-manager-role', 'missing-role'], true)
    const initial = initialEmployeeRoles(options, 'supervisor', ['hr-manager-role', 'missing-role'])
    const unavailable = options.find((role) => role.id === 'hr-manager-role')!
    const ops = options.find((role) => role.id === 'ops-role')!

    expect(employeeRoleChange(initial, initial, options, true).accessRoleIds).toBeUndefined()
    const withoutUnavailable = { ...initial, ids: initial.ids.filter((id) => id !== unavailable.id) }
    expect(toggleEmployeeRole(withoutUnavailable, unavailable, options, true)).toEqual(withoutUnavailable)
    const edited = toggleEmployeeRole(initial, ops, options, true)
    const change = employeeRoleChange(initial, edited, options, true)
    expect(change.error).toBeNull()
    expect(change.accessRoleIds).toEqual(expect.arrayContaining(['hr-manager-role', 'missing-role', 'ops-role']))
  })

  it('keeps every role read-only for profile-only editors', () => {
    const options = employeeRoleOptions([], 'supervisor', [], false)
    const initial = initialEmployeeRoles(options, 'supervisor', [])
    const supervisor = options.find((role) => role.baseAppRole === 'supervisor')!
    const attemptedPrimary = { ...supervisor, id: 'guard-role', baseAppRole: 'guard' as const }

    expect(options.map((role) => role.baseAppRole)).toEqual(['supervisor'])
    expect(toggleEmployeeRole(initial, attemptedPrimary, options, false)).toEqual(initial)
    expect(makeEmployeeRolePrimary(initial, attemptedPrimary, options, false)).toEqual(initial)
    expect(employeeRoleChange(initial, initial, options, false).accessRoleIds).toBeUndefined()
  })
})

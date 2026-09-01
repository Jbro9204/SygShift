import { describe, expect, it } from 'vitest'
import { applyPermissionCategorySelection } from './permissionSelection'

describe('permission category selection', () => {
  it('selects the complete category without removing permissions from other categories', () => {
    const result = applyPermissionCategorySelection(
      new Set(['reports.view']),
      ['hr.people.view', 'hr.people.manage', 'hr.compensation.view'],
      true,
    )

    expect([...result].sort()).toEqual([
      'hr.compensation.view',
      'hr.people.manage',
      'hr.people.view',
      'reports.view',
    ])
  })

  it('clears the complete category without removing permissions from other categories', () => {
    const result = applyPermissionCategorySelection(
      new Set(['hr.people.view', 'hr.people.manage', 'reports.view']),
      ['hr.people.view', 'hr.people.manage'],
      false,
    )

    expect([...result]).toEqual(['reports.view'])
  })
})

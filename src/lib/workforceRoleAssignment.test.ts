import { describe, expect, it } from 'vitest'
import {
  workforceRoleLabel,
  workforceRoleLabels,
  workforceRoleOptions,
} from './workforceRoleAssignment'

describe('workforce role labels', () => {
  it('keeps one canonical label for every primary workforce role', () => {
    expect(workforceRoleLabels).toEqual({
      admin: 'Admin',
      dispatcher: 'Dispatcher',
      guard: 'Guard',
      recruiting_licensing: 'Recruiting & Licensing',
      scheduler: 'Scheduler',
      supervisor: 'Supervisor',
    })
    expect(workforceRoleOptions).toEqual([
      { label: 'Guard', value: 'guard' },
      { label: 'Dispatcher', value: 'dispatcher' },
      { label: 'Scheduler', value: 'scheduler' },
      { label: 'Recruiting & Licensing', value: 'recruiting_licensing' },
      { label: 'Supervisor', value: 'supervisor' },
      { label: 'Admin', value: 'admin' },
    ])
  })

  it('uses exact canonical labels while keeping unknown legacy values readable', () => {
    expect(workforceRoleLabel('recruiting_licensing')).toBe('Recruiting & Licensing')
    expect(workforceRoleLabel('human_resources_employee')).toBe('Human Resources Employee')
    expect(workforceRoleLabel('')).toBe('')
    expect(workforceRoleLabel(null)).toBe('')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  bindViewDateSelectionOwner,
  clearViewDateSelections,
  readViewDateSelection,
  saveViewDateSelection,
  validViewDateKey,
} from './sessionViewDateSelection'

const storageKey = 'sygshift:view-date-selections:v1'

describe('session view date selections', () => {
  beforeEach(() => window.sessionStorage.clear())

  it('keeps My Time, Schedule, and Scheduler selections independent for one employee', () => {
    bindViewDateSelectionOwner('employee-a')
    saveViewDateSelection('employee-a', 'my-time', { fromDate: '2026-08-09', throughDate: '2026-08-22' })
    saveViewDateSelection('employee-a', 'schedule', { range: 'month', weekStartsOn: '2026-08-02' })
    saveViewDateSelection('employee-a', 'scheduler', { weekStartsOn: '2026-11-01' })

    expect(readViewDateSelection('employee-a', 'my-time')).toEqual({ fromDate: '2026-08-09', throughDate: '2026-08-22' })
    expect(readViewDateSelection('employee-a', 'schedule')).toEqual({ range: 'month', weekStartsOn: '2026-08-02' })
    expect(readViewDateSelection('employee-a', 'scheduler')).toEqual({ weekStartsOn: '2026-11-01' })
  })

  it('clears the previous employee selections when the authenticated account changes', () => {
    bindViewDateSelectionOwner('employee-a')
    saveViewDateSelection('employee-a', 'schedule', { weekStartsOn: '2026-08-02' })

    bindViewDateSelectionOwner('employee-b')

    expect(readViewDateSelection('employee-a', 'schedule')).toBeNull()
    expect(readViewDateSelection('employee-b', 'schedule')).toBeNull()
  })

  it('rejects corrupt or invalid stored dates and falls back without throwing', () => {
    window.sessionStorage.setItem(storageKey, JSON.stringify({
      ownerId: 'employee-a',
      selections: { 'my-time': { fromDate: '2026-02-30', throughDate: '2026-03-14' } },
    }))

    expect(readViewDateSelection('employee-a', 'my-time')).toBeNull()
    expect(window.sessionStorage.getItem(storageKey)).toBeNull()
    expect(validViewDateKey('2026-02-30')).toBe(false)
    expect(validViewDateKey('2026-02-28')).toBe(true)
  })

  it('removes every retained surface on sign-out cleanup', () => {
    bindViewDateSelectionOwner('employee-a')
    saveViewDateSelection('employee-a', 'my-time', { fromDate: '2026-08-09', throughDate: '2026-08-22' })
    clearViewDateSelections()
    expect(window.sessionStorage.getItem(storageKey)).toBeNull()
  })
})

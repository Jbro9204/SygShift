import { describe, expect, it } from 'vitest'
import {
  alignPostNameWithShiftRequirement,
  shiftDisplayTitle,
  shiftRequirementLabel,
} from './shiftDisplay'

describe('shift display labels', () => {
  it('uses the shift requirement for generic qualification-based post names', () => {
    expect(alignPostNameWithShiftRequirement('Armed coverage', false)).toBe('Unarmed coverage')
    expect(alignPostNameWithShiftRequirement('Unarmed position', true)).toBe('Armed position')
    expect(alignPostNameWithShiftRequirement('Patrol - Armed', false)).toBe('Patrol - Unarmed')
  })

  it('preserves physical post names and event names', () => {
    expect(alignPostNameWithShiftRequirement('Front Desk', false)).toBe('Front Desk')
    expect(alignPostNameWithShiftRequirement('Armed Forces Pavilion', false)).toBe('Armed Forces Pavilion')
    expect(shiftDisplayTitle({ eventName: 'Community gala', requiresArmed: true })).toBe('Community gala')
  })

  it('selects a useful fallback and exposes an explicit requirement label', () => {
    expect(shiftDisplayTitle({ locationName: 'West entrance', requiresArmed: false })).toBe('West entrance')
    expect(shiftDisplayTitle({ requiresArmed: false }, 'Shift')).toBe('Shift')
    expect(shiftRequirementLabel(true)).toBe('Armed')
    expect(shiftRequirementLabel(false)).toBe('Unarmed')
  })
})

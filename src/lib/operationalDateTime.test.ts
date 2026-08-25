import { describe, expect, it } from 'vitest'
import {
  defaultMaintenanceWindow,
  fromOperationalDateTimeInput,
  toOperationalDateTimeInput,
} from './operationalDateTime'

describe('Mountain Time maintenance scheduling', () => {
  it('converts MDT wall time independently of the browser time zone', () => {
    expect(fromOperationalDateTimeInput('2026-08-25T14:30')).toBe('2026-08-25T20:30:00.000Z')
    expect(toOperationalDateTimeInput('2026-08-25T20:30:00.000Z')).toBe('2026-08-25T14:30')
  })

  it('converts MST wall time independently of the browser time zone', () => {
    expect(fromOperationalDateTimeInput('2026-12-25T14:30')).toBe('2026-12-25T21:30:00.000Z')
  })

  it('uses a one-hour default window aligned to a quarter hour', () => {
    expect(defaultMaintenanceWindow(new Date('2026-08-25T20:07:00.000Z'))).toEqual({
      startsAt: '2026-08-25T14:15',
      endsAt: '2026-08-25T15:15',
    })
  })
})

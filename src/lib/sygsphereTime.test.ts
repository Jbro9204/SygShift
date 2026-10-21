import { describe, expect, it } from 'vitest'
import { formatSygSphereTimestamp } from './sygsphereTime'

describe('SygSphere viewer-local timestamps', () => {
  it('uses Eastern daylight time and preserves the optional military display', () => {
    expect(formatSygSphereTimestamp('2026-07-03T18:45:00.000Z', 'America/New_York'))
      .toBe('07/03/2026 · 2:45 PM (14:45) EDT')
  })

  it('uses Eastern standard time automatically in winter', () => {
    expect(formatSygSphereTimestamp('2026-01-15T18:45:00.000Z', 'America/New_York'))
      .toBe('01/15/2026 · 1:45 PM (13:45) EST')
  })

  it('uses Mountain daylight and standard time when that is the device zone', () => {
    expect(formatSygSphereTimestamp('2026-07-03T18:45:00.000Z', 'America/Denver'))
      .toBe('07/03/2026 · 12:45 PM MDT')
    expect(formatSygSphereTimestamp('2026-01-15T18:45:00.000Z', 'America/Denver'))
      .toBe('01/15/2026 · 11:45 AM MST')
  })

  it('shows a stable fallback instead of crashing on an invalid timestamp or zone', () => {
    expect(formatSygSphereTimestamp('not-a-timestamp', 'America/New_York')).toBe('Time unavailable')
    expect(formatSygSphereTimestamp('2026-07-03T18:45:00.000Z', 'Not/A_Zone')).toBe('Time unavailable')
  })
})

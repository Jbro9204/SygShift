import { describe, expect, it } from 'vitest'
import {
  continentalUsTimeZoneLabel,
  continentalUsTimeZones,
  isContinentalUsTimeZone,
} from './usTimeZones'

describe('continental US time zones', () => {
  it('keeps the supported list explicit and ordered east to west', () => {
    expect(continentalUsTimeZones.map((option) => option.value)).toEqual([
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
    ])
  })

  it('rejects unsupported or ambiguous zones', () => {
    expect(isContinentalUsTimeZone('America/Chicago')).toBe(true)
    expect(isContinentalUsTimeZone('UTC')).toBe(false)
    expect(isContinentalUsTimeZone(null)).toBe(false)
    expect(continentalUsTimeZoneLabel('America/Chicago')).toBe('Central Time')
  })
})

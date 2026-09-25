import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserContinentalUsTimeZone,
  continentalUsTimeZoneLabel,
  continentalUsTimeZones,
  isContinentalUsTimeZone,
  personalDisplayTimeZone,
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

  it('keeps the employee profile authoritative when the device reports another supported zone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      calendar: 'gregory',
      locale: 'en-US',
      numberingSystem: 'latn',
      timeZone: 'America/Denver',
    })

    expect(browserContinentalUsTimeZone()).toBe('America/Denver')
    expect(personalDisplayTimeZone('America/New_York')).toBe('America/New_York')
  })

  it('uses the device zone only as a safe display fallback when no valid profile zone exists', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      calendar: 'gregory',
      locale: 'en-US',
      numberingSystem: 'latn',
      timeZone: 'America/Los_Angeles',
    })

    expect(personalDisplayTimeZone(null)).toBe('America/Los_Angeles')
    expect(personalDisplayTimeZone('UTC')).toBe('America/Los_Angeles')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserSystemTimeZone } from './systemTimeZone'

function resolvedTimeZone(timeZone: string) {
  return {
    calendar: 'gregory',
    locale: 'en-US',
    numberingSystem: 'latn',
    timeZone,
  }
}

describe('browser system time zone', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses the browser/device zone before a different employee-profile fallback', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue(resolvedTimeZone('America/New_York'))

    expect(browserSystemTimeZone('America/Denver')).toBe('America/New_York')
  })

  it('accepts valid system zones outside the employee-profile zone list', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue(resolvedTimeZone('America/Anchorage'))

    expect(browserSystemTimeZone('America/Denver')).toBe('America/Anchorage')
  })

  it('uses a valid fallback when the browser does not report a usable zone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue(resolvedTimeZone(''))

    expect(browserSystemTimeZone('America/Chicago')).toBe('America/Chicago')
  })

  it('falls back safely to UTC when detection fails and the supplied fallback is invalid', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(() => { throw new Error('Unavailable') })

    expect(browserSystemTimeZone('Not/A_Zone')).toBe('UTC')
  })
})

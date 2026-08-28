import { describe, expect, it } from 'vitest'
import {
  internalHref,
  isSafeInternalHref,
  parseInternalHistory,
  previousInternalLocation,
  recordInternalLocation,
} from './internalNavigation'

describe('internal navigation history', () => {
  it('builds an internal href with query and hash state', () => {
    expect(internalHref('/time/team', '?employee=abc', '#punches')).toBe('/time/team?employee=abc#punches')
  })

  it('rejects login and external-looking destinations', () => {
    expect(isSafeInternalHref('/time')).toBe(true)
    expect(isSafeInternalHref('/login')).toBe(false)
    expect(isSafeInternalHref('//example.com')).toBe(false)
  })

  it('records unique destinations and restores the prior one', () => {
    let entries = recordInternalLocation([], '/', 0)
    entries = recordInternalLocation(entries, '/time?tab=team', 240)
    const result = previousInternalLocation(entries, '/time?tab=team')

    expect(result.target).toEqual({ href: '/', scrollY: 240 })
    expect(result.entries).toEqual([])
  })

  it('ignores malformed persisted entries', () => {
    expect(parseInternalHistory('[{"href":"https://bad.test","scrollY":1},{"href":"/time","scrollY":12}]'))
      .toEqual([{ href: '/time', scrollY: 12 }])
  })
})

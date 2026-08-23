import { describe, expect, it } from 'vitest'
import { canAccessRoute, hasAnyEffectivePermission, hasEffectivePermission, routeAccessPolicies } from './accessPolicy'
import { navigationGroups } from './navigation'

const session = (permissions: string[]) => ({ permissions })

describe('central access policy', () => {
  it('allows only effective permissions and never role-name shortcuts', () => {
    expect(hasEffectivePermission(session(['schedule.view']), 'schedule.view')).toBe(true)
    expect(hasEffectivePermission(session([]), 'schedule.view')).toBe(false)
    expect(hasAnyEffectivePermission(session(['time.manage']), ['time.view', 'time.manage'])).toBe(true)
  })

  it('denies unknown and unpermitted routes', () => {
    expect(canAccessRoute('/schedule', session([]))).toBe(false)
    expect(canAccessRoute('/not-a-real-route', session(['operations.view']))).toBe(false)
  })

  it('allows account security so users can complete required security setup', () => {
    expect(canAccessRoute('/account-security', session([]))).toBe(true)
  })

  it('allows the Accountability Tracker only with an effective accountability permission', () => {
    expect(canAccessRoute('/time/accountability', session(['accountability.view']))).toBe(true)
    expect(canAccessRoute('/time/accountability', session(['accountability.manage']))).toBe(true)
    expect(canAccessRoute('/time/accountability', session(['time.manage']))).toBe(false)
  })

  it('keeps every navigation destination covered by the route policy', () => {
    const navigationPaths = navigationGroups.flatMap((group) => group.items.map((item) => item.path))
    expect(navigationPaths.every((path) => path in routeAccessPolicies)).toBe(true)
  })
})

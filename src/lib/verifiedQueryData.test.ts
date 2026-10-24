import { describe, expect, it } from 'vitest'
import { queryVerificationFailed, verifiedQueryData } from './verifiedQueryData'

describe('verified query data', () => {
  it('withholds cached data after a background refresh fails', () => {
    const cached = { canManage: true, protectedValue: 'stale' }

    expect(verifiedQueryData(cached, { isError: false, isRefetchError: true })).toBeUndefined()
    expect(queryVerificationFailed({ isError: false, isRefetchError: true })).toBe(true)
  })

  it('withholds cached data after an initial failure and returns only verified data', () => {
    const fresh = { canManage: true }

    expect(verifiedQueryData(fresh, { isError: true, isRefetchError: false })).toBeUndefined()
    expect(verifiedQueryData(fresh, { isError: false, isRefetchError: false })).toBe(fresh)
  })
})

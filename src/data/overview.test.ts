import { describe, expect, it } from 'vitest'
import { overviewMetricNote } from './overview'

describe('overview metric language', () => {
  it('uses clear language for empty live states', () => {
    expect(overviewMetricNote('openShifts', 0)).toBe('No published openings right now')
    expect(overviewMetricNote('pendingRequests', 0)).toBe('The action queue is clear')
    expect(overviewMetricNote('clockExceptions', 0)).toBe('No unresolved clock exceptions')
  })

  it('makes permission-limited counts understandable', () => {
    expect(overviewMetricNote('onDutyNow', null)).toBe('Available after sign-in permissions allow it')
  })
})

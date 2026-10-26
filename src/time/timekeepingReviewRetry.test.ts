import { describe, expect, it } from 'vitest'
import {
  isStatementTimeoutError,
  shouldRetryTimekeepingReview,
  timekeepingReviewErrorMessage,
} from './timekeepingReviewRetry'

describe('timekeeping review retry policy', () => {
  it('does not retry PostgreSQL statement cancellations identified by SQLSTATE', () => {
    const error = Object.assign(new Error('query canceled'), { code: '57014' })

    expect(isStatementTimeoutError(error)).toBe(true)
    expect(shouldRetryTimekeepingReview(0, error)).toBe(false)
  })

  it('does not retry the provider statement-timeout message when a code is absent', () => {
    const error = new Error('canceling statement due to statement timeout')

    expect(isStatementTimeoutError(error)).toBe(true)
    expect(shouldRetryTimekeepingReview(0, error)).toBe(false)
  })

  it('retains one retry for a non-timeout transient failure', () => {
    const error = new Error('Network request failed')

    expect(shouldRetryTimekeepingReview(0, error)).toBe(true)
    expect(shouldRetryTimekeepingReview(1, error)).toBe(false)
  })

  it('explains that a timed-out review did not change payroll', () => {
    const error = Object.assign(new Error('query canceled'), { code: '57014' })

    expect(timekeepingReviewErrorMessage(error)).toContain('No payroll exception was approved or changed')
  })
})

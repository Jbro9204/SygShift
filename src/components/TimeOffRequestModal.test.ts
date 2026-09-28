import { describe, expect, it } from 'vitest'
import { timeOffErrorMessage } from './timeOffErrors'

describe('timeOffErrorMessage', () => {
  it.each([
    ['An active time-off request already overlaps this time.', 'already have an active time-off request'],
    ['For a current or imminent shift, use Report Sick / Call-Off.', 'Use Report Sick / Call-Off'],
    ['MFA is required to review time-off requests.', 'Confirm your identity with MFA'],
    ['Another authorized reviewer must decide your time-off request.', 'different authorized reviewer'],
    ['Resolve assigned shifts before approving this time off.', 'Resolve the affected assigned shifts'],
    ['The time-off request is no longer pending.', 'Refresh the request'],
  ])('maps a known operational error without exposing its raw text', (raw, expected) => {
    expect(timeOffErrorMessage(new Error(`Database error: ${raw} (SQLSTATE P0001)`), 'Fallback')).toContain(expected)
  })

  it('uses the fixed fallback for an unrecognized provider or validation error', () => {
    const raw = 'PostgREST 500: relation private.employee_secret does not exist'

    expect(timeOffErrorMessage(new Error(raw), 'Nothing was changed. Try again.')).toBe('Nothing was changed. Try again.')
    expect(timeOffErrorMessage(new Error(raw), 'Nothing was changed. Try again.')).not.toContain('employee_secret')
  })
})

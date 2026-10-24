import { describe, expect, it } from 'vitest'
import { passwordChangeResultIsCurrent, type PasswordChangeResult } from './myAccount'

const result: PasswordChangeResult = {
  authUserId: '20000000-0000-4000-8000-000000000001',
  employeeId: '10000000-0000-4000-8000-000000000001',
  passwordAlreadyCurrent: false,
  saved: true,
  sessionStillCurrent: true,
}

describe('password change result ownership', () => {
  it('accepts only the current operation for the same employee and captured session', () => {
    expect(passwordChangeResultIsCurrent(
      4,
      4,
      result.employeeId,
      result.employeeId,
      result,
    )).toBe(true)

    expect(passwordChangeResultIsCurrent(
      4,
      5,
      result.employeeId,
      result.employeeId,
      result,
    )).toBe(false)
    expect(passwordChangeResultIsCurrent(
      4,
      4,
      result.employeeId,
      '10000000-0000-4000-8000-000000000002',
      result,
    )).toBe(false)
    expect(passwordChangeResultIsCurrent(
      4,
      4,
      result.employeeId,
      result.employeeId,
      { ...result, sessionStillCurrent: false },
    )).toBe(false)
  })
})

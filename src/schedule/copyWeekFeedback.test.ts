import { describe, expect, it } from 'vitest'
import { copyWeekFailureMessage } from './copyWeekFeedback'

describe('copyWeekFailureMessage', () => {
  it('turns a database timeout into plain recovery guidance', () => {
    expect(copyWeekFailureMessage(new Error('canceling statement due to statement timeout (57014)'))).toBe(
      'The copy took too long to finish safely. Nothing was changed. Try again in a moment. If it keeps happening, contact an administrator.',
    )
  })

  it('does not expose raw provider or database errors', () => {
    expect(copyWeekFailureMessage(new Error('PostgREST error: relation private.schedules is unavailable'))).toBe(
      'The schedule could not be copied. Nothing was changed. Try again in a moment. If it keeps happening, contact an administrator.',
    )
  })

  it('gives a safe refresh path when the visible source revision changed', () => {
    expect(copyWeekFailureMessage(new Error('The destination did not match the source revision.'))).toBe(
      'The schedule changed before the copy finished. Nothing was changed. Refresh the week and try again.',
    )
  })
})

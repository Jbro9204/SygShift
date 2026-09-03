import { describe, expect, it } from 'vitest'
import { scheduledOvertimePreviewBlocksSave } from './scheduleDraftEdit'

describe('draft shift scheduled-overtime preview guard', () => {
  it('allows a shift to be saved as open when the disabled preview has no data', () => {
    expect(scheduledOvertimePreviewBlocksSave('', { isPending: true, isError: false })).toBe(false)
    expect(scheduledOvertimePreviewBlocksSave(null, { isPending: false, isError: true })).toBe(false)
  })

  it('blocks an employee assignment while its overtime preview is pending or failed', () => {
    expect(scheduledOvertimePreviewBlocksSave('employee-1', { isPending: true, isError: false })).toBe(true)
    expect(scheduledOvertimePreviewBlocksSave('employee-1', { isPending: false, isError: true })).toBe(true)
  })

  it('allows an employee assignment after the overtime preview succeeds', () => {
    expect(scheduledOvertimePreviewBlocksSave('employee-1', { isPending: false, isError: false })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { pendingTimeRequestCount, timeCorrectionReviewPath } from './timeCorrectionWorkflow'

describe('time correction workflow navigation', () => {
  it('keeps the employee, active date range, and pending-correction filter together', () => {
    expect(timeCorrectionReviewPath({
      employeeId: 'f62ca89e-66fb-4d7c-bdf3-922d3b4e04a9',
      fromDate: '2026-09-06',
      throughDate: '2026-09-12',
    })).toBe('/time/review?from=2026-09-06&through=2026-09-12&show=pending_correction&employee=f62ca89e-66fb-4d7c-bdf3-922d3b4e04a9')
  })

  it('combines both supported correction request sources', () => {
    expect(pendingTimeRequestCount(3, 2)).toBe(5)
  })
})

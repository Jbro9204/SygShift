import { describe, expect, it } from 'vitest'
import { buildSygSphereCommsUsageResponse } from '../worker/comms/usageContract'

describe('SygSphere Communications usage contract', () => {
  it('never represents missing telemetry as zero usage', () => {
    const usage = buildSygSphereCommsUsageResponse({
      periodEndsAt: '2026-10-01T00:00:00.000Z',
      periodStartsAt: '2026-09-01T00:00:00.000Z',
      receivedBytes: null,
      reconciliationAsOf: null,
      telemetryStatus: 'unavailable',
    })
    expect(usage.usage.receivedBytes).toBeNull()
    expect(usage.projected.estimatedOverageUsd).toBeNull()
    expect(usage.reconciliation.status).toBe('unavailable')
  })

  it('uses decimal gigabytes and exposes an honest projected overage', () => {
    const usage = buildSygSphereCommsUsageResponse({
      periodEndsAt: '2026-10-01T00:00:00.000Z',
      periodStartsAt: '2026-09-01T00:00:00.000Z',
      receivedBytes: 1_050_000_000_000,
      reconciliationAsOf: '2026-09-19T20:00:00.000Z',
      telemetryStatus: 'reconciled',
    })
    expect(usage.usage.receivedDecimalGigabytes).toBe(1050)
    expect(usage.projected.overageGigabytes).toBe(50)
    expect(usage.projected.estimatedOverageUsd).toBe(2.5)
    expect(usage.projected.remainingAllowanceGigabytes).toBe(0)
  })
})

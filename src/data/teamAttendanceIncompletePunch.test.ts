import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTeamAttendanceSummary } from './timekeeping'

const rpc = vi.fn()

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const employeeId = '73000000-0000-4000-8000-000000000101'

const summaryPayload = {
  fromDate: '2026-10-04',
  operationalTimeZone: 'America/Denver',
  rows: [{
    breakMinutes: 0,
    employeeId,
    employeeName: 'Test Employee',
    employmentType: 'hourly',
    eventCount: 1,
    firstClockIn: '2026-10-17T02:00:00.000Z',
    lastClockOut: null,
    latestEffectiveAt: '2026-10-17T02:00:00.000Z',
    latestEventName: null,
    latestKind: 'clock_in',
    latestLocationName: 'Test Site',
    latestPostName: 'Guard',
    latestSiteCode: 'TEST',
    latestSiteName: 'Test Site',
    latestTimeZone: 'America/Denver',
    overtimeMinutes: 0,
    paidMinutes: 0,
    pendingCorrectionCount: 0,
    role: 'guard',
    scheduledEndsAt: '2026-10-18T10:00:00.000Z',
    scheduledEventName: null,
    scheduledLocationName: 'Test Site / Guard',
    scheduledMinutes: 480,
    scheduledPostName: 'Guard',
    scheduledShiftCount: 1,
    scheduledSiteCode: 'TEST',
    scheduledSiteName: 'Test Site',
    scheduledStartsAt: '2026-10-18T02:00:00.000Z',
    scheduledTimeZone: 'America/Denver',
    username: 'testemployee',
    workedSegmentCount: 0,
  }],
  serverTimestamp: '2026-10-18T18:00:00.000Z',
  throughDate: '2026-10-17',
}

function totalsPayload(incompletePunchCount?: number) {
  return {
    fromDate: '2026-10-04',
    operationalTimeZone: 'America/Denver',
    rows: [{
      breakMinutes: 0,
      employeeId,
      ...(incompletePunchCount === undefined ? {} : { incompletePunchCount }),
      overtimeMinutes: 0,
      paidMinutes: 0,
      pendingCorrectionCount: 0,
      workedSegmentCount: 0,
    }],
    serverTimestamp: '2026-10-18T18:00:00.000Z',
    throughDate: '2026-10-17',
  }
}

describe('Team Attendance incomplete-punch totals contract', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it('merges the lightweight canonical incomplete-punch count into the employee summary', async () => {
    rpc
      .mockResolvedValueOnce({ data: summaryPayload, error: null })
      .mockResolvedValueOnce({ data: totalsPayload(1), error: null })

    const result = await getTeamAttendanceSummary({
      fromDate: '2026-10-04',
      throughDate: '2026-10-17',
    })

    expect(result.rows[0]?.incompletePunchCount).toBe(1)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).not.toHaveBeenCalledWith('get_timekeeping_review', expect.anything())
  })

  it('accepts the prior totals response while leaving completeness explicitly unknown', async () => {
    rpc
      .mockResolvedValueOnce({ data: summaryPayload, error: null })
      .mockResolvedValueOnce({ data: totalsPayload(), error: null })

    const result = await getTeamAttendanceSummary({
      fromDate: '2026-10-04',
      throughDate: '2026-10-17',
    })

    expect(result.rows[0]?.incompletePunchCount).toBeUndefined()
  })
})

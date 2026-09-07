import { describe, expect, it } from 'vitest'
import type { TeamAttendanceSummaryRow } from '../data/timekeeping'
import { buildTeamRows } from './teamAttendanceRows'

function summaryRow(overrides: Partial<TeamAttendanceSummaryRow> = {}): TeamAttendanceSummaryRow {
  return {
    breakMinutes: 0,
    employeeId: 'dab8dcee-58ee-4110-9b06-d56e162edc73',
    employeeName: 'John Holliday',
    employmentType: 'hourly',
    eventCount: 0,
    firstClockIn: null,
    lastClockOut: null,
    latestEffectiveAt: null,
    latestEventName: null,
    latestKind: null,
    latestLocationName: null,
    latestPostName: null,
    latestSiteCode: null,
    latestSiteName: null,
    latestTimeZone: 'America/Denver',
    overtimeMinutes: 0,
    paidMinutes: 0,
    pendingCorrectionCount: 0,
    role: 'guard',
    scheduledEndsAt: '2026-09-06T03:30:00Z',
    scheduledEventName: null,
    scheduledLocationName: "B'Nai",
    scheduledMinutes: 210,
    scheduledPostName: 'Armed coverage',
    scheduledShiftCount: 1,
    scheduledSiteCode: 'BNOEH',
    scheduledSiteName: "B'Nai",
    scheduledStartsAt: '2026-09-06T00:00:00Z',
    scheduledTimeZone: 'America/Denver',
    username: 'jholliday',
    workedSegmentCount: 0,
    ...overrides,
  }
}

describe('Team Attendance employee visibility', () => {
  it('keeps a scheduled employee searchable when they have no time activity', () => {
    const rows = buildTeamRows([summaryRow()])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      employeeName: 'John Holliday',
      eventCount: 0,
      scheduledShiftCount: 1,
      state: 'off_clock',
    })
  })

  it('continues to omit an employee with neither schedule nor time activity', () => {
    const rows = buildTeamRows([summaryRow({ scheduledMinutes: 0, scheduledShiftCount: 0 })])

    expect(rows).toHaveLength(0)
  })
})

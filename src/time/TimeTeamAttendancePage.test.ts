import { describe, expect, it } from 'vitest'
import type { LiveTimeRosterRow, TeamAttendanceSummaryRow } from '../data/timekeeping'
import { teamAttendanceReviewState } from './teamAttendanceReviewState'
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

function liveRow(overrides: Partial<LiveTimeRosterRow> = {}): LiveTimeRosterRow {
  return {
    assignedSupervisor: null,
    clockedInAt: '2026-10-18T14:00:00Z',
    elapsedMinutes: 30,
    employeeId: 'dab8dcee-58ee-4110-9b06-d56e162edc73',
    employeeName: 'John Holliday',
    employmentType: 'hourly',
    eventName: null,
    locationName: 'NLA / Unarmed coverage',
    postName: 'Unarmed coverage',
    role: 'guard',
    scheduledEndsAt: '2026-10-18T22:00:00Z',
    siteCode: 'NLA',
    siteName: 'Neon Local Apt',
    status: 'working',
    statusSince: '2026-10-18T14:00:00Z',
    timeZone: 'America/Denver',
    username: 'jholliday',
    ...overrides,
  }
}

describe('Team Attendance employee visibility', () => {
  it('flags an incomplete punch instead of labeling the employee clean', () => {
    expect(teamAttendanceReviewState({
      hasSelectedRangeSummary: true,
      incompletePunchCount: 1,
      pendingCorrectionCount: 0,
    })).toEqual({
      label: 'Incomplete punch',
      requiresAttention: true,
      tone: 'danger',
    })
  })

  it('fails closed when an older totals response does not report punch completeness', () => {
    expect(teamAttendanceReviewState({
      hasSelectedRangeSummary: true,
      pendingCorrectionCount: 0,
    })).toEqual({
      label: 'Punch status unavailable',
      requiresAttention: true,
      tone: 'warning',
    })
  })

  it('only labels a selected-range record clean after completeness is explicitly confirmed', () => {
    expect(teamAttendanceReviewState({
      hasSelectedRangeSummary: true,
      incompletePunchCount: 0,
      pendingCorrectionCount: 0,
    })).toEqual({
      label: 'Clean',
      requiresAttention: false,
      tone: 'good',
    })
  })

  it('keeps a live-only employee distinct from a reviewed historical record', () => {
    expect(teamAttendanceReviewState({
      hasSelectedRangeSummary: false,
      pendingCorrectionCount: 0,
    })).toEqual({
      label: 'Live status only',
      requiresAttention: false,
      tone: 'neutral',
    })
  })

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

  it('does not treat a historical final-day clock-in as a current live session', () => {
    const rows = buildTeamRows([summaryRow({
      eventCount: 1,
      latestEffectiveAt: '2026-10-18T02:00:00Z',
      latestKind: 'clock_in',
      latestLocationName: 'Historical location',
    })], [])

    expect(rows[0]).toMatchObject({
      currentLocation: "BNOEH / B'Nai / Armed coverage",
      state: 'off_clock',
    })
  })

  it('uses the current live roster for status and location', () => {
    const rows = buildTeamRows([summaryRow({ latestKind: 'clock_out' })], [liveRow()])

    expect(rows[0]).toMatchObject({
      currentLocation: 'NLA / Unarmed coverage',
      hasSelectedRangeSummary: true,
      state: 'working',
    })
  })

  it('adds a live employee who has no row in the selected historical range without inventing history', () => {
    const historicalEmployee = summaryRow({
      employeeId: 'dab8dcee-58ee-4110-9b06-d56e162edc73',
      employeeName: 'John Holliday',
      eventCount: 2,
      firstClockIn: '2026-08-01T02:00:00Z',
      lastClockOut: '2026-08-01T10:00:00Z',
      paidMinutes: 480,
      scheduledShiftCount: 0,
      workedSegmentCount: 1,
    })
    const currentLiveEmployee = liveRow({
      employeeId: 'fa000000-0000-4000-8000-000000000201',
      employeeName: 'Live Only Employee',
      locationName: 'Current Site / Patrol',
      postName: 'Patrol',
      siteCode: 'CURRENT',
      siteName: 'Current Site',
      username: 'liveonly',
    })

    const rows = buildTeamRows([historicalEmployee], [currentLiveEmployee])
    const liveOnly = rows.find((row) => row.employeeId === currentLiveEmployee.employeeId)

    expect(rows).toHaveLength(2)
    expect(rows[0]?.employeeId).toBe(currentLiveEmployee.employeeId)
    expect(liveOnly).toMatchObject({
      breakMinutes: 0,
      currentLocation: 'Current Site / Patrol',
      eventCount: 0,
      firstClockIn: null,
      hasSelectedRangeSummary: false,
      lastClockOut: null,
      overtimeMinutes: 0,
      paidMinutes: 0,
      pendingCorrectionCount: 0,
      scheduledShiftCount: 0,
      scheduledSummary: 'No scheduled or worked time in selected range',
      state: 'working',
      workedSegmentCount: 0,
    })
    expect(rows.find((row) => row.employeeId === historicalEmployee.employeeId)).toMatchObject({
      hasSelectedRangeSummary: true,
      paidMinutes: 480,
      state: 'off_clock',
    })
  })

  it('does not duplicate a live employee who already has a selected-range summary', () => {
    const rows = buildTeamRows([summaryRow({ eventCount: 2, paidMinutes: 480 })], [liveRow()])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      hasSelectedRangeSummary: true,
      paidMinutes: 480,
      state: 'working',
    })
  })
})

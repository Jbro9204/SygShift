import { describe, expect, it } from 'vitest'
import type { SessionContext } from '../data/auth'
import type { TeamAttendanceSummary, TimekeepingDashboard, TimekeepingReview } from '../data/timekeeping'
import { buildTimeCommandCenterModel, canViewTeamTime } from './timeCommandCenter'
import { canResolveTimeExceptions, canUseOwnTimeClock, canViewOwnTime } from './timePermissions'

const dashboard: TimekeepingDashboard = {
  eligibleShifts: [],
  employee: {
    displayName: 'Zach Ward',
    employmentType: 'flex',
    id: '73000000-0000-4000-8000-000000000001',
    role: 'guard',
    username: 'zward',
  },
  lastEvent: {
    id: '73000000-0000-4000-8000-000000000002',
    kind: 'clock_in',
    recordedAt: '2026-07-30T14:00:00.000Z',
    shiftId: null,
    source: 'web',
  },
  operationalDate: '2026-07-30',
  operationalTimeZone: 'America/Denver',
  pendingCorrectionCount: 1,
  recentEvents: [],
  serverTimestamp: '2026-07-30T16:00:00.000Z',
}

const review: TimekeepingReview = {
  exceptionResolutionHistory: [],
  fromDate: '2026-07-26',
  operationalTimeZone: 'America/Denver',
  payrollRules: {
    dailyOvertimeMinutes: 720,
    defaultBreakMinutes: 30,
    payDateAnchor: '2026-07-31',
    payFrequency: 'biweekly',
    salaryTimeOffReducesDefault: true,
    salaryWeeklyDefaultMinutes: 2400,
    timeZone: 'America/Denver',
    unpaidBreaks: true,
    weeklyOvertimeMinutes: 2400,
    weekStartsOn: 0,
    weekStartsOnLabel: 'Sunday',
  },
  pendingCorrections: [{
    employeeId: dashboard.employee.id,
    employeeName: 'Zach Ward',
    id: '73000000-0000-4000-8000-000000000004',
    kind: 'clock_in',
    reason: 'Forgot to clock in.',
    recordedAt: '2026-07-30T14:00:00.000Z',
    replacementTime: null,
    requestedAt: '2026-07-30T15:00:00.000Z',
    requestedBy: dashboard.employee.id,
    shiftId: null,
    timeEventId: '73000000-0000-4000-8000-000000000002',
    username: 'zward',
    voided: false,
  }],
  rows: [{
    breakMinutes: 30,
    employeeId: dashboard.employee.id,
    employeeName: 'Zach Ward',
    employmentType: 'flex',
    eventCount: 1,
    eventName: null,
    exceptionCodes: ['missing_clock_out'],
    detectedExceptionCodes: ['missing_clock_out'],
    exceptionDetails: [],
    eventTimeline: [],
    firstClockIn: '2026-07-30T14:00:00.000Z',
    grossMinutes: 660,
    isOvertime: false,
    lastClockOut: null,
    locationName: 'Administrative',
    operationalDate: '2026-07-30',
    overtimeMinutes: 0,
    paidMinutes: 630,
    payrollNotes: [],
    payrollReady: false,
    reviewStatus: 'unresolved',
    postName: 'Recruiting and Licensure',
    regularMinutes: 630,
    requiresArmed: false,
    role: 'guard',
    rowKind: 'time_event',
    salaryDefaultMinutes: 0,
    scheduledEndsAt: null,
    scheduledStartsAt: null,
    shiftId: null,
    siteCode: 'ADMIN',
    siteName: 'Administrative',
    timeOffMinutes: 0,
    timeZone: 'America/Denver',
    unpaidGapMinutes: 0,
    unpaidGaps: [],
    username: 'zward',
    weekEndsOn: '2026-08-01',
    weekStartsOn: '2026-07-26',
    workedSegments: [],
  }],
  serverTimestamp: '2026-07-30T16:00:00.000Z',
  summary: {
    exceptionCount: 1,
    grossMinutes: 660,
    overtimeMinutes: 0,
    paidMinutes: 630,
    pendingCorrectionCount: 1,
    readyCount: 0,
    regularMinutes: 630,
    rowCount: 1,
    salaryDefaultMinutes: 0,
    timeOffMinutes: 0,
  },
  throughDate: '2026-08-08',
}

const attendanceSummary: TeamAttendanceSummary = {
  fromDate: '2026-07-26',
  operationalTimeZone: 'America/Denver',
  rows: [{
    employeeId: dashboard.employee.id,
    employeeName: 'Zach Ward',
    employmentType: 'flex',
    eventCount: 1,
    firstClockIn: '2026-07-30T14:00:00.000Z',
    lastClockOut: null,
    latestEffectiveAt: '2026-07-30T14:00:00.000Z',
    latestEventName: null,
    latestKind: 'clock_in',
    latestLocationName: 'Administrative',
    latestPostName: null,
    latestSiteCode: null,
    latestSiteName: null,
    latestTimeZone: 'America/Denver',
    role: 'guard',
    scheduledEndsAt: null,
    scheduledEventName: null,
    scheduledLocationName: null,
    scheduledPostName: null,
    scheduledShiftCount: 0,
    scheduledSiteCode: null,
    scheduledSiteName: null,
    scheduledStartsAt: null,
    scheduledTimeZone: 'America/Denver',
    username: 'zward',
  }],
  serverTimestamp: '2026-07-30T16:00:00.000Z',
  throughDate: '2026-08-08',
}

describe('time command center model', () => {
  it('summarizes real review and team attendance data without depending on raw maintenance punches', () => {
    const model = buildTimeCommandCenterModel({ attendanceSummary, dashboard, review })

    expect(model.self.clockState).toBe('working')
    expect(model.clockedIn.count).toBe(1)
    expect(model.clockedIn.atUnexpectedLocation).toBe(1)
    expect(model.missingPunches.missingClockOuts).toBe(0)
    expect(model.payrollReadiness.percent).toBeNull()
    expect(model.overtimeRisk.approachingDaily).toBe(0)
  })

  it('only warns for active clock-ins once they reach the fourteen-hour guardrail', () => {
    const thirteenHourSummary: TeamAttendanceSummary = {
      ...attendanceSummary,
      serverTimestamp: '2026-07-31T03:00:00.000Z',
    }
    const fourteenHourSummary: TeamAttendanceSummary = {
      ...attendanceSummary,
      serverTimestamp: '2026-07-31T04:00:00.000Z',
    }

    expect(buildTimeCommandCenterModel({ attendanceSummary: thirteenHourSummary, dashboard, review }).clockedIn.longShiftCount).toBe(0)
    expect(buildTimeCommandCenterModel({ attendanceSummary: fourteenHourSummary, dashboard, review }).clockedIn.longShiftCount).toBe(1)
  })

  it('keeps employee access separate from team-wide access', () => {
    const guardSession: SessionContext = {
      displayName: 'Zach Ward',
      employeeId: dashboard.employee.id,
      hasMfa: false,
      mfaEnrolledAt: null,
      mfaRequired: false,
      mustChangePassword: false,
      passwordChangedAt: null,
      permissions: ['time.self.view'],
      role: 'guard',
      username: 'zward',
    }

    expect(canViewOwnTime(guardSession)).toBe(true)
    expect(canUseOwnTimeClock(guardSession)).toBe(false)
    expect(canViewTeamTime(guardSession)).toBe(false)
    expect(canViewTeamTime({ ...guardSession, role: 'supervisor' })).toBe(false)
    expect(canUseOwnTimeClock({ ...guardSession, permissions: ['time.punch'] })).toBe(true)
    expect(canViewTeamTime({ ...guardSession, permissions: ['time.view'] })).toBe(true)
    expect(canResolveTimeExceptions(guardSession)).toBe(false)
    expect(canResolveTimeExceptions({ ...guardSession, hasMfa: true, permissions: ['time.resolve_exceptions'] })).toBe(true)
  })
})

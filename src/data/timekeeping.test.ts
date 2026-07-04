import { describe, expect, it } from 'vitest'
import {
  activeTimeState,
  nextTimeEventKinds,
  parseTimekeepingDashboard,
  parseTimekeepingEvent,
  parseTimekeepingReview,
  payrollHours,
  reviewRowsToPayrollCsv,
} from './timekeeping'

describe('timekeeping validation', () => {
  it('accepts the protected dashboard contract', () => {
    const dashboard = parseTimekeepingDashboard({
      serverTimestamp: '2026-07-04T15:00:00.000Z',
      operationalDate: '2026-07-04',
      operationalTimeZone: 'America/Denver',
      employee: {
        id: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        displayName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
      },
      lastEvent: null,
      eligibleShifts: [],
      recentEvents: [],
      pendingCorrectionCount: 0,
    })

    expect(dashboard.employee.username).toBe('jbrown')
    expect(activeTimeState(dashboard.lastEvent)).toBe('off_clock')
  })

  it('maps the last punch to the correct employee state', () => {
    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000002',
      kind: 'clock_in',
      shiftId: null,
      recordedAt: '2026-07-04T15:00:00.000Z',
      source: 'web',
    }))).toBe('working')

    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000003',
      kind: 'break_start',
      shiftId: null,
      recordedAt: '2026-07-04T17:00:00.000Z',
      source: 'web',
    }))).toBe('on_break')

    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000004',
      kind: 'clock_out',
      shiftId: null,
      recordedAt: '2026-07-04T23:00:00.000Z',
      source: 'web',
    }))).toBe('off_clock')
  })

  it('limits next actions to valid punch sequences', () => {
    expect(nextTimeEventKinds('off_clock')).toEqual(['clock_in'])
    expect(nextTimeEventKinds('working')).toEqual(['break_start', 'clock_out'])
    expect(nextTimeEventKinds('on_break')).toEqual(['break_end'])
  })

  it('validates supervisor review rows and exports payroll CSV safely', () => {
    const review = parseTimekeepingReview({
      serverTimestamp: '2026-07-04T15:00:00.000Z',
      fromDate: '2026-06-28',
      throughDate: '2026-07-04',
      operationalTimeZone: 'America/Denver',
      summary: {
        rowCount: 1,
        readyCount: 1,
        exceptionCount: 0,
        pendingCorrectionCount: 0,
        grossMinutes: 510,
        paidMinutes: 480,
      },
      rows: [{
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: '73000000-0000-4000-8000-000000000010',
        operationalDate: '2026-07-04',
        siteName: 'Main Site',
        siteCode: 'MAIN',
        postName: 'Primary Post',
        eventName: null,
        locationName: 'Main Site',
        scheduledStartsAt: '2026-07-04T14:00:00.000Z',
        scheduledEndsAt: '2026-07-04T22:00:00.000Z',
        timeZone: 'America/Denver',
        firstClockIn: '2026-07-04T13:58:00.000Z',
        lastClockOut: '2026-07-04T22:28:00.000Z',
        grossMinutes: 510,
        breakMinutes: 30,
        paidMinutes: 480,
        eventCount: 4,
        requiresArmed: false,
        isOvertime: false,
        payrollReady: true,
        exceptionCodes: [],
      }],
      pendingCorrections: [],
    })

    expect(payrollHours(review.summary.paidMinutes)).toBe('8.00')
    expect(reviewRowsToPayrollCsv(review.rows)).toContain('Jordan Brown,jbrown,2026-07-04')
  })
})

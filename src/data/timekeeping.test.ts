import { describe, expect, it } from 'vitest'
import {
  activeTimeState,
  nextTimeEventKinds,
  parsePayrollExportBatch,
  parsePayrollExportHistory,
  parseTimeMaintenance,
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
      payrollRules: {
        timeZone: 'America/Denver',
        weekStartsOn: 0,
        weekStartsOnLabel: 'Sunday',
        payFrequency: 'biweekly',
        payDateAnchor: '2026-07-17',
        dailyOvertimeMinutes: 720,
        weeklyOvertimeMinutes: 2400,
        unpaidBreaks: true,
        defaultBreakMinutes: 30,
        salaryWeeklyDefaultMinutes: 2400,
        salaryTimeOffReducesDefault: true,
      },
      summary: {
        rowCount: 1,
        readyCount: 1,
        exceptionCount: 0,
        pendingCorrectionCount: 0,
        grossMinutes: 510,
        paidMinutes: 480,
        regularMinutes: 420,
        overtimeMinutes: 60,
        salaryDefaultMinutes: 0,
        timeOffMinutes: 0,
      },
      rows: [{
        rowKind: 'time_event',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: '73000000-0000-4000-8000-000000000010',
        operationalDate: '2026-07-04',
        weekStartsOn: '2026-06-28',
        weekEndsOn: '2026-07-04',
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
        regularMinutes: 420,
        overtimeMinutes: 60,
        salaryDefaultMinutes: 0,
        timeOffMinutes: 0,
        eventCount: 4,
        requiresArmed: false,
        isOvertime: false,
        payrollReady: true,
        exceptionCodes: [],
        payrollNotes: ['Daily OT: over 12 paid hours in one day.'],
      }],
      pendingCorrections: [],
    })

    expect(payrollHours(review.summary.paidMinutes)).toBe('8.00')
    expect(payrollHours(review.summary.overtimeMinutes)).toBe('1.00')
    expect(reviewRowsToPayrollCsv(review.rows)).toContain('time_event,Jordan Brown,jbrown,2026-07-04')
  })

  it('validates salary default payroll rows reduced by approved time off', () => {
    const review = parseTimekeepingReview({
      serverTimestamp: '2026-07-16T15:00:00.000Z',
      fromDate: '2026-07-12',
      throughDate: '2026-07-18',
      operationalTimeZone: 'America/Denver',
      summary: {
        rowCount: 1,
        readyCount: 1,
        exceptionCount: 0,
        pendingCorrectionCount: 0,
        grossMinutes: 1920,
        paidMinutes: 1920,
        regularMinutes: 1920,
        overtimeMinutes: 0,
        salaryDefaultMinutes: 2400,
        timeOffMinutes: 480,
      },
      rows: [{
        rowKind: 'salary_default',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: null,
        operationalDate: '2026-07-12',
        weekStartsOn: '2026-07-12',
        weekEndsOn: '2026-07-18',
        siteName: null,
        siteCode: null,
        postName: null,
        eventName: null,
        locationName: 'Salary default',
        scheduledStartsAt: null,
        scheduledEndsAt: null,
        timeZone: 'America/Denver',
        firstClockIn: null,
        lastClockOut: null,
        grossMinutes: 1920,
        breakMinutes: 0,
        paidMinutes: 1920,
        regularMinutes: 1920,
        overtimeMinutes: 0,
        salaryDefaultMinutes: 2400,
        timeOffMinutes: 480,
        eventCount: 0,
        requiresArmed: false,
        isOvertime: false,
        payrollReady: true,
        exceptionCodes: [],
        payrollNotes: ['Approved time off reduced the salary default by 8.00 hours.'],
      }],
      pendingCorrections: [],
    })

    expect(review.rows[0]?.rowKind).toBe('salary_default')
    expect(reviewRowsToPayrollCsv(review.rows)).toContain('salary_default,Jordan Brown,jbrown,2026-07-12')
  })

  it('validates locked payroll export batch records', () => {
    const batch = parsePayrollExportBatch({
      id: '73000000-0000-4000-8000-000000000020',
      fromDate: '2026-06-28',
      throughDate: '2026-07-04',
      createdAt: '2026-07-04T23:30:00.000Z',
      createdBy: '73000000-0000-4000-8000-000000000001',
      createdByName: 'Jordan Brown',
      rowCount: 14,
      grossMinutes: 7140,
      paidMinutes: 6720,
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      note: 'Reviewed and ready for payroll.',
      duplicate: false,
    })

    expect(batch.rowCount).toBe(14)
    expect(parsePayrollExportHistory([batch])).toHaveLength(1)
  })

  it('validates operations time maintenance events', () => {
    const maintenance = parseTimeMaintenance({
      serverTimestamp: '2026-07-16T15:00:00.000Z',
      fromDate: '2026-07-10',
      throughDate: '2026-07-16',
      operationalTimeZone: 'America/Denver',
      employees: [{
        id: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        displayName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        status: 'active',
      }],
      events: [{
        id: '73000000-0000-4000-8000-000000000030',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: null,
        kind: 'clock_out',
        recordedAt: '2026-07-16T22:00:00.000Z',
        effectiveAt: '2026-07-16T22:00:00.000Z',
        clientRecordedAt: null,
        source: 'supervisor',
        createdBy: '73000000-0000-4000-8000-000000000001',
        createdByName: 'Jordan Brown',
        voided: false,
        pendingCorrectionCount: 0,
        maintenanceNoteCount: 1,
        latestNote: 'Forgotten clock-out verified by supervisor.',
        latestAction: 'manual_add',
        siteName: null,
        siteCode: null,
        postName: null,
        eventName: null,
        locationName: 'Unscheduled',
        timeZone: 'America/Denver',
      }],
    })

    expect(maintenance.events[0]?.source).toBe('supervisor')
    expect(maintenance.events[0]?.latestAction).toBe('manual_add')
  })
})

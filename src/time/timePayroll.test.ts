import { describe, expect, it } from 'vitest'
import type { TimekeepingReview } from '../data/timekeeping'
import { payrollExportFileName, payrollLockBlocker, payrollReadinessPercent } from './timePayroll'

const cleanReview: TimekeepingReview = {
  fromDate: '2026-07-12',
  operationalTimeZone: 'America/Denver',
  pendingCorrections: [],
  rows: [{
    breakMinutes: 30,
    employeeId: '73000000-0000-4000-8000-000000000001',
    employeeName: 'Jordan Brown',
    employmentType: 'salary',
    eventCount: 4,
    eventName: null,
    exceptionCodes: [],
    firstClockIn: '2026-07-12T14:00:00.000Z',
    grossMinutes: 510,
    isOvertime: false,
    lastClockOut: '2026-07-12T22:30:00.000Z',
    locationName: 'Administrative',
    operationalDate: '2026-07-12',
    overtimeMinutes: 0,
    paidMinutes: 480,
    payrollNotes: [],
    payrollReady: true,
    postName: 'Administration',
    regularMinutes: 480,
    requiresArmed: false,
    role: 'admin',
    rowKind: 'time_event',
    salaryDefaultMinutes: 0,
    scheduledEndsAt: null,
    scheduledStartsAt: null,
    shiftId: null,
    siteCode: 'ADMIN',
    siteName: 'Administrative',
    timeOffMinutes: 0,
    timeZone: 'America/Denver',
    username: 'jbrown',
    weekEndsOn: '2026-07-25',
    weekStartsOn: '2026-07-12',
  }],
  serverTimestamp: '2026-07-30T16:00:00.000Z',
  summary: {
    exceptionCount: 0,
    grossMinutes: 510,
    overtimeMinutes: 0,
    paidMinutes: 480,
    pendingCorrectionCount: 0,
    readyCount: 1,
    regularMinutes: 480,
    rowCount: 1,
    salaryDefaultMinutes: 0,
    timeOffMinutes: 0,
  },
  throughDate: '2026-07-25',
}

describe('payroll export readiness', () => {
  it('allows clean payroll to be locked', () => {
    expect(payrollLockBlocker(cleanReview)).toBe('')
    expect(payrollReadinessPercent(cleanReview)).toBe(100)
  })

  it('blocks payroll while exceptions remain', () => {
    const blockedReview: TimekeepingReview = {
      ...cleanReview,
      summary: {
        ...cleanReview.summary,
        exceptionCount: 1,
        readyCount: 0,
      },
    }

    expect(payrollLockBlocker(blockedReview)).toContain('Needs review')
    expect(payrollReadinessPercent(blockedReview)).toBe(0)
  })

  it('uses stable file names for preview and official exports', () => {
    expect(payrollExportFileName('2026-07-12', '2026-07-25')).toBe('sygshift-payroll-preview-2026-07-12-to-2026-07-25.csv')
    expect(payrollExportFileName('2026-07-12', '2026-07-25', 'official')).toBe('sygshift-payroll-official-2026-07-12-to-2026-07-25.csv')
  })
})

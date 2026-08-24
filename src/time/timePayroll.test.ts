import { describe, expect, it } from 'vitest'
import type { PayrollAccountabilityEvent, TimekeepingReview } from '../data/timekeeping'
import {
  accountabilityEventPayCategory,
  accountabilityEventPayableMinutes,
  accountabilityEventReviewNote,
  accountabilityEventScheduledMinutes,
  buildPayrollWorkbookSheets,
  createPayrollWorkbookBlob,
  payrollWorkbookWeeks,
} from './payrollWorkbook'
import {
  exportableWorkedTimeRows,
  isActiveInProgressTimeRow,
  payrollExportFileName,
  payrollLockBlocker,
  payrollReadinessPercent,
  workedTimePayrollReview,
} from './timePayroll'

const cleanReview: TimekeepingReview = {
  exceptionResolutionHistory: [],
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
    detectedExceptionCodes: [],
    exceptionDetails: [],
    eventTimeline: [],
    firstClockIn: '2026-07-12T14:00:00.000Z',
    grossMinutes: 510,
    isOvertime: false,
    lastClockOut: '2026-07-12T22:30:00.000Z',
    locationName: 'Administrative',
    operationalDate: '2026-07-12',
    overtimeMinutes: 0,
    paidMinutes: 480,
    payrollNotes: [],
    payrollOccurrenceKey: 'shift:73000000-0000-4000-8000-000000000010:employee:73000000-0000-4000-8000-000000000001',
    payrollAssignmentSource: 'scheduled_shift',
    payrollAssignmentStatus: 'derived',
    payrollAssignmentExplanation: 'Entire occurrence follows the scheduled shift start in America/Denver.',
    payrollAssignmentCandidates: [],
    crossesPayrollBoundary: false,
    payrollGroupingPolicy: 'scheduled_shift_start',
    payrollPolicyVersion: 'payroll-batch-v1',
    payrollConfigurationVersion: 1,
    overtimePolicyVersion: 'colorado-daily-weekly-v1',
    manualAdjustment: false,
    payrollReady: true,
    reviewStatus: 'ready',
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
    unpaidGapMinutes: 0,
    unpaidGaps: [],
    username: 'jbrown',
    weekEndsOn: '2026-07-25',
    weekStartsOn: '2026-07-12',
    workedSegments: [],
    workType: 'post',
    workTypeLabel: 'Post Time',
    payCode: 'POST',
    workTypePaid: true,
    workTypeOvertimeEligible: true,
    workTypeRateSource: 'employee_base_rate',
    mixedWorkTypes: false,
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

const sickEvent: PayrollAccountabilityEvent = {
  createdAt: '2026-07-30T12:00:00.000Z',
  employeeId: '73000000-0000-4000-8000-000000000002',
  employeeName: 'Jade Baptist',
  employmentType: 'hourly',
  endsAt: '2026-07-30T22:00:00.000Z',
  eventName: null,
  eventType: 'called_in_sick',
  id: '73000000-0000-4000-8000-000000000101',
  locationName: 'Market',
  note: 'Called in sick before shift.',
  operationalDate: '2026-07-30',
  postName: 'Unarmed coverage',
  role: 'guard',
  siteCode: 'MKT',
  siteName: 'Market',
  sourceTable: 'attendance_accountability_events',
  startsAt: '2026-07-30T12:00:00.000Z',
  status: 'reported',
  timeZone: 'America/Denver',
  username: 'jbaptist',
}

describe('payroll export readiness', () => {
  it('allows clean payroll to be locked', () => {
    expect(payrollLockBlocker(cleanReview)).toBe('')
    expect(payrollReadinessPercent(cleanReview)).toBe(100)
  })

  it('blocks payroll while exceptions remain', () => {
    const blockedReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        exceptionCodes: ['pending_correction'],
        payrollReady: false,
      }],
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
    expect(payrollExportFileName('2026-07-12', '2026-07-25')).toBe('sygshift-payroll-preview-2026-07-12-to-2026-07-25.xlsx')
    expect(payrollExportFileName('2026-07-12', '2026-07-25', 'official')).toBe('sygshift-payroll-official-2026-07-12-to-2026-07-25.xlsx')
  })

  it('removes salary defaults from payroll export readiness', () => {
    const salaryOnlyReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        breakMinutes: 0,
        eventCount: 0,
        firstClockIn: null,
        grossMinutes: 2400,
        lastClockOut: null,
        locationName: 'Salary default',
        paidMinutes: 2400,
        payrollNotes: ['Salary payroll default.'],
        regularMinutes: 2400,
        rowKind: 'salary_default',
        salaryDefaultMinutes: 2400,
      }],
      summary: {
        ...cleanReview.summary,
        grossMinutes: 2400,
        paidMinutes: 2400,
        readyCount: 1,
        regularMinutes: 2400,
        rowCount: 1,
        salaryDefaultMinutes: 2400,
      },
    }

    expect(workedTimePayrollReview(salaryOnlyReview)?.summary.rowCount).toBe(0)
    expect(payrollLockBlocker(salaryOnlyReview)).toContain('no SygShift clock-in/out')
    expect(exportableWorkedTimeRows(salaryOnlyReview.rows)).toHaveLength(0)
  })

  it('blocks export when a worked-time row is missing a clock-out', () => {
    const incompleteReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        exceptionCodes: ['missing_clock_out'],
        lastClockOut: null,
        paidMinutes: 0,
        payrollReady: false,
      }],
      summary: {
        ...cleanReview.summary,
        exceptionCount: 1,
        paidMinutes: 0,
        readyCount: 0,
      },
    }

    expect(payrollLockBlocker(incompleteReview)).toContain('worked-time row')
    expect(exportableWorkedTimeRows(incompleteReview.rows)).toHaveLength(0)
  })

  it('does not flag an active clock-in as a missing punch while the shift is still in progress', () => {
    const activeReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        exceptionCodes: ['missing_clock_out', 'zero_paid_minutes'],
        firstClockIn: '2026-07-30T14:00:00.000Z',
        lastClockOut: null,
        paidMinutes: 0,
        payrollReady: false,
        scheduledEndsAt: '2026-07-30T21:00:00.000Z',
        scheduledStartsAt: '2026-07-30T14:00:00.000Z',
      }],
      serverTimestamp: '2026-07-30T18:00:00.000Z',
    }

    expect(isActiveInProgressTimeRow(activeReview.rows[0], new Date(activeReview.serverTimestamp))).toBe(true)
    expect(workedTimePayrollReview(activeReview)?.summary.rowCount).toBe(0)
    expect(payrollLockBlocker(activeReview)).toContain('no SygShift clock-in/out')
  })

  it('does not flag an active clock-in just because the scheduled shift end has passed', () => {
    const activeAfterScheduledEndReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        exceptionCodes: ['missing_clock_out', 'zero_paid_minutes'],
        firstClockIn: '2026-07-30T14:00:00.000Z',
        lastClockOut: null,
        paidMinutes: 0,
        payrollReady: false,
        scheduledEndsAt: '2026-07-30T18:00:00.000Z',
        scheduledStartsAt: '2026-07-30T14:00:00.000Z',
      }],
      serverTimestamp: '2026-07-31T02:30:00.000Z',
    }

    expect(isActiveInProgressTimeRow(activeAfterScheduledEndReview.rows[0], new Date(activeAfterScheduledEndReview.serverTimestamp))).toBe(true)
    expect(workedTimePayrollReview(activeAfterScheduledEndReview)?.summary.rowCount).toBe(0)
    expect(payrollLockBlocker(activeAfterScheduledEndReview)).toContain('no SygShift clock-in/out')
  })

  it('flags an active clock-in once it reaches the fourteen-hour review limit', () => {
    const overLimitReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        exceptionCodes: ['missing_clock_out', 'zero_paid_minutes'],
        firstClockIn: '2026-07-30T14:00:00.000Z',
        lastClockOut: null,
        paidMinutes: 0,
        payrollReady: false,
        scheduledEndsAt: '2026-07-30T18:00:00.000Z',
        scheduledStartsAt: '2026-07-30T14:00:00.000Z',
      }],
      serverTimestamp: '2026-07-31T04:00:00.000Z',
    }

    expect(isActiveInProgressTimeRow(overLimitReview.rows[0], new Date(overLimitReview.serverTimestamp))).toBe(false)
    expect(workedTimePayrollReview(overLimitReview)?.summary.exceptionCount).toBe(1)
    expect(payrollLockBlocker(overLimitReview)).toContain('worked-time row')
  })

  it('keeps stale open clock-ins blocked after the active shift window has passed', () => {
    const staleReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        exceptionCodes: ['missing_clock_out', 'zero_paid_minutes'],
        firstClockIn: '2026-07-29T14:00:00.000Z',
        lastClockOut: null,
        paidMinutes: 0,
        payrollReady: false,
        scheduledEndsAt: '2026-07-29T21:00:00.000Z',
        scheduledStartsAt: '2026-07-29T14:00:00.000Z',
      }],
      serverTimestamp: '2026-07-30T18:00:00.000Z',
    }

    expect(isActiveInProgressTimeRow(staleReview.rows[0], new Date(staleReview.serverTimestamp))).toBe(false)
    expect(workedTimePayrollReview(staleReview)?.summary.exceptionCount).toBe(1)
    expect(payrollLockBlocker(staleReview)).toContain('worked-time row')
  })

  it('pays sick time from the scheduled shift length', () => {
    expect(accountabilityEventScheduledMinutes(sickEvent)).toBe(600)
    expect(accountabilityEventPayableMinutes(sickEvent)).toBe(600)
    expect(accountabilityEventPayCategory(sickEvent)).toBe('Sick pay')
    expect(accountabilityEventReviewNote(sickEvent)).toBe('')
  })

  it('flags sick reports without a scheduled shift window instead of guessing hours', () => {
    const dateOnlySickEvent: PayrollAccountabilityEvent = {
      ...sickEvent,
      endsAt: null,
      startsAt: null,
    }

    expect(accountabilityEventScheduledMinutes(dateOnlySickEvent)).toBe(0)
    expect(accountabilityEventPayableMinutes(dateOnlySickEvent)).toBe(0)
    expect(accountabilityEventReviewNote(dateOnlySickEvent)).toContain('no scheduled shift')
  })

  it('keeps regular call-offs unpaid unless HR converts them to sick or PTO', () => {
    const callOffEvent: PayrollAccountabilityEvent = {
      ...sickEvent,
      eventType: 'call_off',
      note: 'Called off but not marked sick.',
    }

    expect(accountabilityEventScheduledMinutes(callOffEvent)).toBe(600)
    expect(accountabilityEventPayableMinutes(callOffEvent)).toBe(0)
    expect(accountabilityEventPayCategory(callOffEvent)).toBe('Unpaid call-off')
  })

  it('builds a compact payroll summary with separate review and variance sheets', () => {
    const sheets = buildPayrollWorkbookSheets({
      exportType: 'Preview',
      review: cleanReview,
    })

    expect(sheets.map((sheet) => sheet.name).slice(0, 5)).toEqual([
      'Payroll Summary',
      'Week 1 Detail',
      'Week 2 Detail',
      'Payroll Review',
      'Hours Variance',
    ])
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    expect(summaryHeaderIndex).toBeGreaterThan(0)
    expect(sheets[0].rows[summaryHeaderIndex]).toEqual([
      'Employee',
      'Employment',
      'Payroll Week',
      'Week Dates',
      'Worked Shifts',
      'Scheduled Hours',
      'Worked Hours',
      'Training Hours',
      'Regular Hours',
      'Overtime Hours',
      'Sick Pay Hours',
      'PTO Hours',
      'Other Paid Hours',
      'Total Payable',
      'Status',
    ])
    expect(sheets[0].rows.every((row) => row.length <= 15)).toBe(true)
    const employeeHeader = sheets.at(-1)?.rows.find((row) => row[0] === 'Employee' && row[1] === 'Employee ID')
    expect(employeeHeader).toEqual([
      'Employee',
      'Employee ID',
      'Username',
      'Work Date',
      'Site / Post',
      'Time Category',
      'Scheduled Start',
      'Scheduled End',
      'Actual Clock In',
      'Actual Clock Out',
      'Worked Hours',
      'Payroll Batch Week',
      'Payroll Period',
      'Regular Hours',
      'Overtime Hours',
      'Break Minutes',
      'Crosses Payroll Boundary',
      'Assignment Source',
      'Manual Adjustment',
      'Exception Status',
      'Shift Notes',
      'Review Notes',
    ])
  })

  it('exports a reviewed medical-appointment split shift without inventing paid time', () => {
    const fingerprint = 'a'.repeat(64)
    const medicalReview: TimekeepingReview = {
      ...cleanReview,
      exceptionResolutionHistory: [{
        action: 'approved_exception',
        employeeId: cleanReview.rows[0].employeeId,
        employeeName: cleanReview.rows[0].employeeName,
        exceptionCode: 'multiple_work_segments',
        id: '73000000-0000-4000-8000-000000000099',
        occurrenceFingerprint: fingerprint,
        operationalDate: '2026-07-12',
        reason: 'Medical appointment; unpaid gap verified by the administrator.',
        resolvedAt: '2026-07-13T01:00:00.000Z',
        resolvedBy: '73000000-0000-4000-8000-000000000008',
        resolvedByName: 'Payroll Administrator',
        shiftId: cleanReview.rows[0].shiftId,
      }],
      rows: [{
        ...cleanReview.rows[0],
        breakMinutes: 0,
        detectedExceptionCodes: ['multiple_work_segments'],
        exceptionCodes: [],
        exceptionDetails: [{
          code: 'multiple_work_segments',
          fingerprint,
          policy: 'reviewable',
          reason: 'Medical appointment; unpaid gap verified by the administrator.',
          status: 'approved_exception',
        }],
        eventCount: 4,
        eventTimeline: [
          { effectiveAt: '2026-07-12T14:00:00.000Z', id: '73000000-0000-4000-8000-000000000011', kind: 'clock_in', recordedAt: '2026-07-12T14:00:00.000Z', shiftId: null },
          { effectiveAt: '2026-07-12T17:00:00.000Z', id: '73000000-0000-4000-8000-000000000012', kind: 'clock_out', recordedAt: '2026-07-12T17:00:00.000Z', shiftId: null },
          { effectiveAt: '2026-07-12T19:00:00.000Z', id: '73000000-0000-4000-8000-000000000013', kind: 'clock_in', recordedAt: '2026-07-12T19:00:00.000Z', shiftId: null },
          { effectiveAt: '2026-07-12T22:00:00.000Z', id: '73000000-0000-4000-8000-000000000014', kind: 'clock_out', recordedAt: '2026-07-12T22:00:00.000Z', shiftId: null },
        ],
        firstClockIn: '2026-07-12T14:00:00.000Z',
        grossMinutes: 480,
        lastClockOut: '2026-07-12T22:00:00.000Z',
        paidMinutes: 360,
        payrollReady: true,
        regularMinutes: 360,
        reviewStatus: 'approved_exception',
        unpaidGapMinutes: 120,
        unpaidGaps: [{ endsAt: '2026-07-12T19:00:00.000Z', minutes: 120, startsAt: '2026-07-12T17:00:00.000Z' }],
        workedSegments: [
          { breakMinutes: 0, endsAt: '2026-07-12T17:00:00.000Z', paidMinutes: 180, segmentNumber: 1, startsAt: '2026-07-12T14:00:00.000Z' },
          { breakMinutes: 0, endsAt: '2026-07-12T22:00:00.000Z', paidMinutes: 180, segmentNumber: 2, startsAt: '2026-07-12T19:00:00.000Z' },
        ],
      }],
      summary: {
        ...cleanReview.summary,
        grossMinutes: 480,
        paidMinutes: 360,
        regularMinutes: 360,
      },
    }

    expect(exportableWorkedTimeRows(medicalReview.rows)).toHaveLength(1)
    expect(exportableWorkedTimeRows(medicalReview.rows)[0].paidMinutes).toBe(360)
    expect(payrollLockBlocker(medicalReview)).toBe('')

    const sheets = buildPayrollWorkbookSheets({ exportType: 'Preview', review: medicalReview })
    const decisionSheet = sheets.find((sheet) => sheet.name === 'Exception Decisions')
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    expect(sheets[0].rows[summaryHeaderIndex + 1]?.[6]).toBe(6)
    expect(decisionSheet?.rows[4]).toContain('Approved valid exception')
    expect(decisionSheet?.rows[4]).toContain('Medical appointment; unpaid gap verified by the administrator.')
  })

  it('writes worksheet elements in Excel-compatible schema order', async () => {
    const workbook = createPayrollWorkbookBlob({
      exportType: 'Preview',
      review: cleanReview,
    })
    const packageText = new TextDecoder().decode(await workbook.arrayBuffer())
    const worksheetDocuments = packageText.match(/<worksheet[\s\S]*?<\/worksheet>/g) ?? []

    expect(worksheetDocuments.length).toBeGreaterThan(0)
    for (const worksheet of worksheetDocuments) {
      const filterIndex = worksheet.indexOf('<autoFilter')
      const mergeIndex = worksheet.indexOf('<mergeCells')
      if (filterIndex >= 0 && mergeIndex >= 0) expect(filterIndex).toBeLessThan(mergeIndex)
    }
  })

  it('supports custom payroll export ranges', () => {
    const sheets = buildPayrollWorkbookSheets({
      exportType: 'Preview',
      review: {
        ...cleanReview,
        fromDate: '2026-07-19',
        throughDate: '2026-08-01',
      },
    })

    expect(sheets[0].rows[1]).toEqual(['Pay Period', '07/19/2026 - 08/01/2026'])
  })

  it('builds distinct Sunday-through-Saturday payroll weeks for a biweekly export', () => {
    expect(payrollWorkbookWeeks({ exportType: 'Preview', review: cleanReview })).toEqual([
      { label: 'Week 1', weekEndsOn: '2026-07-18', weekStartsOn: '2026-07-12' },
      { label: 'Week 2', weekEndsOn: '2026-07-25', weekStartsOn: '2026-07-19' },
    ])
  })

  it('keeps a Saturday-night occurrence entirely in week one of the payroll workbook', () => {
    const overnightRow = {
      ...cleanReview.rows[0],
      breakMinutes: 0,
      crossesPayrollBoundary: true,
      firstClockIn: '2026-08-16T05:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-08-16T13:00:00.000Z',
      operationalDate: '2026-08-15',
      paidMinutes: 480,
      payrollAssignmentAnchor: '2026-08-16T05:00:00.000Z',
      payrollBatchWeekEndsOn: '2026-08-15',
      payrollBatchWeekStartsOn: '2026-08-09',
      payrollPeriodEndsOn: '2026-08-22',
      payrollPeriodStartsOn: '2026-08-09',
      regularMinutes: 480,
      scheduledEndsAt: '2026-08-16T13:00:00.000Z',
      scheduledStartsAt: '2026-08-16T05:00:00.000Z',
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      fromDate: '2026-08-09',
      rows: [overnightRow],
      throughDate: '2026-08-22',
    }
    const sheets = buildPayrollWorkbookSheets({ exportType: 'Preview', review })
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    const weekOne = sheets[0].rows[summaryHeaderIndex + 1]
    const weekTwo = sheets[0].rows[summaryHeaderIndex + 2]

    expect(weekOne?.[2]).toBe('Week 1')
    expect(weekOne?.[6]).toBe(8)
    expect(weekTwo?.[2]).toBe('Week 2')
    expect(weekTwo?.[6]).toBe(0)
    expect(sheets.find((sheet) => sheet.name === 'Week 1 Detail')?.rows.some((row) => row[0] === 'Jordan Brown' && row[11] === 8)).toBe(true)
    expect(sheets.find((sheet) => sheet.name === 'Week 2 Detail')?.rows.some((row) => row[0] === 'Jordan Brown')).toBe(false)
  })

  it('places a Sunday-night occurrence in week two without splitting its hours', () => {
    const overnightRow = {
      ...cleanReview.rows[0],
      breakMinutes: 0,
      crossesPayrollBoundary: false,
      firstClockIn: '2026-08-17T05:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-08-17T13:00:00.000Z',
      operationalDate: '2026-08-16',
      paidMinutes: 480,
      payrollAssignmentAnchor: '2026-08-17T05:00:00.000Z',
      payrollBatchWeekEndsOn: '2026-08-22',
      payrollBatchWeekStartsOn: '2026-08-16',
      payrollPeriodEndsOn: '2026-08-22',
      payrollPeriodStartsOn: '2026-08-09',
      regularMinutes: 480,
      scheduledEndsAt: '2026-08-17T13:00:00.000Z',
      scheduledStartsAt: '2026-08-17T05:00:00.000Z',
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      fromDate: '2026-08-09',
      rows: [overnightRow],
      throughDate: '2026-08-22',
    }
    const sheets = buildPayrollWorkbookSheets({ exportType: 'Preview', review })
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    expect(sheets[0].rows[summaryHeaderIndex + 1]?.[6]).toBe(0)
    expect(sheets[0].rows[summaryHeaderIndex + 2]?.[6]).toBe(8)
  })

  it('keeps weekly worked, overtime, sick-pay, and payable totals in their correct payroll week', () => {
    const employeeId = cleanReview.rows[0].employeeId
    const weekOneRow = {
      ...cleanReview.rows[0],
      breakMinutes: 0,
      firstClockIn: '2026-08-10T14:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-08-10T22:00:00.000Z',
      operationalDate: '2026-08-10',
      paidMinutes: 480,
      payrollAssignmentAnchor: '2026-08-10T14:00:00.000Z',
      payrollBatchWeekEndsOn: '2026-08-15',
      payrollBatchWeekStartsOn: '2026-08-09',
      regularMinutes: 480,
      scheduledEndsAt: '2026-08-10T22:00:00.000Z',
      scheduledStartsAt: '2026-08-10T14:00:00.000Z',
    }
    const weekTwoRow = {
      ...weekOneRow,
      firstClockIn: '2026-08-17T14:00:00.000Z',
      lastClockOut: '2026-08-17T22:00:00.000Z',
      operationalDate: '2026-08-17',
      overtimeMinutes: 120,
      payrollAssignmentAnchor: '2026-08-17T14:00:00.000Z',
      payrollBatchWeekEndsOn: '2026-08-22',
      payrollBatchWeekStartsOn: '2026-08-16',
      regularMinutes: 360,
      scheduledEndsAt: '2026-08-17T22:00:00.000Z',
      scheduledStartsAt: '2026-08-17T14:00:00.000Z',
    }
    const weekTwoSickEvent: PayrollAccountabilityEvent = {
      ...sickEvent,
      employeeId,
      employeeName: weekTwoRow.employeeName,
      endsAt: '2026-08-18T16:00:00.000Z',
      operationalDate: '2026-08-18',
      startsAt: '2026-08-18T14:00:00.000Z',
      username: weekTwoRow.username,
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      fromDate: '2026-08-09',
      rows: [weekOneRow, weekTwoRow],
      throughDate: '2026-08-22',
    }
    const sheets = buildPayrollWorkbookSheets({
      accountabilityEvents: [weekTwoSickEvent],
      exportType: 'Preview',
      review,
    })
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    const weekOne = sheets[0].rows[summaryHeaderIndex + 1]
    const weekTwo = sheets[0].rows[summaryHeaderIndex + 2]

    expect(weekOne?.slice(6, 15)).toEqual([8, 0, 8, 0, 0, 0, 0, 8, 'Ready'])
    expect(weekTwo?.slice(6, 15)).toEqual([8, 0, 6, 2, 2, 0, 0, 10, 'Ready'])
  })
})

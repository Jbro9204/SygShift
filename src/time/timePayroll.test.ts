import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PayrollAccountabilityEvent, PayrollRules, TimekeepingReview } from '../data/timekeeping'
import {
  accountabilityEventPayCategory,
  accountabilityEventPayableMinutes,
  accountabilityEventReviewNote,
  accountabilityEventScheduledMinutes,
  buildPayrollWorkbookSheets,
  createPayrollWorkbookBlob,
  downloadPayrollWorkbook,
  payrollWorkbookWeeks,
  summarizePayrollWorkbookByWeek,
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
    employmentType: 'hourly',
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
    payrollCategory: 'regular',
    payrollCategoryLabel: 'Regular',
    mixedPayrollCategories: false,
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
    epMinutes: 0,
    overtimeMinutes: 0,
    paidMinutes: 480,
    pendingCorrectionCount: 0,
    readyCount: 1,
    regularCategoryMinutes: 480,
    regularMinutes: 480,
    rowCount: 1,
    salaryDefaultMinutes: 0,
    timeOffMinutes: 0,
    truepMinutes: 0,
    unclassifiedCategoryMinutes: 0,
  },
  throughDate: '2026-07-25',
}

const sundayPayrollRules: PayrollRules = {
  crossBoundaryGroupingPolicy: 'elapsed_time_boundary_split',
  dailyOvertimeMinutes: 720,
  defaultBreakMinutes: 30,
  overtimePolicyVersion: 'colorado-daily-weekly-v1',
  overtimeTimeZone: 'America/Denver',
  overtimeWeekStartsOn: 0,
  overtimeWeekStartTime: '00:00:00',
  payDateAnchor: '2026-08-28',
  payFrequency: 'biweekly',
  payrollCalculationPolicyVersion: 'payroll-batch-v2',
  payrollConfigurationVersion: 2,
  payrollPolicyEffectiveFrom: '2026-08-16',
  payrollWeekStartTime: '00:00:00',
  salaryTimeOffReducesDefault: true,
  salaryWeeklyDefaultMinutes: 2_400,
  timeZone: 'America/Denver',
  unpaidBreaks: true,
  weeklyOvertimeMinutes: 2_400,
  weekStartsOn: 0,
  weekStartsOnLabel: 'Sunday',
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

  it('blocks a conflicting payroll category even if the underlying row was marked ready', () => {
    const mixedCategoryReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        mixedPayrollCategories: true,
      }],
    }

    expect(payrollLockBlocker(mixedCategoryReview)).toContain('conflicting Regular, EP, or TRUEP')
    expect(payrollReadinessPercent(mixedCategoryReview)).toBe(0)
    expect(exportableWorkedTimeRows(mixedCategoryReview.rows)).toHaveLength(0)
  })

  it('blocks a failed server reconciliation with actionable reasons', () => {
    const failedReconciliationReview: TimekeepingReview = {
      ...cleanReview,
      reconciliation: {
        categoryMinutesMatchPaid: false,
        configurationVersion: 1,
        duplicateOccurrenceCount: 2,
        epMinutes: 0,
        overtimeMinutes: 60,
        paidMinutes: 480,
        passed: false,
        policyVersion: 'payroll-batch-v1',
        regularCategoryMinutes: 420,
        regularMinutes: 360,
        regularPlusOvertimeMatchesPaid: false,
        rowCount: 2,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        uniqueOccurrenceCount: 1,
        unresolvedAssignmentCount: 1,
      },
    }

    const blocker = payrollLockBlocker(failedReconciliationReview)

    expect(blocker).toContain('Regular, EP, TRUEP, and legacy-unclassified minutes do not equal paid minutes')
    expect(blocker).toContain('regular plus overtime minutes do not equal paid minutes')
    expect(blocker).toContain('2 duplicate worked-time occurrences')
    expect(blocker).toContain('1 unresolved payroll week assignment')
  })

  it('blocks locking when payroll-week allocations do not reconcile to selected-range paid minutes', () => {
    const allocationMismatchReview: TimekeepingReview = {
      ...cleanReview,
      reconciliation: {
        categoryMinutesMatchPaid: true,
        configurationVersion: 2,
        duplicateOccurrenceCount: 0,
        epMinutes: 0,
        overtimeMinutes: 0,
        paidMinutes: 480,
        passed: false,
        payrollWeekAllocationsMatchPaid: false,
        policyVersion: 'payroll-batch-v2',
        regularCategoryMinutes: 480,
        regularMinutes: 480,
        regularPlusOvertimeMatchesPaid: true,
        rowCount: 1,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        uniqueOccurrenceCount: 1,
        unresolvedAssignmentCount: 0,
      },
    }

    expect(payrollLockBlocker(allocationMismatchReview)).toBe(
      'Payroll reconciliation failed: payroll-week allocation minutes do not reconcile to the selected-range paid minutes. Resolve these issues before locking payroll.',
    )
  })

  it('names paid minutes that still need a payroll category', () => {
    const failedClassificationReview: TimekeepingReview = {
      ...cleanReview,
      reconciliation: {
        categoryMinutesMatchPaid: true,
        configurationVersion: 1,
        duplicateOccurrenceCount: 0,
        epMinutes: 0,
        overtimeMinutes: 0,
        paidMinutes: 75,
        passed: false,
        policyVersion: 'payroll-batch-v1',
        regularCategoryMinutes: 0,
        regularMinutes: 75,
        regularPlusOvertimeMatchesPaid: true,
        rowCount: 1,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 75,
        uniqueOccurrenceCount: 1,
        unresolvedAssignmentCount: 0,
      },
    }

    expect(payrollLockBlocker(failedClassificationReview)).toContain(
      '75 paid minutes still need a Regular, EP, or TRUEP classification',
    )
  })

  it('does not reject a historical review solely because reconciliation metadata is absent', () => {
    expect(cleanReview.reconciliation).toBeUndefined()
    expect(payrollLockBlocker(cleanReview)).toBe('')
  })

  it('keeps an unresolved live category unclassified instead of defaulting it to Regular', () => {
    const unresolvedReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        payrollCategory: null,
        payrollCategoryLabel: 'Unclassified',
        payrollCategoryResolved: false,
        payrollReady: false,
        reviewStatus: 'unresolved',
      }],
      summary: {
        ...cleanReview.summary,
        exceptionCount: 1,
        readyCount: 0,
        regularCategoryMinutes: 0,
        unclassifiedCategoryMinutes: 480,
      },
    }

    const review = workedTimePayrollReview(unresolvedReview)

    expect(review?.rows[0].payrollCategory).toBeNull()
    expect(review?.summary.regularCategoryMinutes).toBe(0)
    expect(review?.summary.unclassifiedCategoryMinutes).toBe(480)
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

  it('excludes salaried punch rows from hourly payroll totals and blockers', () => {
    const salaryPunchReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        employmentType: 'salary',
        exceptionCodes: ['multiple_work_segments'],
        overtimeMinutes: 480,
        payrollReady: false,
        regularMinutes: 0,
      }],
      summary: {
        ...cleanReview.summary,
        exceptionCount: 1,
        overtimeMinutes: 480,
        readyCount: 0,
      },
    }

    expect(workedTimePayrollReview(salaryPunchReview)?.summary).toMatchObject({
      exceptionCount: 0,
      overtimeMinutes: 0,
      paidMinutes: 0,
      rowCount: 0,
    })
    expect(exportableWorkedTimeRows(salaryPunchReview.rows)).toHaveLength(0)
    expect(payrollLockBlocker(salaryPunchReview)).toContain('no SygShift clock-in/out')
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

  it('reconciles category totals independently from overtime without double counting', () => {
    const rows: TimekeepingReview['rows'] = [
      {
        ...cleanReview.rows[0],
        grossMinutes: 1920,
        paidMinutes: 1920,
        payrollBatchWeekEndsOn: '2026-07-18',
        payrollBatchWeekStartsOn: '2026-07-12',
        regularMinutes: 1920,
      },
      {
        ...cleanReview.rows[0],
        firstClockIn: '2026-07-13T14:00:00.000Z',
        grossMinutes: 480,
        lastClockOut: '2026-07-13T22:00:00.000Z',
        operationalDate: '2026-07-13',
        paidMinutes: 480,
        payrollBatchWeekEndsOn: '2026-07-18',
        payrollBatchWeekStartsOn: '2026-07-12',
        payrollCategory: 'ep',
        payrollCategoryLabel: 'EP',
        regularMinutes: 480,
      },
      {
        ...cleanReview.rows[0],
        firstClockIn: '2026-07-14T14:00:00.000Z',
        grossMinutes: 480,
        lastClockOut: '2026-07-14T22:00:00.000Z',
        operationalDate: '2026-07-14',
        overtimeMinutes: 480,
        paidMinutes: 480,
        payrollBatchWeekEndsOn: '2026-07-18',
        payrollBatchWeekStartsOn: '2026-07-12',
        payrollCategory: 'truep',
        payrollCategoryLabel: 'TRUEP',
        regularMinutes: 0,
      },
    ]
    const review: TimekeepingReview = {
      ...cleanReview,
      rows,
      summary: {
        ...cleanReview.summary,
        epMinutes: 480,
        grossMinutes: 2880,
        overtimeMinutes: 480,
        paidMinutes: 2880,
        readyCount: 3,
        regularCategoryMinutes: 1920,
        regularMinutes: 2400,
        rowCount: 3,
        truepMinutes: 480,
      },
    }

    const summary = summarizePayrollWorkbookByWeek({ exportType: 'Preview', review })[0]?.summaries[0]

    expect(summary).toMatchObject({
      epMinutes: 480,
      overtimeMinutes: 480,
      paidMinutes: 2880,
      regularCategoryMinutes: 1920,
      regularMinutes: 2400,
      truepMinutes: 480,
      unclassifiedCategoryMinutes: 0,
    })
    expect((summary?.regularCategoryMinutes ?? 0) + (summary?.epMinutes ?? 0) + (summary?.truepMinutes ?? 0)).toBe(summary?.paidMinutes)
    expect((summary?.regularMinutes ?? 0) + (summary?.overtimeMinutes ?? 0)).toBe(summary?.paidMinutes)
  })

  it('keeps an old locked row without a stored category visibly unclassified in the workbook', () => {
    const legacyReview: TimekeepingReview = {
      ...cleanReview,
      rows: [{
        ...cleanReview.rows[0],
        payrollCategory: undefined,
        payrollCategoryLabel: undefined,
      }],
    }

    const sheets = buildPayrollWorkbookSheets({ exportType: 'Official Locked', review: legacyReview })
    const summary = sheets.find((sheet) => sheet.name === 'Payroll Summary')
    const summaryHeaderIndex = summary?.rows.findIndex((row) => row[0] === 'Employee') ?? -1
    const summaryRow = summary?.rows[summaryHeaderIndex + 1]
    const weekOneDetail = sheets.find((sheet) => sheet.name === 'Week 1 Detail')
    const detailRow = weekOneDetail?.rows.find((row) => row[0] === cleanReview.rows[0].employeeName)

    expect(summaryRow?.[7]).toBe(0)
    expect(summaryRow?.[10]).toBe(8)
    expect(detailRow?.[5]).toBe('Legacy / unclassified')
    expect(detailRow?.[13]).toBe(0)
    expect(detailRow?.[16]).toBe(8)
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
    for (const sheet of sheets) {
      if (sheet.columnWidths) {
        expect(Math.max(...sheet.rows.map((row) => row.length))).toBeLessThanOrEqual(sheet.columnWidths.length)
      }
    }
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    expect(summaryHeaderIndex).toBeGreaterThan(0)
    expect(sheets[0].rows[summaryHeaderIndex]).toEqual([
      'Employee',
      'Employment',
      'Payroll Week',
      'Week Dates',
      'Worked Shifts',
      'Scheduled Hours',
      'Total Worked Hours',
      'Regular Hours',
      'EP Hours',
      'TRUEP Hours',
      'Legacy Unclassified Hours',
      'Paid Training Hours',
      'Non-Overtime Hours',
      'Overtime Hours',
      'Sick Pay Hours',
      'PTO Hours',
      'Other Paid Hours',
      'Total Payable',
      'SygShift Review Status',
    ])
    expect(sheets[0].rows).toContainEqual([
      'Rounding Basis',
      'SygShift aggregates exact whole minutes first, then displays hours rounded to two decimals. Do not add displayed row values to reconstruct totals.',
    ])
    expect(sheets[0].rows).toContainEqual([
      'Status Meaning',
      'SygShift Review Status describes source-record readiness inside SygShift; it is not an iSolved submission, approval, or payment status.',
    ])
    expect(sheets[0].rows.every((row) => row.length <= 19)).toBe(true)
    const employeeHeader = sheets.at(-1)?.rows.find((row) => row[0] === 'Employee' && row[1] === 'Employee ID')
    expect(employeeHeader).toEqual([
      'Employee',
      'Employee ID',
      'Username',
      'Work Date',
      'Site / Post',
      'Time Category',
      'Payroll Category',
      'Scheduled Start',
      'Scheduled End',
      'Actual Clock In',
      'Actual Clock Out',
      'Total Worked Hours',
      'Regular Hours',
      'EP Hours',
      'TRUEP Hours',
      'Legacy Unclassified Hours',
      'Payroll Batch Week',
      'Payroll Period',
      'Non-Overtime Hours',
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
      review: {
        ...cleanReview,
        rows: cleanReview.rows.map((row, index) => index === 0
          ? { ...row, employeeName: `Jordan & <Payroll>${String.fromCharCode(1)}` }
          : row),
      },
    })
    const packageText = new TextDecoder().decode(await workbook.arrayBuffer())
    const worksheetDocuments = packageText.match(/<worksheet[\s\S]*?<\/worksheet>/g) ?? []
    const parser = new DOMParser()

    expect(worksheetDocuments.length).toBeGreaterThan(0)
    for (const worksheet of worksheetDocuments) {
      const document = parser.parseFromString(worksheet, 'application/xml')
      expect(document.querySelector('parsererror')).toBeNull()
      expect(worksheet).not.toContain(String.fromCharCode(1))
      const filterIndex = worksheet.indexOf('<autoFilter')
      const mergeIndex = worksheet.indexOf('<mergeCells')
      if (filterIndex >= 0 && mergeIndex >= 0) expect(filterIndex).toBeLessThan(mergeIndex)
    }
    expect(packageText).toContain('Jordan &amp; &lt;Payroll&gt;')
  })

  it('packages production-sized payroll workbooks without overflowing the browser call stack', async () => {
    const sourceRow = cleanReview.rows[0]
    const rows = Array.from({ length: 1_200 }, (_, index) => ({
      ...sourceRow,
      payrollOccurrenceKey: `large-payroll-occurrence-${index + 1}`,
    }))
    const review: TimekeepingReview = {
      ...cleanReview,
      rows,
      summary: {
        ...cleanReview.summary,
        grossMinutes: sourceRow.grossMinutes * rows.length,
        paidMinutes: sourceRow.paidMinutes * rows.length,
        readyCount: rows.length,
        regularMinutes: sourceRow.regularMinutes * rows.length,
        rowCount: rows.length,
      },
    }

    const workbook = createPayrollWorkbookBlob({ exportType: 'Preview', review })
    const bytes = new Uint8Array(await workbook.arrayBuffer())

    expect(workbook.size).toBeGreaterThan(500_000)
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  }, 15_000)

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

  it('provides the same separate weekly employee totals used by the browser and workbook', () => {
    const groups = summarizePayrollWorkbookByWeek({ exportType: 'Preview', review: cleanReview })
    const weekOne = groups[0]?.summaries.find((summary) => summary.employeeId === cleanReview.rows[0]?.employeeId)
    const weekTwo = groups[1]?.summaries.find((summary) => summary.employeeId === cleanReview.rows[0]?.employeeId)

    expect(groups.map((group) => group.week.label)).toEqual(['Week 1', 'Week 2'])
    expect(weekOne).toMatchObject({ hasActivity: true, paidMinutes: 480, workedShiftCount: 1 })
    expect(weekTwo).toMatchObject({ hasActivity: false, paidMinutes: 0, workedShiftCount: 0 })
  })

  it('omits inactive employee-week placeholders while retaining EP and TRUEP week and pay-period totals', () => {
    const weekOneEpRow: TimekeepingReview['rows'][number] = {
      ...cleanReview.rows[0],
      grossMinutes: 120,
      paidMinutes: 120,
      payrollCategory: 'ep',
      payrollCategoryLabel: 'EP',
      regularMinutes: 120,
    }
    const weekTwoTruepRow: TimekeepingReview['rows'][number] = {
      ...cleanReview.rows[0],
      employeeId: '73000000-0000-4000-8000-000000000002',
      employeeName: 'Jade Baptist',
      firstClockIn: '2026-07-20T14:00:00.000Z',
      grossMinutes: 180,
      lastClockOut: '2026-07-20T17:00:00.000Z',
      operationalDate: '2026-07-20',
      paidMinutes: 180,
      payrollAssignmentAnchor: '2026-07-20T14:00:00.000Z',
      payrollBatchWeekEndsOn: '2026-07-25',
      payrollBatchWeekStartsOn: '2026-07-19',
      payrollCategory: 'truep',
      payrollCategoryLabel: 'TRUEP',
      payrollOccurrenceKey: 'shift:73000000-0000-4000-8000-000000000020:employee:73000000-0000-4000-8000-000000000002',
      regularMinutes: 180,
      username: 'jbaptist',
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      rows: [weekOneEpRow, weekTwoTruepRow],
      summary: {
        ...cleanReview.summary,
        epMinutes: 120,
        grossMinutes: 300,
        paidMinutes: 300,
        readyCount: 2,
        regularCategoryMinutes: 0,
        regularMinutes: 300,
        rowCount: 2,
        truepMinutes: 180,
      },
    }

    const summary = buildPayrollWorkbookSheets({ exportType: 'Preview', review })[0]
    const headerIndex = summary.rows.findIndex((row) => row[0] === 'Employee')
    const bodyAndTotals = summary.rows.slice(headerIndex + 1)
    const employeeRows = bodyAndTotals.filter((row) => !String(row[0]).endsWith(' totals'))
    const weekOneTotal = bodyAndTotals.find((row) => row[0] === 'Week 1 totals')
    const weekTwoTotal = bodyAndTotals.find((row) => row[0] === 'Week 2 totals')
    const payPeriodTotal = bodyAndTotals.find((row) => row[0] === 'Pay period totals')

    expect(employeeRows.map((row) => [row[0], row[2], row[8], row[9]])).toEqual([
      ['Jordan Brown', 'Week 1', 2, 0],
      ['Jade Baptist', 'Week 2', 0, 3],
    ])
    expect(bodyAndTotals.some((row) => row[0] === 'Employee' || row[18] === 'No activity')).toBe(false)
    expect(weekOneTotal?.slice(8, 10)).toEqual([2, 0])
    expect(weekTwoTotal?.slice(8, 10)).toEqual([0, 3])
    expect(payPeriodTotal?.slice(8, 10)).toEqual([2, 3])
    expect(payPeriodTotal?.[6]).toBe(5)
    expect(payPeriodTotal?.[17]).toBe(5)
  })

  it('keeps the workbook URL alive long enough for the browser to finish the download', () => {
    vi.useFakeTimers()
    const createObjectUrl = vi.fn(() => 'blob:sygshift-payroll-preview')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    const result = downloadPayrollWorkbook(
      { exportType: 'Preview', review: cleanReview },
      'sygshift-payroll-preview.xlsx',
    )

    expect(result.fileName).toBe('sygshift-payroll-preview.xlsx')
    expect(result.size).toBeGreaterThan(0)
    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:sygshift-payroll-preview')
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
    const employeeRows = sheets[0].rows
      .slice(summaryHeaderIndex + 1)
      .filter((row) => !String(row[0]).endsWith(' totals'))
    const weekOne = employeeRows.find((row) => row[2] === 'Week 1')

    expect(weekOne?.[2]).toBe('Week 1')
    expect(weekOne?.[6]).toBe(8)
    expect(employeeRows.some((row) => row[2] === 'Week 2')).toBe(false)
    expect(sheets.find((sheet) => sheet.name === 'Week 1 Detail')?.rows.some((row) => row[0] === 'Jordan Brown' && row[11] === 8)).toBe(true)
    expect(sheets.find((sheet) => sheet.name === 'Week 2 Detail')?.rows.some((row) => row[0] === 'Jordan Brown')).toBe(false)
  })

  it('allocates a crossing occurrence into both payroll weeks without duplicating the canonical timecard', () => {
    const overnightRow = {
      ...cleanReview.rows[0],
      breakMinutes: 0,
      crossesPayrollBoundary: true,
      firstClockIn: '2026-08-16T05:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-08-16T13:00:00.000Z',
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 480,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 480,
      occurrenceRegularCategoryMinutes: 480,
      occurrenceRegularMinutes: 480,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-08-15',
      paidMinutes: 480,
      payrollAssignmentAnchor: '2026-08-16T05:00:00.000Z',
      payrollBatchWeekEndsOn: '2026-08-15',
      payrollBatchWeekStartsOn: '2026-08-09',
      payrollPeriodEndsOn: '2026-08-22',
      payrollPeriodStartsOn: '2026-08-09',
      payrollPolicyVersion: 'payroll-batch-v2',
      payrollGroupingPolicy: 'elapsed_time_boundary_split',
      payrollWeekAllocations: [{
        allocationKey: 'shift:73000000-0000-4000-8000-000000000010:employee:73000000-0000-4000-8000-000000000001|2026-08-09',
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 60,
        overtimeMinutes: 0,
        paidMinutes: 60,
        regularCategoryMinutes: 60,
        regularMinutes: 60,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-15',
        weekStartsOn: '2026-08-09',
      }, {
        allocationKey: 'shift:73000000-0000-4000-8000-000000000010:employee:73000000-0000-4000-8000-000000000001|2026-08-16',
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 420,
        overtimeMinutes: 0,
        paidMinutes: 420,
        regularCategoryMinutes: 420,
        regularMinutes: 420,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-22',
        weekStartsOn: '2026-08-16',
      }],
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
    const summary = sheets[0]
    const summaryHeaderIndex = summary.rows.findIndex((row) => row[0] === 'Employee')
    const summaryRows = summary.rows.slice(summaryHeaderIndex + 1)

    expect(summaryRows.find((row) => row[0] === 'Jordan Brown' && row[2] === 'Week 1')?.[6]).toBe(1)
    expect(summaryRows.find((row) => row[0] === 'Jordan Brown' && row[2] === 'Week 2')?.[6]).toBe(7)
    expect(summaryRows.find((row) => row[0] === 'Pay period totals')?.[4]).toBe(1)
    expect(summaryRows.find((row) => row[0] === 'Pay period totals')?.[6]).toBe(8)

    const weekOneDetail = sheets.find((sheet) => sheet.name === 'Week 1 Detail')!
    const weekTwoDetail = sheets.find((sheet) => sheet.name === 'Week 2 Detail')!
    expect(weekOneDetail.rows.some((row) => row[0] === 'Jordan Brown' && row[4] === 'Worked-time allocation' && row[12] === 1)).toBe(true)
    expect(weekTwoDetail.rows.some((row) => row[0] === 'Jordan Brown' && row[4] === 'Worked-time allocation' && row[12] === 7)).toBe(true)

    const employeeSheet = sheets.at(-1)!
    expect(employeeSheet.rows.filter((row) => row[0] === 'Jordan Brown')).toHaveLength(1)
    expect(employeeSheet.rows.find((row) => row[0] === 'Jordan Brown')?.[11]).toBe(8)
    expect(String(employeeSheet.rows.find((row) => row[0] === 'Jordan Brown')?.[16])).toContain('1 hrs')
    expect(String(employeeSheet.rows.find((row) => row[0] === 'Jordan Brown')?.[16])).toContain('7 hrs')
  })

  it('regenerates a locked Sunday workbook from stored allocations when live rules changed', () => {
    const occurrenceKey = cleanReview.rows[0].payrollOccurrenceKey
    const lockedRow: TimekeepingReview['rows'][number] = {
      ...cleanReview.rows[0],
      breakMinutes: 0,
      crossesPayrollBoundary: true,
      timeZone: 'America/New_York',
      firstClockIn: '2026-08-16T05:00:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-08-16T13:00:00.000Z',
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 480,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 480,
      occurrenceRegularCategoryMinutes: 480,
      occurrenceRegularMinutes: 480,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-08-15',
      paidMinutes: 480,
      payrollBatchWeekEndsOn: '2026-08-15',
      payrollBatchWeekStartsOn: '2026-08-09',
      payrollConfigurationVersion: 2,
      payrollGroupingPolicy: 'elapsed_time_boundary_split',
      payrollPolicyVersion: 'payroll-batch-v2',
      payrollWeekAllocations: [{
        allocationKey: `${occurrenceKey}|2026-08-09`,
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 60,
        overtimeMinutes: 0,
        paidMinutes: 60,
        regularCategoryMinutes: 60,
        regularMinutes: 60,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-15',
        weekStartsOn: '2026-08-09',
      }, {
        allocationKey: `${occurrenceKey}|2026-08-16`,
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 420,
        overtimeMinutes: 0,
        paidMinutes: 420,
        regularCategoryMinutes: 420,
        regularMinutes: 420,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-22',
        weekStartsOn: '2026-08-16',
      }],
      regularMinutes: 480,
      scheduledEndsAt: '2026-08-16T13:00:00.000Z',
      scheduledStartsAt: '2026-08-16T05:00:00.000Z',
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      fromDate: '2026-08-09',
      rows: [lockedRow],
      throughDate: '2026-08-22',
    }
    const changedLiveRules: PayrollRules = {
      ...sundayPayrollRules,
      crossBoundaryGroupingPolicy: 'scheduled_shift_start',
      payrollCalculationPolicyVersion: 'future-live-policy',
      payrollConfigurationVersion: 99,
      payrollWeekStartTime: '04:00:00',
      weekStartsOn: 1,
      weekStartsOnLabel: 'Monday',
    }
    const input = {
      accountabilityEvents: [{
        ...sickEvent,
        employeeId: lockedRow.employeeId,
        employeeName: lockedRow.employeeName,
        endsAt: '2026-08-16T16:00:00.000Z',
        operationalDate: '2026-08-16',
        startsAt: '2026-08-16T14:00:00.000Z',
        username: lockedRow.username,
      }],
      batch: {
        createdAt: '2026-08-23T14:00:00.000Z',
        createdBy: '73000000-0000-4000-8000-000000000001',
        createdByName: 'Jordan Brown',
        digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        fromDate: '2026-08-09',
        grossMinutes: 480,
        id: '73000000-0000-4000-8000-000000000020',
        note: 'Locked Sunday payroll batch.',
        paidMinutes: 480,
        rowCount: 1,
        throughDate: '2026-08-22',
      },
      exportType: 'Official Locked' as const,
      review,
      rules: changedLiveRules,
    }

    expect(payrollWorkbookWeeks(input)).toEqual([
      { label: 'Week 1', weekEndsOn: '2026-08-15', weekStartsOn: '2026-08-09' },
      { label: 'Week 2', weekEndsOn: '2026-08-22', weekStartsOn: '2026-08-16' },
    ])
    const sheets = buildPayrollWorkbookSheets(input)
    expect(sheets[0].rows).toContainEqual([
      'Calculation Policy',
      'payroll-batch-v2 / configuration 2 (stored with locked row)',
    ])
    expect(sheets[0].rows.find((row) => row[0] === 'Payroll Rules')?.[1]).toContain('Time zone: America/Denver')
    expect(sheets.find((sheet) => sheet.name === 'Week 1 Detail')?.rows
      .find((row) => row[0] === 'Jordan Brown')?.[11]).toBe(1)
    expect(sheets.find((sheet) => sheet.name === 'Week 2 Detail')?.rows
      .find((row) => row[0] === 'Jordan Brown')?.[11]).toBe(7)
    const summaryHeaderIndex = sheets[0].rows.findIndex((row) => row[0] === 'Employee')
    expect(sheets[0].rows.slice(summaryHeaderIndex + 1)
      .find((row) => row[0] === 'Jordan Brown' && row[2] === 'Week 2')?.[14]).toBe(2)
  })

  it('does not emit a phantom worked row for a zero-paid boundary allocation', () => {
    const occurrenceKey = cleanReview.rows[0].payrollOccurrenceKey
    const row: TimekeepingReview['rows'][number] = {
      ...cleanReview.rows[0],
      breakMinutes: 30,
      crossesPayrollBoundary: true,
      firstClockIn: '2026-08-16T05:30:00.000Z',
      grossMinutes: 480,
      lastClockOut: '2026-08-16T13:30:00.000Z',
      occurrenceBreakMinutes: 30,
      occurrenceGrossMinutes: 480,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 450,
      occurrenceRegularCategoryMinutes: 450,
      occurrenceRegularMinutes: 450,
      occurrenceUnpaidGapMinutes: 0,
      operationalDate: '2026-08-15',
      paidMinutes: 450,
      payrollConfigurationVersion: 2,
      payrollGroupingPolicy: 'elapsed_time_boundary_split',
      payrollPolicyVersion: 'payroll-batch-v2',
      payrollWeekAllocations: [{
        allocationKey: `${occurrenceKey}|2026-08-09`,
        breakMinutes: 30,
        epMinutes: 0,
        grossMinutes: 30,
        overtimeMinutes: 0,
        paidMinutes: 0,
        regularCategoryMinutes: 0,
        regularMinutes: 0,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-15',
        weekStartsOn: '2026-08-09',
      }, {
        allocationKey: `${occurrenceKey}|2026-08-16`,
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: 450,
        overtimeMinutes: 0,
        paidMinutes: 450,
        regularCategoryMinutes: 450,
        regularMinutes: 450,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-22',
        weekStartsOn: '2026-08-16',
      }],
      regularMinutes: 450,
      scheduledEndsAt: '2026-08-16T13:30:00.000Z',
      scheduledStartsAt: '2026-08-16T05:30:00.000Z',
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      fromDate: '2026-08-09',
      rows: [row],
      throughDate: '2026-08-22',
    }
    const sheets = buildPayrollWorkbookSheets({ exportType: 'Preview', review, rules: sundayPayrollRules })
    const summaryHeaderIndex = sheets[0].rows.findIndex((item) => item[0] === 'Employee')
    const summaryRows = sheets[0].rows.slice(summaryHeaderIndex + 1)

    expect(summaryRows.find((item) => item[0] === 'Jordan Brown' && item[2] === 'Week 1')?.slice(4, 7)).toEqual([0, 0.5, 0])
    expect(summaryRows.find((item) => item[0] === 'Week 1 totals')?.[5]).toBe(0.5)
    expect(summaryRows.find((item) => item[0] === 'Jordan Brown' && item[2] === 'Week 2')?.slice(4, 7)).toEqual([1, 7.5, 7.5])
    expect(summaryRows.find((item) => item[0] === 'Pay period totals')?.[4]).toBe(1)
    expect(sheets.find((sheet) => sheet.name === 'Week 1 Detail')?.rows
      .some((item) => item[0] === 'Jordan Brown')).toBe(false)
    expect(sheets.find((sheet) => sheet.name === 'Week 2 Detail')?.rows
      .some((item) => item[0] === 'Jordan Brown' && item[12] === 7.5)).toBe(true)
  })

  it.each([
    {
      edge: 'start edge',
      expectedScheduledMinutes: 420,
      fromDate: '2026-08-10',
      scheduledEndsAt: '2026-08-10T13:00:00.000Z',
      scheduledStartsAt: '2026-08-10T05:00:00.000Z',
      throughDate: '2026-08-15',
    },
    {
      edge: 'end edge',
      expectedScheduledMinutes: 60,
      fromDate: '2026-08-09',
      scheduledEndsAt: '2026-08-16T13:00:00.000Z',
      scheduledStartsAt: '2026-08-16T05:00:00.000Z',
      throughDate: '2026-08-15',
    },
  ])('clips scheduled comparison minutes at the selected range $edge', ({
    expectedScheduledMinutes,
    fromDate,
    scheduledEndsAt,
    scheduledStartsAt,
    throughDate,
  }) => {
    const occurrenceKey = cleanReview.rows[0].payrollOccurrenceKey
    const paidMinutes = expectedScheduledMinutes - 30
    const row: TimekeepingReview['rows'][number] = {
      ...cleanReview.rows[0],
      breakMinutes: 0,
      firstClockIn: scheduledStartsAt,
      grossMinutes: paidMinutes,
      lastClockOut: scheduledEndsAt,
      occurrenceBreakMinutes: 0,
      occurrenceGrossMinutes: 480,
      occurrenceOvertimeMinutes: 0,
      occurrencePaidMinutes: 480,
      occurrenceRegularCategoryMinutes: 480,
      occurrenceRegularMinutes: 480,
      occurrenceUnpaidGapMinutes: 0,
      paidMinutes,
      payrollBatchWeekEndsOn: '2026-08-15',
      payrollBatchWeekStartsOn: '2026-08-09',
      payrollConfigurationVersion: 2,
      payrollGroupingPolicy: 'elapsed_time_boundary_split',
      payrollPolicyVersion: 'payroll-batch-v2',
      payrollWeekAllocations: [{
        allocationKey: `${occurrenceKey}|2026-08-09`,
        breakMinutes: 0,
        epMinutes: 0,
        grossMinutes: paidMinutes,
        overtimeMinutes: 0,
        paidMinutes,
        regularCategoryMinutes: paidMinutes,
        regularMinutes: paidMinutes,
        truepMinutes: 0,
        unclassifiedCategoryMinutes: 0,
        unpaidGapMinutes: 0,
        weekEndsOn: '2026-08-15',
        weekStartsOn: '2026-08-09',
      }],
      regularMinutes: paidMinutes,
      scheduledEndsAt,
      scheduledStartsAt,
    }
    const review: TimekeepingReview = {
      ...cleanReview,
      fromDate,
      rows: [row],
      throughDate,
    }
    const summary = summarizePayrollWorkbookByWeek({
      exportType: 'Preview',
      review,
      rules: sundayPayrollRules,
    })[0]?.summaries[0]

    expect(summary?.scheduledMinutes).toBe(expectedScheduledMinutes)
    const sheets = buildPayrollWorkbookSheets({ exportType: 'Preview', review, rules: sundayPayrollRules })
    const varianceRow = sheets.find((sheet) => sheet.name === 'Hours Variance')?.rows
      .find((item) => item[0] === 'Jordan Brown')
    expect(varianceRow?.[3]).toBe(expectedScheduledMinutes / 60)
    expect(varianceRow?.[5]).toBe(-0.5)
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
    const employeeRows = sheets[0].rows
      .slice(summaryHeaderIndex + 1)
      .filter((row) => !String(row[0]).endsWith(' totals'))

    expect(employeeRows.some((row) => row[2] === 'Week 1')).toBe(false)
    expect(employeeRows.find((row) => row[2] === 'Week 2')?.[6]).toBe(8)
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

    expect(weekOne?.slice(6, 19)).toEqual([8, 8, 0, 0, 0, 0, 8, 0, 0, 0, 0, 8, 'Ready'])
    expect(weekTwo?.slice(6, 19)).toEqual([8, 8, 0, 0, 0, 0, 6, 2, 2, 0, 0, 10, 'Ready'])
  })
})

import type {
  PayrollExportBatch,
  PayrollRules,
  TimekeepingDashboard,
  TimekeepingReview,
  TimekeepingReviewRow,
  TimeMaintenance,
  TimeMaintenanceEvent,
} from '../data/timekeeping'
import { activeTimeState } from '../data/timekeeping'
import type { SessionContext } from '../data/auth'
import { DEFAULT_TIME_RULES, TIME_RISK_THRESHOLDS, currentPayrollPeriod, type TimePeriod } from './timeRules'
import { workedTimePayrollReview } from './timePayroll'
export { canExportPayroll, canViewTeamTime } from './timePermissions'

export type TimeCommandRoleMode = 'employee' | 'salary' | 'operations' | 'admin'

export interface TimeCommandCenterModel {
  clockedIn: {
    atScheduledLocation: number
    atUnexpectedLocation: number
    count: number
    longShiftCount: number
  }
  exceptions: {
    adminAction: number
    awaitingEmployeeOrSupervisor: number
    highPriority: number
    total: number
  }
  missingPunches: {
    correctionsAwaitingReview: number
    incompleteShifts: number
    missingClockIns: number
    missingClockOuts: number
  }
  overtimeRisk: {
    alreadyInOvertime: number
    approachingDaily: number
    approachingWeekly: number
    projected: null
  }
  payrollReadiness: {
    awaitingApproval: number
    blocked: number
    percent: number | null
    ready: number
    total: number
    unresolvedExceptions: number
  }
  period: TimePeriod
  roleMode: TimeCommandRoleMode
  self: {
    clockState: ReturnType<typeof activeTimeState>
    displayName: string
    employmentType: string
    pendingCorrections: number
    todayPaidMinutes: number
    payPeriodPaidMinutes: number
    weeklyPaidMinutes: number
  }
}

export function commandRoleMode(session: SessionContext | null | undefined, dashboard: TimekeepingDashboard | null | undefined): TimeCommandRoleMode {
  const role = session?.role ?? dashboard?.employee.role
  if (role === 'admin') return 'admin'
  if (role && ['dispatcher', 'scheduler', 'supervisor'].includes(role)) return 'operations'
  if (dashboard?.employee.employmentType === 'salary') return 'salary'
  return 'employee'
}

export function buildTimeCommandCenterModel(input: {
  dashboard: TimekeepingDashboard
  exportHistory?: PayrollExportBatch[]
  maintenance?: TimeMaintenance
  payrollRules?: PayrollRules
  review?: TimekeepingReview
  session?: SessionContext | null
}): TimeCommandCenterModel {
  const period = currentPayrollPeriod(undefined, input.payrollRules)
  const rows = input.review?.rows ?? []
  const workedReview = workedTimePayrollReview(input.review)
  const latestExport = input.exportHistory?.find((batch) => batch.fromDate === period.fromDate && batch.throughDate === period.throughDate)
  const periodStatus = latestExport ? 'exported' : period.status
  const selfRows = rows.filter((row) => row.employeeId === input.dashboard.employee.id)
  const todayRows = selfRows.filter((row) => row.operationalDate === input.dashboard.operationalDate)

  return {
    clockedIn: summarizeClockedIn(input.maintenance),
    exceptions: summarizeExceptions(workedReview),
    missingPunches: summarizeMissingPunches(workedReview),
    overtimeRisk: summarizeOvertimeRisk(workedReview),
    payrollReadiness: summarizePayrollReadiness(workedReview),
    period: {
      ...period,
      status: periodStatus,
    },
    roleMode: commandRoleMode(input.session, input.dashboard),
    self: {
      clockState: activeTimeState(input.dashboard.lastEvent),
      displayName: input.dashboard.employee.displayName,
      employmentType: input.dashboard.employee.employmentType,
      payPeriodPaidMinutes: sumMinutes(selfRows),
      pendingCorrections: input.dashboard.pendingCorrectionCount,
      todayPaidMinutes: sumMinutes(todayRows),
      weeklyPaidMinutes: sumWeeklyMinutes(selfRows, input.dashboard.operationalDate),
    },
  }
}

function summarizePayrollReadiness(review?: TimekeepingReview): TimeCommandCenterModel['payrollReadiness'] {
  if (!review) {
    return {
      awaitingApproval: 0,
      blocked: 0,
      percent: null,
      ready: 0,
      total: 0,
      unresolvedExceptions: 0,
    }
  }

  const total = review.summary.rowCount
  return {
    awaitingApproval: review.summary.pendingCorrectionCount,
    blocked: Math.max(0, total - review.summary.readyCount),
    percent: total > 0 ? Math.round((review.summary.readyCount / total) * 100) : null,
    ready: review.summary.readyCount,
    total,
    unresolvedExceptions: review.summary.exceptionCount,
  }
}

function summarizeExceptions(review?: TimekeepingReview): TimeCommandCenterModel['exceptions'] {
  if (!review) return { adminAction: 0, awaitingEmployeeOrSupervisor: 0, highPriority: 0, total: 0 }
  const uniqueRows = review.rows.filter((row) => row.exceptionCodes.length > 0)
  return {
    adminAction: review.pendingCorrections.length,
    awaitingEmployeeOrSupervisor: uniqueRows.filter((row) => row.exceptionCodes.includes('missing_clock_out') || row.exceptionCodes.includes('missing_clock_in')).length,
    highPriority: uniqueRows.filter((row) => row.exceptionCodes.includes('invalid_sequence') || row.exceptionCodes.includes('missing_clock_out')).length,
    total: uniqueRows.length + review.pendingCorrections.length,
  }
}

function summarizeMissingPunches(review?: TimekeepingReview): TimeCommandCenterModel['missingPunches'] {
  if (!review) {
    return {
      correctionsAwaitingReview: 0,
      incompleteShifts: 0,
      missingClockIns: 0,
      missingClockOuts: 0,
    }
  }

  const missingClockIns = countRowsWithException(review.rows, 'missing_clock_in')
  const missingClockOuts = countRowsWithException(review.rows, 'missing_clock_out')
  return {
    correctionsAwaitingReview: review.pendingCorrections.length,
    incompleteShifts: missingClockIns + missingClockOuts,
    missingClockIns,
    missingClockOuts,
  }
}

function summarizeOvertimeRisk(review?: TimekeepingReview): TimeCommandCenterModel['overtimeRisk'] {
  if (!review) return { alreadyInOvertime: 0, approachingDaily: 0, approachingWeekly: 0, projected: null }
  const weekTotals = new Map<string, number>()
  for (const row of review.rows) {
    const weekKey = `${row.employeeId}:${row.weekStartsOn ?? row.operationalDate}`
    weekTotals.set(weekKey, (weekTotals.get(weekKey) ?? 0) + row.paidMinutes)
  }
  return {
    alreadyInOvertime: review.rows.filter((row) => row.overtimeMinutes > 0).length,
    approachingDaily: review.rows.filter((row) => row.overtimeMinutes === 0 && row.paidMinutes >= TIME_RISK_THRESHOLDS.dailyApproachingOvertimeMinutes).length,
    approachingWeekly: [...weekTotals.values()].filter((minutes) => minutes >= TIME_RISK_THRESHOLDS.weeklyApproachingOvertimeMinutes && minutes < DEFAULT_TIME_RULES.weeklyOvertimeMinutes).length,
    projected: null,
  }
}

function summarizeClockedIn(maintenance?: TimeMaintenance): TimeCommandCenterModel['clockedIn'] {
  if (!maintenance) return { atScheduledLocation: 0, atUnexpectedLocation: 0, count: 0, longShiftCount: 0 }
  const latestEvents = new Map<string, TimeMaintenanceEvent>()
  for (const event of maintenance.events) {
    const previous = latestEvents.get(event.employeeId)
    if (!previous || new Date(event.effectiveAt).getTime() > new Date(previous.effectiveAt).getTime()) {
      latestEvents.set(event.employeeId, event)
    }
  }

  const activeEvents = [...latestEvents.values()].filter((event) => ['clock_in', 'break_start', 'break_end'].includes(event.kind) && !event.voided)
  const now = new Date(maintenance.serverTimestamp).getTime()
  return {
    atScheduledLocation: activeEvents.filter((event) => Boolean(event.shiftId)).length,
    atUnexpectedLocation: activeEvents.filter((event) => !event.shiftId).length,
    count: activeEvents.length,
    longShiftCount: activeEvents.filter((event) => now - new Date(event.effectiveAt).getTime() >= 12 * 60 * 60 * 1000).length,
  }
}

function countRowsWithException(rows: TimekeepingReviewRow[], exception: TimekeepingReviewRow['exceptionCodes'][number]): number {
  return rows.filter((row) => row.exceptionCodes.includes(exception)).length
}

function sumMinutes(rows: TimekeepingReviewRow[]): number {
  return rows.reduce((total, row) => total + row.paidMinutes, 0)
}

function sumWeeklyMinutes(rows: TimekeepingReviewRow[], operationalDate: string): number {
  const activeRow = rows.find((row) => row.operationalDate === operationalDate)
  if (!activeRow?.weekStartsOn) return sumMinutes(rows)
  return sumMinutes(rows.filter((row) => row.weekStartsOn === activeRow.weekStartsOn))
}

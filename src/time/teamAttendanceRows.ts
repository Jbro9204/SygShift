import type { LiveTimeRosterRow, TeamAttendanceSummaryRow } from '../data/timekeeping'

export type TeamClockState = 'off_clock' | 'working' | 'on_break'

export interface TeamAttendanceRow {
  employeeId: string
  employeeName: string
  username: string
  employmentType: string
  role: string
  state: TeamClockState
  latestKind: TeamAttendanceSummaryRow['latestKind']
  latestEffectiveAt: string | null
  currentLocation: string
  firstClockIn: string | null
  lastClockOut: string | null
  paidMinutes: number
  breakMinutes: number
  overtimeMinutes: number
  workedSegmentCount: number
  scheduledShiftCount: number
  scheduledSummary: string
  eventCount: number
  pendingCorrectionCount: number
  hasSelectedRangeSummary: boolean
}

function liveRosterState(row: LiveTimeRosterRow | undefined): TeamClockState {
  if (!row) return 'off_clock'
  return row.status
}

function summaryLocation(row: TeamAttendanceSummaryRow, liveRow: LiveTimeRosterRow | undefined): string {
  return liveRow?.locationName
    || [row.scheduledSiteCode, row.scheduledSiteName, row.scheduledPostName ?? row.scheduledEventName].filter(Boolean).join(' / ')
    || row.scheduledLocationName
    || 'No location yet'
}

function scheduledSummary(row: TeamAttendanceSummaryRow): string {
  if (row.scheduledShiftCount === 0) return 'No scheduled shift in range'
  const location = [row.scheduledSiteCode, row.scheduledSiteName, row.scheduledPostName ?? row.scheduledEventName].filter(Boolean).join(' / ')
    || row.scheduledLocationName
    || 'Scheduled location'
  return `${row.scheduledShiftCount} scheduled · ${location}`
}

export function buildTeamRows(
  summaries: TeamAttendanceSummaryRow[],
  liveRoster: LiveTimeRosterRow[] = [],
): TeamAttendanceRow[] {
  const liveByEmployee = new Map(liveRoster.map((row) => [row.employeeId, row]))
  const summaryEmployeeIds = new Set(summaries.map((row) => row.employeeId))

  const summaryRows: TeamAttendanceRow[] = summaries.map((attendance) => {
    const liveRow = liveByEmployee.get(attendance.employeeId)
    return {
      breakMinutes: attendance.breakMinutes,
      currentLocation: summaryLocation(attendance, liveRow),
      employeeId: attendance.employeeId,
      employeeName: attendance.employeeName,
      employmentType: attendance.employmentType,
      eventCount: attendance.eventCount,
      firstClockIn: attendance.firstClockIn,
      lastClockOut: attendance.lastClockOut,
      latestEffectiveAt: attendance.latestEffectiveAt,
      latestKind: attendance.latestKind,
      overtimeMinutes: attendance.overtimeMinutes,
      paidMinutes: attendance.paidMinutes,
      pendingCorrectionCount: attendance.pendingCorrectionCount,
      role: attendance.role,
      scheduledShiftCount: attendance.scheduledShiftCount,
      scheduledSummary: scheduledSummary(attendance),
      state: liveRosterState(liveRow),
      username: attendance.username,
      workedSegmentCount: attendance.workedSegmentCount,
      hasSelectedRangeSummary: true,
    }
  })
  const liveOnlyRows: TeamAttendanceRow[] = [...liveByEmployee.values()]
    .filter((liveRow) => !summaryEmployeeIds.has(liveRow.employeeId))
    .map((liveRow) => ({
      breakMinutes: 0,
      currentLocation: liveRow.locationName,
      employeeId: liveRow.employeeId,
      employeeName: liveRow.employeeName,
      employmentType: liveRow.employmentType,
      eventCount: 0,
      firstClockIn: null,
      hasSelectedRangeSummary: false,
      lastClockOut: null,
      latestEffectiveAt: null,
      latestKind: null,
      overtimeMinutes: 0,
      paidMinutes: 0,
      pendingCorrectionCount: 0,
      role: liveRow.role,
      scheduledShiftCount: 0,
      scheduledSummary: 'No scheduled or worked time in selected range',
      state: liveRosterState(liveRow),
      username: liveRow.username,
      workedSegmentCount: 0,
    }))

  return [...summaryRows, ...liveOnlyRows].filter((row) =>
    row.eventCount > 0
    || row.workedSegmentCount > 0
    || row.paidMinutes > 0
    || row.breakMinutes > 0
    || row.overtimeMinutes > 0
    || row.pendingCorrectionCount > 0
    || row.scheduledShiftCount > 0
    || row.state !== 'off_clock',
  ).sort((left, right) => {
    const stateWeight = { working: 0, on_break: 1, off_clock: 2 }
    const stateCompare = stateWeight[left.state] - stateWeight[right.state]
    if (stateCompare !== 0) return stateCompare
    return left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' })
  })
}

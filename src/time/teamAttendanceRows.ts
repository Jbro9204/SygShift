import type { TeamAttendanceSummaryRow } from '../data/timekeeping'

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
}

function latestEventState(kind: TeamAttendanceSummaryRow['latestKind']): TeamClockState {
  if (!kind || kind === 'clock_out') return 'off_clock'
  if (kind === 'break_start') return 'on_break'
  return 'working'
}

function summaryLocation(row: TeamAttendanceSummaryRow): string {
  const liveLocation = row.latestKind && row.latestKind !== 'clock_out'
    ? [row.latestSiteCode, row.latestSiteName, row.latestPostName ?? row.latestEventName].filter(Boolean).join(' / ')
      || row.latestLocationName
    : null

  return liveLocation
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

export function buildTeamRows(summaries: TeamAttendanceSummaryRow[]): TeamAttendanceRow[] {
  return summaries.map((attendance) => ({
    breakMinutes: attendance.breakMinutes,
    currentLocation: summaryLocation(attendance),
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
    state: latestEventState(attendance.latestKind),
    username: attendance.username,
    workedSegmentCount: attendance.workedSegmentCount,
  })).filter((row) =>
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

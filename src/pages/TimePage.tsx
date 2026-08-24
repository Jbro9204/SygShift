import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Archive,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Coffee,
  Download,
  FileClock,
  FileWarning,
  History,
  LockKeyhole,
  Pencil,
  ShieldAlert,
  Timer,
  UserRound,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  activeTimeState,
  createPayrollExportBatch,
  correctTimeRecordWorkType,
  getClockableShiftChoices,
  getOwnTimekeepingReview,
  getPayrollExportHistory,
  getTeamAttendanceSummary,
  getTimeMaintenanceShiftOptions,
  shiftOptionsForOperationalDate,
  getTimeMaintenance,
  getTimekeepingDashboard,
  getTimekeepingReview,
  nextTimeEventKinds,
  payrollHours,
  recordTimeEvent,
  reviewRowsToPayrollSummaryCsv,
  reviewTimeEventCorrection,
  sortTimeMaintenanceEmployees,
  summarizePayrollRowsByEmployee,
  supervisorCorrectTimeEvent,
  supervisorRecordTimeEvent,
  supervisorUpdateTimeEventSitePost,
  supervisorUpdateTimeEventLocation,
  verifiedTimekeepingBaseline,
  type PendingCorrection,
  type PayrollExportBatch,
  type PayrollEmployeeSummary,
  type ClockableShiftChoices,
  type TeamAttendanceSummaryRow,
  type TimeMaintenanceEvent,
  type TimeMaintenanceShiftOption,
  type TimeEventKind,
  type TimekeepingDashboard,
  type TimekeepingEvent,
  type TimekeepingReview,
  type TimekeepingReviewRow,
  type TimekeepingShift,
  type TimekeepingState,
  type WorkType,
} from '../data/timekeeping'
import { getSessionContext } from '../data/auth'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatDualTime, OPERATIONAL_TIME_ZONE, operationalToday } from '../lib/time'
import { TimeCommandCenterPage } from '../time/TimeCommandCenterPage'
import { workedTimePayrollReview } from '../time/timePayroll'
import { completedPayrollPeriod } from '../time/timeRules'
import { recommendedManualPunchTimestamp } from '../time/manualPunchWorkday'
import {
  canExportPayroll as sessionCanExportPayroll,
  canManageTime as sessionCanManageTime,
  canUseOwnTimeClock,
  canViewOwnTime,
} from '../time/timePermissions'
import { applyTimeEventToCachedDashboards, refreshTimekeepingQueriesAfterPunch } from '../time/timeQuerySync'

const actionLabels: Record<TimeEventKind, string> = {
  clock_in: 'Clock in',
  break_start: 'Start break',
  break_end: 'End break',
  clock_out: 'Clock out',
}

const eventLabels: Record<TimeEventKind, string> = {
  clock_in: 'Clocked in',
  break_start: 'Break started',
  break_end: 'Break ended',
  clock_out: 'Clocked out',
}

const rowKindLabels: Record<TimekeepingReviewRow['rowKind'], string> = {
  salary_default: 'Salary default',
  time_event: 'Time clock',
}

const stateCopy: Record<TimekeepingState, { title: string; body: string }> = {
  off_clock: {
    title: 'You are currently off the clock.',
    body: 'Choose the correct assigned shift when one is available. If no shift is listed, the punch is recorded as unscheduled time for supervisor review.',
  },
  working: {
    title: 'You are clocked in.',
    body: 'You can start a break or clock out. The official time is recorded by the secure server.',
  },
  on_break: {
    title: 'You are on break.',
    body: 'End the break before clocking out so payroll can calculate the paid and unpaid time correctly.',
  },
}

function formatDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(date)
}

function payrollWeekRange(dateKey: string): { fromDate: string; throughDate: string } {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  const start = new Date(date)
  start.setDate(date.getDate() - date.getDay())
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return {
    fromDate: formatDateKey(start),
    throughDate: formatDateKey(end),
  }
}

function formatTime(value: string, timeZone = OPERATIONAL_TIME_ZONE): string {
  return formatDualTime(value, { includeTimeZoneName: true, timeZone })
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

function dateInputValue(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(new Date(value))
}

function timeInputValue(value: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
  }).formatToParts(new Date(value))
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
  return `${hour}:${minute}`
}

function zonedDateTimeToIso(dateKey: string, timeValue: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = timeValue.split(':').map(Number)
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute)
  let guess = targetUtc
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  })

  for (let index = 0; index < 3; index += 1) {
    const parts = formatter.formatToParts(new Date(guess))
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '0'
    const renderedUtc = Date.UTC(
      Number(part('year')),
      Number(part('month')) - 1,
      Number(part('day')),
      Number(part('hour')),
      Number(part('minute')),
    )
    guess += targetUtc - renderedUtc
  }

  return new Date(guess).toISOString()
}

function shortDigest(digest: string): string {
  return `${digest.slice(0, 10)}…${digest.slice(-6)}`
}

function shiftTitle(shift: TimekeepingShift): string {
  return shift.postName ?? shift.eventName ?? shift.locationName ?? 'Assigned shift'
}

function shiftLocation(shift: TimekeepingShift): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' · ') || 'Location pending'
}

function sitePostOptionTitle(option: TimeMaintenanceShiftOption): string {
  const site = [option.siteCode, option.siteName ?? option.locationName].filter(Boolean).join(' · ') || option.locationName
  const post = option.postName ?? option.eventName
  if (!post || post === site) return `${site} - Site`
  return `${site} - ${post}`
}

function sitePostOptionSchedule(option: TimeMaintenanceShiftOption): string {
  const assignedNames = option.assignedEmployees.map((employee) => employee.name).join(', ')
  const assignedText = assignedNames ? ` · assigned: ${assignedNames}` : ' · open/unassigned'
  return `${formatDate(option.startsAt)} · ${formatTime(option.startsAt, option.timeZone)} - ${formatTime(option.endsAt, option.timeZone)} · ${option.scheduleStatus} r${option.scheduleRevision}${assignedText}`
}

function activeShift(dashboard: TimekeepingDashboard): TimekeepingShift | null {
  const activeShiftId = dashboard.lastEvent?.shiftId
  if (!activeShiftId) return null
  return dashboard.eligibleShifts.find((shift) => shift.shiftId === activeShiftId) ?? null
}

function maintenanceEventLabel(event: TimeMaintenanceEvent): string {
  return eventLabels[event.kind]
}

function MaintenanceEventStatus({ event }: { event: TimeMaintenanceEvent }) {
  if (event.voided) return <span className="payroll-status payroll-status--hold">Voided</span>
  if (event.pendingCorrectionCount > 0) return <span className="payroll-status payroll-status--hold">Correction pending</span>
  if (event.latestAction === 'site_post_update') return <span className="payroll-status payroll-status--ready">Site/Post fixed</span>
  if (event.latestAction === 'time_adjust') return <span className="payroll-status payroll-status--ready">Adjusted</span>
  if (event.latestAction === 'punch_type_update') return <span className="payroll-status payroll-status--ready">Punch type fixed</span>
  if (event.latestAction === 'manual_add') return <span className="payroll-status payroll-status--ready">Manual</span>
  if (event.latestAction === 'location_update') return <span className="payroll-status payroll-status--ready">Location fixed</span>
  if (event.latestAction === 'work_type_update') return <span className="payroll-status payroll-status--ready">Time category fixed</span>
  if (event.latestAction === 'automatic_clock_out') return <span className="payroll-status payroll-status--hold">Auto clock-out</span>
  if (event.latestAction) return <span className="payroll-status payroll-status--ready">Updated</span>
  return <span className="payroll-status payroll-status--ready">Active</span>
}

export interface TimeMaintenanceFocusRequest {
  employeeId: string
  fromDate: string
  throughDate: string
  requestId: number
}

const MANUAL_SITE_POST_OPTION = '__manual_site_post__'

interface TimeMaintenanceOverviewRow {
  employeeId: string
  employeeName: string
  username: string
  employmentType: TeamAttendanceSummaryRow['employmentType']
  role: TeamAttendanceSummaryRow['role']
  latestKind: TeamAttendanceSummaryRow['latestKind']
  latestEffectiveAt: string | null
  currentLocation: string
  firstClockIn: string | null
  lastClockOut: string | null
  eventCount: number
  scheduledShiftCount: number
  scheduledSummary: string
  paidMinutes: number
  breakMinutes: number
  overtimeMinutes: number
  workedShiftCount: number
  exceptionCount: number
  pendingCorrectionCount: number
}

function maintenanceClockState(kind: TeamAttendanceSummaryRow['latestKind']): TimekeepingState {
  if (!kind || kind === 'clock_out') return 'off_clock'
  if (kind === 'break_start') return 'on_break'
  return 'working'
}

function maintenanceClockLabel(kind: TeamAttendanceSummaryRow['latestKind']): string {
  const state = maintenanceClockState(kind)
  if (state === 'working') return 'Clocked in'
  if (state === 'on_break') return 'On break'
  return 'Off clock'
}

function maintenanceSummaryLocation(row: TeamAttendanceSummaryRow): string {
  const liveLocation = row.latestKind && row.latestKind !== 'clock_out'
    ? [row.latestSiteCode, row.latestSiteName, row.latestPostName ?? row.latestEventName].filter(Boolean).join(' / ')
      || row.latestLocationName
    : null

  return liveLocation
    || [row.scheduledSiteCode, row.scheduledSiteName, row.scheduledPostName ?? row.scheduledEventName].filter(Boolean).join(' / ')
    || row.scheduledLocationName
    || 'No location in range'
}

function maintenanceScheduledSummary(row: TeamAttendanceSummaryRow): string {
  if (row.scheduledShiftCount === 0) return 'No scheduled shifts in range'
  const location = [row.scheduledSiteCode, row.scheduledSiteName, row.scheduledPostName ?? row.scheduledEventName].filter(Boolean).join(' / ')
    || row.scheduledLocationName
    || 'Scheduled location'
  return `${row.scheduledShiftCount} scheduled · ${location}`
}

function buildTimeMaintenanceOverviewRows(
  attendanceRows: TeamAttendanceSummaryRow[],
  payrollSummaries: PayrollEmployeeSummary[],
  pendingCorrections: PendingCorrection[],
): TimeMaintenanceOverviewRow[] {
  const payrollByEmployee = new Map(payrollSummaries.map((summary) => [summary.employeeId, summary]))
  const attendanceByEmployee = new Map(attendanceRows.map((row) => [row.employeeId, row]))
  const pendingByEmployee = new Map<string, number>()

  for (const correction of pendingCorrections) {
    pendingByEmployee.set(correction.employeeId, (pendingByEmployee.get(correction.employeeId) ?? 0) + 1)
  }

  const rows = new Map<string, TimeMaintenanceOverviewRow>()

  for (const attendance of attendanceRows) {
    const payroll = payrollByEmployee.get(attendance.employeeId)
    rows.set(attendance.employeeId, {
      breakMinutes: payroll?.breakMinutes ?? 0,
      currentLocation: maintenanceSummaryLocation(attendance),
      employeeId: attendance.employeeId,
      employeeName: attendance.employeeName,
      employmentType: attendance.employmentType,
      eventCount: attendance.eventCount,
      exceptionCount: payroll?.exceptionCount ?? 0,
      firstClockIn: attendance.firstClockIn,
      lastClockOut: attendance.lastClockOut,
      latestEffectiveAt: attendance.latestEffectiveAt,
      latestKind: attendance.latestKind,
      overtimeMinutes: payroll?.overtimeMinutes ?? 0,
      paidMinutes: payroll?.paidMinutes ?? 0,
      pendingCorrectionCount: pendingByEmployee.get(attendance.employeeId) ?? 0,
      role: attendance.role,
      scheduledShiftCount: attendance.scheduledShiftCount,
      scheduledSummary: maintenanceScheduledSummary(attendance),
      username: attendance.username,
      workedShiftCount: payroll?.workedShiftCount ?? 0,
    })
  }

  for (const payroll of payrollSummaries) {
    if (rows.has(payroll.employeeId)) continue
    const attendance = attendanceByEmployee.get(payroll.employeeId)
    rows.set(payroll.employeeId, {
      breakMinutes: payroll.breakMinutes,
      currentLocation: attendance ? maintenanceSummaryLocation(attendance) : 'Time clock activity',
      employeeId: payroll.employeeId,
      employeeName: payroll.employeeName,
      employmentType: payroll.employmentType,
      eventCount: attendance?.eventCount ?? 0,
      exceptionCount: payroll.exceptionCount,
      firstClockIn: attendance?.firstClockIn ?? null,
      lastClockOut: attendance?.lastClockOut ?? null,
      latestEffectiveAt: attendance?.latestEffectiveAt ?? null,
      latestKind: attendance?.latestKind ?? null,
      overtimeMinutes: payroll.overtimeMinutes,
      paidMinutes: payroll.paidMinutes,
      pendingCorrectionCount: pendingByEmployee.get(payroll.employeeId) ?? 0,
      role: payroll.role,
      scheduledShiftCount: attendance?.scheduledShiftCount ?? 0,
      scheduledSummary: attendance ? maintenanceScheduledSummary(attendance) : 'No scheduled shifts in range',
      username: payroll.username,
      workedShiftCount: payroll.workedShiftCount,
    })
  }

  return [...rows.values()].sort((left, right) => {
    const stateWeight: Record<TimekeepingState, number> = { working: 0, on_break: 1, off_clock: 2 }
    const stateCompare = stateWeight[maintenanceClockState(left.latestKind)] - stateWeight[maintenanceClockState(right.latestKind)]
    if (stateCompare !== 0) return stateCompare
    return left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' })
  })
}

export function TimeMaintenanceWorkbench({
  defaultPeriod,
  defaultDate,
  focusRequest,
  headingEyebrow = 'Time maintenance',
  headingSummary = 'Search an employee, review their punches, add missing events, and correct mistakes without erasing the original history.',
  headingTitle = 'Work employee time records',
  initialEmployeeId,
  lockEmployeeFilter = false,
  onClose,
}: {
  defaultPeriod?: { fromDate: string; throughDate: string }
  defaultDate: string
  focusRequest: TimeMaintenanceFocusRequest | null
  headingEyebrow?: string
  headingSummary?: string
  headingTitle?: string
  initialEmployeeId?: string
  lockEmployeeFilter?: boolean
  onClose?: () => void
}) {
  const queryClient = useQueryClient()
  const workbenchRef = useRef<HTMLElement | null>(null)
  const defaultMaintenancePeriod = useMemo(() => defaultPeriod ?? completedPayrollPeriod(), [defaultPeriod])
  const [fromDate, setFromDate] = useState(defaultMaintenancePeriod.fromDate)
  const [throughDate, setThroughDate] = useState(defaultMaintenancePeriod.throughDate)
  const [employeeId, setEmployeeId] = useState(initialEmployeeId ?? '')
  const [addEmployeeId, setAddEmployeeId] = useState(initialEmployeeId ?? '')
  const [addKind, setAddKind] = useState<TimeEventKind>('clock_in')
  const [addDate, setAddDate] = useState(defaultDate)
  const [addOperationalDate, setAddOperationalDate] = useState(defaultDate)
  const [addTime, setAddTime] = useState('08:00')
  const [addReason, setAddReason] = useState('')
  const [addShiftId, setAddShiftId] = useState<string | null>(null)
  const [addManualLocation, setAddManualLocation] = useState('')
  const [addUsesManualLocation, setAddUsesManualLocation] = useState(false)
  const [addContext, setAddContext] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<TimeMaintenanceEvent | null>(null)
  const [correctionMode, setCorrectionMode] = useState<'adjust' | 'void' | 'site_post' | 'work_type'>('adjust')
  const [correctionDate, setCorrectionDate] = useState(defaultDate)
  const [correctionTime, setCorrectionTime] = useState('08:00')
  const [correctionKind, setCorrectionKind] = useState<TimeEventKind>('clock_in')
  const [correctionShiftId, setCorrectionShiftId] = useState('')
  const [correctionManualLocation, setCorrectionManualLocation] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const [correctionWorkType, setCorrectionWorkType] = useState<WorkType>('post')
  const showOverview = !lockEmployeeFilter && employeeId === ''
  const overviewSummaryQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryKey: ['time-maintenance-overview', fromDate, throughDate],
    queryFn: () => getTeamAttendanceSummary({ fromDate, throughDate }),
    refetchInterval: 30_000,
  })
  const overviewReviewQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryKey: ['time-maintenance-review-summary', fromDate, throughDate],
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
    refetchInterval: 30_000,
  })
  const maintenanceQuery = useQuery({
    enabled: !lockEmployeeFilter || employeeId !== '',
    queryKey: ['time-maintenance', fromDate, throughDate, employeeId || null],
    queryFn: () => getTimeMaintenance({ employeeId: employeeId || null, fromDate, throughDate }),
    refetchInterval: 30_000,
  })
  const shiftOptionsEmployeeId = selectedEvent?.employeeId ?? (employeeId || null)
  const addShiftOptionsQuery = useQuery({
    enabled: addEmployeeId !== '' && addOperationalDate !== '',
    queryKey: ['time-maintenance-add-shift-options', addOperationalDate, addEmployeeId],
    queryFn: () => getTimeMaintenanceShiftOptions({
      employeeId: addEmployeeId,
      fromDate: addOperationalDate,
      throughDate: addOperationalDate,
    }),
  })
  const shiftOptionsQuery = useQuery({
    enabled: selectedEvent !== null && correctionMode === 'site_post',
    queryKey: ['time-maintenance-shift-options', fromDate, throughDate, shiftOptionsEmployeeId],
    queryFn: () => getTimeMaintenanceShiftOptions({
      employeeId: shiftOptionsEmployeeId,
      fromDate,
      throughDate,
    }),
  })
  const refreshTimeQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['time-maintenance'] }),
      queryClient.invalidateQueries({ queryKey: ['time-maintenance-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['time-maintenance-review-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['time-maintenance-shift-options'] }),
      queryClient.invalidateQueries({ queryKey: ['time-payroll-review'] }),
      queryClient.invalidateQueries({ queryKey: ['timekeeping-review'] }),
      queryClient.invalidateQueries({ queryKey: ['my-time-review'] }),
      queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
      queryClient.invalidateQueries({ queryKey: ['time-command-attendance-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['time-team-review'] }),
      queryClient.invalidateQueries({ queryKey: ['time-team-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
      queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
    ])
  }
  const addMutation = useMutation({
    mutationFn: () => supervisorRecordTimeEvent({
      effectiveAt: zonedDateTimeToIso(addDate, addTime),
      employeeId: addEmployeeId,
      kind: addKind,
      locationName: addUsesManualLocation ? addManualLocation.trim() : null,
      reason: addReason.trim(),
      shiftId: addUsesManualLocation ? null : addShiftId,
      timeZone: 'America/Denver',
    }),
    onSuccess: async () => {
      setAddReason('')
      setAddContext(null)
      await refreshTimeQueries()
    },
  })
  const correctionMutation = useMutation<unknown, Error>({
    mutationFn: () => {
      if (!selectedEvent) throw new Error('Select a time event first.')
      if (correctionMode === 'site_post') {
        if (correctionShiftId === MANUAL_SITE_POST_OPTION) {
          return supervisorUpdateTimeEventLocation({
            locationName: correctionManualLocation.trim(),
            reason: correctionReason.trim(),
            timeEventId: selectedEvent.id,
            timeZone: selectedEvent.timeZone,
          })
        }
        return supervisorUpdateTimeEventSitePost({
          reason: correctionReason.trim(),
          shiftId: correctionShiftId,
          timeEventId: selectedEvent.id,
        })
      }
      if (correctionMode === 'work_type') {
        return correctTimeRecordWorkType({
          reason: correctionReason.trim(),
          timeEventId: selectedEvent.id,
          workType: correctionWorkType,
        })
      }
      return supervisorCorrectTimeEvent({
        reason: correctionReason.trim(),
        replacementKind: correctionMode === 'adjust' ? correctionKind : null,
        replacementTime: correctionMode === 'adjust' ? zonedDateTimeToIso(correctionDate, correctionTime) : null,
        timeEventId: selectedEvent.id,
        voided: correctionMode === 'void',
      })
    },
    onSuccess: async () => {
      setSelectedEvent(null)
      setCorrectionShiftId('')
      setCorrectionManualLocation('')
      setCorrectionReason('')
      await refreshTimeQueries()
    },
  })
  const maintenance = maintenanceQuery.data
  const events = maintenance?.events ?? []
  const employees = useMemo(
    () => sortTimeMaintenanceEmployees(maintenance?.employees ?? []),
    [maintenance?.employees],
  )
  const overviewPayrollSummaries = useMemo(() => {
    const workedReview = workedTimePayrollReview(overviewReviewQuery.data)
    return summarizePayrollRowsByEmployee(workedReview?.rows ?? [])
  }, [overviewReviewQuery.data])
  const overviewRows = useMemo(() => buildTimeMaintenanceOverviewRows(
    overviewSummaryQuery.data?.rows ?? [],
    overviewPayrollSummaries,
    overviewReviewQuery.data?.pendingCorrections ?? [],
  ), [overviewPayrollSummaries, overviewReviewQuery.data?.pendingCorrections, overviewSummaryQuery.data?.rows])
  const selectedAttendanceSummary = useMemo(
    () => overviewSummaryQuery.data?.rows.find((row) => row.employeeId === employeeId) ?? null,
    [employeeId, overviewSummaryQuery.data?.rows],
  )
  const selectedPayrollSummary = useMemo(
    () => overviewPayrollSummaries.find((row) => row.employeeId === employeeId) ?? null,
    [employeeId, overviewPayrollSummaries],
  )
  const selectedPendingCorrections = useMemo(
    () => overviewReviewQuery.data?.pendingCorrections.filter((correction) => correction.employeeId === employeeId).length ?? 0,
    [employeeId, overviewReviewQuery.data?.pendingCorrections],
  )
  const selectedScheduledMinutes = selectedAttendanceSummary?.scheduledMinutes ?? 0
  const selectedWorkedMinutes = selectedPayrollSummary?.paidMinutes ?? 0
  const selectedDifferenceMinutes = selectedWorkedMinutes - selectedScheduledMinutes
  const selectedNeedsAttention = (selectedPayrollSummary?.exceptionCount ?? 0) + selectedPendingCorrections
  const visibleEvents = showOverview ? [] : events
  const overviewEventCount = overviewRows.reduce((total, row) => total + row.eventCount, 0)
  const overviewPendingCount = overviewRows.reduce((total, row) => total + row.pendingCorrectionCount, 0)
  const overviewExceptionCount = overviewRows.reduce((total, row) => total + row.exceptionCount, 0)
  const overviewPaidMinutes = overviewRows.reduce((total, row) => total + row.paidMinutes, 0)
  const addShiftOptions = useMemo(() => {
    const options = shiftOptionsForOperationalDate(addShiftOptionsQuery.data ?? [], addOperationalDate)
    return options.sort((left, right) => {
      if (left.selectedEmployeeAssigned !== right.selectedEmployeeAssigned) return left.selectedEmployeeAssigned ? -1 : 1
      return sitePostOptionTitle(left).localeCompare(sitePostOptionTitle(right), undefined, { sensitivity: 'base' })
    })
  }, [addOperationalDate, addShiftOptionsQuery.data])
  const canAdd = addEmployeeId !== ''
    && addReason.trim().length > 0
    && (addUsesManualLocation ? addManualLocation.trim().length > 0 : addShiftId !== null)
    && !addMutation.isPending
  const canCorrect = selectedEvent !== null
    && correctionReason.trim().length > 0
    && !correctionMutation.isPending
    && (correctionMode !== 'site_post' || (correctionShiftId !== '' && (correctionShiftId !== MANUAL_SITE_POST_OPTION || correctionManualLocation.trim().length > 0)))
  const selectedEventDate = selectedEvent ? dateInputValue(selectedEvent.effectiveAt) : ''
  const correctionShiftOptions = useMemo(() => {
    const options = shiftOptionsQuery.data ?? []
    if (!selectedEventDate) return options
    return options.filter((option) =>
      dateInputValue(option.startsAt) === selectedEventDate || dateInputValue(option.endsAt) === selectedEventDate)
  }, [selectedEventDate, shiftOptionsQuery.data])

  useEffect(() => {
    if (!focusRequest) return
    setEmployeeId(focusRequest.employeeId)
    setAddEmployeeId((current) => current || focusRequest.employeeId)
    setFromDate(focusRequest.fromDate)
    setThroughDate(focusRequest.throughDate)
    window.requestAnimationFrame(() => {
      workbenchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [focusRequest])

  useEffect(() => {
    if (!initialEmployeeId) return
    setEmployeeId(initialEmployeeId)
    setAddEmployeeId(initialEmployeeId)
  }, [initialEmployeeId])

  useEffect(() => {
    setSelectedEvent(null)
    setCorrectionShiftId('')
    setCorrectionManualLocation('')
    setCorrectionReason('')
  }, [employeeId, fromDate, throughDate])

  function beginCorrection(event: TimeMaintenanceEvent, mode: 'adjust' | 'void' | 'site_post' | 'work_type') {
    setSelectedEvent(event)
    setCorrectionMode(mode)
    setCorrectionDate(dateInputValue(event.effectiveAt))
    setCorrectionTime(timeInputValue(event.effectiveAt))
    setCorrectionKind(event.kind)
    setCorrectionShiftId(event.shiftId ?? '')
    setCorrectionManualLocation(event.locationName === 'Unscheduled' || event.locationName === 'Unscheduled Location' ? '' : event.locationName)
    setCorrectionReason('')
    setCorrectionWorkType(event.workType)
  }

  function prefillRelatedPunch(event: TimeMaintenanceEvent) {
    setAddEmployeeId(event.employeeId)
    setAddShiftId(event.shiftId)
    const hasManualLocation = event.shiftId === null
      && event.locationName !== 'Unscheduled'
      && event.locationName !== 'Unscheduled Location'
    setAddUsesManualLocation(hasManualLocation)
    setAddManualLocation(hasManualLocation ? event.locationName : '')
    setAddContext(event.shiftId
      ? `${event.employeeName} · ${event.locationName} · same shift`
      : `${event.employeeName} · unscheduled time`)
    setAddDate(dateInputValue(event.effectiveAt))
    setAddOperationalDate(event.operationalDate)
    setAddTime(timeInputValue(event.effectiveAt))
    setAddReason('')
  }

  return (
    <section className="time-maintenance-workbench" aria-labelledby="time-maintenance-title" ref={workbenchRef}>
      <div className="time-maintenance-heading">
        <div>
          <p className="eyebrow">{headingEyebrow}</p>
          <h2 id="time-maintenance-title">{headingTitle}</h2>
          <p>{headingSummary}</p>
        </div>
        <div className="time-maintenance-heading__controls">
          <div className="time-review-range" aria-label="Time maintenance date range">
            <label><span>From</span><input max={throughDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
            <label><span>Through</span><input min={fromDate} onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
          </div>
          {onClose ? <button className="secondary-button" onClick={onClose} type="button">Close details</button> : null}
        </div>
      </div>

      {maintenanceQuery.isPending ? (
        <DataStatePanel icon={FileClock} title="Loading time maintenance"><p>Retrieving employee time events and maintenance history.</p></DataStatePanel>
      ) : maintenanceQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Time maintenance unavailable" tone="error"><p>{maintenanceQuery.error.message}</p></DataStatePanel>
      ) : maintenance ? (
        <>
          <section className="time-review-metrics" aria-label="Time maintenance totals">
            {showOverview ? (
              <>
                <article><span>People</span><strong>{overviewRows.length}</strong><small>Employees with time or schedule activity</small></article>
                <article><span>Punches</span><strong>{overviewEventCount}</strong><small>Clock events in range</small></article>
                <article className={overviewPendingCount + overviewExceptionCount ? 'import-metric--attention' : ''}><span>Needs review</span><strong>{overviewPendingCount + overviewExceptionCount}</strong><small>Corrections or payroll exceptions</small></article>
                <article><span>Paid hours</span><strong>{payrollHours(overviewPaidMinutes)}</strong><small>Worked time in range</small></article>
              </>
            ) : (
              <>
                <article><span>Scheduled</span><strong>{payrollHours(selectedScheduledMinutes)} hr</strong><small>Published schedule in this range</small></article>
                <article><span>Worked</span><strong>{payrollHours(selectedWorkedMinutes)} hr</strong><small>Paid time from completed punches</small></article>
                <article className={selectedDifferenceMinutes !== 0 ? 'import-metric--attention' : ''}>
                  <span>Worked vs schedule</span>
                  <strong>{selectedDifferenceMinutes > 0 ? '+' : ''}{payrollHours(selectedDifferenceMinutes)} hr</strong>
                  <small>Punch-based worked time minus scheduled coverage. Clocked-out gaps stay unpaid.</small>
                </article>
                <article className={selectedNeedsAttention ? 'import-metric--attention time-maintenance-attention' : ''}>
                  <span>Needs attention</span>
                  <strong>{selectedNeedsAttention}</strong>
                  <small>Payroll exceptions or pending corrections</small>
                  {selectedNeedsAttention ? (
                    <Link
                      className="time-maintenance-attention__link"
                      to={`/time/exceptions?employee=${encodeURIComponent(employeeId)}&from=${encodeURIComponent(fromDate)}&through=${encodeURIComponent(throughDate)}`}
                    >
                      Review this employee
                    </Link>
                  ) : null}
                </article>
              </>
            )}
          </section>

          {!showOverview ? (
            <details className="time-maintenance-breakdown">
              <summary>View hours breakdown</summary>
              <div className="time-maintenance-breakdown__grid">
                <span><small>Regular</small><strong>{payrollHours(selectedPayrollSummary?.regularMinutes ?? 0)} hr</strong></span>
                <span><small>Overtime</small><strong>{payrollHours(selectedPayrollSummary?.overtimeMinutes ?? 0)} hr</strong></span>
                <span><small>Unpaid breaks</small><strong>{payrollHours(selectedPayrollSummary?.breakMinutes ?? 0)} hr</strong></span>
                <span><small>Completed work segments</small><strong>{selectedPayrollSummary?.workedShiftCount ?? 0}</strong></span>
              </div>
            </details>
          ) : null}

          <div className="time-maintenance-tools">
            <label className="time-maintenance-filter">
              <span>Employee filter</span>
              <select
                disabled={lockEmployeeFilter}
                onChange={(event) => {
                  setEmployeeId(event.target.value)
                  if (event.target.value && addEmployeeId === '') setAddEmployeeId(event.target.value)
                }}
                value={employeeId}
              >
                {lockEmployeeFilter ? null : <option value="">All active employees</option>}
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.displayName} (@{employee.username})</option>
                ))}
              </select>
              {lockEmployeeFilter ? <small>Detail view is locked to the selected employee.</small> : null}
            </label>

            <form
              className="time-maintenance-add"
              onSubmit={(event) => {
                event.preventDefault()
                addMutation.mutate()
              }}
            >
              <div>
                <p className="eyebrow">Add missing punch</p>
                <h3>Supervisor-entered time event</h3>
              </div>
              <label>
                <span>Employee</span>
                <select
                  onChange={(event) => {
                    setAddEmployeeId(event.target.value)
                    setAddShiftId(null)
                    setAddManualLocation('')
                    setAddUsesManualLocation(false)
                    setAddContext(null)
                  }}
                  required
                  value={addEmployeeId}
                >
                  <option value="">Choose employee</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.displayName} (@{employee.username})</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Punch type</span>
                <select onChange={(event) => {
                  const nextKind = event.target.value as TimeEventKind
                  setAddKind(nextKind)
                  const selectedShift = addShiftOptions.find((option) => option.shiftId === addShiftId)
                  if (!selectedShift) return
                  const recommended = recommendedManualPunchTimestamp(selectedShift, nextKind)
                  if (!recommended) return
                  setAddDate(recommended.date)
                  setAddTime(recommended.time)
                }} value={addKind}>
                  {Object.entries(actionLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                </select>
              </label>
              <label><span>Punch date</span><input onChange={(event) => setAddDate(event.target.value)} required type="date" value={addDate} /></label>
              <label><span>Time / Mountain</span><input onChange={(event) => setAddTime(event.target.value)} required type="time" value={addTime} /></label>
              <div className="time-maintenance-add__site-post">
                <label>
                  <span>Workday</span>
                  <input
                    onChange={(event) => {
                      setAddOperationalDate(event.target.value)
                      setAddShiftId(null)
                      setAddManualLocation('')
                      setAddUsesManualLocation(false)
                      setAddContext(null)
                    }}
                    required
                    type="date"
                    value={addOperationalDate}
                  />
                  <small>For an overnight shift, use the date the shift starts.</small>
                </label>
                <label>
                  <span>Site/Post</span>
                  <select
                    disabled={!addEmployeeId || addShiftOptionsQuery.isPending}
                    onChange={(event) => {
                      const value = event.target.value
                      const useManualLocation = value === MANUAL_SITE_POST_OPTION
                      const selectedShift = addShiftOptions.find((option) => option.shiftId === value)
                      setAddUsesManualLocation(useManualLocation)
                      setAddShiftId(useManualLocation || value === '' ? null : value)
                      if (!useManualLocation) setAddManualLocation('')
                      setAddContext(null)
                      if (selectedShift) {
                        setAddOperationalDate(selectedShift.operationalDate)
                        const recommended = recommendedManualPunchTimestamp(selectedShift, addKind)
                        if (recommended) {
                          setAddDate(recommended.date)
                          setAddTime(recommended.time)
                        }
                      }
                    }}
                    required
                    value={addUsesManualLocation ? MANUAL_SITE_POST_OPTION : addShiftId ?? ''}
                  >
                    <option value="">{addShiftOptionsQuery.isPending ? 'Loading Site/Post options...' : 'Choose Site/Post'}</option>
                    {addShiftOptions.filter((option) => option.selectedEmployeeAssigned).length ? (
                      <optgroup label="Assigned shifts">
                        {addShiftOptions.filter((option) => option.selectedEmployeeAssigned).map((option) => (
                          <option key={option.shiftId} value={option.shiftId}>
                            Workday {formatDateOnly(option.operationalDate)} · {sitePostOptionTitle(option)} · {formatTime(option.startsAt, option.timeZone)} - {formatTime(option.endsAt, option.timeZone)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {addShiftOptions.filter((option) => !option.selectedEmployeeAssigned).length ? (
                      <optgroup label="Other scheduled Site/Posts">
                        {addShiftOptions.filter((option) => !option.selectedEmployeeAssigned).map((option) => (
                          <option key={option.shiftId} value={option.shiftId}>
                            Workday {formatDateOnly(option.operationalDate)} · {sitePostOptionTitle(option)} · {formatTime(option.startsAt, option.timeZone)} - {formatTime(option.endsAt, option.timeZone)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <option value={MANUAL_SITE_POST_OPTION}>Other location</option>
                  </select>
                  <small>Saved with this punch so a second Site/Post correction is not required.</small>
                </label>
                {addUsesManualLocation ? (
                  <label>
                    <span>Other location</span>
                    <input
                      maxLength={180}
                      onChange={(event) => setAddManualLocation(event.target.value)}
                      placeholder="Enter the verified work location"
                      required
                      value={addManualLocation}
                    />
                  </label>
                ) : null}
                {addShiftOptionsQuery.isError ? <small className="field-error">{addShiftOptionsQuery.error.message}</small> : null}
              </div>
              <label className="time-maintenance-add__reason">
                <span>Reason</span>
                <textarea
                  maxLength={700}
                  onChange={(event) => setAddReason(event.target.value)}
                  placeholder="Example: Employee forgot to clock out; verified by supervisor."
                  required
                  rows={2}
                  value={addReason}
                />
              </label>
              {addContext ? (
                <div className="time-maintenance-context">
                  <span>Linked context</span>
                  <strong>{addContext}</strong>
                  <button
                    className="text-button"
                    onClick={() => {
                      setAddShiftId(null)
                      setAddManualLocation('')
                      setAddUsesManualLocation(false)
                      setAddContext(null)
                    }}
                    type="button"
                  >
                    Clear shift link
                  </button>
                </div>
              ) : null}
              <button className="primary-action" disabled={!canAdd} type="submit">
                {addMutation.isPending ? 'Saving...' : 'Add time event'}
              </button>
            </form>
          </div>

          {addMutation.isError ? <div className="inline-alert" role="alert">{addMutation.error.message}</div> : null}
          {selectedEvent ? (
            <ModalDialog
              busy={correctionMutation.isPending}
              busyLabel="Saving time correction..."
              className="modal-dialog--time-workflow modal-dialog--time-correction"
              description={`${selectedEvent.employeeName} · Workday ${formatDateOnly(selectedEvent.operationalDate)} · ${formatTime(selectedEvent.effectiveAt, selectedEvent.timeZone)}`}
              onClose={() => setSelectedEvent(null)}
              title="Correct punch"
            >
              <form
                className="time-correction-editor time-correction-editor--modal"
                onSubmit={(event) => {
                  event.preventDefault()
                  correctionMutation.mutate()
                }}
              >
              <div className="time-correction-editor__mode" role="radiogroup" aria-label="Correction type">
                <label><input checked={correctionMode === 'adjust'} onChange={() => setCorrectionMode('adjust')} type="radio" /> Change punch</label>
                <label><input checked={correctionMode === 'site_post'} onChange={() => {
                  setCorrectionMode('site_post')
                  setCorrectionShiftId(selectedEvent.shiftId ?? '')
                }} type="radio" /> Fix Site/Post</label>
                <label><input checked={correctionMode === 'work_type'} onChange={() => {
                  setCorrectionMode('work_type')
                  setCorrectionWorkType(selectedEvent.workType)
                }} type="radio" /> Time category</label>
                <label><input checked={correctionMode === 'void'} onChange={() => setCorrectionMode('void')} type="radio" /> Void duplicate/accidental</label>
              </div>
              {correctionMode === 'adjust' ? (
                <div className="time-correction-editor__fields">
                  <label className="time-correction-editor__field--wide">
                    <span>Punch type</span>
                    <select onChange={(event) => setCorrectionKind(event.target.value as TimeEventKind)} value={correctionKind}>
                      {Object.entries(actionLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                    </select>
                  </label>
                  <label><span>New date</span><input onChange={(event) => setCorrectionDate(event.target.value)} required type="date" value={correctionDate} /></label>
                  <label><span>New time / Mountain</span><input onChange={(event) => setCorrectionTime(event.target.value)} required type="time" value={correctionTime} /></label>
                </div>
              ) : null}
              {correctionMode === 'void' ? (
                <p className="time-correction-editor__guidance">Void is reserved for a duplicate or accidental punch. To fix Clock In versus Clock Out, use Change punch so the original event remains in the audit history.</p>
              ) : null}
              {correctionMode === 'site_post' ? (
                <label className="time-correction-editor__location">
                  <span>Correct Site/Post</span>
                  <select
                    disabled={shiftOptionsQuery.isPending}
                    onChange={(event) => setCorrectionShiftId(event.target.value)}
                    required
                    value={correctionShiftId}
                  >
                    <option value="">{shiftOptionsQuery.isPending ? 'Loading schedule blocks...' : 'Choose the correct Site/Post shift'}</option>
                    {correctionShiftOptions.map((option) => (
                      <option key={option.shiftId} value={option.shiftId}>
                        {sitePostOptionTitle(option)}
                      </option>
                    ))}
                    <option value={MANUAL_SITE_POST_OPTION}>Other / manual label only</option>
                  </select>
                  {correctionShiftId === MANUAL_SITE_POST_OPTION ? (
                    <>
                      <input
                        maxLength={180}
                        onChange={(event) => setCorrectionManualLocation(event.target.value)}
                        placeholder="Example: Cobalt / Executive Protection"
                        required
                        type="text"
                        value={correctionManualLocation}
                      />
                      <small>Use this only when the schedule block does not exist yet. It fixes the payroll label but does not link the punch to a schedule block.</small>
                    </>
                  ) : correctionShiftOptions.length > 0 && correctionShiftId ? (
                    <small>{sitePostOptionSchedule(correctionShiftOptions.find((option) => option.shiftId === correctionShiftId) ?? correctionShiftOptions[0])}</small>
                  ) : (
                    <small>Select the actual scheduled block. This removes the Unscheduled payroll flag for the corrected punch group.</small>
                  )}
                  {shiftOptionsQuery.isError ? <small className="field-error">{shiftOptionsQuery.error.message}</small> : null}
                  {!shiftOptionsQuery.isPending && correctionShiftOptions.length === 0 ? (
                    <small className="field-error">No schedule blocks were found on this punch date. Add the shift to the schedule first for a true Site/Post link, or choose Other for a manual payroll label.</small>
                  ) : null}
                </label>
              ) : null}
              {correctionMode === 'work_type' ? (
                <label className="time-correction-editor__location">
                  <span>Paid work classification</span>
                  <select onChange={(event) => setCorrectionWorkType(event.target.value as WorkType)} value={correctionWorkType}>
                    <option value="post">Worked time</option>
                    <option value="training">Paid training</option>
                  </select>
                  <small>This updates every punch in this employee's same shift/day occurrence and preserves the original punches in the audit history.</small>
                </label>
              ) : null}
              <label className="time-maintenance-add__reason">
                <span>Reason</span>
                <textarea
                  maxLength={700}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  placeholder={correctionMode === 'void' ? 'Explain why this punch is a duplicate or accidental entry.' : 'Explain why this punch is being corrected.'}
                  required
                  rows={2}
                  value={correctionReason}
                />
              </label>
              {correctionMutation.isError ? <div className="inline-alert time-correction-editor__error" role="alert">{correctionMutation.error.message}</div> : null}
              <div className="time-correction-editor__actions">
                <button className="secondary-button" onClick={() => setSelectedEvent(null)} type="button">Cancel</button>
                <button className={correctionMode === 'void' ? 'danger-primary' : 'primary-action'} disabled={!canCorrect} type="submit">
                  {correctionMutation.isPending ? 'Saving...' : correctionMode === 'void' ? 'Void punch' : correctionMode === 'site_post' ? 'Save Site/Post' : correctionMode === 'work_type' ? 'Save work type' : 'Save corrected punch'}
                </button>
              </div>
              </form>
            </ModalDialog>
          ) : null}

          {showOverview ? (
            overviewSummaryQuery.isPending || overviewReviewQuery.isPending ? (
              <DataStatePanel icon={FileClock} title="Loading employee summaries">
                <p>Building the team overview for this pay-period range.</p>
              </DataStatePanel>
            ) : overviewSummaryQuery.isError ? (
              <DataStatePanel icon={ShieldAlert} title="Employee summaries unavailable" tone="error">
                <p>{overviewSummaryQuery.error.message}</p>
              </DataStatePanel>
            ) : overviewReviewQuery.isError ? (
              <DataStatePanel icon={ShieldAlert} title="Payroll totals unavailable" tone="error">
                <p>{overviewReviewQuery.error.message}</p>
              </DataStatePanel>
            ) : overviewRows.length === 0 ? (
              <DataStatePanel icon={UserRound} title="No team time activity in this range">
                <p>No scheduled or clocked time was found for the selected dates. Choose an employee above if you need to add a verified missing punch.</p>
              </DataStatePanel>
            ) : (
              <div className="time-maintenance-overview">
                <div className="time-maintenance-overview__heading">
                  <div>
                    <p className="eyebrow">Team overview</p>
                    <h3>Review by employee first</h3>
                    <p>Select an employee to open their punch-level maintenance record. The full punch list is intentionally hidden from the all-employee view.</p>
                  </div>
                </div>
                <div className="time-review-table-wrap">
                  <table className="time-review-table time-maintenance-overview-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Status</th>
                        <th>Worked time</th>
                        <th>Schedule / location</th>
                        <th>Activity</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overviewRows.map((row) => {
                        const clockState = maintenanceClockState(row.latestKind)
                        const reviewCount = row.pendingCorrectionCount + row.exceptionCount
                        return (
                          <tr key={row.employeeId}>
                            <td>
                              <strong>{row.employeeName}</strong>
                              <span>@{row.username} · {row.employmentType}</span>
                            </td>
                            <td>
                              <span className={clockState === 'on_break' ? 'payroll-status payroll-status--hold' : 'payroll-status payroll-status--ready'}>
                                {maintenanceClockLabel(row.latestKind)}
                              </span>
                              {row.latestEffectiveAt ? <small>{formatTime(row.latestEffectiveAt)}</small> : <small>No punch in range</small>}
                            </td>
                            <td>
                              <strong>{payrollHours(row.paidMinutes)} hr paid</strong>
                              <span>{row.workedShiftCount} worked row{row.workedShiftCount === 1 ? '' : 's'}</span>
                              <small>{payrollHours(row.breakMinutes)} hr break · {payrollHours(row.overtimeMinutes)} hr OT</small>
                            </td>
                            <td>
                              <strong>{row.currentLocation}</strong>
                              <span>{row.scheduledSummary}</span>
                            </td>
                            <td>
                              <strong>{row.eventCount} punch{row.eventCount === 1 ? '' : 'es'}</strong>
                              {row.firstClockIn ? <span>First: {formatDateOnly(dateInputValue(row.firstClockIn))}</span> : <span>No clock-in</span>}
                              {reviewCount > 0 ? <small className="field-error">{reviewCount} item{reviewCount === 1 ? '' : 's'} need review</small> : <small>Ready for detail review</small>}
                            </td>
                            <td>
                              <button
                                className="secondary-button secondary-button--small"
                                onClick={() => {
                                  setEmployeeId(row.employeeId)
                                  setAddEmployeeId(row.employeeId)
                                }}
                                type="button"
                              >
                                View details
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          ) : visibleEvents.length === 0 ? (
            <DataStatePanel icon={UserRound} title="No employee time events in this range">
              <p>This employee has no punch-level time events in the selected range. Add a missing punch only when a supervisor has verified the time.</p>
            </DataStatePanel>
          ) : (
            <div className="time-review-table-wrap">
              <table className="time-review-table time-maintenance-table">
                <thead>
                  <tr>
                    <th>Workday / punch time</th>
                    <th>Punch</th>
                    <th>Site/Post</th>
                    <th>Status</th>
                    <th>Maintenance</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((event) => (
                    <tr className={event.voided ? 'time-maintenance-row--voided' : ''} key={event.id}>
                      <td>
                        <strong>Workday {formatDateOnly(event.operationalDate)}</strong>
                        <span>{formatDateOnly(dateInputValue(event.effectiveAt))} · {formatTime(event.effectiveAt, event.timeZone)}</span>
                        {event.effectiveAt !== event.recordedAt ? <small>Original: {formatTime(event.recordedAt, event.timeZone)}</small> : null}
                      </td>
                      <td>
                        <strong>{maintenanceEventLabel(event)}</strong>
                        <span>{event.source.replaceAll('_', ' ')}</span>
                        {event.recordedKind && event.recordedKind !== event.kind ? <small>Originally: {eventLabels[event.recordedKind]}</small> : null}
                        {event.workType === 'training' ? <small>Paid training</small> : null}
                      </td>
                      <td>
                        <strong>{event.locationName}</strong>
                        <span>{[event.siteCode, event.postName ?? event.eventName].filter(Boolean).join(' · ') || 'Unscheduled'}</span>
                      </td>
                      <td>
                        <MaintenanceEventStatus event={event} />
                        {event.latestNote ? <small>{event.latestNote}</small> : null}
                      </td>
                      <td>
                        <div className="time-maintenance-actions">
                          <button className="secondary-button secondary-button--small" disabled={event.voided} onClick={() => prefillRelatedPunch(event)} type="button">
                            Add punch
                          </button>
                          <button className="secondary-button secondary-button--small" disabled={event.voided} onClick={() => beginCorrection(event, 'adjust')} type="button">
                            <Pencil aria-hidden="true" size={15} /> Correct punch
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}

function VerifiedTimekeepingSetup() {
  return (
    <>
      <section className="time-hero-card" aria-labelledby="timekeeping-foundation-title">
        <div className="time-hero-card__icon"><Timer aria-hidden="true" size={31} /></div>
        <div>
          <p className="eyebrow">Timekeeping foundation</p>
          <h2 id="timekeeping-foundation-title">Clock-in rules are ready for the secure database.</h2>
          <p>
            SygShift is built around schedule-linked punches, server-recorded official time, audit-only
            device timestamps, break tracking, and correction records that cannot quietly overwrite history.
          </p>
        </div>
        <span className="import-state-pill"><CheckCircle2 aria-hidden="true" size={17} /> Controlled</span>
      </section>

      <section className="time-rule-grid" aria-label="Timekeeping safeguards">
        {verifiedTimekeepingBaseline.guarantees.map((guarantee) => (
          <article key={guarantee}>
            <BadgeCheck aria-hidden="true" size={22} />
            <span>{guarantee}</span>
          </article>
        ))}
      </section>

      <section className="time-layout">
        <article className="time-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Punch window</p>
              <h2>Easy for guards, strict for payroll</h2>
            </div>
          </div>
          <p className="time-panel__lead">{verifiedTimekeepingBaseline.punchWindow}</p>
          <div className="time-action-row">
            <button className="primary-action" disabled type="button">Clock in</button>
            <button className="secondary-button" disabled type="button">Start break</button>
            <button className="secondary-button" disabled type="button">Clock out</button>
          </div>
        </article>

        <DataStatePanel icon={FileClock} title="Connect Supabase to record live punches" tone="setup">
          <p>
            The page is ready, but live time punches stay disabled until a signed-in employee account is connected.
            Direct table writes remain closed; employees punch only through the controlled workflow.
          </p>
        </DataStatePanel>
      </section>
    </>
  )
}

function ShiftPicker({
  choices,
  selectedShiftId,
  onSelect,
}: {
  choices: ClockableShiftChoices
  selectedShiftId: string | null
  onSelect: (shiftId: string | null) => void
}) {
  const shifts = choices.shifts
  if (shifts.length === 0) {
    return (
      <div className="time-shift-empty">
        <CalendarClock aria-hidden="true" size={25} />
        <div>
          <strong>No assigned shift is available for clock-in right now.</strong>
          <p>An unscheduled clock-in can still be recorded for supervisor review.</p>
          {choices.hiddenCount > 0 ? (
            <p>{choices.hiddenCount} future or duplicate schedule {choices.hiddenCount === 1 ? 'entry is' : 'entries are'} hidden from this clock-in list.</p>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <fieldset className="time-shift-list">
      <legend>Choose the shift you are clocking into</legend>
      {choices.hiddenCount > 0 ? (
        <p className="time-shift-list__note">
          Showing only shifts available for clock-in right now. {choices.hiddenCount} future or duplicate schedule {choices.hiddenCount === 1 ? 'entry is' : 'entries are'} hidden.
        </p>
      ) : null}
      {shifts.map((shift) => (
        <label className={selectedShiftId === shift.shiftId ? 'time-shift-option time-shift-option--selected' : 'time-shift-option'} key={shift.shiftId}>
          <input
            checked={selectedShiftId === shift.shiftId}
            name="time-shift"
            onChange={() => onSelect(shift.shiftId)}
            type="radio"
          />
          <span>
            <strong>{shiftTitle(shift)}</strong>
            <small>{shiftLocation(shift)}</small>
            <em>{formatTime(shift.startsAt, shift.timeZone)} - {formatTime(shift.endsAt, shift.timeZone)}</em>
          </span>
          {shift.requiresArmed ? <b>Armed</b> : null}
          {shift.isOvertime ? <b>OT</b> : null}
        </label>
      ))}
      <label className={selectedShiftId === null ? 'time-shift-option time-shift-option--selected' : 'time-shift-option'}>
        <input checked={selectedShiftId === null} name="time-shift" onChange={() => onSelect(null)} type="radio" />
        <span>
          <strong>Unscheduled time</strong>
          <small>Use only when a supervisor expects you to work outside a listed shift.</small>
        </span>
      </label>
    </fieldset>
  )
}

function PunchControls({
  canPunch,
  dashboard,
  pending,
  onPunch,
}: {
  canPunch: boolean
  dashboard: TimekeepingDashboard
  pending: boolean
  onPunch: (kind: TimeEventKind, shiftId?: string | null) => void
}) {
  const state = activeTimeState(dashboard.lastEvent)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(
    dashboard.eligibleShifts.length === 1 ? dashboard.eligibleShifts[0]?.shiftId ?? null : null,
  )
  const copy = stateCopy[state]
  const currentShift = activeShift(dashboard)
  const actions = nextTimeEventKinds(state)
  const clockableChoices = useMemo(
    () => getClockableShiftChoices(dashboard.eligibleShifts, dashboard.serverTimestamp),
    [dashboard.eligibleShifts, dashboard.serverTimestamp],
  )

  useEffect(() => {
    if (state !== 'off_clock') return
    if (clockableChoices.shifts.some((shift) => shift.shiftId === selectedShiftId)) return
    setSelectedShiftId(clockableChoices.shifts[0]?.shiftId ?? null)
  }, [clockableChoices.shifts, selectedShiftId, state])

  return (
    <section className={`time-clock-card time-clock-card--${state}`} aria-labelledby="time-clock-title">
      <div className="time-clock-card__header">
        <div>
          <p className="eyebrow">Current status</p>
          <h2 id="time-clock-title">{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
        <div className="time-server-box">
          <span>Official server time</span>
          <strong>{formatTime(dashboard.serverTimestamp)}</strong>
        </div>
      </div>

      {state === 'off_clock' ? (
        <ShiftPicker choices={clockableChoices} onSelect={setSelectedShiftId} selectedShiftId={selectedShiftId} />
      ) : currentShift ? (
        <div className="active-shift-card">
          <Clock3 aria-hidden="true" size={23} />
          <div>
            <strong>{shiftTitle(currentShift)}</strong>
            <span>{shiftLocation(currentShift)} · {formatTime(currentShift.startsAt, currentShift.timeZone)} - {formatTime(currentShift.endsAt, currentShift.timeZone)}</span>
          </div>
        </div>
      ) : (
        <div className="active-shift-card">
          <Clock3 aria-hidden="true" size={23} />
          <div>
            <strong>Unscheduled active time</strong>
            <span>This session will stay visible for supervisor payroll review.</span>
          </div>
        </div>
      )}

      <div className="time-action-row">
        {actions.map((kind) => (
          <button
            className={kind === 'clock_in' || kind === 'clock_out' ? 'primary-action' : 'secondary-button'}
            disabled={pending || !canPunch}
            key={kind}
            onClick={() => onPunch(kind, kind === 'clock_in' ? selectedShiftId : undefined)}
            type="button"
          >
            {kind === 'break_start' || kind === 'break_end' ? <Coffee aria-hidden="true" size={18} /> : <Timer aria-hidden="true" size={18} />}
            {pending ? 'Recording...' : actionLabels[kind]}
          </button>
        ))}
      </div>
      <small className="my-time-official-note">
        {canPunch
          ? 'Official time is recorded by the secure server. This panel updates as soon as the punch is saved.'
          : 'Your account can view time, but time clock punches are not enabled.'}
      </small>
    </section>
  )
}

function RecentEvents({ events }: { events: TimekeepingEvent[] }) {
  if (events.length === 0) {
    return (
      <DataStatePanel icon={History} title="No punches recorded today">
        <p>Your clock-in, break, and clock-out events will appear here as soon as they are recorded.</p>
      </DataStatePanel>
    )
  }

  return (
    <section className="time-panel" aria-labelledby="recent-time-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Today</p>
          <h2 id="recent-time-title">Recorded time events</h2>
        </div>
      </div>
      <ol className="time-event-list">
        {events.map((event) => (
          <li className={event.voided ? 'time-event time-event--voided' : 'time-event'} key={event.id}>
            <span><Clock3 aria-hidden="true" size={18} /></span>
            <div>
              <strong>{eventLabels[event.kind]}</strong>
              <small>{formatDate(event.recordedAt)} · {formatTime(event.recordedAt)} · {event.source.replaceAll('_', ' ')}</small>
            </div>
            {event.voided ? <em>Voided</em> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

function exceptionLabel(code: string): string {
  return code.replaceAll('_', ' ')
}

function exportPayrollCsv(review: TimekeepingReview) {
  const csv = reviewRowsToPayrollSummaryCsv(review.rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `sygshift-payroll-summary-${review.fromDate}-to-${review.throughDate}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function PayrollRulesPanel({ review }: { review: TimekeepingReview }) {
  const rules = review.payrollRules
  if (!rules) return null

  return (
    <section className="payroll-rules-panel" aria-label="Active payroll rules">
      <article>
        <span>Payroll week</span>
        <strong>{rules.weekStartsOnLabel} 12:00 AM - Saturday 11:59 PM</strong>
        <small>{formatDateOnly(review.fromDate)} to {formatDateOnly(review.throughDate)}</small>
      </article>
      <article>
        <span>Overtime</span>
        <strong>{payrollHours(rules.dailyOvertimeMinutes)} daily / {payrollHours(rules.weeklyOvertimeMinutes)} weekly</strong>
        <small>Daily OT is counted before weekly OT.</small>
      </article>
      <article>
        <span>Export source</span>
        <strong>Clock-in/out records only</strong>
        <small>Scheduled hours and salary defaults are excluded from payroll export.</small>
      </article>
      <article>
        <span>Breaks</span>
        <strong>{rules.unpaidBreaks ? 'Unpaid' : 'Paid'}</strong>
        <small>Typical break: {rules.defaultBreakMinutes} minutes.</small>
      </article>
    </section>
  )
}

function MyTimeHistory({ dashboard, defaultDate }: { dashboard: TimekeepingDashboard; defaultDate: string }) {
  const defaultPayrollWeek = useMemo(() => payrollWeekRange(defaultDate), [defaultDate])
  const [fromDate, setFromDate] = useState(defaultPayrollWeek.fromDate)
  const [throughDate, setThroughDate] = useState(defaultPayrollWeek.throughDate)
  const reviewQuery = useQuery({
    queryKey: ['my-timekeeping-review', dashboard.employee.id, fromDate, throughDate],
    queryFn: () => getOwnTimekeepingReview({
      employeeId: dashboard.employee.id,
      fromDate,
      throughDate,
    }),
  })
  const review = reviewQuery.data

  return (
    <section className="my-time-history" aria-labelledby="my-time-history-title">
      <div className="my-time-history__heading">
        <div>
          <p className="eyebrow">My time</p>
          <h2 id="my-time-history-title">My Time & Attendance</h2>
          <p>
            View your own pay-period time, breaks, overtime, salary defaults, and pending corrections.
            Team payroll tools stay separate for supervisors and admins.
          </p>
        </div>
        <div className="time-review-range" aria-label="My time date range">
          <label><span>From</span><input max={throughDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
        </div>
      </div>

      {reviewQuery.isPending ? (
        <DataStatePanel icon={FileClock} title="Loading your time"><p>Calculating your time records for the selected range.</p></DataStatePanel>
      ) : reviewQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Your time could not be loaded" tone="error"><p>{reviewQuery.error.message}</p></DataStatePanel>
      ) : review ? (
        <>
          <section className="my-time-history__metrics" aria-label="My time totals">
            <article>
              <span>Paid</span>
              <strong>{payrollHours(review.summary.paidMinutes)} hr</strong>
              <small>Total paid time in this range.</small>
            </article>
            <article>
              <span>Regular</span>
              <strong>{payrollHours(review.summary.regularMinutes)} hr</strong>
              <small>Regular payroll hours.</small>
            </article>
            <article className={review.summary.overtimeMinutes ? 'import-metric--attention' : ''}>
              <span>OT</span>
              <strong>{payrollHours(review.summary.overtimeMinutes)} hr</strong>
              <small>Daily or weekly overtime.</small>
            </article>
            <article className={review.summary.pendingCorrectionCount ? 'import-metric--attention' : ''}>
              <span>Corrections</span>
              <strong>{review.summary.pendingCorrectionCount}</strong>
              <small>Waiting for supervisor review.</small>
            </article>
          </section>

          {review.rows.length === 0 ? (
            <DataStatePanel icon={FileClock} title="No time records in this range">
              <p>Your punches or salary default will appear here once time exists for the selected dates.</p>
            </DataStatePanel>
          ) : (
            <div className="my-time-history__list" aria-label="My time records">
              {review.rows.map((row) => (
                <article className="my-time-row" key={`${row.employeeId}-${row.shiftId ?? row.rowKind}-${row.operationalDate}`}>
                  <div className="my-time-row__date">
                    <strong>{formatDateOnly(row.operationalDate)}</strong>
                    <span>{row.rowKind === 'salary_default' ? 'Salary default' : row.locationName}</span>
                  </div>
                  <div>
                    <strong>{row.postName ?? row.eventName ?? row.locationName}</strong>
                    <span>
                      {row.firstClockIn ? formatTime(row.firstClockIn, row.timeZone) : '—'}
                      {' '}to{' '}
                      {row.lastClockOut ? formatTime(row.lastClockOut, row.timeZone) : '—'}
                    </span>
                    {row.payrollNotes.length > 0 ? <small>{row.payrollNotes.join(' ')}</small> : null}
                  </div>
                  <div className="my-time-row__hours">
                    <strong>{payrollHours(row.paidMinutes)} hr</strong>
                    <span>{row.breakMinutes} break min</span>
                  </div>
                  <div className="my-time-row__status">
                    {row.payrollReady ? (
                      <span className="payroll-status payroll-status--ready">Ready</span>
                    ) : (
                      <span className="payroll-status payroll-status--hold">Needs review</span>
                    )}
                    {row.exceptionCodes.length > 0 ? <small>{row.exceptionCodes.map(exceptionLabel).join(', ')}</small> : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}

function PayrollReviewTable({
  canManageTime,
  rows,
  onReviewEmployeeTime,
}: {
  canManageTime: boolean
  rows: TimekeepingReviewRow[]
  onReviewEmployeeTime: (row: TimekeepingReviewRow) => void
}) {
  if (rows.length === 0) {
    return (
      <DataStatePanel icon={FileClock} title="No time records in this range">
        <p>Recorded punches will appear here once employees begin using the time clock.</p>
      </DataStatePanel>
    )
  }

  return (
    <div className="time-review-table-wrap">
      <table className="time-review-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Type</th>
            <th>Date</th>
            <th>Location</th>
            <th>Clock in</th>
            <th>Clock out</th>
            <th>Regular</th>
            <th>OT</th>
            <th>Paid</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.employeeId}-${row.shiftId ?? 'unscheduled'}-${row.operationalDate}`}>
              <td>
                <strong>{row.employeeName}</strong>
                <span>@{row.username}</span>
                {canManageTime ? (
                  <button className="time-review-jump-button" onClick={() => onReviewEmployeeTime(row)} type="button">
                    Review / edit time
                  </button>
                ) : null}
              </td>
              <td>
                <strong>{rowKindLabels[row.rowKind]}</strong>
                {row.weekStartsOn && row.weekEndsOn ? <span>{formatDateOnly(row.weekStartsOn)} - {formatDateOnly(row.weekEndsOn)}</span> : null}
              </td>
              <td>{formatDateOnly(row.operationalDate)}</td>
              <td>
                <strong>{row.locationName}</strong>
                <span>{[row.siteCode, row.postName ?? row.eventName].filter(Boolean).join(' · ') || 'Time clock'}</span>
              </td>
              <td>{row.firstClockIn ? formatTime(row.firstClockIn, row.timeZone) : row.rowKind === 'salary_default' ? 'Payroll default' : 'Missing'}</td>
              <td>{row.lastClockOut ? formatTime(row.lastClockOut, row.timeZone) : row.rowKind === 'salary_default' ? 'Payroll default' : 'Missing'}</td>
              <td>
                <strong>{payrollHours(row.regularMinutes)} hr</strong>
                {row.salaryDefaultMinutes > 0 ? <span>{payrollHours(row.salaryDefaultMinutes)} salary default</span> : null}
              </td>
              <td>
                <strong>{payrollHours(row.overtimeMinutes)} hr</strong>
                {row.timeOffMinutes > 0 ? <span>{payrollHours(row.timeOffMinutes)} time off</span> : null}
              </td>
              <td>
                <strong>{payrollHours(row.paidMinutes)} hr</strong>
                <span>{row.breakMinutes} break min</span>
              </td>
              <td>
                {row.payrollReady ? (
                  <span className="payroll-status payroll-status--ready">Ready</span>
                ) : (
                  <span className="payroll-status payroll-status--hold">Needs review</span>
                )}
                {row.exceptionCodes.length > 0 ? (
                  <small>{row.exceptionCodes.map(exceptionLabel).join(', ')}</small>
                ) : null}
                {row.payrollNotes.length > 0 ? (
                  <small>{row.payrollNotes.join(' ')}</small>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CorrectionReviewCard({
  correction,
  pending,
  onDecision,
}: {
  correction: PendingCorrection
  pending: boolean
  onDecision: (approved: boolean, note: string | null) => void
}) {
  const [declineNote, setDeclineNote] = useState('')

  return (
    <article className="correction-card">
      <div>
        <span className="payroll-status payroll-status--hold">{correction.voided ? 'Void requested' : 'Time change requested'}</span>
        <h3>{correction.employeeName}</h3>
        <p>
          {eventLabels[correction.kind]} at {formatTime(correction.recordedAt)}
          {correction.replacementTime ? ` → ${formatTime(correction.replacementTime)}` : ''}
        </p>
        <blockquote>{correction.reason}</blockquote>
      </div>
      <div className="correction-card__actions">
        <button
          className="secondary-button"
          disabled={pending}
          onClick={() => onDecision(true, null)}
          type="button"
        >
          Approve
        </button>
        <label>
          <span className="visually-hidden">Decline reason for {correction.employeeName}</span>
          <textarea
            maxLength={700}
            onChange={(event) => setDeclineNote(event.target.value)}
            placeholder="Reason if declined"
            rows={2}
            value={declineNote}
          />
        </label>
        <button
          className="danger-primary"
          disabled={pending || declineNote.trim().length === 0}
          onClick={() => onDecision(false, declineNote.trim())}
          type="button"
        >
          Decline
        </button>
      </div>
    </article>
  )
}

function PendingCorrections({
  corrections,
  pending,
  onDecision,
}: {
  corrections: PendingCorrection[]
  pending: boolean
  onDecision: (correctionId: string, approved: boolean, note: string | null) => void
}) {
  if (corrections.length === 0) {
    return (
      <DataStatePanel icon={CheckCircle2} title="No correction requests are waiting">
        <p>Employee correction requests will appear here before they affect payroll-ready totals.</p>
      </DataStatePanel>
    )
  }

  return (
    <div className="correction-list">
      {corrections.map((correction) => (
        <CorrectionReviewCard
          correction={correction}
          key={correction.id}
          onDecision={(approved, note) => onDecision(correction.id, approved, note)}
          pending={pending}
        />
      ))}
    </div>
  )
}

function payrollLockBlocker(review: TimekeepingReview | undefined): string {
  if (!review) return 'Load the payroll review before locking an export.'
  if (review.summary.rowCount === 0) return 'There are no time records in this range yet.'
  if (review.summary.pendingCorrectionCount > 0) return 'Resolve every pending correction request first.'
  if (review.summary.exceptionCount > 0) return 'Fix every row marked “Needs review” before locking payroll.'
  if (review.summary.readyCount !== review.summary.rowCount) return 'Every row must be marked Ready before payroll can be locked.'
  return ''
}

function PayrollExportHistoryList({ batches }: { batches: PayrollExportBatch[] }) {
  if (batches.length === 0) {
    return (
      <DataStatePanel icon={Archive} title="No locked payroll exports yet">
        <p>Locked batches will appear here after a supervisor exports a clean review range.</p>
      </DataStatePanel>
    )
  }

  return (
    <ol className="payroll-export-history-list">
      {batches.map((batch) => (
        <li className="payroll-export-history-item" key={batch.id}>
          <div>
            <strong>{batch.fromDate} to {batch.throughDate}</strong>
            <span>{batch.rowCount} rows · {payrollHours(batch.paidMinutes)} paid hours · locked by {batch.createdByName ?? 'Unknown'}</span>
            <small>{formatDate(batch.createdAt)} · {formatTime(batch.createdAt)} · {shortDigest(batch.digest)}</small>
          </div>
          <p>{batch.note}</p>
        </li>
      ))}
    </ol>
  )
}

function SupervisorTimeReview({
  canExportPayroll,
  canManageTime,
  defaultDate,
  onReviewEmployeeTime,
}: {
  canExportPayroll: boolean
  canManageTime: boolean
  defaultDate: string
  onReviewEmployeeTime: (row: TimekeepingReviewRow) => void
}) {
  const queryClient = useQueryClient()
  const defaultPayrollWeek = useMemo(() => payrollWeekRange(defaultDate), [defaultDate])
  const [fromDate, setFromDate] = useState(defaultPayrollWeek.fromDate)
  const [throughDate, setThroughDate] = useState(defaultPayrollWeek.throughDate)
  const [exportNote, setExportNote] = useState('')
  const [lastExport, setLastExport] = useState<PayrollExportBatch | null>(null)
  const reviewQuery = useQuery({
    queryKey: ['timekeeping-review', fromDate, throughDate],
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
  })
  const exportHistoryQuery = useQuery({
    queryKey: ['payroll-export-history'],
    queryFn: () => getPayrollExportHistory(12),
  })
  const correctionMutation = useMutation({
    mutationFn: (input: { correctionId: string; approved: boolean; note: string | null }) => reviewTimeEventCorrection(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timekeeping-review'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
      ])
    },
  })
  const exportMutation = useMutation({
    mutationFn: (note: string) => createPayrollExportBatch({ fromDate, throughDate, note }),
    onSuccess: async (batch) => {
      setLastExport(batch)
      setExportNote('')
      await queryClient.invalidateQueries({ queryKey: ['payroll-export-history'] })
    },
  })
  const review = useMemo(() => workedTimePayrollReview(reviewQuery.data), [reviewQuery.data])
  const lockBlockedReason = payrollLockBlocker(review)
  const canLockExport = Boolean(canExportPayroll && review && lockBlockedReason === '' && exportNote.trim().length > 0 && !exportMutation.isPending)

  return (
    <section className="time-review-workbench" aria-labelledby="supervisor-time-title">
      <div className="time-review-workbench__heading">
        <div>
          <p className="eyebrow">Supervisor payroll review</p>
          <h2 id="supervisor-time-title">Review time before payroll export</h2>
          <p>Rows stay marked “Needs review” until the punch sequence is complete and correction requests are resolved.</p>
        </div>
        <div className="time-review-range" aria-label="Time review date range">
          <label><span>From</span><input max={throughDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
        </div>
      </div>

      {reviewQuery.isPending ? (
        <DataStatePanel icon={FileClock} title="Loading payroll review"><p>Calculating paid time, breaks, corrections, and exception flags.</p></DataStatePanel>
      ) : reviewQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Payroll review unavailable" tone="error"><p>{reviewQuery.error.message}</p></DataStatePanel>
      ) : review ? (
        <>
          <section className="time-review-metrics" aria-label="Payroll review totals">
            <article><span>Worked rows</span><strong>{review.summary.rowCount}</strong><small>Clock-in/out groups in range</small></article>
            <article><span>Regular</span><strong>{payrollHours(review.summary.regularMinutes)}</strong><small>Regular worked hours</small></article>
            <article className={review.summary.overtimeMinutes ? 'import-metric--attention' : ''}><span>OT</span><strong>{payrollHours(review.summary.overtimeMinutes)}</strong><small>Daily/weekly overtime</small></article>
            <article><span>Paid hours</span><strong>{payrollHours(review.summary.paidMinutes)}</strong><small>Worked-time export preview</small></article>
          </section>

          <PayrollRulesPanel review={review} />

          <div className="inline-note">
            Payroll export includes only time recorded by SygShift clock-in/out punches. Scheduled shifts and salary
            default rows are not exported.
          </div>

          {correctionMutation.isError ? <div className="inline-alert" role="alert">{correctionMutation.error.message}</div> : null}

          <div className="time-review-actions">
            <p><FileWarning aria-hidden="true" size={18} /> CSV is a preview for checking totals. Locking creates the official payroll audit batch.</p>
            {canExportPayroll ? (
              <button className="secondary-button" disabled={review.rows.length === 0} onClick={() => exportPayrollCsv(review)} type="button">
                <Download aria-hidden="true" size={18} /> Export Summary CSV
              </button>
            ) : null}
          </div>

          {canExportPayroll ? (
            <section className="payroll-lock-panel" aria-labelledby="payroll-lock-title">
            <div className="payroll-lock-panel__copy">
              <p className="eyebrow">Controlled export</p>
              <h3 id="payroll-lock-title">Lock clean payroll for this range</h3>
              <p>
                The database rechecks the review before saving anything. If a correction is pending,
                a clock-out is missing, or any row is not ready, the export is blocked.
              </p>
              {lastExport ? (
                <div className="payroll-lock-success" role="status">
                  <CheckCircle2 aria-hidden="true" size={18} />
                  <span>
                    {lastExport.duplicate ? 'This exact payroll batch was already locked.' : 'Payroll export locked.'}
                    {' '}Batch {shortDigest(lastExport.digest)} · {lastExport.rowCount} rows · {payrollHours(lastExport.paidMinutes)} paid hours.
                  </span>
                </div>
              ) : null}
              {exportMutation.isError ? <div className="inline-alert" role="alert">{exportMutation.error.message}</div> : null}
            </div>
            <div className="payroll-lock-controls">
              <label>
                <span>Audit note</span>
                <textarea
                  maxLength={240}
                  onChange={(event) => setExportNote(event.target.value)}
                  placeholder="Example: Reviewed and ready for payroll."
                  rows={3}
                  value={exportNote}
                />
              </label>
              <button
                className="primary-action"
                disabled={!canLockExport}
                onClick={() => exportMutation.mutate(exportNote.trim())}
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={18} />
                {exportMutation.isPending ? 'Locking payroll…' : 'Lock payroll export'}
              </button>
              <small>{lockBlockedReason || (exportNote.trim() ? 'Ready to lock. The server will verify it one more time.' : 'Add a short note before locking payroll.')}</small>
            </div>
            </section>
          ) : null}

          <PayrollReviewTable canManageTime={canManageTime} onReviewEmployeeTime={onReviewEmployeeTime} rows={review.rows} />

          {canManageTime ? (
            <section className="time-panel time-corrections-panel" aria-labelledby="pending-corrections-title">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Corrections</p>
                  <h2 id="pending-corrections-title">Pending correction requests</h2>
                </div>
              </div>
              <PendingCorrections
                corrections={review.pendingCorrections}
                onDecision={(correctionId, approved, note) => correctionMutation.mutate({ correctionId, approved, note })}
                pending={correctionMutation.isPending}
              />
            </section>
          ) : null}

          <section className="time-panel payroll-history-panel" aria-labelledby="payroll-history-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Payroll history</p>
                <h2 id="payroll-history-title">Recent locked export batches</h2>
              </div>
            </div>
            {exportHistoryQuery.isPending ? (
              <DataStatePanel icon={Archive} title="Loading locked exports"><p>Retrieving recent payroll batches from the audit history.</p></DataStatePanel>
            ) : exportHistoryQuery.isError ? (
              <DataStatePanel icon={ShieldAlert} title="Payroll history unavailable" tone="error"><p>{exportHistoryQuery.error.message}</p></DataStatePanel>
            ) : (
              <PayrollExportHistoryList batches={exportHistoryQuery.data} />
            )}
          </section>
        </>
      ) : null}
    </section>
  )
}

function LiveTimekeeping() {
  const queryClient = useQueryClient()
  const punchLocked = useRef(false)
  const operationalDate = useMemo(() => formatDateKey(operationalToday()), [])
  const [maintenanceFocusRequest, setMaintenanceFocusRequest] = useState<TimeMaintenanceFocusRequest | null>(null)
  const sessionQuery = useQuery({
    queryKey: ['session-context'],
    queryFn: getSessionContext,
    enabled: isSupabaseConfigured,
  })
  const ownTimeAllowed = canViewOwnTime(sessionQuery.data)
  const punchAllowed = canUseOwnTimeClock(sessionQuery.data)
  const dashboardQuery = useQuery({
    queryKey: ['timekeeping-dashboard', operationalDate],
    queryFn: () => getTimekeepingDashboard(operationalDate),
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    refetchInterval: 15_000,
  })
  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSuccess: (event) => {
      applyTimeEventToCachedDashboards(queryClient, event)
    },
    onSettled: async () => {
      punchLocked.current = false
      await refreshTimekeepingQueriesAfterPunch(queryClient)
    },
  })

  function recordPunch(kind: TimeEventKind, shiftId?: string | null) {
    if (!punchAllowed || punchLocked.current || punchMutation.isPending) return
    punchLocked.current = true
    punchMutation.mutate({ kind, shiftId })
  }

  if (sessionQuery.isPending || (ownTimeAllowed && dashboardQuery.isPending)) {
    return <DataStatePanel icon={Timer} title="Loading timekeeping"><p>Retrieving your assigned shifts, current status, and today&apos;s recorded punches.</p></DataStatePanel>
  }

  if (sessionQuery.isError || !ownTimeAllowed) {
    return <DataStatePanel icon={ShieldAlert} title="Timekeeping is not enabled" tone="error"><p>Your account does not currently have Time & Attendance access. Ask an admin to add time.self.view or time.punch if this is incorrect.</p></DataStatePanel>
  }

  if (dashboardQuery.isError) {
    return <DataStatePanel icon={ShieldAlert} title="Timekeeping unavailable" tone="error"><p>{dashboardQuery.error.message}</p></DataStatePanel>
  }

  const dashboard = dashboardQuery.data
  if (!dashboard) {
    return <DataStatePanel icon={Timer} title="Loading timekeeping"><p>Waiting for your current clock and schedule data to finish loading.</p></DataStatePanel>
  }

  const session = sessionQuery.data
  const canManageTime = sessionCanManageTime(session)
  const canExportPayroll = sessionCanExportPayroll(session)
  const canReviewPayroll = canManageTime || canExportPayroll

  return (
    <>
      <section className="time-hero-card" aria-labelledby="live-time-title">
        <div className="time-hero-card__icon"><FileClock aria-hidden="true" size={31} /></div>
        <div>
          <p className="eyebrow">Time & Attendance</p>
          <h2 id="live-time-title">{dashboard.employee.displayName}</h2>
          <p>
            @{dashboard.employee.username} · {dashboard.employee.role} · {dashboard.employee.employmentType}
            {' '}employee · Official day {dashboard.operationalDate}
          </p>
        </div>
        <span className={dashboard.pendingCorrectionCount ? 'import-state-pill import-state-pill--attention' : 'import-state-pill'}>
          {dashboard.pendingCorrectionCount ? <CircleAlert aria-hidden="true" size={17} /> : <CheckCircle2 aria-hidden="true" size={17} />}
          {dashboard.pendingCorrectionCount ? `${dashboard.pendingCorrectionCount} correction pending` : 'No pending corrections'}
        </span>
      </section>

      {punchMutation.isError ? <div className="inline-alert" role="alert">{punchMutation.error.message}</div> : null}

      <div className="time-layout">
        <PunchControls
          canPunch={punchAllowed}
          dashboard={dashboard}
          onPunch={recordPunch}
          pending={punchMutation.isPending}
        />

        <section className="time-panel time-panel--guardrails" aria-labelledby="time-rules-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payroll guardrails</p>
              <h2 id="time-rules-title">What SygShift protects</h2>
            </div>
          </div>
          <ul>
            <li>Server time is the official payroll time.</li>
            <li>Device time is stored only for audit comparison.</li>
            <li>Breaks must be closed before clock-out.</li>
            <li>Corrections never overwrite the original punch.</li>
          </ul>
        </section>
      </div>

      <RecentEvents events={dashboard.recentEvents} />

      <MyTimeHistory dashboard={dashboard} defaultDate={operationalDate} />

      {canReviewPayroll ? (
        <>
          {canManageTime ? <TimeMaintenanceWorkbench defaultDate={operationalDate} focusRequest={maintenanceFocusRequest} /> : null}
          <SupervisorTimeReview
            canExportPayroll={canExportPayroll}
            canManageTime={canManageTime}
            defaultDate={operationalDate}
            onReviewEmployeeTime={(row) => {
              if (!canManageTime) return
              setMaintenanceFocusRequest({
                employeeId: row.employeeId,
                fromDate: row.operationalDate,
                requestId: Date.now(),
                throughDate: row.operationalDate,
              })
            }}
          />
        </>
      ) : null}
    </>
  )
}

export function LegacyTimeToolsPage() {
  return (
    <div className="page page--timekeeping">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Time & Attendance</h1>
          <p className="page-summary">
            Clock into scheduled shifts, record breaks, preserve original punch history, and prepare clean
            payroll evidence without making employees fight the system.
          </p>
        </div>
        <div className="access-note"><ShieldAlert aria-hidden="true" size={19} /> Server time is official</div>
      </section>
      {isSupabaseConfigured ? <LiveTimekeeping /> : <VerifiedTimekeepingSetup />}
    </div>
  )
}

export function TimePage() {
  return <TimeCommandCenterPage />
}

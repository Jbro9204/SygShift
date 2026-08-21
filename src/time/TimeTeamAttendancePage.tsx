import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileClock,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  getPayrollRules,
  getTeamAttendanceSummary,
  payrollHours,
  type TeamAttendanceSummaryRow,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { TimeMaintenanceWorkbench, type TimeMaintenanceFocusRequest } from '../pages/TimePage'
import { currentPayrollPeriod, formatUsDateKey, type TimePeriod } from './timeRules'
import { canManageTime, canViewTeamTime } from './timePermissions'
import {
  TimeAlertCard,
  TimeButton,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

type TeamClockState = 'off_clock' | 'working' | 'on_break'
type TeamAttendanceFilter = 'all' | TeamClockState | 'exceptions'

interface TeamAttendanceRow {
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

function rulesForPeriod(rules?: Awaited<ReturnType<typeof getPayrollRules>>): Parameters<typeof currentPayrollPeriod>[1] {
  if (!rules) return undefined
  return {
    payDateAnchor: rules.payDateAnchor,
    payFrequency: rules.payFrequency,
    weekStartsOn: rules.weekStartsOn,
  }
}

function latestEventState(kind: TeamAttendanceSummaryRow['latestKind']): TeamClockState {
  if (!kind || kind === 'clock_out') return 'off_clock'
  if (kind === 'break_start') return 'on_break'
  return 'working'
}

function statusTone(state: TeamClockState): 'neutral' | 'good' | 'warning' {
  if (state === 'working') return 'good'
  if (state === 'on_break') return 'warning'
  return 'neutral'
}

function statusLabel(state: TeamClockState): string {
  if (state === 'working') return 'Clocked in'
  if (state === 'on_break') return 'On break'
  return 'Off clock'
}

function statusFilterFromSearch(value: string | null): TeamAttendanceFilter {
  if (value === 'working' || value === 'on_break' || value === 'off_clock' || value === 'exceptions') return value
  return 'all'
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

function buildTeamRows(
  summaries: TeamAttendanceSummaryRow[],
): TeamAttendanceRow[] {
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
    || row.state !== 'off_clock',
  ).sort((left, right) => {
    const stateWeight = { working: 0, on_break: 1, off_clock: 2 }
    const stateCompare = stateWeight[left.state] - stateWeight[right.state]
    if (stateCompare !== 0) return stateCompare
    return left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' })
  })
}

function periodLabel(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>): string {
  return `${formatUsDateKey(period.fromDate)} - ${formatUsDateKey(period.throughDate)}`
}

export function TimeTeamAttendancePage() {
  const [searchParams] = useSearchParams()
  const [focusRequest, setFocusRequest] = useState<TimeMaintenanceFocusRequest | null>(null)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const defaultPeriod = currentPayrollPeriod()
  const [fromDate, setFromDate] = useState(defaultPeriod.fromDate)
  const [throughDate, setThroughDate] = useState(defaultPeriod.throughDate)
  const [rangeTouched, setRangeTouched] = useState(false)
  const [statusFilter, setStatusFilter] = useState<TeamAttendanceFilter>(statusFilterFromSearch(searchParams.get('status')))

  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const teamAllowed = canViewTeamTime(sessionQuery.data)
  const manageAllowed = canManageTime(sessionQuery.data)
  const rulesQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: getPayrollRules,
    queryKey: ['time-team-rules'],
  })

  useEffect(() => {
    if (rangeTouched || !rulesQuery.data) return
    const activePeriod = currentPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data))
    setFromDate(activePeriod.fromDate)
    setThroughDate(activePeriod.throughDate)
  }, [rangeTouched, rulesQuery.data])

  useEffect(() => {
    const nextFilter = statusFilterFromSearch(searchParams.get('status'))
    setStatusFilter((current) => (current === nextFilter ? current : nextFilter))
  }, [searchParams])

  const summaryQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: () => getTeamAttendanceSummary({ fromDate, throughDate }),
    queryKey: ['time-team-summary', fromDate, throughDate],
    refetchInterval: 30_000,
  })
  const teamRows = useMemo(
    () => buildTeamRows(summaryQuery.data?.rows ?? []),
    [summaryQuery.data?.rows],
  )
  const selectedEmployee = useMemo(
    () => teamRows.find((row) => row.employeeId === selectedEmployeeId) ?? null,
    [selectedEmployeeId, teamRows],
  )
  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return teamRows
    if (statusFilter === 'exceptions') return teamRows.filter((row) => row.pendingCorrectionCount > 0)
    return teamRows.filter((row) => row.state === statusFilter)
  }, [statusFilter, teamRows])

  const activeCount = teamRows.filter((row) => row.state === 'working').length
  const breakCount = teamRows.filter((row) => row.state === 'on_break').length
  const pendingReviewCount = teamRows.reduce((total, row) => total + row.pendingCorrectionCount, 0)
  const paidMinutes = teamRows.reduce((total, row) => total + row.paidMinutes, 0)

  function setPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>) {
    setFromDate(period.fromDate)
    setThroughDate(period.throughDate)
    setRangeTouched(true)
  }

  function focusEmployee(employeeId: string, date?: string) {
    setSelectedEmployeeId(employeeId)
    setFocusRequest({
      employeeId,
      fromDate: date ?? fromDate,
      requestId: Date.now(),
      throughDate: date ?? throughDate,
    })
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader eyebrow="Team Attendance" summary="Secure database connection is required before team attendance can load." title="Team Attendance" />
        <DataStatePanel icon={ShieldAlert} title="Secure time data is not connected" tone="setup">
          <p>Connect Supabase before live team attendance and exception correction tools can run.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isPending) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading Team Attendance">
          <p>Verifying your access and preparing team time data.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isError || !teamAllowed) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader eyebrow="Team Attendance" summary="Team attendance is controlled by Time permissions." title="Team Attendance" />
        <DataStatePanel icon={ShieldAlert} title="Team Attendance is not available" tone="error">
          <p>Your account needs time.view, time.manage, or time.export_payroll access with MFA.</p>
        </DataStatePanel>
      </main>
    )
  }

  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={
          <>
            <Link className="time-button time-button--secondary" to="/time"><ArrowRight aria-hidden="true" size={18} /><span>Time Command Center</span></Link>
            <Link className="time-button time-button--secondary" to="/time/exceptions"><AlertTriangle aria-hidden="true" size={18} /><span>Exceptions</span></Link>
          </>
        }
        eyebrow="Team Attendance"
        summary="Live team status, worked totals, and direct correction access for supervisors, schedulers, and admins."
        title="Team Attendance"
      />

      {rulesQuery.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Payroll rules could not be loaded" tone="warning">
          <p>{rulesQuery.error.message}</p>
        </TimeAlertCard>
      ) : null}

      <section className="time-card time-team-controls" aria-label="Team attendance date range and filters">
        <TimeSectionHeader
          eyebrow="Review range"
          summary={`Current view: ${periodLabel({ fromDate, throughDate })}`}
          title="Team time period"
        />
        <div className="time-team-controls__grid">
          <label><span>From</span><input max={throughDate} onChange={(event) => setPeriod({ fromDate: event.target.value, throughDate })} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setPeriod({ fromDate, throughDate: event.target.value })} type="date" value={throughDate} /></label>
          <label>
            <span>Status</span>
            <select onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} value={statusFilter}>
              <option value="all">All time activity</option>
              <option value="working">Clocked in</option>
              <option value="on_break">On break</option>
              <option value="off_clock">Off clock</option>
              <option value="exceptions">Exceptions only</option>
            </select>
          </label>
        </div>
      </section>

      <section className="time-command-grid" aria-label="Team attendance summary">
        <TimeMetricCard detail="Employees with a live working punch." icon={Timer} label="Clocked In" tone={activeCount > 0 ? 'good' : 'neutral'} value={activeCount} />
        <TimeMetricCard detail="Employees currently marked on break." icon={Clock3} label="On Break" tone={breakCount > 0 ? 'warning' : 'neutral'} value={breakCount} />
        <TimeMetricCard detail="Worked time in the selected period." icon={FileClock} label="Paid Hours" value={`${payrollHours(paidMinutes)} hr`} />
        <TimeMetricCard detail="Employee correction requests awaiting review." icon={AlertTriangle} label="Pending Reviews" tone={pendingReviewCount > 0 ? 'danger' : 'good'} value={pendingReviewCount} />
      </section>

      <section className="time-card time-team-panel" aria-labelledby="team-attendance-table-title">
        <TimeSectionHeader
          eyebrow="Team view"
          summary="Open an employee to review and fix their punch history below."
          title="Employees"
        />
        {summaryQuery.isPending ? (
          <DataStatePanel icon={Timer} title="Loading team attendance">
            <p>Calculating live status, worked totals, and pending reviews.</p>
          </DataStatePanel>
        ) : summaryQuery.isError ? (
          <DataStatePanel icon={ShieldAlert} title="Team attendance summary unavailable" tone="error"><p>{summaryQuery.error.message}</p></DataStatePanel>
        ) : filteredRows.length === 0 ? (
          <DataStatePanel icon={CheckCircle2} title="No employees match this view">
            <p>Change the filter or date range to review team attendance.</p>
          </DataStatePanel>
        ) : (
          <div className="time-review-table-wrap">
            <table className="time-review-table time-team-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Current location</th>
                  <th>First / Last</th>
                  <th>Paid time</th>
                  <th>Review</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.employeeId}>
                    <td>
                      <strong>{row.employeeName}</strong>
                      <span>@{row.username} · {row.role} · {row.employmentType}</span>
                    </td>
                    <td><TimeStatusBadge tone={statusTone(row.state)}>{statusLabel(row.state)}</TimeStatusBadge></td>
                    <td>
                      <strong>{row.currentLocation}</strong>
                      <span>{row.scheduledSummary}</span>
                    </td>
                    <td>
                      {row.firstClockIn ? (
                        <>
                          <strong>{formatOperationalDateTime(row.firstClockIn, { includeTimeZoneName: true })}</strong>
                          <span>{row.lastClockOut ? formatOperationalDateTime(row.lastClockOut, { includeTimeZoneName: true }) : 'Clock-out missing'}</span>
                        </>
                      ) : (
                        <span>No punch in range</span>
                      )}
                    </td>
                    <td>
                      <strong>{payrollHours(row.paidMinutes)} hr</strong>
                      <small>{payrollHours(row.breakMinutes)} hr break · {payrollHours(row.overtimeMinutes)} hr OT</small>
                    </td>
                    <td>
                      <TimeStatusBadge tone={row.pendingCorrectionCount > 0 ? 'warning' : 'good'}>
                        {row.pendingCorrectionCount > 0
                          ? `${row.pendingCorrectionCount} needs review`
                          : 'Clean'}
                      </TimeStatusBadge>
                      {row.pendingCorrectionCount > 0 ? <small>{row.pendingCorrectionCount} employee request{row.pendingCorrectionCount === 1 ? '' : 's'}</small> : null}
                    </td>
                    <td>
                      {manageAllowed ? (
                        <TimeButton onClick={() => focusEmployee(row.employeeId)} variant="secondary">View Details</TimeButton>
                      ) : (
                        <span>View only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {manageAllowed && selectedEmployee ? (
        <ModalDialog
          className="modal-dialog--wide modal-dialog--time-maintenance"
          description={`Review and correct ${selectedEmployee.employeeName}'s punch history for ${periodLabel({ fromDate, throughDate })}.`}
          onClose={() => {
            setSelectedEmployeeId(null)
            setFocusRequest(null)
          }}
          title={`${selectedEmployee.employeeName} time details`}
        >
          <div className="time-maintenance-modal-body">
            <TimeMaintenanceWorkbench
              defaultDate={fromDate}
              defaultPeriod={{ fromDate, throughDate }}
              focusRequest={focusRequest}
              initialEmployeeId={selectedEmployee.employeeId}
              lockEmployeeFilter
              onClose={() => {
                setSelectedEmployeeId(null)
                setFocusRequest(null)
              }}
              headingEyebrow="Punch editor"
              headingSummary="Add missing punches, change times, void mistakes, or correct the Site/Post from this focused employee view."
              headingTitle="Fix employee time"
            />
          </div>
        </ModalDialog>
      ) : null}
    </main>
  )
}

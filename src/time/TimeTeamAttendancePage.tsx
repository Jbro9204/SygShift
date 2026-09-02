import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileClock,
  MapPin,
  Search,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { canAccessRoute } from '../app/accessPolicy'
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
import { currentPayrollWeek, formatUsDateKey, type TimePeriod } from './timeRules'
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
type TeamAttendanceSort = 'status' | 'name' | 'hours'

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

function rulesForWeek(rules?: Awaited<ReturnType<typeof getPayrollRules>>): Parameters<typeof currentPayrollWeek>[1] {
  if (!rules) return undefined
  return {
    weekStartsOn: rules.weekStartsOn,
  }
}

function isDateKey(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00`)
  return !Number.isNaN(parsed.getTime()) && value === parsed.toLocaleDateString('en-CA')
}

function periodFromSearch(searchParams: URLSearchParams): Pick<TimePeriod, 'fromDate' | 'throughDate'> | null {
  const fromDate = searchParams.get('from')
  const throughDate = searchParams.get('through')
  if (!isDateKey(fromDate) || !isDateKey(throughDate) || fromDate > throughDate) return null
  return { fromDate, throughDate }
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
  const [searchParams, setSearchParams] = useSearchParams()
  const [focusRequest, setFocusRequest] = useState<TimeMaintenanceFocusRequest | null>(null)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<TeamAttendanceSort>('status')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const requestedPeriod = periodFromSearch(searchParams)
  const defaultPeriod = requestedPeriod ?? currentPayrollWeek()
  const [fromDate, setFromDate] = useState(defaultPeriod.fromDate)
  const [throughDate, setThroughDate] = useState(defaultPeriod.throughDate)
  const [rangeTouched, setRangeTouched] = useState(requestedPeriod !== null)
  const [statusFilter, setStatusFilter] = useState<TeamAttendanceFilter>(statusFilterFromSearch(searchParams.get('status')))

  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const teamAllowed = canViewTeamTime(sessionQuery.data)
  const manageAllowed = canManageTime(sessionQuery.data)
  const reviewQueueAllowed = canAccessRoute('/time/review', sessionQuery.data)
  const rulesQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: getPayrollRules,
    queryKey: ['time-team-rules'],
  })

  useEffect(() => {
    if (rangeTouched || !rulesQuery.data) return
    const activePeriod = currentPayrollWeek(undefined, rulesForWeek(rulesQuery.data))
    setFromDate(activePeriod.fromDate)
    setThroughDate(activePeriod.throughDate)
  }, [rangeTouched, rulesQuery.data])

  useEffect(() => {
    const requested = periodFromSearch(searchParams)
    if (!requested) return
    setFromDate((current) => current === requested.fromDate ? current : requested.fromDate)
    setThroughDate((current) => current === requested.throughDate ? current : requested.throughDate)
    setRangeTouched(true)
  }, [searchParams])

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
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
    return teamRows
      .filter((row) => {
        const statusMatches = statusFilter === 'all'
          || (statusFilter === 'exceptions' ? row.pendingCorrectionCount > 0 : row.state === statusFilter)
        if (!statusMatches) return false
        if (!normalizedQuery) return true
        return [row.employeeName, row.username, row.role, row.employmentType, row.currentLocation, row.scheduledSummary]
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
      })
      .sort((left, right) => {
        if (sortOrder === 'name') return left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: 'base' })
        if (sortOrder === 'hours') return right.paidMinutes - left.paidMinutes || left.employeeName.localeCompare(right.employeeName)
        const stateWeight = { working: 0, on_break: 1, off_clock: 2 }
        return stateWeight[left.state] - stateWeight[right.state] || left.employeeName.localeCompare(right.employeeName)
      })
  }, [searchQuery, sortOrder, statusFilter, teamRows])
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visibleRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize)

  useEffect(() => {
    setPage(1)
    setExpandedEmployeeId(null)
  }, [fromDate, pageSize, searchQuery, sortOrder, statusFilter, throughDate])

  const activeCount = teamRows.filter((row) => row.state === 'working').length
  const breakCount = teamRows.filter((row) => row.state === 'on_break').length
  const pendingReviewCount = teamRows.reduce((total, row) => total + row.pendingCorrectionCount, 0)
  const paidMinutes = teamRows.reduce((total, row) => total + row.paidMinutes, 0)

  function setPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>) {
    setFromDate(period.fromDate)
    setThroughDate(period.throughDate)
    setRangeTouched(true)
    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.set('from', period.fromDate)
    nextSearchParams.set('through', period.throughDate)
    setSearchParams(nextSearchParams, { replace: true })
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
        actions={reviewQueueAllowed ? <Link className="time-button time-button--secondary" to="/time/review"><AlertTriangle aria-hidden="true" size={18} /><span>Review Queue</span></Link> : undefined}
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
        <div className="time-team-controls__grid time-team-controls__grid--searchable">
          <label className="time-team-search">
            <span>Find employee</span>
            <span className="time-team-search__field"><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearchQuery(event.target.value)} placeholder="Name, username, role, or location" type="search" value={searchQuery} /></span>
          </label>
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
          <label>
            <span>Sort</span>
            <select onChange={(event) => setSortOrder(event.target.value as TeamAttendanceSort)} value={sortOrder}>
              <option value="status">Current status</option>
              <option value="name">Employee name</option>
              <option value="hours">Most paid hours</option>
            </select>
          </label>
          <label>
            <span>Rows</span>
            <select onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}>
              <option value={10}>10 per page</option>
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
            </select>
          </label>
        </div>
      </section>

      <section className="time-command-grid" aria-label="Team attendance summary">
        <TimeMetricCard ariaLabel="Clocked In: open the current live roster" detail="Employees with a live working punch." icon={Timer} label="Clocked In" to="/time/on-duty" tone={activeCount > 0 ? 'good' : 'neutral'} value={activeCount} />
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
          <div className="time-team-list">
            {visibleRows.map((row) => {
              const expanded = expandedEmployeeId === row.employeeId
              return (
                <article className={expanded ? 'time-team-person time-team-person--expanded' : 'time-team-person'} key={row.employeeId}>
                  <button
                    aria-expanded={expanded}
                    className="time-team-person__summary"
                    onClick={() => setExpandedEmployeeId(expanded ? null : row.employeeId)}
                    type="button"
                  >
                    <span className="time-team-person__identity">
                      <strong>{row.employeeName}</strong>
                      <small>@{row.username} · {row.role} · {row.employmentType}</small>
                    </span>
                    <TimeStatusBadge tone={statusTone(row.state)}>{statusLabel(row.state)}</TimeStatusBadge>
                    <span className="time-team-person__location"><MapPin aria-hidden="true" size={16} /><span>{row.currentLocation}</span></span>
                    <span className="time-team-person__hours"><strong>{payrollHours(row.paidMinutes)} hr</strong><small>{row.workedSegmentCount} worked segment{row.workedSegmentCount === 1 ? '' : 's'}</small></span>
                    <TimeStatusBadge tone={row.pendingCorrectionCount > 0 ? 'warning' : 'good'}>{row.pendingCorrectionCount > 0 ? `${row.pendingCorrectionCount} review` : 'Clean'}</TimeStatusBadge>
                    <ChevronDown aria-hidden="true" className="time-team-person__chevron" size={20} />
                  </button>
                  {expanded ? (
                    <div className="time-team-person__details">
                      <dl>
                        <div><dt>Scheduled</dt><dd>{row.scheduledSummary}</dd></div>
                        <div><dt>First punch</dt><dd>{row.firstClockIn ? formatOperationalDateTime(row.firstClockIn, { includeTimeZoneName: true }) : 'No punch in range'}</dd></div>
                        <div><dt>Last punch</dt><dd>{row.lastClockOut ? formatOperationalDateTime(row.lastClockOut, { includeTimeZoneName: true }) : row.firstClockIn ? 'Clock-out not recorded' : 'No punch in range'}</dd></div>
                        <div><dt>Break / OT</dt><dd>{payrollHours(row.breakMinutes)} hr break · {payrollHours(row.overtimeMinutes)} hr OT</dd></div>
                      </dl>
                      <div className="time-team-person__actions">
                        {manageAllowed ? <TimeButton onClick={() => focusEmployee(row.employeeId)} variant="primary">Open Employee Time</TimeButton> : <span>View-only access</span>}
                        {row.pendingCorrectionCount > 0 && reviewQueueAllowed ? <Link className="time-button time-button--secondary" to={`/time/review?employee=${row.employeeId}`}><AlertTriangle aria-hidden="true" size={18} /><span>Review Requests</span></Link> : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
        {filteredRows.length > pageSize ? (
          <div className="payroll-pagination" aria-label="Team Attendance pages">
            <span>Showing {(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, filteredRows.length)} of {filteredRows.length}</span>
            <div>
              <TimeButton disabled={safePage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} variant="secondary">Previous</TimeButton>
              <span>Page {safePage} of {pageCount}</span>
              <TimeButton disabled={safePage === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} variant="secondary">Next</TimeButton>
            </div>
          </div>
        ) : null}
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

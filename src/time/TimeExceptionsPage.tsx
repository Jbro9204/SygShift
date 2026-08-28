import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  FileClock,
  Search,
  ShieldAlert,
  Timer,
  UserRoundCheck,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { canAccessRoute } from '../app/accessPolicy'
import { getSessionContext } from '../data/auth'
import {
  getPayrollRules,
  getTimekeepingReview,
  payrollHours,
  resolveTimekeepingException,
  reviewTimeEventCorrection,
  type PayrollException,
  type PendingCorrection,
  type TimekeepingExceptionDetail,
  type TimekeepingExceptionResolutionAction,
  type TimekeepingReviewRow,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { TimeMaintenanceWorkbench, type TimeMaintenanceFocusRequest } from '../pages/TimePage'
import { canManageTime, canResolveTimeExceptions, canViewTeamTime } from './timePermissions'
import { workedTimePayrollReview } from './timePayroll'
import { TimeReviewQueueNavigation } from './TimeReviewQueueNavigation'
import { completedPayrollPeriod, currentPayrollPeriod, formatUsDateKey, shiftPayrollPeriod, type TimePeriod } from './timeRules'
import {
  TimeAlertCard,
  TimeButton,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

type ExceptionCode = PayrollException | 'pending_correction'
type ExceptionFilter = 'all' | 'missing_punches' | ExceptionCode
type ExceptionSort = 'priority' | 'date' | 'employee'

const exceptionCopy: Record<PayrollException | 'pending_correction', { label: string; help: string }> = {
  invalid_sequence: {
    help: 'Punch order does not make payroll sense. Review the employee events and correct or void the bad punch.',
    label: 'Invalid sequence',
  },
  missing_clock_in: {
    help: 'A worked row has a clock-out but no clock-in. Add or correct the missing clock-in.',
    label: 'Missing clock-in',
  },
  missing_clock_out: {
    help: 'A worked row has a clock-in but no clock-out. Add or correct the missing clock-out.',
    label: 'Missing clock-out',
  },
  pending_correction: {
    help: 'An employee correction request is waiting for supervisor/admin review.',
    label: 'Pending correction',
  },
  unscheduled: {
    help: 'The employee clocked time that is not tied to a schedule block. Fix Site/Post or confirm an Other label.',
    label: 'Unscheduled',
  },
  zero_paid_minutes: {
    help: 'The row has no payable minutes after review. Correct the times or void the bad punch.',
    label: 'Zero paid time',
  },
  multiple_work_segments: {
    help: 'The employee has more than one complete work segment. Confirm the unpaid gap and approve it only when the punches accurately describe the day.',
    label: 'Multiple work segments',
  },
  payroll_assignment_unresolved: {
    help: 'The worked occurrence is missing a reliable payroll-week anchor. Review the schedule and punches, then assign the correct Sunday payroll week with a documented reason.',
    label: 'Payroll week unresolved',
  },
}

const resolutionActionCopy: Record<TimekeepingExceptionResolutionAction, string> = {
  approved_exception: 'Approve valid exception',
  dismissed_false_positive: 'Dismiss false positive',
  reopened: 'Reopen decision',
}

function rulesForPeriod(rules?: Awaited<ReturnType<typeof getPayrollRules>>): Parameters<typeof currentPayrollPeriod>[1] {
  if (!rules) return undefined
  return {
    payDateAnchor: rules.payDateAnchor,
    payFrequency: rules.payFrequency,
    weekStartsOn: rules.weekStartsOn,
  }
}

function rowLocation(row: TimekeepingReviewRow): string {
  return [row.siteCode, row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' / ') || row.locationName
}

function rowWindow(row: TimekeepingReviewRow): string {
  const clockIn = row.firstClockIn ? formatOperationalDateTime(row.firstClockIn, { includeTimeZoneName: true, timeZone: row.timeZone }) : 'Missing clock-in'
  const clockOut = row.lastClockOut ? formatOperationalDateTime(row.lastClockOut, { includeTimeZoneName: true, timeZone: row.timeZone }) : 'Missing clock-out'
  return `${clockIn} - ${clockOut}`
}

function exceptionCodesForRow(row: TimekeepingReviewRow): ExceptionCode[] {
  return row.exceptionCodes.length > 0 ? row.exceptionCodes : ['pending_correction']
}

function filterExceptionRows(rows: TimekeepingReviewRow[], filter: ExceptionFilter): TimekeepingReviewRow[] {
  const exceptionRows = rows.filter((row) => !row.payrollReady || row.exceptionCodes.length > 0)
  if (filter === 'all') return exceptionRows
  if (filter === 'missing_punches') {
    return exceptionRows.filter((row) => row.exceptionCodes.includes('missing_clock_in') || row.exceptionCodes.includes('missing_clock_out'))
  }
  if (filter === 'pending_correction') return exceptionRows.filter((row) => row.exceptionCodes.length === 0 && !row.payrollReady)
  return exceptionRows.filter((row) => row.exceptionCodes.includes(filter))
}

function countException(rows: TimekeepingReviewRow[], code: ExceptionFilter): number {
  return filterExceptionRows(rows, code).length
}

function periodLabel(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>): string {
  return `${formatUsDateKey(period.fromDate)} - ${formatUsDateKey(period.throughDate)}`
}

function exceptionFilterFromSearch(value: string | null): ExceptionFilter {
  if (
    value === 'missing_punches'
    || value === 'unscheduled'
    || value === 'missing_clock_in'
    || value === 'missing_clock_out'
    || value === 'invalid_sequence'
    || value === 'zero_paid_minutes'
    || value === 'multiple_work_segments'
    || value === 'pending_correction'
  ) {
    return value
  }
  return 'all'
}

function dateFromSearch(value: string | null, fallback: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}

function filterRowsForEmployee(rows: TimekeepingReviewRow[], focusedEmployeeId: string | null): TimekeepingReviewRow[] {
  return focusedEmployeeId ? rows.filter((row) => row.employeeId === focusedEmployeeId) : rows
}

function PendingCorrectionCard({
  correction,
  disabled,
  note,
  onDecision,
  onNoteChange,
}: {
  correction: PendingCorrection
  disabled: boolean
  note: string
  onDecision: (approved: boolean, note: string | null) => void
  onNoteChange: (value: string) => void
}) {
  return (
    <article className="time-exception-card time-exception-card--pending">
      <div>
        <TimeStatusBadge tone="warning">{correction.voided ? 'Void requested' : 'Time change requested'}</TimeStatusBadge>
        <strong>{correction.employeeName}</strong>
        <span>@{correction.username} · {correction.kind.replaceAll('_', ' ')}</span>
        <small>
          Original {formatOperationalDateTime(correction.recordedAt, { includeTimeZoneName: true })}
          {correction.replacementTime ? ` · requested ${formatOperationalDateTime(correction.replacementTime, { includeTimeZoneName: true })}` : ''}
        </small>
        <p>{correction.reason}</p>
      </div>
      <label>
        <span>Decision note</span>
        <textarea
          maxLength={240}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Optional but recommended for payroll audit."
          rows={2}
          value={note}
        />
      </label>
      <div className="time-exception-card__actions">
        <TimeButton disabled={disabled} onClick={() => onDecision(false, note.trim() || null)} variant="danger">Decline</TimeButton>
        <TimeButton disabled={disabled} onClick={() => onDecision(true, note.trim() || null)} variant="primary">Approve</TimeButton>
      </div>
    </article>
  )
}

export function TimeExceptionsPage() {
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [focusRequest, setFocusRequest] = useState<TimeMaintenanceFocusRequest | null>(null)
  const [selectedExceptionRow, setSelectedExceptionRow] = useState<TimekeepingReviewRow | null>(null)
  const [correctionMode, setCorrectionMode] = useState(false)
  const [resolutionReason, setResolutionReason] = useState('')
  const [pendingResolution, setPendingResolution] = useState<{
    action: TimekeepingExceptionResolutionAction
    detail: TimekeepingExceptionDetail
  } | null>(null)
  const defaultPeriod = completedPayrollPeriod()
  const focusedEmployeeId = searchParams.get('employee')
  const [fromDate, setFromDate] = useState(() => dateFromSearch(searchParams.get('from'), defaultPeriod.fromDate))
  const [throughDate, setThroughDate] = useState(() => dateFromSearch(searchParams.get('through'), defaultPeriod.throughDate))
  const [rangeTouched, setRangeTouched] = useState(() => Boolean(searchParams.get('from') || searchParams.get('through')))
  const [filter, setFilter] = useState<ExceptionFilter>(exceptionFilterFromSearch(searchParams.get('show')))
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<ExceptionSort>('priority')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const [pendingPage, setPendingPage] = useState(1)
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})

  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const teamAllowed = canViewTeamTime(sessionQuery.data)
  const manageAllowed = canManageTime(sessionQuery.data)
  const resolveAllowed = canResolveTimeExceptions(sessionQuery.data)
  const teamRouteAllowed = canAccessRoute('/time/team', sessionQuery.data)
  const payrollRouteAllowed = canAccessRoute('/time/payroll', sessionQuery.data)
  const dailyReviewRouteAllowed = canAccessRoute('/time/daily-review', sessionQuery.data)
  const rulesQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: getPayrollRules,
    queryKey: ['time-exceptions-rules'],
  })

  useEffect(() => {
    if (rangeTouched || !rulesQuery.data) return
    const completedPeriod = completedPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data))
    setFromDate(completedPeriod.fromDate)
    setThroughDate(completedPeriod.throughDate)
  }, [rangeTouched, rulesQuery.data])

  useEffect(() => {
    const nextFilter = exceptionFilterFromSearch(searchParams.get('show'))
    setFilter((current) => (current === nextFilter ? current : nextFilter))
  }, [searchParams])

  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
    queryKey: ['time-exceptions-review', fromDate, throughDate],
  })
  const decisionMutation = useMutation({
    mutationFn: (input: { approved: boolean; correctionId: string; note: string | null }) => reviewTimeEventCorrection(input),
    onSuccess: async (_result, variables) => {
      setDecisionNotes((current) => {
        const next = { ...current }
        delete next[variables.correctionId]
        return next
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-payroll-review'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-attendance-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['time-team-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-team-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['time-maintenance'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
      ])
    },
  })
  const resolutionMutation = useMutation({
    mutationFn: (input: {
      action: TimekeepingExceptionResolutionAction
      detail: TimekeepingExceptionDetail
      reason: string
      row: TimekeepingReviewRow
    }) => resolveTimekeepingException({
      action: input.action,
      employeeId: input.row.employeeId,
      exceptionCode: input.detail.code,
      occurrenceFingerprint: input.detail.fingerprint,
      operationalDate: input.row.operationalDate,
      reason: input.reason,
      shiftId: input.row.shiftId,
    }),
    onSuccess: async () => {
      setPendingResolution(null)
      setResolutionReason('')
      closeExceptionModal()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-payroll-review'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-team-review'] }),
      ])
    },
  })

  const review = useMemo(() => workedTimePayrollReview(reviewQuery.data), [reviewQuery.data])
  const focusedRows = useMemo(
    () => filterRowsForEmployee(review?.rows ?? [], focusedEmployeeId),
    [focusedEmployeeId, review?.rows],
  )
  const exceptionRows = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
    return filterExceptionRows(focusedRows, filter)
      .filter((row) => !normalizedSearch || [
        row.employeeName,
        row.username,
        row.operationalDate,
        rowLocation(row),
        ...row.exceptionCodes.map((code) => exceptionCopy[code].label),
      ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch)))
      .sort((left, right) => {
        if (sortOrder === 'employee') return left.employeeName.localeCompare(right.employeeName) || left.operationalDate.localeCompare(right.operationalDate)
        if (sortOrder === 'date') return right.operationalDate.localeCompare(left.operationalDate) || left.employeeName.localeCompare(right.employeeName)
        const leftHard = left.exceptionDetails.some((detail) => detail.policy === 'hard') ? 0 : 1
        const rightHard = right.exceptionDetails.some((detail) => detail.policy === 'hard') ? 0 : 1
        return leftHard - rightHard || right.operationalDate.localeCompare(left.operationalDate) || left.employeeName.localeCompare(right.employeeName)
      })
  }, [filter, focusedRows, searchQuery, sortOrder])
  const focusedPendingCorrections = useMemo(
    () => (review?.pendingCorrections ?? []).filter((correction) => !focusedEmployeeId || correction.employeeId === focusedEmployeeId),
    [focusedEmployeeId, review?.pendingCorrections],
  )
  const matchedPendingCorrections = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
    return focusedPendingCorrections
      .filter((correction) => !normalizedSearch || [correction.employeeName, correction.username, correction.reason, correction.kind]
        .some((value) => value.toLocaleLowerCase().includes(normalizedSearch)))
      .sort((left, right) => sortOrder === 'employee'
        ? left.employeeName.localeCompare(right.employeeName)
        : right.recordedAt.localeCompare(left.recordedAt) || left.employeeName.localeCompare(right.employeeName))
  }, [focusedPendingCorrections, searchQuery, sortOrder])
  const pageCount = Math.max(1, Math.ceil(exceptionRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visibleExceptionRows = exceptionRows.slice((safePage - 1) * pageSize, safePage * pageSize)
  const pendingPageCount = Math.max(1, Math.ceil(matchedPendingCorrections.length / pageSize))
  const safePendingPage = Math.min(pendingPage, pendingPageCount)
  const visiblePendingCorrections = matchedPendingCorrections.slice((safePendingPage - 1) * pageSize, safePendingPage * pageSize)
  const activePeriod = rulesQuery.data ? currentPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data)) : currentPayrollPeriod()
  const previousPeriod = shiftPayrollPeriod({ fromDate }, -1, rulesForPeriod(rulesQuery.data))
  const totalPending = focusedPendingCorrections.length
  const totalExceptions = focusedEmployeeId
    ? filterExceptionRows(focusedRows, 'all').length
    : review?.summary.exceptionCount ?? 0
  const focusedPaidMinutes = focusedEmployeeId
    ? focusedRows.reduce((sum, row) => sum + row.paidMinutes, 0)
    : review?.summary.paidMinutes ?? 0
  const unresolvedRows = exceptionRows.length
  const pageTitle = filter === 'pending_correction' ? 'Correction Requests' : 'Exceptions'

  useEffect(() => {
    setPage(1)
    setPendingPage(1)
  }, [filter, fromDate, pageSize, searchQuery, sortOrder, throughDate])

  function setPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>) {
    setFromDate(period.fromDate)
    setThroughDate(period.throughDate)
    setRangeTouched(true)
  }

  function focusRow(row: TimekeepingReviewRow) {
    setSelectedExceptionRow(row)
    setCorrectionMode(false)
    setResolutionReason('')
    setPendingResolution(null)
    setFocusRequest({
      employeeId: row.employeeId,
      fromDate: row.operationalDate,
      requestId: Date.now(),
      throughDate: row.operationalDate,
    })
  }

  function closeExceptionModal() {
    setSelectedExceptionRow(null)
    setFocusRequest(null)
    setCorrectionMode(false)
    setResolutionReason('')
    setPendingResolution(null)
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader eyebrow="Time Exceptions" summary="Secure database connection is required before exceptions can load." title="Time Exceptions" />
        <DataStatePanel icon={ShieldAlert} title="Secure time data is not connected" tone="setup">
          <p>Connect Supabase before payroll exceptions and correction tools can run.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isPending) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading Time Exceptions">
          <p>Verifying your access and loading payroll exception data.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isError || !teamAllowed) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader eyebrow="Time Exceptions" summary="Exception review is controlled by Time permissions." title="Time Exceptions" />
        <DataStatePanel icon={ShieldAlert} title="Time Exceptions are not available" tone="error">
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
            {teamRouteAllowed ? <Link className="time-button time-button--secondary" to="/time/team"><UserRoundCheck aria-hidden="true" size={18} /><span>Team Attendance</span></Link> : null}
            {payrollRouteAllowed ? <Link className="time-button time-button--secondary" to="/time/payroll"><FileClock aria-hidden="true" size={18} /><span>Payroll</span></Link> : null}
          </>
        }
        eyebrow="Review Queue"
        summary={focusedEmployeeId
          ? 'Reviewing only the selected employee and date range from Time Maintenance.'
          : 'Find and fix the records that can block payroll: missing punches, unscheduled time, bad punch order, and pending correction requests.'}
        title={pageTitle}
      />

      <TimeReviewQueueNavigation canAccessDailyReview={dailyReviewRouteAllowed} canAccessExceptions />

      {rulesQuery.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Payroll rules could not be loaded" tone="warning">
          <p>{rulesQuery.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {decisionMutation.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Correction decision could not be saved" tone="danger">
          <p>{decisionMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {resolutionMutation.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Exception decision could not be saved" tone="danger">
          <p>{resolutionMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}

      <section className="time-card time-team-controls" aria-label="Exception date range and filters">
        <TimeSectionHeader
          eyebrow="Payroll range"
          summary={`Normal payroll cleanup should use the last completed pay period. Current view: ${periodLabel({ fromDate, throughDate })}`}
          title="Exception review range"
        />
        <div className="time-team-controls__grid time-team-controls__grid--review">
          <label className="time-team-search">
            <span>Find record</span>
            <span className="time-team-search__field"><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearchQuery(event.target.value)} placeholder="Employee, date, location, or issue" type="search" value={searchQuery} /></span>
          </label>
          <label><span>From</span><input max={throughDate} onChange={(event) => setPeriod({ fromDate: event.target.value, throughDate })} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setPeriod({ fromDate, throughDate: event.target.value })} type="date" value={throughDate} /></label>
          <label>
            <span>Show</span>
            <select onChange={(event) => setFilter(event.target.value as ExceptionFilter)} value={filter}>
              <option value="all">All exceptions</option>
              <option value="missing_punches">Missing punches</option>
              <option value="unscheduled">Unscheduled</option>
              <option value="missing_clock_in">Missing clock-in</option>
              <option value="missing_clock_out">Missing clock-out</option>
              <option value="invalid_sequence">Invalid sequence</option>
              <option value="zero_paid_minutes">Zero paid time</option>
              <option value="multiple_work_segments">Multiple work segments</option>
              <option value="pending_correction">Pending correction</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select onChange={(event) => setSortOrder(event.target.value as ExceptionSort)} value={sortOrder}>
              <option value="priority">Highest priority</option>
              <option value="date">Newest workday</option>
              <option value="employee">Employee name</option>
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
        <div className="payroll-period-controls__actions">
          <TimeButton onClick={() => setPeriod(completedPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data)))} variant="primary">Last completed pay period</TimeButton>
          <TimeButton onClick={() => setPeriod(activePeriod)} variant="secondary">Current open period</TimeButton>
          <TimeButton onClick={() => setPeriod(previousPeriod)} variant="secondary">Previous period</TimeButton>
        </div>
      </section>

      <section className="time-command-grid" aria-label="Exception summary">
        <TimeMetricCard detail="Worked rows currently blocking payroll readiness." icon={AlertTriangle} label="Blocked Rows" tone={totalExceptions > 0 ? 'danger' : 'good'} value={totalExceptions} />
        <TimeMetricCard detail="Employee correction requests waiting for action." icon={FileClock} label="Pending Requests" tone={totalPending > 0 ? 'warning' : 'good'} value={totalPending} />
        <TimeMetricCard detail="Unscheduled rows need Site/Post correction or a manual label." icon={ShieldAlert} label="Unscheduled" tone={countException(focusedRows, 'unscheduled') > 0 ? 'warning' : 'good'} value={countException(focusedRows, 'unscheduled')} />
        <TimeMetricCard detail="Paid hours across worked-time rows in this range." icon={CheckCircle2} label="Paid Hours" value={`${payrollHours(focusedPaidMinutes)} hr`} />
      </section>

      <section className="time-card time-exception-reference" aria-label="Exception meanings">
        <TimeSectionHeader
          eyebrow="What to fix"
          summary="Each exception tells you what kind of payroll cleanup is needed."
          title="Exception guide"
        />
        <div className="time-exception-guide">
          {Object.entries(exceptionCopy).map(([code, copy]) => (
            <article className={filter === code ? 'time-exception-guide__item time-exception-guide__item--selected' : 'time-exception-guide__item'} key={code}>
              <strong>{copy.label}</strong>
              <span>{copy.help}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="time-card time-team-panel" aria-labelledby="exception-list-title">
        <TimeSectionHeader
          eyebrow="Payroll blockers"
          summary="Open a blocker to review its punches, worked segments, unpaid gaps, and the rule that needs a decision."
          title="Rows needing review"
        />
        {reviewQuery.isPending ? (
          <DataStatePanel icon={Timer} title="Loading exceptions">
            <p>Checking payroll rows and correction requests.</p>
          </DataStatePanel>
        ) : reviewQuery.isError ? (
          <DataStatePanel icon={ShieldAlert} title="Exception review unavailable" tone="error"><p>{reviewQuery.error.message}</p></DataStatePanel>
        ) : unresolvedRows === 0 ? (
          <DataStatePanel icon={CheckCircle2} title="No rows match this exception view">
            <p>{filter === 'all' ? 'No payroll blockers were found in this range.' : 'Change the filter to see other exception types.'}</p>
          </DataStatePanel>
        ) : (
          <div className="time-exception-card-list">
            {visibleExceptionRows.map((row) => (
              <article className="time-exception-card" key={`${row.employeeId}-${row.operationalDate}-${row.shiftId ?? row.locationName}-${row.firstClockIn ?? 'missing-in'}-${row.lastClockOut ?? 'missing-out'}`}>
                <div>
                  <strong>{row.employeeName}</strong>
                  <span>{formatUsDateKey(row.operationalDate)} · {rowLocation(row)}</span>
                  <small>{rowWindow(row)}</small>
                  {row.mixedWorkTypes ? <small>Needs classification review</small> : row.workType === 'training' ? <small>Paid training</small> : null}
                  <div className="time-exception-card__badges">
                    {exceptionCodesForRow(row).map((code) => (
                      <TimeStatusBadge key={code} tone="warning">{exceptionCopy[code].label}</TimeStatusBadge>
                    ))}
                  </div>
                  {row.payrollNotes.length > 0 ? <p>{row.payrollNotes.join(' ')}</p> : null}
                </div>
                {manageAllowed || resolveAllowed ? (
                  <TimeButton onClick={() => focusRow(row)} variant="secondary">Review blocker</TimeButton>
                ) : (
                  <span>View only</span>
                )}
              </article>
            ))}
          </div>
        )}
        {exceptionRows.length > pageSize ? (
          <div className="payroll-pagination" aria-label="Time exception pages">
            <span>Showing {(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, exceptionRows.length)} of {exceptionRows.length}</span>
            <div>
              <TimeButton disabled={safePage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} variant="secondary">Previous</TimeButton>
              <span>Page {safePage} of {pageCount}</span>
              <TimeButton disabled={safePage === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} variant="secondary">Next</TimeButton>
            </div>
          </div>
        ) : null}
      </section>

      {manageAllowed && review && focusedPendingCorrections.length > 0 ? (
        <section className="time-card time-team-panel" aria-labelledby="pending-correction-review-title">
          <TimeSectionHeader
            eyebrow="Employee requests"
            summary="Approve or decline employee-submitted correction requests before payroll can be locked."
            title="Pending correction requests"
          />
          <div className="time-exception-card-list time-exception-card-list--pending">
            {visiblePendingCorrections.map((correction) => (
              <PendingCorrectionCard
                correction={correction}
                disabled={decisionMutation.isPending}
                key={correction.id}
                note={decisionNotes[correction.id] ?? ''}
                onDecision={(approved, note) => decisionMutation.mutate({ approved, correctionId: correction.id, note })}
                onNoteChange={(value) => setDecisionNotes((current) => ({ ...current, [correction.id]: value }))}
              />
            ))}
          </div>
          {matchedPendingCorrections.length > pageSize ? (
            <div className="payroll-pagination" aria-label="Pending correction pages">
              <span>Showing {(safePendingPage - 1) * pageSize + 1}-{Math.min(safePendingPage * pageSize, matchedPendingCorrections.length)} of {matchedPendingCorrections.length}</span>
              <div>
                <TimeButton disabled={safePendingPage === 1} onClick={() => setPendingPage((current) => Math.max(1, current - 1))} variant="secondary">Previous</TimeButton>
                <span>Page {safePendingPage} of {pendingPageCount}</span>
                <TimeButton disabled={safePendingPage === pendingPageCount} onClick={() => setPendingPage((current) => Math.min(pendingPageCount, current + 1))} variant="secondary">Next</TimeButton>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {review && (
        review.rows.some((row) => row.reviewStatus === 'corrected' || row.reviewStatus === 'approved_exception' || row.reviewStatus === 'dismissed_false_positive')
        || review.exceptionResolutionHistory.length > 0
      ) ? (
        <section className="time-card time-team-panel" aria-labelledby="resolved-exception-title">
          <TimeSectionHeader
            eyebrow="Audit history"
            summary="Resolved findings stay visible without changing or deleting the original punches."
            title="Resolved this period"
          />
          <div className="time-exception-card-list">
            {review.rows
              .filter((row) => row.reviewStatus === 'corrected' || row.reviewStatus === 'approved_exception' || row.reviewStatus === 'dismissed_false_positive')
              .map((row) => (
                <article className="time-exception-card time-exception-card--resolved" key={`resolved-${row.employeeId}-${row.operationalDate}-${row.shiftId ?? row.locationName}`}>
                  <div>
                    <TimeStatusBadge tone="good">
                      {row.reviewStatus === 'corrected' ? 'Corrected timekeeping error' : row.reviewStatus === 'approved_exception' ? 'Approved valid exception' : 'Dismissed false positive'}
                    </TimeStatusBadge>
                    <strong>{row.employeeName}</strong>
                    <span>{formatUsDateKey(row.operationalDate)} · {rowLocation(row)}</span>
                    {row.mixedWorkTypes ? <small>Needs classification review</small> : row.workType === 'training' ? <small>Paid training</small> : null}
                    <small>{payrollHours(row.paidMinutes)} paid hr · {payrollHours(row.unpaidGapMinutes)} unpaid-gap hr</small>
                  </div>
                </article>
              ))}
            {review.exceptionResolutionHistory.map((resolution) => (
              <article className="time-exception-card time-exception-card--history" key={resolution.id}>
                <div>
                  <TimeStatusBadge tone={resolution.action === 'reopened' ? 'warning' : 'good'}>{resolutionActionCopy[resolution.action]}</TimeStatusBadge>
                  <strong>{exceptionCopy[resolution.exceptionCode].label}</strong>
                  <span>{formatUsDateKey(resolution.operationalDate)} · {resolution.resolvedByName ?? 'Authorized administrator'}</span>
                  <p>{resolution.reason}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {manageAllowed || resolveAllowed ? (
        selectedExceptionRow ? (
          <ModalDialog
            className="modal-dialog--wide modal-dialog--time-maintenance"
            description={`${selectedExceptionRow.employeeName} · ${formatUsDateKey(selectedExceptionRow.operationalDate)} · ${rowLocation(selectedExceptionRow)}`}
            busy={resolutionMutation.isPending}
            busyLabel="Recording the audited exception decision..."
            onClose={closeExceptionModal}
            title={correctionMode ? 'Correct payroll exception' : 'Review payroll exception'}
          >
            {correctionMode && manageAllowed ? <div className="time-maintenance-modal-body">
              <TimeMaintenanceWorkbench
                defaultDate={selectedExceptionRow.operationalDate}
                defaultPeriod={{ fromDate: selectedExceptionRow.operationalDate, throughDate: selectedExceptionRow.operationalDate }}
                focusRequest={focusRequest}
                initialEmployeeId={selectedExceptionRow.employeeId}
                lockEmployeeFilter
                onClose={closeExceptionModal}
                headingEyebrow="Exception correction"
                headingSummary="Add missing punches, change times, void mistakes, or correct the Site/Post for this payroll blocker."
                headingTitle="Fix punch records"
              />
            </div> : (
              <div className="time-exception-review">
                <div className="time-exception-review__summary">
                  <article>
                    <span>Scheduled shift</span>
                    <strong>{selectedExceptionRow.scheduledStartsAt && selectedExceptionRow.scheduledEndsAt
                      ? `${formatOperationalDateTime(selectedExceptionRow.scheduledStartsAt, { timeZone: selectedExceptionRow.timeZone })} - ${formatOperationalDateTime(selectedExceptionRow.scheduledEndsAt, { timeZone: selectedExceptionRow.timeZone })}`
                      : 'No linked schedule block'}</strong>
                  </article>
                  <article><span>Actual worked</span><strong>{payrollHours(selectedExceptionRow.paidMinutes)} hr</strong></article>
                  <article><span>Unpaid gaps</span><strong>{payrollHours(selectedExceptionRow.unpaidGapMinutes)} hr</strong></article>
                  <article><span>Time category</span><strong>{selectedExceptionRow.mixedWorkTypes ? 'Needs classification review' : selectedExceptionRow.workType === 'training' ? 'Paid training' : 'Worked time'}</strong></article>
                  <article><span>Review state</span><strong>{selectedExceptionRow.reviewStatus.replaceAll('_', ' ')}</strong></article>
                </div>

                <section className="time-exception-review__section">
                  <h3>Punch timeline</h3>
                  <div className="time-exception-timeline">
                    {selectedExceptionRow.eventTimeline.map((event) => (
                      <article key={event.id}>
                        <TimeStatusBadge tone={event.kind === 'clock_in' || event.kind === 'break_end' ? 'good' : 'neutral'}>{event.kind.replaceAll('_', ' ')}</TimeStatusBadge>
                        <strong>{formatOperationalDateTime(event.effectiveAt, { includeTimeZoneName: true, timeZone: selectedExceptionRow.timeZone })}</strong>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="time-exception-review__section">
                  <h3>Calculated work segments</h3>
                  <div className="time-exception-segments">
                    {selectedExceptionRow.workedSegments.map((segment) => (
                      <article key={segment.segmentNumber}>
                        <strong>Segment {segment.segmentNumber}</strong>
                        <span>{formatOperationalDateTime(segment.startsAt, { timeZone: selectedExceptionRow.timeZone })} - {segment.endsAt ? formatOperationalDateTime(segment.endsAt, { timeZone: selectedExceptionRow.timeZone }) : 'Open'}</span>
                        <small>{payrollHours(segment.paidMinutes)} paid hr{segment.breakMinutes > 0 ? ` · ${payrollHours(segment.breakMinutes)} unpaid break hr` : ''}</small>
                      </article>
                    ))}
                    {selectedExceptionRow.unpaidGaps.map((gap) => (
                      <article className="time-exception-segments__gap" key={`${gap.startsAt}-${gap.endsAt}`}>
                        <strong>Unpaid gap</strong>
                        <span>{formatOperationalDateTime(gap.startsAt, { timeZone: selectedExceptionRow.timeZone })} - {formatOperationalDateTime(gap.endsAt, { timeZone: selectedExceptionRow.timeZone })}</span>
                        <small>{payrollHours(gap.minutes)} unpaid hr</small>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="time-exception-review__section">
                  <h3>Rules requiring review</h3>
                  <div className="time-exception-rule-list">
                    {selectedExceptionRow.exceptionDetails.map((detail) => (
                      <article className={detail.policy === 'hard' ? 'time-exception-rule time-exception-rule--hard' : 'time-exception-rule'} key={`${detail.code}-${detail.fingerprint}`}>
                        <div>
                          <TimeStatusBadge tone={detail.policy === 'hard' ? 'danger' : 'warning'}>{detail.policy === 'hard' ? 'Hard blocker' : 'Human review allowed'}</TimeStatusBadge>
                          <strong>{exceptionCopy[detail.code].label}</strong>
                          <p>{exceptionCopy[detail.code].help}</p>
                          {detail.reason ? <small>Last decision note: {detail.reason}</small> : null}
                        </div>
                        {detail.policy === 'reviewable' && resolveAllowed ? (
                          <div className="time-exception-rule__actions">
                            <TimeButton onClick={() => setPendingResolution({ action: 'dismissed_false_positive', detail })} variant="secondary">Dismiss false positive</TimeButton>
                            <TimeButton onClick={() => setPendingResolution({ action: 'approved_exception', detail })} variant="primary">Approve valid exception</TimeButton>
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </section>

                {pendingResolution ? (
                  <section className="time-exception-decision" aria-live="polite">
                    <h3>Confirm: {resolutionActionCopy[pendingResolution.action]}</h3>
                    <p>This applies only to this exact set of punches. Any later punch change requires a new review.</p>
                    <label>
                      <span>Required reason</span>
                      <textarea autoFocus maxLength={1000} minLength={8} onChange={(event) => setResolutionReason(event.target.value)} placeholder="Explain what happened and why this record is valid or why the finding is incorrect." rows={4} value={resolutionReason} />
                    </label>
                    <div className="time-exception-decision__actions">
                      <TimeButton onClick={() => { setPendingResolution(null); setResolutionReason('') }} variant="secondary">Cancel</TimeButton>
                      <TimeButton disabled={resolutionReason.trim().length < 8 || resolutionMutation.isPending} onClick={() => resolutionMutation.mutate({ action: pendingResolution.action, detail: pendingResolution.detail, reason: resolutionReason.trim(), row: selectedExceptionRow })} variant="primary">Confirm audited decision</TimeButton>
                    </div>
                  </section>
                ) : null}

                <div className="time-exception-review__footer">
                  <TimeButton onClick={closeExceptionModal} variant="secondary">Leave unresolved</TimeButton>
                  {manageAllowed ? <TimeButton onClick={() => setCorrectionMode(true)} variant="secondary">Correct punches</TimeButton> : null}
                </div>
              </div>
            )}
          </ModalDialog>
        ) : null
      ) : null}
    </main>
  )
}

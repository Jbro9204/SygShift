import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileClock,
  ShieldAlert,
  Timer,
  UserRoundCheck,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import {
  getPayrollRules,
  getTimeMaintenance,
  getTimekeepingReview,
  payrollHours,
  reviewTimeEventCorrection,
  type PayrollException,
  type PendingCorrection,
  type TimekeepingReviewRow,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { TimeMaintenanceWorkbench, type TimeMaintenanceFocusRequest } from '../pages/TimePage'
import { canManageTime, canViewTeamTime } from './timePermissions'
import { workedTimePayrollReview } from './timePayroll'
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
type ExceptionFilter = 'all' | ExceptionCode

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
  if (filter === 'pending_correction') return exceptionRows.filter((row) => row.exceptionCodes.length === 0 && !row.payrollReady)
  return exceptionRows.filter((row) => row.exceptionCodes.includes(filter))
}

function countException(rows: TimekeepingReviewRow[], code: ExceptionFilter): number {
  return filterExceptionRows(rows, code).length
}

function periodLabel(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>): string {
  return `${formatUsDateKey(period.fromDate)} - ${formatUsDateKey(period.throughDate)}`
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
  const [focusRequest, setFocusRequest] = useState<TimeMaintenanceFocusRequest | null>(null)
  const defaultPeriod = completedPayrollPeriod()
  const [fromDate, setFromDate] = useState(defaultPeriod.fromDate)
  const [throughDate, setThroughDate] = useState(defaultPeriod.throughDate)
  const [rangeTouched, setRangeTouched] = useState(false)
  const [filter, setFilter] = useState<ExceptionFilter>('all')
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})

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
    queryKey: ['time-exceptions-rules'],
  })

  useEffect(() => {
    if (rangeTouched || !rulesQuery.data) return
    const completedPeriod = completedPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data))
    setFromDate(completedPeriod.fromDate)
    setThroughDate(completedPeriod.throughDate)
  }, [rangeTouched, rulesQuery.data])

  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
    queryKey: ['time-exceptions-review', fromDate, throughDate],
  })
  const maintenanceQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && teamAllowed,
    queryFn: () => getTimeMaintenance({ fromDate, throughDate }),
    queryKey: ['time-exceptions-maintenance', fromDate, throughDate],
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
        queryClient.invalidateQueries({ queryKey: ['time-maintenance'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
      ])
    },
  })

  const review = useMemo(() => workedTimePayrollReview(reviewQuery.data), [reviewQuery.data])
  const exceptionRows = useMemo(() => filterExceptionRows(review?.rows ?? [], filter), [filter, review?.rows])
  const activePeriod = rulesQuery.data ? currentPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data)) : currentPayrollPeriod()
  const previousPeriod = shiftPayrollPeriod({ fromDate }, -1, rulesForPeriod(rulesQuery.data))
  const totalPending = review?.pendingCorrections.length ?? 0
  const totalExceptions = review?.summary.exceptionCount ?? 0
  const unresolvedRows = exceptionRows.length

  function setPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>) {
    setFromDate(period.fromDate)
    setThroughDate(period.throughDate)
    setRangeTouched(true)
  }

  function focusRow(row: TimekeepingReviewRow) {
    setFocusRequest({
      employeeId: row.employeeId,
      fromDate: row.operationalDate,
      requestId: Date.now(),
      throughDate: row.operationalDate,
    })
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
            <Link className="time-button time-button--secondary" to="/time"><ArrowRight aria-hidden="true" size={18} /><span>Time Command Center</span></Link>
            <Link className="time-button time-button--secondary" to="/time/team"><UserRoundCheck aria-hidden="true" size={18} /><span>Team Attendance</span></Link>
            <Link className="time-button time-button--secondary" to="/time/payroll"><FileClock aria-hidden="true" size={18} /><span>Payroll</span></Link>
          </>
        }
        eyebrow="Time Exceptions"
        summary="Find and fix the records that can block payroll: missing punches, unscheduled time, bad punch order, and pending correction requests."
        title="Exceptions"
      />

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

      <section className="time-card time-team-controls" aria-label="Exception date range and filters">
        <TimeSectionHeader
          eyebrow="Payroll range"
          summary={`Normal payroll cleanup should use the last completed pay period. Current view: ${periodLabel({ fromDate, throughDate })}`}
          title="Exception review range"
        />
        <div className="time-team-controls__grid">
          <label><span>From</span><input max={throughDate} onChange={(event) => setPeriod({ fromDate: event.target.value, throughDate })} type="date" value={fromDate} /></label>
          <label><span>Through</span><input min={fromDate} onChange={(event) => setPeriod({ fromDate, throughDate: event.target.value })} type="date" value={throughDate} /></label>
          <label>
            <span>Show</span>
            <select onChange={(event) => setFilter(event.target.value as ExceptionFilter)} value={filter}>
              <option value="all">All exceptions</option>
              <option value="unscheduled">Unscheduled</option>
              <option value="missing_clock_in">Missing clock-in</option>
              <option value="missing_clock_out">Missing clock-out</option>
              <option value="invalid_sequence">Invalid sequence</option>
              <option value="zero_paid_minutes">Zero paid time</option>
              <option value="pending_correction">Pending correction</option>
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
        <TimeMetricCard detail="Unscheduled rows need Site/Post correction or a manual label." icon={ShieldAlert} label="Unscheduled" tone={countException(review?.rows ?? [], 'unscheduled') > 0 ? 'warning' : 'good'} value={countException(review?.rows ?? [], 'unscheduled')} />
        <TimeMetricCard detail="Paid hours across worked-time rows in this range." icon={CheckCircle2} label="Paid Hours" value={`${payrollHours(review?.summary.paidMinutes ?? 0)} hr`} />
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
          summary="Click Work events to jump the correction workbench to the employee and day that needs attention."
          title="Rows needing review"
        />
        {reviewQuery.isPending || maintenanceQuery.isPending ? (
          <DataStatePanel icon={Timer} title="Loading exceptions">
            <p>Checking payroll rows, correction requests, and punch history.</p>
          </DataStatePanel>
        ) : reviewQuery.isError ? (
          <DataStatePanel icon={ShieldAlert} title="Exception review unavailable" tone="error"><p>{reviewQuery.error.message}</p></DataStatePanel>
        ) : maintenanceQuery.isError ? (
          <DataStatePanel icon={ShieldAlert} title="Punch maintenance unavailable" tone="error"><p>{maintenanceQuery.error.message}</p></DataStatePanel>
        ) : unresolvedRows === 0 ? (
          <DataStatePanel icon={CheckCircle2} title="No rows match this exception view">
            <p>{filter === 'all' ? 'No payroll blockers were found in this range.' : 'Change the filter to see other exception types.'}</p>
          </DataStatePanel>
        ) : (
          <div className="time-exception-card-list">
            {exceptionRows.map((row) => (
              <article className="time-exception-card" key={`${row.employeeId}-${row.operationalDate}-${row.shiftId ?? row.locationName}-${row.firstClockIn ?? 'missing-in'}-${row.lastClockOut ?? 'missing-out'}`}>
                <div>
                  <strong>{row.employeeName}</strong>
                  <span>{formatUsDateKey(row.operationalDate)} · {rowLocation(row)}</span>
                  <small>{rowWindow(row)}</small>
                  <div className="time-exception-card__badges">
                    {exceptionCodesForRow(row).map((code) => (
                      <TimeStatusBadge key={code} tone="warning">{exceptionCopy[code].label}</TimeStatusBadge>
                    ))}
                  </div>
                  {row.payrollNotes.length > 0 ? <p>{row.payrollNotes.join(' ')}</p> : null}
                </div>
                {manageAllowed ? (
                  <TimeButton onClick={() => focusRow(row)} variant="secondary">Work events</TimeButton>
                ) : (
                  <span>View only</span>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {manageAllowed && review && review.pendingCorrections.length > 0 ? (
        <section className="time-card time-team-panel" aria-labelledby="pending-correction-review-title">
          <TimeSectionHeader
            eyebrow="Employee requests"
            summary="Approve or decline employee-submitted correction requests before payroll can be locked."
            title="Pending correction requests"
          />
          <div className="time-exception-card-list time-exception-card-list--pending">
            {review.pendingCorrections.map((correction) => (
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
        </section>
      ) : null}

      {manageAllowed ? (
        <TimeMaintenanceWorkbench
          defaultDate={fromDate}
          defaultPeriod={{ fromDate, throughDate }}
          focusRequest={focusRequest}
          headingEyebrow="Exception correction"
          headingSummary="Use this controlled workbench for the actual fix: add missing punches, change times, void mistakes, or fix Site/Post from approved schedule blocks."
          headingTitle="Fix punch records"
        />
      ) : null}
    </main>
  )
}

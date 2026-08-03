import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  Download,
  FileClock,
  History,
  LockKeyhole,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import {
  createPayrollExportBatch,
  getPayrollAccountabilityEvents,
  getPayrollExportBatchDetail,
  getPayrollExportHistory,
  getPayrollRules,
  getTimekeepingReview,
  payrollHours,
  summarizePayrollRowsByEmployee,
  type PayrollAccountabilityEvent,
  type PayrollEmployeeSummary,
  type PayrollExportBatch,
  type PayrollExportDetail,
  type PayrollRules,
  type TimekeepingReview,
  type TimekeepingReviewRow,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { canExportPayroll, canViewTeamTime } from './timePermissions'
import { completedPayrollPeriod, currentPayrollPeriod, formatUsDateKey, shiftPayrollPeriod, type TimePeriod } from './timeRules'
import { payrollExportFileName, payrollLockBlocker, payrollReadinessPercent, workedTimePayrollReview } from './timePayroll'
import {
  downloadPayrollWorkbook,
  getPayrollAccountabilitySummary,
  payrollPayableMinutes,
  summarizePayrollAccountabilityByEmployee,
} from './payrollWorkbook'
import {
  TimeAlertCard,
  TimeButton,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

interface PayrollDownloadRequest {
  batchId: string
}

interface PayrollWorkbookDownload {
  accountabilityEvents: PayrollAccountabilityEvent[]
  detail: PayrollExportDetail
}

function formatPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>): string {
  return `${formatUsDateKey(period.fromDate)} - ${formatUsDateKey(period.throughDate)}`
}

function rulesForPeriod(rules?: PayrollRules): Partial<Pick<PayrollRules, 'payDateAnchor' | 'payFrequency' | 'weekStartsOn'>> | undefined {
  if (!rules) return undefined
  return {
    payDateAnchor: rules.payDateAnchor,
    payFrequency: rules.payFrequency,
    weekStartsOn: rules.weekStartsOn,
  }
}

function rowLocation(row: TimekeepingReviewRow): string {
  return [row.siteCode, row.siteName, row.postName ?? row.eventName]
    .filter(Boolean)
    .join(' / ') || row.locationName
}

function rowClock(value: string | null, row: TimekeepingReviewRow): string {
  if (value) return formatOperationalDateTime(value, { includeTimeZoneName: true, timeZone: row.timeZone })
  return 'Missing'
}

function exceptionLabel(code: string): string {
  return code.replaceAll('_', ' ')
}

function PayrollRulesSummary({ rules, period }: { period: Pick<TimePeriod, 'fromDate' | 'throughDate'>; rules?: PayrollRules }) {
  if (!rules) {
    return (
      <TimeAlertCard icon={AlertTriangle} title="Payroll rules are still loading" tone="warning">
        <p>The export page is using safe defaults until the secure payroll rules finish loading.</p>
      </TimeAlertCard>
    )
  }

  return (
    <section className="payroll-rules-panel payroll-rules-panel--page" aria-label="Payroll rules used by this export">
      <article>
        <span>Selected range</span>
        <strong>{formatPeriod(period)}</strong>
        <small>Use Last completed pay period for normal HR handoff.</small>
      </article>
      <article>
        <span>Payroll week</span>
        <strong>{rules.weekStartsOnLabel} 12:00 AM - Saturday 11:59 PM</strong>
        <small>{rules.payFrequency === 'biweekly' ? 'Biweekly pay-period export.' : 'Weekly pay-period export.'}</small>
      </article>
      <article>
        <span>Overtime</span>
        <strong>{payrollHours(rules.dailyOvertimeMinutes)} daily / {payrollHours(rules.weeklyOvertimeMinutes)} weekly</strong>
        <small>Daily overtime and weekly overtime are calculated before export.</small>
      </article>
      <article>
        <span>Export source</span>
        <strong>Clock-in/out records only</strong>
        <small>Worked payroll totals come from punches. Scheduled hours are shown beside actual hours for discrepancy review.</small>
      </article>
      <article>
        <span>Breaks</span>
        <strong>{rules.unpaidBreaks ? 'Unpaid' : 'Paid'}</strong>
        <small>Typical break reference: {rules.defaultBreakMinutes} minutes.</small>
      </article>
    </section>
  )
}

function PeriodControls({
  fromDate,
  onChange,
  rules,
  throughDate,
}: {
  fromDate: string
  onChange: (period: Pick<TimePeriod, 'fromDate' | 'throughDate'>, touched?: boolean) => void
  rules?: PayrollRules
  throughDate: string
}) {
  const periodRules = rulesForPeriod(rules)
  const selectedPeriod = { fromDate, throughDate }
  const lastCompleted = completedPayrollPeriod(undefined, periodRules)
  const activePeriod = currentPayrollPeriod(undefined, periodRules)

  return (
    <section className="time-card payroll-period-controls" aria-label="Payroll export date range">
      <TimeSectionHeader
        eyebrow="Pay period"
        summary="Choose any date range HR needs, or use a suggested payroll-period shortcut."
        title="Export range"
      />
      <div className="payroll-period-controls__fields">
        <label>
          <span>From</span>
          <input
            max={throughDate}
            onChange={(event) => onChange({ fromDate: event.target.value, throughDate }, true)}
            type="date"
            value={fromDate}
          />
        </label>
        <label>
          <span>Through</span>
          <input
            min={fromDate}
            onChange={(event) => onChange({ fromDate, throughDate: event.target.value }, true)}
            type="date"
            value={throughDate}
          />
        </label>
      </div>
      <div className="payroll-period-controls__actions">
        <TimeButton onClick={() => onChange(lastCompleted, false)} variant="primary">Last completed pay period</TimeButton>
        <TimeButton onClick={() => onChange(activePeriod, false)} variant="secondary">Current open period</TimeButton>
        <TimeButton onClick={() => onChange(shiftPayrollPeriod(selectedPeriod, -1, periodRules), false)} variant="secondary">Previous period</TimeButton>
        <TimeButton onClick={() => onChange(shiftPayrollPeriod(selectedPeriod, 1, periodRules), false)} variant="secondary">Next period</TimeButton>
      </div>
    </section>
  )
}

function PayrollExportPanel({
  accountabilityEvents,
  canLock,
  exportMutation,
  lockBlockedReason,
  note,
  onDownloadPreview,
  onNoteChange,
  review,
  rules,
}: {
  accountabilityEvents: PayrollAccountabilityEvent[]
  canLock: boolean
  exportMutation: UseMutationResult<PayrollWorkbookDownload, Error, string>
  lockBlockedReason: string
  note: string
  onDownloadPreview: () => void
  onNoteChange: (value: string) => void
  review: TimekeepingReview
  rules?: PayrollRules
}) {
  const noteMissing = note.trim().length === 0

  return (
    <section className="time-card payroll-export-panel" aria-labelledby="payroll-export-title">
      <div>
        <p className="eyebrow">Controlled export</p>
        <h2 id="payroll-export-title">Payroll handoff</h2>
        <p>
          Preview workbooks can be downloaded for checking. The official payroll export includes completed SygShift
          clock-in/out records, scheduled-vs-actual totals, accountability items, and employee detail tabs after the server verifies every worked-time row is ready.
        </p>
      </div>
      <div className="payroll-export-panel__body">
        <label>
          <span>Export note</span>
          <textarea
            maxLength={240}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="Example: Reviewed and ready for HR/Finance."
            rows={4}
            value={note}
          />
        </label>
        <div className="payroll-export-panel__actions">
          <TimeButton
            disabled={review.rows.length === 0}
            icon={Download}
            onClick={onDownloadPreview}
            variant="secondary"
          >
            Download Preview Workbook
          </TimeButton>
          <TimeButton
            disabled={!canLock}
            icon={LockKeyhole}
            loading={exportMutation.isPending}
            onClick={() => exportMutation.mutate(note.trim())}
            variant="primary"
          >
            Lock official export
          </TimeButton>
        </div>
        <small>
          {lockBlockedReason || (noteMissing ? 'Add a short export note before locking payroll.' : 'Ready to lock. The official handoff downloads as a clean employee summary; detail stays available for audit.')}
        </small>
        {accountabilityEvents.length > 0 ? (
          <small>{accountabilityEvents.length} accountability/time-off item{accountabilityEvents.length === 1 ? '' : 's'} will be included in the workbook.</small>
        ) : null}
        {rules ? <small>Workbook dates use MM/DD/YYYY and times show civilian plus military time.</small> : null}
        {exportMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{exportMutation.error.message}</p> : null}
        {exportMutation.isSuccess ? (
          <p className="form-feedback form-feedback--success" role="status">
            {exportMutation.data.detail.batch.duplicate ? 'This exact payroll batch was already locked.' : 'Official payroll export locked and downloaded.'}
            {' '}Batch {exportMutation.data.detail.batch.digest.slice(0, 10)}.
          </p>
        ) : null}
      </div>
    </section>
  )
}

function PayrollExceptions({ rows }: { rows: TimekeepingReviewRow[] }) {
  const exceptionRows = rows.filter((row) => !row.payrollReady || row.exceptionCodes.length > 0)

  if (exceptionRows.length === 0) {
    return (
      <TimeAlertCard icon={CheckCircle2} title="No payroll blockers in this range" tone="good">
        <p>Rows are ready from an export standpoint. Still review totals before locking the official batch.</p>
      </TimeAlertCard>
    )
  }

  return (
    <section className="time-card payroll-exception-list" aria-labelledby="payroll-exceptions-title">
      <TimeSectionHeader
        eyebrow="Fix before locking"
        summary="Official export is blocked until these rows are corrected or reviewed."
        title="Payroll blockers"
      />
      <div className="payroll-exception-list__items">
        {exceptionRows.map((row) => (
          <article key={`${row.employeeId}-${row.shiftId ?? row.operationalDate}-${row.rowKind}`}>
            <div>
              <strong>{row.employeeName}</strong>
              <span>{formatUsDateKey(row.operationalDate)} · {rowLocation(row)}</span>
            </div>
            <TimeStatusBadge tone="warning">{row.exceptionCodes.length ? row.exceptionCodes.map(exceptionLabel).join(', ') : 'Needs review'}</TimeStatusBadge>
          </article>
        ))}
      </div>
    </section>
  )
}

function PayrollEmployeeSummaryTable({
  accountabilityEvents,
  onSelectEmployee,
  selectedEmployeeId,
  summaries,
}: {
  accountabilityEvents: PayrollAccountabilityEvent[]
  onSelectEmployee: (employeeId: string) => void
  selectedEmployeeId: string | null
  summaries: PayrollEmployeeSummary[]
}) {
  const accountabilitySummaries = useMemo(
    () => summarizePayrollAccountabilityByEmployee(accountabilityEvents),
    [accountabilityEvents],
  )
  const tableSummaries = useMemo(() => {
    const employeeIds = [...new Set([
      ...summaries.map((summary) => summary.employeeId),
      ...accountabilitySummaries.map((summary) => summary.employeeId),
    ])]

    return employeeIds.map((employeeId) => {
      const workedSummary = summaries.find((summary) => summary.employeeId === employeeId)
      const accountabilitySummary = getPayrollAccountabilitySummary(employeeId, accountabilitySummaries)
      const sickPtoMinutes = (accountabilitySummary?.sickPayMinutes ?? 0) + (accountabilitySummary?.vacationPayMinutes ?? 0)
      const reviewCount = accountabilitySummary?.reviewCount ?? 0
      return {
        accountabilityCount: accountabilitySummary?.accountabilityCount ?? 0,
        breakMinutes: workedSummary?.breakMinutes ?? 0,
        employeeId,
        employeeName: workedSummary?.employeeName ?? accountabilitySummary?.employeeName ?? 'Employee',
        employmentType: workedSummary?.employmentType ?? accountabilitySummary?.employmentType ?? 'hourly',
        exceptionCount: (workedSummary?.exceptionCount ?? 0) + reviewCount,
        hasWorkedDetail: Boolean(workedSummary),
        locationCount: workedSummary?.locationCount ?? 0,
        overtimeMinutes: workedSummary?.overtimeMinutes ?? 0,
        paidMinutes: payrollPayableMinutes(workedSummary, accountabilitySummary),
        payrollReady: (workedSummary?.payrollReady ?? true) && reviewCount === 0,
        regularMinutes: workedSummary?.regularMinutes ?? 0,
        sickPtoMinutes,
        username: workedSummary?.username ?? accountabilitySummary?.username ?? 'unknown',
        workedShiftCount: workedSummary?.workedShiftCount ?? 0,
      }
    })
  }, [accountabilitySummaries, summaries])

  if (tableSummaries.length === 0) {
    return (
      <DataStatePanel icon={FileClock} title="No worked time in this range">
        <p>No SygShift clock-in/out totals, sick reports, or PTO records are available for the selected payroll range.</p>
      </DataStatePanel>
    )
  }

  return (
    <section className="time-card payroll-employee-summary-panel" aria-labelledby="payroll-employee-summary-title">
      <TimeSectionHeader
        eyebrow="Employee totals"
        summary="The main payroll view is grouped by person. Open an employee only when you need the shift-by-shift audit detail."
        title="Pay period summary"
      />
      <div className="time-review-table-wrap">
        <table className="time-review-table payroll-employee-summary-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Worked shifts</th>
              <th>Regular</th>
              <th>OT</th>
              <th>Breaks</th>
              <th>Sick/PTO</th>
              <th>Total payable</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {tableSummaries.map((summary) => (
              <tr className={selectedEmployeeId === summary.employeeId ? 'payroll-summary-row payroll-summary-row--selected' : 'payroll-summary-row'} key={summary.employeeId}>
                <td>
                  <strong>{summary.employeeName}</strong>
                  <span>@{summary.username} · {summary.employmentType}</span>
                </td>
                <td>
                  <strong>{summary.workedShiftCount}</strong>
                  <span>{summary.locationCount} location{summary.locationCount === 1 ? '' : 's'} · {summary.accountabilityCount} accountability</span>
                </td>
                <td><strong>{payrollHours(summary.regularMinutes)} hr</strong></td>
                <td><strong>{payrollHours(summary.overtimeMinutes)} hr</strong></td>
                <td><strong>{summary.breakMinutes} min</strong></td>
                <td><strong>{payrollHours(summary.sickPtoMinutes)} hr</strong></td>
                <td><strong>{payrollHours(summary.paidMinutes)} hr</strong></td>
                <td>
                  <TimeStatusBadge tone={summary.payrollReady ? 'good' : 'warning'}>
                    {summary.payrollReady ? 'Ready' : 'Needs review'}
                  </TimeStatusBadge>
                  {summary.exceptionCount > 0 ? <small>{summary.exceptionCount} row{summary.exceptionCount === 1 ? '' : 's'} need review</small> : null}
                </td>
                <td>
                  {summary.hasWorkedDetail ? (
                    <TimeButton
                      onClick={() => onSelectEmployee(summary.employeeId)}
                      variant={selectedEmployeeId === summary.employeeId ? 'primary' : 'secondary'}
                    >
                      {selectedEmployeeId === summary.employeeId ? 'Viewing details' : 'View details'}
                    </TimeButton>
                  ) : (
                    <TimeStatusBadge tone="neutral">Events only</TimeStatusBadge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PayrollRowsTable({
  rows,
  summary,
}: {
  rows: TimekeepingReviewRow[]
  summary: PayrollEmployeeSummary
}) {
  if (rows.length === 0) {
    return (
      <DataStatePanel icon={FileClock} title="No time records in this range">
        <p>No SygShift clock-in/out time records are available for the selected payroll range.</p>
      </DataStatePanel>
    )
  }

  return (
    <section className="time-card payroll-rows-panel" aria-labelledby="payroll-rows-title">
      <TimeSectionHeader
        eyebrow="Employee detail"
        summary={`${summary.workedShiftCount} worked shift${summary.workedShiftCount === 1 ? '' : 's'} · ${payrollHours(summary.paidMinutes)} paid hours · ${summary.exceptionCount === 0 ? 'ready for payroll' : `${summary.exceptionCount} row${summary.exceptionCount === 1 ? '' : 's'} need review`}.`}
        title={`${summary.employeeName} payroll detail`}
      />
      <div className="time-review-table-wrap">
        <table className="time-review-table payroll-rows-table">
          <thead>
            <tr>
              <th>Employee</th>
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
              <tr key={`${row.employeeId}-${row.shiftId ?? row.rowKind}-${row.operationalDate}-${row.firstClockIn ?? row.scheduledStartsAt ?? 'no-start'}`}>
                <td>
                  <strong>{row.employeeName}</strong>
                  <span>@{row.username} · {row.employmentType}</span>
                </td>
                <td>
                  <strong>{formatUsDateKey(row.operationalDate)}</strong>
                  {row.weekStartsOn && row.weekEndsOn ? <span>{formatUsDateKey(row.weekStartsOn)} - {formatUsDateKey(row.weekEndsOn)}</span> : null}
                </td>
                <td>
                  <strong>{row.locationName}</strong>
                  <span>{rowLocation(row)}</span>
                </td>
                <td>{rowClock(row.firstClockIn, row)}</td>
                <td>{rowClock(row.lastClockOut, row)}</td>
                <td>
                  <strong>{payrollHours(row.regularMinutes)} hr</strong>
                  {row.grossMinutes !== row.paidMinutes + row.breakMinutes ? <span>Gross time reviewed</span> : null}
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
                  {row.exceptionCodes.length > 0 ? <small>{row.exceptionCodes.map(exceptionLabel).join(', ')}</small> : null}
                  {row.payrollNotes.length > 0 ? <small>{row.payrollNotes.join(' ')}</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PayrollHistory({
  batches,
  downloadMutation,
}: {
  batches: PayrollExportBatch[]
  downloadMutation: UseMutationResult<PayrollWorkbookDownload, Error, PayrollDownloadRequest>
}) {
  if (batches.length === 0) {
    return (
      <DataStatePanel icon={Archive} title="No official payroll exports yet">
        <p>Locked payroll batches will appear here after the first official export is created.</p>
      </DataStatePanel>
    )
  }

  return (
    <ol className="payroll-export-history-list payroll-export-history-list--page">
      {batches.map((batch) => (
        <li className="payroll-export-history-item payroll-export-history-item--actionable" key={batch.id}>
          <div>
            <strong>{formatUsDateKey(batch.fromDate)} to {formatUsDateKey(batch.throughDate)}</strong>
            <span>{batch.rowCount} rows · {payrollHours(batch.paidMinutes)} paid hours · locked by {batch.createdByName ?? 'Unknown'}</span>
            <small>{formatOperationalDateTime(batch.createdAt, { includeTimeZoneName: true })} · {batch.digest.slice(0, 10)}</small>
          </div>
          <div>
            <p>{batch.note}</p>
            <TimeButton
              disabled={downloadMutation.isPending}
              icon={Download}
              loading={downloadMutation.isPending && downloadMutation.variables?.batchId === batch.id}
              onClick={() => downloadMutation.mutate({ batchId: batch.id })}
              variant="secondary"
            >
              Download Workbook
            </TimeButton>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function TimePayrollPage() {
  const queryClient = useQueryClient()
  const defaultPeriod = completedPayrollPeriod()
  const [fromDate, setFromDate] = useState(defaultPeriod.fromDate)
  const [throughDate, setThroughDate] = useState(defaultPeriod.throughDate)
  const [rangeTouched, setRangeTouched] = useState(false)
  const [exportNote, setExportNote] = useState('')

  const sessionQuery = useQuery({
    queryKey: ['session-context'],
    queryFn: getSessionContext,
    enabled: isSupabaseConfigured,
  })
  const reviewAllowed = canViewTeamTime(sessionQuery.data) || canExportPayroll(sessionQuery.data)
  const exportAllowed = canExportPayroll(sessionQuery.data)
  const rulesQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && reviewAllowed,
    queryKey: ['time-payroll-rules'],
    queryFn: getPayrollRules,
  })

  useEffect(() => {
    if (rangeTouched || !rulesQuery.data) return
    const completedPeriod = completedPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data))
    setFromDate(completedPeriod.fromDate)
    setThroughDate(completedPeriod.throughDate)
  }, [rangeTouched, rulesQuery.data])

  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && reviewAllowed,
    queryKey: ['time-payroll-review', fromDate, throughDate],
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
  })
  const accountabilityQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && reviewAllowed,
    queryKey: ['time-payroll-accountability', fromDate, throughDate],
    queryFn: () => getPayrollAccountabilityEvents({ fromDate, throughDate }),
  })
  const historyQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && exportAllowed,
    queryKey: ['payroll-export-history'],
    queryFn: () => getPayrollExportHistory(20),
  })
  const review = useMemo(() => workedTimePayrollReview(reviewQuery.data), [reviewQuery.data])
  const lockBlockedReason = payrollLockBlocker(review)
  const readinessPercent = payrollReadinessPercent(review)
  const employeeSummaries = useMemo(() => summarizePayrollRowsByEmployee(review?.rows ?? []), [review])
  const accountabilityEvents = accountabilityQuery.data ?? []
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const selectedSummary = useMemo(
    () => employeeSummaries.find((summary) => summary.employeeId === selectedEmployeeId) ?? null,
    [employeeSummaries, selectedEmployeeId],
  )
  const selectedRows = useMemo(
    () => review?.rows.filter((row) => row.employeeId === selectedEmployeeId) ?? [],
    [review, selectedEmployeeId],
  )

  useEffect(() => {
    if (selectedEmployeeId && !employeeSummaries.some((summary) => summary.employeeId === selectedEmployeeId)) {
      setSelectedEmployeeId(null)
    }
  }, [employeeSummaries, selectedEmployeeId])

  const downloadMutation = useMutation({
    mutationFn: async (request: PayrollDownloadRequest): Promise<PayrollWorkbookDownload> => {
      const detail = await getPayrollExportBatchDetail(request.batchId)
      const events = await getPayrollAccountabilityEvents({
        fromDate: detail.batch.fromDate,
        throughDate: detail.batch.throughDate,
      })
      return { accountabilityEvents: events, detail }
    },
    onSuccess: ({ accountabilityEvents: events, detail }) => {
      downloadPayrollWorkbook({
        accountabilityEvents: events,
        batch: detail.batch,
        exportNote: detail.batch.note,
        exportType: 'Official Locked',
        review: {
          ...detail,
          fromDate: detail.batch.fromDate,
          operationalTimeZone: 'America/Denver',
          payrollRules: rulesQuery.data,
          pendingCorrections: [],
          serverTimestamp: detail.batch.createdAt,
          summary: {
            exceptionCount: 0,
            grossMinutes: detail.batch.grossMinutes,
            overtimeMinutes: detail.rows.reduce((total, row) => total + row.overtimeMinutes, 0),
            paidMinutes: detail.batch.paidMinutes,
            pendingCorrectionCount: 0,
            readyCount: detail.rows.length,
            regularMinutes: detail.rows.reduce((total, row) => total + row.regularMinutes, 0),
            rowCount: detail.rows.length,
            salaryDefaultMinutes: 0,
            timeOffMinutes: 0,
          },
          throughDate: detail.batch.throughDate,
        },
        rules: rulesQuery.data,
      }, payrollExportFileName(detail.batch.fromDate, detail.batch.throughDate, 'official'))
    },
  })
  const exportMutation = useMutation({
    mutationFn: async (note: string): Promise<PayrollWorkbookDownload> => {
      const batch = await createPayrollExportBatch({ fromDate, note, throughDate })
      const [detail, events] = await Promise.all([
        getPayrollExportBatchDetail(batch.id),
        getPayrollAccountabilityEvents({ fromDate: batch.fromDate, throughDate: batch.throughDate }),
      ])
      return { accountabilityEvents: events, detail }
    },
    onSuccess: async ({ accountabilityEvents: events, detail }) => {
      downloadPayrollWorkbook({
        accountabilityEvents: events,
        batch: detail.batch,
        exportNote: detail.batch.note,
        exportType: 'Official Locked',
        review: {
          ...detail,
          fromDate: detail.batch.fromDate,
          operationalTimeZone: 'America/Denver',
          payrollRules: rulesQuery.data,
          pendingCorrections: [],
          serverTimestamp: detail.batch.createdAt,
          summary: {
            exceptionCount: 0,
            grossMinutes: detail.batch.grossMinutes,
            overtimeMinutes: detail.rows.reduce((total, row) => total + row.overtimeMinutes, 0),
            paidMinutes: detail.batch.paidMinutes,
            pendingCorrectionCount: 0,
            readyCount: detail.rows.length,
            regularMinutes: detail.rows.reduce((total, row) => total + row.regularMinutes, 0),
            rowCount: detail.rows.length,
            salaryDefaultMinutes: 0,
            timeOffMinutes: 0,
          },
          throughDate: detail.batch.throughDate,
        },
        rules: rulesQuery.data,
      }, payrollExportFileName(detail.batch.fromDate, detail.batch.throughDate, 'official'))
      setExportNote('')
      await queryClient.invalidateQueries({ queryKey: ['payroll-export-history'] })
    },
  })

  const totals = useMemo(() => review?.summary, [review])
  const canLock = Boolean(exportAllowed && review && lockBlockedReason === '' && exportNote.trim().length > 0 && !exportMutation.isPending)

  function setPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>, touched = true) {
    setFromDate(period.fromDate)
    setThroughDate(period.throughDate)
    setRangeTouched(touched)
  }

  function downloadSummaryPreview() {
    if (!review) return
    downloadPayrollWorkbook({
      accountabilityEvents,
      exportNote: 'Preview workbook. Official export requires locking the reviewed payroll batch.',
      exportType: 'Preview',
      review,
      rules: rulesQuery.data ?? review.payrollRules,
    }, payrollExportFileName(review.fromDate, review.throughDate, 'preview'))
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="page page--sygshift-time">
        <TimePageHeader
          eyebrow="Payroll export"
          summary="Connect Supabase before payroll rows, export history, and official locks can load."
          title="Payroll Export"
        />
        <DataStatePanel icon={ShieldAlert} title="Secure payroll data is not connected" tone="setup">
          <p>The export workflow requires the live database because official payroll batches are audited.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isPending) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={Timer} title="Loading payroll export">
          <p>Verifying your time and payroll access.</p>
        </DataStatePanel>
      </main>
    )
  }

  if (sessionQuery.isError || !reviewAllowed) {
    return (
      <main className="page page--sygshift-time">
        <DataStatePanel icon={ShieldAlert} title="Payroll export is not available" tone="error">
          <p>Your account needs Time review or Payroll export access with MFA before payroll data can be shown.</p>
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
            <Link className="time-button time-button--secondary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Time Tools</span></Link>
          </>
        }
        eyebrow="Payroll export"
        summary="Review the pay period, correct exceptions, download a clean workbook preview, then lock the official payroll batch with an audit trail."
        title="Payroll Export"
      />

      {rulesQuery.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Payroll rules could not be loaded" tone="warning">
          <p>{rulesQuery.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {downloadMutation.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Locked export download failed" tone="danger">
          <p>{downloadMutation.error.message}</p>
        </TimeAlertCard>
      ) : null}
      {accountabilityQuery.isError ? (
        <TimeAlertCard icon={AlertTriangle} title="Accountability items could not be loaded" tone="warning">
          <p>{accountabilityQuery.error.message}</p>
        </TimeAlertCard>
      ) : null}

      <section className="payroll-command-grid">
        <PeriodControls
          fromDate={fromDate}
          onChange={setPeriod}
          rules={rulesQuery.data}
          throughDate={throughDate}
        />
        <section className="time-card payroll-readiness-card">
          <TimeSectionHeader
            eyebrow="Readiness"
            summary="Official exports stay disabled until the review is clean."
            title="Payroll status"
          />
          {reviewQuery.isPending ? (
            <DataStatePanel icon={FileClock} title="Loading payroll review">
              <p>Calculating clock-in/out rows, exceptions, overtime, breaks, and corrections.</p>
            </DataStatePanel>
          ) : reviewQuery.isError ? (
            <DataStatePanel icon={ShieldAlert} title="Payroll review unavailable" tone="error">
              <p>{reviewQuery.error.message}</p>
            </DataStatePanel>
          ) : review ? (
            <div className="payroll-readiness-card__body">
              <strong>{readinessPercent === null ? 'Not ready' : `${readinessPercent}% ready`}</strong>
              <span>{review.summary.readyCount} of {review.summary.rowCount} rows ready</span>
              <TimeStatusBadge tone={lockBlockedReason ? 'warning' : 'good'}>
                {lockBlockedReason ? 'Needs review' : 'Ready to lock'}
              </TimeStatusBadge>
              <small>{lockBlockedReason || 'No blockers found for the selected payroll range.'}</small>
            </div>
          ) : null}
        </section>
      </section>

      {review ? (
        <>
          <section className="time-command-grid payroll-summary-grid" aria-label="Payroll export totals">
            <TimeMetricCard detail="Only SygShift timeclock rows in the selected range." icon={FileClock} label="Worked Rows" value={totals?.rowCount ?? 0} />
            <TimeMetricCard detail="Paid hours from completed clock-in/out records after unpaid breaks." icon={CheckCircle2} label="Paid Hours" tone="good" value={`${payrollHours(totals?.paidMinutes ?? 0)} hr`} />
            <TimeMetricCard detail="Regular hours ready for HR/Finance." icon={History} label="Regular" value={`${payrollHours(totals?.regularMinutes ?? 0)} hr`} />
            <TimeMetricCard detail="Daily/weekly overtime calculated by payroll rules." icon={AlertTriangle} label="Overtime" tone={(totals?.overtimeMinutes ?? 0) > 0 ? 'warning' : 'neutral'} value={`${payrollHours(totals?.overtimeMinutes ?? 0)} hr`} />
            <TimeMetricCard detail="Unpaid break minutes subtracted from worked time." icon={LockKeyhole} label="Breaks" value={`${payrollHours(review.summary.grossMinutes - review.summary.paidMinutes)} hr`} />
            <TimeMetricCard detail="Rows or corrections blocking official export." icon={ShieldAlert} label="Blockers" tone={(totals?.exceptionCount ?? 0) + (totals?.pendingCorrectionCount ?? 0) > 0 ? 'danger' : 'good'} value={(totals?.exceptionCount ?? 0) + (totals?.pendingCorrectionCount ?? 0)} />
          </section>

          <PayrollRulesSummary period={{ fromDate, throughDate }} rules={rulesQuery.data ?? review.payrollRules} />

          {exportAllowed ? (
            <PayrollExportPanel
              accountabilityEvents={accountabilityEvents}
              canLock={canLock}
              exportMutation={exportMutation}
              lockBlockedReason={lockBlockedReason}
              note={exportNote}
              onDownloadPreview={downloadSummaryPreview}
              onNoteChange={setExportNote}
              review={review}
              rules={rulesQuery.data ?? review.payrollRules}
            />
          ) : (
            <TimeAlertCard icon={ShieldAlert} title="Preview only" tone="warning">
              <p>You can review payroll rows, but your account does not have Payroll export permission to lock official batches.</p>
            </TimeAlertCard>
          )}

          <PayrollExceptions rows={review.rows} />
          <PayrollEmployeeSummaryTable
            accountabilityEvents={accountabilityEvents}
            onSelectEmployee={(employeeId) => setSelectedEmployeeId((current) => current === employeeId ? null : employeeId)}
            selectedEmployeeId={selectedEmployeeId}
            summaries={employeeSummaries}
          />
          {selectedSummary ? <PayrollRowsTable rows={selectedRows} summary={selectedSummary} /> : null}
        </>
      ) : null}

      {exportAllowed ? (
        <section className="time-card payroll-history-panel payroll-history-panel--page" aria-labelledby="payroll-history-title">
          <TimeSectionHeader
            eyebrow="Audit history"
            summary="Official locked batches are append-only. Use this when HR needs the file resent."
            title="Locked payroll exports"
          />
          {historyQuery.isPending ? (
            <DataStatePanel icon={Archive} title="Loading official payroll history">
              <p>Retrieving locked export batches.</p>
            </DataStatePanel>
          ) : historyQuery.isError ? (
            <DataStatePanel icon={ShieldAlert} title="Payroll history unavailable" tone="error">
              <p>{historyQuery.error.message}</p>
            </DataStatePanel>
          ) : (
            <PayrollHistory batches={historyQuery.data} downloadMutation={downloadMutation} />
          )}
        </section>
      ) : null}
    </main>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
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
  Search,
  ShieldAlert,
  Timer,
  Users,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  createPayrollExportBatch,
  correctPayrollBatchAssignment,
  getPayrollAccountabilityEvents,
  getPayrollExportBatchDetail,
  getPayrollExportHistory,
  getPayrollRules,
  getTimekeepingReview,
  payrollHours,
  reviewTimeEventCorrection,
  summarizePayrollRowsByEmployee,
  type PendingCorrection,
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
import { TimeMaintenanceWorkbench, type TimeMaintenanceFocusRequest } from '../pages/TimePage'
import { canExportPayroll, canManageTime, canOverridePayrollAssignment, canViewTeamTime } from './timePermissions'
import { completedPayrollPeriod, currentPayrollPeriod, formatUsDateKey, shiftPayrollPeriod, type TimePeriod } from './timeRules'
import { payrollExportFileName, payrollLockBlocker, payrollReadinessPercent, workedTimePayrollReview } from './timePayroll'
import {
  downloadPayrollWorkbook,
  payrollWeeklyTotalPayableMinutes,
  summarizePayrollWorkbookByWeek,
  type PayrollWeeklySummaryGroup,
  type PayrollWeeklyEmployeeSummary,
  type PayrollWorkbookDownloadResult,
  type PayrollWorkbookWeek,
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

interface PayrollSummarySelection {
  employeeId: string
  weekStartsOn: string
}

type PayrollWorkspaceSection = 'overview' | 'review' | 'employees' | 'export' | 'rules'

const payrollWorkspaceSections: Array<{ label: string; path: string; section: PayrollWorkspaceSection }> = [
  { label: 'Overview', path: '/payroll', section: 'overview' },
  { label: 'Review Queue', path: '/payroll/review', section: 'review' },
  { label: 'Employee Payroll', path: '/payroll/employees', section: 'employees' },
  { label: 'Export & History', path: '/payroll/export', section: 'export' },
  { label: 'Rules', path: '/payroll/rules', section: 'rules' },
]

function payrollWorkspaceSection(pathname: string): PayrollWorkspaceSection {
  if (pathname.startsWith('/payroll/review')) return 'review'
  if (pathname.startsWith('/payroll/employees')) return 'employees'
  if (pathname.startsWith('/payroll/export')) return 'export'
  if (pathname.startsWith('/payroll/rules')) return 'rules'
  return 'overview'
}

function validDateKey(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
}

function PayrollWorkspaceNavigation({
  activeSection,
  search,
  showRules,
}: {
  activeSection: PayrollWorkspaceSection
  search: string
  showRules: boolean
}) {
  const visibleSections = showRules
    ? payrollWorkspaceSections
    : payrollWorkspaceSections.filter((item) => item.section !== 'rules')

  return (
    <nav aria-label="Payroll workspace" className="payroll-workspace-tabs">
      {visibleSections.map((item) => (
        <Link
          aria-current={activeSection === item.section ? 'page' : undefined}
          className={activeSection === item.section ? 'payroll-workspace-tabs__link payroll-workspace-tabs__link--active' : 'payroll-workspace-tabs__link'}
          key={item.section}
          to={`${item.path}${search}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

function formatPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>): string {
  return `${formatUsDateKey(period.fromDate)} - ${formatUsDateKey(period.throughDate)}`
}

function addDateDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
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

function assignmentSourceLabel(source: TimekeepingReviewRow['payrollAssignmentSource']): string {
  const labels: Record<TimekeepingReviewRow['payrollAssignmentSource'], string> = {
    authorized_correction: 'Authorized correction',
    manual_entry: 'Manual entry clock-in',
    manual_linked_shift: 'Scheduled shift (manual entry)',
    replacement_assignment: 'Parent scheduled shift',
    salary_default: 'Salary payroll default',
    scheduled_shift: 'Scheduled shift start',
    unresolved: 'Needs payroll review',
    unscheduled_actual_punch: 'Actual clock-in',
  }
  return labels[source]
}

function isSundayDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).getUTCDay() === 0
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
        <strong>{rules.weekStartsOnLabel} {rules.payrollWeekStartTime.slice(0, 5)} - Saturday 11:59 PM</strong>
        <small>Entire overnight occurrences follow the scheduled shift start; there is no fixed morning cutoff.</small>
      </article>
      <article>
        <span>Overtime</span>
        <strong>{payrollHours(rules.dailyOvertimeMinutes)} daily / {payrollHours(rules.weeklyOvertimeMinutes)} weekly</strong>
        <small>Calculated under the separate {rules.overtimePolicyVersion} workweek policy.</small>
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
        summary="The selected period stays with you across every Payroll page and after a reload."
        title="Selected pay period"
      />
      <div className="payroll-period-status" aria-label="Selected payroll weeks">
        <TimeStatusBadge tone={fromDate === activePeriod.fromDate && throughDate === activePeriod.throughDate ? 'good' : 'neutral'}>
          {fromDate === activePeriod.fromDate && throughDate === activePeriod.throughDate ? 'Current open period' : fromDate === lastCompleted.fromDate && throughDate === lastCompleted.throughDate ? 'Last completed period' : 'Custom range'}
        </TimeStatusBadge>
        <span>Week 1 starts {formatUsDateKey(fromDate)}</span>
        {throughDate >= addDateDays(fromDate, 7) ? <span>Week 2 starts {formatUsDateKey(addDateDays(fromDate, 7))}</span> : null}
      </div>
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
        <TimeButton onClick={() => onChange(lastCompleted)} variant="primary">Last completed pay period</TimeButton>
        <TimeButton onClick={() => onChange(activePeriod)} variant="secondary">Current open period</TimeButton>
        <TimeButton onClick={() => onChange(shiftPayrollPeriod(selectedPeriod, -1, periodRules))} variant="secondary">Previous period</TimeButton>
        <TimeButton onClick={() => onChange(shiftPayrollPeriod(selectedPeriod, 1, periodRules))} variant="secondary">Next period</TimeButton>
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
  onNoteChange,
  previewMutation,
  review,
  rules,
}: {
  accountabilityEvents: PayrollAccountabilityEvent[]
  canLock: boolean
  exportMutation: UseMutationResult<PayrollWorkbookDownload, Error, string>
  lockBlockedReason: string
  note: string
  onNoteChange: (value: string) => void
  previewMutation: UseMutationResult<PayrollWorkbookDownloadResult, Error, void>
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
            disabled={(review.rows.length === 0 && accountabilityEvents.length === 0) || previewMutation.isPending}
            icon={Download}
            loading={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
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
        {previewMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">Preview download failed: {previewMutation.error.message}</p> : null}
        {previewMutation.isSuccess ? (
          <p className="form-feedback form-feedback--success" role="status">
            Preview workbook downloaded: {previewMutation.data.fileName}.
          </p>
        ) : null}
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

function PayrollExceptions({
  canWork,
  onReviewCorrection,
  onWorkRow,
  pendingCorrections,
  rows,
}: {
  canWork: boolean
  onReviewCorrection: (correction: PendingCorrection) => void
  onWorkRow: (row: TimekeepingReviewRow) => void
  pendingCorrections: PendingCorrection[]
  rows: TimekeepingReviewRow[]
}) {
  const exceptionRows = useMemo(
    () => rows.filter((row) => !row.payrollReady || row.exceptionCodes.length > 0),
    [rows],
  )
  const [search, setSearch] = useState('')
  const [queueFilter, setQueueFilter] = useState<'all' | 'blockers' | 'corrections'>('all')
  const [sortOrder, setSortOrder] = useState<'employee' | 'date'>('date')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const queueItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const corrections = queueFilter === 'blockers' ? [] : pendingCorrections.map((correction) => ({
      correction,
      date: correction.recordedAt.slice(0, 10),
      employeeName: correction.employeeName,
      key: `correction-${correction.id}`,
      kind: 'correction' as const,
    }))
    const blockers = queueFilter === 'corrections' ? [] : exceptionRows.map((row) => ({
      date: row.operationalDate,
      employeeName: row.employeeName,
      key: `row-${row.employeeId}-${row.shiftId ?? row.operationalDate}-${row.rowKind}`,
      kind: 'blocker' as const,
      row,
    }))
    return [...corrections, ...blockers]
      .filter((item) => !normalizedSearch || `${item.employeeName} ${item.date} ${item.kind === 'blocker' ? rowLocation(item.row) : item.correction.reason}`.toLocaleLowerCase().includes(normalizedSearch))
      .sort((left, right) => sortOrder === 'employee'
        ? left.employeeName.localeCompare(right.employeeName) || left.date.localeCompare(right.date)
        : left.date.localeCompare(right.date) || left.employeeName.localeCompare(right.employeeName))
  }, [exceptionRows, pendingCorrections, queueFilter, search, sortOrder])
  const pageCount = Math.max(1, Math.ceil(queueItems.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visibleItems = queueItems.slice((safePage - 1) * pageSize, safePage * pageSize)

  useEffect(() => setPage(1), [pageSize, queueFilter, search, sortOrder])

  if (exceptionRows.length === 0 && pendingCorrections.length === 0) {
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
        summary="Open each blocker here, make the correction, and return to a refreshed payroll review."
        title="Payroll blockers"
      />
      <div className="payroll-queue-controls">
        <label className="payroll-queue-search">
          <span className="sr-only">Search payroll review queue</span>
          <Search aria-hidden="true" size={18} />
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Search employee, date, location, or reason" type="search" value={search} />
        </label>
        <label>
          <span>Show</span>
          <select onChange={(event) => setQueueFilter(event.target.value as typeof queueFilter)} value={queueFilter}>
            <option value="all">All items</option>
            <option value="blockers">Payroll blockers</option>
            <option value="corrections">Correction requests</option>
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select onChange={(event) => setSortOrder(event.target.value as typeof sortOrder)} value={sortOrder}>
            <option value="date">Work date</option>
            <option value="employee">Employee name</option>
          </select>
        </label>
        <label>
          <span>Rows</span>
          <select onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>
      <div className="payroll-exception-list__items">
        {visibleItems.map((item) => item.kind === 'correction' ? (
          <article key={item.key}>
            <div className="payroll-exception-list__item-main">
              <strong>{item.correction.employeeName}</strong>
              <span>{formatUsDateKey(item.correction.recordedAt.slice(0, 10))} | {item.correction.voided ? 'Void requested' : 'Time change requested'}</span>
              <small>{item.correction.reason}</small>
            </div>
            <div className="payroll-exception-list__item-actions">
              <TimeStatusBadge tone="warning">Pending correction</TimeStatusBadge>
              {canWork ? <TimeButton onClick={() => onReviewCorrection(item.correction)} variant="primary">Review request</TimeButton> : <span>View only</span>}
            </div>
          </article>
        ) : (
          <article key={item.key}>
            <div className="payroll-exception-list__item-main">
              <strong>{item.row.employeeName}</strong>
              <span>{formatUsDateKey(item.row.operationalDate)} · {rowLocation(item.row)}</span>
            </div>
            <div className="payroll-exception-list__item-actions">
              <TimeStatusBadge tone="warning">{item.row.exceptionCodes.length ? item.row.exceptionCodes.map(exceptionLabel).join(', ') : 'Needs review'}</TimeStatusBadge>
              {canWork ? <TimeButton onClick={() => onWorkRow(item.row)} variant="primary">Fix blocker</TimeButton> : <span>View only</span>}
            </div>
          </article>
        ))}
        {visibleItems.length === 0 ? <p className="payroll-queue-empty">No review items match these filters.</p> : null}
      </div>
      {queueItems.length > pageSize ? (
        <div className="payroll-pagination" aria-label="Payroll review queue pages">
          <span>{queueItems.length} items · Page {safePage} of {pageCount}</span>
          <div>
            <TimeButton disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} variant="secondary">Previous</TimeButton>
            <TimeButton disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} variant="secondary">Next</TimeButton>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function PayrollEmployeeSummaryTable({
  groups,
  onSelectSummary,
  selectedSummary,
}: {
  groups: PayrollWeeklySummaryGroup[]
  onSelectSummary: (selection: PayrollSummarySelection) => void
  selectedSummary: PayrollSummarySelection | null
}) {
  const visibleGroups = groups.map((group) => ({
    ...group,
    summaries: group.summaries.filter((summary) => summary.hasActivity),
  }))
  const hasActivity = visibleGroups.some((group) => group.summaries.length > 0)
  const hasTrainingTime = visibleGroups.some((group) => group.summaries.some((summary) => summary.trainingMinutes > 0))

  if (!hasActivity) {
    return (
      <DataStatePanel icon={FileClock} title="No worked time in this range">
        <p>No SygShift clock-in/out totals, sick reports, or PTO records are available for the selected payroll range.</p>
      </DataStatePanel>
    )
  }

  return (
    <section className="time-card payroll-employee-summary-panel" aria-labelledby="payroll-employee-summary-title">
      <TimeSectionHeader
        eyebrow="Weekly employee totals"
        summary="Each Sunday-through-Saturday payroll week is shown separately. Overnight work remains with the week in which the occurrence began."
        title="Payroll weeks"
      />
      <div className="payroll-week-summary-list">
        {visibleGroups.map((group) => {
          const weekTotal = group.summaries.reduce((total, summary) => total + payrollWeeklyTotalPayableMinutes(summary), 0)
          return (
            <section className="payroll-week-summary" key={group.week.weekStartsOn}>
              <header className="payroll-week-summary__header">
                <div>
                  <p className="eyebrow">{group.week.label}</p>
                  <h3>{formatUsDateKey(group.week.weekStartsOn)} - {formatUsDateKey(group.week.weekEndsOn)}</h3>
                </div>
                <div className="payroll-week-summary__totals">
                  <strong>{payrollHours(weekTotal)} hr payable</strong>
                  <span>{group.summaries.length} employee{group.summaries.length === 1 ? '' : 's'} with activity</span>
                </div>
              </header>
              {group.summaries.length === 0 ? (
                <div className="payroll-week-summary__empty">No worked time, sick time, or PTO is recorded in this payroll week.</div>
              ) : (
                <div className="time-review-table-wrap">
                  <table className="time-review-table payroll-employee-summary-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Worked shifts</th>
              <th>Regular</th>
              <th>OT</th>
              <th>Worked</th>
              {hasTrainingTime ? <th>Training</th> : null}
              <th>Breaks</th>
              <th>Sick/PTO</th>
              <th>Total payable</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {group.summaries.map((summary) => {
              const isSelected = selectedSummary?.employeeId === summary.employeeId && selectedSummary.weekStartsOn === group.week.weekStartsOn
              const sickPtoMinutes = summary.sickPayMinutes + summary.vacationPayMinutes
              return (
              <tr className={isSelected ? 'payroll-summary-row payroll-summary-row--selected' : 'payroll-summary-row'} key={`${group.week.weekStartsOn}-${summary.employeeId}`}>
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
                <td><strong>{payrollHours(summary.paidMinutes)} hr</strong></td>
                {hasTrainingTime ? <td><strong>{payrollHours(summary.trainingMinutes)} hr</strong></td> : null}
                <td><strong>{summary.breakMinutes} min</strong></td>
                <td><strong>{payrollHours(sickPtoMinutes)} hr</strong></td>
                <td><strong>{payrollHours(payrollWeeklyTotalPayableMinutes(summary))} hr</strong></td>
                <td>
                  <TimeStatusBadge tone={summary.needsReview ? 'warning' : 'good'}>
                    {summary.needsReview ? 'Needs review' : 'Ready'}
                  </TimeStatusBadge>
                  {summary.exceptionCount > 0 ? <small>{summary.exceptionCount} row{summary.exceptionCount === 1 ? '' : 's'} need review</small> : null}
                </td>
                <td>
                  {summary.hasWorkedDetail ? (
                    <TimeButton
                      onClick={() => onSelectSummary({ employeeId: summary.employeeId, weekStartsOn: group.week.weekStartsOn })}
                      variant={isSelected ? 'primary' : 'secondary'}
                    >
                      {isSelected ? 'Viewing details' : 'View details'}
                    </TimeButton>
                  ) : (
                    <TimeStatusBadge tone="neutral">Events only</TimeStatusBadge>
                  )}
                </td>
              </tr>
            )})}
          </tbody>
        </table>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </section>
  )
}

function PayrollEmployeeWorkspace({
  groups,
  onOpenEmployee,
}: {
  groups: PayrollWeeklySummaryGroup[]
  onOpenEmployee: (employeeId: string) => void
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'ready' | 'review'>('all')
  const [sortOrder, setSortOrder] = useState<'employee' | 'hours-desc'>('employee')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const employees = useMemo(() => {
    const records = new Map<string, {
      employeeId: string
      employeeName: string
      employmentType: string
      needsReview: boolean
      totalMinutes: number
      username: string
      weeks: Array<{ summary: PayrollWeeklyEmployeeSummary; week: PayrollWorkbookWeek }>
    }>()
    for (const group of groups) {
      for (const summary of group.summaries.filter((candidate) => candidate.hasActivity)) {
        const record = records.get(summary.employeeId) ?? {
          employeeId: summary.employeeId,
          employeeName: summary.employeeName,
          employmentType: summary.employmentType,
          needsReview: false,
          totalMinutes: 0,
          username: summary.username,
          weeks: [],
        }
        record.weeks.push({ summary, week: group.week })
        record.needsReview ||= summary.needsReview
        record.totalMinutes += payrollWeeklyTotalPayableMinutes(summary)
        records.set(summary.employeeId, record)
      }
    }
    const normalizedSearch = search.trim().toLocaleLowerCase()
    return [...records.values()]
      .filter((record) => !normalizedSearch || `${record.employeeName} ${record.username} ${record.employmentType}`.toLocaleLowerCase().includes(normalizedSearch))
      .filter((record) => status === 'all' || (status === 'review' ? record.needsReview : !record.needsReview))
      .sort((left, right) => sortOrder === 'hours-desc'
        ? right.totalMinutes - left.totalMinutes || left.employeeName.localeCompare(right.employeeName)
        : left.employeeName.localeCompare(right.employeeName))
  }, [groups, search, sortOrder, status])
  const pageCount = Math.max(1, Math.ceil(employees.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visibleEmployees = employees.slice((safePage - 1) * pageSize, safePage * pageSize)

  useEffect(() => setPage(1), [pageSize, search, sortOrder, status])

  return (
    <section className="time-card payroll-employee-workspace" aria-labelledby="payroll-employee-workspace-title">
      <TimeSectionHeader
        eyebrow="Employee payroll"
        summary="Review one person at a time. Week 1 and Week 2 remain separate, with detailed punches available only when needed."
        title="Employee totals"
      />
      <div className="payroll-queue-controls payroll-employee-workspace__controls">
        <label className="payroll-queue-search">
          <span className="sr-only">Search employees</span>
          <Search aria-hidden="true" size={18} />
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Search employee or username" type="search" value={search} />
        </label>
        <label>
          <span>Status</span>
          <select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
            <option value="all">All statuses</option>
            <option value="ready">Ready</option>
            <option value="review">Needs review</option>
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select onChange={(event) => setSortOrder(event.target.value as typeof sortOrder)} value={sortOrder}>
            <option value="employee">Employee name</option>
            <option value="hours-desc">Highest payable hours</option>
          </select>
        </label>
        <label>
          <span>Rows</span>
          <select onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>
      {visibleEmployees.length === 0 ? (
        <DataStatePanel icon={Users} title="No employee payroll matches">
          <p>Change the search or status filter to view another employee.</p>
        </DataStatePanel>
      ) : (
        <div className="payroll-employee-list">
          {visibleEmployees.map((employee) => (
            <article className="payroll-employee-list__item" key={employee.employeeId}>
              <div className="payroll-employee-list__identity">
                <strong>{employee.employeeName}</strong>
                <span>@{employee.username} · {employee.employmentType}</span>
                <TimeStatusBadge tone={employee.needsReview ? 'warning' : 'good'}>{employee.needsReview ? 'Needs review' : 'Ready'}</TimeStatusBadge>
              </div>
              <div className="payroll-employee-list__weeks">
                {employee.weeks.map(({ summary, week }, index) => (
                  <div key={week.weekStartsOn}>
                    <span>{week.label || `Week ${index + 1}`}</span>
                    <strong>{payrollHours(payrollWeeklyTotalPayableMinutes(summary))} hr</strong>
                    <small>{payrollHours(summary.regularMinutes)} regular · {payrollHours(summary.overtimeMinutes)} OT · {payrollHours(summary.sickPayMinutes + summary.vacationPayMinutes)} sick/PTO</small>
                  </div>
                ))}
              </div>
              <div className="payroll-employee-list__total">
                <span>Pay-period total</span>
                <strong>{payrollHours(employee.totalMinutes)} hr</strong>
                <TimeButton onClick={() => onOpenEmployee(employee.employeeId)} variant="secondary">View details</TimeButton>
              </div>
            </article>
          ))}
        </div>
      )}
      {employees.length > pageSize ? (
        <div className="payroll-pagination" aria-label="Employee payroll pages">
          <span>{employees.length} employees · Page {safePage} of {pageCount}</span>
          <div>
            <TimeButton disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} variant="secondary">Previous</TimeButton>
            <TimeButton disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} variant="secondary">Next</TimeButton>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function PayrollRowsTable({
  rows,
  summary,
  week,
}: {
  rows: TimekeepingReviewRow[]
  summary: PayrollEmployeeSummary
  week: PayrollWorkbookWeek
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
        summary={`${formatUsDateKey(week.weekStartsOn)} - ${formatUsDateKey(week.weekEndsOn)} · ${summary.workedShiftCount} worked shift${summary.workedShiftCount === 1 ? '' : 's'} · ${payrollHours(summary.paidMinutes)} paid hours · ${summary.exceptionCount === 0 ? 'ready for payroll' : `${summary.exceptionCount} row${summary.exceptionCount === 1 ? '' : 's'} need review`}.`}
        title={`${summary.employeeName} — ${week.label} detail`}
      />
      <div className="time-review-table-wrap">
        <table className="time-review-table payroll-rows-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Date</th>
              <th>Location</th>
              <th>Time category</th>
              <th>Clock in</th>
              <th>Clock out</th>
              <th>Regular</th>
              <th>OT</th>
              <th>Paid</th>
              <th>Payroll batch</th>
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
                <td>
                  <strong>{row.mixedWorkTypes ? 'Needs classification review' : row.workType === 'training' ? 'Paid training' : 'Worked time'}</strong>
                  {row.workType === 'training' ? <span>Marked on the scheduled shift</span> : null}
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
                  <strong>{row.payrollBatchWeekStartsOn && row.payrollBatchWeekEndsOn
                    ? `${formatUsDateKey(row.payrollBatchWeekStartsOn)} - ${formatUsDateKey(row.payrollBatchWeekEndsOn)}`
                    : 'Needs assignment'}</strong>
                  <span>{assignmentSourceLabel(row.payrollAssignmentSource)}</span>
                  {row.crossesPayrollBoundary ? <TimeStatusBadge tone="warning">Crosses payroll boundary</TimeStatusBadge> : null}
                  {row.manualAdjustment ? <small>Manual adjustment recorded</small> : null}
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
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeSection = payrollWorkspaceSection(location.pathname)
  const defaultPeriod = currentPayrollPeriod()
  const requestedFromDate = searchParams.get('from')
  const requestedThroughDate = searchParams.get('through')
  const hasRequestedPeriod = validDateKey(requestedFromDate) && validDateKey(requestedThroughDate) && requestedFromDate <= requestedThroughDate
  const [fromDate, setFromDate] = useState(hasRequestedPeriod ? requestedFromDate : defaultPeriod.fromDate)
  const [throughDate, setThroughDate] = useState(hasRequestedPeriod ? requestedThroughDate : defaultPeriod.throughDate)
  const [rangeTouched, setRangeTouched] = useState(hasRequestedPeriod)
  const [exportNote, setExportNote] = useState('')
  const [focusRequest, setFocusRequest] = useState<TimeMaintenanceFocusRequest | null>(null)
  const [selectedBlockerRow, setSelectedBlockerRow] = useState<TimekeepingReviewRow | null>(null)
  const [selectedCorrection, setSelectedCorrection] = useState<PendingCorrection | null>(null)
  const [correctionNote, setCorrectionNote] = useState('')
  const [payrollAssignmentWeek, setPayrollAssignmentWeek] = useState('')
  const [payrollAssignmentReason, setPayrollAssignmentReason] = useState('')
  const [selectedPayrollEmployeeId, setSelectedPayrollEmployeeId] = useState<string | null>(null)

  const sessionQuery = useQuery({
    queryKey: ['session-context'],
    queryFn: getSessionContext,
    enabled: isSupabaseConfigured,
  })
  const reviewAllowed = canViewTeamTime(sessionQuery.data) || canExportPayroll(sessionQuery.data)
  const exportAllowed = canExportPayroll(sessionQuery.data)
  const manageAllowed = canManageTime(sessionQuery.data)
  const assignmentCorrectionAllowed = canOverridePayrollAssignment(sessionQuery.data)
  const rulesAllowed = sessionQuery.data?.role === 'admin'
  const reviewNeeded = activeSection !== 'rules'
  const rulesQuery = useQuery({
    enabled: isSupabaseConfigured
      && sessionQuery.isSuccess
      && (activeSection === 'rules' ? rulesAllowed : reviewAllowed),
    queryKey: ['time-payroll-rules'],
    queryFn: getPayrollRules,
  })
  useEffect(() => {
    if (rangeTouched || !rulesQuery.data) return
    const activePeriod = currentPayrollPeriod(undefined, rulesForPeriod(rulesQuery.data))
    setFromDate(activePeriod.fromDate)
    setThroughDate(activePeriod.throughDate)
    setRangeTouched(true)
    setSearchParams({ from: activePeriod.fromDate, through: activePeriod.throughDate }, { replace: true })
  }, [rangeTouched, rulesQuery.data, setSearchParams])

  const reviewQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && reviewAllowed && reviewNeeded,
    queryKey: ['time-payroll-review', fromDate, throughDate],
    queryFn: () => getTimekeepingReview({ fromDate, throughDate }),
  })
  const accountabilityQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && reviewAllowed && activeSection === 'export',
    queryKey: ['time-payroll-accountability', fromDate, throughDate],
    queryFn: () => getPayrollAccountabilityEvents({ fromDate, throughDate }),
  })
  const historyQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && exportAllowed && activeSection === 'export',
    queryKey: ['payroll-export-history'],
    queryFn: () => getPayrollExportHistory(20),
  })
  const correctionDecisionMutation = useMutation({
    mutationFn: (input: { approved: boolean; correctionId: string; note: string | null }) => reviewTimeEventCorrection(input),
    onSuccess: async () => {
      setSelectedCorrection(null)
      setCorrectionNote('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['time-payroll-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-exceptions-review'] }),
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
  const payrollAssignmentMutation = useMutation({
    mutationFn: () => {
      if (!selectedBlockerRow?.payrollOccurrenceFingerprint || !selectedBlockerRow.payrollOccurrenceKey) {
        throw new Error('This payroll occurrence does not have enough evidence for an audited correction.')
      }
      if (!isSundayDateKey(payrollAssignmentWeek)) {
        throw new Error('Choose the Sunday that begins the correct payroll week.')
      }
      return correctPayrollBatchAssignment({
        assignedWeekStartsOn: payrollAssignmentWeek,
        employeeId: selectedBlockerRow.employeeId,
        firstClockIn: selectedBlockerRow.firstClockIn,
        occurrenceFingerprint: selectedBlockerRow.payrollOccurrenceFingerprint,
        occurrenceKey: selectedBlockerRow.payrollOccurrenceKey,
        originalWeekStartsOn: selectedBlockerRow.payrollBatchWeekStartsOn ?? null,
        reason: payrollAssignmentReason,
        shiftId: selectedBlockerRow.shiftId,
      })
    },
    onSuccess: async () => {
      setPayrollAssignmentWeek('')
      setPayrollAssignmentReason('')
      closeRowBlocker()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['time-payroll-review'] }),
        queryClient.invalidateQueries({ queryKey: ['timekeeping-review'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
      ])
    },
  })
  const review = useMemo(() => workedTimePayrollReview(reviewQuery.data), [reviewQuery.data])
  const lockBlockedReason = payrollLockBlocker(review)
  const readinessPercent = payrollReadinessPercent(review)
  const employeeSummaries = useMemo(() => summarizePayrollRowsByEmployee(review?.rows ?? []), [review])
  const trainingMinutes = useMemo(
    () => employeeSummaries.reduce((total, summary) => total + summary.trainingMinutes, 0),
    [employeeSummaries],
  )
  const accountabilityEvents = useMemo(() => accountabilityQuery.data ?? [], [accountabilityQuery.data])
  const payrollWorkbookInput = useMemo(() => review ? ({
    accountabilityEvents,
    exportType: 'Preview' as const,
    review,
    rules: rulesQuery.data ?? review.payrollRules,
  }) : null, [accountabilityEvents, review, rulesQuery.data])
  const weeklySummaryGroups = useMemo(
    () => payrollWorkbookInput ? summarizePayrollWorkbookByWeek(payrollWorkbookInput) : [],
    [payrollWorkbookInput],
  )
  const selectedEmployeeWeeks = useMemo(() => selectedPayrollEmployeeId
    ? weeklySummaryGroups.flatMap((group) => group.summaries
      .filter((summary) => summary.employeeId === selectedPayrollEmployeeId && summary.hasActivity)
      .map((summary) => ({ summary, week: group.week })))
    : [], [selectedPayrollEmployeeId, weeklySummaryGroups])
  const selectedEmployeeRows = useMemo(() => review && selectedPayrollEmployeeId
    ? review.rows.filter((row) => row.employeeId === selectedPayrollEmployeeId)
    : [], [review, selectedPayrollEmployeeId])
  const selectedEmployeeName = selectedEmployeeWeeks[0]?.summary.employeeName ?? selectedEmployeeRows[0]?.employeeName ?? ''
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
          exceptionResolutionHistory: detail.exceptionResolutionHistory,
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
          exceptionResolutionHistory: detail.exceptionResolutionHistory,
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
  const previewDownloadMutation = useMutation({
    mutationFn: async (): Promise<PayrollWorkbookDownloadResult> => {
      if (!payrollWorkbookInput) throw new Error('The payroll preview is not ready yet. Please wait for the review to finish loading.')
      return downloadPayrollWorkbook(
        {
          ...payrollWorkbookInput,
          exportNote: 'Preview workbook. Official export requires locking the reviewed payroll batch.',
        },
        payrollExportFileName(payrollWorkbookInput.review.fromDate, payrollWorkbookInput.review.throughDate, 'preview'),
      )
    },
  })

  const totals = useMemo(() => review?.summary, [review])
  const canLock = Boolean(exportAllowed && review && lockBlockedReason === '' && exportNote.trim().length > 0 && !exportMutation.isPending)
  const workspaceSearch = `?from=${encodeURIComponent(fromDate)}&through=${encodeURIComponent(throughDate)}`
  const workspaceHeading: Record<PayrollWorkspaceSection, { eyebrow: string; summary: string; title: string }> = {
    employees: {
      eyebrow: 'Payroll workspace',
      summary: 'Review Week 1, Week 2, and pay-period totals by employee without crowding the screen with punch detail.',
      title: 'Employee Payroll',
    },
    export: {
      eyebrow: 'Payroll workspace',
      summary: 'Download a clean workbook preview, then lock the official payroll batch with a complete audit trail.',
      title: 'Payroll Export & History',
    },
    overview: {
      eyebrow: 'HR & Finance',
      summary: 'See payroll readiness, priority work, and the selected pay period before moving into detailed review.',
      title: 'Payroll',
    },
    review: {
      eyebrow: 'Payroll workspace',
      summary: 'Resolve genuine blockers and employee correction requests from one focused, auditable queue.',
      title: 'Payroll Review Queue',
    },
    rules: {
      eyebrow: 'Payroll administration',
      summary: 'Review the effective pay-cycle, overtime, break, and worked-time rules used by payroll.',
      title: 'Payroll Rules',
    },
  }

  function setPeriod(period: Pick<TimePeriod, 'fromDate' | 'throughDate'>, touched = true) {
    setFromDate(period.fromDate)
    setThroughDate(period.throughDate)
    setRangeTouched(touched)
    setSearchParams({ from: period.fromDate, through: period.throughDate }, { replace: true })
  }

  function openRowBlocker(row: TimekeepingReviewRow) {
    setSelectedBlockerRow(row)
    setPayrollAssignmentWeek(row.payrollBatchWeekStartsOn ?? '')
    setPayrollAssignmentReason('')
    setFocusRequest({
      employeeId: row.employeeId,
      fromDate: row.operationalDate,
      requestId: Date.now(),
      throughDate: row.operationalDate,
    })
  }

  function closeRowBlocker() {
    setSelectedBlockerRow(null)
    setFocusRequest(null)
    setPayrollAssignmentWeek('')
    setPayrollAssignmentReason('')
  }

  function openFirstBlocker() {
    if (!review) return
    const correction = review.pendingCorrections[0]
    if (correction) {
      setSelectedCorrection(correction)
      return
    }
    const row = review.rows.find((candidate) => !candidate.payrollReady || candidate.exceptionCodes.length > 0)
    if (row) openRowBlocker(row)
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
        actions={<Link className="time-button time-button--secondary" to="/time/tools"><Timer aria-hidden="true" size={18} /><span>Time Tools</span></Link>}
        eyebrow={workspaceHeading[activeSection].eyebrow}
        summary={workspaceHeading[activeSection].summary}
        title={workspaceHeading[activeSection].title}
      />
      <PayrollWorkspaceNavigation activeSection={activeSection} search={workspaceSearch} showRules={rulesAllowed} />

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

      <section className={activeSection === 'overview' ? 'payroll-command-grid' : 'payroll-command-grid payroll-command-grid--period-only'}>
        <PeriodControls
          fromDate={fromDate}
          onChange={setPeriod}
          rules={rulesQuery.data}
          throughDate={throughDate}
        />
        {activeSection === 'overview' ? <section className="time-card payroll-readiness-card">
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
              {lockBlockedReason && manageAllowed ? (
                <TimeButton icon={ArrowRight} onClick={openFirstBlocker} variant="primary">Open first blocker</TimeButton>
              ) : null}
            </div>
          ) : null}
        </section> : null}
      </section>

      {activeSection !== 'rules' && reviewQuery.isPending ? (
        <DataStatePanel icon={FileClock} title="Loading payroll workspace">
          <p>Calculating worked time, scheduled comparisons, exceptions, and weekly payroll totals.</p>
        </DataStatePanel>
      ) : null}
      {activeSection !== 'rules' && reviewQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Payroll workspace unavailable" tone="error">
          <p>{reviewQuery.error.message}</p>
        </DataStatePanel>
      ) : null}

      {review && activeSection === 'overview' ? (
        <>
          <section className="time-command-grid payroll-summary-grid" aria-label="Payroll export totals">
            <TimeMetricCard detail="Only SygShift timeclock rows in the selected range." icon={FileClock} label="Worked Rows" value={totals?.rowCount ?? 0} />
            <TimeMetricCard detail="Paid hours from completed clock-in/out records after unpaid breaks." icon={CheckCircle2} label="Paid Hours" tone="good" value={`${payrollHours(totals?.paidMinutes ?? 0)} hr`} />
            <TimeMetricCard detail="Daily/weekly overtime calculated by payroll rules." icon={AlertTriangle} label="Overtime" tone={(totals?.overtimeMinutes ?? 0) > 0 ? 'warning' : 'neutral'} value={`${payrollHours(totals?.overtimeMinutes ?? 0)} hr`} />
            <TimeMetricCard detail="Rows or corrections blocking official export." icon={ShieldAlert} label="Blockers" tone={(totals?.exceptionCount ?? 0) + (totals?.pendingCorrectionCount ?? 0) > 0 ? 'danger' : 'good'} value={(totals?.exceptionCount ?? 0) + (totals?.pendingCorrectionCount ?? 0)} />
            {trainingMinutes > 0 ? <TimeMetricCard detail="Paid training marked on scheduled shifts and included in worked hours." icon={History} label="Training Time" value={`${payrollHours(trainingMinutes)} hr`} /> : null}
          </section>
          <section className="time-card payroll-priority-panel" aria-labelledby="payroll-priority-title">
            <TimeSectionHeader eyebrow="Priority work" summary="Only the first five items needing attention are shown here. Use Review Queue for the complete list." title="What needs attention" />
            <div className="payroll-priority-list">
              {review.pendingCorrections.slice(0, 5).map((correction) => (
                <article key={correction.id}>
                  <div><strong>{correction.employeeName}</strong><span>Employee correction request · {formatUsDateKey(correction.recordedAt.slice(0, 10))}</span></div>
                  <TimeStatusBadge tone="warning">Review</TimeStatusBadge>
                </article>
              ))}
              {review.rows.filter((row) => !row.payrollReady || row.exceptionCodes.length > 0).slice(0, Math.max(0, 5 - review.pendingCorrections.length)).map((row) => (
                <article key={`${row.employeeId}-${row.operationalDate}-${row.shiftId ?? row.rowKind}`}>
                  <div><strong>{row.employeeName}</strong><span>{formatUsDateKey(row.operationalDate)} · {rowLocation(row)}</span></div>
                  <TimeStatusBadge tone="warning">{row.exceptionCodes.length ? row.exceptionCodes.map(exceptionLabel).join(', ') : 'Needs review'}</TimeStatusBadge>
                </article>
              ))}
              {review.pendingCorrections.length === 0 && !review.rows.some((row) => !row.payrollReady || row.exceptionCodes.length > 0) ? (
                <div className="payroll-priority-list__empty"><CheckCircle2 aria-hidden="true" size={22} /><span>No priority payroll work for this period.</span></div>
              ) : null}
            </div>
            <div className="payroll-priority-panel__actions">
              <Link className="time-button time-button--primary" to={`/payroll/review${workspaceSearch}`}>Open Review Queue</Link>
              <Link className="time-button time-button--secondary" to={`/payroll/employees${workspaceSearch}`}>Review employees</Link>
              {exportAllowed ? <Link className="time-button time-button--secondary" to={`/payroll/export${workspaceSearch}`}>Export payroll</Link> : null}
            </div>
          </section>
        </>
      ) : null}

      {review && activeSection === 'review' ? (
        <PayrollExceptions
          canWork={manageAllowed}
          onReviewCorrection={(correction) => {
            setSelectedCorrection(correction)
            setCorrectionNote('')
          }}
          onWorkRow={openRowBlocker}
          pendingCorrections={review.pendingCorrections}
          rows={review.rows}
        />
      ) : null}

      {review && activeSection === 'employees' ? (
        <PayrollEmployeeWorkspace groups={weeklySummaryGroups} onOpenEmployee={setSelectedPayrollEmployeeId} />
      ) : null}

      {review && activeSection === 'export' ? exportAllowed ? (
        <>
          <PayrollExportPanel
            accountabilityEvents={accountabilityEvents}
            canLock={canLock}
            exportMutation={exportMutation}
            lockBlockedReason={lockBlockedReason}
            note={exportNote}
            onNoteChange={setExportNote}
            previewMutation={previewDownloadMutation}
            review={review}
            rules={rulesQuery.data ?? review.payrollRules}
          />
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
        </>
      ) : (
        <TimeAlertCard icon={ShieldAlert} title="Payroll export access is required" tone="warning">
          <p>Your account can review payroll, but only authorized HR/Finance users can preview or lock official export workbooks.</p>
        </TimeAlertCard>
      ) : null}

      {activeSection === 'rules' ? rulesAllowed ? (
        <PayrollRulesSummary period={{ fromDate, throughDate }} rules={rulesQuery.data} />
      ) : (
        <DataStatePanel icon={ShieldAlert} title="Payroll rules are restricted" tone="error">
          <p>Only administrators can view company-wide payroll configuration.</p>
        </DataStatePanel>
      ) : null}

      {selectedPayrollEmployeeId ? (
        <ModalDialog
          className="modal-dialog--wide payroll-employee-detail-modal"
          description={`${formatUsDateKey(fromDate)} - ${formatUsDateKey(throughDate)} · Week 1 and Week 2 remain separated.`}
          onClose={() => setSelectedPayrollEmployeeId(null)}
          title={selectedEmployeeName || 'Employee payroll detail'}
        >
          <div className="payroll-employee-detail-modal__weeks">
            {selectedEmployeeWeeks.map(({ summary, week }) => (
              <article key={week.weekStartsOn}>
                <span>{week.label}</span>
                <strong>{formatUsDateKey(week.weekStartsOn)} - {formatUsDateKey(week.weekEndsOn)}</strong>
                <div><b>{payrollHours(summary.regularMinutes)} hr</b><small>Regular</small></div>
                <div><b>{payrollHours(summary.overtimeMinutes)} hr</b><small>Overtime</small></div>
                <div><b>{payrollHours(summary.sickPayMinutes + summary.vacationPayMinutes)} hr</b><small>Sick/PTO</small></div>
                <div><b>{payrollHours(payrollWeeklyTotalPayableMinutes(summary))} hr</b><small>Total payable</small></div>
              </article>
            ))}
          </div>
          <div className="payroll-employee-detail-list">
            {selectedEmployeeRows.map((row) => (
              <article key={`${row.operationalDate}-${row.shiftId ?? row.rowKind}-${row.firstClockIn ?? row.scheduledStartsAt ?? 'row'}`}>
                <div><strong>{formatUsDateKey(row.operationalDate)}</strong><span>{rowLocation(row)}</span></div>
                <div><span>{rowClock(row.firstClockIn, row)} - {rowClock(row.lastClockOut, row)}</span><small>{row.breakMinutes} unpaid break min</small></div>
                <div><strong>{payrollHours(row.paidMinutes)} paid hr</strong><TimeStatusBadge tone={row.payrollReady ? 'good' : 'warning'}>{row.payrollReady ? 'Ready' : 'Needs review'}</TimeStatusBadge></div>
              </article>
            ))}
          </div>
        </ModalDialog>
      ) : null}

      {manageAllowed && selectedBlockerRow ? (
        <ModalDialog
          className="modal-dialog--wide modal-dialog--time-maintenance"
          description={`${selectedBlockerRow.employeeName} | ${formatUsDateKey(selectedBlockerRow.operationalDate)} | ${rowLocation(selectedBlockerRow)}`}
          onClose={closeRowBlocker}
          title="Fix payroll blocker"
        >
          <div className="payroll-blocker-modal__summary">
            <div><span>Employee</span><strong>{selectedBlockerRow.employeeName}</strong></div>
            <div><span>Work date</span><strong>{formatUsDateKey(selectedBlockerRow.operationalDate)}</strong></div>
            <div><span>Blocker</span><strong>{selectedBlockerRow.exceptionCodes.length ? selectedBlockerRow.exceptionCodes.map(exceptionLabel).join(', ') : 'Needs review'}</strong></div>
          </div>
          <section className="payroll-assignment-review" aria-labelledby="payroll-assignment-review-title">
            <div>
              <span>Payroll batch assignment</span>
              <h3 id="payroll-assignment-review-title">
                {selectedBlockerRow.payrollBatchWeekStartsOn && selectedBlockerRow.payrollBatchWeekEndsOn
                  ? `${formatUsDateKey(selectedBlockerRow.payrollBatchWeekStartsOn)} - ${formatUsDateKey(selectedBlockerRow.payrollBatchWeekEndsOn)}`
                  : 'Not reliably determined'}
              </h3>
              <p>{selectedBlockerRow.payrollAssignmentExplanation}</p>
              <small>Source: {assignmentSourceLabel(selectedBlockerRow.payrollAssignmentSource)} · Policy {selectedBlockerRow.payrollPolicyVersion}</small>
            </div>
            {selectedBlockerRow.crossesPayrollBoundary ? (
              <TimeAlertCard icon={History} title="Crosses Payroll Boundary" tone="warning">
                <p>This occurrence begins in one payroll week and ends in the next. The entire occurrence stays with the payroll batch selected from its scheduled start.</p>
              </TimeAlertCard>
            ) : null}
            {selectedBlockerRow.payrollAssignmentStatus === 'unresolved' && selectedBlockerRow.payrollAssignmentCandidates.length > 0 ? (
              <div className="payroll-assignment-review__candidates">
                <strong>Nearby schedule evidence</strong>
                <p>These shifts are shown for review only. Choosing a payroll week does not link or alter a shift.</p>
                <ul>
                  {selectedBlockerRow.payrollAssignmentCandidates.slice(0, 6).map((candidate) => (
                    <li key={candidate.shiftId}>
                      <span>{candidate.locationName}</span>
                      <small>{formatOperationalDateTime(candidate.startsAt, { includeTimeZoneName: true, timeZone: candidate.timeZone })} - {formatOperationalDateTime(candidate.endsAt, { includeTimeZoneName: true, timeZone: candidate.timeZone })}</small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {assignmentCorrectionAllowed && selectedBlockerRow.payrollOccurrenceFingerprint && selectedBlockerRow.payrollOccurrenceKey ? (
              <div className="payroll-assignment-review__correction">
                <label>
                  <span>Corrected week start <small>Sunday only</small></span>
                  <input onChange={(event) => setPayrollAssignmentWeek(event.target.value)} type="date" value={payrollAssignmentWeek} />
                </label>
                <label>
                  <span>Reason <small>Required</small></span>
                  <textarea
                    maxLength={500}
                    onChange={(event) => setPayrollAssignmentReason(event.target.value)}
                    placeholder="Explain why this exact unlocked occurrence belongs to another payroll batch."
                    rows={3}
                    value={payrollAssignmentReason}
                  />
                </label>
                {payrollAssignmentMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{payrollAssignmentMutation.error.message}</p> : null}
                <TimeButton
                  disabled={payrollAssignmentMutation.isPending || payrollAssignmentReason.trim().length < 12 || !isSundayDateKey(payrollAssignmentWeek)}
                  loading={payrollAssignmentMutation.isPending}
                  onClick={() => payrollAssignmentMutation.mutate()}
                  variant="secondary"
                >
                  Save audited batch correction
                </TimeButton>
              </div>
            ) : null}
          </section>
          <div className="time-maintenance-modal-body">
            <TimeMaintenanceWorkbench
              defaultDate={selectedBlockerRow.operationalDate}
              defaultPeriod={{ fromDate: selectedBlockerRow.operationalDate, throughDate: selectedBlockerRow.operationalDate }}
              focusRequest={focusRequest}
              initialEmployeeId={selectedBlockerRow.employeeId}
              lockEmployeeFilter
              onClose={closeRowBlocker}
              headingEyebrow="Payroll blocker"
              headingSummary="Add a missing punch, correct the time, void a mistake, or update the Site/Post without leaving payroll review."
              headingTitle="Correct this time record"
            />
          </div>
        </ModalDialog>
      ) : null}

      {manageAllowed && selectedCorrection ? (
        <ModalDialog
          busy={correctionDecisionMutation.isPending}
          busyLabel="Saving payroll decision..."
          className="modal-dialog--wide payroll-correction-modal"
          description={`${selectedCorrection.employeeName} | ${selectedCorrection.kind.replaceAll('_', ' ')}`}
          onClose={() => {
            setSelectedCorrection(null)
            setCorrectionNote('')
          }}
          title="Review payroll correction"
        >
          <div className="payroll-correction-modal__body">
            <div className="payroll-correction-modal__request">
              <TimeStatusBadge tone="warning">{selectedCorrection.voided ? 'Void requested' : 'Time change requested'}</TimeStatusBadge>
              <strong>{selectedCorrection.employeeName}</strong>
              <span>Original: {formatOperationalDateTime(selectedCorrection.recordedAt, { includeTimeZoneName: true })}</span>
              {selectedCorrection.replacementTime ? <span>Requested: {formatOperationalDateTime(selectedCorrection.replacementTime, { includeTimeZoneName: true })}</span> : null}
              <p>{selectedCorrection.reason}</p>
            </div>
            <label>
              <span>Decision note <small>Optional</small></span>
              <textarea
                maxLength={240}
                onChange={(event) => setCorrectionNote(event.target.value)}
                placeholder="Add context for the payroll audit trail."
                rows={3}
                value={correctionNote}
              />
            </label>
            {correctionDecisionMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{correctionDecisionMutation.error.message}</p> : null}
            <div className="payroll-correction-modal__actions">
              <TimeButton disabled={correctionDecisionMutation.isPending} onClick={() => correctionDecisionMutation.mutate({ approved: false, correctionId: selectedCorrection.id, note: correctionNote.trim() || null })} variant="danger">Decline</TimeButton>
              <TimeButton disabled={correctionDecisionMutation.isPending} onClick={() => correctionDecisionMutation.mutate({ approved: true, correctionId: selectedCorrection.id, note: correctionNote.trim() || null })} variant="primary">Approve correction</TimeButton>
            </div>
          </div>
        </ModalDialog>
      ) : null}
    </main>
  )
}

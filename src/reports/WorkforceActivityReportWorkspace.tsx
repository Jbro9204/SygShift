import { useDeferredValue, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  MapPin,
  RefreshCw,
  Search,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  exportWorkforceActivityReport,
  getWorkforceActivityReportPage,
  type WorkforceActivityGroup,
  type WorkforceActivityOutcome,
  type WorkforceActivityRow,
  type WorkforceActivityView,
} from '../data/workforceActivity'
import { dateKeyInTimeZone, formatDualTimeRange, formatOperationalDateTime, OPERATIONAL_TIME_ZONE } from '../lib/time'
import { personalDisplayTimeZone } from '../lib/usTimeZones'
import { formatUsDateKey } from '../time/timeRules'
import { downloadWorkforceActivityPdf, downloadWorkforceActivityXlsx } from './workforceActivityExport'
import { workforceActivityOutcomeValues } from './workforceActivityTypes'

const pageSizes = [10, 25, 50] as const
type DateScope = 'day' | 'range'

const workforceActivityOutcomeLabels: Record<WorkforceActivityOutcome, string> = {
  worked_as_scheduled: 'Worked as scheduled',
  replacement_worked: 'Replacement worked',
  worked_not_scheduled: 'Worked, not scheduled',
  salary_worked_confirmed: 'Salary work confirmed',
  scheduled_no_work_record: 'Scheduled, no work record',
  called_off: 'Called off',
  open_unassigned: 'Open / unassigned',
  needs_time_correction: 'Needs time correction',
}

const viewTabs: Array<{ label: string; value: WorkforceActivityView; description: string }> = [
  { label: 'Who Worked', value: 'worked', description: 'People with a recorded or confirmed work occurrence.' },
  { label: 'Schedule Comparison', value: 'all', description: 'Scheduled coverage beside recorded work, call-offs, replacements, and openings.' },
]

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`)
  if (Number.isNaN(date.valueOf())) return dateKeyInTimeZone(new Date(), OPERATIONAL_TIME_ZONE)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function validDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
}

function duration(minutes: number | null): string {
  if (minutes == null) return 'Not recorded'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (!hours) return `${remainder} min`
  if (!remainder) return `${hours} hr`
  return `${hours} hr ${remainder} min`
}

function isSalaryRow(row: WorkforceActivityRow): boolean {
  return row.employmentType?.trim().toLocaleLowerCase() === 'salary' || row.outcome === 'salary_worked_confirmed'
}

function workedDuration(row: WorkforceActivityRow): string {
  if (isSalaryRow(row)) return row.outcome === 'salary_worked_confirmed' ? 'Confirmed — hours not calculated' : 'Salary hours not calculated'
  return duration(row.workedMinutes)
}

function shiftWindow(row: WorkforceActivityRow): string {
  if (!row.scheduledStartAt && !row.scheduledEndAt) return 'Not scheduled'
  if (row.scheduledStartAt && row.scheduledEndAt) return formatDualTimeRange(row.scheduledStartAt, row.scheduledEndAt, row.timeZone)
  return formatOperationalDateTime(row.scheduledStartAt ?? row.scheduledEndAt!, { timeZone: row.timeZone })
}

function actualWindow(row: WorkforceActivityRow): string {
  if (isSalaryRow(row)) return row.outcome === 'salary_worked_confirmed' ? 'Work confirmed' : 'Salary time not displayed'
  if (!row.actualStartAt && !row.actualEndAt) return 'No work record'
  if (row.actualStartAt && row.actualEndAt) return formatDualTimeRange(row.actualStartAt, row.actualEndAt, row.timeZone)
  return `${formatOperationalDateTime(row.actualStartAt ?? row.actualEndAt!, { timeZone: row.timeZone })} · incomplete`
}

function employeeLabel(row: WorkforceActivityRow): string {
  return row.employeeName ?? (row.outcome === 'open_unassigned' ? 'Open position' : 'No employee recorded')
}

function locationSecondary(row: WorkforceActivityRow): string {
  return [row.clientName, row.siteCode, row.siteName, row.postName, row.eventName]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join(' · ')
}

function locationRequest(location: string): { clientId?: string; eventId?: string; siteId?: string } {
  const [kind, id] = location.split(':', 2)
  if (!id) return {}
  if (kind === 'client') return { clientId: id }
  if (kind === 'event') return { eventId: id }
  if (kind === 'site') return { siteId: id }
  return {}
}

function groupLabel(groupBy: WorkforceActivityGroup, row: WorkforceActivityRow): string {
  if (groupBy === 'employee') return employeeLabel(row)
  if (groupBy === 'day') return formatUsDateKey(row.operationalDate)
  return row.locationLabel
}

function WorkforceActivityDetail({ onClose, row }: { onClose: () => void; row: WorkforceActivityRow }) {
  const secondary = locationSecondary(row)
  return <ModalDialog
    className="reports-detail-modal workforce-activity-detail-modal"
    description="Read-only schedule and recorded-work detail. Time corrections remain in Time & Attendance."
    onClose={onClose}
    title={employeeLabel(row)}
  >
    <div className="reports-detail-grid workforce-activity-detail-grid">
      <div><span>Outcome</span><strong><span className={`workforce-outcome workforce-outcome--${row.outcome}`}>{workforceActivityOutcomeLabels[row.outcome]}</span></strong></div>
      <div><span>Work date</span><strong>{formatUsDateKey(row.operationalDate)}</strong></div>
      <div><span>Employee number</span><strong>{row.employeeNumber ?? 'Not assigned'}</strong></div>
      <div><span>Employment type</span><strong>{row.employmentType?.replaceAll('_', ' ') ?? 'Not recorded'}</strong></div>
      <div><span>Location</span><strong>{row.locationLabel}</strong></div>
      <div><span>Location detail</span><strong>{row.locationDetail ?? (secondary || 'Not recorded')}</strong></div>
      <div><span>Scheduled start</span><strong>{row.scheduledStartAt ? formatOperationalDateTime(row.scheduledStartAt, { includeTimeZoneName: true, timeZone: row.timeZone }) : 'Not scheduled'}</strong></div>
      <div><span>Scheduled end</span><strong>{row.scheduledEndAt ? formatOperationalDateTime(row.scheduledEndAt, { includeTimeZoneName: true, timeZone: row.timeZone }) : 'Not scheduled'}</strong></div>
      <div><span>Scheduled duration</span><strong>{duration(row.scheduledMinutes)}</strong></div>
      <div><span>Actual start</span><strong>{isSalaryRow(row) ? row.outcome === 'salary_worked_confirmed' ? 'Confirmed without a punch time' : 'Not displayed for salary work' : row.actualStartAt ? formatOperationalDateTime(row.actualStartAt, { includeTimeZoneName: true, timeZone: row.timeZone }) : 'Not recorded'}</strong></div>
      <div><span>Actual end</span><strong>{isSalaryRow(row) ? row.outcome === 'salary_worked_confirmed' ? 'Confirmed without a punch time' : 'Not displayed for salary work' : row.actualEndAt ? formatOperationalDateTime(row.actualEndAt, { includeTimeZoneName: true, timeZone: row.timeZone }) : 'Not recorded'}</strong></div>
      <div><span>Worked duration</span><strong>{workedDuration(row)}</strong></div>
      <div><span>Unpaid breaks</span><strong>{isSalaryRow(row) ? 'Not calculated for salary work' : duration(row.unpaidBreakMinutes)}</strong></div>
      <div><span>Payroll readiness</span><strong>{isSalaryRow(row) ? 'Not applicable for salary work' : row.payrollReady ? 'Ready' : 'Needs review'}</strong></div>
      <div><span>Time basis</span><strong>{row.timeZone}</strong></div>
      {row.notes.length ? <div className="workforce-activity-detail-grid__wide"><span>Notes</span><strong>{row.notes.join('\n')}</strong></div> : null}
    </div>
    <div className="modal-actions">
      <Link className="primary-action" to="/time/team">Open employee time</Link>
      <button className="secondary-button" onClick={onClose} type="button">Close</button>
    </div>
  </ModalDialog>
}

export function WorkforceActivityReportWorkspace({
  canExport,
  from,
  onRangeChange,
  through,
  viewerTimeZone,
}: {
  canExport: boolean
  from: string
  onRangeChange: (from: string, through: string) => void
  through: string
  viewerTimeZone?: string
}) {
  const resolvedViewerTimeZone = personalDisplayTimeZone(viewerTimeZone)
  const viewerToday = dateKeyInTimeZone(new Date(), resolvedViewerTimeZone)
  const initialDay = validDateKey(through) ? through : validDateKey(from) ? from : viewerToday
  const [dateScope, setDateScope] = useState<DateScope>('day')
  const [view, setView] = useState<WorkforceActivityView>('worked')
  const [groupBy, setGroupBy] = useState<WorkforceActivityGroup>('location')
  const [employeeId, setEmployeeId] = useState('')
  const [location, setLocation] = useState('')
  const [outcome, setOutcome] = useState<WorkforceActivityOutcome | ''>('')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(25)
  const [selected, setSelected] = useState<WorkforceActivityRow | null>(null)
  const [exportNotice, setExportNotice] = useState('')
  const day = initialDay
  const rangeFrom = validDateKey(from) ? from : day
  const rangeThrough = validDateKey(through) && through >= rangeFrom ? through : rangeFrom
  const reportFrom = dateScope === 'day' ? day : rangeFrom
  const reportThrough = dateScope === 'day' ? day : rangeThrough
  const locationFilter = locationRequest(location)

  const query = useQuery({
    queryKey: ['workforce-activity-report', reportFrom, reportThrough, view, groupBy, employeeId, location, outcome, deferredSearch, page, pageSize],
    queryFn: () => getWorkforceActivityReportPage({
      fromDate: reportFrom,
      throughDate: reportThrough,
      view,
      groupBy,
      employeeId: employeeId || undefined,
      ...locationFilter,
      outcome: outcome || undefined,
      search: deferredSearch || undefined,
      page,
      pageSize,
    }),
    placeholderData: (previous) => previous,
  })

  const groupedRows = useMemo(() => {
    const groups = new Map<string, WorkforceActivityRow[]>()
    for (const row of query.data?.rows ?? []) {
      const label = groupLabel(groupBy, row)
      groups.set(label, [...(groups.get(label) ?? []), row])
    }
    return [...groups.entries()]
  }, [groupBy, query.data?.rows])

  const selectedLocationLabel = useMemo(() => {
    if (!location || !query.data) return ''
    const [kind, id] = location.split(':', 2)
    const options = kind === 'client'
      ? query.data.filterOptions.clients
      : kind === 'site'
        ? query.data.filterOptions.sites
        : query.data.filterOptions.events
    return options.find((option) => option.id === id)?.label ?? ''
  }, [location, query.data])

  function resetPage() {
    setPage(1)
  }

  function selectDay(nextDay: string) {
    if (!validDateKey(nextDay)) return
    resetPage()
    setSelected(null)
    onRangeChange(nextDay, nextDay)
  }

  function selectRange(nextFrom: string, nextThrough: string) {
    if (!validDateKey(nextFrom) || !validDateKey(nextThrough) || nextFrom > nextThrough) return
    resetPage()
    setSelected(null)
    onRangeChange(nextFrom, nextThrough)
  }

  function selectView(nextView: WorkforceActivityView) {
    setView(nextView)
    setOutcome('')
    resetPage()
  }

  function clearFilters() {
    setEmployeeId('')
    setLocation('')
    setOutcome('')
    setSearch('')
    resetPage()
  }

  const summary = query.data?.summary
  const hasFilters = Boolean(employeeId || location || outcome || search)
  const totalPages = query.data?.totalPages ?? 0
  const activeTab = viewTabs.find((tab) => tab.value === view) ?? viewTabs[0]
  const exportMutation = useMutation({
    mutationFn: async (format: 'xlsx' | 'pdf') => {
      const report = await exportWorkforceActivityReport({
        fromDate: reportFrom,
        throughDate: reportThrough,
        view,
        groupBy,
        employeeId: employeeId || undefined,
        ...locationFilter,
        outcome: outcome || undefined,
        search: deferredSearch || undefined,
      })
      const employee = report.filterOptions.employees.find((option) => option.id === employeeId)
      const description = [
        activeTab.label,
        employee ? `Employee: ${employee.label}` : '',
        selectedLocationLabel ? `Location: ${selectedLocationLabel}` : '',
        outcome ? `Outcome: ${workforceActivityOutcomeLabels[outcome]}` : '',
        deferredSearch ? `Search: ${deferredSearch}` : '',
      ].filter(Boolean).join(' · ')
      const metadata = {
        filterDescription: description,
        fromDate: report.fromDate,
        generatedAt: report.generatedAt,
        throughDate: report.throughDate,
      }
      const fileName = format === 'xlsx'
        ? downloadWorkforceActivityXlsx(report.rows, metadata)
        : await downloadWorkforceActivityPdf(report.rows, metadata)
      return fileName
    },
    onMutate: () => setExportNotice(''),
    onSuccess: (fileName) => setExportNotice(`${fileName} downloaded.`),
  })

  return <div className="workforce-activity-workspace">
    <section className="operations-panel reports-workspace-heading workforce-activity-heading">
      <Link className="secondary-button reports-back" to={`/reports?from=${reportFrom}&through=${reportThrough}`}>Back to report library</Link>
      <div>
        <p className="eyebrow">Daily workforce reporting</p>
        <h1>Workforce Activity</h1>
        <p>Start with one operational day to see who worked and where, or expand to a date range for a broader schedule comparison.</p>
      </div>
    </section>

    <section className="operations-panel workforce-activity-day-panel" aria-label="Workforce activity day">
      <div className="workforce-activity-scope" aria-label="Date scope">
        <button aria-pressed={dateScope === 'day'} className={dateScope === 'day' ? 'workforce-activity-scope__button workforce-activity-scope__button--active' : 'workforce-activity-scope__button'} onClick={() => { setDateScope('day'); resetPage() }} type="button">One day</button>
        <button aria-pressed={dateScope === 'range'} className={dateScope === 'range' ? 'workforce-activity-scope__button workforce-activity-scope__button--active' : 'workforce-activity-scope__button'} onClick={() => { setDateScope('range'); resetPage() }} type="button">Date range</button>
      </div>
      <div className="workforce-activity-date-controls">
        {dateScope === 'day' ? <>
          <div className="workforce-activity-day-picker">
            <button aria-label="Previous day" className="secondary-button" onClick={() => selectDay(addDays(day, -1))} type="button"><ChevronLeft aria-hidden="true" size={18} /></button>
            <label><span>Operational day</span><input onChange={(event) => selectDay(event.target.value)} type="date" value={day} /></label>
            <button aria-label="Next day" className="secondary-button" onClick={() => selectDay(addDays(day, 1))} type="button"><ChevronRight aria-hidden="true" size={18} /></button>
          </div>
          <div className="workforce-activity-day-presets">
            <button className="secondary-button" onClick={() => selectDay(addDays(viewerToday, -1))} type="button">Yesterday</button>
            <button className="secondary-button" onClick={() => selectDay(viewerToday)} type="button">Today</button>
          </div>
        </> : <div className="workforce-activity-range-picker" aria-label="Workforce activity date range">
          <label><span>From</span><input max={rangeThrough} onChange={(event) => selectRange(event.target.value, rangeThrough)} type="date" value={rangeFrom} /></label>
          <label><span>Through</span><input min={rangeFrom} onChange={(event) => selectRange(rangeFrom, event.target.value)} type="date" value={rangeThrough} /></label>
        </div>}
        <span className="workforce-activity-time-zone-note"><CalendarDays aria-hidden="true" size={17} />Each record uses its assigned time zone</span>
      </div>
    </section>

    <section className="operations-panel workforce-activity-view-panel">
      <div className="workforce-activity-tabs" role="tablist" aria-label="Workforce activity view">
        {viewTabs.map((tab) => <button
          aria-selected={view === tab.value}
          className={view === tab.value ? 'workforce-activity-tab workforce-activity-tab--active' : 'workforce-activity-tab'}
          key={tab.value}
          onClick={() => selectView(tab.value)}
          role="tab"
          type="button"
        >{tab.label}</button>)}
      </div>
      <p>{activeTab.description}</p>
    </section>

    <section className="operations-panel reports-workspace-controls workforce-activity-controls" aria-label="Workforce activity filters">
      <label className="reports-search workforce-activity-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => { setSearch(event.target.value); resetPage() }} placeholder="Employee, event, client, site, or post" type="search" value={search} /></span></label>
      <div className="workforce-activity-filter-grid">
        <label><span>Employee</span><select onChange={(event) => { setEmployeeId(event.target.value); resetPage() }} value={employeeId}><option value="">All employees</option>{query.data?.filterOptions.employees.map((option) => <option key={option.id} value={option.id}>{option.label}{option.employeeNumber ? ` · ${option.employeeNumber}` : ''}</option>)}</select></label>
        <label><span>Location or event</span><select onChange={(event) => { setLocation(event.target.value); resetPage() }} value={location}><option value="">All locations and events</option>{query.data?.filterOptions.clients.length ? <optgroup label="Clients">{query.data.filterOptions.clients.map((option) => <option key={option.id} value={`client:${option.id}`}>{option.label}</option>)}</optgroup> : null}{query.data?.filterOptions.sites.length ? <optgroup label="Sites">{query.data.filterOptions.sites.map((option) => <option key={option.id} value={`site:${option.id}`}>{option.label}</option>)}</optgroup> : null}{query.data?.filterOptions.events.length ? <optgroup label="Events">{query.data.filterOptions.events.map((option) => <option key={option.id} value={`event:${option.id}`}>{option.label}</option>)}</optgroup> : null}</select></label>
        <label><span>Outcome</span><select onChange={(event) => { setOutcome(event.target.value as WorkforceActivityOutcome | ''); resetPage() }} value={outcome}><option value="">All outcomes</option>{workforceActivityOutcomeValues.map((value) => { const option = query.data?.filterOptions.outcomes.find((candidate) => candidate.value === value); return <option key={value} value={value}>{workforceActivityOutcomeLabels[value]}{option ? ` (${option.count})` : ''}</option> })}</select></label>
        <label><span>Organize by</span><select onChange={(event) => { setGroupBy(event.target.value as WorkforceActivityGroup); resetPage() }} value={groupBy}>{query.data?.filterOptions.groupings.map((option) => <option key={option.value} value={option.value}>{option.label}</option>) ?? <><option value="location">Location</option><option value="employee">Employee</option><option value="day">Day</option></>}</select></label>
      </div>
      <div className="workforce-activity-filter-actions"><button className="secondary-button" disabled={!hasFilters} onClick={clearFilters} type="button">Clear filters</button>{query.isFetching && !query.isPending ? <span role="status">Refreshing results…</span> : null}</div>
    </section>

    {summary ? <section className="operations-metrics workforce-activity-metrics" aria-label="Workforce activity summary">
      <article><span>Actual workers</span><strong>{summary.actualWorkers}</strong><small>Recorded or confirmed</small></article>
      <article><span>Scheduled assignments</span><strong>{summary.scheduledAssignments}</strong><small>{duration(summary.scheduledMinutes)} planned</small></article>
      <article><span>Worked time</span><strong>{duration(summary.workedMinutes)}</strong><small>Hourly recorded time only</small></article>
      <article><span>Salary confirmations</span><strong>{summary.salaryConfirmed}</strong><small>No hours inferred</small></article>
      <article className={summary.replacements || summary.callOffs || summary.openPositions ? 'import-metric--attention' : ''}><span>Coverage changes</span><strong>{summary.replacements + summary.callOffs + summary.openPositions}</strong><small>{summary.replacements} replacement · {summary.callOffs} call-off · {summary.openPositions} open</small></article>
      <article className={summary.needsReview ? 'import-metric--attention' : ''}><span>Needs review</span><strong>{summary.needsReview}</strong><small>Time or coverage follow-up</small></article>
    </section> : null}

    <section className="operations-panel reports-results workforce-activity-results" aria-busy={query.isFetching}>
      <div className="reports-section-heading workforce-activity-results-heading">
        <div><p className="eyebrow">{dateScope === 'day' ? formatUsDateKey(day) : `${formatUsDateKey(reportFrom)} – ${formatUsDateKey(reportThrough)}`}</p><h2>{query.data ? `${query.data.totalCount} ${query.data.totalCount === 1 ? 'record' : 'records'}` : 'Workforce activity'}</h2><p>Times use each row’s recorded time zone. Salary confirmations never create worked hours.</p></div>
        <div className="workforce-activity-export-actions" aria-label="Workforce activity exports"><button className="primary-action" disabled={!canExport || exportMutation.isPending || !query.data?.totalCount} onClick={() => exportMutation.mutate('xlsx')} type="button"><Download aria-hidden="true" size={17} />{exportMutation.isPending && exportMutation.variables === 'xlsx' ? 'Preparing Excel…' : 'Export Excel'}</button><button className="secondary-button" disabled={!canExport || exportMutation.isPending || !query.data?.totalCount} onClick={() => exportMutation.mutate('pdf')} type="button"><Download aria-hidden="true" size={17} />{exportMutation.isPending && exportMutation.variables === 'pdf' ? 'Preparing PDF…' : 'Export PDF'}</button></div>
      </div>
      {!canExport ? <p className="reports-export-note">Report export permission is required to download protected workforce records.</p> : null}
      {exportMutation.isError ? <p className="reports-export-note reports-export-note--error" role="alert">{exportMutation.error.message}</p> : null}
      {exportNotice ? <p className="reports-export-note" role="status">{exportNotice}</p> : null}
      {query.isPending ? <div className="report-empty" role="status">Loading workforce activity…</div> : null}
      {query.isError ? <DataStatePanel icon={AlertTriangle} title="Workforce activity is unavailable" tone="error"><p>{query.error.message}</p><button className="secondary-button" onClick={() => void query.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Retry</button></DataStatePanel> : null}
      {query.isSuccess && query.data.rows.length === 0 ? <div className="report-empty"><strong>No workforce activity matches this view.</strong><span>{hasFilters ? `Clear a filter or choose another ${dateScope === 'day' ? 'operational day' : 'date range'}.` : view === 'worked' ? `No recorded or confirmed work was found for this ${dateScope === 'day' ? 'day' : 'range'}. Open Schedule Comparison to review planned coverage.` : `No scheduled or worked records were found for this ${dateScope === 'day' ? 'day' : 'range'}.`}</span></div> : null}
      {groupedRows.length ? <div className="workforce-activity-groups">{groupedRows.map(([label, rows]) => <section className="workforce-activity-group" key={label} aria-label={label}>
        <div className="workforce-activity-group__heading"><div><MapPin aria-hidden="true" size={18} /><h3>{label}</h3></div><span>{rows.length} {rows.length === 1 ? 'record' : 'records'} on this page</span></div>
        <div className="workforce-activity-list">{rows.map((row) => <article className={`workforce-activity-row workforce-activity-row--${row.outcome}`} key={row.id}>
          <div className="workforce-activity-row__identity"><span className={`workforce-outcome workforce-outcome--${row.outcome}`}>{workforceActivityOutcomeLabels[row.outcome]}</span><strong>{employeeLabel(row)}</strong><small>{row.employeeNumber ?? row.employmentType?.replaceAll('_', ' ') ?? 'No employee assigned'}</small></div>
          <div className="workforce-activity-row__location"><span>Location</span><strong>{row.locationLabel}</strong><small>{row.locationDetail ?? (locationSecondary(row) || 'No additional location detail')}</small></div>
          <div className="workforce-activity-row__time"><span><CalendarDays aria-hidden="true" size={15} />Scheduled</span><strong>{shiftWindow(row)}</strong><small>{duration(row.scheduledMinutes)}</small></div>
          <div className="workforce-activity-row__time"><span><Clock3 aria-hidden="true" size={15} />Actual</span><strong>{actualWindow(row)}</strong><small>{workedDuration(row)}</small></div>
          <div className="workforce-activity-row__action"><small>{row.timeZone}</small><button className="secondary-button" onClick={() => setSelected(row)} type="button">View details</button></div>
        </article>)}</div>
      </section>)}</div> : null}
      {query.data && query.data.totalCount > 0 ? <nav className="reports-pagination workforce-activity-pagination" aria-label="Workforce activity pages">
        <label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as (typeof pageSizes)[number]); resetPage() }} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <span>Page {query.data.page} of {Math.max(1, totalPages)}</span>
        <button className="secondary-button" disabled={page <= 1 || query.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button>
        <button className="secondary-button" disabled={page >= totalPages || query.isFetching} onClick={() => setPage((current) => current + 1)} type="button">Next</button>
      </nav> : null}
    </section>
    {selected ? <WorkforceActivityDetail onClose={() => setSelected(null)} row={selected} /> : null}
  </div>
}

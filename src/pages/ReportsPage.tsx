import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronLeft, ChevronRight, DatabaseZap, FileBarChart, Search, ShieldAlert } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import { getOperationsReport } from '../data/operations'
import { getTimekeepingOperationsReportPage } from '../data/timeOperations'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  getOperationalReportDefinition,
  operationalReportDefinitions,
  type OperationalReportDefinition,
} from '../reports/reportDefinitions'
import { LicensingStatusReportWorkspace } from '../reports/LicensingStatusReportWorkspace'
import { PatrolActivityReportWorkspace } from '../reports/PatrolActivityReportWorkspace'

const pageSizes = [10, 25, 50] as const
const rangeStorageKey = 'sygshift-reports-range'

const fieldLabels: Record<string, string> = {
  action: 'Action', actor: 'Changed by', adjustmentStatus: 'Correction status', afterValues: 'Updated values',
  approvalStatus: 'Approval', assignedCount: 'Assigned', automaticClockOutAt: 'Automatic clock-out',
  beforeValues: 'Previous values', callOffCount: 'Call-offs', callOffType: 'Call-off type', canceledAt: 'Canceled',
  clockInAt: 'Clock in', clockOutAt: 'Clock out', createdAt: 'Created', decisionNote: 'Decision note',
  detectedAt: 'Detected', employeeName: 'Employee', endsAt: 'Ends', exceptionCode: 'Exception',
  exceptionCodes: 'Exceptions', headcountRequired: 'Needed', issueType: 'Request type', openCount: 'Open',
  operationalDate: 'Work date', overtimeMinutes: 'Overtime', payrollReady: 'Payroll ready',
  processingMinutes: 'Processing time', reason: 'Reason', replacementNeeded: 'Replacement needed',
  reportedAt: 'Reported', requestedClockInAt: 'Requested clock in', requestedClockOutAt: 'Requested clock out',
  resolutionMethod: 'Resolution', resolutionNote: 'Resolution note', resolvedAt: 'Resolved', resolvedBy: 'Resolved by',
  reviewedAt: 'Reviewed', reviewer: 'Reviewer', scheduledEndAt: 'Scheduled end', scheduledMinutes: 'Scheduled',
  scheduledStartAt: 'Scheduled start', shiftNotes: 'Shift notes', sitePost: 'Site / Post', startsAt: 'Starts',
  status: 'Status', submittedAt: 'Submitted', timeOpenMinutes: 'Time open', unpaidBreakMinutes: 'Unpaid breaks',
  warningCodes: 'Warnings', workDate: 'Work date', workedMinutes: 'Worked',
}

function number(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function defaultRange() {
  const through = new Date()
  const from = new Date(through)
  from.setDate(from.getDate() - 13)
  return { from: isoDate(from), through: isoDate(through) }
}

function storedRange() {
  try {
    const parsed = JSON.parse(localStorage.getItem(rangeStorageKey) ?? '{}') as { from?: string; through?: string }
    if (parsed.from && parsed.through) return { from: parsed.from, through: parsed.through }
  } catch {
    // A malformed local preference must not prevent Reports from opening.
  }
  return defaultRange()
}

function saveRange(from: string, through: string) {
  localStorage.setItem(rangeStorageKey, JSON.stringify({ from, through }))
}

function labelFor(field: string): string {
  return fieldLabels[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())
}

function valueFor(value: unknown, field?: string): string {
  if (value == null || value === '') return 'Not recorded'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (field?.toLowerCase().includes('minutes')) return `${Math.floor(value / 60)} hr ${value % 60} min`
    return number(value)
  }
  if (Array.isArray(value)) return value.length ? value.map((item) => valueFor(item)).join(', ') : 'None'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = new Date(text)
    if (!Number.isNaN(parsed.valueOf())) {
      return new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Denver' }).format(parsed)
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-')
    return `${month}/${day}/${year}`
  }
  return text.replaceAll('_', ' ')
}

function rowKey(row: Record<string, unknown>, index: number): string {
  return String(row.id ?? `${row.employeeId ?? 'row'}-${row.workDate ?? row.operationalDate ?? row.startsAt ?? index}`)
}

function RangeControls({ from, onChange, through }: { from: string; onChange: (from: string, through: string) => void; through: string }) {
  return <div className="reports-range" aria-label="Report date range">
    <label><span>From</span><input max={through} onChange={(event) => onChange(event.target.value, through)} type="date" value={from} /></label>
    <label><span>Through</span><input min={from} onChange={(event) => onChange(from, event.target.value)} type="date" value={through} /></label>
  </div>
}

function ReportLibrary({ from, permissions, through }: { from: string; permissions: string[]; through: string }) {
  const canViewTimeReports = permissions.includes('time.reports.view')
  const canViewLicensingReport = permissions.includes('licensing.view')
  const canViewPatrolReport = permissions.includes('patrol.reports.view') || permissions.includes('patrol.manage')
  const canViewClientReport = permissions.includes('clients.activity.view') || permissions.includes('clients.manage')
  const reportQuery = useQuery({ queryKey: ['operations-report'], queryFn: getOperationsReport, enabled: isSupabaseConfigured })
  const attentionQuery = useQuery({
    queryKey: ['reports-attention-preview', from, through],
    queryFn: () => getTimekeepingOperationsReportPage({ reportKey: 'timekeepingExceptions', fromDate: from, throughDate: through, scope: 'active', sort: 'priority', page: 1, pageSize: 10 }),
    enabled: isSupabaseConfigured && through >= from && canViewTimeReports,
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={DatabaseZap} title="Reports need the secure connection" tone="setup"><p>Reports become available after the protected data connection is restored.</p></DataStatePanel>
  if (reportQuery.isPending) return <DataStatePanel icon={FileBarChart} title="Loading report library"><p>Gathering current operational totals.</p></DataStatePanel>
  if (reportQuery.isError) return <DataStatePanel icon={ShieldAlert} title="Reports unavailable" tone="error"><p>{reportQuery.error.message}</p></DataStatePanel>

  const report = reportQuery.data
  const attentionRows = attentionQuery.data?.rows.slice(0, 5) ?? []
  return <>
    <section className="operations-metrics reports-metric-grid" aria-label="Reports overview">
      <article><span>Published weeks</span><strong>{number(report.schedule.weeks)}</strong><small>{number(report.schedule.shifts)} scheduled shifts</small></article>
      <article><span>Assigned slots</span><strong>{number(report.schedule.assignedSlots)}</strong><small>{number(report.schedule.openShifts)} open</small></article>
      <article className={report.schedule.reviewNeeded ? 'import-metric--attention' : ''}><span>Review needed</span><strong>{number(report.schedule.reviewNeeded)}</strong><small>Schedule items requiring attention</small></article>
      <article><span>Active employees</span><strong>{number(report.people.active)}</strong><small>{number(report.people.hourly)} hourly · {number(report.people.salary)} salary</small></article>
    </section>

    {canViewTimeReports ? <section className="operations-panel reports-attention" aria-labelledby="reports-attention-title">
      <div className="reports-section-heading"><div><p className="eyebrow">Attention preview</p><h2 id="reports-attention-title">Items needing review</h2><p>The five highest-priority timekeeping items in the selected range.</p></div><Link className="secondary-button" to={`/reports/timekeepingExceptions?from=${from}&through=${through}&scope=active&sort=priority`}>Open full report</Link></div>
      {attentionQuery.isPending ? <div className="report-empty">Loading attention items…</div> : null}
      {attentionQuery.isError ? <div className="shell-alert" role="alert">{attentionQuery.error.message}</div> : null}
      {!attentionQuery.isPending && !attentionQuery.isError && attentionRows.length === 0 ? <div className="report-empty">No unresolved timekeeping items are in this range.</div> : null}
      {attentionRows.length ? <div className="reports-attention-list">{attentionRows.map((row, index) => <article key={rowKey(row, index)}><div><strong>{valueFor(row.employeeName)}</strong><span>{valueFor(row.exceptionCode)} · {valueFor(row.sitePost)}</span></div><span>{valueFor(row.scheduledStartAt ?? row.detectedAt)}</span></article>)}</div> : null}
    </section> : null}

    <section className="operations-panel reports-snapshot" aria-labelledby="reports-snapshot-title">
      <div className="reports-section-heading"><div><p className="eyebrow">Operational snapshot</p><h2 id="reports-snapshot-title">Current activity</h2></div><Link className="secondary-button" to="/payroll">Open Payroll</Link></div>
      <div className="reports-snapshot-grid">
        <article><h3>Employee mix</h3><dl><div><dt>Guards</dt><dd>{number(report.people.guards)}</dd></div><div><dt>Supervisors</dt><dd>{number(report.people.supervisors)}</dd></div><div><dt>Flex</dt><dd>{number(report.people.flex)}</dd></div></dl></article>
        <article><h3>Sites &amp; Posts</h3><dl><div><dt>Active sites</dt><dd>{number(report.sites.activeSites)}</dd></div><div><dt>Active posts</dt><dd>{number(report.posts.activePosts)}</dd></div><div><dt>Armed openings</dt><dd>{number(report.schedule.armedOpenShifts)}</dd></div></dl></article>
        <article><h3>Action queue</h3><dl><div><dt>Time off</dt><dd>{number(report.requests.timeOffPending)}</dd></div><div><dt>Shift requests</dt><dd>{number(report.requests.shiftPending)}</dd></div><div><dt>Call-offs</dt><dd>{number(report.requests.callOffsOpen)}</dd></div></dl></article>
        <article><h3>Timekeeping posture</h3><dl><div><dt>Time events</dt><dd>{number(report.timekeeping.timeEvents)}</dd></div><div><dt>Corrections</dt><dd>{number(report.timekeeping.pendingCorrections)}</dd></div><div><dt>Notifications failed</dt><dd>{number(report.notifications.failed)}</dd></div></dl></article>
      </div>
    </section>

    <section className="reports-catalog" aria-labelledby="reports-catalog-title">
      <div className="reports-section-heading"><div><p className="eyebrow">Report library</p><h2 id="reports-catalog-title">Choose one report</h2><p>Each report opens in a focused, paginated workspace.</p></div></div>
      <div className="reports-report-grid">
        {canViewClientReport ? <article className="reports-report-card reports-report-card--clients"><div><p className="eyebrow">Client operations</p><h3>Client Portfolio &amp; Activity</h3><p>Review client status, renewals, linked sites, contacts, protected documents, shifts, patrol hits, incidents, and service history from the authoritative Client File.</p></div><Link className="secondary-button" to="/clients">Open report</Link></article> : null}
        {canViewPatrolReport ? <article className="reports-report-card reports-report-card--patrol"><div><p className="eyebrow">Patrol operations</p><h3>Patrol Activity</h3><p>Review required, completed, missed, makeup, extra, incident, location, and protected-evidence activity. Export internal or client-ready reports.</p></div><Link className="secondary-button" to="/reports/patrolActivity">Open report</Link></article> : null}
        {canViewLicensingReport ? <article className="reports-report-card reports-report-card--licensing"><div><p className="eyebrow">Licensing &amp; Credentials</p><h3>Guard Licensing Status</h3><p>See who is currently licensed, expiring, expired, pending review, restricted, or missing a required license, then download the complete Excel workbook.</p></div><Link className="secondary-button" to="/reports/licensingStatus">Open report</Link></article> : null}
        {canViewTimeReports ? operationalReportDefinitions.map((definition) => <article className="reports-report-card" key={definition.key}><div><h3>{definition.title}</h3><p>{definition.description}</p></div><Link className="secondary-button" to={`/reports/${definition.key}?from=${from}&through=${through}&scope=active&sort=priority`}>Open report</Link></article>) : null}
      </div>
      {!canViewLicensingReport && !canViewTimeReports && !canViewPatrolReport && !canViewClientReport ? <div className="report-empty">No report library items are available with your current permissions.</div> : null}
    </section>
  </>
}

function ReportResultCard({ definition, onInspect, row }: { definition: OperationalReportDefinition; onInspect: () => void; row: Record<string, unknown> }) {
  return <article className="reports-result-card"><dl className="reports-result-summary">{definition.summaryFields.map((field) => <div key={field}><dt>{labelFor(field)}</dt><dd>{valueFor(row[field], field)}</dd></div>)}</dl><button className="secondary-button" onClick={onInspect} type="button">View details</button></article>
}

function ReportWorkspace({ definition, from, onRangeChange, through }: { definition: OperationalReportDefinition; from: string; onRangeChange: (from: string, through: string) => void; through: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null)
  const search = searchParams.get('search') ?? ''
  const scopeValue = searchParams.get('scope')
  const scope = scopeValue === 'archive' || scopeValue === 'all' ? scopeValue : 'active'
  const sortValue = searchParams.get('sort')
  const sort = sortValue === 'newest' || sortValue === 'oldest' || sortValue === 'employee' ? sortValue : 'priority'
  const filterValue = searchParams.get('filter') ?? ''
  const rawPageSize = Number(searchParams.get('pageSize') ?? 10)
  const pageSize = pageSizes.includes(rawPageSize as 10 | 25 | 50) ? rawPageSize as 10 | 25 | 50 : 10
  const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)

  const updateParameters = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '') next.delete(key)
      else next.set(key, String(value))
    }
    setSearchParams(next)
  }

  const query = useQuery({
    queryKey: ['operational-report-page', definition.key, from, through, scope, search, filterValue, sort, page, pageSize],
    queryFn: () => getTimekeepingOperationsReportPage({ reportKey: definition.key, fromDate: from, throughDate: through, scope, search, filterKey: definition.filter?.key, filterValue, sort, page, pageSize }),
    enabled: isSupabaseConfigured && through >= from,
    placeholderData: (previous) => previous,
  })

  return <>
    <section className="operations-panel reports-workspace-heading"><Link className="secondary-button reports-back" to={`/reports?from=${from}&through=${through}`}><ArrowLeft aria-hidden="true" size={18} />Back to report library</Link><div><p className="eyebrow">Focused report</p><h1>{definition.title}</h1><p>{definition.description}</p></div></section>
    <section className="operations-panel reports-workspace-controls" aria-label={`${definition.title} controls`}>
      <RangeControls from={from} onChange={onRangeChange} through={through} />
      <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => updateParameters({ search: event.target.value, page: 1 })} placeholder="Employee, site, status, or note" type="search" value={search} /></span></label>
      <div className="reports-filter-row">
        {definition.filter ? <label><span>{definition.filter.label}</span><select onChange={(event) => updateParameters({ filter: event.target.value, page: 1 })} value={filterValue}>{definition.filter.options.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}</select></label> : null}
        <label><span>Sort</span><select onChange={(event) => updateParameters({ sort: event.target.value, page: 1 })} value={sort}><option value="priority">Priority</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="employee">Employee name</option></select></label>
        <label><span>Rows</span><select onChange={(event) => updateParameters({ pageSize: event.target.value, page: 1 })} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      </div>
      <div className="reports-scope-tabs" role="tablist" aria-label="Report status"><button aria-selected={scope === 'active'} className={scope === 'active' ? 'reports-scope-tab reports-scope-tab--active' : 'reports-scope-tab'} onClick={() => updateParameters({ scope: 'active', page: 1 })} role="tab" type="button">{definition.activeLabel}{query.data ? ` (${number(query.data.activeCount)})` : ''}</button><button aria-selected={scope === 'archive'} className={scope === 'archive' ? 'reports-scope-tab reports-scope-tab--active' : 'reports-scope-tab'} onClick={() => updateParameters({ scope: 'archive', page: 1 })} role="tab" type="button">{definition.archiveLabel}{query.data ? ` (${number(query.data.archiveCount)})` : ''}</button></div>
    </section>
    <section className="operations-panel reports-results" aria-live="polite">
      <div className="reports-section-heading"><div><p className="eyebrow">Results</p><h2>{query.data ? `${number(query.data.totalCount)} records` : 'Loading records'}</h2></div><Link className="secondary-button reports-canonical-link" to={definition.canonicalPath}>{definition.canonicalLabel}</Link></div>
      {query.isPending ? <div className="report-empty">Loading report results…</div> : null}
      {query.isError ? <DataStatePanel icon={ShieldAlert} title="Report unavailable" tone="error"><p>{query.error.message}</p><p>Your access is verified on the server before any report data is returned.</p></DataStatePanel> : null}
      {!query.isPending && !query.isError && query.data?.rows.length === 0 ? <div className="report-empty">No records match this date range and these filters.</div> : null}
      {query.data?.rows.length ? <div className="reports-result-list">{query.data.rows.map((row, index) => <ReportResultCard definition={definition} key={rowKey(row, index)} onInspect={() => setSelectedRow(row)} row={row} />)}</div> : null}
      {query.data && query.data.totalPages > 1 ? <div className="reports-pagination" aria-label="Report pages"><button className="secondary-button" disabled={page <= 1 || query.isFetching} onClick={() => updateParameters({ page: page - 1 })} type="button"><ChevronLeft aria-hidden="true" size={18} />Previous</button><span>Page {page} of {query.data.totalPages}</span><button className="secondary-button" disabled={page >= query.data.totalPages || query.isFetching} onClick={() => updateParameters({ page: page + 1 })} type="button">Next<ChevronRight aria-hidden="true" size={18} /></button></div> : null}
    </section>
    {selectedRow ? <ModalDialog className="reports-detail-modal" description="Read-only report detail. Operational changes are completed in the linked source workspace." onClose={() => setSelectedRow(null)} title={definition.title}><div className="reports-detail-grid">{definition.detailFields.map((field) => <div key={field}><span>{labelFor(field)}</span><strong>{valueFor(selectedRow[field], field)}</strong></div>)}</div><div className="modal-actions"><Link className="primary-action" to={definition.canonicalPath}>{definition.canonicalLabel}</Link><button className="secondary-button" onClick={() => setSelectedRow(null)} type="button">Close</button></div></ModalDialog> : null}
  </>
}

export function ReportsPage() {
  const { reportKey } = useParams<{ reportKey?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialRange = useMemo(storedRange, [])
  const from = searchParams.get('from') ?? initialRange.from
  const through = searchParams.get('through') ?? initialRange.through
  const definition = getOperationalReportDefinition(reportKey)
  const isLicensingStatusReport = reportKey === 'licensingStatus'
  const isPatrolActivityReport = reportKey === 'patrolActivity'
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const permissions = sessionQuery.data?.permissions ?? []
  const canViewLicensingStatusReport = permissions.includes('licensing.view')
  const canExportLicensingStatusReport = permissions.includes('reports.export')
  const canViewPatrolActivityReport = permissions.includes('patrol.reports.view') || permissions.includes('patrol.manage')

  useEffect(() => {
    if (searchParams.has('from') && searchParams.has('through')) return
    const next = new URLSearchParams(searchParams)
    next.set('from', from)
    next.set('through', through)
    setSearchParams(next, { replace: true })
  }, [from, searchParams, setSearchParams, through])

  const changeRange = (nextFrom: string, nextThrough: string) => {
    saveRange(nextFrom, nextThrough)
    const next = new URLSearchParams(searchParams)
    next.set('from', nextFrom)
    next.set('through', nextThrough)
    next.set('page', '1')
    setSearchParams(next)
  }

  return <div className="page page--reports">
    {!reportKey ? <section className="page-intro reports-page-intro"><div><p className="eyebrow">Operations</p><h1>Reports</h1><p className="page-summary">Choose a focused operational report without loading every record into one screen.</p></div><RangeControls from={from} onChange={changeRange} through={through} /></section> : null}
    {reportKey && !definition && !isLicensingStatusReport && !isPatrolActivityReport ? <DataStatePanel icon={ShieldAlert} title="Report not found" tone="error"><p>This report is not part of the approved report library.</p><Link className="secondary-button" to="/reports">Return to Reports</Link></DataStatePanel> : null}
    {!reportKey ? <ReportLibrary from={from} permissions={permissions} through={through} /> : null}
    {definition ? <ReportWorkspace definition={definition} from={from} onRangeChange={changeRange} through={through} /> : null}
    {isLicensingStatusReport && sessionQuery.isPending ? <DataStatePanel icon={FileBarChart} title="Verifying report access"><p>Checking your current Reports and Licensing permissions.</p></DataStatePanel> : null}
    {isLicensingStatusReport && sessionQuery.isError ? <DataStatePanel icon={ShieldAlert} title="Report access unavailable" tone="error"><p>{sessionQuery.error.message}</p></DataStatePanel> : null}
    {isLicensingStatusReport && sessionQuery.isSuccess && !canViewLicensingStatusReport ? <DataStatePanel icon={ShieldAlert} title="Licensing report access required" tone="error"><p>This report contains protected licensing information and requires Licensing access with verified MFA.</p><Link className="secondary-button" to="/reports">Return to Reports</Link></DataStatePanel> : null}
    {isLicensingStatusReport && canViewLicensingStatusReport ? <LicensingStatusReportWorkspace canExport={canExportLicensingStatusReport} /> : null}
    {isPatrolActivityReport && sessionQuery.isPending ? <DataStatePanel icon={FileBarChart} title="Verifying Patrol report access"><p>Checking your current Patrol reporting permissions.</p></DataStatePanel> : null}
    {isPatrolActivityReport && sessionQuery.isSuccess && !canViewPatrolActivityReport ? <DataStatePanel icon={ShieldAlert} title="Patrol report access required" tone="error"><p>This report requires protected Patrol reporting access.</p><Link className="secondary-button" to="/reports">Return to Reports</Link></DataStatePanel> : null}
    {isPatrolActivityReport && canViewPatrolActivityReport ? <PatrolActivityReportWorkspace /> : null}
  </div>
}

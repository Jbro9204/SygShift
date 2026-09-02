import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileBarChart, Search, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { authorizePatrolReportExport, getPatrolReport } from '../data/patrol'
import { isSupabaseConfigured } from '../lib/supabase'
import { downloadPatrolCsv, downloadPatrolPdf, downloadPatrolXlsx, type PatrolReportProfile } from './patrolReportExport'

const pageSizes = [5, 10, 20] as const

function statusLabel(value: string | null) {
  return value ? value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Not recorded'
}

export function PatrolActivityReportWorkspace() {
  const today = new Date().toISOString().slice(0, 10)
  const twoWeeksAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10)
  const [from, setFrom] = useState(twoWeeksAgo)
  const [through, setThrough] = useState(today)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [classification, setClassification] = useState('all')
  const [route, setRoute] = useState('all')
  const [profile, setProfile] = useState<PatrolReportProfile>('internal')
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(10)
  const [page, setPage] = useState(1)
  const [downloaded, setDownloaded] = useState('')

  const reportQuery = useQuery({
    enabled: isSupabaseConfigured && Boolean(from && through && through >= from),
    queryFn: () => getPatrolReport(from, through),
    queryKey: ['patrol-report', from, through],
  })
  const routeOptions = useMemo(() => Array.from(new Set((reportQuery.data?.rows ?? []).map((row) => row.routeName))).sort(), [reportQuery.data?.rows])
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (reportQuery.data?.rows ?? []).filter((row) => {
      if (status !== 'all' && row.status !== status) return false
      if (classification !== 'all' && row.classification !== classification) return false
      if (route !== 'all' && row.routeName !== route) return false
      return !term || `${row.employeeName} ${row.employeeNumber ?? ''} ${row.routeName} ${row.locationLabel} ${row.note ?? ''} ${row.outcome ?? ''}`.toLowerCase().includes(term)
    })
  }, [classification, reportQuery.data?.rows, route, search, status])
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const visibleRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize)
  const exportMutation = useMutation({
    mutationFn: async (format: 'xlsx' | 'csv' | 'pdf') => {
      if (!reportQuery.data) throw new Error('The Patrol Activity report is not ready yet.')
      await authorizePatrolReportExport(from, through, profile, format)
      const filteredReport = { ...reportQuery.data, rows }
      if (format === 'xlsx') return downloadPatrolXlsx(filteredReport, profile)
      if (format === 'csv') return downloadPatrolCsv(filteredReport, profile)
      return downloadPatrolPdf(filteredReport, profile)
    },
    onSuccess: (name) => setDownloaded(name),
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={ShieldAlert} title="Patrol report needs the secure connection" tone="setup"><p>The report becomes available after the protected data connection is restored.</p></DataStatePanel>
  if (reportQuery.isPending) return <DataStatePanel icon={FileBarChart} title="Loading Patrol Activity report"><p>Reconciling assigned routes, required hits, outcomes, exceptions, and evidence totals.</p></DataStatePanel>
  if (reportQuery.isError) return <DataStatePanel icon={ShieldAlert} title="Patrol Activity report unavailable" tone="error"><p>{reportQuery.error.message}</p></DataStatePanel>
  const report = reportQuery.data

  return <>
    <section className="operations-panel reports-workspace-heading reports-patrol-heading">
      <Link className="secondary-button reports-back" to="/reports"><ArrowLeft aria-hidden="true" size={18} />Back to report library</Link>
      <div><p className="eyebrow">Patrol report</p><h1>Patrol Activity</h1><p>Review required, completed, missed, incident, location-verification, and evidence activity without mixing extra hits into required totals.</p></div>
    </section>
    <section className="reports-patrol-summary" aria-label="Patrol report summary">
      <article><span>Required</span><strong>{report.summary.required}</strong><small>Scheduled obligations</small></article>
      <article><span>Completed</span><strong>{report.summary.completed}</strong><small>Submitted required hits</small></article>
      <article className={report.summary.missed ? 'reports-patrol-danger' : ''}><span>Missed</span><strong>{report.summary.missed}</strong><small>Need exception review</small></article>
      <article><span>Extra</span><strong>{report.summary.extra}</strong><small>Tracked separately</small></article>
      <article><span>Incidents</span><strong>{report.summary.incidents}</strong><small>Incident outcomes</small></article>
      <article><span>Evidence</span><strong>{report.summary.evidence}</strong><small>Protected files</small></article>
      <article><span>Makeup</span><strong>{report.summary.makeupCompleted}/{report.summary.makeupAssigned + report.summary.makeupCompleted}</strong><small>Completed / assigned</small></article>
    </section>
    <section className="operations-panel reports-workspace-controls reports-patrol-controls">
      <div className="reports-range"><label><span>From</span><input max={through} onChange={(event) => { setFrom(event.target.value); setPage(1) }} type="date" value={from} /></label><label><span>Through</span><input min={from} onChange={(event) => { setThrough(event.target.value); setPage(1) }} type="date" value={through} /></label></div>
      <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Employee, route, stop, note, or outcome" type="search" value={search} /></span></label>
      <div className="reports-filter-row"><label><span>Activity</span><select onChange={(event) => { setClassification(event.target.value); setPage(1) }} value={classification}><option value="all">All activity</option><option value="required">Required hits</option><option value="makeup">Makeup hits</option><option value="extra">Extra hits</option></select></label><label><span>Status</span><select onChange={(event) => { setStatus(event.target.value); setPage(1) }} value={status}><option value="all">All statuses</option><option value="completed">Completed</option><option value="assigned">Makeup assigned</option><option value="missed">Missed</option><option value="due">Due</option><option value="scheduled">Scheduled</option><option value="waived">Waived</option><option value="canceled">Canceled</option></select></label><label><span>Route</span><select onChange={(event) => { setRoute(event.target.value); setPage(1) }} value={route}><option value="all">All routes</option>{routeOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as (typeof pageSizes)[number]); setPage(1) }} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label><label><span>Export profile</span><select onChange={(event) => setProfile(event.target.value as PatrolReportProfile)} value={profile}><option value="internal">Internal detail</option><option value="client">Client-ready</option></select></label></div>
      {report.canExport ? <div className="reports-patrol-export"><span>Download the filtered results</span><div><button className="secondary-button" disabled={exportMutation.isPending || rows.length === 0} onClick={() => exportMutation.mutate('csv')} type="button"><Download aria-hidden="true" size={17} />CSV</button><button className="secondary-button" disabled={exportMutation.isPending || rows.length === 0} onClick={() => exportMutation.mutate('xlsx')} type="button"><Download aria-hidden="true" size={17} />Excel</button><button className="primary-action" disabled={exportMutation.isPending || rows.length === 0} onClick={() => exportMutation.mutate('pdf')} type="button"><Download aria-hidden="true" size={17} />PDF</button></div></div> : <div className="reports-export-note"><ShieldAlert aria-hidden="true" size={18} /><span>You can view Patrol reporting. Downloads require Patrol Report Export permission.</span></div>}
      {downloaded ? <div className="form-feedback form-feedback--success" role="status">Downloaded {downloaded}.</div> : null}
      {exportMutation.isError ? <div className="inline-alert" role="alert">{exportMutation.error.message}</div> : null}
    </section>
    <section className="operations-panel reports-results"><div className="reports-section-heading"><div><p className="eyebrow">Results</p><h2>{rows.length} patrol record{rows.length === 1 ? '' : 's'}</h2><p>All dates follow the route’s configured operational time zone.</p></div><Link className="secondary-button" to="/patrol">Open Patrol Command Center</Link></div>
      {visibleRows.length === 0 ? <div className="report-empty">No Patrol records match these filters.</div> : <div className="reports-result-list">{visibleRows.map((row) => <article className="reports-result-card reports-patrol-result" key={row.recordId}><dl className="reports-result-summary"><div><dt>Service date</dt><dd>{row.serviceDate}<small>{row.routeName}</small></dd></div><div><dt>Employee</dt><dd>{row.employeeName}<small>{row.employeeNumber ?? 'ID not recorded'}</small></dd></div><div><dt>Stop</dt><dd>{row.locationLabel}<small>{statusLabel(row.classification)} · {row.requirementLabel}{row.hitNumber ? ` · Hit ${row.hitNumber}` : ''}</small></dd></div><div><dt>Status</dt><dd><span className={`patrol-status patrol-status--${row.status}`}>{statusLabel(row.status)}</span><small>{row.completedAt ? new Date(row.completedAt).toLocaleString() : 'Not completed'}</small></dd></div><div><dt>Outcome</dt><dd>{statusLabel(row.outcome)}<small>{row.evidenceCount} evidence file{row.evidenceCount === 1 ? '' : 's'}</small></dd></div></dl></article>)}</div>}
      {totalPages > 1 ? <div className="reports-pagination"><button className="secondary-button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button"><ChevronLeft aria-hidden="true" size={18} />Previous</button><span>Page {safePage} of {totalPages}</span><button className="secondary-button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} type="button">Next<ChevronRight aria-hidden="true" size={18} /></button></div> : null}
    </section>
  </>
}

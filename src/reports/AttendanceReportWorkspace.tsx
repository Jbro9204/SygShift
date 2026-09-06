import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getAttendanceReport } from '../data/accountability'
import { downloadXlsxWorkbook } from '../lib/xlsxWorkbook'
import { accountabilityDisplayState, accountabilityTypeLabels, summarizeAccountability } from '../time/accountability'
import { formatUsDateKey } from '../time/timeRules'
import { attendanceCsv, attendanceWorkbook, filterAttendanceReport } from './attendanceReport'

export function AttendanceReportWorkspace({ from, through, onRangeChange, canExport }: { from: string; through: string; onRangeChange: (from: string, through: string) => void; canExport: boolean }) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [state, setState] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const valid = Boolean(from && through && through >= from && (Date.parse(through) - Date.parse(from)) / 86400000 <= 45)
  const query = useQuery({ queryKey: ['attendance-report', from, through], queryFn: () => getAttendanceReport({ fromDate: from, throughDate: through }), enabled: valid })
  const events = filterAttendanceReport(query.data?.events ?? [], search, type, state)
  const summary = summarizeAccountability(events)
  const pages = Math.max(1, Math.ceil(events.length / pageSize))
  const activePage = Math.min(page, pages)
  const exportMutation = useMutation({ mutationFn: async (format: 'xlsx' | 'csv') => {
    const report = await getAttendanceReport({ fromDate: from, throughDate: through, export: true })
    const exportEvents = filterAttendanceReport(report.events, search, type, state)
    const filters = `Search: ${search || 'All'}; Type: ${type || 'All'}; Review: ${state || 'All'}`
    const fileName = `Attendance_${from}_through_${through}`
    if (format === 'xlsx') downloadXlsxWorkbook(attendanceWorkbook(report, exportEvents, filters), `${fileName}.xlsx`)
    else {
      const url = URL.createObjectURL(new Blob([attendanceCsv(report, exportEvents, filters)], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = `${fileName}.csv`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return exportEvents.length
  } })
  function changeRange(nextFrom: string, nextThrough: string) { setPage(1); exportMutation.reset(); onRangeChange(nextFrom, nextThrough) }
  function selectWeek(previous: boolean) {
    const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const start = new Date(`${dateKey}T12:00:00Z`)
    start.setUTCDate(start.getUTCDate() - start.getUTCDay() - (previous ? 7 : 0))
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6)
    changeRange(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10))
  }
  return <>
    <section className="operations-panel reports-workspace-heading"><Link className="secondary-button reports-back" to="/reports">Back to report library</Link><div><p className="eyebrow">Weekly operations reporting</p><h1>Attendance &amp; Call-Offs</h1><p>Recorded occurrences from Accountability Tracker, call-off reports, and time-off requests. All review states are included by default.</p></div></section>
    <section className="operations-panel reports-workspace-controls attendance-report-controls" aria-label="Attendance report controls">
      <fieldset disabled={exportMutation.isPending}><div className="reports-range"><label><span>From</span><input type="date" max={through} value={from} onChange={(event) => changeRange(event.target.value, through)} /></label><label><span>Through</span><input type="date" min={from} value={through} onChange={(event) => changeRange(from, event.target.value)} /></label></div>
      <div className="attendance-report-actions"><button className="secondary-button" type="button" onClick={() => selectWeek(false)}>This week</button><button className="secondary-button" type="button" onClick={() => selectWeek(true)}>Previous week</button><span>Sunday–Saturday · Mountain dates</span></div>
      <div className="reports-filter-row"><label><span>Search attendance</span><input type="search" placeholder="Employee, location, or note" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} /></label><label><span>Occurrence type</span><select value={type} onChange={(event) => { setType(event.target.value); setPage(1) }}><option value="">All occurrence types</option>{Object.entries(accountabilityTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Review state</span><select value={state} onChange={(event) => { setState(event.target.value); setPage(1) }}><option value="">All review states</option>{['open','confirmed','protected','corrected','dismissed'].map((value) => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label></div></fieldset>
      {!valid ? <p role="alert">Choose a date range of up to 46 days.</p> : null}
    </section>
    <section className="operations-panel reports-results attendance-report-results" aria-busy={query.isFetching}>
      <div className="reports-section-heading"><div><h2>{valid && query.isSuccess ? `${events.length} documented occurrences` : 'Attendance results'}</h2><p>Recorded absences include call-offs, sick calls, and no-call/no-shows. Totals count occurrences, not absent days or discipline points.</p></div><Link className="secondary-button" to="/time/accountability">Open Accountability Tracker</Link></div>
      {valid && query.isPending ? <p role="status">Loading attendance records…</p> : null}
      {query.isError ? <p role="alert">{query.error.message}</p> : null}
      {valid && query.isSuccess ? <>
        <div className="operations-metrics reports-metric-grid"><article><span>Recorded absences</span><strong>{summary.absences}</strong></article><article><span>Late arrivals</span><strong>{summary.lateArrivals}</strong></article><article><span>Corrected records</span><strong>{summary.corrected}</strong></article><article><span>Open review</span><strong>{summary.open}</strong></article></div>
        <p>Corrected records remain in recorded totals. Dismissed and voided records are excluded from type totals; approved time off is separate.</p>
        <div className="attendance-report-actions"><button className="primary-action" disabled={!canExport || exportMutation.isPending || query.isFetching} onClick={() => exportMutation.mutate('xlsx')} type="button">{exportMutation.isPending ? 'Preparing export…' : 'Export Excel'}</button><button className="secondary-button" disabled={!canExport || exportMutation.isPending || query.isFetching} onClick={() => exportMutation.mutate('csv')} type="button">Export CSV</button><small>Exports include every matching record, not just this page. Excel includes employee totals and occurrence detail.</small></div>
        {!canExport ? <p>Report export permission is required to download.</p> : null}
        {exportMutation.isSuccess ? <p role="status">Export prepared: {exportMutation.data} matching records.</p> : null}
        {exportMutation.isError ? <p role="alert">{exportMutation.error.message}</p> : null}
        {!events.length ? <div className="report-empty">No attendance records match this range and these filters.</div> : <div className="reports-result-list">{events.slice((activePage - 1) * pageSize, activePage * pageSize).map((event) => <article className="reports-result-card" key={`${event.sourceTable}-${event.id}`}><dl className="reports-result-summary"><div><dt>Work date</dt><dd>{formatUsDateKey(event.operationalDate)}</dd></div><div><dt>Employee</dt><dd>{event.employeeName}</dd></div><div><dt>Type</dt><dd>{accountabilityTypeLabels[event.eventType]}</dd></div><div><dt>Review</dt><dd>{accountabilityDisplayState(event)}</dd></div></dl><p>{event.locationName} · {event.note}</p></article>)}</div>}
        {events.length > 10 ? <nav className="reports-pagination attendance-report-pagination" aria-label="Attendance pages"><label>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>{[10,25,50].map((size) => <option key={size}>{size}</option>)}</select></label><span>Page {activePage} of {pages}</span><button className="secondary-button" disabled={activePage === 1} onClick={() => setPage(activePage - 1)} type="button">Previous</button><button className="secondary-button" disabled={activePage === pages} onClick={() => setPage(activePage + 1)} type="button">Next</button></nav> : null}
      </> : null}
    </section>
  </>
}

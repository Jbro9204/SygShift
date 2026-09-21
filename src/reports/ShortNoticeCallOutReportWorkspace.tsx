import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Download, FileText, Search, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ModalDialog } from '../components/ModalDialog'
import { getShortNoticeCallOutReport, type ShortNoticeCallOutRow } from '../data/shortNoticeCallOutReport'
import { downloadXlsxWorkbook } from '../lib/xlsxWorkbook'
import { formatUsDateKey } from '../time/timeRules'
import {
  coverageStatusLabels,
  filterShortNoticeCallOutRows,
  formatNoticeMinutes,
  formatOperationalDateTime,
  occurrenceTypeLabels,
  reviewOutcomeLabels,
  shortNoticeCallOutPdf,
  shortNoticeCallOutWorkbook,
  summarizeShortNoticeCallOutRows,
  type ShortNoticeCallOutFilters,
} from './shortNoticeCallOutReport'

const emptyFilters: ShortNoticeCallOutFilters = {
  search: '', noticeBucket: '', occurrenceType: '', reviewOutcome: '', coverageStatus: '',
}

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function filterDescription(filters: ShortNoticeCallOutFilters): string {
  return [
    `Search: ${filters.search || 'All'}`,
    `Notice: ${filters.noticeBucket ? filters.noticeBucket.replaceAll('_', ' ') : 'All under four hours'}`,
    `Occurrence: ${filters.occurrenceType ? occurrenceTypeLabels[filters.occurrenceType as ShortNoticeCallOutRow['occurrenceType']] : 'All'}`,
    `Review: ${filters.reviewOutcome ? reviewOutcomeLabels[filters.reviewOutcome as ShortNoticeCallOutRow['reviewOutcome']] : 'All'}`,
    `Coverage: ${filters.coverageStatus ? coverageStatusLabels[filters.coverageStatus as ShortNoticeCallOutRow['coverageStatus']] : 'All'}`,
  ].join('; ')
}

function ShortNoticeDetail({ onClose, row }: { onClose: () => void; row: ShortNoticeCallOutRow }) {
  return <ModalDialog className="reports-detail-modal short-notice-detail-modal" description="Read-only HR attendance detail. Review decisions remain in the Accountability Tracker." onClose={onClose} title={`Short-notice call-out · ${row.employeeName}`}>
    <div className="reports-detail-grid short-notice-detail-grid">
      <div><span>Employee number</span><strong>{row.employeeNumber ?? 'Not recorded'}</strong></div>
      <div><span>Work date</span><strong>{formatUsDateKey(row.operationalDate)}</strong></div>
      <div><span>Occurrence</span><strong>{occurrenceTypeLabels[row.occurrenceType]}</strong></div>
      <div><span>Scheduled start</span><strong>{formatOperationalDateTime(row.scheduledStartAt, row.timeZone)}</strong></div>
      <div><span>Call received</span><strong>{formatOperationalDateTime(row.callReceivedAt, row.timeZone)}</strong></div>
      <div><span>Notice provided</span><strong>{formatNoticeMinutes(row.noticeMinutes)}</strong></div>
      <div><span>Client</span><strong>{row.clientName ?? 'Not linked'}</strong></div>
      <div><span>Site / post</span><strong>{[row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' / ') || row.locationName}</strong></div>
      <div><span>Submitted through</span><strong>{row.submissionSource.replaceAll('_', ' ')}</strong></div>
      <div><span>Received by</span><strong>{row.receivedByName ?? row.reportedByName ?? 'Not recorded'}</strong></div>
      <div><span>Coverage</span><strong>{coverageStatusLabels[row.coverageStatus]}</strong></div>
      <div><span>Replacement</span><strong>{row.replacementEmployeeName ?? 'None recorded'}</strong></div>
      <div><span>Overtime created</span><strong>{row.overtimeCreated ? 'Yes' : 'No'}</strong></div>
      <div><span>HR review</span><strong>{reviewOutcomeLabels[row.reviewOutcome]}</strong></div>
      <div><span>Reviewed by</span><strong>{row.reviewedByName ?? 'Pending'}</strong></div>
      <div className="short-notice-detail-grid__wide"><span>Call-out reason</span><strong>{row.reason ?? 'Not recorded'}</strong></div>
      <div className="short-notice-detail-grid__wide"><span>Operational details</span><strong>{row.operationalDetails ?? 'Not recorded'}</strong></div>
      <div className="short-notice-detail-grid__wide"><span>HR decision note</span><strong>{row.decisionNote ?? 'No decision note'}</strong></div>
    </div>
    <div className="modal-actions"><Link className="primary-action" to={row.actionPath}>Open coverage record</Link><Link className="secondary-button" to="/time/accountability">Open Accountability Tracker</Link><button className="secondary-button" onClick={onClose} type="button">Close</button></div>
  </ModalDialog>
}

export function ShortNoticeCallOutReportWorkspace({ canExport, from, onRangeChange, through }: {
  canExport: boolean
  from: string
  onRangeChange: (from: string, through: string) => void
  through: string
}) {
  const [filters, setFilters] = useState<ShortNoticeCallOutFilters>(emptyFilters)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [selected, setSelected] = useState<ShortNoticeCallOutRow | null>(null)
  const valid = Boolean(from && through && through >= from && (Date.parse(through) - Date.parse(from)) / 86400000 <= 366)
  const query = useQuery({
    queryKey: ['hr-short-notice-call-outs', from, through],
    queryFn: () => getShortNoticeCallOutReport({ fromDate: from, throughDate: through }),
    enabled: valid,
  })
  const rows = useMemo(() => filterShortNoticeCallOutRows(query.data?.rows ?? [], filters), [filters, query.data?.rows])
  const summary = useMemo(() => summarizeShortNoticeCallOutRows(rows), [rows])
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const activePage = Math.min(page, pages)

  useEffect(() => { if (page > pages) setPage(pages) }, [page, pages])

  const exportMutation = useMutation({
    mutationFn: async (format: 'xlsx' | 'pdf') => {
      const report = await getShortNoticeCallOutReport({ fromDate: from, throughDate: through, export: true })
      const exportRows = filterShortNoticeCallOutRows(report.rows, filters)
      const description = filterDescription(filters)
      const fileName = `Short_Notice_Call_Outs_${from}_through_${through}`
      if (format === 'xlsx') downloadXlsxWorkbook(shortNoticeCallOutWorkbook(report, exportRows, description), `${fileName}.xlsx`)
      else downloadBytes(await shortNoticeCallOutPdf(report, exportRows, description), `${fileName}.pdf`, 'application/pdf')
      return { count: exportRows.length, format }
    },
  })

  function updateFilter(key: keyof ShortNoticeCallOutFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
    exportMutation.reset()
  }

  function changeRange(nextFrom: string, nextThrough: string) {
    setPage(1)
    exportMutation.reset()
    onRangeChange(nextFrom, nextThrough)
  }

  return <>
    <section className="operations-panel reports-workspace-heading short-notice-heading">
      <Link className="secondary-button reports-back" to={`/reports?from=${from}&through=${through}`}>Back to report library</Link>
      <div><p className="eyebrow">Protected HR reporting</p><h1>Short-Notice Call-Outs</h1><p>Employees who provided less than four hours’ notice before a scheduled shift. Exactly four hours is compliant; after-start and no-call/no-show records remain clearly identified.</p></div>
    </section>

    <section className="operations-panel reports-workspace-controls short-notice-controls" aria-label="Short-notice call-out report controls">
      <div className="reports-range"><label><span>From</span><input type="date" max={through} value={from} onChange={(event) => changeRange(event.target.value, through)} /></label><label><span>Through</span><input type="date" min={from} value={through} onChange={(event) => changeRange(from, event.target.value)} /></label></div>
      <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => updateFilter('search', event.target.value)} placeholder="Employee, number, client, site, or receiver" type="search" value={filters.search} /></span></label>
      <div className="reports-filter-row short-notice-filter-row">
        <label><span>Notice window</span><select value={filters.noticeBucket} onChange={(event) => updateFilter('noticeBucket', event.target.value)}><option value="">All under four hours</option><option value="after_start">After shift started</option><option value="under_1_hour">Under 1 hour</option><option value="1_to_2_hours">1–2 hours</option><option value="2_to_3_hours">2–3 hours</option><option value="3_to_4_hours">3–4 hours</option></select></label>
        <label><span>Occurrence</span><select value={filters.occurrenceType} onChange={(event) => updateFilter('occurrenceType', event.target.value)}><option value="">All occurrences</option>{Object.entries(occurrenceTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>HR review</span><select value={filters.reviewOutcome} onChange={(event) => updateFilter('reviewOutcome', event.target.value)}><option value="">All review outcomes</option>{Object.entries(reviewOutcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Coverage result</span><select value={filters.coverageStatus} onChange={(event) => updateFilter('coverageStatus', event.target.value)}><option value="">All coverage results</option>{Object.entries(coverageStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <div className="short-notice-rule"><ShieldCheck aria-hidden="true" size={20} /><div><strong>Four-hour policy rule</strong><span>Flag when scheduled start minus actual call-received time is less than 240 minutes. A record entered later still uses the documented received time.</span></div></div>
      {!valid ? <p className="inline-alert" role="alert">Choose a valid date range of 366 days or fewer.</p> : null}
    </section>

    <section className="operations-metrics reports-metric-grid short-notice-metrics" aria-label="Short-notice call-out totals">
      <article><span>Short-notice events</span><strong>{summary.total}</strong><small>Less than four hours</small></article>
      <article className={summary.afterStart ? 'import-metric--attention' : ''}><span>After shift start</span><strong>{summary.afterStart}</strong><small>Includes late reports</small></article>
      <article><span>No-call / no-show</span><strong>{summary.noShows}</strong><small>Separate severe category</small></article>
      <article className={summary.uncovered ? 'import-metric--attention' : ''}><span>Coverage unresolved</span><strong>{summary.uncovered}</strong><small>Current recorded status</small></article>
      <article><span>Repeat employees</span><strong>{summary.repeatEmployees}</strong><small>More than one event</small></article>
    </section>

    <section className="operations-panel reports-results short-notice-results" aria-busy={query.isFetching}>
      <div className="reports-section-heading"><div><p className="eyebrow">HR attendance review</p><h2>{query.isSuccess ? `${rows.length} matching events` : 'Short-notice results'}</h2><p>This report documents notice timing and operational impact. It does not automatically assign discipline or attendance points.</p></div><div className="short-notice-export-actions"><button className="primary-action" disabled={!canExport || exportMutation.isPending || query.isFetching} onClick={() => exportMutation.mutate('xlsx')} type="button"><Download aria-hidden="true" size={17} />{exportMutation.isPending ? 'Preparing…' : 'Export Excel'}</button><button className="secondary-button" disabled={!canExport || exportMutation.isPending || query.isFetching} onClick={() => exportMutation.mutate('pdf')} type="button"><FileText aria-hidden="true" size={17} />Export PDF</button></div></div>
      {!canExport ? <p className="reports-export-note">HR report export permission is required to download protected records.</p> : null}
      {exportMutation.isSuccess ? <p className="form-feedback" role="status">{exportMutation.data.format.toUpperCase()} prepared with {exportMutation.data.count} matching records.</p> : null}
      {exportMutation.isError ? <p className="inline-alert" role="alert">{exportMutation.error.message}</p> : null}
      {valid && query.isPending ? <div className="report-empty">Loading short-notice call-outs…</div> : null}
      {query.isError ? <div className="inline-alert" role="alert">{query.error.message}</div> : null}
      {valid && query.isSuccess && rows.length === 0 ? <div className="report-empty">No call-outs under four hours match this date range and these filters.</div> : null}
      {rows.length ? <div className="reports-result-list short-notice-list">{rows.slice((activePage - 1) * pageSize, activePage * pageSize).map((row) => <article className={`reports-result-card short-notice-row${row.noticeMinutes < 0 ? ' short-notice-row--late' : ''}`} key={row.id}><dl className="reports-result-summary short-notice-summary"><div><dt>Work date</dt><dd>{formatUsDateKey(row.operationalDate)}</dd></div><div><dt>Employee</dt><dd>{row.employeeName}<small>{row.employeeNumber ?? 'No employee number'}</small></dd></div><div><dt>Notice</dt><dd>{formatNoticeMinutes(row.noticeMinutes)}</dd></div><div><dt>Shift</dt><dd>{formatOperationalDateTime(row.scheduledStartAt, row.timeZone)}</dd></div><div><dt>Site / post</dt><dd>{[row.siteName, row.postName ?? row.eventName].filter(Boolean).join(' / ') || row.locationName}</dd></div><div><dt>Coverage</dt><dd>{coverageStatusLabels[row.coverageStatus]}</dd></div></dl><button className="secondary-button" onClick={() => setSelected(row)} type="button">View details</button></article>)}</div> : null}
      {rows.length > 10 ? <nav className="reports-pagination attendance-report-pagination" aria-label="Short-notice report pages"><label>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>{[10, 25, 50].map((size) => <option key={size}>{size}</option>)}</select></label><span>Page {activePage} of {pages}</span><button className="secondary-button" disabled={activePage === 1} onClick={() => setPage(activePage - 1)} type="button">Previous</button><button className="secondary-button" disabled={activePage === pages} onClick={() => setPage(activePage + 1)} type="button">Next</button></nav> : null}
      {summary.afterStart > 0 ? <div className="short-notice-caution"><AlertTriangle aria-hidden="true" size={19} /><span>After-start records require factual HR review. This report does not infer whether an absence was protected or unexcused.</span></div> : null}
    </section>
    {selected ? <ShortNoticeDetail onClose={() => setSelected(null)} row={selected} /> : null}
  </>
}

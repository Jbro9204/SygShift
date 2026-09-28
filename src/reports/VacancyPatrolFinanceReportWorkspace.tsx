import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Search, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  authorizeVacancyPatrolFinanceExport,
  getVacancyPatrolFinanceReport,
  reviewVacancyPatrolBilling,
  type VacancyPatrolBillingDisposition,
  type VacancyPatrolFinanceRow,
} from '../data/vacancyPatrolFinance'
import {
  downloadVacancyPatrolFinanceCsv,
  downloadVacancyPatrolFinancePdf,
  downloadVacancyPatrolFinanceXlsx,
  vacancyPatrolDispositionLabel,
  vacancyPatrolStatusLabel,
} from './vacancyPatrolFinanceExport'

const pageSizes = [10, 25, 50] as const
const reviewedDispositions = ['bill_separately', 'included_in_contract', 'non_billable', 'duplicate_suppressed'] as const
type ReviewedDisposition = (typeof reviewedDispositions)[number]
type BillingSelection = ReviewedDisposition | ''

function formatDateTime(value: string | null, timeZone: string): string {
  if (!value) return 'Not recorded'
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(value))
}

function locationLabel(row: VacancyPatrolFinanceRow): string {
  return [row.siteName, row.postName].filter(Boolean).join(' / ') || 'Location not linked'
}

function BillingReviewDialog({ onClose, row }: { onClose: () => void, row: VacancyPatrolFinanceRow }) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(crypto.randomUUID())
  const initialDisposition: BillingSelection = row.billingDisposition === 'pending_review' ? '' : row.billingDisposition
  const [disposition, setDisposition] = useState<BillingSelection>(initialDisposition)
  const [reference, setReference] = useState(row.billingReference ?? '')
  const [reason, setReason] = useState(row.billingReason ?? '')
  const [acknowledged, setAcknowledged] = useState(false)
  const mutation = useMutation({
    mutationFn: async () => {
      if (!disposition) throw new Error('Choose a billing disposition.')
      return reviewVacancyPatrolBilling({
        billingReference: disposition === 'bill_separately' ? reference : reference || null,
        disposition,
        idempotencyKey: idempotencyKey.current,
        reason,
        requestId: row.requestId,
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-finance-report'] }),
        queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-map'] }),
        queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-worklist'] }),
      ])
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.reset()
    if (row.status !== 'completed' || !disposition) return
    mutation.mutate()
  }

  if (mutation.isSuccess) {
    return <ModalDialog className="reports-detail-modal" description={`${row.requestNumber} now has an audited Finance disposition.`} onClose={onClose} title="Billing decision recorded">
      <div className="form-feedback form-feedback--success" role="status">{vacancyPatrolDispositionLabel(mutation.data.billingDisposition)} was recorded by {mutation.data.reviewedBy.name}. No invoice or charge was created automatically.</div>
      <div className="modal-actions"><button className="primary-action" data-dialog-autofocus onClick={onClose} type="button">Done</button></div>
    </ModalDialog>
  }

  return <ModalDialog busy={mutation.isPending} busyLabel="Recording the audited billing decision..." className="reports-detail-modal" description={`${row.requestNumber} · ${row.clientName ?? row.siteName ?? 'Unlinked client'} · ${row.completedHits} completed, ${row.missedHits} missed, ${row.remainingHits} remaining`} onClose={onClose} title="Review vacancy Patrol billing">
    <form className="request-form" onSubmit={submit}>
      <div className="schedule-workflow-note"><ShieldCheck aria-hidden="true" size={20} /><p>This decision controls the Finance handoff only. It does not create an invoice, charge the client, rewrite the original shift, or alter Patrol evidence.</p></div>
      <div className="reports-detail-grid">
        <div><span>Original service</span><strong>{formatDateTime(row.startsAt, row.timeZone)}–{formatDateTime(row.endsAt, row.timeZone)}</strong></div>
        <div><span>Scheduled hours</span><strong>{row.originalShiftHours.toFixed(2)}</strong></div>
      <div><span>Patrol outcomes</span><strong>{row.completedHits} completed · {row.missedHits} missed</strong></div>
        <div><span>Client</span><strong>{row.clientName ?? 'Not linked'}</strong></div>
        <div><span>Site / post</span><strong>{locationLabel(row)}</strong></div>
        <div><span>Patrol route</span><strong>{row.acceptedRouteName ?? row.requestedRouteName ?? 'Not assigned'}</strong></div>
      </div>
      <label className="field-stack">Billing disposition<select data-dialog-autofocus disabled={mutation.isPending} onChange={(event) => { setDisposition(event.target.value as BillingSelection); mutation.reset() }} required value={disposition}><option disabled value="">Choose a billing disposition</option>{reviewedDispositions.map((value) => <option key={value} value={value}>{vacancyPatrolDispositionLabel(value)}</option>)}</select></label>
      <label className="field-stack">Billing reference{disposition === 'bill_separately' ? ' (required)' : ' (optional)'}<input disabled={mutation.isPending} maxLength={120} minLength={disposition === 'bill_separately' ? 3 : undefined} onChange={(event) => { setReference(event.target.value); mutation.reset() }} placeholder="Invoice, work order, or approved billing reference" required={disposition === 'bill_separately'} value={reference} /><small>A separately billed recovery requires a unique reference so the same service cannot be billed twice.</small></label>
      <label className="field-stack">Decision reason<textarea disabled={mutation.isPending} maxLength={1000} minLength={5} onChange={(event) => { setReason(event.target.value); mutation.reset() }} placeholder="Explain why this is the correct treatment under the client agreement." required rows={4} value={reason} /></label>
      <label className="schedule-workflow-confirmation"><input checked={acknowledged} disabled={mutation.isPending} onChange={(event) => { setAcknowledged(event.target.checked); mutation.reset() }} required type="checkbox" /><span>I reviewed the original unfilled shift and reconciled Patrol evidence and understand this action records a billing disposition without creating an invoice.</span></label>
      {mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}
      {row.status !== 'completed' ? <div className="inline-alert" role="alert">Every planned Patrol obligation must be reconciled as completed or missed before Finance can record the final billing disposition.</div> : null}
      <div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending || row.status !== 'completed' || !disposition || reason.trim().length < 5 || !acknowledged || (disposition === 'bill_separately' && reference.trim().length < 3)} type="submit">{mutation.isPending ? 'Recording...' : 'Record billing decision'}</button></div>
    </form>
  </ModalDialog>
}

function RecoveryDetailDialog({ onClose, onReview, row }: { onClose: () => void, onReview: () => void, row: VacancyPatrolFinanceRow }) {
  return <ModalDialog className="reports-detail-modal" description="Read-only linked evidence from Schedule, Patrol, and Finance." onClose={onClose} title={`${row.requestNumber} · ${row.clientName ?? row.siteName ?? 'Vacancy recovery'}`}>
    <div className="reports-detail-grid">
      <div><span>Service date</span><strong>{row.serviceDate}</strong></div>
      <div><span>Original shift</span><strong>{formatDateTime(row.startsAt, row.timeZone)}–{formatDateTime(row.endsAt, row.timeZone)}</strong></div>
      <div><span>Original hours</span><strong>{row.originalShiftHours.toFixed(2)}</strong></div>
      <div><span>Client</span><strong>{row.clientName ?? 'Not linked'}</strong></div>
      <div><span>Site / post</span><strong>{locationLabel(row)}</strong></div>
      <div><span>Recovery status</span><strong>{vacancyPatrolStatusLabel(row.status)}</strong></div>
      <div><span>Patrol hits</span><strong>{row.completedHits} completed · {row.missedHits} missed · {row.remainingHits} remaining</strong></div>
      <div><span>Patrol route</span><strong>{row.acceptedRouteName ?? row.requestedRouteName ?? 'Pending'}</strong></div>
      <div><span>Assigned employee</span><strong>{row.assignedEmployeeName ?? 'Pending'}{row.assignedEmployeeNumber ? ` · ${row.assignedEmployeeNumber}` : ''}</strong></div>
      <div><span>Requested by</span><strong>{row.requestedByName}<br />{formatDateTime(row.requestedAt, row.timeZone)}</strong></div>
      <div><span>Accepted by</span><strong>{row.acceptedByName ?? 'Pending'}{row.acceptedAt ? <><br />{formatDateTime(row.acceptedAt, row.timeZone)}</> : null}</strong></div>
      <div><span>Patrol service closed</span><strong>{formatDateTime(row.completedAt, row.timeZone)}</strong></div>
      <div><span>Finance review</span><strong>{vacancyPatrolDispositionLabel(row.billingDisposition)}{row.reviewedByName ? <><br />{row.reviewedByName}</> : null}{row.reviewedAt ? <><br />{formatDateTime(row.reviewedAt, row.timeZone)}</> : null}</strong></div>
      <div><span>Billing reference</span><strong>{row.billingReference ?? 'Not recorded'}</strong></div>
      <div><span>Billing reason</span><strong>{row.billingReason ?? 'Not reviewed'}</strong></div>
    </div>
    <div className="modal-actions">{row.canReview && row.status === 'completed' ? <button className="primary-action" onClick={onReview} type="button">{row.billingDisposition === 'pending_review' ? 'Review billing' : 'Update decision'}</button> : null}<button className="secondary-button" onClick={onClose} type="button">Close</button></div>
  </ModalDialog>
}

export function VacancyPatrolFinanceReportWorkspace({ from, onRangeChange, through }: {
  from: string
  onRangeChange: (from: string, through: string) => void
  through: string
}) {
  const [search, setSearch] = useState('')
  const [disposition, setDisposition] = useState<VacancyPatrolBillingDisposition | 'all'>('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(10)
  const [selected, setSelected] = useState<VacancyPatrolFinanceRow | null>(null)
  const [reviewing, setReviewing] = useState<VacancyPatrolFinanceRow | null>(null)
  const [downloaded, setDownloaded] = useState('')
  const valid = Boolean(from && through && through >= from && (Date.parse(through) - Date.parse(from)) / 86_400_000 <= 366)
  const query = useQuery({
    enabled: valid,
    queryFn: () => getVacancyPatrolFinanceReport({ billingDisposition: disposition, from, through }),
    queryKey: ['vacancy-patrol-finance-report', from, through, disposition],
  })
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (query.data?.rows ?? []).filter((row) => {
      if (status !== 'all' && row.status !== status) return false
      return !term || `${row.requestNumber} ${row.clientName ?? ''} ${row.siteName ?? ''} ${row.postName ?? ''} ${row.requestedByName} ${row.assignedEmployeeName ?? ''} ${row.billingReference ?? ''}`.toLowerCase().includes(term)
    })
  }, [query.data?.rows, search, status])
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const activePage = Math.min(page, pages)
  const visibleRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize)

  useEffect(() => { if (page > pages) setPage(pages) }, [page, pages])
  useEffect(() => { setDownloaded('') }, [disposition, from, search, status, through])

  const exportMutation = useMutation({
    mutationFn: async (format: 'csv' | 'xlsx' | 'pdf') => {
      if (!query.data) throw new Error('The Finance report is still loading.')
      await authorizeVacancyPatrolFinanceExport({ format, from, through })
      const report = { ...query.data, rows }
      if (format === 'csv') return downloadVacancyPatrolFinanceCsv(report)
      if (format === 'xlsx') return downloadVacancyPatrolFinanceXlsx(report)
      return downloadVacancyPatrolFinancePdf(report)
    },
    onSuccess: (name) => setDownloaded(name),
  })

  const summary = query.data?.summary
  return <>
    <section className="operations-panel reports-workspace-heading">
      <Link className="secondary-button reports-back" to={`/reports?from=${from}&through=${through}`}>Back to report library</Link>
      <div><p className="eyebrow">Protected Finance reporting</p><h1>Vacancy Patrol Coverage & Billing</h1><p>Reconcile regular schedule vacancies replaced by Patrol service while keeping the original shift, documented hit outcomes, and billing decision linked without double billing.</p></div>
    </section>

    <section className="operations-panel reports-workspace-controls" aria-label="Vacancy Patrol Finance report controls">
      <div className="reports-range"><label><span>From</span><input max={through} onChange={(event) => { setPage(1); onRangeChange(event.target.value, through) }} type="date" value={from} /></label><label><span>Through</span><input min={from} onChange={(event) => { setPage(1); onRangeChange(from, event.target.value) }} type="date" value={through} /></label></div>
      <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Request, client, site, employee, or billing reference" type="search" value={search} /></span></label>
      <div className="reports-filter-row"><label><span>Billing disposition</span><select onChange={(event) => { setDisposition(event.target.value as VacancyPatrolBillingDisposition | 'all'); setPage(1) }} value={disposition}><option value="all">All billing dispositions</option><option value="pending_review">Pending Finance review</option>{reviewedDispositions.map((value) => <option key={value} value={value}>{vacancyPatrolDispositionLabel(value)}</option>)}</select></label><label><span>Recovery status</span><select onChange={(event) => { setStatus(event.target.value); setPage(1) }} value={status}><option value="all">All recovery statuses</option><option value="requested">Requested</option><option value="patrol_planned">Patrol planned</option><option value="in_progress">In progress</option><option value="completed">Reconciled</option><option value="declined">Declined</option><option value="canceled">Canceled</option></select></label><label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as (typeof pageSizes)[number]); setPage(1) }} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label></div>
      <div className="schedule-workflow-note"><ShieldCheck aria-hidden="true" size={20} /><p>Finance records the contractual billing disposition here. SygShift deliberately does not create an invoice or bill both the original static shift and substitute Patrol hits automatically.</p></div>
      {!valid ? <div className="inline-alert" role="alert">Choose a valid date range of 366 days or fewer.</div> : null}
    </section>

    {summary ? <section className="reports-patrol-summary" aria-label="Vacancy Patrol Finance totals"><article><span>Requests</span><strong>{summary.totalRequests}</strong><small>In date range</small></article><article className={summary.awaitingCompletion ? 'reports-patrol-danger' : ''}><span>Awaiting completion</span><strong>{summary.awaitingCompletion}</strong><small>Patrol work open</small></article><article className={summary.pendingReview ? 'reports-patrol-danger' : ''}><span>Finance pending</span><strong>{summary.pendingReview}</strong><small>Ready for review</small></article><article><span>Bill separately</span><strong>{summary.billSeparately}</strong><small>Reference required</small></article><article><span>Included</span><strong>{summary.includedInContract}</strong><small>Contract service</small></article><article><span>Non-billable</span><strong>{summary.nonBillable}</strong><small>No separate charge</small></article><article><span>Duplicates stopped</span><strong>{summary.duplicateSuppressed}</strong><small>Protected from rebill</small></article></section> : null}

    <section className="operations-panel reports-results reports-patrol-result" aria-busy={query.isFetching}>
      <div className="reports-section-heading"><div><p className="eyebrow">Linked service recovery</p><h2>{query.isSuccess ? `${rows.length} matching record${rows.length === 1 ? '' : 's'}` : 'Vacancy recovery results'}</h2><p>Each row retains the original unfilled shift and the Patrol service actually delivered.</p></div><div className="short-notice-export-actions"><button className="secondary-button" disabled={!query.data?.permissions.canExport || exportMutation.isPending || !rows.length} onClick={() => exportMutation.mutate('csv')} type="button"><Download aria-hidden="true" size={17} />CSV</button><button className="primary-action" disabled={!query.data?.permissions.canExport || exportMutation.isPending || !rows.length} onClick={() => exportMutation.mutate('xlsx')} type="button"><Download aria-hidden="true" size={17} />Excel</button><button className="secondary-button" disabled={!query.data?.permissions.canExport || exportMutation.isPending || !rows.length} onClick={() => exportMutation.mutate('pdf')} type="button"><FileText aria-hidden="true" size={17} />PDF</button></div></div>
      {query.isPending ? <div className="report-empty">Loading linked Schedule, Patrol, and Finance evidence…</div> : null}
      {query.isError ? <DataStatePanel icon={ShieldAlert} title="Vacancy Patrol Finance report unavailable" tone="error"><p>{query.error.message}</p></DataStatePanel> : null}
      {query.isSuccess && !rows.length ? <div className="report-empty">No vacancy Patrol recoveries match this range and these filters.</div> : null}
      {query.data && !query.data.permissions.canExport ? <div className="reports-export-note">Finance export permission is required to download these protected records.</div> : null}
      {downloaded ? <div className="form-feedback form-feedback--success" role="status">Downloaded {downloaded}.</div> : null}
      {exportMutation.isError ? <div className="inline-alert" role="alert">{exportMutation.error.message}</div> : null}
      {visibleRows.length ? <div className="reports-result-list">{visibleRows.map((row) => {
        const needsReview = row.canReview && row.status === 'completed' && row.billingDisposition === 'pending_review'
        return <article className="reports-result-card" key={row.requestId}><dl className="reports-result-summary"><div><dt>Service date</dt><dd>{row.serviceDate}<small>{row.requestNumber}</small></dd></div><div><dt>Client / site</dt><dd>{row.clientName ?? 'Not linked'}<small>{locationLabel(row)}</small></dd></div><div><dt>Original shift</dt><dd>{formatDateTime(row.startsAt, row.timeZone)}<small>{row.originalShiftHours.toFixed(2)} scheduled hours</small></dd></div><div><dt>Patrol delivery</dt><dd>{row.completedHits} completed<small>{row.missedHits} missed · {row.remainingHits} remaining</small></dd></div><div><dt>Billing</dt><dd>{vacancyPatrolDispositionLabel(row.billingDisposition)}<small>{row.billingReference ?? 'No reference'}</small></dd></div></dl><button className={`${needsReview ? 'primary-action' : 'secondary-button'} reports-report-card__action`} onClick={() => needsReview ? setReviewing(row) : setSelected(row)} type="button">{needsReview ? 'Review billing' : 'View details'}</button></article>
      })}</div> : null}
      {rows.length > pageSize ? <nav className="reports-pagination" aria-label="Vacancy Patrol report pages"><button className="secondary-button" disabled={activePage <= 1} onClick={() => setPage(activePage - 1)} type="button">Previous</button><span>Page {activePage} of {pages}</span><button className="secondary-button" disabled={activePage >= pages} onClick={() => setPage(activePage + 1)} type="button">Next</button></nav> : null}
    </section>
    {selected ? <RecoveryDetailDialog onClose={() => setSelected(null)} onReview={() => { setReviewing(selected); setSelected(null) }} row={selected} /> : null}
    {reviewing ? <BillingReviewDialog onClose={() => setReviewing(null)} row={reviewing} /> : null}
  </>
}

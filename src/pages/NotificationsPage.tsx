import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCircle2, DatabaseZap, MailCheck, RefreshCw, Search, ShieldAlert, TriangleAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getNotificationCenter, processNotificationBatch, retryAllFailedNotifications, retryNotificationJob, type NotificationCenter } from '../data/operations'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'

type DeliveryStatus = 'all' | 'queued' | 'delivered' | 'failed'
const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const statusClass = (status: string) => status === 'delivered' ? 'status-badge status-badge--active' : status === 'failed' ? 'status-badge status-badge--separated' : 'status-badge status-badge--leave'

function JobDetails({ batch, onClose, onRetry, retrying }: { batch: NotificationCenter['batches'][number], onClose: () => void, onRetry: () => void, retrying: boolean }) {
  return <ModalDialog className="communications-modal communications-modal--details" onClose={onClose} title="Notification delivery details">
    <div className="communications-detail-grid">
      <article><span>Subject</span><strong>{batch.subject}</strong></article><article><span>Status</span><strong className={statusClass(batch.status)}>{titleCase(batch.status)}</strong></article>
      <article><span>Recipients</span><strong>{batch.recipientCount}</strong></article><article><span>Attempts</span><strong>{batch.attemptCount}</strong></article>
      <article><span>Queued</span><strong>{formatOperationalDateTime(batch.createdAt, { includeTimeZoneName: true })}</strong></article><article><span>Channel</span><strong>{batch.channels.join(', ')}</strong></article>
    </div>
    {batch.lastError ? <div className="inline-alert" role="alert"><TriangleAlert size={18} />{batch.lastError}</div> : null}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close</button>{batch.status === 'failed' ? <button className="primary-action" disabled={retrying} onClick={onRetry} type="button"><RefreshCw size={18} />{retrying ? 'Retrying…' : 'Retry this job'}</button> : null}</div>
  </ModalDialog>
}

export function NotificationsPage() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<DeliveryStatus>('all'); const [search, setSearch] = useState(''); const [dateFrom, setDateFrom] = useState(''); const [dateThrough, setDateThrough] = useState('')
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState<5 | 10 | 20>(10); const [selected, setSelected] = useState<NotificationCenter['batches'][number] | null>(null)
  const queryInput = useMemo(() => ({ dateFrom: dateFrom || null, dateThrough: dateThrough || null, page, pageSize, search, status }), [dateFrom, dateThrough, page, pageSize, search, status])
  const notificationQuery = useQuery({ queryKey: ['notification-center', queryInput], queryFn: () => getNotificationCenter(queryInput), enabled: isSupabaseConfigured })
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['notification-center'] })
  const processMutation = useMutation({ mutationFn: processNotificationBatch, onSuccess: refresh }); const retryMutation = useMutation({ mutationFn: retryNotificationJob, onSuccess: async () => { setSelected(null); await refresh() } }); const retryAllMutation = useMutation({ mutationFn: retryAllFailedNotifications, onSuccess: refresh })
  const data = notificationQuery.data; const canManageNotifications = data?.permissions.canManage ?? false; const updateFilter = (callback: () => void) => { callback(); setPage(1) }
  return <div className="page page--notifications communications-workspace">
    <section className="page-intro communications-hero"><div><p className="eyebrow">Communication Operations</p><h1>Notifications</h1><p className="page-summary">Monitor message delivery by job, resolve failures, and keep recipient-level noise out of the main workspace.</p></div><div className="communications-hero__actions">
      {canManageNotifications && data && data.summary.failed > 0 ? <button className="secondary-button" disabled={retryAllMutation.isPending} onClick={() => retryAllMutation.mutate()} type="button"><RefreshCw size={18} />{retryAllMutation.isPending ? 'Retrying…' : 'Retry failed'}</button> : null}
      {canManageNotifications ? <button className="primary-action" disabled={processMutation.isPending || !data?.summary.pending} onClick={() => processMutation.mutate()} type="button"><MailCheck size={19} />{processMutation.isPending ? 'Processing…' : 'Process queued'}</button> : null}
    </div></section>
    {!isSupabaseConfigured ? <DataStatePanel icon={DatabaseZap} title="Notification delivery needs the secure connection" tone="setup"><p>Connect the protected data service before working delivery jobs.</p></DataStatePanel> : notificationQuery.isPending ? <DataStatePanel icon={Bell} title="Loading notification operations"><p>Checking grouped delivery jobs.</p></DataStatePanel> : notificationQuery.isError ? <DataStatePanel icon={ShieldAlert} title="Notifications unavailable" tone="error"><p>{notificationQuery.error.message}</p></DataStatePanel> : data ? <>
      <section className="communications-summary" aria-label="Notification job totals"><article className={data.summary.pending ? 'communications-summary--attention' : ''}><span>Queued</span><strong>{data.summary.pending}</strong><small>Jobs ready to process</small></article><article><span>Delivered</span><strong>{data.summary.delivered}</strong><small>Completed deliveries</small></article><article className={data.summary.failed ? 'communications-summary--danger' : ''}><span>Failed</span><strong>{data.summary.failed}</strong><small>Jobs requiring review</small></article></section>
      {processMutation.isSuccess ? <div className="inline-success" role="status"><CheckCircle2 size={18} />Processed {processMutation.data.processed} queued message{processMutation.data.processed === 1 ? '' : 's'}.</div> : null}{processMutation.isError ? <div className="inline-alert" role="alert">{processMutation.error.message}</div> : null}{retryAllMutation.isError ? <div className="inline-alert" role="alert">{retryAllMutation.error.message}</div> : null}
      <section className="operations-panel communications-panel"><div className="section-heading"><div><p className="eyebrow">Delivery Jobs</p><h2>Notification history</h2><p>One row represents one message batch—not one recipient.</p></div><button className="secondary-button" onClick={() => notificationQuery.refetch()} type="button"><RefreshCw size={18} />Refresh</button></div>
        <div className="communications-filters"><label className="communications-search"><span>Search</span><div><Search size={18} /><input onChange={(event) => updateFilter(() => setSearch(event.target.value))} placeholder="Subject or message type" value={search} /></div></label><label><span>Status</span><select onChange={(event) => updateFilter(() => setStatus(event.target.value as DeliveryStatus))} value={status}><option value="all">All statuses</option><option value="queued">Queued</option><option value="delivered">Delivered</option><option value="failed">Failed</option></select></label><label><span>From</span><input onChange={(event) => updateFilter(() => setDateFrom(event.target.value))} type="date" value={dateFrom} /></label><label><span>Through</span><input onChange={(event) => updateFilter(() => setDateThrough(event.target.value))} type="date" value={dateThrough} /></label></div>
        {data.batches.length === 0 ? <DataStatePanel icon={Bell} title="No delivery jobs match these filters"><p>Change the filters or create a new announcement.</p></DataStatePanel> : <div className="communications-list">{data.batches.map((batch) => <article className="communications-list__row" key={batch.id}><div><strong>{batch.subject}</strong><span>{titleCase(batch.messageType)} · {formatOperationalDateTime(batch.createdAt, { includeTimeZoneName: true })}</span></div><div><span>Recipients</span><strong>{batch.recipientCount}</strong></div><div><span>Channel</span><strong>{batch.channels.join(', ')}</strong></div><span className={statusClass(batch.status)}>{titleCase(batch.status)}</span><button className="secondary-button" onClick={() => setSelected(batch)} type="button">View details</button></article>)}</div>}
        <div className="communications-pagination"><span>Page {data.page.number} of {data.page.totalPages} · {data.page.total} jobs</span><label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as 5 | 10 | 20); setPage(1) }} value={pageSize}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label><button className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">Previous</button><button className="secondary-button" disabled={page >= data.page.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div>
      </section></> : null}
    {selected ? <JobDetails batch={selected} onClose={() => setSelected(null)} onRetry={() => retryMutation.mutate(selected.id)} retrying={retryMutation.isPending} /> : null}
  </div>
}

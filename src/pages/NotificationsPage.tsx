import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCircle2, DatabaseZap, MailCheck, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getNotificationCenter, processNotificationBatch } from '../data/operations'
import { isSupabaseConfigured } from '../lib/supabase'

function messageTypeLabel(value: string): string {
  return value.replaceAll('_', ' ')
}

function deliveryStatus(item: {
  deliveredAt: string | null
  failedAt: string | null
}): { className: string; label: string } {
  if (item.deliveredAt) return { className: 'status-badge status-badge--active', label: 'Delivered' }
  if (item.failedAt) return { className: 'status-badge status-badge--separated', label: 'Failed' }
  return { className: 'status-badge status-badge--leave', label: 'Queued' }
}

export function NotificationsPage() {
  const queryClient = useQueryClient()
  const notificationQuery = useQuery({
    queryKey: ['notification-center'],
    queryFn: getNotificationCenter,
    enabled: isSupabaseConfigured,
  })
  const processMutation = useMutation({
    mutationFn: processNotificationBatch,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notification-center'] })
    },
  })

  return (
    <div className="page page--notifications">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Communication</p>
          <h1>Notifications</h1>
          <p className="page-summary">
            Track queued, delivered, and failed operational emails for call-offs, announcements,
            overtime, open shifts, and schedule coordination.
          </p>
        </div>
        <button
          className="primary-action"
          disabled={processMutation.isPending || !notificationQuery.data?.summary.pending}
          onClick={() => processMutation.mutate()}
          type="button"
        >
          <MailCheck aria-hidden="true" size={19} />
          {processMutation.isPending ? 'Sending queued emails…' : 'Process queued emails'}
        </button>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Notification delivery needs the secure connection" tone="setup">
          <p>Queued email status appears after Supabase and Cloudflare Email Sending are connected.</p>
        </DataStatePanel>
      ) : notificationQuery.isPending ? (
        <DataStatePanel icon={Bell} title="Loading notification center">
          <p>Checking queued and delivered operational messages.</p>
        </DataStatePanel>
      ) : notificationQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Notifications unavailable" tone="error">
          <p>{notificationQuery.error.message}</p>
          <p>Supervisor or Admin access is required.</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="operations-metrics" aria-label="Notification totals">
            <article className={notificationQuery.data.summary.pending ? 'import-metric--attention' : ''}>
              <span>Queued</span>
              <strong>{notificationQuery.data.summary.pending}</strong>
              <small>Ready to send</small>
            </article>
            <article>
              <span>Delivered</span>
              <strong>{notificationQuery.data.summary.delivered}</strong>
              <small>Marked sent</small>
            </article>
            <article className={notificationQuery.data.summary.failed ? 'import-metric--attention' : ''}>
              <span>Failed</span>
              <strong>{notificationQuery.data.summary.failed}</strong>
              <small>Needs review</small>
            </article>
          </section>

          {processMutation.isSuccess ? (
            <div className="inline-success" role="status">
              <CheckCircle2 aria-hidden="true" size={18} />
              Processed {processMutation.data.processed} queued message{processMutation.data.processed === 1 ? '' : 's'}.
            </div>
          ) : null}
          {processMutation.isError ? <div className="inline-alert" role="alert">{processMutation.error.message}</div> : null}

          <section className="operations-panel" aria-labelledby="notification-history-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Delivery history</p>
                <h2 id="notification-history-title">Recent notification jobs</h2>
              </div>
              <button className="secondary-button" onClick={() => notificationQuery.refetch()} type="button">
                <RefreshCw aria-hidden="true" size={18} /> Refresh
              </button>
            </div>
            {notificationQuery.data.recent.length === 0 ? (
              <DataStatePanel icon={Bell} title="No notifications have been queued yet">
                <p>Announcements and call-off alerts will appear here after they are created.</p>
              </DataStatePanel>
            ) : (
              <div className="operations-list">
                {notificationQuery.data.recent.map((item) => {
                  const status = deliveryStatus(item)
                  return (
                    <article key={item.id}>
                      <TriangleAlert aria-hidden="true" size={20} />
                      <div>
                        <strong>{messageTypeLabel(item.messageType)}</strong>
                        <span>{item.aggregateType} · attempts {item.attemptCount} · queued {new Date(item.createdAt).toLocaleString()}</span>
                        {item.lastError ? <small>{item.lastError}</small> : null}
                      </div>
                      <span className={status.className}>{status.label}</span>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

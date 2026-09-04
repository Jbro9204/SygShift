import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { HrPagination } from '../components/HrPagination'
import { getSessionContext } from '../data/auth'
import {
  getHrStage10Workspace,
  type HrStage10PageSize,
} from '../data/hrStage10'
import { isSupabaseConfigured } from '../lib/supabase'

function formatDate(value: string | null): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`))
}

export function HrisPayrollIntegrationPage() {
  const [pageSize, setPageSize] = useState<HrStage10PageSize>(10)
  const [offset, setOffset] = useState(0)
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const hasPermission = sessionQuery.data?.permissions.includes('hr.payroll_integration.view') === true
  const workspaceQuery = useQuery({
    queryKey: ['hr-stage10-payroll-integration', pageSize, offset],
    queryFn: () => getHrStage10Workspace(pageSize, offset),
    enabled: Boolean(isSupabaseConfigured && !sessionQuery.isPending && hasPermission),
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Payroll integration needs the secure connection" tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (sessionQuery.isPending) return <DataStatePanel icon={ShieldCheck} title="Checking payroll integration access"><p>Verifying your exact permission.</p></DataStatePanel>
  if (sessionQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Payroll integration access unavailable" tone="error"><p>{sessionQuery.error.message}</p></DataStatePanel>
  if (!hasPermission) return <DataStatePanel icon={AlertTriangle} title="Payroll integration access is not assigned" tone="error"><p>An authorized administrator must assign the exact payroll-integration permission.</p></DataStatePanel>

  const workspace = workspaceQuery.data
  const gates = workspace ? [
    ['Integration', workspace.gates.integration.enabled],
    ['Webhooks', workspace.gates.webhooks.enabled],
    ['Enterprise cutover', workspace.gates.cutover.enabled],
  ] as const : []

  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>Payroll Integration</h1><p className="page-summary">Govern versioned HR-to-Payroll contracts, approval evidence, locked-snapshot reconciliation, and controlled release readiness.</p></div>
      </section>

      {workspaceQuery.isPending ? <DataStatePanel icon={ShieldCheck} title="Loading payroll integration controls"><p>Checking the protected control plane.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} title="Payroll integration controls unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : null}
      {workspace && !workspace.enabled ? <DataStatePanel icon={CheckCircle2} title="Payroll integration is safely staged"><p>SygShift Payroll remains authoritative. No HR change can affect pay, unlock a batch, publish an event, call a webhook, or start cutover.</p><p>Current employee access, schedules, punches, payroll calculations, and locked exports remain unchanged.</p></DataStatePanel> : null}

      {workspace?.enabled ? <>
        <section className="page-section-heading"><div><p className="eyebrow">Protected control plane</p><h2>Integration readiness</h2><p>{workspace.authority} Changes require documented approval, recent MFA, reconciliation, and an explicit release gate.</p></div><button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button></section>
        <section aria-label="Payroll integration status" className="hr-automation-summary hr-automation-summary--three">
          <article><ShieldCheck aria-hidden="true" size={20} /><span>Contract</span><strong>{workspace.contract?.version ?? 'Not approved'}</strong></article>
          <article><ShieldCheck aria-hidden="true" size={20} /><span>Pending approvals</span><strong>{workspace.counts.pendingApprovals}</strong></article>
          <article><ShieldCheck aria-hidden="true" size={20} /><span>Reconciliation differences</span><strong>{workspace.counts.differences}</strong></article>
        </section>
        <section className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Release controls</p><h2>All authority remains explicit</h2></div></div>
          <div className="hr-automation-list">{gates.map(([label, enabled]) => <article key={label}><div><strong>{label}</strong><span>{enabled ? 'Explicitly enabled' : 'Off by default'}</span></div><div><span className="action-status">{enabled ? 'Enabled' : 'Protected'}</span></div></article>)}</div>
        </section>
        <section className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Change proposals</p><h2>Current governed work</h2></div></div>
          {workspace.items.length ? <div className="hr-automation-list">{workspace.items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.subtitle}{item.detail ? ` · ${item.detail}` : ''}</span></div><div><span className="action-status">{item.status}</span>{formatDate(item.dateLabel) ? <small>{formatDate(item.dateLabel)}</small> : null}</div></article>)}</div> : <div className="compact-empty"><ShieldCheck aria-hidden="true" size={24} /><span>No payroll-impacting HR changes are awaiting review.</span></div>}
        </section>
        <HrPagination itemCount={workspace.items.length} label="Payroll integration records" offset={offset} onOffsetChange={setOffset} onPageSizeChange={setPageSize} pageSize={pageSize} />
      </> : null}
    </div>
  )
}

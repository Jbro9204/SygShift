import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ListChecks, RefreshCw, Workflow } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getHrAutomationWorkspace } from '../data/hrAutomation'
import { isSupabaseConfigured } from '../lib/supabase'

function formatDateTime(value: string | null): string {
  if (!value) return 'Not set'
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value))
}

export function HrisAutomationPage() {
  const [pageSize, setPageSize] = useState<5 | 10 | 20>(10)
  const [offset, setOffset] = useState(0)
  const workspaceQuery = useQuery({
    queryKey: ['hr-automation-workspace', pageSize, offset],
    queryFn: () => getHrAutomationWorkspace(pageSize, offset),
    enabled: isSupabaseConfigured,
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Automation needs the secure connection" tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (workspaceQuery.isPending) return <DataStatePanel icon={Workflow} title="Loading HR automation"><p>Checking workflow and action status.</p></DataStatePanel>
  if (workspaceQuery.isError) return <DataStatePanel icon={AlertTriangle} title="HR automation unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel>

  const workspace = workspaceQuery.data
  if (!workspace.enabled) {
    return (
      <div className="page page--hr-automation">
        <section className="page-intro workforce-intro"><div><p className="eyebrow">HR &amp; Finance</p><h1>Automation</h1><p className="page-summary">The protected workflow foundation is installed and remains inactive until its controlled release is approved.</p></div></section>
        <DataStatePanel icon={CheckCircle2} title="Automation is safely staged"><p>No workflow can start, send a notification, or assign an action while both release gates are off.</p></DataStatePanel>
      </div>
    )
  }

  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>Automation</h1><p className="page-summary">Monitor controlled HR workflows, employee actions, and failed jobs without exposing protected system data.</p></div>
        <button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button>
      </section>
      <section className="hr-automation-summary" aria-label="Automation status">
        <article><Workflow aria-hidden="true" size={20} /><span>Definitions</span><strong>{workspace.counts.definitions}</strong></article>
        <article><RefreshCw aria-hidden="true" size={20} /><span>Active workflows</span><strong>{workspace.counts.activeInstances}</strong></article>
        <article><ListChecks aria-hidden="true" size={20} /><span>Open actions</span><strong>{workspace.counts.openTasks}</strong></article>
        <article className={workspace.counts.deadLetters ? 'is-alert' : ''}><AlertTriangle aria-hidden="true" size={20} /><span>Needs intervention</span><strong>{workspace.counts.deadLetters}</strong></article>
      </section>
      <section className="panel hr-automation-worklist">
        <div className="section-heading">
          <div><p className="eyebrow">Current work</p><h2>Employee actions</h2><p>Only the selected number of items is shown.</p></div>
          <label className="compact-page-size"><span>Show</span><select onChange={(event) => { setPageSize(Number(event.target.value) as 5 | 10 | 20); setOffset(0) }} value={pageSize}><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
        </div>
        {workspace.tasks.length ? <div className="hr-automation-list">{workspace.tasks.map((task) => <article key={task.id}><div><strong>{task.title}</strong><span>{task.assignedName ?? task.requiredPermission ?? 'Unassigned'}</span></div><div><span className={`action-status action-status--${task.status}`}>{task.status}</span><small>Due {formatDateTime(task.dueAt)}</small></div></article>)}</div> : <div className="compact-empty"><CheckCircle2 aria-hidden="true" size={24} /><span>No employee actions need attention.</span></div>}
        <div className="compact-pagination"><button className="secondary-button secondary-button--small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} type="button">Previous</button><span>Items {workspace.tasks.length ? offset + 1 : 0}–{offset + workspace.tasks.length}</span><button className="secondary-button secondary-button--small" disabled={workspace.tasks.length < pageSize} onClick={() => setOffset(offset + pageSize)} type="button">Next</button></div>
      </section>
    </div>
  )
}

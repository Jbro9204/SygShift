import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ClipboardCheck, RefreshCw, UserRoundCheck } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getHrOnboardingCase, getHrOnboardingWorkspace } from '../data/hrOnboarding'
import { isSupabaseConfigured } from '../lib/supabase'

type PageSize = 5 | 10 | 20

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
}

export function HrisOnboardingPage() {
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const [offset, setOffset] = useState(0)
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const workspaceQuery = useQuery({ queryKey: ['hr-onboarding-workspace', pageSize, offset], queryFn: () => getHrOnboardingWorkspace(pageSize, offset), enabled: isSupabaseConfigured })
  const caseQuery = useQuery({ queryKey: ['hr-onboarding-case', selectedCaseId], queryFn: () => getHrOnboardingCase(selectedCaseId!), enabled: Boolean(selectedCaseId) })

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Onboarding needs the secure connection" tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (workspaceQuery.isPending) return <DataStatePanel icon={ClipboardCheck} title="Loading onboarding"><p>Checking employee readiness and assigned work.</p></DataStatePanel>
  if (workspaceQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Onboarding unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel>

  const workspace = workspaceQuery.data
  if (!workspace.enabled) {
    return (
      <div className="page page--hr-automation">
        <section className="page-intro workforce-intro"><div><p className="eyebrow">HR &amp; Finance</p><h1>Onboarding</h1><p className="page-summary">The protected onboarding foundation is installed and remains inactive until its controlled release is approved.</p></div></section>
        <DataStatePanel icon={CheckCircle2} title="Onboarding is safely staged"><p>No onboarding case, task, reminder, employee activation, or downstream assignment can change while the release gate is off.</p></DataStatePanel>
      </div>
    )
  }

  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>Onboarding</h1><p className="page-summary">Coordinate employee readiness across identity, licensing, training, equipment, documents, and site access.</p></div>
        <button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button>
      </section>
      <section className="hr-automation-summary hr-automation-summary--three" aria-label="Onboarding status">
        <article><UserRoundCheck aria-hidden="true" size={20} /><span>Active cases</span><strong>{workspace.counts.activeCases}</strong></article>
        <article><CheckCircle2 aria-hidden="true" size={20} /><span>Ready to finalize</span><strong>{workspace.counts.readyCases}</strong></article>
        <article className={workspace.counts.overdueTasks ? 'is-alert' : ''}><AlertTriangle aria-hidden="true" size={20} /><span>Overdue tasks</span><strong>{workspace.counts.overdueTasks}</strong></article>
      </section>
      <section className="hr-stage-grid">
        <article className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Employee readiness</p><h2>Onboarding cases</h2></div></div>
          {workspace.cases.length ? <div className="hr-automation-list">{workspace.cases.map((item) => <article key={item.id}><div><strong>{item.employeeName}</strong><span>{item.employeeNumber} · starts {formatDate(item.targetStartDate)} · {item.templateName}</span></div><div><span className="action-status">{item.status}</span><small>{item.taskCounts.complete}/{item.taskCounts.total} complete · {item.taskCounts.overdue} overdue</small><button className="text-button" onClick={() => setSelectedCaseId(item.id)} type="button">Review case</button></div></article>)}</div> : <div className="compact-empty"><UserRoundCheck aria-hidden="true" size={24} /><span>No onboarding cases are in this view.</span></div>}
        </article>
        <article className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Controlled setup</p><h2>Templates</h2></div></div>
          {workspace.templates.length ? <div className="hr-automation-list">{workspace.templates.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>Version {item.version}</span></div><div><span className="action-status">{item.status}</span></div></article>)}</div> : <div className="compact-empty"><ClipboardCheck aria-hidden="true" size={24} /><span>No onboarding templates are available.</span></div>}
        </article>
      </section>
      {selectedCaseId ? <section className="panel hr-onboarding-detail" aria-live="polite"><div className="section-heading"><div><p className="eyebrow">Selected case</p><h2>{caseQuery.data?.case.employeeName ?? 'Loading employee'}</h2></div><button className="secondary-button secondary-button--small" onClick={() => setSelectedCaseId(null)} type="button">Close</button></div>{caseQuery.isPending ? <p>Loading case details…</p> : caseQuery.isError ? <DataStatePanel icon={AlertTriangle} title="Case details unavailable" tone="error"><p>{caseQuery.error.message}</p></DataStatePanel> : <div className="hr-onboarding-task-list">{caseQuery.data?.tasks.map((task) => <article key={task.id}><div><strong>{task.title}</strong><span>{task.responsibleGroup} · {task.required ? 'Required' : 'Optional'}</span></div><span className="action-status">{task.status}</span></article>)}</div>}</section> : null}
      <div className="compact-pagination panel"><button className="secondary-button secondary-button--small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} type="button">Previous</button><label className="compact-page-size"><span>Show</span><select onChange={(event) => { setPageSize(Number(event.target.value) as PageSize); setOffset(0) }} value={pageSize}><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label><span>Items {workspace.cases.length ? offset + 1 : 0}–{offset + workspace.cases.length}</span><button className="secondary-button secondary-button--small" disabled={workspace.cases.length < pageSize} onClick={() => setOffset(offset + pageSize)} type="button">Next</button></div>
    </div>
  )
}

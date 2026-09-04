import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, BriefcaseBusiness, CheckCircle2, RefreshCw, UserRoundSearch } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { HrPagination } from '../components/HrPagination'
import { HrRecruitingActions } from '../components/HrRecruitingActions'
import { getHrRecruitingWorkspace } from '../data/hrRecruiting'
import { isSupabaseConfigured } from '../lib/supabase'

type PageSize = 5 | 10 | 20

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value))
}

export function HrisRecruitingPage() {
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const [offset, setOffset] = useState(0)
  const workspaceQuery = useQuery({
    queryKey: ['hr-recruiting-workspace', pageSize, offset],
    queryFn: () => getHrRecruitingWorkspace(pageSize, offset),
    enabled: isSupabaseConfigured,
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Recruiting needs the secure connection" tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (workspaceQuery.isPending) return <DataStatePanel icon={UserRoundSearch} title="Loading recruiting"><p>Checking requisitions and candidate activity.</p></DataStatePanel>
  if (workspaceQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Recruiting unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel>

  const workspace = workspaceQuery.data
  if (!workspace.enabled) {
    return (
      <div className="page page--hr-automation">
        <section className="page-intro workforce-intro"><div><p className="eyebrow">HR &amp; Finance</p><h1>Recruiting</h1><p className="page-summary">The protected recruiting foundation is installed and remains inactive until its controlled release is approved.</p></div></section>
        <DataStatePanel icon={CheckCircle2} title="Recruiting is safely staged"><p>No requisition, candidate, interview, offer, or employee conversion can change while the release gate is off.</p></DataStatePanel>
      </div>
    )
  }

  const shownCount = Math.max(workspace.requisitions.length, workspace.applications.length)
  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>Recruiting</h1><p className="page-summary">Manage approved hiring work from requisition through candidate conversion without re-entering employee identity data.</p></div>
        <div className="hr-operational-heading-actions"><HrRecruitingActions workspace={workspace} onComplete={() => workspaceQuery.refetch()} /><button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button></div>
      </section>
      <section className="hr-automation-summary" aria-label="Recruiting status">
        <article><BriefcaseBusiness aria-hidden="true" size={20} /><span>Open requisitions</span><strong>{workspace.counts.openRequisitions}</strong></article>
        <article><UserRoundSearch aria-hidden="true" size={20} /><span>Active candidates</span><strong>{workspace.counts.activeCandidates}</strong></article>
        <article><UserRoundSearch aria-hidden="true" size={20} /><span>Pending interviews</span><strong>{workspace.counts.pendingInterviews}</strong></article>
        <article><BriefcaseBusiness aria-hidden="true" size={20} /><span>Pending offers</span><strong>{workspace.counts.pendingOffers}</strong></article>
      </section>
      <section className="hr-stage-grid">
        <article className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Hiring plans</p><h2>Requisitions</h2></div></div>
          {workspace.requisitions.length ? <div className="hr-automation-list">{workspace.requisitions.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.number} · {item.employmentType} · {item.headcount} position{item.headcount === 1 ? '' : 's'}</span></div><div><span className="action-status">{item.status}</span><small>Updated {formatDateTime(item.updatedAt)}</small></div></article>)}</div> : <div className="compact-empty"><BriefcaseBusiness aria-hidden="true" size={24} /><span>No requisitions are in this view.</span></div>}
        </article>
        <article className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Candidate pipeline</p><h2>Applicants</h2></div></div>
          {workspace.applications.length ? <div className="hr-automation-list">{workspace.applications.map((item) => <article key={item.id}><div><strong>{item.candidateName}</strong><span>{item.requisitionTitle} · {item.stage}</span></div><div><span className="action-status">{item.status}</span><small>Moved {formatDateTime(item.stageChangedAt)}</small></div></article>)}</div> : <div className="compact-empty"><UserRoundSearch aria-hidden="true" size={24} /><span>No candidates are in this view.</span></div>}
        </article>
      </section>
      <HrPagination itemCount={shownCount} label="Recruiting records" offset={offset} onOffsetChange={setOffset} onPageSizeChange={setPageSize} pageSize={pageSize} />
    </div>
  )
}

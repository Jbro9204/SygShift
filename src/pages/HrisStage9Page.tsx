import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  FileBarChart,
  RefreshCw,
  Repeat2,
  UserRoundCog,
  type LucideIcon,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import {
  getHrStage9Workspace,
  type HrStage9Module,
  type HrStage9PageSize,
} from '../data/hrStage9'
import { isSupabaseConfigured } from '../lib/supabase'

type WorkspaceDefinition = {
  module: HrStage9Module
  permission: string
  title: string
  summary: string
  staged: string
  metrics: readonly [string, string, string]
  empty: string
  icon: LucideIcon
}

const workspaceDefinitions: Record<HrStage9Module, WorkspaceDefinition> = {
  offboarding: {
    module: 'offboarding',
    permission: 'hr.offboarding.view',
    title: 'Employee Lifecycle',
    summary: 'Coordinate separation and rehire decisions while preserving employee, payroll, schedule, licensing, document, training, asset, and access history.',
    staged: 'Separation, rehire, approval, and downstream handoff records remain protected and unchanged.',
    metrics: ['Active cases', 'Pending approvals', 'Open handoffs'],
    empty: 'No employee lifecycle cases are in this view.',
    icon: Repeat2,
  },
  self_service: {
    module: 'self_service',
    permission: 'hr.self_service.view',
    title: 'HR Self-Service',
    summary: 'Review controlled employee and manager requests without allowing direct changes to authoritative HR records.',
    staged: 'Employee and manager HR requests remain protected and unchanged.',
    metrics: ['Open requests', 'My requests', 'Approved requests'],
    empty: 'No HR self-service requests are in this view.',
    icon: UserRoundCog,
  },
  reporting: {
    module: 'reporting',
    permission: 'hr.reporting.view',
    title: 'HR Reporting',
    summary: 'Build permission-filtered reports, queue larger exports, and schedule governed report delivery.',
    staged: 'Report definitions, exports, schedules, and delivery records remain protected and unchanged.',
    metrics: ['Active reports', 'Queued exports', 'Scheduled reports'],
    empty: 'No governed HR reports are in this view.',
    icon: FileBarChart,
  },
}

function formatDate(value: string | null): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`))
}

function Pagination({ itemCount, offset, pageSize, onOffset, onPageSize }: {
  itemCount: number
  offset: number
  pageSize: HrStage9PageSize
  onOffset: (value: number) => void
  onPageSize: (value: HrStage9PageSize) => void
}) {
  return (
    <div className="compact-pagination panel">
      <button className="secondary-button secondary-button--small" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - pageSize))} type="button">Previous</button>
      <label className="compact-page-size"><span>Show</span><select onChange={(event) => onPageSize(Number(event.target.value) as HrStage9PageSize)} value={pageSize}><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
      <span>Items {itemCount ? offset + 1 : 0}–{offset + itemCount}</span>
      <button className="secondary-button secondary-button--small" disabled={itemCount < pageSize} onClick={() => onOffset(offset + pageSize)} type="button">Next</button>
    </div>
  )
}

function Stage9WorkspacePage({ module }: { module: HrStage9Module }) {
  const [pageSize, setPageSize] = useState<HrStage9PageSize>(10)
  const [offset, setOffset] = useState(0)
  const definition = workspaceDefinitions[module]
  const WorkspaceIcon = definition.icon
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const hasPermission = sessionQuery.data?.permissions.includes(definition.permission) === true
  const workspaceQuery = useQuery({
    queryKey: ['hr-stage9-workspace', module, pageSize, offset],
    queryFn: () => getHrStage9Workspace(module, pageSize, offset),
    enabled: Boolean(isSupabaseConfigured && !sessionQuery.isPending && hasPermission),
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title={`${definition.title} needs the secure connection`} tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (sessionQuery.isPending) return <DataStatePanel icon={CheckCircle2} title={`Checking ${definition.title} access`}><p>Verifying your exact HR permission.</p></DataStatePanel>
  if (sessionQuery.isError) return <DataStatePanel icon={AlertTriangle} title={`${definition.title} access unavailable`} tone="error"><p>{sessionQuery.error.message}</p></DataStatePanel>
  if (!hasPermission) return <DataStatePanel icon={AlertTriangle} title={`${definition.title} access is not assigned`} tone="error"><p>An authorized administrator must assign the exact permission for this workspace.</p></DataStatePanel>

  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>{definition.title}</h1><p className="page-summary">{definition.summary}</p></div>
      </section>
      {workspaceQuery.isPending ? <DataStatePanel icon={WorkspaceIcon} title={`Loading ${definition.title}`}><p>Checking the protected workspace.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} title={`${definition.title} unavailable`} tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : null}
      {workspaceQuery.data && !workspaceQuery.data.enabled ? <DataStatePanel icon={CheckCircle2} title={`${definition.title} is safely staged`}><p>{definition.staged}</p><p>No current roles, permissions, employee records, schedules, or time records were changed.</p></DataStatePanel> : null}
      {workspaceQuery.data?.enabled ? <>
        <section className="page-section-heading"><div><p className="eyebrow">Protected workspace</p><h2>{definition.title}</h2><p>{definition.summary}</p></div><button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button></section>
        <section aria-label={`${definition.title} status`} className="hr-automation-summary hr-automation-summary--three">
          {definition.metrics.map((metric, index) => <article key={metric}><WorkspaceIcon aria-hidden="true" size={20} /><span>{metric}</span><strong>{index === 0 ? workspaceQuery.data.counts.primary : index === 1 ? workspaceQuery.data.counts.secondary : workspaceQuery.data.counts.tertiary}</strong></article>)}
        </section>
        <section className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Current work</p><h2>{definition.title} worklist</h2></div></div>
          {workspaceQuery.data.items.length ? <div className="hr-automation-list">{workspaceQuery.data.items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.subtitle}{item.detail ? ` · ${item.detail}` : ''}</span></div><div><span className="action-status">{item.status}</span>{formatDate(item.dateLabel) ? <small>{formatDate(item.dateLabel)}</small> : null}</div></article>)}</div> : <div className="compact-empty"><WorkspaceIcon aria-hidden="true" size={24} /><span>{definition.empty}</span></div>}
        </section>
        <Pagination itemCount={workspaceQuery.data.items.length} offset={offset} pageSize={pageSize} onOffset={setOffset} onPageSize={(value) => { setPageSize(value); setOffset(0) }} />
      </> : null}
    </div>
  )
}

export function HrisOffboardingPage() { return <Stage9WorkspacePage module="offboarding" /> }
export function HrisSelfServicePage() { return <Stage9WorkspacePage module="self_service" /> }
export function HrisReportingPage() { return <Stage9WorkspacePage module="reporting" /> }

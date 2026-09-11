import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileBarChart,
  RefreshCw,
  Repeat2,
  UserRoundCog,
  type LucideIcon,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { HrLifecycleCaseDialog } from '../components/HrLifecycleCaseDialog'
import { HrLifecycleCaseWizard } from '../components/HrLifecycleCaseWizard'
import { HrPagination } from '../components/HrPagination'
import { HrOperationalActions } from '../components/HrOperationalActions'
import { getSessionContext } from '../data/auth'
import { getHrOffboardingOptions } from '../data/hrOffboarding'
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

function Stage9WorkspacePage({ module }: { module: HrStage9Module }) {
  const [pageSize, setPageSize] = useState<HrStage9PageSize>(10)
  const [offset, setOffset] = useState(0)
  const definition = workspaceDefinitions[module]
  const WorkspaceIcon = definition.icon
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const hasPermission = sessionQuery.data?.permissions.includes(definition.permission) === true
  const canManage = module === 'self_service' || sessionQuery.data?.permissions.includes(`hr.${module}.manage`) === true
  const canApproveLifecycle = module === 'offboarding'
    && sessionQuery.data?.permissions.includes('hr.offboarding.approve') === true
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
        <section className="page-section-heading"><div><p className="eyebrow">Protected workspace</p><h2>{definition.title}</h2><p>{definition.summary}</p></div><div className="hr-operational-heading-actions">{canManage ? <HrOperationalActions actionKeys={module === 'offboarding' ? ['create_case'] : undefined} module={module} items={workspaceQuery.data.items} onComplete={() => workspaceQuery.refetch()} triggerLabel={module === 'offboarding' ? 'New case' : 'New or manage'} /> : null}<button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button></div></section>
        <section aria-label={`${definition.title} status`} className="hr-automation-summary hr-automation-summary--three">
          {definition.metrics.map((metric, index) => <article key={metric}><WorkspaceIcon aria-hidden="true" size={20} /><span>{metric}</span><strong>{index === 0 ? workspaceQuery.data.counts.primary : index === 1 ? workspaceQuery.data.counts.secondary : workspaceQuery.data.counts.tertiary}</strong></article>)}
        </section>
        <section className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Current work</p><h2>{definition.title} worklist</h2></div></div>
          {workspaceQuery.data.items.length ? <div className="hr-automation-list">{workspaceQuery.data.items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.subtitle}{item.detail ? ` · ${item.detail}` : ''}</span></div><div className="hr-lifecycle-row-actions"><span className="action-status">{item.status.replaceAll('_', ' ')}</span>{formatDate(item.dateLabel) ? <small>{formatDate(item.dateLabel)}</small> : null}{module === 'offboarding' && item.status === 'pending_approval' && canApproveLifecycle ? <HrOperationalActions actionKeys={['review_case']} initialValues={{ id: item.id }} items={[item]} module="offboarding" onComplete={() => workspaceQuery.refetch()} showPlusIcon={false} triggerClassName="secondary-button secondary-button--small" triggerLabel="Manage" /> : null}</div></article>)}</div> : <div className="compact-empty"><WorkspaceIcon aria-hidden="true" size={24} /><span>{definition.empty}</span></div>}
        </section>
        <HrPagination itemCount={workspaceQuery.data.items.length} label={`${definition.title} records`} offset={offset} onOffsetChange={setOffset} onPageSizeChange={setPageSize} pageSize={pageSize} />
      </> : null}
    </div>
  )
}

export function HrisOffboardingPage() {
  const [pageSize, setPageSize] = useState<HrStage9PageSize>(10)
  const [offset, setOffset] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const [wizardOpen, setWizardOpen] = useState(Boolean(searchParams.get('employee')))
  const [selectedCaseId, setSelectedCaseId] = useState(searchParams.get('case'))
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const hasPermission = sessionQuery.data?.permissions.includes('hr.offboarding.view') === true
  const canManage = sessionQuery.data?.permissions.includes('hr.offboarding.manage') === true
  const workspaceQuery = useQuery({
    queryKey: ['hr-stage9-workspace', 'offboarding', pageSize, offset],
    queryFn: () => getHrStage9Workspace('offboarding', pageSize, offset),
    enabled: Boolean(isSupabaseConfigured && !sessionQuery.isPending && hasPermission),
  })
  const optionsQuery = useQuery({
    queryKey: ['hr-offboarding-options'],
    queryFn: getHrOffboardingOptions,
    enabled: Boolean(isSupabaseConfigured && !sessionQuery.isPending && hasPermission),
  })

  useEffect(() => {
    const caseId = searchParams.get('case')
    if (caseId) setSelectedCaseId(caseId)
  }, [searchParams])

  function clearModalRoute() {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('case')
      next.delete('employee')
      return next
    }, { replace: true })
  }

  function closeWizard() {
    setWizardOpen(false)
    clearModalRoute()
  }

  function openCase(caseId: string) {
    setSelectedCaseId(caseId)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('case', caseId)
      next.delete('employee')
      return next
    }, { replace: true })
  }

  function closeCase() {
    setSelectedCaseId(null)
    clearModalRoute()
  }

  function exportQueue() {
    if (!workspaceQuery.data) return
    const rows = [
      ['Employee', 'Lifecycle', 'Status', 'Effective date', 'Protected summary'],
      ...workspaceQuery.data.items.map((item) => [item.title, item.subtitle, item.status, item.dateLabel ?? '', item.detail ?? '']),
    ]
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `sygshift-employee-lifecycle-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title="Employee Lifecycle needs the secure connection" tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (sessionQuery.isPending) return <DataStatePanel icon={CheckCircle2} title="Checking Employee Lifecycle access"><p>Verifying your exact HR permission.</p></DataStatePanel>
  if (sessionQuery.isError) return <DataStatePanel icon={AlertTriangle} title="Employee Lifecycle access unavailable" tone="error"><p>{sessionQuery.error.message}</p></DataStatePanel>
  if (!hasPermission) return <DataStatePanel icon={AlertTriangle} title="Employee Lifecycle access is not assigned" tone="error"><p>An authorized administrator must assign the exact permission for this workspace.</p></DataStatePanel>

  return <div className="page page--hr-automation page--employee-lifecycle">
    <section className="page-intro workforce-intro"><div><p className="eyebrow">HR &amp; Finance</p><h1>Employee Lifecycle</h1><p className="page-summary">One guided workflow for resignation, termination, job abandonment, end of assignment, and rehire—from independent approval through every handoff and final confirmation.</p></div></section>
    {workspaceQuery.isPending ? <DataStatePanel icon={Repeat2} title="Loading Employee Lifecycle"><p>Checking the protected cases and due work.</p></DataStatePanel> : null}
    {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} title="Employee Lifecycle unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : null}
    {optionsQuery.isError ? <DataStatePanel icon={AlertTriangle} title="Lifecycle options unavailable" tone="error"><p>{optionsQuery.error.message}</p></DataStatePanel> : null}
    {workspaceQuery.data?.enabled ? <>
      <section className="page-section-heading"><div><p className="eyebrow">Protected workspace</p><h2>Cases and effective-date queue</h2><p>Approval never changes employment by itself. Due cases require a qualified person to complete the checklist and confirm the final action.</p></div><div className="hr-operational-heading-actions">{canManage && optionsQuery.data ? <button className="primary-action" onClick={() => setWizardOpen(true)} type="button">Start guided case</button> : null}<button className="secondary-button" disabled={!workspaceQuery.data.items.length} onClick={exportQueue} type="button"><Download aria-hidden="true" size={17} />Export view</button><button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button></div></section>
      <section aria-label="Employee Lifecycle status" className="hr-automation-summary hr-automation-summary--three"><article><Repeat2 aria-hidden="true" size={20} /><span>Active cases</span><strong>{workspaceQuery.data.counts.primary}</strong></article><article><UserRoundCog aria-hidden="true" size={20} /><span>Pending approvals</span><strong>{workspaceQuery.data.counts.secondary}</strong></article><article><CheckCircle2 aria-hidden="true" size={20} /><span>Open handoffs</span><strong>{workspaceQuery.data.counts.tertiary}</strong></article></section>
      <section className="panel hr-automation-worklist hr-lifecycle-worklist"><div className="section-heading"><div><p className="eyebrow">Current work</p><h2>Employee lifecycle worklist</h2></div></div>{workspaceQuery.data.items.length ? <div className="hr-automation-list">{workspaceQuery.data.items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.subtitle}{item.detail ? ` · ${item.detail}` : ''}</span></div><div className="hr-lifecycle-row-actions"><span className="action-status">{item.status.replaceAll('_', ' ')}</span>{formatDate(item.dateLabel) ? <small>{formatDate(item.dateLabel)}</small> : null}<button className="secondary-button secondary-button--small" onClick={() => openCase(item.id)} type="button">Open case</button></div></article>)}</div> : <div className="compact-empty"><Repeat2 aria-hidden="true" size={24} /><span>No employee lifecycle cases are in this view.</span></div>}</section>
      <HrPagination itemCount={workspaceQuery.data.items.length} label="Employee lifecycle cases" offset={offset} onOffsetChange={setOffset} onPageSizeChange={setPageSize} pageSize={pageSize} />
    </> : null}
    {wizardOpen && optionsQuery.data ? <HrLifecycleCaseWizard initialEmployeeId={searchParams.get('employee') ?? ''} onClose={closeWizard} onCreated={(caseId) => { setWizardOpen(false); openCase(caseId); void workspaceQuery.refetch() }} options={optionsQuery.data} /> : null}
    {selectedCaseId && optionsQuery.data ? <HrLifecycleCaseDialog caseId={selectedCaseId} onClose={closeCase} onUpdated={() => { void workspaceQuery.refetch() }} options={optionsQuery.data} /> : null}
  </div>
}
export function HrisSelfServicePage() { return <Stage9WorkspacePage module="self_service" /> }
export function HrisReportingPage() { return <Stage9WorkspacePage module="reporting" /> }

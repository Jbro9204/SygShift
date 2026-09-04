import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ClipboardCheck,
  GraduationCap,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { HrPagination } from '../components/HrPagination'
import { HrOperationalActions } from '../components/HrOperationalActions'
import { getSessionContext } from '../data/auth'
import {
  getHrStage8Workspace,
  type HrStage8Module,
  type HrStage8PageSize,
} from '../data/hrStage8'
import { isSupabaseConfigured } from '../lib/supabase'

type WorkspaceDefinition = {
  module: HrStage8Module
  permission: string
  label: string
  title: string
  summary: string
  staged: string
  metrics: readonly [string, string, string]
  empty: string
  icon: LucideIcon
}

const workspaceDefinitions: Record<HrStage8Module, WorkspaceDefinition> = {
  talent: {
    module: 'talent', permission: 'hr.talent.view', label: 'Talent', title: 'Talent Management',
    summary: 'Coordinate goals, reviews, development plans, and carefully restricted talent records.',
    staged: 'Goals, reviews, development plans, performance history, and restricted talent records remain protected and unchanged.',
    metrics: ['Open cycles', 'Active goals', 'Reviews in progress'], empty: 'No talent work is in this view.', icon: GraduationCap,
  },
  learning: {
    module: 'learning', permission: 'hr.learning.view', label: 'Learning', title: 'Learning & Training',
    summary: 'Assign learning, monitor completion, and connect training evidence to licensing without duplicating credentials.',
    staged: 'Courses, assignments, completion evidence, renewals, and Licensing Center connections remain protected and unchanged.',
    metrics: ['Active learning', 'Due assignments', 'Completed assignments'], empty: 'No learning assignments are in this view.', icon: BookOpenCheck,
  },
  cases: {
    module: 'cases', permission: 'hr.cases.view', label: 'Employee Cases', title: 'Employee Relations Cases',
    summary: 'Keep sensitive HR case work, evidence, tasks, outcomes, and legal holds in a restricted audit trail.',
    staged: 'Cases, participants, notes, evidence, tasks, outcomes, and legal holds remain protected and unchanged.',
    metrics: ['Open cases', 'High priority', 'Open tasks'], empty: 'No employee relations cases are in this view.', icon: ClipboardCheck,
  },
  safety: {
    module: 'safety', permission: 'hr.safety.view', label: 'Safety', title: 'Safety & Workers’ Compensation',
    summary: 'Track incidents, work restrictions, return-to-work plans, and segregated medical records safely.',
    staged: 'Incidents, witnesses, restrictions, return-to-work plans, medical records, and claims remain protected and unchanged.',
    metrics: ['Open incidents', 'Active restrictions', 'Return-to-work plans'], empty: 'No safety cases are in this view.', icon: ShieldAlert,
  },
  assets: {
    module: 'assets', permission: 'hr.assets.view', label: 'Assets', title: 'Employee Assets',
    summary: 'Control equipment issuance, acknowledgment, condition, transfer, return, and offboarding recovery.',
    staged: 'Assets, assignments, acknowledgments, returns, loss reviews, and offboarding recovery remain protected and unchanged.',
    metrics: ['Available assets', 'Active assignments', 'Financial reviews'], empty: 'No assets are in this view.', icon: PackageCheck,
  },
}

const talentLearningModules: HrStage8Module[] = ['talent', 'learning']
const casesComplianceModules: HrStage8Module[] = ['cases', 'safety', 'assets']

function formatDate(value: string | null): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`))
}

function Stage8WorkspacePage({ title, summary, modules }: {
  title: string
  summary: string
  modules: HrStage8Module[]
}) {
  const [selectedModule, setSelectedModule] = useState<HrStage8Module>(modules[0])
  const [pageSize, setPageSize] = useState<HrStage8PageSize>(10)
  const [offset, setOffset] = useState(0)
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const allowedModules = useMemo(() => modules.filter((module) => (
    sessionQuery.data?.permissions.includes(workspaceDefinitions[module].permission)
  )), [modules, sessionQuery.data?.permissions])
  const canManageSelected = sessionQuery.data?.permissions.includes(`hr.${selectedModule}.manage`) === true

  useEffect(() => {
    if (allowedModules.length && !allowedModules.includes(selectedModule)) setSelectedModule(allowedModules[0])
  }, [allowedModules, selectedModule])

  const canLoad = Boolean(isSupabaseConfigured && !sessionQuery.isPending && allowedModules.includes(selectedModule))
  const workspaceQuery = useQuery({
    queryKey: ['hr-stage8-workspace', selectedModule, pageSize, offset],
    queryFn: () => getHrStage8Workspace(selectedModule, pageSize, offset),
    enabled: canLoad,
  })
  const definition = workspaceDefinitions[selectedModule]
  const WorkspaceIcon = definition.icon

  function changeModule(module: HrStage8Module) {
    setSelectedModule(module)
    setOffset(0)
  }

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title={`${title} needs the secure connection`} tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (sessionQuery.isPending) return <DataStatePanel icon={CheckCircle2} title={`Checking ${title} access`}><p>Verifying your exact HR permissions.</p></DataStatePanel>
  if (sessionQuery.isError) return <DataStatePanel icon={AlertTriangle} title={`${title} access unavailable`} tone="error"><p>{sessionQuery.error.message}</p></DataStatePanel>
  if (!allowedModules.length) return <DataStatePanel icon={AlertTriangle} title={`${title} access is not assigned`} tone="error"><p>An authorized administrator must assign the exact permission for this workspace.</p></DataStatePanel>

  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>{title}</h1><p className="page-summary">{summary}</p></div>
      </section>
      <nav aria-label={`${title} sections`} className="segmented-control hr-stage8-tabs">
        {allowedModules.map((module) => {
          const tab = workspaceDefinitions[module]
          const Icon = tab.icon
          return <button aria-pressed={module === selectedModule} className={module === selectedModule ? 'is-active' : ''} key={module} onClick={() => changeModule(module)} type="button"><Icon aria-hidden="true" size={17} />{tab.label}</button>
        })}
      </nav>
      {workspaceQuery.isPending ? <DataStatePanel icon={definition.icon} title={`Loading ${definition.title}`}><p>Checking the protected workspace.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} title={`${definition.title} unavailable`} tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : null}
      {workspaceQuery.data && !workspaceQuery.data.enabled ? <DataStatePanel icon={CheckCircle2} title={`${definition.title} is safely staged`}><p>{definition.staged}</p><p>No current roles, permissions, or employee records were changed.</p></DataStatePanel> : null}
      {workspaceQuery.data?.enabled ? <>
        <section className="page-section-heading"><div><p className="eyebrow">Protected workspace</p><h2>{definition.title}</h2><p>{definition.summary}</p></div><div className="hr-operational-heading-actions">{canManageSelected ? <HrOperationalActions module={selectedModule} items={workspaceQuery.data.items} onComplete={() => workspaceQuery.refetch()} /> : null}<button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button></div></section>
        <section aria-label={`${definition.title} status`} className="hr-automation-summary hr-automation-summary--three">
          {definition.metrics.map((metric, index) => <article key={metric}><WorkspaceIcon aria-hidden="true" size={20} /><span>{metric}</span><strong>{index === 0 ? workspaceQuery.data.counts.primary : index === 1 ? workspaceQuery.data.counts.secondary : workspaceQuery.data.counts.tertiary}</strong></article>)}
        </section>
        <section className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Current work</p><h2>{definition.label} worklist</h2></div></div>
          {workspaceQuery.data.items.length ? <div className="hr-automation-list">{workspaceQuery.data.items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.subtitle}{item.detail ? ` · ${item.detail}` : ''}</span></div><div><span className="action-status">{item.status}</span>{formatDate(item.dateLabel) ? <small>{formatDate(item.dateLabel)}</small> : null}</div></article>)}</div> : <div className="compact-empty"><WorkspaceIcon aria-hidden="true" size={24} /><span>{definition.empty}</span></div>}
        </section>
        <HrPagination itemCount={workspaceQuery.data.items.length} label={`${definition.title} records`} offset={offset} onOffsetChange={setOffset} onPageSizeChange={setPageSize} pageSize={pageSize} />
      </> : null}
    </div>
  )
}

export function HrisTalentLearningPage() {
  return <Stage8WorkspacePage modules={talentLearningModules} summary="Develop people and manage learning in focused workspaces connected to authoritative employee and licensing records." title="Talent & Learning" />
}

export function HrisCasesCompliancePage() {
  return <Stage8WorkspacePage modules={casesComplianceModules} summary="Handle restricted employee cases, safety work, and issued assets without crowding or weakening audit controls." title="Cases, Safety & Assets" />
}

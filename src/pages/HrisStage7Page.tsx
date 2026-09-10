import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, BadgeDollarSign, CheckCircle2, HeartHandshake, RefreshCw, ShieldCheck, Umbrella } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { PayRateReviewDialog } from '../components/EmployeeCompensationCard'
import { HrPagination } from '../components/HrPagination'
import { HrOperationalActions } from '../components/HrOperationalActions'
import { getSessionContext } from '../data/auth'
import { getHrEmployeeCompensation } from '../data/hrCompensation'
import {
  getHrBenefitsWorkspace,
  getHrCompensationWorkspace,
  getHrLeaveWorkspace,
  type HrBenefitsWorkspace,
  type HrCompensationWorkspace,
  type HrLeaveWorkspace,
} from '../data/hrStage7'
import { isSupabaseConfigured } from '../lib/supabase'

type PageSize = 5 | 10 | 20
type WorkspaceKind = 'leave' | 'benefits' | 'compensation'
type Stage7Workspace = HrLeaveWorkspace | HrBenefitsWorkspace | HrCompensationWorkspace

const workspaceDetails = {
  leave: {
    title: 'Leave Administration',
    summary: 'Coordinate approved leave without replacing the operational time-off request workflow.',
    staged: 'No leave policy, case, protected detail, balance, or downstream payroll action can change while the release gate is off.',
    icon: Umbrella,
  },
  benefits: {
    title: 'Benefits',
    summary: 'Manage benefit plans, enrollment windows, eligibility, elections, dependents, and beneficiaries in a protected workspace.',
    staged: 'No plan, eligibility rule, election, dependent, beneficiary, or deduction can change while the release gate is off.',
    icon: HeartHandshake,
  },
  compensation: {
    title: 'Compensation',
    summary: 'Review protected compensation records and controlled proposals with recent MFA and approval separation.',
    staged: 'No pay component, amount, proposal, approval, payroll instruction, or employee compensation record can change while the release gate is off.',
    icon: BadgeDollarSign,
  },
} as const

function formatDate(value: string | null): string {
  if (!value) return 'Open-ended'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`))
}

function Stage7WorkspacePage({ kind }: { kind: WorkspaceKind }) {
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const [offset, setOffset] = useState(0)
  const details = workspaceDetails[kind]
  const sessionQuery = useQuery({ queryKey: ['session-context'], queryFn: getSessionContext, enabled: isSupabaseConfigured })
  const query = useQuery<Stage7Workspace>({
    queryKey: [`hr-${kind}-workspace`, pageSize, offset],
    queryFn: () => kind === 'leave'
      ? getHrLeaveWorkspace(pageSize, offset)
      : kind === 'benefits'
        ? getHrBenefitsWorkspace(pageSize, offset)
        : getHrCompensationWorkspace(pageSize, offset),
    enabled: isSupabaseConfigured,
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={AlertTriangle} title={`${details.title} needs the secure connection`} tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  if (query.isPending) return <DataStatePanel icon={details.icon} title={`Loading ${details.title}`}><p>Checking the protected workspace.</p></DataStatePanel>
  if (query.isError) return <DataStatePanel icon={AlertTriangle} title={`${details.title} unavailable`} tone="error"><p>{query.error.message}</p></DataStatePanel>

  const workspace = query.data
  if (!workspace.enabled) {
    return (
      <div className="page page--hr-automation">
        <section className="page-intro workforce-intro"><div><p className="eyebrow">HR &amp; Finance</p><h1>{details.title}</h1><p className="page-summary">{details.summary}</p></div></section>
        <DataStatePanel icon={CheckCircle2} title={`${details.title} is safely staged`}><p>{details.staged}</p></DataStatePanel>
      </div>
    )
  }

  return (
    <div className="page page--hr-automation">
      <section className="page-intro workforce-intro">
        <div><p className="eyebrow">HR &amp; Finance</p><h1>{details.title}</h1><p className="page-summary">{details.summary}</p></div>
        <div className="hr-operational-heading-actions">
          {kind !== 'compensation' && sessionQuery.data?.permissions.includes(`hr.${kind}.manage`) ? <HrOperationalActions module={kind} items={workspace.items.map((item) => ({ id: item.id, title: 'employeeName' in item ? item.employeeName : item.name, status: item.status }))} onComplete={() => query.refetch()} /> : null}
          <button className="secondary-button" onClick={() => query.refetch()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button>
        </div>
      </section>
      {kind === 'leave' ? <LeaveWorkspace workspace={workspace as HrLeaveWorkspace} /> : null}
      {kind === 'benefits' ? <BenefitsWorkspace workspace={workspace as HrBenefitsWorkspace} /> : null}
      {kind === 'compensation' ? <CompensationWorkspace canApprove={sessionQuery.data?.permissions.includes('hr.compensation.approve') === true} workspace={workspace as HrCompensationWorkspace} /> : null}
      <HrPagination itemCount={workspace.items.length} label={`${details.title} records`} offset={offset} onOffsetChange={setOffset} onPageSizeChange={setPageSize} pageSize={pageSize} />
    </div>
  )
}

function LeaveWorkspace({ workspace }: { workspace: HrLeaveWorkspace }) {
  return <><section className="hr-automation-summary hr-automation-summary--three" aria-label="Leave status"><article><Umbrella aria-hidden="true" size={20} /><span>Open cases</span><strong>{workspace.counts.openCases}</strong></article><article><CheckCircle2 aria-hidden="true" size={20} /><span>Approved cases</span><strong>{workspace.counts.approvedCases}</strong></article><article><Umbrella aria-hidden="true" size={20} /><span>Active policies</span><strong>{workspace.counts.activePolicies}</strong></article></section><section className="hr-stage-grid"><article className="panel hr-automation-worklist"><div className="section-heading"><div><p className="eyebrow">Case worklist</p><h2>Leave cases</h2></div></div>{workspace.items.length ? <div className="hr-automation-list">{workspace.items.map((item) => <article key={item.id}><div><strong>{item.employeeName}</strong><span>{item.employeeNumber} · {item.caseType} · {formatDate(item.startOn)} to {formatDate(item.returnOn)}</span></div><div><span className="action-status">{item.status}</span><small>{item.payTreatment}</small></div></article>)}</div> : <div className="compact-empty"><Umbrella aria-hidden="true" size={24} /><span>No leave cases are in this view.</span></div>}</article><article className="panel hr-automation-worklist"><div className="section-heading"><div><p className="eyebrow">Policy control</p><h2>Leave policies</h2></div></div>{workspace.policies.length ? <div className="hr-automation-list">{workspace.policies.map((policy) => <article key={policy.id}><div><strong>{policy.name}</strong><span>{policy.code} · effective {formatDate(policy.effectiveFrom)} to {formatDate(policy.effectiveThrough)}</span></div><span className="action-status">{policy.status}</span></article>)}</div> : <div className="compact-empty"><Umbrella aria-hidden="true" size={24} /><span>No leave policies have been approved.</span></div>}</article></section></>
}

function BenefitsWorkspace({ workspace }: { workspace: HrBenefitsWorkspace }) {
  return <><section className="hr-automation-summary hr-automation-summary--three" aria-label="Benefits status"><article><HeartHandshake aria-hidden="true" size={20} /><span>Active plans</span><strong>{workspace.counts.activePlans}</strong></article><article><HeartHandshake aria-hidden="true" size={20} /><span>Open windows</span><strong>{workspace.counts.openWindows}</strong></article><article><AlertTriangle aria-hidden="true" size={20} /><span>Pending elections</span><strong>{workspace.counts.pendingEnrollments}</strong></article></section><section className="hr-stage-grid"><article className="panel hr-automation-worklist"><div className="section-heading"><div><p className="eyebrow">Plan worklist</p><h2>Benefit plans</h2></div></div>{workspace.items.length ? <div className="hr-automation-list">{workspace.items.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.code} · {item.planType}{item.carrierName ? ` · ${item.carrierName}` : ''}</span></div><span className="action-status">{item.status}</span></article>)}</div> : <div className="compact-empty"><HeartHandshake aria-hidden="true" size={24} /><span>No benefit plans have been configured.</span></div>}</article><article className="panel hr-automation-worklist"><div className="section-heading"><div><p className="eyebrow">Enrollment control</p><h2>Enrollment windows</h2></div></div>{workspace.windows.length ? <div className="hr-automation-list">{workspace.windows.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.windowType} · {formatDate(item.opensAt)} to {formatDate(item.closesAt)}</span></div><span className="action-status">{item.status}</span></article>)}</div> : <div className="compact-empty"><HeartHandshake aria-hidden="true" size={24} /><span>No enrollment windows are open.</span></div>}</article></section></>
}

function CompensationWorkspace({ canApprove, workspace }: { canApprove: boolean; workspace: HrCompensationWorkspace }) {
  const [reviewTarget, setReviewTarget] = useState<HrCompensationWorkspace['items'][number] | null>(null)
  const [notice, setNotice] = useState('')
  const reviewQuery = useQuery({
    enabled: reviewTarget !== null,
    queryFn: () => getHrEmployeeCompensation(reviewTarget!.employeeId),
    queryKey: ['hr-employee-compensation', reviewTarget?.employeeId],
    retry: false,
  })
  const money = (cents: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  const proposal = reviewTarget ? reviewQuery.data?.pendingProposals.find((item) => item.id === reviewTarget.id) : undefined
  return <><section className="hr-automation-summary hr-automation-summary--three" aria-label="Compensation status"><article><BadgeDollarSign aria-hidden="true" size={20} /><span>Active components</span><strong>{workspace.counts.activeComponents}</strong></article><article><AlertTriangle aria-hidden="true" size={20} /><span>Pending proposals</span><strong>{workspace.counts.pendingProposals}</strong></article><article><CheckCircle2 aria-hidden="true" size={20} /><span>Active records</span><strong>{workspace.counts.activeRecords}</strong></article></section><section className="hr-stage-grid"><article className="panel hr-automation-worklist"><div className="section-heading"><div><p className="eyebrow">Approval worklist</p><h2>Compensation proposals</h2></div></div>{notice ? <div className="hr-compensation-worklist__notice" role="status"><CheckCircle2 aria-hidden="true" size={17} />{notice}</div> : null}{workspace.items.length ? <div className="hr-automation-list">{workspace.items.map((item) => <article key={item.id}><div><strong>{item.employeeName}</strong><span>{item.employeeNumber} · {item.componentName} · effective {formatDate(item.effectiveFrom)}</span></div><div className="hr-compensation-row__controls"><div><strong>{money(item.amountCents, item.currencyCode)}</strong><small>{item.payFrequency}</small></div>{canApprove && item.status === 'pending' ? <button aria-label={`Review compensation for ${item.employeeName}`} className="secondary-button" onClick={() => { setNotice(''); setReviewTarget(item) }} type="button"><ShieldCheck aria-hidden="true" size={16} />Review</button> : <span className="action-status">{item.status}</span>}</div></article>)}</div> : <div className="compact-empty"><BadgeDollarSign aria-hidden="true" size={24} /><span>No compensation proposals are in this view.</span></div>}</article><article className="panel hr-automation-worklist"><div className="section-heading"><div><p className="eyebrow">Configuration</p><h2>Pay components</h2></div></div>{workspace.components.length ? <div className="hr-automation-list">{workspace.components.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.code} · {item.componentType}</span></div><span className="action-status">{item.status}</span></article>)}</div> : <div className="compact-empty"><BadgeDollarSign aria-hidden="true" size={24} /><span>No pay components have been configured.</span></div>}</article></section>{reviewTarget && reviewQuery.isPending ? <ModalDialog busy busyLabel="Opening protected compensation…" className="hr-file-editor-modal" description="Loading the exact proposal and verifying that you can make the independent decision." onClose={() => setReviewTarget(null)} title={`Review pay rate · ${reviewTarget.employeeName}`}><div className="hr-compensation-review-state"><ShieldCheck aria-hidden="true" /><p>Checking the protected proposal.</p></div></ModalDialog> : null}{reviewTarget && reviewQuery.isError ? <ModalDialog className="hr-file-editor-modal" description="The protected proposal could not be opened. Complete identity verification if prompted, then try again." onClose={() => setReviewTarget(null)} title={`Review pay rate · ${reviewTarget.employeeName}`}><div className="hr-compensation-review-state" role="alert"><AlertTriangle aria-hidden="true" /><p>{reviewQuery.error instanceof Error ? reviewQuery.error.message : 'Protected compensation could not be loaded.'}</p><button className="secondary-button" onClick={() => void reviewQuery.refetch()} type="button"><RefreshCw aria-hidden="true" size={16} />Try again</button></div></ModalDialog> : null}{reviewTarget && reviewQuery.isSuccess && proposal && reviewQuery.data.canApprove && !proposal.proposedByCurrentActor ? <PayRateReviewDialog employeeId={reviewTarget.employeeId} employeeName={reviewTarget.employeeName} onClose={() => setReviewTarget(null)} onSaved={(status) => { setNotice(`Pay-rate proposal ${status}.`); setReviewTarget(null) }} proposal={proposal} /> : null}{reviewTarget && reviewQuery.isSuccess && (!proposal || !reviewQuery.data.canApprove || proposal.proposedByCurrentActor) ? <ModalDialog className="hr-file-editor-modal" description="Compensation decisions remain protected by independent approval and current proposal status." onClose={() => setReviewTarget(null)} title={`Review pay rate · ${reviewTarget.employeeName}`}><div className="hr-compensation-review-state" role="status"><ShieldCheck aria-hidden="true" /><div><strong>{proposal?.proposedByCurrentActor ? 'A different authorized approver is required.' : proposal ? 'You do not have compensation approval access.' : 'This proposal is no longer pending.'}</strong><p>{proposal?.proposedByCurrentActor ? 'The person who proposed a pay change cannot approve it.' : proposal ? 'Ask an administrator with compensation approval permission to review it.' : 'Refresh the worklist to see the current compensation queue.'}</p></div></div><div className="modal-actions"><button className="secondary-button" onClick={() => setReviewTarget(null)} type="button">Close</button></div></ModalDialog> : null}</>
}

export function HrisLeavePage() { return <Stage7WorkspacePage kind="leave" /> }
export function HrisBenefitsPage() { return <Stage7WorkspacePage kind="benefits" /> }
export function HrisCompensationPage() { return <Stage7WorkspacePage kind="compensation" /> }

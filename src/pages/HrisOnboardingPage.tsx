import { useMemo, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getSessionContext } from '../data/auth'
import {
  createHrOnboardingPrehire,
  getHrOnboardingCase,
  getHrOnboardingWorkspace,
  runHrOnboardingAction,
  sendHrOnboardingWelcomePackage,
  type HrOnboardingAction,
  type HrOnboardingCase,
  type HrOnboardingPrehireInput,
} from '../data/hrOnboarding'
import { isSupabaseConfigured } from '../lib/supabase'

type PageSize = 5 | 10 | 20
type Feedback = { tone: 'success' | 'error'; message: string }
type Task = HrOnboardingCase['tasks'][number]
type PendingAction = {
  action: HrOnboardingAction
  payload: Record<string, unknown>
  title: string
  description: string
}

const initialPrehire: HrOnboardingPrehireInput = {
  firstName: '',
  middleName: '',
  lastName: '',
  personalEmail: '',
  mobilePhone: '',
  positionTitle: '',
  workState: 'CO',
  role: 'guard',
  employmentType: 'hourly',
  jobFamily: 'guard',
  startDate: '',
  requiresGuardLicense: true,
  requiresArmedCredentials: false,
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`))
}

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function groupTasks(tasks: Task[]) {
  return tasks.reduce<Record<string, Task[]>>((groups, task) => {
    const group = task.responsibleGroup || 'Onboarding'
    groups[group] = [...(groups[group] ?? []), task]
    return groups
  }, {})
}

export function HrisOnboardingPage() {
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const [offset, setOffset] = useState(0)
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [prehire, setPrehire] = useState<HrOnboardingPrehireInput>(initialPrehire)
  const [createReason, setCreateReason] = useState('Create employee onboarding record.')
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [actionReason, setActionReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const sessionQuery = useQuery({
    queryKey: ['session-context'],
    queryFn: getSessionContext,
    enabled: isSupabaseConfigured,
  })
  const workspaceQuery = useQuery({
    queryKey: ['hr-onboarding-workspace', pageSize, offset],
    queryFn: () => getHrOnboardingWorkspace(pageSize, offset),
    enabled: isSupabaseConfigured,
  })
  const caseQuery = useQuery({
    queryKey: ['hr-onboarding-case', selectedCaseId],
    queryFn: () => getHrOnboardingCase(selectedCaseId!),
    enabled: Boolean(selectedCaseId),
  })

  const permissions = sessionQuery.data?.permissions ?? []
  const canManage = permissions.includes('hr.onboarding.manage')
  const canApprove = permissions.includes('hr.onboarding.approve')
  const taskGroups = useMemo(() => groupTasks(caseQuery.data?.tasks ?? []), [caseQuery.data?.tasks])

  async function refreshWorkspace(caseId?: string | null) {
    const targetCaseId = caseId ?? selectedCaseId
    await workspaceQuery.refetch()
    if (targetCaseId && targetCaseId === selectedCaseId) await caseQuery.refetch()
  }

  async function submitPrehire(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setFeedback(null)
    try {
      const result = await createHrOnboardingPrehire(prehire, createReason.trim())
      setPrehire(initialPrehire)
      setCreateReason('Create employee onboarding record.')
      setShowCreate(false)
      if (result.caseId) setSelectedCaseId(result.caseId)
      await refreshWorkspace(result.caseId)
      setFeedback({ tone: 'success', message: 'The employee and applicable onboarding checklist were created.' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'The employee could not be created.' })
    } finally {
      setBusy(false)
    }
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pendingAction || !actionReason.trim()) return
    setBusy(true)
    setFeedback(null)
    try {
      await runHrOnboardingAction(pendingAction.action, pendingAction.payload, actionReason.trim())
      setPendingAction(null)
      setActionReason('')
      await refreshWorkspace()
      setFeedback({ tone: 'success', message: 'The onboarding record was updated and the audit history was saved.' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'The onboarding action could not be completed.' })
    } finally {
      setBusy(false)
    }
  }

  async function sendWelcomePackage() {
    if (!selectedCaseId) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await sendHrOnboardingWelcomePackage(selectedCaseId, 'Send approved onboarding welcome and account setup package.')
      await refreshWorkspace()
      setFeedback({
        tone: 'success',
        message: `Welcome email: ${formatStatus(result.delivery.welcome)}. Account setup: ${formatStatus(result.delivery.accountSetup)}.`,
      })
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : 'The welcome package could not be sent.' })
    } finally {
      setBusy(false)
    }
  }

  if (!isSupabaseConfigured) {
    return <DataStatePanel icon={AlertTriangle} title="Onboarding needs the secure connection" tone="setup"><p>Connect the protected data service to continue.</p></DataStatePanel>
  }
  if (workspaceQuery.isPending || sessionQuery.isPending) {
    return <DataStatePanel icon={ClipboardCheck} title="Loading onboarding"><p>Checking employee readiness, permissions, and assigned work.</p></DataStatePanel>
  }
  if (workspaceQuery.isError || sessionQuery.isError) {
    const message = workspaceQuery.error?.message ?? sessionQuery.error?.message ?? 'Onboarding could not be loaded.'
    return <DataStatePanel icon={AlertTriangle} title="Onboarding unavailable" tone="error"><p>{message}</p></DataStatePanel>
  }

  const workspace = workspaceQuery.data
  if (!workspace.enabled) {
    return (
      <div className="page page--hr-automation">
        <section className="page-intro workforce-intro"><div><p className="eyebrow">HR &amp; Finance</p><h1>Onboarding</h1><p className="page-summary">The protected onboarding workspace is installed and remains inactive until its controlled release is approved.</p></div></section>
        <DataStatePanel icon={ShieldCheck} title="Onboarding is safely staged"><p>No onboarding record, task, email, or employee activation can change while the release gate is off.</p></DataStatePanel>
      </div>
    )
  }

  return (
    <div className="page page--hr-automation page--hr-onboarding">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">HR &amp; Finance</p>
          <h1>Onboarding</h1>
          <p className="page-summary">Create the employee once, complete only the requirements that apply, and activate access after an authorized final review.</p>
        </div>
        <div className="hr-onboarding-header-actions">
          <button className="secondary-button" onClick={() => refreshWorkspace()} type="button"><RefreshCw aria-hidden="true" size={17} />Refresh</button>
          {canManage ? <button className="primary-action" onClick={() => setShowCreate(true)} type="button"><Plus aria-hidden="true" size={18} />New employee</button> : null}
        </div>
      </section>

      {feedback ? <div className={`form-feedback form-feedback--${feedback.tone} hr-onboarding-feedback`} role="status">{feedback.message}</div> : null}

      <section className="hr-automation-summary hr-automation-summary--three" aria-label="Onboarding status">
        <article><UserRoundCheck aria-hidden="true" size={20} /><span>Active cases</span><strong>{workspace.counts.activeCases}</strong></article>
        <article><CheckCircle2 aria-hidden="true" size={20} /><span>Ready to finalize</span><strong>{workspace.counts.readyCases}</strong></article>
        <article className={workspace.counts.overdueTasks ? 'is-alert' : ''}><AlertTriangle aria-hidden="true" size={20} /><span>Overdue tasks</span><strong>{workspace.counts.overdueTasks}</strong></article>
      </section>

      <section className="panel hr-onboarding-guide" aria-label="Onboarding safeguards">
        <div><ShieldCheck aria-hidden="true" size={20} /><strong>Controlled activation</strong><span>Ordinary HR work can be prepared without granting employment access.</span></div>
        <div><FileText aria-hidden="true" size={20} /><strong>Evidence required</strong><span>Document-required steps cannot be completed until the current file exists in the Document Vault.</span></div>
        <div><Mail aria-hidden="true" size={20} /><strong>Separate communications</strong><span>The company welcome and secure login instructions are sent as separate approved messages.</span></div>
      </section>

      <section className="hr-stage-grid">
        <article className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Employee readiness</p><h2>Onboarding cases</h2></div></div>
          {workspace.cases.length ? (
            <div className="hr-automation-list">
              {workspace.cases.map((item) => (
                <article key={item.id}>
                  <div><strong>{item.employeeName}</strong><span>{item.employeeNumber} · starts {formatDate(item.targetStartDate)} · {item.templateName}</span></div>
                  <div><span className="action-status">{formatStatus(item.status)}</span><small>{item.taskCounts.complete}/{item.taskCounts.total} complete · {item.taskCounts.overdue} overdue</small><button className="text-button" onClick={() => setSelectedCaseId(item.id)} type="button">Review case</button></div>
                </article>
              ))}
            </div>
          ) : <div className="compact-empty"><UserRoundCheck aria-hidden="true" size={24} /><span>No onboarding cases are in this view.</span></div>}
        </article>
        <article className="panel hr-automation-worklist">
          <div className="section-heading"><div><p className="eyebrow">Requirement sets</p><h2>Active templates</h2></div></div>
          {workspace.templates.length ? <div className="hr-automation-list">{workspace.templates.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>Version {item.version}</span></div><div><span className="action-status">{formatStatus(item.status)}</span></div></article>)}</div> : <div className="compact-empty"><ClipboardCheck aria-hidden="true" size={24} /><span>No onboarding templates are available.</span></div>}
        </article>
      </section>

      <div className="compact-pagination panel">
        <button className="secondary-button secondary-button--small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} type="button">Previous</button>
        <label className="compact-page-size"><span>Show</span><select onChange={(event) => { setPageSize(Number(event.target.value) as PageSize); setOffset(0) }} value={pageSize}><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
        <span>Items {workspace.cases.length ? offset + 1 : 0}–{offset + workspace.cases.length}</span>
        <button className="secondary-button secondary-button--small" disabled={workspace.cases.length < pageSize} onClick={() => setOffset(offset + pageSize)} type="button">Next</button>
      </div>

      {showCreate ? (
        <ModalDialog busy={busy} busyLabel="Creating employee and checklist..." className="modal-dialog--hr-onboarding" description="Create the pre-hire identity and generate only the onboarding requirements that apply." onClose={() => setShowCreate(false)} title="Create onboarding record">
          <form className="hr-onboarding-form" onSubmit={submitPrehire}>
            <fieldset><legend>Employee identity</legend><div className="hr-onboarding-form-grid hr-onboarding-form-grid--three">
              <label><span>Legal first name</span><input required value={prehire.firstName} onChange={(event) => setPrehire({ ...prehire, firstName: event.target.value })} /></label>
              <label><span>Middle name <small>Optional</small></span><input value={prehire.middleName ?? ''} onChange={(event) => setPrehire({ ...prehire, middleName: event.target.value })} /></label>
              <label><span>Legal last name</span><input required value={prehire.lastName} onChange={(event) => setPrehire({ ...prehire, lastName: event.target.value })} /></label>
              <label><span>Personal email</span><input required type="email" value={prehire.personalEmail} onChange={(event) => setPrehire({ ...prehire, personalEmail: event.target.value })} /></label>
              <label><span>Mobile phone <small>Optional</small></span><input type="tel" value={prehire.mobilePhone ?? ''} onChange={(event) => setPrehire({ ...prehire, mobilePhone: event.target.value })} /></label>
            </div></fieldset>
            <fieldset><legend>Employment setup</legend><div className="hr-onboarding-form-grid hr-onboarding-form-grid--three">
              <label><span>Position title</span><input required value={prehire.positionTitle} onChange={(event) => setPrehire({ ...prehire, positionTitle: event.target.value })} /></label>
              <label><span>Start date</span><input required type="date" value={prehire.startDate} onChange={(event) => setPrehire({ ...prehire, startDate: event.target.value })} /></label>
              <label><span>Work state</span><select value={prehire.workState} onChange={(event) => setPrehire({ ...prehire, workState: event.target.value as HrOnboardingPrehireInput['workState'] })}><option value="CO">Colorado</option><option value="CA">California</option><option value="AZ">Arizona</option></select></label>
              <label><span>Employment type</span><select value={prehire.employmentType} onChange={(event) => setPrehire({ ...prehire, employmentType: event.target.value as HrOnboardingPrehireInput['employmentType'] })}><option value="hourly">Hourly</option><option value="salary">Salary</option><option value="flex">Flex</option></select></label>
              <label><span>SygShift role</span><select value={prehire.role} onChange={(event) => setPrehire({ ...prehire, role: event.target.value as HrOnboardingPrehireInput['role'] })}><option value="guard">Guard</option><option value="supervisor">Supervisor</option><option value="dispatcher">Dispatcher</option><option value="scheduler">Scheduler</option><option value="recruiting_licensing">Recruiting &amp; Licensing</option><option value="admin">Admin</option></select></label>
              <label><span>Job family</span><select value={prehire.jobFamily} onChange={(event) => setPrehire({ ...prehire, jobFamily: event.target.value as HrOnboardingPrehireInput['jobFamily'] })}><option value="guard">Guard</option><option value="administration">Administration</option><option value="operations">Operations</option><option value="other">Other</option></select></label>
            </div><div className="hr-onboarding-checks">
              <label><input checked={prehire.requiresGuardLicense} onChange={(event) => setPrehire({ ...prehire, requiresGuardLicense: event.target.checked })} type="checkbox" /><span>Guard license requirements apply</span></label>
              <label><input checked={prehire.requiresArmedCredentials} onChange={(event) => setPrehire({ ...prehire, requiresArmedCredentials: event.target.checked })} type="checkbox" /><span>Armed credential requirements apply</span></label>
            </div></fieldset>
            <label className="hr-onboarding-reason"><span>Audit reason</span><textarea required value={createReason} onChange={(event) => setCreateReason(event.target.value)} /></label>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setShowCreate(false)} type="button">Cancel</button><button className="primary-action" disabled={!createReason.trim()} type="submit">Create employee and checklist</button></div>
          </form>
        </ModalDialog>
      ) : null}

      {selectedCaseId ? (
        <ModalDialog busy={busy} busyLabel="Updating onboarding..." className="modal-dialog--hr-onboarding-case" description="Review the applicable checklist, supporting evidence, communications, and final activation." onClose={() => setSelectedCaseId(null)} title={caseQuery.data?.case.employeeName ?? 'Onboarding case'}>
          {caseQuery.isPending ? <DataStatePanel icon={ClipboardCheck} title="Loading case"><p>Checking requirements and audit history.</p></DataStatePanel> : caseQuery.isError ? <DataStatePanel icon={AlertTriangle} title="Case details unavailable" tone="error"><p>{caseQuery.error.message}</p></DataStatePanel> : caseQuery.data ? (
            <div className="hr-onboarding-case-workspace">
              <section className="hr-onboarding-case-summary">
                <div><span>Employee</span><strong>{caseQuery.data.case.employeeNumber}</strong></div><div><span>Start date</span><strong>{formatDate(caseQuery.data.case.targetStartDate)}</strong></div><div><span>State</span><strong>{caseQuery.data.case.workState}</strong></div><div><span>Employment</span><strong>{formatStatus(caseQuery.data.case.employmentType)}</strong></div><div><span>Position</span><strong>{caseQuery.data.case.positionTitle}</strong></div><div><span>Status</span><strong>{formatStatus(caseQuery.data.case.status)}</strong></div>
              </section>
              <section className="hr-onboarding-delivery"><div><Mail aria-hidden="true" size={20} /><span>Company welcome</span><strong>{formatStatus(caseQuery.data.case.welcomeEmailStatus)}</strong></div><div><ShieldCheck aria-hidden="true" size={20} /><span>Account setup</span><strong>{formatStatus(caseQuery.data.case.accountSetupStatus)}</strong></div>{canManage ? <button className="secondary-button" onClick={sendWelcomePackage} type="button">Send welcome and login package</button> : null}</section>
              <section className="hr-onboarding-task-groups">
                {Object.entries(taskGroups).map(([group, tasks]) => <div className="hr-onboarding-task-group" key={group}><div className="section-heading"><div><p className="eyebrow">Responsible group</p><h3>{group}</h3></div><span>{tasks.filter((task) => task.status === 'completed').length}/{tasks.length} complete</span></div>{tasks.map((task) => <article className={`hr-onboarding-task-card ${task.status === 'completed' ? 'is-complete' : ''}`} key={task.id}><div><strong>{task.title}</strong><span>{task.required ? 'Required' : 'Optional'} · {formatStatus(task.status)}</span>{task.resolutionReason ? <small>{task.resolutionReason}</small> : null}</div><div className="hr-onboarding-task-actions">{task.sourceRequirement.documentRequired ? <Link className="secondary-button secondary-button--small" to="/hr/documents"><FileText aria-hidden="true" size={16} />Document Vault</Link> : null}{canManage && !['completed', 'waived', 'not_applicable'].includes(task.status) ? <button className="primary-action" onClick={() => setPendingAction({ action: 'complete_task', payload: { taskId: task.id, evidence: task.evidence }, title: `Complete ${task.title}`, description: 'Confirm that the requirement has been satisfied. Required document steps are validated against the Document Vault.' })} type="button">Mark complete</button> : null}{canApprove && !task.required && !['completed', 'waived', 'not_applicable'].includes(task.status) ? <button className="secondary-button" onClick={() => setPendingAction({ action: 'waive_task', payload: { taskId: task.id, notApplicable: true }, title: `Mark ${task.title} not applicable`, description: 'This exception applies only to this employee and requires an approval reason.' })} type="button">Not applicable</button> : null}</div></article>)}</div>)}
              </section>
              <section className="hr-onboarding-case-actions"><div><strong>Final activation is protected.</strong><span>Only an authorized approver can activate employment after all required work is complete.</span></div>{canManage ? <button className="danger-button" onClick={() => setPendingAction({ action: 'cancel_case', payload: { caseId: selectedCaseId }, title: 'Cancel onboarding', description: 'Cancel this onboarding case without deleting its audit history.' })} type="button">Cancel onboarding</button> : null}{canApprove ? <button className="primary-action" onClick={() => setPendingAction({ action: 'finalize_case', payload: { caseId: selectedCaseId }, title: 'Approve and activate employment', description: 'Complete the final review and activate the employee only after every required step has been satisfied.' })} type="button"><UserRoundCheck aria-hidden="true" size={17} />Approve and activate</button> : null}</section>
            </div>
          ) : null}
        </ModalDialog>
      ) : null}

      {pendingAction ? (
        <ModalDialog busy={busy} busyLabel="Saving audited decision..." className="modal-dialog--hr-onboarding-action" description={pendingAction.description} onClose={() => setPendingAction(null)} title={pendingAction.title}>
          <form className="hr-onboarding-action-form" onSubmit={submitAction}><label><span>Reason</span><textarea autoFocus required value={actionReason} onChange={(event) => setActionReason(event.target.value)} /></label><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingAction(null)} type="button">Keep reviewing</button><button className="primary-action" disabled={!actionReason.trim()} type="submit">Confirm action</button></div></form>
        </ModalDialog>
      ) : null}
    </div>
  )
}

import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  ArrowLeft,
  BookOpenCheck,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  GraduationCap,
  History,
  MessageSquareText,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
  XCircle,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  createEmployeeConversation,
  employeeConversationTypeLabels,
  getEmployeeConversationsWorkspace,
  recordEmployeeConversationAction,
  type EmployeeConversationItem,
  type EmployeeConversationType,
} from '../data/employeeConversations'
import { operationalToday } from '../lib/time'

type RecordAction = 'follow_up' | 'complete' | 'reopen' | 'void'

const todayKey = () => format(operationalToday(), 'yyyy-MM-dd')

const emptyDraft = (employeeId: string) => ({
  employeeId,
  conversationType: 'employee_conversation' as EmployeeConversationType,
  occurredOn: todayKey(),
  subject: '',
  factualSummary: '',
  expectations: '',
  employeePresent: true,
  followUpOn: '',
})

const typeGuidance: Record<EmployeeConversationType, string> = {
  employee_conversation: 'A routine documented discussion with the employee.',
  coaching: 'Informal guidance intended to clarify or improve work.',
  training: 'Instruction or on-the-job training that was actually completed.',
  policy_reminder: 'A reminder of an existing rule or workplace expectation.',
  performance_follow_up: 'A check-in on previously discussed work expectations.',
  recognition: 'Positive feedback or recognition for work performed.',
  other: 'Another factual conversation that belongs in the supervisory record.',
}

const eventLabels = {
  created: 'Record created',
  follow_up: 'Follow-up added',
  completed: 'Marked complete',
  reopened: 'Reopened',
  voided: 'Voided',
} as const

function formatDate(value: string | null): string {
  if (!value) return 'None'
  const [year, month, day] = value.slice(0, 10).split('-')
  return `${month}/${day}/${year}`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function statusLabel(status: EmployeeConversationItem['status']): string {
  return status === 'open' ? 'Follow-up open' : status === 'completed' ? 'Complete' : 'Voided'
}

export function EmployeeConversationsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedEmployeeId = searchParams.get('employeeId')
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<EmployeeConversationType | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<'active' | 'open' | 'completed' | 'voided' | 'all'>('active')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState(1)
  const [draft, setDraft] = useState(() => emptyDraft(selectedEmployeeId ?? ''))
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<{ action: RecordAction; item: EmployeeConversationItem } | null>(null)
  const [actionNote, setActionNote] = useState('')
  const [actionFollowUpOn, setActionFollowUpOn] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const offset = (page - 1) * pageSize

  const workspaceQuery = useQuery({
    queryKey: ['employee-conversations', selectedEmployeeId, typeFilter, statusFilter, pageSize, offset],
    queryFn: () => getEmployeeConversationsWorkspace({
      employeeId: selectedEmployeeId,
      type: typeFilter,
      status: statusFilter,
      pageSize,
      offset,
    }),
  })

  const matchingEmployees = useMemo(() => {
    const search = employeeSearch.trim().toLocaleLowerCase()
    return (workspaceQuery.data?.employees ?? []).filter((employee) => {
      if (!search) return true
      return [employee.name, employee.employeeNumber, employee.jobTitle, employee.supervisorName]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(search)
    }).slice(0, 20)
  }, [employeeSearch, workspaceQuery.data?.employees])

  const pageCount = Math.max(1, Math.ceil((workspaceQuery.data?.total ?? 0) / pageSize))

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['employee-conversations'] })
  }

  const createMutation = useMutation({
    mutationFn: createEmployeeConversation,
    onSuccess: async () => {
      setWizardOpen(false)
      setWizardStep(1)
      setFormError(null)
      await refresh()
    },
    onError: (error: Error) => setFormError(error.message),
  })

  const actionMutation = useMutation({
    mutationFn: recordEmployeeConversationAction,
    onSuccess: async () => {
      setPendingAction(null)
      setActionNote('')
      setActionFollowUpOn('')
      setFormError(null)
      await refresh()
    },
    onError: (error: Error) => setFormError(error.message),
  })

  function chooseEmployee(employeeId: string) {
    const next = new URLSearchParams(searchParams)
    next.set('employeeId', employeeId)
    setSearchParams(next)
    setEmployeeSearch('')
    setPage(1)
    setExpandedRecordId(null)
  }

  function clearEmployee() {
    const next = new URLSearchParams(searchParams)
    next.delete('employeeId')
    setSearchParams(next)
    setPage(1)
    setExpandedRecordId(null)
  }

  function openCreateWizard() {
    if (!selectedEmployeeId) return
    setDraft(emptyDraft(selectedEmployeeId))
    setWizardStep(1)
    setFormError(null)
    setWizardOpen(true)
  }

  function moveWizard(nextStep: number) {
    setFormError(null)
    if (wizardStep === 1 && (!draft.conversationType || !draft.occurredOn || draft.subject.trim().length < 3)) {
      setFormError('Choose a conversation type and date, then enter a short subject.')
      return
    }
    if (wizardStep === 2 && draft.factualSummary.trim().length < 8) {
      setFormError('Record the factual summary in at least 8 characters.')
      return
    }
    if (wizardStep === 3 && draft.followUpOn && draft.followUpOn < draft.occurredOn) {
      setFormError('Follow-up date cannot be before the conversation date.')
      return
    }
    setWizardStep(nextStep)
  }

  function submitConversation(event: FormEvent) {
    event.preventDefault()
    setFormError(null)
    createMutation.mutate({
      employeeId: draft.employeeId,
      conversationType: draft.conversationType,
      occurredOn: draft.occurredOn,
      subject: draft.subject.trim(),
      factualSummary: draft.factualSummary.trim(),
      expectations: draft.expectations.trim() || null,
      employeePresent: draft.employeePresent,
      followUpOn: draft.followUpOn || null,
    })
  }

  function openAction(action: RecordAction, item: EmployeeConversationItem) {
    setPendingAction({ action, item })
    setActionNote('')
    setActionFollowUpOn(item.followUpOn ?? '')
    setFormError(null)
  }

  function submitAction(event: FormEvent) {
    event.preventDefault()
    if (!pendingAction) return
    setFormError(null)
    const requiredLength = pendingAction.action === 'void' ? 8 : 3
    const maximumLength = pendingAction.action === 'void' ? 2000 : 10000
    if (actionNote.trim().length < requiredLength || actionNote.trim().length > maximumLength) {
      setFormError(pendingAction.action === 'void' ? 'Enter a clear void reason between 8 and 2,000 characters.' : 'Enter a clear note between 3 and 10,000 characters.')
      return
    }
    actionMutation.mutate({
      conversationId: pendingAction.item.id,
      action: pendingAction.action,
      note: actionNote.trim(),
      followUpOn: ['follow_up', 'reopen'].includes(pendingAction.action) ? actionFollowUpOn || null : null,
    })
  }

  return (
    <main className="employee-conversations-page">
      <section className="employee-conversations-hero">
        <div>
          <p className="eyebrow">Workforce · protected record</p>
          <h1>Employee Conversations</h1>
          <p>Record employee discussions and training in one guided, permanent timeline—without opening the rest of the confidential HR file.</p>
        </div>
        <div className="employee-conversations-hero__rule">
          <ShieldCheck aria-hidden="true" />
          <span><strong>Purpose-limited access</strong>Supervisors see assigned employees. HR and approved leaders can review the companywide record.</span>
        </div>
      </section>

      <section className="employee-conversations-guide" aria-label="Employee conversation workflow">
        <div><span>1</span><strong>Choose employee</strong><small>Only people inside your scope appear.</small></div>
        <ChevronRight aria-hidden="true" />
        <div><span>2</span><strong>Record facts</strong><small>Use what was discussed or taught.</small></div>
        <ChevronRight aria-hidden="true" />
        <div><span>3</span><strong>Review</strong><small>Confirm the exact permanent record.</small></div>
        <ChevronRight aria-hidden="true" />
        <div><span>4</span><strong>Follow up</strong><small>Add progress without overwriting history.</small></div>
      </section>

      {workspaceQuery.isPending ? (
        <DataStatePanel icon={MessageSquareText} title="Loading Employee Conversations">
          <p>Checking your verified access and supervisory scope.</p>
        </DataStatePanel>
      ) : null}

      {workspaceQuery.isError ? (
        <DataStatePanel icon={XCircle} tone="error" title="Employee Conversations unavailable">
          <p>{workspaceQuery.error.message}</p>
          <button className="secondary-button" onClick={() => workspaceQuery.refetch()} type="button">Try again</button>
        </DataStatePanel>
      ) : null}

      {workspaceQuery.data && !selectedEmployeeId ? (
        <section className="employee-conversations-picker panel">
          <div className="section-heading">
            <div><p className="eyebrow">Start here</p><h2>Who did you speak with?</h2><p>Search by legal name, employee number, title, or assigned supervisor.</p></div>
            <span className="employee-conversations-picker__scope">{workspaceQuery.data.canReviewAll ? 'Approved companywide scope' : 'Your assigned employees'}</span>
          </div>
          <label className="search-field search-field--wide">
            <Search aria-hidden="true" size={20} />
            <span className="visually-hidden">Find an employee</span>
            <input autoFocus onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search employee name or number" type="search" value={employeeSearch} />
          </label>
          {matchingEmployees.length ? (
            <div className="employee-conversations-employee-list">
              {matchingEmployees.map((employee) => (
                <button key={employee.id} onClick={() => chooseEmployee(employee.id)} type="button">
                  <span className="employee-conversations-avatar" aria-hidden="true">{employee.name.split(' ').slice(0, 2).map((part) => part[0]).join('')}</span>
                  <span><strong>{employee.name}</strong><small>{employee.employeeNumber ?? 'Employee number pending'} · {employee.jobTitle || 'Title not recorded'}</small></span>
                  <span><small>Supervisor</small><strong>{employee.supervisorName ?? 'Unassigned'}</strong></span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <div className="compact-empty"><UserRound aria-hidden="true" /><span>No authorized employees match this search.</span></div>
          )}
        </section>
      ) : null}

      {workspaceQuery.data?.selectedEmployee ? (
        <>
          <section className="employee-conversations-person panel">
            <button className="employee-conversations-back" onClick={clearEmployee} type="button"><ArrowLeft aria-hidden="true" />Choose another employee</button>
            <div className="employee-conversations-person__main">
              <span className="employee-conversations-avatar employee-conversations-avatar--large" aria-hidden="true">{workspaceQuery.data.selectedEmployee.name.split(' ').slice(0, 2).map((part) => part[0]).join('')}</span>
              <div><p className="eyebrow">Conversation record</p><h2>{workspaceQuery.data.selectedEmployee.name}</h2><p>{workspaceQuery.data.selectedEmployee.employeeNumber ?? 'Employee number pending'} · {workspaceQuery.data.selectedEmployee.jobTitle || 'Title not recorded'}</p></div>
              <div><span>Assigned supervisor</span><strong>{workspaceQuery.data.selectedEmployee.supervisorName ?? 'Unassigned'}</strong></div>
              {workspaceQuery.data.canCreate && ['onboarding', 'active', 'leave'].includes(workspaceQuery.data.selectedEmployee.status) ? <button className="primary-action" onClick={openCreateWizard} type="button"><Plus aria-hidden="true" />Record conversation</button> : null}
            </div>
          </section>

          <section className="employee-conversations-summary" aria-label="Conversation summary">
            <article><MessageSquareText aria-hidden="true" /><span>Current records</span><strong>{workspaceQuery.data.summary.total}</strong></article>
            <article><ClipboardList aria-hidden="true" /><span>Follow-up open</span><strong>{workspaceQuery.data.summary.open}</strong></article>
            <article><GraduationCap aria-hidden="true" /><span>Training records</span><strong>{workspaceQuery.data.summary.training}</strong></article>
            <article className={workspaceQuery.data.summary.followUpDue ? 'is-due' : ''}><History aria-hidden="true" /><span>Follow-up due</span><strong>{workspaceQuery.data.summary.followUpDue}</strong></article>
          </section>

          <section className="employee-conversations-notice">
            <ShieldCheck aria-hidden="true" />
            <div><strong>Internal supervisory record</strong><p>This does not create discipline, attendance points, payroll changes, or an employee acknowledgment. Use the formal Corrective Action workflow when HR review and employee delivery are required.</p></div>
            <Link to={`/hr/cases-compliance?employeeId=${encodeURIComponent(workspaceQuery.data.selectedEmployee.id)}`}>Open formal HR workflow<ChevronRight aria-hidden="true" /></Link>
          </section>

          <section className="employee-conversations-worklist panel">
            <div className="section-heading">
              <div><p className="eyebrow">Permanent timeline</p><h2>Conversation history</h2><p>Nothing is silently overwritten. Follow-ups, completion, reopening, and voids remain in history.</p></div>
              <div className="employee-conversations-filters">
                <label><span>Type</span><select onChange={(event) => { setTypeFilter(event.target.value as typeof typeFilter); setPage(1) }} value={typeFilter}><option value="all">All types</option>{Object.entries(employeeConversationTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Status</span><select onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); setPage(1) }} value={statusFilter}><option value="active">Current records</option><option value="open">Follow-up open</option><option value="completed">Complete</option>{workspaceQuery.data.canReviewAll ? <option value="voided">Voided</option> : null}<option value="all">All records</option></select></label>
              </div>
            </div>

            {workspaceQuery.data.items.length ? (
              <div className="employee-conversations-list">
                {workspaceQuery.data.items.map((item) => {
                  const expanded = expandedRecordId === item.id
                  return (
                    <article className={`employee-conversation-card employee-conversation-card--${item.status}`} key={item.id}>
                      <header>
                        <div><span className={`employee-conversation-type employee-conversation-type--${item.conversationType}`}>{employeeConversationTypeLabels[item.conversationType]}</span><h3>{item.subject}</h3><p>{formatDate(item.occurredOn)} · Recorded by {item.createdByName}</p></div>
                        <div><span className={`employee-conversation-status employee-conversation-status--${item.status}`}>{statusLabel(item.status)}</span><button aria-expanded={expanded} className="secondary-button secondary-button--small" onClick={() => setExpandedRecordId(expanded ? null : item.id)} type="button"><Eye aria-hidden="true" />{expanded ? 'Hide details' : 'View details'}</button></div>
                      </header>
                      <div className="employee-conversation-card__summary"><p>{item.factualSummary}</p>{item.followUpOn ? <span className="employee-conversation-follow-up">Follow up {formatDate(item.followUpOn)}</span> : null}</div>
                      {expanded ? (
                        <div className="employee-conversation-detail">
                          <section><h4>Factual summary</h4><p>{item.factualSummary}</p></section>
                          <section><h4>Expectations / next steps</h4><p>{item.expectations || 'No separate next step was recorded.'}</p></section>
                          <dl><div><dt>Employee participated</dt><dd>{item.employeePresent ? 'Yes' : 'No'}</dd></div><div><dt>Created</dt><dd>{formatDateTime(item.createdAt)}</dd></div><div><dt>Last activity</dt><dd>{formatDateTime(item.updatedAt)}</dd></div></dl>
                          <details className="employee-conversation-history"><summary><History aria-hidden="true" />Permanent activity history ({item.events.length})</summary><ol>{item.events.map((event) => <li key={event.id}><span /><div><strong>{eventLabels[event.eventType]}</strong><small>{event.actorName} · {formatDateTime(event.occurredAt)}</small><p>{event.note}</p></div></li>)}</ol></details>
                          {item.canManage ? <div className="employee-conversation-actions">{item.status === 'open' ? <><button className="secondary-button" onClick={() => openAction('follow_up', item)} type="button"><Plus aria-hidden="true" />Add follow-up</button><button className="primary-action" onClick={() => openAction('complete', item)} type="button"><CheckCircle2 aria-hidden="true" />Mark complete</button></> : item.status === 'completed' ? <button className="secondary-button" onClick={() => openAction('reopen', item)} type="button"><RotateCcw aria-hidden="true" />Reopen for follow-up</button> : null}{item.canVoid ? <button className="secondary-button employee-conversation-void" onClick={() => openAction('void', item)} type="button"><XCircle aria-hidden="true" />Void incorrect record</button> : null}</div> : null}
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </div>
            ) : <div className="compact-empty"><MessageSquareText aria-hidden="true" /><span>No conversation records match these filters.</span></div>}

            {workspaceQuery.data.total > 0 ? <div className="employee-conversations-pagination"><span>Showing {offset + 1}–{Math.min(offset + pageSize, workspaceQuery.data.total)} of {workspaceQuery.data.total}</span><label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} value={pageSize}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label><button className="secondary-button secondary-button--small" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">Previous</button><span>Page {page} of {pageCount}</span><button className="secondary-button secondary-button--small" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} type="button">Next</button></div> : null}
          </section>
        </>
      ) : null}

      {wizardOpen && workspaceQuery.data?.selectedEmployee ? (
        <ModalDialog busy={createMutation.isPending} busyLabel="Saving the permanent conversation record…" className="modal-dialog--employee-conversation" description={`For ${workspaceQuery.data.selectedEmployee.name}. SygShift will show the exact record for review before saving.`} onClose={() => setWizardOpen(false)} title="Record an employee conversation">
          <form className="employee-conversation-wizard" onSubmit={submitConversation}>
            <nav aria-label="Conversation steps">{['Details', 'Facts', 'Next steps', 'Review'].map((label, index) => <span className={wizardStep === index + 1 ? 'is-current' : wizardStep > index + 1 ? 'is-complete' : ''} key={label}><b>{wizardStep > index + 1 ? <Check aria-hidden="true" /> : index + 1}</b>{label}</span>)}</nav>
            {wizardStep === 1 ? <section className="employee-conversation-wizard__step"><p className="eyebrow">Step 1 of 4</p><h3>What kind of conversation was this?</h3><div className="employee-conversation-type-grid">{(Object.keys(employeeConversationTypeLabels) as EmployeeConversationType[]).map((type) => <button className={draft.conversationType === type ? 'is-selected' : ''} key={type} onClick={() => setDraft({ ...draft, conversationType: type })} type="button"><strong>{employeeConversationTypeLabels[type]}</strong><span>{typeGuidance[type]}</span></button>)}</div><div className="form-grid form-grid--two"><label><span>Conversation date</span><input max={todayKey()} onChange={(event) => setDraft({ ...draft, occurredOn: event.target.value })} required type="date" value={draft.occurredOn} /></label><label><span>Short subject</span><input maxLength={180} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} placeholder="Example: Radio procedure refresher" required value={draft.subject} /></label></div></section> : null}
            {wizardStep === 2 ? <section className="employee-conversation-wizard__step"><p className="eyebrow">Step 2 of 4</p><h3>What was discussed or taught?</h3><p>Write observable facts: who, what, when, and the work-related context. Avoid diagnoses, rumors, labels, or assumptions.</p><label className="form-field form-field--wide"><span>Factual summary</span><textarea autoFocus maxLength={10000} onChange={(event) => setDraft({ ...draft, factualSummary: event.target.value })} placeholder="Example: Reviewed the radio check-in steps and had the employee demonstrate the procedure correctly." rows={9} value={draft.factualSummary} /><small>{draft.factualSummary.length.toLocaleString()} / 10,000</small></label><label className="employee-conversation-check"><input checked={draft.employeePresent} onChange={(event) => setDraft({ ...draft, employeePresent: event.target.checked })} type="checkbox" /><span><strong>The employee participated in this conversation</strong><small>Clear this only when documenting a preparation or attempted conversation that did not occur with the employee.</small></span></label></section> : null}
            {wizardStep === 3 ? <section className="employee-conversation-wizard__step"><p className="eyebrow">Step 3 of 4</p><h3>Is anything expected next?</h3><label className="form-field form-field--wide"><span>Expectations or next steps <small>Optional</small></span><textarea autoFocus maxLength={6000} onChange={(event) => setDraft({ ...draft, expectations: event.target.value })} placeholder="Example: Employee will use the reviewed process beginning with the next assigned shift." rows={6} value={draft.expectations} /><small>{draft.expectations.length.toLocaleString()} / 6,000</small></label><label className="form-field"><span>Follow-up date <small>Optional</small></span><input min={draft.occurredOn} onChange={(event) => setDraft({ ...draft, followUpOn: event.target.value })} type="date" value={draft.followUpOn} /><small>{draft.followUpOn ? 'This record will stay open until the follow-up is completed.' : 'With no follow-up date, this record will be saved complete.'}</small></label><div className="employee-conversation-boundary"><ShieldCheck aria-hidden="true" /><span><strong>This record stays internal.</strong>It does not notify the employee or create discipline, attendance points, or payroll consequences.</span></div></section> : null}
            {wizardStep === 4 ? <section className="employee-conversation-wizard__step employee-conversation-review"><p className="eyebrow">Step 4 of 4</p><h3>Review the exact permanent record</h3><dl><div><dt>Employee</dt><dd>{workspaceQuery.data.selectedEmployee.name}</dd></div><div><dt>Type</dt><dd>{employeeConversationTypeLabels[draft.conversationType]}</dd></div><div><dt>Date</dt><dd>{formatDate(draft.occurredOn)}</dd></div><div><dt>Employee participated</dt><dd>{draft.employeePresent ? 'Yes' : 'No'}</dd></div><div><dt>Follow-up</dt><dd>{formatDate(draft.followUpOn || null)}</dd></div></dl><section><h4>{draft.subject}</h4><p>{draft.factualSummary}</p></section><section><h4>Expectations / next steps</h4><p>{draft.expectations.trim() || 'No separate next step recorded.'}</p></section><div className="employee-conversation-boundary"><BookOpenCheck aria-hidden="true" /><span><strong>Ready to save</strong>After saving, changes are recorded as follow-ups, completion, reopening, or a reasoned void. The original record is not silently replaced.</span></div></section> : null}
            {formError ? <div className="inline-alert" role="alert">{formError}</div> : null}
            <div className="modal-actions employee-conversation-wizard__actions"><button className="secondary-button" onClick={() => wizardStep === 1 ? setWizardOpen(false) : setWizardStep((current) => current - 1)} type="button"><ChevronLeft aria-hidden="true" />{wizardStep === 1 ? 'Cancel' : 'Back'}</button>{wizardStep < 4 ? <button className="primary-action" onClick={() => moveWizard(wizardStep + 1)} type="button">Continue<ChevronRight aria-hidden="true" /></button> : <button className="primary-action" type="submit"><ShieldCheck aria-hidden="true" />Save conversation</button>}</div>
          </form>
        </ModalDialog>
      ) : null}

      {pendingAction ? (
        <ModalDialog busy={actionMutation.isPending} busyLabel="Saving the timeline update…" className="modal-dialog--employee-conversation-action" description={pendingAction.action === 'void' ? 'The original record will remain preserved and marked void with your reason.' : 'This update will be appended to the permanent activity history.'} onClose={() => setPendingAction(null)} title={pendingAction.action === 'follow_up' ? `Add follow-up: ${pendingAction.item.subject}` : pendingAction.action === 'complete' ? `Complete: ${pendingAction.item.subject}` : pendingAction.action === 'reopen' ? `Reopen: ${pendingAction.item.subject}` : `Void incorrect record: ${pendingAction.item.subject}`}>
          <form className="employee-conversation-action-form" onSubmit={submitAction}>
            {['follow_up', 'reopen'].includes(pendingAction.action) ? <label className="form-field"><span>Next follow-up date <small>Optional</small></span><input min={pendingAction.item.occurredOn} onChange={(event) => setActionFollowUpOn(event.target.value)} type="date" value={actionFollowUpOn} /></label> : null}
            <label className="form-field form-field--wide"><span>{pendingAction.action === 'void' ? 'Why is this record incorrect?' : pendingAction.action === 'complete' ? 'Completion outcome' : pendingAction.action === 'reopen' ? 'Why is more follow-up needed?' : 'Follow-up note'}</span><textarea autoFocus maxLength={pendingAction.action === 'void' ? 2000 : 10000} onChange={(event) => setActionNote(event.target.value)} rows={6} value={actionNote} /></label>
            {formError ? <div className="inline-alert" role="alert">{formError}</div> : null}
            <div className="modal-actions"><button className="secondary-button" onClick={() => setPendingAction(null)} type="button">Cancel</button><button className={pendingAction.action === 'void' ? 'primary-action employee-conversation-danger' : 'primary-action'} type="submit">{pendingAction.action === 'follow_up' ? 'Save follow-up' : pendingAction.action === 'complete' ? 'Mark complete' : pendingAction.action === 'reopen' ? 'Reopen record' : 'Void record'}</button></div>
          </form>
        </ModalDialog>
      ) : null}
    </main>
  )
}

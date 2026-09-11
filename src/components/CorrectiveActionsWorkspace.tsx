import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Eye, Plus, Send, ShieldCheck, X } from 'lucide-react'
import {
  closeGuidedCorrectiveAction,
  createGuidedCorrectiveAction,
  deliverGuidedCorrectiveAction,
  getGuidedCorrectiveActions,
  reviewGuidedCorrectiveAction,
  type CorrectiveActionManagerItem,
} from '../data/correctiveActions'
import { ModalDialog } from './ModalDialog'

const levels = [
  ['coaching', 'Coaching record'],
  ['written_warning', 'Written warning'],
  ['final_warning', 'Final warning'],
  ['performance_improvement', 'Performance improvement plan'],
] as const

const emptyDraft = {
  employeeId: '', actionLevel: 'coaching' as CorrectiveActionManagerItem['actionLevel'], title: '', occurredOn: new Date().toISOString().slice(0, 10),
  factualSummary: '', policyExpectation: '', improvementExpectation: '', followUpOn: '', submissionReason: '',
}

function label(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }
function date(value: string | null) { return value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`)) : 'Not set' }
function dateTime(value: string | null) { return value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not yet' }

type PendingAction = { kind: 'approve' | 'cancel' | 'deliver' | 'close'; item: CorrectiveActionManagerItem }

export function CorrectiveActionsWorkspace({ actorEmployeeId, onChanged }: { actorEmployeeId: string; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [step, setStep] = useState(1)
  const [draft, setDraft] = useState(emptyDraft)
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const workspaceQuery = useQuery({ queryKey: ['guided-corrective-actions'], queryFn: () => getGuidedCorrectiveActions() })
  const filteredEmployees = useMemo(() => {
    const search = employeeSearch.trim().toLowerCase()
    return (workspaceQuery.data?.employees ?? []).filter((employee) => !search || `${employee.name} ${employee.employeeNumber ?? ''}`.toLowerCase().includes(search)).slice(0, 20)
  }, [employeeSearch, workspaceQuery.data?.employees])

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['guided-corrective-actions'] })
    onChanged()
  }

  const createMutation = useMutation({
    mutationFn: createGuidedCorrectiveAction,
    onSuccess: async () => { setCreating(false); setStep(1); setDraft(emptyDraft); setEmployeeSearch(''); await refresh() },
    onError: (nextError: Error) => setError(nextError.message),
  })
  const actionMutation = useMutation({
    mutationFn: async ({ kind, item, actionReason }: PendingAction & { actionReason: string }) => {
      if (kind === 'approve' || kind === 'cancel') return reviewGuidedCorrectiveAction(item.id, kind === 'approve' ? 'approved' : 'canceled', actionReason)
      if (kind === 'deliver') return deliverGuidedCorrectiveAction(item.id, actionReason)
      return closeGuidedCorrectiveAction(item.id, actionReason)
    },
    onSuccess: async () => { setPendingAction(null); setReason(''); await refresh() },
    onError: (nextError: Error) => setError(nextError.message),
  })

  function validateStep(next: number) {
    setError(null)
    if (step === 1 && (!draft.employeeId || !draft.title.trim() || !draft.occurredOn)) return setError('Choose an employee, date, level, and clear title.')
    if (step === 2 && draft.factualSummary.trim().length < 8) return setError('Describe the observed facts in at least 8 characters.')
    if (step === 3 && (draft.policyExpectation.trim().length < 8 || draft.improvementExpectation.trim().length < 8)) return setError('Explain both the expectation and the improvement needed.')
    setStep(next)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (draft.submissionReason.trim().length < 8) return setError('Explain why this record is being submitted for HR review.')
    createMutation.mutate({ ...draft, followUpOn: draft.followUpOn || null })
  }

  return (
    <section className="panel corrective-workspace">
      <div className="section-heading">
        <div><p className="eyebrow">Guided workflow</p><h2>Corrective actions</h2><p>Create a factual record, route it to a different HR reviewer, deliver it privately, and preserve the employee’s exact response.</p></div>
        <button className="primary-action" onClick={() => { setCreating(true); setStep(1); setError(null) }} type="button"><Plus aria-hidden="true" size={17} />New corrective action</button>
      </div>
      {workspaceQuery.data ? <div className="corrective-summary"><article><span>Needs HR review</span><strong>{workspaceQuery.data.summary.pendingReview}</strong></article><article><span>Ready to deliver</span><strong>{workspaceQuery.data.summary.readyToDeliver}</strong></article><article><span>Awaiting employee</span><strong>{workspaceQuery.data.summary.awaitingEmployee}</strong></article><article><span>Follow-up due</span><strong>{workspaceQuery.data.summary.followUpDue}</strong></article></div> : null}
      {workspaceQuery.isPending ? <p>Loading protected corrective-action records…</p> : null}
      {workspaceQuery.isError ? <div className="inline-alert" role="alert">{workspaceQuery.error.message}</div> : null}
      {workspaceQuery.data && !workspaceQuery.data.items.length ? <div className="compact-empty"><ClipboardCheck aria-hidden="true" size={24} /><span>No corrective actions have been created.</span></div> : null}
      {workspaceQuery.data?.items.length ? <div className="corrective-list">{workspaceQuery.data.items.map((item) => {
        const ownProposal = item.proposedById === actorEmployeeId
        return <article key={item.id}>
          <header><div><span className={`action-status action-status--${item.status}`}>{label(item.status)}</span><h3>{item.title}</h3><p>{item.employeeName}{item.employeeNumber ? ` · ${item.employeeNumber}` : ''} · Case #{item.caseNumber}</p></div><button aria-expanded={expanded === item.id} className="secondary-button secondary-button--small" onClick={() => setExpanded(expanded === item.id ? null : item.id)} type="button"><Eye aria-hidden="true" size={16} />{expanded === item.id ? 'Hide' : 'Review record'}</button></header>
          <div className="corrective-list__facts"><span>{label(item.actionLevel)}</span><span>Occurred {date(item.occurredOn)}</span><span>Proposed by {item.proposedByName}</span></div>
          {expanded === item.id ? <div className="corrective-detail"><section><h4>Observed facts</h4><p>{item.factualSummary}</p></section><section><h4>Policy or expectation</h4><p>{item.policyExpectation}</p></section><section><h4>Improvement needed</h4><p>{item.improvementExpectation}</p></section><section><h4>Employee response</h4><p>{item.response ? `${label(item.response.type)}${item.response.statement ? ` — ${item.response.statement}` : ''}` : 'No response recorded yet.'}</p></section><details><summary>Permanent activity history ({item.events.length})</summary><ol>{item.events.map((event) => <li key={event.id}><strong>{label(event.action)}</strong><span>{event.actorName} · {dateTime(event.occurredAt)}</span><p>{event.reason}</p></li>)}</ol></details></div> : null}
          <footer>
            {item.status === 'pending_hr_review' && ownProposal ? <span className="corrective-guidance"><ShieldCheck aria-hidden="true" size={16} />Waiting for a different qualified HR reviewer.</span> : null}
            {item.status === 'pending_hr_review' && !ownProposal ? <><button className="primary-action" onClick={() => { setPendingAction({ kind: 'approve', item }); setError(null) }} type="button"><Check aria-hidden="true" size={16} />Approve</button><button className="secondary-button" onClick={() => { setPendingAction({ kind: 'cancel', item }); setError(null) }} type="button"><X aria-hidden="true" size={16} />Return / cancel</button></> : null}
            {item.status === 'approved' ? <button className="primary-action" onClick={() => { setPendingAction({ kind: 'deliver', item }); setError(null) }} type="button"><Send aria-hidden="true" size={16} />Deliver privately</button> : null}
            {['delivered', 'employee_responded'].includes(item.status) ? <button className="primary-action" onClick={() => { setPendingAction({ kind: 'close', item }); setError(null) }} type="button"><CheckCircle2 aria-hidden="true" size={16} />Close with outcome</button> : null}
          </footer>
        </article>
      })}</div> : null}

      {creating ? <ModalDialog busy={createMutation.isPending} busyLabel="Submitting for HR review…" className="modal-dialog--corrective" description="SygShift walks you through one decision at a time. Nothing is delivered to the employee until a different HR reviewer approves it." onClose={() => setCreating(false)} title="Create a corrective action">
        <form className="corrective-wizard" onSubmit={submit}>
          <nav aria-label="Corrective action steps">{['Employee', 'Facts', 'Expectations', 'Review'].map((name, index) => <span className={step === index + 1 ? 'is-current' : step > index + 1 ? 'is-complete' : ''} key={name}><b>{step > index + 1 ? <Check size={14} /> : index + 1}</b>{name}</span>)}</nav>
          {step === 1 ? <div className="corrective-wizard__step"><h3>Who and what is this about?</h3><label className="form-field form-field--wide"><span>Find employee</span><input autoFocus onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search by name or employee number" value={employeeSearch} /></label><div className="corrective-employee-results">{filteredEmployees.map((employee) => <button className={draft.employeeId === employee.id ? 'is-selected' : ''} key={employee.id} onClick={() => { setDraft({ ...draft, employeeId: employee.id }); setEmployeeSearch(employee.name) }} type="button"><strong>{employee.name}</strong><span>{employee.employeeNumber ?? 'No employee number'}</span></button>)}</div><label className="form-field"><span>Level</span><select onChange={(event) => setDraft({ ...draft, actionLevel: event.target.value as CorrectiveActionManagerItem['actionLevel'] })} value={draft.actionLevel}>{levels.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="form-field"><span>Occurrence date</span><input onChange={(event) => setDraft({ ...draft, occurredOn: event.target.value })} type="date" value={draft.occurredOn} /></label><label className="form-field form-field--wide"><span>Record title</span><input onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Short, factual title" value={draft.title} /></label></div> : null}
          {step === 2 ? <div className="corrective-wizard__step"><h3>Record only the observed facts</h3><p>Use dates, actions, witnesses, and direct observations. Avoid assumptions or labels.</p><label className="form-field form-field--wide"><span>What happened?</span><textarea autoFocus maxLength={10000} onChange={(event) => setDraft({ ...draft, factualSummary: event.target.value })} placeholder="Describe what was observed, when it occurred, and the work impact." rows={9} value={draft.factualSummary} /><small>{draft.factualSummary.length.toLocaleString()} / 10,000</small></label></div> : null}
          {step === 3 ? <div className="corrective-wizard__step"><h3>Explain the expectation and next step</h3><label className="form-field form-field--wide"><span>Policy or job expectation</span><textarea autoFocus maxLength={6000} onChange={(event) => setDraft({ ...draft, policyExpectation: event.target.value })} rows={5} value={draft.policyExpectation} /></label><label className="form-field form-field--wide"><span>Improvement required</span><textarea maxLength={6000} onChange={(event) => setDraft({ ...draft, improvementExpectation: event.target.value })} rows={5} value={draft.improvementExpectation} /></label><label className="form-field"><span>Follow-up date (optional)</span><input min={draft.occurredOn} onChange={(event) => setDraft({ ...draft, followUpOn: event.target.value })} type="date" value={draft.followUpOn} /></label></div> : null}
          {step === 4 ? <div className="corrective-wizard__step corrective-review"><h3>Review before submitting</h3><dl><div><dt>Employee</dt><dd>{workspaceQuery.data?.employees.find((employee) => employee.id === draft.employeeId)?.name}</dd></div><div><dt>Level</dt><dd>{label(draft.actionLevel)}</dd></div><div><dt>Occurred</dt><dd>{date(draft.occurredOn)}</dd></div><div><dt>Title</dt><dd>{draft.title}</dd></div></dl><section><h4>Observed facts</h4><p>{draft.factualSummary}</p></section><section><h4>Expectation</h4><p>{draft.policyExpectation}</p></section><section><h4>Improvement needed</h4><p>{draft.improvementExpectation}</p></section><label className="form-field form-field--wide"><span>Why are you submitting this for HR review?</span><textarea autoFocus maxLength={4000} onChange={(event) => setDraft({ ...draft, submissionReason: event.target.value })} rows={4} value={draft.submissionReason} /></label><p className="corrective-guidance"><ShieldCheck aria-hidden="true" size={17} />A different qualified HR reviewer must approve this record before it can be delivered.</p></div> : null}
          {error ? <div className="inline-alert" role="alert">{error}</div> : null}
          <div className="modal-actions"><button className="secondary-button" onClick={() => step === 1 ? setCreating(false) : setStep(step - 1)} type="button"><ChevronLeft aria-hidden="true" size={17} />{step === 1 ? 'Cancel' : 'Back'}</button>{step < 4 ? <button className="primary-action" onClick={() => validateStep(step + 1)} type="button">Continue<ChevronRight aria-hidden="true" size={17} /></button> : <button className="primary-action" type="submit"><ShieldCheck aria-hidden="true" size={17} />Submit for HR review</button>}</div>
        </form>
      </ModalDialog> : null}

      {pendingAction ? <ModalDialog busy={actionMutation.isPending} busyLabel="Saving protected decision…" description={pendingAction.kind === 'approve' ? 'Approval makes the record ready for private delivery. It does not send it yet.' : pendingAction.kind === 'deliver' ? 'The employee will receive one private notification and email, then respond in Action Center.' : 'Your reason becomes part of the permanent protected history.'} onClose={() => setPendingAction(null)} title={`${label(pendingAction.kind)}: ${pendingAction.item.title}`}>
        <form className="corrective-decision" onSubmit={(event) => { event.preventDefault(); setError(null); if (reason.trim().length < 8) return setError('Enter a clear reason of at least 8 characters.'); actionMutation.mutate({ ...pendingAction, actionReason: reason.trim() }) }}><label className="form-field"><span>{pendingAction.kind === 'deliver' ? 'Private delivery note' : 'Decision reason'}</span><textarea autoFocus maxLength={4000} onChange={(event) => setReason(event.target.value)} required rows={5} value={reason} /></label>{error ? <div className="inline-alert" role="alert">{error}</div> : null}<div className="modal-actions"><button className="secondary-button" onClick={() => setPendingAction(null)} type="button">Cancel</button><button className="primary-action" type="submit">Confirm {label(pendingAction.kind)}</button></div></form>
      </ModalDialog> : null}
    </section>
  )
}

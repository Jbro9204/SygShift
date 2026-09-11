import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardList,
  FileText,
  History,
  ShieldCheck,
  UserRoundCheck,
  XCircle,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  cancelHrLifecycleCase,
  executeHrLifecycleCase,
  getHrLifecycleCase,
  reviewHrLifecycleCase,
  updateHrLifecycleTask,
  type HrLifecycleTask,
  type HrOffboardingOptions,
} from '../data/hrOffboarding'
import { formatOperationalDateTime } from '../lib/time'
import { DataStatePanel } from './DataStatePanel'
import { ModalDialog } from './ModalDialog'

const lifecycleLabels: Record<string, string> = {
  voluntary_resignation: 'Voluntary resignation',
  involuntary_termination: 'Involuntary termination',
  job_abandonment: 'Job abandonment',
  end_of_assignment: 'End of assignment',
  rehire: 'Rehire',
}

function displayStatus(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatDate(value: string | null) {
  if (!value) return 'Not set'
  const [year, month, day] = value.split('-')
  return `${month}/${day}/${year}`
}

function TaskEditor({ options, onSaved, task }: { options: HrOffboardingOptions; onSaved: () => void; task: HrLifecycleTask }) {
  const [status, setStatus] = useState<'ready' | 'in_progress' | 'blocked' | 'completed' | 'waived'>(
    ['ready', 'in_progress', 'blocked', 'completed', 'waived'].includes(task.status)
      ? task.status as 'ready' | 'in_progress' | 'blocked' | 'completed' | 'waived'
      : 'ready',
  )
  const [assignedTo, setAssignedTo] = useState(task.assignedTo ?? '')
  const [dueOn, setDueOn] = useState(task.dueOn ?? '')
  const [note, setNote] = useState(task.evidenceNote ?? '')
  const mutation = useMutation({
    mutationFn: updateHrLifecycleTask,
    onSuccess: onSaved,
  })
  const needsEvidence = status === 'completed' || status === 'waived'

  return <form className="hr-lifecycle-task-editor" onSubmit={(event) => {
    event.preventDefault()
    mutation.mutate({ assignedTo: assignedTo || null, dueOn: dueOn || null, note: note.trim() || null, status, taskId: task.id })
  }}>
    <label><span>Status</span><select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}><option value="ready">Ready</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="completed">Completed</option><option value="waived">Waived with reason</option></select></label>
    <label><span>Owner</span><select onChange={(event) => setAssignedTo(event.target.value)} value={assignedTo}><option value="">Choose an owner</option>{options.owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>
    <label><span>Due date</span><input onChange={(event) => setDueOn(event.target.value)} type="date" value={dueOn} /></label>
    <label className="wide"><span>{status === 'waived' ? 'Required waiver reason' : needsEvidence ? 'Required completion evidence' : 'Work note'}</span><textarea minLength={needsEvidence ? 3 : undefined} onChange={(event) => setNote(event.target.value)} placeholder={status === 'waived' ? 'Explain why this required item does not apply.' : 'Record what was verified, completed, or is blocking progress.'} required={needsEvidence} rows={3} value={note} /></label>
    {mutation.isError ? <p className="form-error wide" role="alert">{mutation.error.message}</p> : null}
    <div className="wide"><button className="primary-action primary-action--small" disabled={mutation.isPending || (needsEvidence && note.trim().length < 3)} type="submit">Save checklist item</button></div>
  </form>
}

export function HrLifecycleCaseDialog({ caseId, onClose, onUpdated, options }: { caseId: string; onClose: () => void; onUpdated: () => void; options: HrOffboardingOptions }) {
  const queryClient = useQueryClient()
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [reviewDecision, setReviewDecision] = useState<'approved' | 'denied'>('approved')
  const [reviewReason, setReviewReason] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [executeReason, setExecuteReason] = useState('')
  const [confirmationUsername, setConfirmationUsername] = useState('')
  const [action, setAction] = useState<'review' | 'cancel' | 'execute' | null>(null)
  const caseQuery = useQuery({ queryKey: ['hr-lifecycle-case', caseId], queryFn: () => getHrLifecycleCase(caseId) })
  const data = caseQuery.data
  const selectedTask = useMemo(() => data?.tasks.find((task) => task.id === selectedTaskId) ?? null, [data?.tasks, selectedTaskId])
  const reviewMutation = useMutation({ mutationFn: reviewHrLifecycleCase, onSuccess: refresh })
  const cancelMutation = useMutation({ mutationFn: cancelHrLifecycleCase, onSuccess: refresh })
  const executeMutation = useMutation({ mutationFn: executeHrLifecycleCase, onSuccess: refresh })
  const busy = reviewMutation.isPending || cancelMutation.isPending || executeMutation.isPending

  async function refresh() {
    setAction(null)
    setSelectedTaskId(null)
    setReviewReason('')
    setCancelReason('')
    setExecuteReason('')
    setConfirmationUsername('')
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hr-lifecycle-case', caseId] }),
      queryClient.invalidateQueries({ queryKey: ['hr-stage9-workspace', 'offboarding'] }),
      queryClient.invalidateQueries({ queryKey: ['hris-people'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] }),
    ])
    onUpdated()
  }

  useEffect(() => {
    if (data?.case.status === 'completed') setAction(null)
  }, [data?.case.status])

  return <ModalDialog
    busy={busy}
    busyLabel="Saving the protected lifecycle action…"
    className="hr-lifecycle-case-modal"
    description="One protected timeline for approval, handoffs, documents, and final execution."
    eyebrow="Employee Lifecycle"
    headingIcon={<ShieldCheck aria-hidden="true" size={21} />}
    onClose={onClose}
    title={data ? `${data.case.employeeName} · ${lifecycleLabels[data.case.lifecycleType]}` : 'Employee lifecycle case'}
  >
    {caseQuery.isPending ? <DataStatePanel icon={ClipboardList} title="Loading lifecycle case"><p>Checking the protected case and checklist.</p></DataStatePanel> : null}
    {caseQuery.isError ? <DataStatePanel icon={AlertTriangle} title="Lifecycle case unavailable" tone="error"><p>{caseQuery.error.message}</p></DataStatePanel> : null}
    {data ? <div className="hr-lifecycle-case">
      <ol aria-label="Lifecycle progress" className="hr-lifecycle-case__progress">
        {[
          { key: 'request', label: 'Request', complete: true },
          { key: 'approval', label: 'Approval', complete: !['pending_approval', 'draft'].includes(data.case.status) },
          { key: 'checklist', label: 'Checklist', complete: data.progress.total > 0 && data.progress.done === data.progress.total },
          { key: 'final', label: 'Final action', complete: data.case.status === 'completed' },
        ].map((item) => <li className={item.complete ? 'is-complete' : ''} key={item.key}><span>{item.complete ? <Check aria-hidden="true" size={14} /> : null}</span>{item.label}</li>)}
      </ol>

      <section className="hr-lifecycle-case__summary">
        <div><span className={`action-status is-${data.case.status}`}>{displayStatus(data.case.status)}</span><h3>{data.case.employeeName}</h3><p>@{data.case.username} · {displayStatus(data.case.employeeRole)}</p></div>
        <dl><div><dt>Effective date</dt><dd>{formatDate(data.case.effectiveOn)}</dd></div><div><dt>Opened by</dt><dd>{data.case.requestedByName}</dd></div><div><dt>Approval</dt><dd>{data.case.approvedByName ?? 'Pending'}</dd></div><div><dt>Checklist</dt><dd>{data.progress.done} of {data.progress.total} complete or waived</dd></div></dl>
        <p className="hr-lifecycle-case__reason"><strong>Protected business reason</strong>{data.case.requestReason}</p>
        {data.case.decisionReason ? <p className="hr-lifecycle-case__reason"><strong>Approval decision</strong>{data.case.decisionReason}</p> : null}
      </section>

      {data.case.status === 'denied' || data.case.status === 'canceled' ? <div className="hr-lifecycle-terminal"><XCircle aria-hidden="true" /><div><strong>This case is {data.case.status}.</strong><p>No employment or access change was made by this case.</p></div></div> : null}
      {data.case.status === 'completed' ? <div className="hr-lifecycle-terminal is-complete"><CheckCircle2 aria-hidden="true" /><div><strong>Final action completed.</strong><p>{data.case.caseType === 'rehire' ? 'The employee moved to Onboarding. Prior access, MFA, pay, licenses, and assignments were not reactivated.' : 'Employment was separated and access was disabled through the canonical termination transaction.'}</p></div></div> : null}

      <section className="hr-lifecycle-case__conditions">
        <div><p className="eyebrow">Live readiness checks</p><h3>Records that need attention</h3></div>
        <div><span><strong>{data.conditions.futureAssignments}</strong>Future assignments</span><span><strong>{data.conditions.pendingCorrections}</strong>Pending time corrections</span><span><strong>{data.conditions.assignedAssets}</strong>Assigned assets</span><span><strong>{data.conditions.activeEmployeeCases}</strong>Active restricted cases</span>{data.conditions.onLeave ? <span><strong>Yes</strong>Employee currently on leave</span> : null}</div>
        <small>These are live references—not copied records. Use the matching checklist item to document the review or authorized waiver.</small>
      </section>

      <section className="hr-lifecycle-case__checklist">
        <div className="section-heading"><div><p className="eyebrow">Required handoffs</p><h3>Offboarding checklist</h3><p>Every item remains open until someone records the work or a reasoned waiver.</p></div><span>{data.progress.done}/{data.progress.total}</span></div>
        <div className="hr-lifecycle-task-list">{data.tasks.map((task) => <article className={task.status === 'completed' || task.status === 'waived' ? 'is-done' : ''} key={task.id}>
          <div className="hr-lifecycle-task-list__icon">{task.status === 'completed' || task.status === 'waived' ? <CheckCircle2 aria-hidden="true" /> : <CalendarClock aria-hidden="true" />}</div>
          <div><strong>{task.label}</strong><span>{task.assignedToName ?? 'Owner needed'} · due {formatDate(task.dueOn)}</span>{task.evidenceNote ? <small>{task.evidenceNote}</small> : null}</div>
          <span className="action-status">{displayStatus(task.status)}</span>
          {data.case.canManage ? <button className="secondary-button secondary-button--small" onClick={() => setSelectedTaskId((current) => current === task.id ? null : task.id)} type="button">{selectedTaskId === task.id ? 'Close' : 'Update'}</button> : null}
          {selectedTaskId === task.id && selectedTask ? <TaskEditor key={`${selectedTask.id}-${selectedTask.status}-${selectedTask.assignedTo}-${selectedTask.dueOn}`} onSaved={refresh} options={options} task={selectedTask} /> : null}
        </article>)}</div>
      </section>

      <section className="hr-lifecycle-case__documents">
        <div className="section-heading"><div><p className="eyebrow">Connected forms</p><h3>Approved HR documents</h3><p>These reference the controlled library source. No file or employee fact is copied into the case.</p></div></div>
        <div>{data.documents.map((document) => <article key={document.id}><FileText aria-hidden="true" /><span><strong>{document.formCode} · {document.title}</strong><small>{displayStatus(document.sensitivity)} · {document.available ? 'Source available' : 'Indexed source awaiting approved upload'}</small></span><Link className="secondary-button secondary-button--small" to={`/hr/documents?library=${encodeURIComponent(document.formCode)}`}>Open Document Studio</Link></article>)}</div>
      </section>

      {data.case.canReview ? <section className="hr-lifecycle-case__decision"><div><UserRoundCheck aria-hidden="true" /><span><strong>Independent approval required</strong><small>Approval starts the checklist. It does not terminate employment or restore access.</small></span><button className="primary-action primary-action--small" onClick={() => setAction(action === 'review' ? null : 'review')} type="button">Review request</button></div>{action === 'review' ? <form onSubmit={(event: FormEvent) => { event.preventDefault(); reviewMutation.mutate({ caseId, decision: reviewDecision, reason: reviewReason.trim() }) }}><label><span>Decision</span><select onChange={(event) => setReviewDecision(event.target.value as typeof reviewDecision)} value={reviewDecision}><option value="approved">Approve and start checklist</option><option value="denied">Deny request</option></select></label><label><span>Required decision reason</span><textarea minLength={10} onChange={(event) => setReviewReason(event.target.value)} required rows={4} value={reviewReason} /></label>{reviewMutation.isError ? <p className="form-error" role="alert">{reviewMutation.error.message}</p> : null}<button className={reviewDecision === 'denied' ? 'danger-action' : 'primary-action'} disabled={reviewReason.trim().length < 10} type="submit">Record {reviewDecision === 'approved' ? 'approval' : 'denial'}</button></form> : null}</section> : null}

      {data.case.canExecute ? <section className="hr-lifecycle-case__final"><div><ShieldCheck aria-hidden="true" /><span><strong>Final human-confirmed action</strong><small>Available only on or after the approved effective date and after all checklist items are complete or waived.</small></span><button className="danger-action" disabled={data.progress.done !== data.progress.total} onClick={() => setAction(action === 'execute' ? null : 'execute')} type="button">{data.case.caseType === 'rehire' ? 'Begin rehire onboarding' : 'Complete separation'}</button></div>{action === 'execute' ? <form onSubmit={(event: FormEvent) => { event.preventDefault(); executeMutation.mutate({ caseId, confirmationUsername: confirmationUsername.trim(), reason: executeReason.trim() }) }}><div className="hr-lifecycle-final-warning" role="alert"><AlertTriangle aria-hidden="true" /><p>{data.case.caseType === 'rehire' ? 'This moves the employee into Onboarding but does not restore prior access, MFA, pay, licenses, or assignments.' : 'This disables login, revokes remembered access, releases assigned future work, reopens understaffed shifts, and cancels pending future shift requests. History is preserved.'}</p></div><label><span>Final execution reason</span><textarea minLength={10} onChange={(event) => setExecuteReason(event.target.value)} required rows={4} value={executeReason} /></label><label><span>Confirm employee username</span><input autoComplete="off" onChange={(event) => setConfirmationUsername(event.target.value)} placeholder={data.case.username} required value={confirmationUsername} /><small>Enter <strong>{data.case.username}</strong> exactly.</small></label>{executeMutation.isError ? <p className="form-error" role="alert">{executeMutation.error.message}</p> : null}<button className="danger-action" disabled={executeReason.trim().length < 10 || confirmationUsername.trim().toLowerCase() !== data.case.username.toLowerCase()} type="submit">Confirm final action</button></form> : null}</section> : null}

      {data.case.canCancel ? <section className="hr-lifecycle-case__cancel"><button className="secondary-button secondary-button--small" onClick={() => setAction(action === 'cancel' ? null : 'cancel')} type="button">Cancel this case</button>{action === 'cancel' ? <form onSubmit={(event: FormEvent) => { event.preventDefault(); cancelMutation.mutate({ caseId, reason: cancelReason.trim() }) }}><label><span>Required cancellation reason</span><textarea minLength={10} onChange={(event) => setCancelReason(event.target.value)} required rows={3} value={cancelReason} /></label>{cancelMutation.isError ? <p className="form-error" role="alert">{cancelMutation.error.message}</p> : null}<button className="danger-action" disabled={cancelReason.trim().length < 10} type="submit">Confirm cancellation</button></form> : null}</section> : null}

      <details className="hr-lifecycle-case__history"><summary><History aria-hidden="true" />Permanent case timeline <span>{data.events.length}</span></summary><div>{data.events.map((event) => <article key={event.id}><span><strong>{displayStatus(event.action)}</strong><small>{event.actorName} · {formatOperationalDateTime(event.occurredAt)}</small></span><p>{event.reason}</p></article>)}</div></details>
    </div> : null}
  </ModalDialog>
}

import { type FormEvent, type ReactNode, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ClipboardList, FileSignature, Plus, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getHrDocumentWorkspace } from '../data/hrDocuments'
import {
  cancelHrDocumentAssignment,
  createHrDocumentAssignment,
  createHrDocumentRequest,
  getHrDocumentWorkflowWorkspace,
  reviewHrDocumentRequest,
  type HrDocumentAssignment,
  type HrDocumentRequest,
} from '../data/hrDocumentWorkflows'

type PageSize = 5 | 10 | 20
type Composer = 'request' | 'assignment' | null

const dateLabel = (value: string | null) => value ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` : 'No due date'

export function HrisDocumentWorkflowsPage() {
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const [status, setStatus] = useState('')
  const [composer, setComposer] = useState<Composer>(null)
  const [reviewTarget, setReviewTarget] = useState<HrDocumentRequest | null>(null)
  const [cancelTarget, setCancelTarget] = useState<HrDocumentAssignment | null>(null)
  const workflowQuery = useQuery({ queryFn: () => getHrDocumentWorkflowWorkspace({ page, pageSize, status }), queryKey: ['hr-document-workflows', page, pageSize, status] })
  const inventoryQuery = useQuery({ queryFn: () => getHrDocumentWorkspace({ page: 1, pageSize: 20 }), queryKey: ['hr-documents', 'workflow-composer'] })
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['hr-document-workflows'] }),
    client.invalidateQueries({ queryKey: ['my-hr-documents'] }),
  ])

  return <main className="hr-document-workflows-page">
    <header className="hr-documents-hero"><div><p className="eyebrow">HR &amp; Finance</p><h1>Document Workflows</h1><p>Request records, assign exact document versions, and track employee completion without changing original evidence.</p></div><div className="hr-documents-hero__security"><FileSignature aria-hidden="true" size={24}/><div><strong>Audited employee actions</strong><span>Recent MFA and assigned vault permission required</span></div></div></header>
    <nav aria-label="People and HR sections" className="hr-people-tabs"><Link to="/hr">Overview</Link><Link to="/hr/people">People</Link><Link to="/hr/documents">Documents</Link><Link className="active" to="/hr/documents/workflows">Workflows</Link></nav>
    <section className="hr-workflow-commandbar"><div><p className="eyebrow">Workflow queue</p><h2>Requests and assigned documents</h2><p>Keep the list focused; open a record only when action is needed.</p></div><div className="hr-workflow-commandbar__actions"><button className="secondary-button" onClick={() => setComposer('request')} type="button"><Plus size={17}/>Request document</button><button className="primary-action" onClick={() => setComposer('assignment')} type="button"><FileSignature size={17}/>Assign document</button></div></section>
    <section className="hr-workflow-filters"><label>Status<select onChange={(event) => { setStatus(event.target.value); setPage(1) }} value={status}><option value="">All workflow states</option><option value="requested">Requested</option><option value="pending">Pending assignment</option><option value="completed">Completed</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></label><label>Rows<select onChange={(event) => { setPageSize(Number(event.target.value) as PageSize); setPage(1) }} value={pageSize}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label></section>
    {workflowQuery.isPending ? <DataStatePanel icon={ClipboardList} title="Loading document workflows"><p>Checking authorized requests and assignments.</p></DataStatePanel> : null}
    {workflowQuery.isError ? <DataStatePanel icon={AlertTriangle} tone="error" title="Document workflows unavailable"><p>{workflowQuery.error instanceof Error ? workflowQuery.error.message : 'The workflow queue could not be loaded.'}</p></DataStatePanel> : null}
    {workflowQuery.data ? <div className="hr-workflow-grid">
      <WorkflowList title="Document requests" count={workflowQuery.data.pagination.requestTotal} empty="No document requests match this view.">{workflowQuery.data.requests.map((item) => <RequestRow item={item} key={item.id} onReview={() => setReviewTarget(item)}/>)}</WorkflowList>
      <WorkflowList title="Employee assignments" count={workflowQuery.data.pagination.assignmentTotal} empty="No document assignments match this view.">{workflowQuery.data.assignments.map((item) => <AssignmentRow item={item} key={item.id} onCancel={() => setCancelTarget(item)}/>)}</WorkflowList>
    </div> : null}
    {workflowQuery.data ? <div className="hr-documents-pagination"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">Previous</button><span>Page {page}</span><button className="secondary-button" disabled={workflowQuery.data.requests.length < pageSize && workflowQuery.data.assignments.length < pageSize} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div> : null}
    {composer ? <WorkflowComposer employees={inventoryQuery.data?.employees ?? []} documents={inventoryQuery.data?.documents.filter((item) => item.version?.scanState === 'clean') ?? []} mode={composer} onClose={() => setComposer(null)} onSaved={async () => { setComposer(null); await refresh() }} vaults={inventoryQuery.data?.vaults.filter((item) => item.canManage) ?? []}/> : null}
    {reviewTarget ? <ReviewRequestModal item={reviewTarget} onClose={() => setReviewTarget(null)} onSaved={async () => { setReviewTarget(null); await refresh() }}/> : null}
    {cancelTarget ? <CancelAssignmentModal item={cancelTarget} onClose={() => setCancelTarget(null)} onSaved={async () => { setCancelTarget(null); await refresh() }}/> : null}
  </main>
}

function WorkflowList({ children, count, empty, title }: { children: ReactNode; count: number; empty: string; title: string }) {
  return <section className="hr-workflow-list"><header><div><h3>{title}</h3><p>{count} total</p></div></header>{count > 0 ? children : <p className="hr-workflow-list__empty">{empty}</p>}</section>
}

function RequestRow({ item, onReview }: { item: HrDocumentRequest; onReview: () => void }) {
  const actionable = ['requested', 'submitted'].includes(item.status)
  return <article className="hr-workflow-row"><div><strong>{item.title}</strong><span>{item.employeeLegalName} · {item.category}</span></div><div><span className={`hr-workflow-status hr-workflow-status--${item.status}`}>{item.status}</span><small>{dateLabel(item.dueDate)}</small></div>{actionable ? <button className="secondary-button" onClick={onReview} type="button">Review</button> : <span className="hr-workflow-row__done"><CheckCircle2 size={16}/>Closed</span>}</article>
}

function AssignmentRow({ item, onCancel }: { item: HrDocumentAssignment; onCancel: () => void }) {
  return <article className="hr-workflow-row"><div><strong>{item.documentTitle}</strong><span>{item.employeeLegalName} · {item.requirementType === 'electronic_signature' ? 'Signature' : 'Acknowledgment'}</span></div><div><span className={`hr-workflow-status hr-workflow-status--${item.status}`}>{item.status}</span><small>{dateLabel(item.dueDate)}</small></div>{item.status === 'pending' ? <button className="secondary-button" onClick={onCancel} type="button"><XCircle size={16}/>Cancel</button> : <span className="hr-workflow-row__done"><CheckCircle2 size={16}/>Recorded</span>}</article>
}

function WorkflowComposer({ documents, employees, mode, onClose, onSaved, vaults }: { documents: Array<{ id: string; title: string; employeeLegalName: string | null }>; employees: Array<{ id: string; legalName: string }>; mode: Exclude<Composer, null>; onClose: () => void; onSaved: () => Promise<void>; vaults: Array<{ code: string; name: string }> }) {
  const [employeeId, setEmployeeId] = useState(''); const [recordId, setRecordId] = useState(''); const [title, setTitle] = useState(''); const [category, setCategory] = useState(''); const [details, setDetails] = useState(''); const [dueDate, setDueDate] = useState(''); const [requirementType, setRequirementType] = useState('acknowledgment')
  const mutation = useMutation({ mutationFn: () => mode === 'request' ? createHrDocumentRequest({ category, dueDate, employeeId, instructions: details, title, vaultCode: recordId }) : createHrDocumentAssignment({ documentId: recordId, dueDate, employeeId, requirementType, statement: details }), onSuccess: onSaved })
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate() }
  const dialogTitle = mode === 'request' ? 'Request an employee document' : 'Assign a document action'
  const dialogDescription = mode === 'request' ? 'Ask for one clearly identified record.' : 'The employee receives the exact current clean version.'
  return <ModalDialog busy={mutation.isPending} busyLabel="Saving protected document workflow…" className="hr-workflow-dialog" description={dialogDescription} onClose={onClose} title={dialogTitle}><form className="hr-workflow-modal" onSubmit={submit}><div className="hr-workflow-form-grid"><label>Employee<select onChange={(e) => setEmployeeId(e.target.value)} required value={employeeId}><option value="">Choose employee</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.legalName}</option>)}</select></label>{mode === 'request' ? <><label>Vault<select onChange={(e) => setRecordId(e.target.value)} required value={recordId}><option value="">Choose vault</option>{vaults.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><label>Request title<input onChange={(e) => setTitle(e.target.value)} required value={title}/></label><label>Category<input onChange={(e) => setCategory(e.target.value)} required value={category}/></label></> : <><label>Document<select onChange={(e) => setRecordId(e.target.value)} required value={recordId}><option value="">Choose clean document</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.title}{item.employeeLegalName ? ` · ${item.employeeLegalName}` : ''}</option>)}</select></label><label>Required action<select onChange={(e) => setRequirementType(e.target.value)} value={requirementType}><option value="acknowledgment">Acknowledgment</option><option value="electronic_signature">Electronic signature</option></select></label></>}<label>Due date<input onChange={(e) => setDueDate(e.target.value)} type="date" value={dueDate}/></label><label className="hr-workflow-form-grid__wide">{mode === 'request' ? 'Employee instructions' : 'Completion statement'}<textarea onChange={(e) => setDetails(e.target.value)} required rows={4} value={details}/></label></div>{mutation.isError ? <p className="form-error">{mutation.error instanceof Error ? mutation.error.message : 'The workflow could not be saved.'}</p> : null}<footer><button className="secondary-button" onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending} type="submit">{mutation.isPending ? 'Saving…' : mode === 'request' ? 'Send request' : 'Assign document'}</button></footer></form></ModalDialog>
}

function ReviewRequestModal({ item, onClose, onSaved }: { item: HrDocumentRequest; onClose: () => void; onSaved: () => Promise<void> }) {
  const [action, setAction] = useState('accepted'); const [note, setNote] = useState(''); const mutation = useMutation({ mutationFn: () => reviewHrDocumentRequest(item.id, { action, note }), onSuccess: onSaved })
  return <ModalDialog busy={mutation.isPending} busyLabel="Recording document request decision…" className="hr-workflow-dialog" description={`${item.employeeLegalName} · ${item.category}`} onClose={onClose} title={item.title}><form className="hr-workflow-modal" onSubmit={(e) => { e.preventDefault(); mutation.mutate() }}><div className="hr-workflow-request-copy"><strong>Employee instructions</strong><p>{item.instructions}</p></div><label>Decision<select onChange={(e) => setAction(e.target.value)} value={action}><option value="accepted">Accept</option><option value="rejected">Reject</option><option value="cancelled">Cancel request</option></select></label><label>Required audit note<textarea onChange={(e) => setNote(e.target.value)} required rows={4} value={note}/></label>{mutation.isError ? <p className="form-error">{mutation.error instanceof Error ? mutation.error.message : 'The request could not be reviewed.'}</p> : null}<footer><button className="secondary-button" onClick={onClose} type="button">Close</button><button className="primary-action" disabled={mutation.isPending} type="submit">{mutation.isPending ? 'Saving…' : 'Record decision'}</button></footer></form></ModalDialog>
}

function CancelAssignmentModal({ item, onClose, onSaved }: { item: HrDocumentAssignment; onClose: () => void; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState(''); const mutation = useMutation({ mutationFn: () => cancelHrDocumentAssignment(item.id, reason), onSuccess: onSaved })
  return <ModalDialog busy={mutation.isPending} busyLabel="Cancelling document assignment…" className="hr-workflow-dialog" description="This closes only this employee assignment. The document and audit history remain intact." onClose={onClose} title={`Cancel ${item.documentTitle}?`}><form className="hr-workflow-modal" onSubmit={(e) => { e.preventDefault(); mutation.mutate() }}><label>Required reason<textarea onChange={(e) => setReason(e.target.value)} required rows={4} value={reason}/></label>{mutation.isError ? <p className="form-error">{mutation.error instanceof Error ? mutation.error.message : 'The assignment could not be cancelled.'}</p> : null}<footer><button className="secondary-button" onClick={onClose} type="button">Keep assignment</button><button className="danger-action" disabled={mutation.isPending} type="submit">{mutation.isPending ? 'Cancelling…' : 'Cancel assignment'}</button></footer></form></ModalDialog>
}

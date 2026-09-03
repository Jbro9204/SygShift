import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, Plus, ShieldCheck } from 'lucide-react'
import { getHrOperationalOptions, runHrOperationalAction, type HrOperationalModule } from '../data/hrOperations'
import { ModalDialog } from './ModalDialog'

type Item = { id: string; title: string; subtitle?: string; status: string }
type Field = { key: string; label: string; kind?: 'date' | 'datetime-local' | 'number' | 'textarea' | 'employee' | 'record' | 'reference'; options?: string[]; required?: boolean }
type Action = { key: string; label: string; description: string; fields: Field[] }

const commonEmployee: Field = { key: 'employeeId', label: 'Employee', kind: 'employee', required: true }
const commonRecord: Field = { key: 'id', label: 'Existing record', kind: 'record', required: true }

const actions: Record<HrOperationalModule, Action[]> = {
  leave: [
    { key: 'create_case', label: 'Open leave case', description: 'Record an approved HR leave review without changing the source time-off request.', fields: [commonEmployee, { key: 'caseType', label: 'Leave type', options: ['paid_vacation', 'sick_time', 'unpaid_time_off', 'protected_leave', 'accommodation', 'other'], required: true }, { key: 'startOn', label: 'Start date', kind: 'date', required: true }, { key: 'returnOn', label: 'Expected return', kind: 'date' }, { key: 'payTreatment', label: 'Pay treatment', options: ['pending', 'unpaid', 'paid_vacation', 'paid_sick', 'salary_continuation'], required: true }, { key: 'summary', label: 'Operational summary', kind: 'textarea' }] },
    { key: 'decide_case', label: 'Decide leave case', description: 'A different qualified approver must approve or deny the case.', fields: [commonRecord, { key: 'status', label: 'Decision', options: ['approved', 'denied'], required: true }] },
  ],
  benefits: [
    { key: 'create_plan', label: 'Create benefit plan', description: 'Create a draft plan from approved carrier or company information.', fields: [{ key: 'code', label: 'Plan code', required: true }, { key: 'name', label: 'Plan name', required: true }, { key: 'planType', label: 'Plan type', options: ['medical', 'dental', 'vision', 'life', 'disability', 'retirement', 'other'], required: true }, { key: 'carrierName', label: 'Carrier' }] },
    { key: 'activate_plan', label: 'Activate benefit plan', description: 'A different qualified approver must activate the draft.', fields: [commonRecord] },
  ],
  talent: [
    { key: 'create_goal', label: 'Create employee goal', description: 'Create a measurable employee development or performance goal.', fields: [commonEmployee, { key: 'title', label: 'Goal title', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'startsOn', label: 'Start date', kind: 'date' }, { key: 'dueOn', label: 'Due date', kind: 'date' }] },
    { key: 'update_goal', label: 'Update employee goal', description: 'Record progress or close a goal with an auditable reason.', fields: [commonRecord, { key: 'status', label: 'Status', options: ['active', 'completed', 'canceled', 'archived'], required: true }, { key: 'progressPercent', label: 'Progress percent', kind: 'number', required: true }] },
  ],
  learning: [
    { key: 'create_item', label: 'Create learning item', description: 'Create an approved training or learning requirement.', fields: [{ key: 'code', label: 'Learning code', required: true }, { key: 'title', label: 'Title', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'deliveryMethod', label: 'Delivery method', options: ['in_person', 'virtual', 'self_paced', 'external', 'document', 'other'], required: true }, { key: 'requirementType', label: 'Requirement', options: ['required', 'optional', 'role_required', 'site_required', 'credential_related'], required: true }, { key: 'renewalDays', label: 'Renewal days', kind: 'number' }] },
    { key: 'assign_item', label: 'Assign learning', description: 'Assign an active learning item to an employee.', fields: [{ key: 'itemId', label: 'Learning item', kind: 'reference', required: true }, commonEmployee, { key: 'dueOn', label: 'Due date', kind: 'date' }] },
  ],
  cases: [
    { key: 'create_case', label: 'Open employee case', description: 'Open a restricted employee-relations or corrective-action file.', fields: [commonEmployee, { key: 'caseType', label: 'Case type', options: ['complaint', 'grievance', 'investigation', 'coaching', 'corrective_action', 'accommodation', 'protected_leave', 'harassment', 'policy', 'legal', 'other'], required: true }, { key: 'title', label: 'Case title', required: true }, { key: 'priority', label: 'Priority', options: ['low', 'normal', 'high', 'urgent'], required: true }] },
    { key: 'add_note', label: 'Add restricted note', description: 'Add a factual, auditable note to an existing case.', fields: [commonRecord, { key: 'noteType', label: 'Note type', options: ['case_note', 'interview', 'finding', 'decision', 'communication', 'legal', 'other'], required: true }, { key: 'note', label: 'Case note', kind: 'textarea', required: true }] },
    { key: 'close_case', label: 'Close employee case', description: 'Close the selected case; the business reason becomes the recorded outcome.', fields: [commonRecord] },
  ],
  safety: [{ key: 'create_case', label: 'Open safety case', description: 'Record an incident without placing medical details in the general summary.', fields: [commonEmployee, { key: 'incidentType', label: 'Incident type', options: ['injury', 'illness', 'near_miss', 'vehicle', 'property', 'violence', 'exposure', 'workers_comp', 'other'], required: true }, { key: 'title', label: 'Incident title', required: true }, { key: 'occurredAt', label: 'Occurred at', kind: 'datetime-local', required: true }] }],
  assets: [
    { key: 'create_asset', label: 'Add employee asset', description: 'Add controlled equipment or property to inventory.', fields: [{ key: 'assetTag', label: 'Asset tag', required: true }, { key: 'assetType', label: 'Asset type', options: ['uniform', 'badge', 'key', 'access_card', 'radio', 'phone', 'computer', 'vehicle', 'weapon', 'equipment', 'other'], required: true }, { key: 'name', label: 'Asset name', required: true }, { key: 'serialNumber', label: 'Serial number' }, { key: 'condition', label: 'Condition', options: ['new', 'excellent', 'good', 'fair', 'poor', 'damaged', 'unknown'], required: true }, { key: 'acquiredOn', label: 'Acquired date', kind: 'date' }, { key: 'description', label: 'Description', kind: 'textarea' }] },
    { key: 'assign_asset', label: 'Assign available asset', description: 'Issue an available asset to an employee.', fields: [{ key: 'assetId', label: 'Available asset', kind: 'reference', required: true }, commonEmployee, { key: 'condition', label: 'Condition issued', options: ['new', 'excellent', 'good', 'fair', 'poor', 'damaged', 'unknown'], required: true }] },
  ],
  offboarding: [
    { key: 'create_case', label: 'Start lifecycle case', description: 'Submit a separation or rehire case for independent review.', fields: [commonEmployee, { key: 'caseType', label: 'Case type', options: ['separation', 'rehire'], required: true }, { key: 'effectiveOn', label: 'Effective date', kind: 'date', required: true }] },
    { key: 'review_case', label: 'Review lifecycle case', description: 'A different qualified approver must approve or deny the case.', fields: [commonRecord, { key: 'decision', label: 'Decision', options: ['approved', 'denied'], required: true }] },
  ],
  self_service: [
    { key: 'submit_request', label: 'Submit HR request', description: 'Request a reviewed HR change without directly rewriting the source record.', fields: [{ key: 'scope', label: 'Request type', options: ['profile', 'contact', 'employment', 'document', 'schedule', 'time', 'leave', 'benefit', 'other'], required: true }] },
    { key: 'review_request', label: 'Review HR request', description: 'Approve or deny an employee request with a recorded reason.', fields: [commonRecord, { key: 'decision', label: 'Decision', options: ['approved', 'denied'], required: true }] },
  ],
  reporting: [{ key: 'create_definition', label: 'Create HR report definition', description: 'Create a permission-filtered report definition for later execution.', fields: [{ key: 'name', label: 'Report name', required: true }, { key: 'description', label: 'Description', kind: 'textarea' }, { key: 'sourceKey', label: 'Source', options: ['people', 'employment', 'documents', 'leave', 'benefits', 'compensation', 'learning', 'assets', 'lifecycle'], required: true }, { key: 'visibility', label: 'Visibility', options: ['private', 'role', 'authorized_hr'], required: true }, { key: 'selectedColumnsText', label: 'Columns (comma separated)', required: true }] }],
}

export function HrOperationalActions({ module, items, onComplete }: { module: HrOperationalModule; items: Item[]; onComplete: () => void }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(actions[module][0].key)
  const [values, setValues] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const action = useMemo(() => actions[module].find((entry) => entry.key === selected) ?? actions[module][0], [module, selected])
  const optionsQuery = useQuery({ queryKey: ['hr-operational-options', module], queryFn: () => getHrOperationalOptions(module), enabled: open })
  const mutation = useMutation({ mutationFn: runHrOperationalAction, onSuccess: () => { setMessage('Saved successfully.'); setValues({}); setReason(''); onComplete() } })

  function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage('')
    const payload: Record<string, unknown> = { ...values }
    if (values.progressPercent) payload.progressPercent = Number(values.progressPercent)
    if (values.renewalDays) payload.renewalDays = Number(values.renewalDays)
    if (values.selectedColumnsText) { payload.selectedColumns = values.selectedColumnsText.split(',').map((value) => value.trim()).filter(Boolean); delete payload.selectedColumnsText }
    mutation.mutate({ module, action: action.key, payload, reason })
  }

  return <>
    <button className="primary-action" onClick={() => setOpen(true)} type="button"><Plus aria-hidden="true" size={17} />New or manage</button>
    {open ? <ModalDialog busy={mutation.isPending} className="hr-operational-modal" description={action.description} eyebrow="Protected HR action" headingIcon={<ShieldCheck size={20} />} onClose={() => setOpen(false)} title={action.label}>
      <form className="request-form hr-operational-form" onSubmit={submit}>
        <label><span>Action</span><select value={selected} onChange={(event) => { setSelected(event.target.value); setValues({}); setMessage('') }}>{actions[module].map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
        <div className="hr-operational-form__grid">{action.fields.map((field) => <label key={field.key}><span>{field.label}</span>{field.kind === 'textarea' ? <textarea required={field.required} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} /> : field.options || field.kind === 'employee' || field.kind === 'record' || field.kind === 'reference' ? <select required={field.required} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}><option value="">Choose…</option>{field.options?.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}{field.kind === 'employee' ? optionsQuery.data?.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>) : null}{field.kind === 'record' ? items.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.subtitle ?? item.status}</option>) : null}{field.kind === 'reference' ? optionsQuery.data?.references.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.detail}</option>) : null}</select> : <input required={field.required} type={field.kind ?? 'text'} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}</label>)}</div>
        <label><span>Business reason</span><textarea required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        {mutation.isError ? <p className="form-error" role="alert">{mutation.error.message}</p> : null}
        {message ? <p className="form-success" role="status"><CheckCircle2 aria-hidden="true" size={17} />{message}</p> : null}
        <div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={() => setOpen(false)} type="button">Close</button><button className="primary-action" disabled={mutation.isPending} type="submit">Save HR action</button></div>
      </form>
    </ModalDialog> : null}
  </>
}

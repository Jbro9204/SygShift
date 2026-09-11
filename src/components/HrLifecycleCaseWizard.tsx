import { useMemo, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, ClipboardCheck, Search, ShieldCheck } from 'lucide-react'
import {
  createHrLifecycleCase,
  type HrOffboardingOptions,
  type LifecycleType,
} from '../data/hrOffboarding'
import { ModalDialog } from './ModalDialog'

const lifecycleChoices: Array<{ value: LifecycleType; label: string; description: string }> = [
  { value: 'voluntary_resignation', label: 'Voluntary resignation', description: 'The employee chose to leave and provided notice or a final work date.' },
  { value: 'involuntary_termination', label: 'Involuntary termination', description: 'The company is ending employment after the required review.' },
  { value: 'job_abandonment', label: 'Job abandonment', description: 'Required contact attempts and protected-reason screening will be documented.' },
  { value: 'end_of_assignment', label: 'End of assignment', description: 'A temporary, contract, or assignment-based relationship is ending.' },
  { value: 'rehire', label: 'Rehire', description: 'A separated employee is returning through a new approved restoration process.' },
]

const checklist = [
  'Final timecard review', 'Payroll and final pay', 'Benefits closeout', 'Licensing and credentials',
  'Training records', 'Documents and notices', 'Property and equipment return', 'Schedule and coverage release',
  'Client and site notifications', 'Employee and internal communications', 'Records retention review',
  'Final account access shutdown',
]

export function HrLifecycleCaseWizard({
  initialEmployeeId = '',
  onClose,
  onCreated,
  options,
}: {
  initialEmployeeId?: string
  onClose: () => void
  onCreated: (caseId: string) => void
  options: HrOffboardingOptions
}) {
  const [step, setStep] = useState(0)
  const [employeeId, setEmployeeId] = useState(initialEmployeeId)
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [lifecycleType, setLifecycleType] = useState<LifecycleType>(() =>
    options.employees.find((employee) => employee.id === initialEmployeeId)?.status === 'separated'
      ? 'rehire'
      : 'voluntary_resignation',
  )
  const [effectiveOn, setEffectiveOn] = useState('')
  const [reason, setReason] = useState('')
  const selectedEmployee = options.employees.find((employee) => employee.id === employeeId)
  const selectedChoice = lifecycleChoices.find((choice) => choice.value === lifecycleType)!
  const eligibleEmployees = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase()
    return options.employees.filter((employee) => {
      const eligible = lifecycleType === 'rehire' ? employee.status === 'separated' : employee.status !== 'separated'
      if (!eligible) return false
      return !query || `${employee.name} ${employee.username} ${employee.employeeNumber ?? ''}`.toLowerCase().includes(query)
    })
  }, [employeeSearch, lifecycleType, options.employees])
  const mutation = useMutation({
    mutationFn: createHrLifecycleCase,
    onSuccess: (result) => onCreated(result.id),
  })

  function chooseType(value: LifecycleType) {
    setLifecycleType(value)
    const employee = options.employees.find((item) => item.id === employeeId)
    if (employee && ((value === 'rehire') !== (employee.status === 'separated'))) setEmployeeId('')
  }

  function advance(event: FormEvent) {
    event.preventDefault()
    if (step < 3) setStep((current) => current + 1)
    else mutation.mutate({ employeeId, lifecycleType, effectiveOn, reason: reason.trim() })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Creating the protected lifecycle case…"
      className="hr-lifecycle-wizard"
      description="One guided case coordinates approval, every handoff, required documents, and the final human-confirmed action."
      eyebrow={`Step ${step + 1} of 4`}
      headingIcon={<ClipboardCheck aria-hidden="true" size={21} />}
      onClose={onClose}
      title="Start employee lifecycle case"
    >
      <ol aria-label="Lifecycle case steps" className="hr-lifecycle-steps">
        {['Employee & reason', 'Effective date', 'Checklist', 'Review'].map((label, index) => (
          <li aria-current={index === step ? 'step' : undefined} className={index < step ? 'is-complete' : index === step ? 'is-current' : ''} key={label}>
            <span>{index < step ? <Check aria-hidden="true" size={14} /> : index + 1}</span>{label}
          </li>
        ))}
      </ol>

      <form className="hr-lifecycle-wizard__body" onSubmit={advance}>
        {step === 0 ? <>
          <div className="hr-lifecycle-step-heading"><p className="eyebrow">Employee and lifecycle</p><h3>Who is this for, and what is happening?</h3><p>This controls the approval wording, required forms, and the safe final action.</p></div>
          <fieldset className="hr-lifecycle-choice-grid">
            <legend>Lifecycle type</legend>
            {lifecycleChoices.map((choice) => <label className={lifecycleType === choice.value ? 'is-selected' : ''} key={choice.value}>
              <input checked={lifecycleType === choice.value} name="lifecycleType" onChange={() => chooseType(choice.value)} type="radio" />
              <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
            </label>)}
          </fieldset>
          <label className="hr-lifecycle-search"><span>Find employee</span><div><Search aria-hidden="true" size={17} /><input onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search by name, username, or employee number" value={employeeSearch} /></div></label>
          <label><span>Employee</span><select onChange={(event) => setEmployeeId(event.target.value)} required value={employeeId}><option value="">Choose the employee</option>{eligibleEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · @{employee.username} · {employee.status.replaceAll('_', ' ')}</option>)}</select></label>
        </> : null}

        {step === 1 ? <>
          <div className="hr-lifecycle-step-heading"><p className="eyebrow">Timing and record</p><h3>When does it take effect?</h3><p>Future dates stay scheduled. The system will raise a required HR action when the date arrives; access never shuts down without the final human confirmation.</p></div>
          <label><span>Approved effective date</span><input onChange={(event) => setEffectiveOn(event.target.value)} required type="date" value={effectiveOn} /></label>
          <label><span>Business reason</span><textarea maxLength={4000} minLength={10} onChange={(event) => setReason(event.target.value)} placeholder="Record the factual business reason and the source of this request. Keep medical, legal, and investigation details in their protected case files." required rows={7} value={reason} /><small>{reason.trim().length}/4,000 characters · minimum 10</small></label>
          <div className="hr-lifecycle-safety-note"><ShieldCheck aria-hidden="true" /><p><strong>Sensitive details stay separated.</strong> Operational teams receive only the checklist item they own—not the protected separation reason.</p></div>
        </> : null}

        {step === 2 ? <>
          <div className="hr-lifecycle-step-heading"><p className="eyebrow">Coordinated handoff</p><h3>The full checklist is created automatically</h3><p>Nothing is silently treated as complete. Each item needs an owner, evidence, or an authorized waiver reason.</p></div>
          <div className="hr-lifecycle-checklist-preview">{checklist.map((item, index) => <span key={item}><em>{index + 1}</em>{item}</span>)}</div>
        </> : null}

        {step === 3 ? <>
          <div className="hr-lifecycle-step-heading"><p className="eyebrow">Review before submission</p><h3>Confirm the request</h3><p>A different qualified person must approve it. Approval starts the checklist; it does not terminate employment.</p></div>
          <dl className="hr-lifecycle-review">
            <div><dt>Employee</dt><dd>{selectedEmployee?.name} · @{selectedEmployee?.username}</dd></div>
            <div><dt>Lifecycle</dt><dd>{selectedChoice.label}</dd></div>
            <div><dt>Effective date</dt><dd>{effectiveOn}</dd></div>
            <div><dt>Required handoffs</dt><dd>{checklist.length} checklist items</dd></div>
            <div className="wide"><dt>Recorded reason</dt><dd>{reason}</dd></div>
          </dl>
          <div className="hr-lifecycle-safety-note"><ShieldCheck aria-hidden="true" /><p><strong>No employment or access change happens now.</strong> This creates the protected case and routes it for independent approval.</p></div>
        </> : null}

        {mutation.isError ? <p className="form-error" role="alert">{mutation.error.message}</p> : null}
        <div className="modal-actions">
          <button className="secondary-button" disabled={mutation.isPending} onClick={() => step === 0 ? onClose() : setStep((current) => current - 1)} type="button"><ArrowLeft aria-hidden="true" size={17} />{step === 0 ? 'Cancel' : 'Back'}</button>
          <button className="primary-action" disabled={mutation.isPending || (step === 0 && !employeeId) || (step === 1 && (!effectiveOn || reason.trim().length < 10))} type="submit">{step === 3 ? 'Submit for approval' : 'Continue'}{step < 3 ? <ArrowRight aria-hidden="true" size={17} /> : null}</button>
        </div>
      </form>
    </ModalDialog>
  )
}

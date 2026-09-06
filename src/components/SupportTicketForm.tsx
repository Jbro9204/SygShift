import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronLeft, ChevronRight, LifeBuoy, ShieldAlert } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { submitSupportTicket, type SupportCategory } from '../data/support'
import { ModalDialog } from './ModalDialog'

const categories: Array<{ code: SupportCategory; label: string; description: string; subcategories: string[] }> = [
  { code: 'schedule', label: 'Schedule or assigned shift', description: 'Missing, incorrect, conflicting, or unavailable shift information.', subcategories: ['Incorrect assignment', 'Missing shift', 'Availability conflict', 'Call-off or coverage help', 'Shift trade help', 'Other schedule issue'] },
  { code: 'timekeeping', label: 'Clock-in, clock-out, or timecard', description: 'Missing or incorrect punches, breaks, or time records.', subcategories: ['Missing clock-in', 'Missing clock-out', 'Incorrect time', 'Unable to clock in or out', 'Break-time problem', 'Overtime question', 'Other timekeeping issue'] },
  { code: 'payroll', label: 'Paycheck, overtime, or payroll', description: 'Pay-period, rate, overtime, deduction, or payment questions.', subcategories: ['Missing pay', 'Incorrect hours', 'Overtime question', 'Pay-rate question', 'Deduction question', 'Direct-deposit question', 'Other payroll issue'] },
  { code: 'human_resources', label: 'HR or employment question', description: 'Employment records, workplace concerns, or confidential HR help.', subcategories: ['Employment record', 'Workplace concern', 'Policy question', 'Accommodation question', 'Confidential HR matter', 'Other HR issue'] },
  { code: 'benefits_leave', label: 'Benefits or leave', description: 'Benefits, eligibility, enrollment, or leave administration.', subcategories: ['Benefits question', 'Enrollment issue', 'Leave request help', 'Leave status', 'Other benefits or leave issue'] },
  { code: 'training_compliance', label: 'Training, license, or compliance', description: 'Training assignments, licenses, certifications, or compliance records.', subcategories: ['Training assignment', 'Training completion', 'License or certification', 'Compliance record', 'Other training issue'] },
  { code: 'site_post', label: 'Site, post, or instructions', description: 'Site details, post orders, access, or operational instructions.', subcategories: ['Post instructions', 'Site access', 'Incorrect site information', 'Operational concern', 'Other site or post issue'] },
  { code: 'equipment', label: 'Equipment, uniform, or property', description: 'Issued equipment, uniforms, damage, replacement, or return.', subcategories: ['Equipment request', 'Damaged equipment', 'Uniform issue', 'Return or receipt', 'Other property issue'] },
  { code: 'safety', label: 'Safety or workplace concern', description: 'Non-emergency safety, hazard, incident follow-up, or workplace concern.', subcategories: ['Safety hazard', 'Incident follow-up', 'Workplace concern', 'Other safety issue'] },
  { code: 'account_access', label: 'Account, password, or MFA', description: 'Sign-in, password, permissions, MFA, or account problems.', subcategories: ['Cannot sign in', 'Password problem', 'MFA problem', 'Incorrect access', 'Account locked', 'Other account issue'] },
  { code: 'technical', label: 'SygShift technical problem', description: 'Page errors, missing data, display problems, or unexpected behavior.', subcategories: ['Page error', 'Feature not working', 'Information missing', 'Display or layout issue', 'Slow or unavailable page', 'Other technical issue'] },
  { code: 'client_request', label: 'Client request', description: 'Help connected to a client, client site, or service request.', subcategories: ['Client information', 'Site service request', 'Document or report', 'Client access', 'Other client request'] },
  { code: 'other', label: 'Something else', description: 'A request that does not fit the categories above.', subcategories: ['General help'] },
]

export function SupportTicketForm({ onClose }: { onClose: () => void }) {
  const location = useLocation()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(1)
  const [category, setCategory] = useState<SupportCategory | null>(null)
  const [subcategory, setSubcategory] = useState('')
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [occurredOn, setOccurredOn] = useState('')
  const [stillHappening, setStillHappening] = useState(true)
  const [unableToWork, setUnableToWork] = useState(false)
  const [upcomingShiftAffected, setUpcomingShiftAffected] = useState(false)
  const [payAffected, setPayAffected] = useState(false)
  const [immediateSafety, setImmediateSafety] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [affectedPeople, setAffectedPeople] = useState('1')
  const [referenceType, setReferenceType] = useState('')
  const [reference, setReference] = useState('')
  const [confidential, setConfidential] = useState(false)
  const selectedCategory = categories.find((item) => item.code === category) ?? null
  const formValid = Boolean(category && subcategory && subject.trim().length >= 5 && description.trim().length >= 20)
  const mutation = useMutation({
    mutationFn: submitSupportTicket,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['support'] }),
  })
  const routingLabel = useMemo(() => {
    if (confidential || category === 'human_resources') return 'authorized Human Resources personnel and Administrators'
    return `${selectedCategory?.label ?? 'Support'} personnel and Administrators`
  }, [category, confidential, selectedCategory])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!category || !formValid) return
    mutation.mutate({
      category, subcategory, subject: subject.trim(), description: description.trim(),
      occurredOn: occurredOn || null, stillHappening, confidential,
      impact: { unableToWork, upcomingShiftAffected, payAffected, immediateSafety, deadline: deadline || null, affectedPeople: Number(affectedPeople) || 1 },
      relatedContext: { type: referenceType || null, reference: reference.trim() || null },
      sourcePath: `${location.pathname}${location.search}`,
      technicalContext: { userAgent: navigator.userAgent.slice(0, 500), viewport: `${window.innerWidth}x${window.innerHeight}`, capturedAt: new Date().toISOString() },
    })
  }

  if (mutation.isSuccess) return <ModalDialog className="modal-dialog--support" onClose={onClose} title="Support ticket submitted">
    <section className="support-success" role="status"><CheckCircle2 aria-hidden="true" size={42} /><div><h3>{mutation.data.ticketNumber}</h3><p>Your request was routed successfully. SygShift will email you throughout the ticket lifecycle.</p></div></section>
    <dl className="support-review-grid"><div><dt>Status</dt><dd>New</dd></div><div><dt>Priority</dt><dd>{mutation.data.priority}</dd></div><div><dt>Sent to</dt><dd>{routingLabel}</dd></div><div><dt>Updates</dt><dd>In SygShift and by email</dd></div></dl>
    <div className="modal-actions"><Link className="secondary-button" onClick={onClose} to={`/support?ticket=${mutation.data.id}`}>View ticket</Link><button className="primary-action" onClick={onClose} type="button">Done</button></div>
  </ModalDialog>

  return <ModalDialog busy={mutation.isPending} busyLabel="Submitting your support ticket…" className="modal-dialog--support" description="Answer the questions below so your request reaches the correct authorized role with the information needed to help." eyebrow={`Step ${step} of 4`} headingIcon={<LifeBuoy size={22} />} onClose={onClose} title="How can we help?">
    <form className="support-form" onSubmit={submit}>
      <div aria-label="Ticket progress" className="support-progress"><span className={step >= 1 ? 'active' : ''}>Topic</span><span className={step >= 2 ? 'active' : ''}>Details</span><span className={step >= 3 ? 'active' : ''}>Impact</span><span className={step >= 4 ? 'active' : ''}>Review</span></div>
      {step === 1 ? <section><div className="support-section-heading"><h3>What do you need help with?</h3><p>Choose the closest match. Your answer controls routing and follow-up questions.</p></div><div className="support-category-grid">{categories.map((item) => <label className={category === item.code ? 'support-category selected' : 'support-category'} key={item.code}><input checked={category === item.code} name="category" onChange={() => { setCategory(item.code); setSubcategory(''); setConfidential(item.code === 'human_resources') }} type="radio" /><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</div></section> : null}
      {step === 2 ? <section className="support-form-section"><div className="support-section-heading"><h3>Tell us what happened</h3><p>Include enough detail that the receiving team can begin without asking you to repeat the basics.</p></div><div className="support-field-grid"><label><span>Specific issue</span><select onChange={(e) => setSubcategory(e.target.value)} required value={subcategory}><option value="">Choose an issue</option>{selectedCategory?.subcategories.map((item) => <option key={item}>{item}</option>)}</select></label><label><span>When did this happen? <small>Optional</small></span><input onChange={(e) => setOccurredOn(e.target.value)} type="date" value={occurredOn} /></label></div><label className="field-stack"><span>Subject</span><input maxLength={160} onChange={(e) => setSubject(e.target.value)} placeholder="Briefly describe the problem" required value={subject} /></label><label className="field-stack"><span>Complete description</span><textarea maxLength={5000} minLength={20} onChange={(e) => setDescription(e.target.value)} placeholder="What were you trying to do? What happened instead? Include any error message and what you have already tried." required rows={7} value={description} /></label><label className="support-check"><input checked={stillHappening} onChange={(e) => setStillHappening(e.target.checked)} type="checkbox" /><span>This is still happening</span></label><div className="support-field-grid"><label><span>Related record <small>Optional</small></span><select onChange={(e) => setReferenceType(e.target.value)} value={referenceType}><option value="">No related record</option><option>Shift or schedule</option><option>Timecard or punch</option><option>Pay period or paycheck</option><option>Site or post</option><option>Employee record</option><option>Document</option><option>Training or license</option><option>Client</option></select></label><label><span>Record, date, or identifying detail <small>Optional</small></span><input maxLength={250} onChange={(e) => setReference(e.target.value)} placeholder="Example: 09/11/2026 evening shift" value={reference} /></label></div><p className="form-note">SygShift will also attach the page you were viewing and safe browser diagnostics. Never enter a password, MFA code, full Social Security number, or complete bank information.</p></section> : null}
      {step === 3 ? <section className="support-form-section"><div className="support-section-heading"><h3>Impact, urgency, and privacy</h3><p>Describe the impact. SygShift determines the initial priority from these facts.</p></div>{immediateSafety ? <aside className="support-emergency" role="alert"><ShieldAlert size={22} /><div><strong>Do not wait for a support ticket during an active emergency.</strong><p>Call 911 and contact Dispatch immediately. You may still submit this ticket afterward to preserve the record.</p></div></aside> : null}<div className="support-impact-list"><label><input checked={unableToWork} onChange={(e) => setUnableToWork(e.target.checked)} type="checkbox" /><span><strong>I am currently unable to work</strong><small>The issue prevents me from performing my job.</small></span></label><label><input checked={upcomingShiftAffected} onChange={(e) => setUpcomingShiftAffected(e.target.checked)} type="checkbox" /><span><strong>An upcoming shift may be affected</strong><small>This could prevent or delay reporting for a scheduled shift.</small></span></label><label><input checked={payAffected} onChange={(e) => setPayAffected(e.target.checked)} type="checkbox" /><span><strong>My pay may be affected</strong><small>This involves missing or potentially incorrect pay.</small></span></label><label><input checked={immediateSafety} onChange={(e) => setImmediateSafety(e.target.checked)} type="checkbox" /><span><strong>Someone’s immediate safety may be affected</strong><small>This does not replace calling emergency services or Dispatch.</small></span></label></div><div className="support-field-grid"><label><span>Number of people affected</span><input min="1" max="999" onChange={(e) => setAffectedPeople(e.target.value)} type="number" value={affectedPeople} /></label><label><span>Deadline or important date <small>Optional</small></span><input onChange={(e) => setDeadline(e.target.value)} type="date" value={deadline} /></label></div><label className="support-check support-private"><input checked={confidential} onChange={(e) => setConfidential(e.target.checked)} type="checkbox" /><span><strong>This is a private HR or workplace concern</strong><small>Route this directly to authorized Human Resources personnel and Administrators, bypassing ordinary supervisory routing.</small></span></label></section> : null}
      {step === 4 ? <section className="support-form-section"><div className="support-section-heading"><h3>Review your request</h3><p>Confirm the information and routing before submitting.</p></div><dl className="support-review-grid"><div><dt>Category</dt><dd>{selectedCategory?.label}</dd></div><div><dt>Specific issue</dt><dd>{subcategory || 'Not selected'}</dd></div><div><dt>Subject</dt><dd>{subject || 'Not entered'}</dd></div><div><dt>Routed to</dt><dd>{routingLabel}</dd></div><div><dt>Related record</dt><dd>{referenceType ? `${referenceType}${reference ? ` · ${reference}` : ''}` : 'Current SygShift page'}</dd></div><div><dt>Updates</dt><dd>In-app and lifecycle email</dd></div></dl><div className="support-review-description"><strong>Description</strong><p>{description || 'No description entered.'}</p></div><p className="form-note">Submitting creates a permanent ticket number and audit record. Public replies and lifecycle changes are emailed automatically. Internal staff notes are never emailed to you.</p>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}</section> : null}
      <div className="modal-actions support-form-actions">{step > 1 ? <button className="secondary-button" onClick={() => setStep((value) => value - 1)} type="button"><ChevronLeft size={18} />Back</button> : <button className="secondary-button" onClick={onClose} type="button">Cancel</button>}<span />{step < 4 ? <button className="primary-action" disabled={(step === 1 && !category) || (step === 2 && (!subcategory || subject.trim().length < 5 || description.trim().length < 20))} onClick={() => setStep((value) => value + 1)} type="button">Continue<ChevronRight size={18} /></button> : <button className="primary-action" disabled={!formValid || mutation.isPending} type="submit">{mutation.isPending ? 'Submitting…' : 'Submit Support Ticket'}</button>}</div>
    </form>
  </ModalDialog>
}

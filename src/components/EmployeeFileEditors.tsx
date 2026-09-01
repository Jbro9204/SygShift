import { type FormEvent, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BriefcaseBusiness, ContactRound, Save, ShieldCheck, UserRound } from 'lucide-react'
import {
  updateHrisEmployeeContactDetails,
  updateHrisEmployeeEmploymentProfile,
  updateHrisEmployeeIdentity,
  type HrisEmployeeFile,
  type HrisEmployeeProfileEditorContext,
} from '../data/hrisPeople'
import { ModalDialog } from './ModalDialog'

type EditorProps = {
  employee: HrisEmployeeFile
  onClose: () => void
  onSaved?: () => void
}

function useEmployeeFileRefresh(employeeId: string, onClose: () => void, onSaved?: () => void) {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['hris-employee-file', employeeId] }),
      queryClient.invalidateQueries({ queryKey: ['hris-employee-profile-editor', employeeId] }),
      queryClient.invalidateQueries({ queryKey: ['hris-people'] }),
      queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] }),
    ])
    onSaved?.()
    onClose()
  }
}

export function EmployeeIdentityEditorDialog({ employee, onClose, onSaved }: EditorProps) {
  const refresh = useEmployeeFileRefresh(employee.employeeId, onClose, onSaved)
  const [form, setForm] = useState({
    employeeNumber: employee.employeeNumber ?? '',
    firstName: employee.firstName,
    lastName: employee.lastName,
    middleName: employee.middleName ?? '',
    reason: '',
  })
  const mutation = useMutation({ mutationFn: updateHrisEmployeeIdentity, onSuccess: refresh })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate({ employeeId: employee.employeeId, ...form })
  }

  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Saving legal employee record…" className="hr-file-editor-modal" description="Update the permanent legal employee record. The username and login identity remain unchanged." onClose={() => !mutation.isPending && onClose()} title={`Legal employee record · ${employee.legalName}`}>
      <form onSubmit={submit}>
        <div className="hr-file-editor-notice"><ShieldCheck aria-hidden="true" /><div><strong>Protected and audited</strong><p>Every change records the authorized HR user, the prior values, the new values, and the reason.</p></div></div>
        <div className="hr-file-editor-grid hr-file-editor-grid--three">
          <label>Legal first name<input autoFocus maxLength={100} onChange={(event) => setForm({ ...form, firstName: event.target.value })} required value={form.firstName} /></label>
          <label>Legal middle name<input maxLength={100} onChange={(event) => setForm({ ...form, middleName: event.target.value })} value={form.middleName} /></label>
          <label>Legal last name<input maxLength={100} onChange={(event) => setForm({ ...form, lastName: event.target.value })} required value={form.lastName} /></label>
        </div>
        <label>Employee number<input maxLength={40} onChange={(event) => setForm({ ...form, employeeNumber: event.target.value.toUpperCase() })} placeholder="Example: SYG-1052" value={form.employeeNumber} /></label>
        <label>Reason for change<textarea maxLength={1000} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Explain why this employee record is being added or corrected." required rows={4} value={form.reason} /></label>
        {mutation.isError ? <div className="error-message" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The legal employee record could not be updated.'}</div> : null}
        <div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending} type="submit"><UserRound aria-hidden="true" size={17} />Save legal record</button></div>
      </form>
    </ModalDialog>
  )
}

export function EmployeeEmploymentEditorDialog({ employee, context, onClose, onSaved }: EditorProps & { context: HrisEmployeeProfileEditorContext }) {
  const refresh = useEmployeeFileRefresh(employee.employeeId, onClose, onSaved)
  const [form, setForm] = useState({
    employmentType: employee.employmentType as 'hourly' | 'salary',
    jobTitle: employee.jobTitle ?? '',
    reason: '',
    workClassification: (context.workClassification ?? '') as '' | 'full_time' | 'part_time' | 'flex',
  })
  const mutation = useMutation({ mutationFn: updateHrisEmployeeEmploymentProfile, onSuccess: refresh })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.workClassification) return
    mutation.mutate({ employeeId: employee.employeeId, ...form, workClassification: form.workClassification })
  }

  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Saving employment profile…" className="hr-file-editor-modal" description="Maintain the employee's job title, Full Time / Part Time / Flex classification, and timekeeping treatment without changing security access." onClose={() => !mutation.isPending && onClose()} title={`Employment profile · ${employee.legalName}`}>
      <form onSubmit={submit}>
        <div className="hr-file-editor-notice"><BriefcaseBusiness aria-hidden="true" /><div><strong>One authoritative employment profile</strong><p>Primary role and account access remain controlled in User Accounts. Start and termination dates remain in the separate audited date editor.</p></div></div>
        <label>Job title<input autoFocus maxLength={160} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} placeholder="Employee's current position title" value={form.jobTitle} /></label>
        <div className="hr-file-editor-grid">
          <label>Work classification<select onChange={(event) => setForm({ ...form, workClassification: event.target.value as typeof form.workClassification })} required value={form.workClassification}><option disabled value="">Choose classification</option><option value="full_time">Full Time</option><option value="part_time">Part Time</option><option value="flex">Flex</option></select><small>Tracks the employee's regular workforce classification.</small></label>
          <label>Pay &amp; timekeeping type<select onChange={(event) => setForm({ ...form, employmentType: event.target.value as typeof form.employmentType })} required value={form.employmentType}><option value="hourly">Hourly</option><option value="salary">Salary</option></select><small>Controls timekeeping and leave behavior; Flex is tracked separately as a work classification.</small></label>
        </div>
        <label>Reason for change<textarea maxLength={1000} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Explain why the employment profile is being added or corrected." required rows={4} value={form.reason} /></label>
        {mutation.isError ? <div className="error-message" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The employment profile could not be updated.'}</div> : null}
        <div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending || !form.workClassification} type="submit"><Save aria-hidden="true" size={17} />Save employment profile</button></div>
      </form>
    </ModalDialog>
  )
}

export function EmployeeContactEditorDialog({ employee, context, onClose, onSaved }: EditorProps & { context: HrisEmployeeProfileEditorContext }) {
  const refresh = useEmployeeFileRefresh(employee.employeeId, onClose, onSaved)
  const contacts = employee.contacts
  const restricted = context.restrictedContactExtension
  const [form, setForm] = useState({
    addressLine1: contacts?.addressLine1 ?? '',
    addressLine2: contacts?.addressLine2 ?? '',
    city: contacts?.city ?? '',
    companyEmail: contacts?.companyEmail ?? '',
    emergencyContactEmail: restricted?.emergencyContactEmail ?? '',
    emergencyContactName: contacts?.emergencyContactName ?? '',
    emergencyContactPhone: contacts?.emergencyContactPhone ?? '',
    emergencyContactRelationship: restricted?.emergencyContactRelationship ?? '',
    mobilePhone: contacts?.mobilePhone ?? '',
    personalEmail: contacts?.personalEmail ?? '',
    postalCode: contacts?.postalCode ?? '',
    reason: '',
    region: contacts?.region ?? '',
  })
  const mutation = useMutation({ mutationFn: updateHrisEmployeeContactDetails, onSuccess: refresh })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate({ employeeId: employee.employeeId, ...form })
  }

  return (
    <ModalDialog busy={mutation.isPending} busyLabel="Saving contact details…" className="hr-file-editor-modal hr-file-editor-modal--wide" description="Update the employee's protected contact, address, and emergency-contact information in one place." onClose={() => !mutation.isPending && onClose()} title={`Contact & emergency details · ${employee.legalName}`}>
      <form onSubmit={submit}>
        <div className="hr-file-editor-notice"><ContactRound aria-hidden="true" /><div><strong>Restricted HR information</strong><p>These fields are visible and editable only with separate restricted-record permission and MFA.</p></div></div>
        <section className="hr-file-editor-section" aria-labelledby="employee-contact-heading"><div><h3 id="employee-contact-heading">Employee contact</h3><p>Current personal and company contact information.</p></div><div className="hr-file-editor-grid"><label>Personal email<input autoComplete="off" onChange={(event) => setForm({ ...form, personalEmail: event.target.value })} type="email" value={form.personalEmail} /></label><label>Company email<input autoComplete="off" onChange={(event) => setForm({ ...form, companyEmail: event.target.value })} type="email" value={form.companyEmail} /></label><label>Mobile phone<input autoComplete="off" onChange={(event) => setForm({ ...form, mobilePhone: event.target.value })} type="tel" value={form.mobilePhone} /></label></div></section>
        <section className="hr-file-editor-section" aria-labelledby="employee-address-heading"><div><h3 id="employee-address-heading">Home address</h3><p>Protected mailing and residence information.</p></div><div className="hr-file-editor-grid"><label className="hr-file-editor-span-two">Address line 1<input autoComplete="off" onChange={(event) => setForm({ ...form, addressLine1: event.target.value })} value={form.addressLine1} /></label><label className="hr-file-editor-span-two">Address line 2<input autoComplete="off" onChange={(event) => setForm({ ...form, addressLine2: event.target.value })} value={form.addressLine2} /></label><label>City<input autoComplete="off" onChange={(event) => setForm({ ...form, city: event.target.value })} value={form.city} /></label><label>State<input autoComplete="off" maxLength={30} onChange={(event) => setForm({ ...form, region: event.target.value.toUpperCase() })} value={form.region} /></label><label>Postal code<input autoComplete="off" maxLength={20} onChange={(event) => setForm({ ...form, postalCode: event.target.value.toUpperCase() })} value={form.postalCode} /></label></div></section>
        <section className="hr-file-editor-section hr-file-editor-section--emergency" aria-labelledby="emergency-contact-heading"><div><h3 id="emergency-contact-heading">Emergency contact</h3><p>Who should Guardianship Security contact in an emergency?</p></div><div className="hr-file-editor-grid"><label>Full name<input autoComplete="off" onChange={(event) => setForm({ ...form, emergencyContactName: event.target.value })} value={form.emergencyContactName} /></label><label>Relationship<input autoComplete="off" maxLength={80} onChange={(event) => setForm({ ...form, emergencyContactRelationship: event.target.value })} value={form.emergencyContactRelationship} /></label><label>Phone<input autoComplete="off" onChange={(event) => setForm({ ...form, emergencyContactPhone: event.target.value })} type="tel" value={form.emergencyContactPhone} /></label><label>Email<input autoComplete="off" onChange={(event) => setForm({ ...form, emergencyContactEmail: event.target.value })} type="email" value={form.emergencyContactEmail} /></label></div></section>
        <label>Reason for change<textarea maxLength={1000} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Explain why these protected details are being added or corrected." required rows={3} value={form.reason} /></label>
        {mutation.isError ? <div className="error-message" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Contact and emergency details could not be updated.'}</div> : null}
        <div className="modal-actions"><button className="secondary-button" disabled={mutation.isPending} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={mutation.isPending} type="submit"><Save aria-hidden="true" size={17} />Save contact details</button></div>
      </form>
    </ModalDialog>
  )
}

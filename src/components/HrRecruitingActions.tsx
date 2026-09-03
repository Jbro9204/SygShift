import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BriefcaseBusiness, Plus } from 'lucide-react'
import { runHrRecruitingAction, type HrRecruitingAction, type HrRecruitingWorkspace } from '../data/hrRecruiting'
import { ModalDialog } from './ModalDialog'

export function HrRecruitingActions({ workspace, onComplete }: { workspace: HrRecruitingWorkspace; onComplete: () => void }) {
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<HrRecruitingAction>('create_requisition')
  const [values, setValues] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const mutation = useMutation({ mutationFn: ({ selectedAction, payload }: { selectedAction: HrRecruitingAction; payload: Record<string, unknown> }) => runHrRecruitingAction(selectedAction, payload, reason), onSuccess: () => { setValues({}); setReason(''); onComplete() } })
  const selectable = [
    ['create_requisition', 'Create requisition'], ['submit_requisition', 'Submit draft requisition'], ['approve_requisition', 'Approve requisition'],
    ['create_application', 'Add applicant'], ['move_application', 'Move applicant stage'], ['dispose_application', 'Close applicant record'],
  ] as const
  const isRequisitionAction = action === 'submit_requisition' || action === 'approve_requisition'
  const isApplicationAction = action === 'move_application' || action === 'dispose_application'

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const payload: Record<string, unknown> = { ...values }
    if (values.headcount) payload.headcount = Number(values.headcount)
    mutation.mutate({ selectedAction: action, payload })
  }

  return <>
    <button className="primary-action" onClick={() => setOpen(true)} type="button"><Plus aria-hidden="true" size={17} />New or manage</button>
    {open ? <ModalDialog busy={mutation.isPending} className="hr-operational-modal" description="Create and advance approved recruiting records without duplicating employee identities." eyebrow="Recruiting action" headingIcon={<BriefcaseBusiness size={20} />} onClose={() => setOpen(false)} title="Manage recruiting">
      <form className="request-form hr-operational-form" onSubmit={submit}>
        <label><span>Action</span><select value={action} onChange={(event) => { setAction(event.target.value as HrRecruitingAction); setValues({}) }}>{selectable.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="hr-operational-form__grid">
          {action === 'create_requisition' ? <>
            <label><span>Position title</span><input required value={values.title ?? ''} onChange={(event) => setValues({ ...values, title: event.target.value })} /></label>
            <label><span>Employment type</span><select required value={values.employmentType ?? ''} onChange={(event) => setValues({ ...values, employmentType: event.target.value })}><option value="">Choose…</option><option value="hourly">Hourly</option><option value="salary">Salary</option><option value="flex">Flex</option></select></label>
            <label><span>Headcount</span><input min="1" required type="number" value={values.headcount ?? '1'} onChange={(event) => setValues({ ...values, headcount: event.target.value })} /></label>
            <label><span>Armed requirement</span><select required value={values.armedRequirement ?? ''} onChange={(event) => setValues({ ...values, armedRequirement: event.target.value })}><option value="">Choose…</option><option value="unarmed">Unarmed</option><option value="armed">Armed</option><option value="either">Either</option><option value="not_applicable">Not applicable</option></select></label>
            <label><span>Description</span><textarea value={values.description ?? ''} onChange={(event) => setValues({ ...values, description: event.target.value })} /></label>
          </> : null}
          {isRequisitionAction || action === 'create_application' ? <label><span>Requisition</span><select required value={values.requisitionId ?? ''} onChange={(event) => setValues({ ...values, requisitionId: event.target.value })}><option value="">Choose…</option>{workspace.requisitions.filter((item) => action === 'submit_requisition' ? item.status === 'draft' : action === 'approve_requisition' ? item.status === 'pending_approval' : item.status === 'open').map((item) => <option key={item.id} value={item.id}>{item.number} · {item.title}</option>)}</select></label> : null}
          {action === 'create_application' ? <><label><span>Legal first name</span><input required value={values.legalFirstName ?? ''} onChange={(event) => setValues({ ...values, legalFirstName: event.target.value })} /></label><label><span>Legal last name</span><input required value={values.legalLastName ?? ''} onChange={(event) => setValues({ ...values, legalLastName: event.target.value })} /></label><label><span>Personal email</span><input type="email" value={values.personalEmail ?? ''} onChange={(event) => setValues({ ...values, personalEmail: event.target.value })} /></label><label><span>Mobile phone</span><input value={values.mobilePhone ?? ''} onChange={(event) => setValues({ ...values, mobilePhone: event.target.value })} /></label><label><span>Source</span><input value={values.source ?? ''} onChange={(event) => setValues({ ...values, source: event.target.value })} /></label></> : null}
          {isApplicationAction ? <label><span>Applicant</span><select required value={values.applicationId ?? ''} onChange={(event) => setValues({ ...values, applicationId: event.target.value })}><option value="">Choose…</option>{workspace.applications.map((item) => <option key={item.id} value={item.id}>{item.candidateName} · {item.requisitionTitle}</option>)}</select></label> : null}
          {action === 'move_application' ? <label><span>New stage</span><select required value={values.stage ?? ''} onChange={(event) => setValues({ ...values, stage: event.target.value })}><option value="">Choose…</option>{['screening', 'interview', 'offer', 'accepted', 'on_hold'].map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select></label> : null}
          {action === 'dispose_application' ? <><label><span>Disposition</span><select required value={values.disposition ?? ''} onChange={(event) => setValues({ ...values, disposition: event.target.value })}><option value="">Choose…</option><option value="withdrawn">Withdrawn</option><option value="rejected">Rejected</option></select></label><label><span>Disposition reason</span><input required value={values.dispositionReason ?? ''} onChange={(event) => setValues({ ...values, dispositionReason: event.target.value })} /></label></> : null}
        </div>
        <label><span>Business reason</span><textarea required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        {mutation.isError ? <p className="form-error" role="alert">{mutation.error.message}</p> : null}
        <div className="modal-actions"><button className="secondary-button" onClick={() => setOpen(false)} type="button">Close</button><button className="primary-action" type="submit">Save recruiting action</button></div>
      </form>
    </ModalDialog> : null}
  </>
}

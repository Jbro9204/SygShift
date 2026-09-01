import { type FormEvent, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, ShieldCheck } from 'lucide-react'
import {
  hrisEmploymentDateSourceLabels,
  updateHrisEmploymentDates,
  type HrisEmploymentDateSource,
} from '../data/hrisPeople'
import { ModalDialog } from './ModalDialog'

type EmploymentDateEmployee = {
  employeeId: string
  legalName: string
  status: 'onboarding' | 'active' | 'leave' | 'inactive' | 'separated'
  hiredOn: string | null
  separatedOn: string | null
}

type EmploymentDateEditorDialogProps = {
  employee: EmploymentDateEmployee
  onClose: () => void
  onSaved?: () => void
  sourceType?: HrisEmploymentDateSource
}

type EmploymentDateForm = {
  hiredOn: string
  separatedOn: string
  sourceType: HrisEmploymentDateSource
  sourceReference: string
  reason: string
}

export function EmploymentDateEditorDialog({
  employee,
  onClose,
  onSaved,
  sourceType = 'employee_file',
}: EmploymentDateEditorDialogProps) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<EmploymentDateForm>({
    hiredOn: employee.hiredOn ?? '',
    reason: '',
    separatedOn: employee.separatedOn ?? '',
    sourceReference: '',
    sourceType,
  })
  const updateMutation = useMutation({
    mutationFn: updateHrisEmploymentDates,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hris-employee-file', employee.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hris-employment-date-history', employee.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hris-people'] }),
        queryClient.invalidateQueries({ queryKey: ['hris-identity-readiness'] }),
      ])
      onSaved?.()
      onClose()
    },
  })

  function closeEditor() {
    if (!updateMutation.isPending) onClose()
  }

  function submitEmploymentDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    updateMutation.mutate({
      employeeId: employee.employeeId,
      hiredOn: form.hiredOn,
      reason: form.reason,
      separatedOn: form.separatedOn || null,
      sourceReference: form.sourceReference,
      sourceType: form.sourceType,
    })
  }

  return (
    <ModalDialog
      busy={updateMutation.isPending}
      busyLabel="Updating employment dates…"
      className="hr-employment-dates-modal"
      description="Update the permanent employment record and append a new audit entry. Existing schedules, punches, time cards, and payroll records will not be rewritten."
      onClose={closeEditor}
      title={`Employment dates · ${employee.legalName}`}
    >
      <form onSubmit={submitEmploymentDates}>
        <div className="hr-employment-dates-modal__notice">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Evidence and explanation are required</strong>
            <p>Use the verified source dates. A separated employee must have a termination date, and it cannot be earlier than the hire date.</p>
          </div>
        </div>
        <div className="hr-employment-dates-modal__dates">
          <label>
            Start / hire date
            <input onChange={(event) => setForm({ ...form, hiredOn: event.target.value })} required type="date" value={form.hiredOn} />
            <small>A future start date is allowed only while the employee is onboarding.</small>
          </label>
          <label>
            Separation / termination date
            <input min={form.hiredOn || undefined} onChange={(event) => setForm({ ...form, separatedOn: event.target.value })} required={employee.status === 'separated'} type="date" value={form.separatedOn} />
            <small>{employee.status === 'separated' ? 'Required because this employee is separated.' : 'Leave blank unless an actual separation is documented.'}</small>
          </label>
        </div>
        <label>
          Evidence source
          <select onChange={(event) => setForm({ ...form, sourceType: event.target.value as HrisEmploymentDateSource })} value={form.sourceType}>
            {Object.entries(hrisEmploymentDateSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          Source reference
          <input onChange={(event) => setForm({ ...form, sourceReference: event.target.value })} placeholder="Example: signed offer letter dated 09/01/2026" required value={form.sourceReference} />
        </label>
        <label>
          Reason for update
          <textarea onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Explain why these dates are being added or corrected." required rows={4} value={form.reason} />
        </label>
        {updateMutation.isError ? <div className="error-message" role="alert">{updateMutation.error instanceof Error ? updateMutation.error.message : 'Employment dates could not be updated.'}</div> : null}
        <div className="modal-actions">
          <button className="secondary-button" disabled={updateMutation.isPending} onClick={closeEditor} type="button">Cancel</button>
          <button className="primary-action" disabled={updateMutation.isPending} type="submit"><CalendarClock aria-hidden="true" size={17} />Save employment dates</button>
        </div>
      </form>
    </ModalDialog>
  )
}

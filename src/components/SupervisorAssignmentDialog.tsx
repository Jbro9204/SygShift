import { type FormEvent, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { UserRoundCog } from 'lucide-react'
import { updateSupervisorAssignment, type SupervisorAssignment, type SupervisorOption } from '../data/supervision'
import { ModalDialog } from './ModalDialog'

export function SupervisorAssignmentDialog({
  assignment,
  employeeId,
  employeeName,
  onClose,
  supervisors,
}: {
  assignment: SupervisorAssignment | null
  employeeId: string
  employeeName: string
  onClose: () => void
  supervisors: SupervisorOption[]
}) {
  const queryClient = useQueryClient()
  const [supervisorEmployeeId, setSupervisorEmployeeId] = useState(assignment?.supervisorEmployeeId ?? '')
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: updateSupervisorAssignment,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['supervision-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['hris-employee-file', employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['employee-directory'] }),
      ])
      onClose()
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate({
      employeeId,
      reason,
      supervisorEmployeeId: supervisorEmployeeId || null,
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Updating supervisor assignment…"
      description="This sets the employee's primary reporting relationship and the default My Employees view. It does not grant or remove permissions."
      onClose={onClose}
      title={`Assigned supervisor · ${employeeName}`}
    >
      <form className="supervisor-assignment-form" onSubmit={submit}>
        <div className="supervisor-assignment-note">
          <UserRoundCog aria-hidden="true" size={22} />
          <p>Choose one primary supervisor. Use Unassigned only when the reporting relationship has not been decided.</p>
        </div>
        <label>
          <span>Assigned supervisor</span>
          <select onChange={(event) => setSupervisorEmployeeId(event.target.value)} value={supervisorEmployeeId}>
            <option value="">Unassigned</option>
            {supervisors.filter((supervisor) => supervisor.employeeId !== employeeId).map((supervisor) => (
              <option key={supervisor.employeeId} value={supervisor.employeeId}>
                {supervisor.name}{supervisor.jobTitle ? ` · ${supervisor.jobTitle}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Reason for change</span>
          <textarea
            maxLength={1000}
            minLength={8}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Example: Reporting relationship confirmed by HR."
            required
            rows={3}
            value={reason}
          />
        </label>
        {mutation.isError ? <div className="error-message" role="alert">{mutation.error.message}</div> : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={reason.trim().length < 8} type="submit">Save supervisor</button>
        </div>
      </form>
    </ModalDialog>
  )
}

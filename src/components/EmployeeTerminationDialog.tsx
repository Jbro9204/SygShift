import { type FormEvent, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, UserRoundX } from 'lucide-react'
import {
  terminateHrisEmployee,
  type HrisEmployeeTerminationResult,
} from '../data/hrisPeople'
import { ModalDialog } from './ModalDialog'

type TerminationEmployee = {
  employeeId: string
  legalName: string
  username: string
  hiredOn: string | null
}

type EmployeeTerminationDialogProps = {
  employee: TerminationEmployee
  onClose: () => void
  onTerminated: (result: HrisEmployeeTerminationResult) => void
}

export function EmployeeTerminationDialog({ employee, onClose, onTerminated }: EmployeeTerminationDialogProps) {
  const queryClient = useQueryClient()
  const [terminatedOn, setTerminatedOn] = useState('')
  const [reason, setReason] = useState('')
  const [confirmationUsername, setConfirmationUsername] = useState('')
  const confirmationMatches = confirmationUsername.trim().toLowerCase() === employee.username.toLowerCase()

  const mutation = useMutation({
    mutationFn: terminateHrisEmployee,
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hris-employee-file', employee.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hris-employee-profile-editor', employee.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hris-employment-date-history', employee.employeeId] }),
        queryClient.invalidateQueries({ queryKey: ['hris-people'] }),
        queryClient.invalidateQueries({ queryKey: ['hris-identity-readiness'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] }),
        queryClient.invalidateQueries({ queryKey: ['access-control-center'] }),
        queryClient.invalidateQueries({ queryKey: ['supervision-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['time-command-center'] }),
      ])
      onTerminated(result)
      onClose()
    },
  })

  function closeDialog() {
    if (!mutation.isPending) onClose()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!confirmationMatches) return
    mutation.mutate({
      confirmationUsername,
      employeeId: employee.employeeId,
      reason,
      terminatedOn,
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Terminating employment and securing access…"
      className="hr-termination-modal"
      description="This protected HR action immediately ends access and releases future assigned work while preserving payroll, schedule, timecard, document, and audit history."
      onClose={closeDialog}
      title={`Terminate employment · ${employee.legalName}`}
    >
      <form onSubmit={submit}>
        <div className="hr-termination-modal__warning" role="alert">
          <ShieldAlert aria-hidden="true" />
          <div>
            <strong>This action takes effect immediately.</strong>
            <p>The employee will be marked separated, their login and remembered devices will be disabled, and current or future assigned shifts and pending shift requests will be released.</p>
          </div>
        </div>

        <label>
          Termination date
          <input min={employee.hiredOn ?? undefined} onChange={(event) => setTerminatedOn(event.target.value)} required type="date" value={terminatedOn} />
          <small>Future dates belong in the Offboarding workflow. This action is for an effective termination only.</small>
        </label>

        <label>
          Required HR reason
          <textarea maxLength={1000} minLength={10} onChange={(event) => setReason(event.target.value)} placeholder="Document the approved employment-separation reason." required rows={4} value={reason} />
        </label>

        <label>
          Confirm employee username
          <input autoComplete="off" onChange={(event) => setConfirmationUsername(event.target.value)} placeholder={employee.username} required value={confirmationUsername} />
          <small>Enter <strong>{employee.username}</strong> without the @ symbol to confirm the correct employee.</small>
        </label>

        {mutation.isError ? <div className="error-message" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'The employee could not be terminated.'}</div> : null}

        <div className="modal-actions">
          <button className="secondary-button" disabled={mutation.isPending} onClick={closeDialog} type="button">Keep employee active</button>
          <button className="danger-action" disabled={mutation.isPending || reason.trim().length < 10 || !terminatedOn || !confirmationMatches} type="submit"><UserRoundX aria-hidden="true" size={18} />Terminate employment</button>
        </div>
      </form>
    </ModalDialog>
  )
}

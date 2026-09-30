import type { ChangeEvent, SelectHTMLAttributes } from 'react'
import {
  canAssignWorkforceRole,
  initialWorkforceRoleValue,
  isWorkforceRole,
  workforceRoleOptions,
  type WorkforceRole,
  type WorkforceRoleAssignmentActor,
} from '../lib/workforceRoleAssignment'

type WorkforceRoleSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'defaultValue' | 'onChange' | 'value'> & {
  actor: WorkforceRoleAssignmentActor
  defaultValue?: string | null
  onChange?: (role: WorkforceRole, event: ChangeEvent<HTMLSelectElement>) => void
  value?: string
}

export function WorkforceRoleSelect({ actor, defaultValue, onChange, value, ...selectProps }: WorkforceRoleSelectProps) {
  const controlledValue = value === undefined ? undefined : initialWorkforceRoleValue(value)
  const initialValue = value === undefined ? initialWorkforceRoleValue(defaultValue) : undefined
  const selectedValue = controlledValue ?? initialValue ?? 'guard'
  const unsupportedSelection = isWorkforceRole(selectedValue) ? null : selectedValue

  return (
    <select
      {...selectProps}
      defaultValue={initialValue}
      onChange={(event) => onChange?.(event.target.value as WorkforceRole, event)}
      value={controlledValue}
    >
      {unsupportedSelection ? <option disabled value={unsupportedSelection}>Unsupported role: {unsupportedSelection}</option> : null}
      {workforceRoleOptions.map((option) => (
        <option disabled={!canAssignWorkforceRole(actor, option.value)} key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

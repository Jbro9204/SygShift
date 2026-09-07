import { useId, useState } from 'react'
import { Search, ShieldCheck } from 'lucide-react'
import { employeeRoleLabels, toggleEmployeeRole, type EmployeeRoleDraft, type EmployeeRoleOption } from '../lib/employeeRoleSelection'

export function EmployeeRolesField({ options, draft, canManage, disabled, unavailable, error, onChange }: {
  options: EmployeeRoleOption[]
  draft: EmployeeRoleDraft
  canManage: boolean
  disabled: boolean
  unavailable: boolean
  error: string | null
  onChange: (draft: EmployeeRoleDraft) => void
}) {
  const [search, setSearch] = useState('')
  const id = useId()
  const visible = options.filter((role) => `${role.name} ${role.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(draft.ids.includes(b.id)) - Number(draft.ids.includes(a.id)) || a.name.localeCompare(b.name))

  return (
    <fieldset className="employee-roles" disabled={disabled || unavailable}>
      <legend>Roles</legend>
      <p id={`${id}-help`}>{canManage
        ? 'Select the roles this employee needs. Selected roles appear first; changes are reviewed before saving.'
        : 'Choose the employee’s scheduling role. Other existing access is preserved and can only be changed by an authorized role manager.'}</p>
      <div className="employee-roles__toolbar">
        <label className="employee-roles__search">
          <span>Find a role</span>
          <div><Search aria-hidden="true" size={18} /><input onChange={(event) => { event.stopPropagation(); setSearch(event.target.value) }} placeholder="Search roles…" type="search" value={search} /></div>
        </label>
        <span aria-live="polite">{draft.ids.length} selected · {visible.length} shown</span>
      </div>
      {unavailable ? <p className="form-note" role="status">The role library is unavailable. You can save profile details without changing existing roles.</p> : null}
      <div aria-describedby={`${id}-help`} aria-label="Available roles" className="employee-roles__list" role="group">
        {visible.map((role) => {
          const selected = draft.ids.includes(role.id)
          const isPrimary = selected && role.systemRole && role.baseAppRole === draft.primaryRole
          return (
            <div className={`employee-roles__row${selected ? ' is-selected' : ''}`} key={role.id}>
              <label>
                <input aria-label={role.name} checked={selected} disabled={(!role.active && !selected) || (!canManage && role.baseAppRole === 'admin')}
                  onChange={() => onChange(toggleEmployeeRole(draft, role, options, canManage))} type="checkbox" />
                <span className="employee-roles__copy">
                  <strong>{role.name}</strong>
                  {role.description ? <small>{role.description}</small> : null}
                  <span className="employee-roles__badges">
                    {role.mfaRequired ? <span><ShieldCheck aria-hidden="true" size={14} />MFA required</span> : null}
                    {isPrimary ? <span>Scheduling default</span> : null}
                    {!role.active ? <span>Unavailable</span> : null}
                  </span>
                </span>
              </label>
              {canManage && selected && role.active && role.systemRole && role.baseAppRole && !isPrimary ? (
                <button aria-label={`Use ${role.name} for scheduling`} className="secondary-button secondary-button--small" onClick={() => onChange({ ...draft, primaryRole: role.baseAppRole })} type="button">Use for scheduling</button>
              ) : null}
            </div>
          )
        })}
        {!visible.length ? <p className="employee-roles__empty">No roles match your search.</p> : null}
      </div>
      <p className="employee-roles__note">{draft.primaryRole
        ? `${employeeRoleLabels[draft.primaryRole]} supplies scheduling and timekeeping defaults. All selected roles contribute access; individual permission exceptions remain unchanged.`
        : 'A scheduling role is required. No replacement role will be added automatically.'}</p>
      {error ? <div className="inline-alert" role="alert">{error}</div> : null}
    </fieldset>
  )
}

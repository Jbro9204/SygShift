import { useId, useState } from 'react'
import { Search, ShieldCheck } from 'lucide-react'
import { employeeRoleLabels, toggleEmployeeRole, type EmployeeRoleDraft, type EmployeeRoleOption } from '../lib/employeeRoleSelection'

const rolePresentation: Record<string, { name?: string; summary: string }> = {
  admin: { summary: 'Full access to system settings, security, permissions, and protected records.' },
  dispatcher: { summary: 'Manages dispatch coverage, calls, incidents, and daily activity.' },
  guard: { summary: 'Views schedules, records time, completes assigned work, and uses employee self-service.' },
  'human resources employee': { name: 'Human Resources', summary: 'Handles employee records, onboarding, HR documents, leave, and employee support.' },
  'human resources manager': { summary: 'Manages all HR functions, compensation, payroll preparation, and employee administration.' },
  'operations manager': { summary: 'Oversees schedules, attendance, patrols, sites, licensing, and operational reports.' },
  'recruiting & licensing': { summary: 'Manages recruiting, onboarding, licenses, credentials, and compliance follow-up.' },
  scheduler: { summary: 'Builds schedules, assigns employees, and manages coverage changes.' },
  supervisor: { summary: 'Supervises teams and reviews schedules, attendance, and daily operations.' },
}

function presentRole(role: EmployeeRoleOption) {
  const presentation = rolePresentation[role.name.trim().toLowerCase()]
  if (presentation) return { name: presentation.name ?? role.name, summary: presentation.summary }
  const description = role.description?.trim() || 'Additional access configured in Roles & Permissions.'
  return { name: role.name, summary: description.length > 130 ? `${description.slice(0, 127).trimEnd()}…` : description }
}

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
  const visible = options.filter((role) => {
    const presentation = presentRole(role)
    return `${role.name} ${presentation.name} ${presentation.summary} ${role.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())
  })
    .sort((a, b) => Number(draft.ids.includes(b.id)) - Number(draft.ids.includes(a.id)) || a.name.localeCompare(b.name))

  return (
    <fieldset className="employee-roles" disabled={disabled || unavailable}>
      <legend>Roles</legend>
      <p id={`${id}-help`}>{canManage
        ? 'Assign the roles this employee needs. The highlighted role sets their scheduling and timekeeping rules.'
        : 'Choose the employee’s scheduling and timekeeping role. Existing protected access is preserved.'}</p>
      <div className="employee-roles__toolbar">
        <label className="employee-roles__search">
          <span>Search roles</span>
          <div><Search aria-hidden="true" size={18} /><input onChange={(event) => { event.stopPropagation(); setSearch(event.target.value) }} placeholder="Search by role name" type="search" value={search} /></div>
        </label>
        <span aria-live="polite" className="employee-roles__count"><strong>{draft.ids.length}</strong> selected{search.trim() ? ` · ${visible.length} found` : ''}</span>
      </div>
      {unavailable ? <p className="form-note" role="status">The role library is unavailable. You can save profile details without changing existing roles.</p> : null}
      <div aria-describedby={`${id}-help`} aria-label="Available roles" className="employee-roles__list" role="group">
        {visible.map((role) => {
          const selected = draft.ids.includes(role.id)
          const isPrimary = selected && role.systemRole && role.baseAppRole === draft.primaryRole
          const presentation = presentRole(role)
          return (
            <div className={`employee-roles__row${selected ? ' is-selected' : ''}`} key={role.id}>
              <label>
                <input aria-label={presentation.name} checked={selected} disabled={(!role.active && !selected) || (!canManage && role.baseAppRole === 'admin')}
                  onChange={() => onChange(toggleEmployeeRole(draft, role, options, canManage))} type="checkbox" />
                <span className="employee-roles__copy">
                  <strong>{presentation.name}</strong>
                  <small>{presentation.summary}</small>
                  <span className="employee-roles__badges">
                    {role.mfaRequired ? <span><ShieldCheck aria-hidden="true" size={14} />MFA required</span> : null}
                    {isPrimary ? <span>Schedule &amp; time default</span> : null}
                    {!role.active ? <span>Unavailable</span> : null}
                  </span>
                </span>
              </label>
              {canManage && selected && role.active && role.systemRole && role.baseAppRole && !isPrimary ? (
                <button aria-label={`Use ${presentation.name} for scheduling and timekeeping`} className="secondary-button secondary-button--small" onClick={() => onChange({ ...draft, primaryRole: role.baseAppRole })} type="button">Make default</button>
              ) : null}
            </div>
          )
        })}
        {!visible.length ? <p className="employee-roles__empty">No roles match your search.</p> : null}
      </div>
      <p className="employee-roles__note">{draft.primaryRole
        ? <><strong>Schedule &amp; timekeeping default:</strong> {employeeRoleLabels[draft.primaryRole]}. Existing individual permissions are unchanged.</>
        : 'A scheduling role is required. No replacement role will be added automatically.'}</p>
      {error ? <div className="inline-alert" role="alert">{error}</div> : null}
    </fieldset>
  )
}

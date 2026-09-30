import { useEffect, useId, useState } from 'react'
import { ChevronDown, Search, ShieldCheck } from 'lucide-react'
import {
  employeeAdditionalRoleIds,
  employeeRoleLabels,
  makeEmployeeRolePrimary,
  toggleEmployeeRole,
  type EmployeeRoleDraft,
  type EmployeeRoleOption,
} from '../lib/employeeRoleSelection'

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

const adminRoleRestriction = 'Only an employee whose primary workforce role is Admin can change Admin access.'

export function EmployeeRolesField({ options, draft, originalPrimaryRole, canManage, canManageAdminRole, disabled, unavailable, error, onChange, readOnlyReason }: {
  options: EmployeeRoleOption[]
  draft: EmployeeRoleDraft
  originalPrimaryRole: EmployeeRoleDraft['primaryRole']
  canManage: boolean
  canManageAdminRole: boolean
  disabled: boolean
  unavailable: boolean
  error: string | null
  onChange: (draft: EmployeeRoleDraft) => void
  readOnlyReason?: string | null
}) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const additionalRoleCount = employeeAdditionalRoleIds(draft, options).length
  useEffect(() => {
    if (error) setExpanded(true)
  }, [error])
  const visible = options.filter((role) => {
    const presentation = presentRole(role)
    return `${role.name} ${presentation.name} ${presentation.summary} ${role.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())
  })
    .sort((a, b) => {
      const aSelected = draft.ids.includes(a.id)
      const bSelected = draft.ids.includes(b.id)
      return Number(bSelected) - Number(aSelected) || Number(b.systemRole) - Number(a.systemRole) || a.name.localeCompare(b.name)
    })

  return (
    <fieldset className={`employee-roles${expanded ? ' is-expanded' : ' is-collapsed'}`}>
      <legend>Roles</legend>
      <div className="employee-roles__summary">
        <div>
          <strong>{draft.primaryRole ? `Primary: ${employeeRoleLabels[draft.primaryRole]}` : 'Primary workforce role required'}</strong>
          <span>{additionalRoleCount} additional {additionalRoleCount === 1 ? 'role' : 'roles'} assigned.</span>
        </div>
        <button aria-controls={`${id}-content`} aria-expanded={expanded} className="secondary-button employee-roles__toggle" onClick={() => setExpanded((value) => !value)} type="button">
          {expanded ? 'Collapse roles' : canManage ? 'Manage roles' : 'View roles'}
          <ChevronDown aria-hidden="true" size={18} />
        </button>
      </div>
      {unavailable ? <p className="form-note" role="status">The role library is unavailable. You can save profile details without changing existing roles.</p> : null}
      {expanded ? <div className="employee-roles__content" id={`${id}-content`}>
        <p id={`${id}-help`}>{canManage
          ? 'Choose exactly one primary workforce role. Additional roles add access without replacing that primary role.'
          : readOnlyReason ?? 'Role assignments are read-only. An administrator with role-management access can change them.'}</p>
        <div className="employee-roles__toolbar">
          <label className="employee-roles__search">
            <span>Search roles</span>
            <div><Search aria-hidden="true" size={18} /><input disabled={unavailable} onChange={(event) => { event.stopPropagation(); setSearch(event.target.value) }} placeholder="Search by role name" type="search" value={search} /></div>
          </label>
          <span aria-live="polite" className="employee-roles__count"><strong>{(draft.primaryRole ? 1 : 0) + additionalRoleCount}</strong> assigned{search.trim() ? ` · ${visible.length} found` : ''}</span>
        </div>
        <div aria-describedby={`${id}-help`} aria-label="Available roles" className="employee-roles__list" role="group">
          {visible.map((role) => {
            const isPrimary = Boolean(role.systemRole && role.baseAppRole === draft.primaryRole)
            const isFormerPrimary = Boolean(role.systemRole && role.baseAppRole === originalPrimaryRole
              && draft.primaryRole !== originalPrimaryRole)
            const adminRoleLocked = Boolean(role.systemRole && role.baseAppRole === 'admin' && !canManageAdminRole)
            const selected = draft.ids.includes(role.id)
            const presentation = presentRole(role)
            const inputDisabled = disabled || unavailable || !canManage || isPrimary || isFormerPrimary || adminRoleLocked
              || (!role.active && !selected) || Boolean(role.unavailable && !selected)
            return (
              <div className={`employee-roles__row${selected ? ' is-selected' : ''}`} key={role.id}>
                <label>
                  <input aria-label={presentation.name} checked={selected} disabled={inputDisabled}
                    onChange={() => onChange(toggleEmployeeRole(draft, role, options, canManage))}
                    type="checkbox" />
                  <span className="employee-roles__copy">
                    <strong>{presentation.name}</strong>
                    <small>{presentation.summary}</small>
                    <span className="employee-roles__badges">
                      {role.mfaRequired ? <span><ShieldCheck aria-hidden="true" size={14} />MFA required</span> : null}
                      {isPrimary ? <span>Primary workforce role</span> : null}
                      {isFormerPrimary ? <span>Save before adding as extra</span> : null}
                      {adminRoleLocked ? <span title={adminRoleRestriction}>Primary Admin only</span> : null}
                      {!isPrimary && selected ? <span>Additional access role</span> : null}
                      {!role.active ? <span>Unavailable</span> : null}
                    </span>
                  </span>
                </label>
                {canManage && role.active && !role.unavailable && role.systemRole && role.baseAppRole && !isPrimary ? (
                  <button aria-label={`Make ${presentation.name} the primary workforce role`} className="secondary-button secondary-button--small"
                    disabled={disabled || unavailable || adminRoleLocked} onClick={() => onChange(makeEmployeeRolePrimary(draft, role, options, canManage))}
                    title={adminRoleLocked ? adminRoleRestriction : undefined} type="button">Make primary</button>
                ) : null}
              </div>
            )
          })}
          {!visible.length ? <p className="employee-roles__empty">No roles match your search.</p> : null}
        </div>
        <p className="employee-roles__note">{draft.primaryRole
          ? <><strong>Primary workforce role:</strong> {employeeRoleLabels[draft.primaryRole]}. {additionalRoleCount ? `${additionalRoleCount} additional access ${additionalRoleCount === 1 ? 'role is' : 'roles are'} applied separately.` : 'No additional access roles are assigned.'}</>
          : 'Choose one primary workforce role before saving.'}</p>
      </div> : null}
      {error ? <div className="inline-alert" role="alert">{error}</div> : null}
    </fieldset>
  )
}

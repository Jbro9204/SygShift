import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, Save, Search, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  clearEmployeePermissionOverride,
  setEmployeeAccessRoles,
  setEmployeePermissionOverride,
  type AccessControlCenter,
  type AccessControlUser,
  type AccessRoleDefinition,
  type OverrideEffect,
  type PermissionDefinition,
} from '../data/accessControl'
import { ModalDialog } from './ModalDialog'

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  guard: 'Guard',
  recruiting_licensing: 'Recruiting & Licensing',
  scheduler: 'Scheduler',
  supervisor: 'Supervisor',
}

type EmployeeAccessTab = 'roles' | 'exceptions' | 'effective'

function permissionTone(permission: PermissionDefinition): string {
  if (permission.riskLevel === 'critical') return 'Critical'
  if (permission.riskLevel === 'sensitive') return 'Sensitive'
  return 'Standard'
}

function groupedPermissions(permissions: PermissionDefinition[]) {
  return permissions.reduce<Record<string, PermissionDefinition[]>>((groups, permission) => {
    groups[permission.category] ??= []
    groups[permission.category].push(permission)
    return groups
  }, {})
}

function permissionMatchesSearch(permission: PermissionDefinition, query: string): boolean {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return true
  return [
    permission.category,
    permission.code,
    permission.description,
    permission.name,
    permission.riskLevel,
    permission.requiresMfa ? 'mfa authenticator secure' : 'no mfa',
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(term))
}

function identifierSetsMatch(selectedIds: Set<string>, assignedIds: string[]): boolean {
  if (selectedIds.size !== assignedIds.length) return false
  return assignedIds.every((id) => selectedIds.has(id))
}

function employeeInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function updateCenter(queryClient: ReturnType<typeof useQueryClient>, center: AccessControlCenter) {
  queryClient.setQueryData(['access-control-center'], center)
}

interface EmployeeAccessWorkspaceProps {
  onClose: () => void
  onSelectUser: (userId: string) => void
  permissions: PermissionDefinition[]
  roles: AccessRoleDefinition[]
  selectedUserId: string
  users: AccessControlUser[]
}

export function EmployeeAccessWorkspace({
  onClose,
  onSelectUser,
  permissions,
  roles,
  selectedUserId,
  users,
}: EmployeeAccessWorkspaceProps) {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<EmployeeAccessTab>('roles')
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set())
  const [roleMessage, setRoleMessage] = useState<string | null>(null)
  const [overrideMessage, setOverrideMessage] = useState<string | null>(null)
  const [overridePermissionSearch, setOverridePermissionSearch] = useState('')
  const [overridePermissionCode, setOverridePermissionCode] = useState(permissions[0]?.code ?? '')
  const [overrideEffect, setOverrideEffect] = useState<OverrideEffect>('grant')
  const [overrideReason, setOverrideReason] = useState('')
  const user = users.find((candidate) => candidate.id === selectedUserId) ?? users[0]
  const permissionByCode = useMemo(() => new Map(permissions.map((permission) => [permission.code, permission])), [permissions])
  const filteredUsers = useMemo(() => {
    const normalized = employeeSearch.trim().toLowerCase()
    if (!normalized) return users
    return users.filter((candidate) => [
      candidate.displayName,
      candidate.username ?? '',
      roleLabels[candidate.primaryRole],
      candidate.jobTitle ?? '',
    ].some((value) => value.toLowerCase().includes(normalized)))
  }, [employeeSearch, users])
  const overridePermissions = useMemo(
    () => permissions.filter((permission) => permissionMatchesSearch(permission, overridePermissionSearch)),
    [overridePermissionSearch, permissions],
  )
  const groupedOverridePermissions = useMemo(
    () => groupedPermissions(overridePermissions),
    [overridePermissions],
  )
  const groupedEffective = useMemo(() => {
    if (!user) return {}
    const visible = user.effectivePermissionCodes
      .map((code) => permissionByCode.get(code))
      .filter((permission): permission is PermissionDefinition => Boolean(permission))
    return groupedPermissions(visible)
  }, [permissionByCode, user])
  const rolesChanged = user ? !identifierSetsMatch(selectedRoleIds, user.assignedRoleIds) : false

  const roleMutation = useMutation({
    mutationFn: ({ employeeId, roleIds }: { employeeId: string, roleIds: string[] }) => setEmployeeAccessRoles(employeeId, roleIds),
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setRoleMessage('Additional role memberships saved and effective access refreshed.')
    },
  })

  const overrideMutation = useMutation({
    mutationFn: setEmployeePermissionOverride,
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setOverrideMessage('Individual permission exception saved and effective access refreshed.')
      setOverrideReason('')
    },
  })

  const clearMutation = useMutation({
    mutationFn: clearEmployeePermissionOverride,
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setOverrideMessage('Individual permission exception removed and effective access refreshed.')
    },
  })
  const modalBusy = roleMutation.isPending || overrideMutation.isPending || clearMutation.isPending

  useEffect(() => {
    if (!user) return
    setSelectedRoleIds(new Set(user.assignedRoleIds))
    setRoleMessage(null)
    setOverrideMessage(null)
  }, [user])

  useEffect(() => {
    if (overridePermissions.some((permission) => permission.code === overridePermissionCode)) return
    setOverridePermissionCode(overridePermissions[0]?.code ?? '')
  }, [overridePermissionCode, overridePermissions])

  if (!user) {
    return (
      <ModalDialog
        className="access-modal access-modal--employee-workspace"
        description="Manage role memberships and individual access exceptions."
        onClose={onClose}
        title="Employee access workspace"
      >
        <div className="employee-access-empty">
          <ShieldAlert aria-hidden="true" size={24} />
          <p>No active employees are available for access management.</p>
        </div>
      </ModalDialog>
    )
  }

  function toggleRole(roleId: string) {
    setSelectedRoleIds((current) => {
      const next = new Set(current)
      if (next.has(roleId)) next.delete(roleId)
      else next.add(roleId)
      return next
    })
    setRoleMessage(null)
  }

  function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!overridePermissionCode || !overrideReason.trim()) return
    setOverrideMessage(null)
    overrideMutation.mutate({
      effect: overrideEffect,
      employeeId: user.id,
      permissionCode: overridePermissionCode,
      reason: overrideReason.trim(),
    })
  }

  return (
    <ModalDialog
      busy={modalBusy}
      busyLabel="Updating employee access and recalculating permissions..."
      className="access-modal access-modal--employee-workspace"
      description="Choose an employee, manage only the access layer you need, and verify the final result before closing."
      onClose={onClose}
      title="Employee access workspace"
    >
      <div className="employee-access-workspace">
        <aside className="employee-access-directory" aria-label="Active employees">
          <div className="employee-access-directory__heading">
            <p className="eyebrow">Active employees</p>
            <strong>{users.length}</strong>
          </div>
          <label className="employee-access-search">
            <Search aria-hidden="true" size={18} />
            <span className="visually-hidden">Search active employees</span>
            <input
              onChange={(event) => setEmployeeSearch(event.target.value)}
              placeholder="Search name, username, role, or title"
              type="search"
              value={employeeSearch}
            />
          </label>
          <div className="employee-access-directory__list">
            {filteredUsers.map((candidate) => (
              <button
                aria-current={candidate.id === user.id ? 'true' : undefined}
                className={candidate.id === user.id ? 'employee-access-person employee-access-person--selected' : 'employee-access-person'}
                disabled={modalBusy}
                key={candidate.id}
                onClick={() => onSelectUser(candidate.id)}
                type="button"
              >
                <span className="employee-access-person__initials" aria-hidden="true">
                  {employeeInitials(candidate.displayName)}
                </span>
                <span>
                  <strong>{candidate.displayName}</strong>
                  <small>@{candidate.username || 'no-login'} · {roleLabels[candidate.primaryRole]}</small>
                </span>
                {candidate.overrides.length > 0 ? <em>{candidate.overrides.length} exception{candidate.overrides.length === 1 ? '' : 's'}</em> : null}
              </button>
            ))}
            {filteredUsers.length === 0 ? <p className="employee-access-directory__empty">No active employees match that search.</p> : null}
          </div>
        </aside>

        <section className="employee-access-workarea">
          <header className="employee-access-banner">
            <div>
              <p className="eyebrow">Selected employee</p>
              <h3>{user.displayName}</h3>
              <span>@{user.username || 'no-login'} · Primary role: {roleLabels[user.primaryRole]}{user.jobTitle ? ` · ${user.jobTitle}` : ''}</span>
            </div>
            <span className="status-pill status-pill--green">Active</span>
          </header>

          <div className="employee-access-guidance">
            <ShieldCheck aria-hidden="true" size={20} />
            <p><strong>Roles provide normal access.</strong> Use an individual exception only for a documented one-person need. A deny takes priority over a grant.</p>
          </div>

          <div className="employee-access-tabs" role="tablist" aria-label="Employee access sections">
            <button aria-selected={activeTab === 'roles'} onClick={() => setActiveTab('roles')} role="tab" type="button">
              Role memberships
              <span>{selectedRoleIds.size}</span>
            </button>
            <button aria-selected={activeTab === 'exceptions'} onClick={() => setActiveTab('exceptions')} role="tab" type="button">
              Individual exceptions
              <span>{user.overrides.length}</span>
            </button>
            <button aria-selected={activeTab === 'effective'} onClick={() => setActiveTab('effective')} role="tab" type="button">
              Effective access
              <span>{user.effectivePermissionCodes.length}</span>
            </button>
          </div>

          <div className="employee-access-tabpanel" role="tabpanel">
            {activeTab === 'roles' ? (
              <section className="employee-access-step">
                <div className="employee-access-step__heading">
                  <div>
                    <p className="eyebrow">Standard access</p>
                    <h3>Additional role memberships</h3>
                    <p>The employee keeps their primary {roleLabels[user.primaryRole]} role. Select only the extra groups they also need.</p>
                  </div>
                  <span>{selectedRoleIds.size} selected</span>
                </div>
                <div className="employee-role-grid">
                  {roles.map((role) => (
                    <label className={selectedRoleIds.has(role.id) ? 'employee-role-option employee-role-option--selected' : 'employee-role-option'} key={role.id}>
                      <input checked={selectedRoleIds.has(role.id)} onChange={() => toggleRole(role.id)} type="checkbox" />
                      <span>
                        <strong>{role.name}</strong>
                        <small>{role.description || (role.systemRole ? 'Standard SygShift role.' : 'Custom access role.')}</small>
                      </span>
                      <em>{role.permissionCodes.length} permissions</em>
                    </label>
                  ))}
                </div>
                <div className="employee-access-actionbar">
                  <div className={rolesChanged ? 'access-save-status access-save-status--dirty' : 'access-save-status access-save-status--idle'} role="status" aria-live="polite">
                    {rolesChanged ? <ShieldAlert aria-hidden="true" size={18} /> : <CheckCircle2 aria-hidden="true" size={18} />}
                    <span>{rolesChanged ? 'Unsaved role changes' : 'Role memberships are saved.'}</span>
                  </div>
                  <button
                    className="access-control-button access-control-button--primary"
                    disabled={roleMutation.isPending || !rolesChanged}
                    onClick={() => roleMutation.mutate({ employeeId: user.id, roleIds: [...selectedRoleIds] })}
                    type="button"
                  >
                    <Save aria-hidden="true" size={18} />
                    {roleMutation.isPending ? 'Saving roles...' : 'Save role memberships'}
                  </button>
                </div>
                {roleMessage ? <p className="form-feedback form-feedback--success" role="status">{roleMessage}</p> : null}
                {roleMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{roleMutation.error.message}</p> : null}
              </section>
            ) : null}

            {activeTab === 'exceptions' ? (
              <section className="employee-access-step">
                <div className="employee-access-step__heading">
                  <div>
                    <p className="eyebrow">One-person access</p>
                    <h3>Individual permission exceptions</h3>
                    <p>Grant or deny one permission without changing the employee’s roles. Every exception requires an audit reason.</p>
                  </div>
                  <span>{user.overrides.length} active</span>
                </div>
                <div className="employee-exception-grid">
                  <form className="employee-exception-form" onSubmit={submitOverride}>
                    <h4>Add or replace an exception</h4>
                    <label className="permission-search permission-search--override">
                      <Search aria-hidden="true" size={18} />
                      <span className="visually-hidden">Search permissions to grant or deny</span>
                      <input
                        onChange={(event) => setOverridePermissionSearch(event.target.value)}
                        placeholder="Search permission name, category, or code"
                        type="search"
                        value={overridePermissionSearch}
                      />
                    </label>
                    <label>
                      <span>Permission</span>
                      <select disabled={overridePermissions.length === 0} onChange={(event) => setOverridePermissionCode(event.target.value)} value={overridePermissionCode}>
                        {Object.entries(groupedOverridePermissions).map(([category, categoryPermissions]) => (
                          <optgroup key={category} label={category}>
                            {categoryPermissions.map((permission) => <option key={permission.code} value={permission.code}>{permission.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    {overridePermissions.length === 0 ? <p className="permission-search-empty">No permissions match that search.</p> : null}
                    <fieldset className="employee-exception-effect">
                      <legend>Exception type</legend>
                      <label className={overrideEffect === 'grant' ? 'employee-exception-effect__option employee-exception-effect__option--selected' : 'employee-exception-effect__option'}>
                        <input checked={overrideEffect === 'grant'} name="override-effect" onChange={() => setOverrideEffect('grant')} type="radio" value="grant" />
                        <span><strong>Grant</strong><small>Add this permission for this person.</small></span>
                      </label>
                      <label className={overrideEffect === 'deny' ? 'employee-exception-effect__option employee-exception-effect__option--selected' : 'employee-exception-effect__option'}>
                        <input checked={overrideEffect === 'deny'} name="override-effect" onChange={() => setOverrideEffect('deny')} type="radio" value="deny" />
                        <span><strong>Deny</strong><small>Block this permission for this person.</small></span>
                      </label>
                    </fieldset>
                    <label>
                      <span>Required audit reason</span>
                      <textarea onChange={(event) => setOverrideReason(event.target.value)} placeholder="Explain the business reason for this one-person exception." required rows={4} value={overrideReason} />
                    </label>
                    <button className="access-control-button access-control-button--primary" disabled={overrideMutation.isPending || overridePermissions.length === 0 || !overrideReason.trim()} type="submit">
                      {overrideMutation.isPending ? 'Saving exception...' : 'Save individual exception'}
                    </button>
                  </form>

                  <div className="employee-exception-list">
                    <h4>Active exceptions</h4>
                    {user.overrides.length === 0 ? (
                      <div className="employee-exception-empty">
                        <CheckCircle2 aria-hidden="true" size={22} />
                        <strong>No individual exceptions</strong>
                        <p>This employee currently receives access only through their primary role and additional role memberships.</p>
                      </div>
                    ) : user.overrides.map((override) => {
                      const permission = permissionByCode.get(override.permissionCode)
                      return (
                        <article className={`employee-exception-card employee-exception-card--${override.effect}`} key={override.id}>
                          <header><span>{override.effect === 'grant' ? 'Granted' : 'Denied'}</span><strong>{permission?.name ?? override.permissionCode}</strong></header>
                          <p>{permission?.category ?? 'Permission'} · {permission?.description || override.permissionCode}</p>
                          <dl>
                            <div><dt>Reason</dt><dd>{override.reason}</dd></div>
                            <div><dt>Recorded</dt><dd>{override.createdAt}</dd></div>
                          </dl>
                          <button className="access-control-button access-control-button--secondary" disabled={clearMutation.isPending} onClick={() => clearMutation.mutate(override.id)} type="button">Remove exception</button>
                        </article>
                      )
                    })}
                  </div>
                </div>
                {overrideMessage ? <p className="form-feedback form-feedback--success" role="status">{overrideMessage}</p> : null}
                {overrideMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{overrideMutation.error.message}</p> : null}
                {clearMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{clearMutation.error.message}</p> : null}
              </section>
            ) : null}

            {activeTab === 'effective' ? (
              <section className="employee-access-step">
                <div className="employee-access-step__heading">
                  <div>
                    <p className="eyebrow">Read-only verification</p>
                    <h3>Final effective access</h3>
                    <p>This is the access SygShift calculates after the primary role, additional roles, individual grants, and individual denies are combined.</p>
                  </div>
                  <span>{user.effectivePermissionCodes.length} permissions</span>
                </div>
                <div className="effective-access-summary">
                  <div><strong>{roleLabels[user.primaryRole]}</strong><span>Primary role</span></div>
                  <div><strong>{user.assignedRoleIds.length}</strong><span>Additional roles</span></div>
                  <div><strong>{user.overrides.length}</strong><span>Individual exceptions</span></div>
                </div>
                <div className="effective-access-groups">
                  {Object.entries(groupedEffective).map(([category, categoryPermissions]) => (
                    <details className="effective-access-group" key={category}>
                      <summary><span><strong>{category}</strong><small>{categoryPermissions.length} permissions</small></span><ChevronDown aria-hidden="true" size={20} /></summary>
                      <div>
                        {categoryPermissions.map((permission) => (
                          <article key={permission.code}>
                            <span><strong>{permission.name}</strong><small>{permission.description}</small></span>
                            <em>{permission.requiresMfa ? 'MFA' : permissionTone(permission)}</em>
                          </article>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </section>
      </div>
      <div className="employee-access-workspace__footer">
        <p>Changes are protected by MFA, applied by the server, and recorded in the audit history.</p>
        <button className="access-control-button access-control-button--secondary" disabled={modalBusy} onClick={onClose} type="button">Close workspace</button>
      </div>
    </ModalDialog>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CheckCircle2,
  Info,
  LockKeyhole,
  Minus,
  Plus,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
} from 'lucide-react'
import {
  setEmployeeAccessProfile,
  type AccessControlCenter,
  type AccessControlUser,
  type AccessRoleDefinition,
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
  return [permission.category, permission.code, permission.description, permission.name, permission.riskLevel]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(term))
}

function setsMatch(left: Set<string>, right: string[]): boolean {
  if (left.size !== right.length) return false
  return right.every((value) => left.has(value))
}

function updateCenter(queryClient: ReturnType<typeof useQueryClient>, center: AccessControlCenter) {
  queryClient.setQueryData(['access-control-center'], center)
}

function employeeInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function riskLabel(permission: PermissionDefinition): string | null {
  if (permission.riskLevel === 'critical') return 'Critical'
  if (permission.riskLevel === 'sensitive') return 'Sensitive'
  return null
}

interface EmployeeAccessWorkspaceProps {
  onDirtyChange: (dirty: boolean) => void
  onSelectUser: (userId: string) => void
  permissions: PermissionDefinition[]
  roles: AccessRoleDefinition[]
  selectedUserId: string
  users: AccessControlUser[]
}

export function EmployeeAccessWorkspace({
  onDirtyChange,
  onSelectUser,
  permissions,
  roles,
  selectedUserId,
  users,
}: EmployeeAccessWorkspaceProps) {
  const queryClient = useQueryClient()
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [permissionSearch, setPermissionSearch] = useState('')
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set())
  const [selectedAdditionCodes, setSelectedAdditionCodes] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [confirmSensitive, setConfirmSensitive] = useState(false)
  const user = users.find((candidate) => candidate.id === selectedUserId) ?? users[0]

  const permissionByCode = useMemo(
    () => new Map(permissions.map((permission) => [permission.code, permission])),
    [permissions],
  )
  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles])
  const primaryRole = useMemo(
    () => roles.find((role) => role.systemRole && role.baseAppRole === user?.primaryRole),
    [roles, user?.primaryRole],
  )
  const assignableRoles = useMemo(
    () => roles.filter((role) => role.id !== primaryRole?.id),
    [primaryRole?.id, roles],
  )
  const inheritedCodes = useMemo(() => {
    const codes = new Set(primaryRole?.permissionCodes ?? [])
    selectedRoleIds.forEach((roleId) => roleById.get(roleId)?.permissionCodes.forEach((code) => codes.add(code)))
    return codes
  }, [primaryRole?.permissionCodes, roleById, selectedRoleIds])
  const storedGrantCodes = useMemo(
    () => user?.overrides.filter((override) => override.effect === 'grant').map((override) => override.permissionCode) ?? [],
    [user?.overrides],
  )
  const legacyDenies = useMemo(
    () => user?.overrides.filter((override) => override.effect === 'deny') ?? [],
    [user?.overrides],
  )
  const legacyDeniedCodes = useMemo(
    () => new Set(legacyDenies.map((override) => override.permissionCode)),
    [legacyDenies],
  )
  const originalAdditionCodes = useMemo(
    () => storedGrantCodes.filter((code) => !inheritedCodes.has(code)),
    [inheritedCodes, storedGrantCodes],
  )
  const effectiveCodes = useMemo(() => {
    const codes = new Set(inheritedCodes)
    selectedAdditionCodes.forEach((code) => codes.add(code))
    legacyDenies.forEach((override) => codes.delete(override.permissionCode))
    return codes
  }, [inheritedCodes, legacyDenies, selectedAdditionCodes])
  const availableAdditions = useMemo(
    () => permissions.filter((permission) => (
      !inheritedCodes.has(permission.code)
      && !legacyDeniedCodes.has(permission.code)
    )),
    [inheritedCodes, legacyDeniedCodes, permissions],
  )
  const visiblePermissions = useMemo(
    () => availableAdditions.filter((permission) => (
      (!showSelectedOnly || selectedAdditionCodes.has(permission.code))
      && permissionMatchesSearch(permission, permissionSearch)
    )),
    [availableAdditions, permissionSearch, selectedAdditionCodes, showSelectedOnly],
  )
  const grouped = useMemo(() => groupedPermissions(visiblePermissions), [visiblePermissions])
  const filteredUsers = useMemo(() => {
    const query = employeeSearch.trim().toLocaleLowerCase()
    if (!query) return users
    return users.filter((candidate) => [
      candidate.displayName,
      candidate.username ?? '',
      candidate.jobTitle ?? '',
      roleLabels[candidate.primaryRole],
    ].some((value) => value.toLocaleLowerCase().includes(query)))
  }, [employeeSearch, users])
  const rolesChanged = user ? !setsMatch(selectedRoleIds, user.assignedRoleIds) : false
  const additionsChanged = !setsMatch(selectedAdditionCodes, originalAdditionCodes)
  const hasUnsavedChanges = rolesChanged || additionsChanged
  const changeCount = (
    [...selectedRoleIds].filter((id) => !user?.assignedRoleIds.includes(id)).length
    + (user?.assignedRoleIds.filter((id) => !selectedRoleIds.has(id)).length ?? 0)
    + [...selectedAdditionCodes].filter((code) => !originalAdditionCodes.includes(code)).length
    + originalAdditionCodes.filter((code) => !selectedAdditionCodes.has(code)).length
  )
  const newlyGrantedSensitive = useMemo(
    () => [...effectiveCodes].filter((code) => (
      !user?.effectivePermissionCodes.includes(code)
      && ['sensitive', 'critical'].includes(permissionByCode.get(code)?.riskLevel ?? '')
    )),
    [effectiveCodes, permissionByCode, user?.effectivePermissionCodes],
  )

  const mutation = useMutation({
    mutationFn: setEmployeeAccessProfile,
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Employee access saved and effective permissions refreshed.')
      setReason('')
      setConfirmSensitive(false)
    },
  })

  useEffect(() => {
    if (!user) return
    const nextRoles = new Set(user.assignedRoleIds)
    const baseCodes = new Set(primaryRole?.permissionCodes ?? [])
    nextRoles.forEach((roleId) => roleById.get(roleId)?.permissionCodes.forEach((code) => baseCodes.add(code)))
    setSelectedRoleIds(nextRoles)
    setSelectedAdditionCodes(new Set(
      user.overrides
        .filter((override) => override.effect === 'grant' && !baseCodes.has(override.permissionCode))
        .map((override) => override.permissionCode),
    ))
    setReason('')
    setMessage(null)
    setOpenCategory(null)
  }, [primaryRole?.permissionCodes, roleById, user])

  useEffect(() => {
    setSelectedAdditionCodes((current) => new Set([...current].filter((code) => !inheritedCodes.has(code))))
  }, [inheritedCodes])

  useEffect(() => {
    if (!permissionSearch.trim()) return
    const firstCategory = Object.keys(grouped)[0]
    if (firstCategory) setOpenCategory(firstCategory)
  }, [grouped, permissionSearch])

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsavedChanges])

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges)
    return () => onDirtyChange(false)
  }, [hasUnsavedChanges, onDirtyChange])

  if (!user) {
    return (
      <section className="employee-access-empty">
        <ShieldAlert aria-hidden="true" size={24} />
        <p>No active employees are available for access management.</p>
      </section>
    )
  }

  function chooseUser(userId: string) {
    if (userId === user.id) return
    if (hasUnsavedChanges && !window.confirm('Discard unsaved employee access changes?')) return
    onSelectUser(userId)
  }

  function toggleRole(roleId: string) {
    setSelectedRoleIds((current) => {
      const next = new Set(current)
      if (next.has(roleId)) next.delete(roleId)
      else next.add(roleId)
      return next
    })
    setMessage(null)
  }

  function togglePermission(code: string) {
    setSelectedAdditionCodes((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
    setMessage(null)
  }

  function resetChanges() {
    const nextRoles = new Set(user.assignedRoleIds)
    const baseCodes = new Set(primaryRole?.permissionCodes ?? [])
    nextRoles.forEach((roleId) => roleById.get(roleId)?.permissionCodes.forEach((code) => baseCodes.add(code)))
    setSelectedRoleIds(nextRoles)
    setSelectedAdditionCodes(new Set(storedGrantCodes.filter((code) => !baseCodes.has(code))))
    setReason('')
    setMessage(null)
  }

  function saveProfile() {
    if (!reason.trim()) return
    if (newlyGrantedSensitive.length > 0) {
      setConfirmSensitive(true)
      return
    }
    mutation.mutate({ employeeId: user.id, permissionCodes: [...selectedAdditionCodes], reason: reason.trim(), roleIds: [...selectedRoleIds] })
  }

  function confirmSave() {
    mutation.mutate({ employeeId: user.id, permissionCodes: [...selectedAdditionCodes], reason: reason.trim(), roleIds: [...selectedRoleIds] })
  }

  return (
    <section className="access-employee-mode">
      <aside className="access-employee-directory" aria-label="Active employees">
        <div className="access-panel-heading">
          <div><p className="eyebrow">Employees</p><h2>Choose a person</h2></div>
          <span>{users.length}</span>
        </div>
        <label className="access-search-field">
          <Search aria-hidden="true" size={18} />
          <span className="visually-hidden">Search active employees</span>
          <input onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search name, username, role, or title" type="search" value={employeeSearch} />
        </label>
        <div className="access-employee-list">
          {filteredUsers.map((candidate) => (
            <button aria-current={candidate.id === user.id ? 'true' : undefined} className={candidate.id === user.id ? 'access-person access-person--selected' : 'access-person'} key={candidate.id} onClick={() => chooseUser(candidate.id)} type="button">
              <span className="access-person__initials" aria-hidden="true">{employeeInitials(candidate.displayName)}</span>
              <span><strong>{candidate.displayName}</strong><small>@{candidate.username || 'no-login'} · {roleLabels[candidate.primaryRole]}</small></span>
            </button>
          ))}
          {filteredUsers.length === 0 ? <p className="permission-search-empty">No employees match that search.</p> : null}
        </div>
      </aside>

      <div className="access-employee-editor">
        <header className="access-employee-summary">
          <div><p className="eyebrow">Employee access</p><h2>{user.displayName}</h2><p>@{user.username || 'no-login'}{user.jobTitle ? ` · ${user.jobTitle}` : ''}</p></div>
          <span className="status-pill status-pill--green">Active</span>
        </header>

        <div className="access-summary-strip" aria-label="Employee access summary">
          <div><strong>{roleLabels[user.primaryRole]}</strong><span>Primary role</span></div>
          <div><strong>{selectedRoleIds.size}</strong><span>Additional roles</span></div>
          <div><strong>{inheritedCodes.size}</strong><span>Inherited access</span></div>
          <div><strong>{selectedAdditionCodes.size}</strong><span>Individual additions</span></div>
          <div><strong>{effectiveCodes.size}</strong><span>Effective access</span></div>
        </div>

        <section className="access-editor-section">
          <div className="access-section-heading">
            <div><UsersRound aria-hidden="true" size={20} /><span><strong>Additional role memberships</strong><small>The employee always keeps their primary {roleLabels[user.primaryRole]} role.</small></span></div>
            <span>{selectedRoleIds.size} selected</span>
          </div>
          <div className="access-role-memberships">
            {assignableRoles.map((role) => (
              <label className={selectedRoleIds.has(role.id) ? 'access-role-check access-role-check--selected' : 'access-role-check'} key={role.id}>
                <input checked={selectedRoleIds.has(role.id)} onChange={() => toggleRole(role.id)} type="checkbox" />
                <span><strong>{role.name}</strong><small>{role.permissionCodes.length} permissions{role.mfaRequired ? ' · MFA required' : ''}</small></span>
                {selectedRoleIds.has(role.id) ? <Check aria-hidden="true" size={18} /> : null}
              </label>
            ))}
          </div>
        </section>

        <section className="access-editor-section">
          <div className="access-section-heading">
            <div><UserRoundCog aria-hidden="true" size={20} /><span><strong>Individual permission additions</strong><small>Only permissions not already inherited from a role are available.</small></span></div>
            <span>{selectedAdditionCodes.size} selected</span>
          </div>
          <div className="access-permission-toolbar">
            <label className="access-search-field">
              <Search aria-hidden="true" size={18} />
              <span className="visually-hidden">Search available permission additions</span>
              <input onChange={(event) => setPermissionSearch(event.target.value)} placeholder="Search permissions" type="search" value={permissionSearch} />
            </label>
            <label className="access-filter-check"><input checked={showSelectedOnly} onChange={(event) => setShowSelectedOnly(event.target.checked)} type="checkbox" /><span>Show selected only</span></label>
          </div>
          <div className="access-permission-accordion">
            {Object.entries(grouped).map(([category, categoryPermissions]) => {
              const activeCount = categoryPermissions.filter((permission) => selectedAdditionCodes.has(permission.code)).length
              const open = openCategory === category
              return (
                <section className={open ? 'access-permission-group access-permission-group--open' : 'access-permission-group'} key={category}>
                  <button aria-expanded={open} className="access-permission-group__header" onClick={() => setOpenCategory(open ? null : category)} type="button">
                    <span><strong>{category}</strong><small>{activeCount > 0 ? `${activeCount} added` : 'None added'} · {categoryPermissions.length} available</small></span>
                    {open ? <Minus aria-hidden="true" size={18} /> : <Plus aria-hidden="true" size={18} />}
                  </button>
                  {open ? (
                    <div className="access-permission-group__body">
                      {categoryPermissions.map((permission) => {
                        const selected = selectedAdditionCodes.has(permission.code)
                        const tone = riskLabel(permission)
                        return (
                          <label className={selected ? 'access-permission-row access-permission-row--selected' : 'access-permission-row'} key={permission.code}>
                            <span><strong>{permission.name}</strong></span>
                            <span
                              aria-hidden={permission.description ? undefined : 'true'}
                              className={permission.description ? 'access-permission-info' : 'access-permission-info access-permission-info--empty'}
                              title={permission.description ?? undefined}
                            >
                              <Info aria-hidden="true" size={16} />
                              {permission.description ? <span className="visually-hidden">{permission.description}</span> : null}
                            </span>
                            <span className="access-permission-badges">
                              {tone ? <em className={`access-risk access-risk--${permission.riskLevel}`}>{tone}</em> : null}
                              {permission.requiresMfa ? <em className="access-risk access-risk--mfa">MFA</em> : null}
                            </span>
                            <input aria-label={`${selected ? 'Remove' : 'Add'} ${permission.name}`} checked={selected} onChange={() => togglePermission(permission.code)} type="checkbox" />
                          </label>
                        )
                      })}
                    </div>
                  ) : null}
                </section>
              )
            })}
            {visiblePermissions.length === 0 ? <p className="permission-search-empty">No available permissions match this view.</p> : null}
          </div>
        </section>

        {legacyDenies.length > 0 ? (
          <details className="access-legacy-restrictions">
            <summary><LockKeyhole aria-hidden="true" size={18} /><span><strong>{legacyDenies.length} protected legacy restriction{legacyDenies.length === 1 ? '' : 's'}</strong><small>Preserved to prevent an unintended production access change.</small></span><Plus aria-hidden="true" size={18} /></summary>
            <div>{legacyDenies.map((override) => <p key={override.id}><strong>{permissionByCode.get(override.permissionCode)?.name ?? override.permissionCode}</strong><span>{override.reason}</span></p>)}</div>
          </details>
        ) : null}

        {hasUnsavedChanges ? (
          <div className="access-sticky-savebar">
            <div><ShieldAlert aria-hidden="true" size={20} /><span><strong>{changeCount} unsaved change{changeCount === 1 ? '' : 's'}</strong><small>All changes are applied together and written to the audit history.</small></span></div>
            <label><span>Required audit reason</span><input onChange={(event) => setReason(event.target.value)} placeholder="Why is this access changing?" value={reason} /></label>
            <button className="access-control-button access-control-button--secondary" disabled={mutation.isPending} onClick={resetChanges} type="button">Cancel</button>
            <button className="access-control-button access-control-button--primary" disabled={mutation.isPending || !reason.trim()} onClick={saveProfile} type="button"><Save aria-hidden="true" size={18} />{mutation.isPending ? 'Saving...' : 'Save employee permissions'}</button>
          </div>
        ) : null}

        {message ? <p className="form-feedback form-feedback--success" role="status"><CheckCircle2 aria-hidden="true" size={18} />{message}</p> : null}
        {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
      </div>

      {confirmSensitive ? (
        <ModalDialog busy={mutation.isPending} busyLabel="Applying protected access changes..." className="access-modal access-modal--confirmation" description="This employee will receive one or more sensitive permissions that may expose protected information or administrative actions." onClose={() => setConfirmSensitive(false)} title="Confirm sensitive access">
          <div className="access-confirmation-list">
            {newlyGrantedSensitive.map((code) => <p key={code}><ShieldAlert aria-hidden="true" size={18} /><span><strong>{permissionByCode.get(code)?.name ?? code}</strong><small>{permissionByCode.get(code)?.description}</small></span></p>)}
          </div>
          <div className="modal-actions">
            <button className="access-control-button access-control-button--secondary" onClick={() => setConfirmSensitive(false)} type="button">Go back</button>
            <button className="access-control-button access-control-button--primary" disabled={mutation.isPending} onClick={confirmSave} type="button"><ShieldCheck aria-hidden="true" size={18} />Confirm and save</button>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  )
}

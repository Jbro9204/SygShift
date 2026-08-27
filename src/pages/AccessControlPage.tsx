import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from 'react-router-dom'
import {
  BadgeCheck,
  CheckCircle2,
  Info,
  LockKeyhole,
  Minus,
  Plus,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { EmployeeAccessWorkspace } from '../components/EmployeeAccessWorkspace'
import { ModalDialog } from '../components/ModalDialog'
import {
  getAccessControlCenter,
  setAccessRolePermissions,
  upsertAccessRole,
  type AccessControlCenter,
  type AccessRoleDefinition,
  type PermissionDefinition,
} from '../data/accessControl'

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  guard: 'Guard',
  recruiting_licensing: 'Recruiting & Licensing',
  scheduler: 'Scheduler',
  supervisor: 'Supervisor',
}

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
    permission.locked ? 'locked system' : 'editable custom',
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(term))
}

function filterPermissions(permissions: PermissionDefinition[], query: string): PermissionDefinition[] {
  return permissions.filter((permission) => permissionMatchesSearch(permission, query))
}

function updateCenter(queryClient: ReturnType<typeof useQueryClient>, center: AccessControlCenter) {
  queryClient.setQueryData(['access-control-center'], center)
}

function selectedCount(categoryPermissions: PermissionDefinition[], selectedCodes: Set<string>): number {
  return categoryPermissions.filter((permission) => selectedCodes.has(permission.code)).length
}

function permissionSetsMatch(selectedCodes: Set<string>, permissionCodes: string[]): boolean {
  if (selectedCodes.size !== permissionCodes.length) return false
  return permissionCodes.every((code) => selectedCodes.has(code))
}

function PermissionGroup({
  category,
  permissions,
  selectedCodes,
  onToggle,
  open,
  onOpenChange,
}: {
  category: string
  permissions: PermissionDefinition[]
  selectedCodes: Set<string>
  onToggle: (code: string) => void
  open: boolean
  onOpenChange: () => void
}) {
  const activeCount = selectedCount(permissions, selectedCodes)

  return (
    <section className={open ? 'access-permission-group access-permission-group--open' : 'access-permission-group'}>
      <button aria-expanded={open} className="access-permission-group__header" onClick={onOpenChange} type="button">
        <span>
          <strong>{category}</strong>
          <small>{activeCount} of {permissions.length} enabled</small>
        </span>
        {open ? <Minus aria-hidden="true" size={18} /> : <Plus aria-hidden="true" size={18} />}
      </button>
      {open ? <div className="access-permission-group__body">
        {permissions.map((permission) => {
          const checked = selectedCodes.has(permission.code)
          return (
            <label
              className={checked ? 'access-permission-row access-permission-row--selected' : 'access-permission-row'}
              key={permission.code}
            >
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
                {permission.riskLevel !== 'standard' ? <em className={`access-risk access-risk--${permission.riskLevel}`}>{permissionTone(permission)}</em> : null}
                {permission.requiresMfa ? <em className="access-risk access-risk--mfa">MFA</em> : null}
              </span>
              <input
                aria-label={`${checked ? 'Disable' : 'Enable'} ${permission.name}`}
                checked={checked}
                onChange={() => onToggle(permission.code)}
                type="checkbox"
              />
            </label>
          )
        })}
      </div> : null}
    </section>
  )
}

function RoleTile({
  role,
  selected,
  onSelect,
}: {
  role: AccessRoleDefinition
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={selected ? 'role-tile role-tile--active' : 'role-tile'}
      onClick={onSelect}
      type="button"
    >
      <span>
        <strong>{role.name}</strong>
        <small>{role.systemRole ? `System role${role.baseAppRole ? ` · ${roleLabels[role.baseAppRole]}` : ''}` : 'Custom role'}</small>
      </span>
      <span className="role-tile__meta">
        <em>{role.permissionCodes.length} perms</em>
        <em>{role.assignedCount} people</em>
      </span>
    </button>
  )
}

function CreateRoleModal({
  existingRoleIds,
  onClose,
  onSaved,
  permissions,
}: {
  existingRoleIds: string[]
  onClose: () => void
  onSaved: (message: string) => void
  permissions: PermissionDefinition[]
}) {
  const queryClient = useQueryClient()
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set())
  const [permissionSearch, setPermissionSearch] = useState('')
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const visiblePermissions = useMemo(
    () => filterPermissions(permissions, permissionSearch),
    [permissionSearch, permissions],
  )
  const grouped = useMemo(() => groupedPermissions(visiblePermissions), [visiblePermissions])
  const mutation = useMutation({
    mutationFn: async (input: { name: string, description: string | null, mfaRequired: boolean, permissionCodes: string[] }) => {
      const createdCenter = await upsertAccessRole({
        description: input.description,
        mfaRequired: input.mfaRequired,
        name: input.name,
      })
      const createdRole = createdCenter.roles.find((role) => !existingRoleIds.includes(role.id))
        ?? createdCenter.roles.find((role) => !role.systemRole && role.name.toLowerCase() === input.name.toLowerCase())
      if (!createdRole || input.permissionCodes.length === 0) return createdCenter
      return setAccessRolePermissions(createdRole.id, input.permissionCodes)
    },
    onSuccess: (center, input) => {
      updateCenter(queryClient, center)
      const permissionLabel = input.permissionCodes.length === 1 ? '1 permission' : `${input.permissionCodes.length} permissions`
      onSaved(input.permissionCodes.length > 0 ? `${input.name} created. ${permissionLabel} saved.` : `${input.name} created.`)
      onClose()
    },
  })

  function togglePermission(code: string) {
    setSelectedCodes((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  useEffect(() => {
    if (!permissionSearch.trim()) return
    const firstCategory = Object.keys(grouped)[0]
    if (firstCategory) setOpenCategory(firstCategory)
  }, [grouped, permissionSearch])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    mutation.mutate({
      description: String(data.get('description') ?? '').trim() || null,
      mfaRequired: data.get('mfaRequired') === 'on',
      name: String(data.get('name') ?? '').trim(),
      permissionCodes: [...selectedCodes],
    })
  }

  return (
    <ModalDialog
      busy={mutation.isPending}
      busyLabel="Creating role..."
      className="access-modal access-modal--wide"
      description="Create a custom access group, then choose the permission nests it should include."
      onClose={onClose}
      title="Create custom role"
    >
      <form className="access-modal-form" onSubmit={submit}>
        <div className="access-modal-grid">
          <section className="access-modal-card">
            <label>
              <span>Role name</span>
              <input name="name" placeholder="Example: Assistant Scheduler" required />
            </label>
            <label>
              <span>Description</span>
              <textarea name="description" placeholder="What this role is meant to do." rows={4} />
            </label>
            <label className="access-checkline">
              <input defaultChecked name="mfaRequired" type="checkbox" />
              <span>Require MFA when this role is assigned</span>
            </label>
            <div className="access-modal-summary">
              <strong>{selectedCodes.size}</strong>
              <span>permissions selected</span>
            </div>
          </section>

          <section className="access-modal-card access-modal-card--permissions">
            <p className="eyebrow">Permission nests</p>
            <label className="permission-search">
              <Search aria-hidden="true" size={18} />
              <span className="visually-hidden">Search permissions</span>
              <input
                onChange={(event) => setPermissionSearch(event.target.value)}
                placeholder="Search permissions, categories, codes, or MFA"
                type="search"
                value={permissionSearch}
              />
            </label>
            {visiblePermissions.length === 0 ? (
              <p className="permission-search-empty">No permissions match that search.</p>
            ) : (
              <div className="permission-nest-list">
                {Object.entries(grouped).map(([category, categoryPermissions]) => (
                  <PermissionGroup
                    category={category}
                    key={category}
                    onToggle={togglePermission}
                    onOpenChange={() => setOpenCategory(openCategory === category ? null : category)}
                    open={openCategory === category}
                    permissions={categoryPermissions}
                    selectedCodes={selectedCodes}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="modal-actions">
          <button className="access-control-button access-control-button--secondary" onClick={onClose} type="button">Cancel</button>
          <button className="access-control-button access-control-button--primary" disabled={mutation.isPending} type="submit">
            <Plus aria-hidden="true" size={18} />
            Create role
          </button>
        </div>
        {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
      </form>
    </ModalDialog>
  )
}

function RolePermissionEditor({
  onDirtyChange,
  permissions,
  role,
}: {
  onDirtyChange: (dirty: boolean) => void
  permissions: PermissionDefinition[]
  role: AccessRoleDefinition
}) {
  const queryClient = useQueryClient()
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set(role.permissionCodes))
  const [message, setMessage] = useState<string | null>(null)
  const [permissionSearch, setPermissionSearch] = useState('')
  const [showEnabledOnly, setShowEnabledOnly] = useState(false)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const [confirmSensitive, setConfirmSensitive] = useState(false)
  const visiblePermissions = useMemo(
    () => filterPermissions(permissions, permissionSearch).filter((permission) => !showEnabledOnly || selectedCodes.has(permission.code)),
    [permissionSearch, permissions, selectedCodes, showEnabledOnly],
  )
  const grouped = useMemo(() => groupedPermissions(visiblePermissions), [visiblePermissions])
  const hasUnsavedChanges = useMemo(
    () => !permissionSetsMatch(selectedCodes, role.permissionCodes),
    [role.permissionCodes, selectedCodes],
  )
  const changeCount = useMemo(() => (
    [...selectedCodes].filter((code) => !role.permissionCodes.includes(code)).length
    + role.permissionCodes.filter((code) => !selectedCodes.has(code)).length
  ), [role.permissionCodes, selectedCodes])
  const newSensitiveCodes = useMemo(() => [...selectedCodes].filter((code) => {
    const permission = permissions.find((candidate) => candidate.code === code)
    return !role.permissionCodes.includes(code) && permission && ['sensitive', 'critical'].includes(permission.riskLevel)
  }), [permissions, role.permissionCodes, selectedCodes])
  const mutation = useMutation({
    mutationFn: (codes: string[]) => setAccessRolePermissions(role.id, codes),
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Role permissions saved.')
      setConfirmSensitive(false)
    },
  })

  useEffect(() => {
    setSelectedCodes(new Set(role.permissionCodes))
    setOpenCategory(null)
    setShowEnabledOnly(false)
  }, [role.id, role.permissionCodes])

  useEffect(() => {
    setMessage(null)
  }, [role.id])

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges)
    return () => onDirtyChange(false)
  }, [hasUnsavedChanges, onDirtyChange])

  useEffect(() => {
    if (!permissionSearch.trim()) return
    const firstCategory = Object.keys(grouped)[0]
    if (firstCategory) setOpenCategory(firstCategory)
  }, [grouped, permissionSearch])

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsavedChanges])

  function togglePermission(code: string) {
    setSelectedCodes((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
    setMessage(null)
  }

  function savePermissions() {
    if (newSensitiveCodes.length > 0) {
      setConfirmSensitive(true)
      return
    }
    mutation.mutate([...selectedCodes])
  }

  return (
    <section className="access-workspace-card">
      <div className="access-workspace-card__header">
        <div>
          <p className="eyebrow">Permission workspace</p>
          <h2>{role.name}</h2>
          <p>{role.description || 'No description has been added for this role yet.'}</p>
        </div>
        <div className="access-role-summary">
          <span className={role.protected ? 'status-pill status-pill--gold' : 'status-pill'}>
            {role.protected ? 'Protected' : role.systemRole ? 'System' : 'Custom'}
          </span>
          <strong>{selectedCodes.size}</strong>
          <small>permissions enabled</small>
          <small>{role.assignedCount} employee{role.assignedCount === 1 ? '' : 's'} assigned</small>
          <small>{role.protected ? 'Safety permissions locked' : 'Editable role'}</small>
        </div>
      </div>

      <div className="access-permission-toolbar">
        <label className="access-search-field">
          <Search aria-hidden="true" size={18} />
          <span className="visually-hidden">Search permissions</span>
          <input onChange={(event) => setPermissionSearch(event.target.value)} placeholder="Search permissions" type="search" value={permissionSearch} />
        </label>
        <label className="access-filter-check"><input checked={showEnabledOnly} onChange={(event) => setShowEnabledOnly(event.target.checked)} type="checkbox" /><span>Show enabled only</span></label>
      </div>

      {visiblePermissions.length === 0 ? (
        <p className="permission-search-empty">No permissions match that search.</p>
      ) : (
        <div className="access-permission-accordion">
          {Object.entries(grouped).map(([category, categoryPermissions]) => (
            <PermissionGroup
              category={category}
              key={category}
              onToggle={togglePermission}
              onOpenChange={() => setOpenCategory(openCategory === category ? null : category)}
              open={openCategory === category}
              permissions={categoryPermissions}
              selectedCodes={selectedCodes}
            />
          ))}
        </div>
      )}

      {hasUnsavedChanges ? (
        <div className="access-sticky-savebar">
          <div><ShieldAlert aria-hidden="true" size={20} /><span><strong>{changeCount} unsaved change{changeCount === 1 ? '' : 's'}</strong><small>Changes to {role.name} will affect {role.assignedCount} employee{role.assignedCount === 1 ? '' : 's'}.</small></span></div>
          <button className="access-control-button access-control-button--secondary" disabled={mutation.isPending} onClick={() => setSelectedCodes(new Set(role.permissionCodes))} type="button">Cancel</button>
          <button className="access-control-button access-control-button--primary" disabled={mutation.isPending} onClick={savePermissions} type="button"><Save aria-hidden="true" size={18} />{mutation.isPending ? 'Saving...' : 'Save role permissions'}</button>
        </div>
      ) : null}
      {message ? <p className="form-feedback form-feedback--success" role="status"><CheckCircle2 aria-hidden="true" size={18} />{message}</p> : null}
      {role.protected ? (
        <p className="access-security-note">
          <LockKeyhole aria-hidden="true" size={17} />
          Protected Admin safety permissions cannot be removed.
        </p>
      ) : null}
      {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
      {confirmSensitive ? (
        <ModalDialog busy={mutation.isPending} busyLabel="Saving sensitive role permissions..." className="access-modal access-modal--confirmation" description="These permissions may expose protected information or administrative actions to everyone assigned to this role." onClose={() => setConfirmSensitive(false)} title="Confirm sensitive role access">
          <div className="access-confirmation-list">
            {newSensitiveCodes.map((code) => {
              const permission = permissions.find((candidate) => candidate.code === code)
              return <p key={code}><ShieldAlert aria-hidden="true" size={18} /><span><strong>{permission?.name ?? code}</strong><small>{permission?.description}</small></span></p>
            })}
          </div>
          <div className="modal-actions">
            <button className="access-control-button access-control-button--secondary" onClick={() => setConfirmSensitive(false)} type="button">Go back</button>
            <button className="access-control-button access-control-button--primary" disabled={mutation.isPending} onClick={() => mutation.mutate([...selectedCodes])} type="button"><ShieldCheck aria-hidden="true" size={18} />Confirm and save</button>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  )
}

function AccessControlState({
  children,
  icon,
  title,
  tone,
}: {
  children: ReactNode
  icon: typeof ShieldAlert
  title: string
  tone?: 'setup' | 'error' | 'empty'
}) {
  return (
    <div className="page-stack access-control-page">
      <section className="page-hero page-hero--split access-hero">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Roles & Permissions</h1>
          <p>
            Active Directory style control for SygShift. Build clean roles first,
            then handle per-person exceptions only when they are truly needed.
          </p>
        </div>
      </section>
      <DataStatePanel icon={icon} title={title} tone={tone}>{children}</DataStatePanel>
    </div>
  )
}

export function AccessControlPage() {
  const [activeMode, setActiveMode] = useState<'roles' | 'employees'>('roles')
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [createRoleOpen, setCreateRoleOpen] = useState(false)
  const [roleDirty, setRoleDirty] = useState(false)
  const [employeeDirty, setEmployeeDirty] = useState(false)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const centerQuery = useQuery({
    queryFn: getAccessControlCenter,
    queryKey: ['access-control-center'],
  })

  const center = centerQuery.data
  const selectedRole = center?.roles.find((role) => role.id === selectedRoleId) ?? center?.roles[0]
  const hasUnsavedChanges = roleDirty || employeeDirty
  const blocker = useBlocker(hasUnsavedChanges)
  const handleRoleDirtyChange = useCallback((dirty: boolean) => setRoleDirty(dirty), [])
  const handleEmployeeDirtyChange = useCallback((dirty: boolean) => setEmployeeDirty(dirty), [])

  useEffect(() => {
    if (!selectedRoleId && center?.roles[0]) setSelectedRoleId(center.roles[0].id)
    if (!selectedUserId && center?.users[0]) setSelectedUserId(center.users[0].id)
  }, [center, selectedRoleId, selectedUserId])

  useEffect(() => {
    if (!saveNotice) return
    const timerId = window.setTimeout(() => setSaveNotice(null), 6500)
    return () => window.clearTimeout(timerId)
  }, [saveNotice])

  function changeMode(nextMode: 'roles' | 'employees') {
    if (nextMode === activeMode) return
    if (hasUnsavedChanges && !window.confirm('Discard unsaved permission changes?')) return
    setActiveMode(nextMode)
  }

  function chooseRole(roleId: string) {
    if (roleId === selectedRole?.id) return
    if (roleDirty && !window.confirm('Discard unsaved role permission changes?')) return
    setSelectedRoleId(roleId)
  }

  if (centerQuery.isPending) {
    return (
      <AccessControlState icon={ShieldCheck} title="Loading roles and permissions">
        <p>Retrieving the active permission catalog, role matrix, employee assignments, and override records.</p>
      </AccessControlState>
    )
  }

  if (centerQuery.isError) {
    return (
      <AccessControlState icon={ShieldAlert} title="Roles & Permissions unavailable" tone="error">
        <p>{centerQuery.error.message}</p>
        <p>Sign in as an MFA-verified Admin before managing access control.</p>
      </AccessControlState>
    )
  }

  if (!center) {
    return (
      <AccessControlState icon={ShieldAlert} title="Roles & Permissions unavailable" tone="error">
        <p>The access-control center did not return a usable payload.</p>
      </AccessControlState>
    )
  }

  return (
    <div className="page-stack access-control-page">
      <section className="page-hero page-hero--split access-hero">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Roles & Permissions</h1>
          <p>
            Build reusable role access, then add only the extra permissions a specific
            employee needs. Every saved change remains protected by MFA and audit history.
          </p>
        </div>
        <div className="hero-action-card">
          <SlidersHorizontal aria-hidden="true" size={24} />
          <strong>Last loaded</strong>
          <span>{center.generatedAt}</span>
        </div>
      </section>

      <section className="access-command-center access-command-center--redesigned">
        <div className="access-mode-tabs" aria-label="Permission management mode" role="tablist">
          <button aria-controls="role-permission-panel" aria-selected={activeMode === 'roles'} className={activeMode === 'roles' ? 'access-mode-tab access-mode-tab--active' : 'access-mode-tab'} id="role-permission-tab" onClick={() => changeMode('roles')} role="tab" type="button">
            <ShieldCheck aria-hidden="true" size={19} />
            <span><strong>Role & Group Permissions</strong><small>Set the baseline for a role</small></span>
          </button>
          <button aria-controls="employee-permission-panel" aria-selected={activeMode === 'employees'} className={activeMode === 'employees' ? 'access-mode-tab access-mode-tab--active' : 'access-mode-tab'} id="employee-permission-tab" onClick={() => changeMode('employees')} role="tab" type="button">
            <UsersRound aria-hidden="true" size={19} />
            <span><strong>Employee Permissions</strong><small>Add access for one person</small></span>
          </button>
        </div>
        <div className="access-overview-grid">
          <div>
            <strong>{center.roles.length}</strong>
            <span>Active roles</span>
          </div>
          <div>
            <strong>{center.permissions.length}</strong>
            <span>Permissions</span>
          </div>
          <div>
            <strong>{center.users.length}</strong>
            <span>Active employees</span>
          </div>
          <div>
            <strong>{center.users.reduce((total, user) => total + user.overrides.filter((override) => override.effect === 'grant').length, 0)}</strong>
            <span>Individual additions</span>
          </div>
        </div>
      </section>

      {saveNotice ? (
        <div className="access-save-status access-save-status--saved access-page-save-notice" role="status" aria-live="polite">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{saveNotice}</span>
        </div>
      ) : null}

      {activeMode === 'roles' ? (
        <section aria-labelledby="role-permission-tab" className="access-role-mode" id="role-permission-panel" role="tabpanel">
          <aside className="access-role-directory">
            <div className="access-panel-heading">
              <div><p className="eyebrow">Role library</p><h2>Choose a role</h2></div>
              <span>{center.roles.length}</span>
            </div>
            <div className="access-role-list">
              {center.roles.map((role) => (
                <RoleTile key={role.id} onSelect={() => chooseRole(role.id)} role={role} selected={selectedRole?.id === role.id} />
              ))}
            </div>
            <button className="access-control-button access-control-button--primary access-role-create" onClick={() => setCreateRoleOpen(true)} type="button">
              <Plus aria-hidden="true" size={18} />Create role
            </button>
          </aside>
          {selectedRole ? <RolePermissionEditor onDirtyChange={handleRoleDirtyChange} permissions={center.permissions} role={selectedRole} /> : null}
        </section>
      ) : (
        <div aria-labelledby="employee-permission-tab" id="employee-permission-panel" role="tabpanel">
          <EmployeeAccessWorkspace
            onDirtyChange={handleEmployeeDirtyChange}
            onSelectUser={setSelectedUserId}
            permissions={center.permissions}
            roles={center.roles}
            selectedUserId={selectedUserId ?? center.users[0]?.id ?? ''}
            users={center.users}
          />
        </div>
      )}

      <section className="access-security-note access-security-note--wide">
        <BadgeCheck aria-hidden="true" size={20} />
        <div>
          <strong>Rule of record</strong>
          <p>
            Role permissions provide the baseline. Additional role memberships and individual
            additions can expand access. Existing legacy restrictions remain protected and visible
            until they are reviewed separately, so this redesign cannot silently change access.
          </p>
        </div>
      </section>

      {createRoleOpen ? (
        <CreateRoleModal
          existingRoleIds={center.roles.map((role) => role.id)}
          onClose={() => setCreateRoleOpen(false)}
          onSaved={setSaveNotice}
          permissions={center.permissions}
        />
      ) : null}

      {blocker.state === 'blocked' ? (
        <ModalDialog className="access-modal access-modal--confirmation" description="You have permission changes that have not been saved. Leaving now will discard them." onClose={() => blocker.reset()} title="Discard unsaved changes?">
          <div className="modal-actions">
            <button className="access-control-button access-control-button--secondary" onClick={() => blocker.reset()} type="button">Keep editing</button>
            <button className="access-control-button access-control-button--danger" onClick={() => blocker.proceed()} type="button">Discard and leave</button>
          </div>
        </ModalDialog>
      ) : null}

    </div>
  )
}

import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  ChevronDown,
  LockKeyhole,
  Plus,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserRoundCog,
  X,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  clearEmployeePermissionOverride,
  getAccessControlCenter,
  setAccessRolePermissions,
  setEmployeeAccessRoles,
  setEmployeePermissionOverride,
  upsertAccessRole,
  type AccessControlCenter,
  type AccessControlUser,
  type AccessRoleDefinition,
  type OverrideEffect,
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

function updateCenter(queryClient: ReturnType<typeof useQueryClient>, center: AccessControlCenter) {
  queryClient.setQueryData(['access-control-center'], center)
}

function selectedCount(categoryPermissions: PermissionDefinition[], selectedCodes: Set<string>): number {
  return categoryPermissions.filter((permission) => selectedCodes.has(permission.code)).length
}

function PermissionGroup({
  category,
  permissions,
  selectedCodes,
  onToggle,
  openByDefault,
}: {
  category: string
  permissions: PermissionDefinition[]
  selectedCodes: Set<string>
  onToggle: (code: string) => void
  openByDefault?: boolean
}) {
  const activeCount = selectedCount(permissions, selectedCodes)

  return (
    <details className="permission-nest" open={openByDefault || activeCount > 0}>
      <summary>
        <span>
          <strong>{category}</strong>
          <small>{activeCount} of {permissions.length} enabled</small>
        </span>
        <ChevronDown aria-hidden="true" size={20} />
      </summary>
      <div className="permission-nest__body">
        {permissions.map((permission) => {
          const checked = selectedCodes.has(permission.code)
          return (
            <label
              className={checked ? 'permission-row permission-row--checked' : 'permission-row'}
              key={permission.code}
            >
              <input
                checked={checked}
                onChange={() => onToggle(permission.code)}
                type="checkbox"
              />
              <span>
                <strong>{permission.name}</strong>
                <small>{permission.description}</small>
              </span>
              <em>{permissionTone(permission)}</em>
            </label>
          )
        })}
      </div>
    </details>
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
  permissions,
}: {
  existingRoleIds: string[]
  onClose: () => void
  permissions: PermissionDefinition[]
}) {
  const queryClient = useQueryClient()
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set())
  const grouped = useMemo(() => groupedPermissions(permissions), [permissions])
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
    onSuccess: (center) => {
      updateCenter(queryClient, center)
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
            <div className="permission-nest-list">
              {Object.entries(grouped).map(([category, categoryPermissions], index) => (
                <PermissionGroup
                  category={category}
                  key={category}
                  onToggle={togglePermission}
                  openByDefault={index === 0}
                  permissions={categoryPermissions}
                  selectedCodes={selectedCodes}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-button" disabled={mutation.isPending} type="submit">
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
  permissions,
  role,
}: {
  permissions: PermissionDefinition[]
  role: AccessRoleDefinition
}) {
  const queryClient = useQueryClient()
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set(role.permissionCodes))
  const [message, setMessage] = useState<string | null>(null)
  const grouped = useMemo(() => groupedPermissions(permissions), [permissions])
  const mutation = useMutation({
    mutationFn: (codes: string[]) => setAccessRolePermissions(role.id, codes),
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Role permissions saved.')
    },
  })

  useEffect(() => {
    setSelectedCodes(new Set(role.permissionCodes))
    setMessage(null)
  }, [role.id, role.permissionCodes])

  function togglePermission(code: string) {
    setSelectedCodes((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
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
        </div>
      </div>

      <div className="permission-nest-list">
        {Object.entries(grouped).map(([category, categoryPermissions], index) => (
          <PermissionGroup
            category={category}
            key={category}
            onToggle={togglePermission}
            openByDefault={index === 0}
            permissions={categoryPermissions}
            selectedCodes={selectedCodes}
          />
        ))}
      </div>

      <div className="access-actions">
        <button
          className="primary-button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate([...selectedCodes])}
          type="button"
        >
          <Save aria-hidden="true" size={18} />
          Save permissions
        </button>
        <p>Changes apply to everyone assigned to this role.</p>
      </div>
      {role.protected ? (
        <p className="access-security-note">
          <LockKeyhole aria-hidden="true" size={17} />
          Protected Admin safety permissions cannot be removed.
        </p>
      ) : null}
      {message ? <p className="form-feedback form-feedback--success" role="status">{message}</p> : null}
      {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
    </section>
  )
}

function EmployeeAccessEditor({
  onClose,
  permissions,
  roles,
  user,
}: {
  onClose: () => void
  permissions: PermissionDefinition[]
  roles: AccessRoleDefinition[]
  user: AccessControlUser
}) {
  const queryClient = useQueryClient()
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set(user.assignedRoleIds))
  const [message, setMessage] = useState<string | null>(null)
  const permissionByCode = useMemo(() => new Map(permissions.map((permission) => [permission.code, permission])), [permissions])
  const groupedEffective = useMemo(() => {
    const visible = user.effectivePermissionCodes
      .map((code) => permissionByCode.get(code))
      .filter((permission): permission is PermissionDefinition => Boolean(permission))
    return groupedPermissions(visible)
  }, [permissionByCode, user.effectivePermissionCodes])

  const roleMutation = useMutation({
    mutationFn: (roleIds: string[]) => setEmployeeAccessRoles(user.id, roleIds),
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Employee role assignments saved.')
    },
  })

  const overrideMutation = useMutation({
    mutationFn: setEmployeePermissionOverride,
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Employee permission override saved.')
    },
  })

  const clearMutation = useMutation({
    mutationFn: clearEmployeePermissionOverride,
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Employee permission override removed.')
    },
  })
  const modalBusy = roleMutation.isPending || overrideMutation.isPending || clearMutation.isPending

  useEffect(() => {
    setSelectedRoleIds(new Set(user.assignedRoleIds))
    setMessage(null)
  }, [user.id, user.assignedRoleIds])

  function toggleRole(roleId: string) {
    setSelectedRoleIds((current) => {
      const next = new Set(current)
      if (next.has(roleId)) next.delete(roleId)
      else next.add(roleId)
      return next
    })
  }

  function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    overrideMutation.mutate({
      effect: String(data.get('effect')) as OverrideEffect,
      employeeId: user.id,
      permissionCode: String(data.get('permissionCode')),
      reason: String(data.get('reason') ?? '').trim(),
    }, {
      onSuccess: () => form.reset(),
    })
  }

  return (
    <ModalDialog
      busy={modalBusy}
      busyLabel="Updating employee access..."
      className="access-modal access-modal--wide"
      description="Adjust extra role memberships, individual grants, individual denies, and review final effective permissions."
      onClose={onClose}
      title={`Employee access: ${user.displayName}`}
    >
      <div className="employee-access-window">
        <section className="employee-access-banner">
          <div>
            <p className="eyebrow">Selected employee</p>
            <h3>{user.displayName}</h3>
            <span>@{user.username || 'no-login'} · Primary role: {roleLabels[user.primaryRole]}{user.jobTitle ? ` · ${user.jobTitle}` : ''}</span>
          </div>
          <span className="status-pill status-pill--green">Active</span>
        </section>

        <div className="employee-access-grid">
          <section className="access-modal-card">
            <h3>Additional role memberships</h3>
            <div className="employee-role-picklist">
              {roles.map((role) => (
                <label className="access-checkline access-checkline--card" key={role.id}>
                  <input checked={selectedRoleIds.has(role.id)} onChange={() => toggleRole(role.id)} type="checkbox" />
                  <span>
                    <strong>{role.name}</strong>
                    <small>{role.systemRole ? 'System role can be assigned as an extra group.' : 'Custom role'}</small>
                  </span>
                </label>
              ))}
            </div>
            <button
              className="primary-button"
              disabled={roleMutation.isPending}
              onClick={() => roleMutation.mutate([...selectedRoleIds])}
              type="button"
            >
              <Save aria-hidden="true" size={18} />
              Save employee roles
            </button>
          </section>

          <section className="access-modal-card">
            <h3>Individual permission override</h3>
            <form className="access-override-form" onSubmit={submitOverride}>
              <label>
                <span>Permission</span>
                <select name="permissionCode">
                  {permissions.map((permission) => (
                    <option key={permission.code} value={permission.code}>
                      {permission.category} — {permission.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Effect</span>
                <select name="effect">
                  <option value="grant">Grant</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
              <label>
                <span>Reason</span>
                <textarea name="reason" placeholder="Required audit note." required rows={3} />
              </label>
              <button className="secondary-button" disabled={overrideMutation.isPending} type="submit">
                Apply override
              </button>
            </form>
          </section>
        </div>

        <section className="access-override-list">
          <h3>Active individual overrides</h3>
          {user.overrides.length === 0 ? (
            <p>No person-specific overrides are active.</p>
          ) : (
            <div className="override-chip-list">
              {user.overrides.map((override) => (
                <span className={`override-chip override-chip--${override.effect}`} key={override.id}>
                  <strong>{override.effect === 'grant' ? 'Grant' : 'Deny'}:</strong> {permissionByCode.get(override.permissionCode)?.name ?? override.permissionCode}
                  <button onClick={() => clearMutation.mutate(override.id)} type="button">Remove</button>
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="effective-permissions">
          <h3>Effective permissions preview</h3>
          <p>This is the final calculated access after primary role, extra role memberships, grants, and denies.</p>
          {Object.entries(groupedEffective).map(([category, categoryPermissions]) => (
            <div className="effective-permissions__group" key={category}>
              <strong>{category}</strong>
              <div>
                {categoryPermissions.map((permission) => (
                  <span key={permission.code}>{permission.name}</span>
                ))}
              </div>
            </div>
          ))}
        </section>
        {message ? <p className="form-feedback form-feedback--success" role="status">{message}</p> : null}
        {roleMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{roleMutation.error.message}</p> : null}
        {overrideMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{overrideMutation.error.message}</p> : null}
        {clearMutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{clearMutation.error.message}</p> : null}
      </div>
    </ModalDialog>
  )
}

function EmployeeAccessLauncher({
  onSelect,
  selectedUserId,
  users,
}: {
  onSelect: (userId: string) => void
  selectedUserId: string
  users: AccessControlUser[]
}) {
  const [query, setQuery] = useState('')
  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return users
    return users.filter((user) => [
      user.displayName,
      user.username ?? '',
      roleLabels[user.primaryRole],
      user.jobTitle ?? '',
    ].some((value) => value.toLowerCase().includes(normalized)))
  }, [query, users])

  return (
    <section className="employee-access-launcher">
      <div>
        <p className="eyebrow">Employee exceptions</p>
        <h2>Work a person only when needed</h2>
        <p>Use this for one-off access changes. Normal permissions should live in roles.</p>
      </div>
      <div className="employee-access-search">
        <Search aria-hidden="true" size={18} />
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search employee, username, role, or title"
          value={query}
        />
      </div>
      <select
        className="access-employee-select"
        onChange={(event) => onSelect(event.target.value)}
        value={selectedUserId}
      >
        {filteredUsers.map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName} — {roleLabels[user.primaryRole]}
          </option>
        ))}
      </select>
      {filteredUsers.length === 0 ? <p className="form-feedback form-feedback--error">No active employees match that search.</p> : null}
    </section>
  )
}

export function AccessControlPage() {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [createRoleOpen, setCreateRoleOpen] = useState(false)
  const [employeeAccessOpen, setEmployeeAccessOpen] = useState(false)
  const [employeeEditorOpen, setEmployeeEditorOpen] = useState(false)
  const centerQuery = useQuery({
    queryFn: getAccessControlCenter,
    queryKey: ['access-control-center'],
  })

  const center = centerQuery.data
  const selectedRole = center?.roles.find((role) => role.id === selectedRoleId) ?? center?.roles[0]
  const selectedUser = center?.users.find((user) => user.id === selectedUserId) ?? center?.users[0]

  useEffect(() => {
    if (!selectedRoleId && center?.roles[0]) setSelectedRoleId(center.roles[0].id)
    if (!selectedUserId && center?.users[0]) setSelectedUserId(center.users[0].id)
  }, [center, selectedRoleId, selectedUserId])

  if (centerQuery.isPending) {
    return (
      <DataStatePanel icon={ShieldCheck} title="Loading roles and permissions">
        <p>Retrieving the active permission catalog, role matrix, employee assignments, and override records.</p>
      </DataStatePanel>
    )
  }

  if (centerQuery.isError) {
    return (
      <DataStatePanel icon={ShieldAlert} title="Roles & Permissions unavailable" tone="error">
        <p>{centerQuery.error.message}</p>
        <p>Sign in as an MFA-verified Admin before managing access control.</p>
      </DataStatePanel>
    )
  }

  if (!center) {
    return (
      <DataStatePanel icon={ShieldAlert} title="Roles & Permissions unavailable" tone="error">
        <p>The access-control center did not return a usable payload.</p>
      </DataStatePanel>
    )
  }

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
        <div className="hero-action-card">
          <SlidersHorizontal aria-hidden="true" size={24} />
          <strong>Last loaded</strong>
          <span>{center.generatedAt}</span>
        </div>
      </section>

      <section className="access-command-center">
        <div className="access-command-center__actions">
          <button className="primary-button" onClick={() => setCreateRoleOpen(true)} type="button">
            <Plus aria-hidden="true" size={18} />
            Create role
          </button>
          <button className="secondary-button" onClick={() => setEmployeeAccessOpen(true)} type="button">
            <UserRoundCog aria-hidden="true" size={18} />
            Manage employee access
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
            <strong>{center.users.reduce((total, user) => total + user.overrides.length, 0)}</strong>
            <span>Person overrides</span>
          </div>
        </div>
      </section>

      <section className="role-library-panel">
        <div className="role-library-panel__heading">
          <div>
            <p className="eyebrow">Role library</p>
            <h2>Choose a role to edit</h2>
          </div>
          <span>{center.roles.length} roles</span>
        </div>
        <div className="role-tile-grid">
          {center.roles.map((role) => (
            <RoleTile
              key={role.id}
              onSelect={() => setSelectedRoleId(role.id)}
              role={role}
              selected={selectedRole?.id === role.id}
            />
          ))}
        </div>
      </section>

      {selectedRole ? <RolePermissionEditor permissions={center.permissions} role={selectedRole} /> : null}

      <section className="access-security-note access-security-note--wide">
        <BadgeCheck aria-hidden="true" size={20} />
        <div>
          <strong>Rule of record</strong>
          <p>
            Final access is calculated from primary employee role, extra role memberships,
            individual grants, and individual denies. Denies win over grants.
          </p>
        </div>
      </section>

      {createRoleOpen ? (
        <CreateRoleModal
          existingRoleIds={center.roles.map((role) => role.id)}
          onClose={() => setCreateRoleOpen(false)}
          permissions={center.permissions}
        />
      ) : null}

      {employeeAccessOpen ? (
        <ModalDialog
          className="access-modal"
          description="Choose an employee before opening their access editor."
          onClose={() => setEmployeeAccessOpen(false)}
          title="Manage employee access"
        >
          <EmployeeAccessLauncher
            onSelect={(userId) => setSelectedUserId(userId)}
            selectedUserId={selectedUser?.id ?? ''}
            users={center.users}
          />
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setEmployeeAccessOpen(false)} type="button">
              <X aria-hidden="true" size={18} />
              Close
            </button>
            <button
              className="primary-button"
              disabled={!selectedUser}
              onClick={() => {
                if (!selectedUser) return
                setEmployeeAccessOpen(false)
                setEmployeeEditorOpen(true)
              }}
              type="button"
            >
              Open editor
            </button>
          </div>
        </ModalDialog>
      ) : null}

      {!employeeAccessOpen && selectedUser ? (
        <button
          aria-label="Open employee access chooser"
          className="employee-access-floating-button"
          onClick={() => setEmployeeAccessOpen(true)}
          type="button"
        >
          <UserRoundCog aria-hidden="true" size={20} />
          Employee access
        </button>
      ) : null}

      {employeeEditorOpen && selectedUser ? (
        <EmployeeAccessEditor
          onClose={() => setEmployeeEditorOpen(false)}
          permissions={center.permissions}
          roles={center.roles}
          user={selectedUser}
        />
      ) : null}
    </div>
  )
}

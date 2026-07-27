import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  LockKeyhole,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserRoundCog,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
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

function RoleCard({
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
      className={selected ? 'access-role-card access-role-card--active' : 'access-role-card'}
      onClick={onSelect}
      type="button"
    >
      <span>
        <strong>{role.name}</strong>
        <small>{role.systemRole ? `System role${role.baseAppRole ? ` · ${roleLabels[role.baseAppRole]}` : ''}` : 'Custom role'}</small>
      </span>
      <span className="access-role-card__meta">
        {role.permissionCodes.length} permissions · {role.assignedCount} assigned
      </span>
    </button>
  )
}

function CreateRolePanel() {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: upsertAccessRole,
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Custom role created.')
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    mutation.mutate({
      description: String(data.get('description') ?? '').trim() || null,
      mfaRequired: data.get('mfaRequired') === 'on',
      name: String(data.get('name') ?? '').trim(),
    }, {
      onSuccess: () => form.reset(),
    })
  }

  return (
    <form className="access-create-card" onSubmit={submit}>
      <div>
        <p className="eyebrow">Custom roles</p>
        <h2>Create a role</h2>
        <p>Use this when someone needs a named access group beyond Guard, Scheduler, Supervisor, or Admin.</p>
      </div>
      <label>
        <span>Role name</span>
        <input name="name" placeholder="Example: Assistant Scheduler" required />
      </label>
      <label>
        <span>Description</span>
        <textarea name="description" placeholder="What this role is meant to do." rows={3} />
      </label>
      <label className="access-checkline">
        <input defaultChecked name="mfaRequired" type="checkbox" />
        <span>Require MFA when this role is assigned</span>
      </label>
      <button className="primary-button" disabled={mutation.isPending} type="submit">
        <Plus aria-hidden="true" size={18} />
        Create role
      </button>
      {message ? <p className="form-feedback form-feedback--success" role="status">{message}</p> : null}
      {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
    </form>
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
    <section className="access-editor-card">
      <div className="access-editor-card__header">
        <div>
          <p className="eyebrow">Permission matrix</p>
          <h2>{role.name}</h2>
          <p>{role.description || 'No description has been added for this role yet.'}</p>
        </div>
        <span className={role.protected ? 'status-pill status-pill--gold' : 'status-pill'}>
          {role.protected ? 'Protected' : role.systemRole ? 'System' : 'Custom'}
        </span>
      </div>

      <div className="permission-category-list">
        {Object.entries(grouped).map(([category, categoryPermissions]) => (
          <section className="permission-category-card" key={category}>
            <h3>{category}</h3>
            <div className="permission-grid">
              {categoryPermissions.map((permission) => {
                const checked = selectedCodes.has(permission.code)
                return (
                  <label
                    className={checked ? 'permission-toggle permission-toggle--checked' : 'permission-toggle'}
                    key={permission.code}
                  >
                    <input
                      checked={checked}
                      onChange={() => togglePermission(permission.code)}
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
          </section>
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
        <p>{selectedCodes.size} active permissions selected.</p>
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
  permissions,
  roles,
  user,
}: {
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
    <section className="access-editor-card">
      <div className="access-editor-card__header">
        <div>
          <p className="eyebrow">Per-person control</p>
          <h2>{user.displayName}</h2>
          <p>
            @{user.username || 'no-login'} · Primary role: {roleLabels[user.primaryRole]}{user.jobTitle ? ` · ${user.jobTitle}` : ''}
          </p>
        </div>
        <span className="status-pill status-pill--green">Active</span>
      </div>

      <div className="access-two-column">
        <section>
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

        <section>
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
    </section>
  )
}

export function AccessControlPage() {
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
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
      <section className="page-hero page-hero--split">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Roles & Permissions</h1>
          <p>
            Active Directory style access control for SygShift: system roles, custom roles,
            per-person grants and denies, and an effective permissions preview.
          </p>
        </div>
        <div className="hero-action-card">
          <SlidersHorizontal aria-hidden="true" size={24} />
          <strong>Last loaded</strong>
          <span>{center.generatedAt}</span>
        </div>
      </section>

      <section className="access-overview-grid">
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
      </section>

      <div className="access-layout">
        <aside className="access-side-panel">
          <CreateRolePanel />
          <section className="access-list-panel">
            <div>
              <p className="eyebrow">Role library</p>
              <h2>Choose role</h2>
            </div>
            <div className="access-role-list">
              {center.roles.map((role) => (
                <RoleCard
                  key={role.id}
                  onSelect={() => setSelectedRoleId(role.id)}
                  role={role}
                  selected={selectedRole?.id === role.id}
                />
              ))}
            </div>
          </section>
        </aside>

        <div className="access-main-panel">
          {selectedRole ? <RolePermissionEditor permissions={center.permissions} role={selectedRole} /> : null}

          <section className="access-list-panel">
            <div className="access-editor-card__header">
              <div>
                <p className="eyebrow">Employee access</p>
                <h2>Select employee</h2>
              </div>
              <UserRoundCog aria-hidden="true" size={24} />
            </div>
            <select
              className="access-employee-select"
              onChange={(event) => setSelectedUserId(event.target.value)}
              value={selectedUser?.id ?? ''}
            >
              {center.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} — {roleLabels[user.primaryRole]}
                </option>
              ))}
            </select>
          </section>

          {selectedUser ? (
            <EmployeeAccessEditor permissions={center.permissions} roles={center.roles} user={selectedUser} />
          ) : null}
        </div>
      </div>

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
    </div>
  )
}

import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  ChevronDown,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  Plus,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserRoundCog,
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
                {Object.entries(grouped).map(([category, categoryPermissions], index) => (
                  <PermissionGroup
                    category={category}
                    key={category}
                    onToggle={togglePermission}
                    openByDefault={permissionSearch.trim().length > 0 || index === 0}
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
  permissions,
  role,
}: {
  permissions: PermissionDefinition[]
  role: AccessRoleDefinition
}) {
  const queryClient = useQueryClient()
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set(role.permissionCodes))
  const [message, setMessage] = useState<string | null>(null)
  const [permissionSearch, setPermissionSearch] = useState('')
  const visiblePermissions = useMemo(
    () => filterPermissions(permissions, permissionSearch),
    [permissionSearch, permissions],
  )
  const grouped = useMemo(() => groupedPermissions(visiblePermissions), [visiblePermissions])
  const hasUnsavedChanges = useMemo(
    () => !permissionSetsMatch(selectedCodes, role.permissionCodes),
    [role.permissionCodes, selectedCodes],
  )
  const mutation = useMutation({
    mutationFn: (codes: string[]) => setAccessRolePermissions(role.id, codes),
    onSuccess: (center) => {
      updateCenter(queryClient, center)
      setMessage('Role permissions saved.')
    },
  })
  const saveStatusState = mutation.isPending ? 'saving' : message ? 'saved' : hasUnsavedChanges ? 'dirty' : 'idle'
  const saveStatusText = mutation.isPending
    ? 'Saving permissions...'
    : message
      ? 'Saving complete.'
      : hasUnsavedChanges
        ? 'Unsaved permission changes'
        : 'Saved.'

  useEffect(() => {
    setSelectedCodes(new Set(role.permissionCodes))
  }, [role.id, role.permissionCodes])

  useEffect(() => {
    setMessage(null)
  }, [role.id])

  function togglePermission(code: string) {
    setSelectedCodes((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
    setMessage(null)
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

      <label className="permission-search permission-search--workspace">
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
          {Object.entries(grouped).map(([category, categoryPermissions], index) => (
            <PermissionGroup
              category={category}
              key={category}
              onToggle={togglePermission}
              openByDefault={permissionSearch.trim().length > 0 || index === 0}
              permissions={categoryPermissions}
              selectedCodes={selectedCodes}
            />
          ))}
        </div>
      )}

      <div className="access-actions">
        <button
          className="access-control-button access-control-button--primary"
          disabled={mutation.isPending || !hasUnsavedChanges}
          onClick={() => mutation.mutate([...selectedCodes])}
          type="button"
        >
          <Save aria-hidden="true" size={18} />
          {mutation.isPending ? 'Saving...' : 'Save permissions'}
        </button>
        <div className={`access-save-status access-save-status--${saveStatusState}`} role="status" aria-live="polite">
          {mutation.isPending ? (
            <Loader2 aria-hidden="true" className="access-save-status__spinner" size={18} />
          ) : saveStatusState === 'dirty' ? (
            <ShieldAlert aria-hidden="true" size={18} />
          ) : (
            <CheckCircle2 aria-hidden="true" size={18} />
          )}
          <span>{saveStatusText}</span>
        </div>
        <p>Changes apply to everyone assigned to this role.</p>
      </div>
      {role.protected ? (
        <p className="access-security-note">
          <LockKeyhole aria-hidden="true" size={17} />
          Protected Admin safety permissions cannot be removed.
        </p>
      ) : null}
      {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
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
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [createRoleOpen, setCreateRoleOpen] = useState(false)
  const [employeeAccessOpen, setEmployeeAccessOpen] = useState(false)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
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

  useEffect(() => {
    if (!saveNotice) return
    const timerId = window.setTimeout(() => setSaveNotice(null), 6500)
    return () => window.clearTimeout(timerId)
  }, [saveNotice])

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
          <button className="access-control-button access-control-button--primary" onClick={() => setCreateRoleOpen(true)} type="button">
            <Plus aria-hidden="true" size={18} />
            Create role
          </button>
          <button className="access-control-button access-control-button--secondary" onClick={() => setEmployeeAccessOpen(true)} type="button">
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

      {saveNotice ? (
        <div className="access-save-status access-save-status--saved access-page-save-notice" role="status" aria-live="polite">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{saveNotice}</span>
        </div>
      ) : null}

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
          onSaved={setSaveNotice}
          permissions={center.permissions}
        />
      ) : null}

      {employeeAccessOpen ? (
        <EmployeeAccessWorkspace
          onClose={() => setEmployeeAccessOpen(false)}
          onSelectUser={setSelectedUserId}
          permissions={center.permissions}
          roles={center.roles}
          selectedUserId={selectedUser?.id ?? ''}
          users={center.users}
        />
      ) : null}
    </div>
  )
}

import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  Download,
  KeyRound,
  LockKeyhole,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  UsersRound,
  Mail,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  createEmployee,
  credentialsToCsv,
  getAdminUserDirectory,
  provisionEmployeeAccount,
  provisionMissingAccounts,
  sendAllEmployeeLoginEmails,
  sendEmployeeLoginEmail,
  sendEmployeeWelcomeEmail,
  setEmployeeAccountState,
  updateEmployee,
  type AdminUser,
  type AppRole,
  type EmployeeMutationInput,
  type EmployeeStatus,
  type EmploymentType,
  type ProvisioningCredential,
} from '../data/adminUsers'

const roleLabels: Record<AppRole, string> = {
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  guard: 'Guard',
  supervisor: 'Supervisor',
}

const statusLabels: Record<EmployeeStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  leave: 'On leave',
  separated: 'Separated',
}

const employmentLabels: Record<EmploymentType, string> = {
  hourly: 'Hourly',
  salary: 'Salary',
}

const EMPTY_USERS: AdminUser[] = []

function downloadCredentialCsv(credentials: ProvisioningCredential[], filename = 'sygshift-temporary-logins.csv') {
  const blob = new Blob([credentialsToCsv(credentials)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function employeeFormPayload(form: HTMLFormElement, employeeId?: string): EmployeeMutationInput {
  const data = new FormData(form)
  const value = (key: string) => String(data.get(key) ?? '').trim()
  const optional = (key: string) => value(key) || null
  return {
    companyEmail: optional('companyEmail'),
    employeeId,
    employeeNumber: optional('employeeNumber'),
    employmentType: value('employmentType') as EmploymentType,
    firstName: value('firstName'),
    jobTitle: optional('jobTitle'),
    lastName: value('lastName'),
    middleName: optional('middleName'),
    mobilePhone: optional('mobilePhone'),
    personalEmail: optional('personalEmail'),
    preferredName: optional('preferredName'),
    role: value('role') as AppRole,
    status: value('status') as EmployeeStatus,
  }
}

function AccountStatusBadge({ user }: { user: AdminUser }) {
  if (user.accountStatus === 'not_created') {
    return <span className="account-status account-status--missing">No login</span>
  }
  if (user.accountStatus === 'disabled') {
    return <span className="account-status account-status--disabled">Disabled</span>
  }
  return <span className="account-status account-status--active">Login active</span>
}

function EmployeeForm({
  employee,
  onCancel,
  onSubmit,
  pending,
}: {
  employee?: AdminUser
  onCancel: () => void
  onSubmit: (payload: EmployeeMutationInput) => void
  pending: boolean
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit(employeeFormPayload(event.currentTarget, employee?.id))
  }

  return (
    <form className="request-form user-admin-form" onSubmit={submit}>
      <div className="form-grid form-grid--three">
        <label><span>First name</span><input defaultValue={employee?.firstName} name="firstName" required /></label>
        <label><span>Middle name</span><input defaultValue={employee?.middleName ?? ''} name="middleName" /></label>
        <label><span>Last name</span><input defaultValue={employee?.lastName} name="lastName" required /></label>
      </div>
      <div className="form-grid form-grid--three">
        <label><span>Preferred name</span><input defaultValue={employee?.preferredName ?? ''} name="preferredName" /></label>
        <label>
          <span>Employee ID</span>
          <input
            defaultValue={employee?.employeeNumber ?? ''}
            name="employeeNumber"
            placeholder="Assigned automatically"
            readOnly
          />
        </label>
        <label><span>Job title</span><input defaultValue={employee?.jobTitle ?? ''} maxLength={140} name="jobTitle" placeholder="Guard, Owner, CS&AO..." /></label>
      </div>
      <div className="form-grid form-grid--three">
        <label>
          <span>Role</span>
          <select defaultValue={employee?.role ?? 'guard'} name="role">
            <option value="guard">Guard</option>
            <option value="dispatcher">Dispatcher</option>
            <option value="supervisor">Supervisor</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>
          <span>Employment</span>
          <select defaultValue={employee?.employmentType ?? 'hourly'} name="employmentType">
            <option value="hourly">Hourly</option>
            <option value="salary">Salary</option>
          </select>
        </label>
        <label>
          <span>Status</span>
          <select defaultValue={employee?.status ?? 'active'} name="status">
            <option value="active">Active</option>
            <option value="leave">On leave</option>
            <option value="inactive">Inactive</option>
            <option value="separated">Separated</option>
          </select>
        </label>
        <label><span>Mobile phone</span><input defaultValue={employee?.mobilePhone ?? ''} name="mobilePhone" /></label>
      </div>
      <div className="form-grid form-grid--two">
        <label><span>Personal email</span><input defaultValue={employee?.personalEmail ?? ''} name="personalEmail" type="email" /></label>
        <label><span>Company email</span><input defaultValue={employee?.companyEmail ?? ''} name="companyEmail" type="email" /></label>
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onCancel} type="button">Cancel</button>
        <button className="primary-action" disabled={pending} type="submit">
          {pending ? 'Saving…' : employee ? 'Save employee' : 'Create employee'}
        </button>
      </div>
    </form>
  )
}

function ManageUserModal({
  employee,
  onClose,
}: {
  employee: AdminUser
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [lastCredential, setLastCredential] = useState<ProvisioningCredential | null>(null)
  const [loginEmailMessage, setLoginEmailMessage] = useState<string | null>(null)
  const [welcomeEmailMessage, setWelcomeEmailMessage] = useState<string | null>(null)
  const onFileEmail = employee.companyEmail || employee.personalEmail || null

  const updateMutation = useMutation({
    mutationFn: (payload: EmployeeMutationInput) => updateEmployee({ ...payload, employeeId: employee.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const accountStateMutation = useMutation({
    mutationFn: (disabled: boolean) => setEmployeeAccountState(employee.id, disabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const provisionMutation = useMutation({
    mutationFn: () => provisionEmployeeAccount(employee.id, temporaryPassword),
    onSuccess: async (credential) => {
      setLastCredential(credential)
      setTemporaryPassword('')
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const loginEmailMutation = useMutation({
    mutationFn: () => sendEmployeeLoginEmail(employee.id, temporaryPassword),
    onSuccess: async (result) => {
      setTemporaryPassword('')
      setLastCredential(null)
      setLoginEmailMessage(`Login instructions sent to ${result.email ?? employee.companyEmail ?? employee.personalEmail ?? 'the on-file email address'}.`)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const welcomeEmailMutation = useMutation({
    mutationFn: () => sendEmployeeWelcomeEmail(employee.id),
    onSuccess: async (result) => {
      setWelcomeEmailMessage(
        `Welcome email accepted for ${result.email ?? onFileEmail ?? 'the on-file email address'}. Request ${result.requestId}.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })

  return (
    <ModalDialog
      description={`${employee.employeeNumber ?? 'Employee ID pending'} · Permanent username: @${employee.username}${employee.jobTitle ? ` · ${employee.jobTitle}` : ''}`}
      onClose={onClose}
      title={`Manage ${employee.displayName}`}
    >
      <div className="user-admin-modal-grid">
        <section aria-labelledby="employee-profile-title">
          <h3 id="employee-profile-title">Employee profile</h3>
          <EmployeeForm
            employee={employee}
            onCancel={onClose}
            onSubmit={(payload) => updateMutation.mutate(payload)}
            pending={updateMutation.isPending}
          />
          {updateMutation.isError ? <div className="inline-alert" role="alert">{updateMutation.error.message}</div> : null}
        </section>

        <section className="account-control-panel" aria-labelledby="account-control-title">
          <h3 id="account-control-title">Login access</h3>
          <div className="account-control-card">
            <AccountStatusBadge user={employee} />
            <p>
              {employee.accountStatus === 'not_created'
                ? 'Create a login when this employee is ready to access SygShift.'
                : employee.accountStatus === 'disabled'
                  ? 'The employee record remains for history, but login access is blocked.'
                  : 'The account can sign in. Temporary password resets require a new password change.'}
            </p>
            <label>
              <span>Temporary password override</span>
              <input
                autoComplete="new-password"
                onChange={(event) => setTemporaryPassword(event.target.value)}
                placeholder="Leave blank to generate securely"
                type="password"
                value={temporaryPassword}
              />
            </label>
            <button
              className="primary-action"
              disabled={provisionMutation.isPending || employee.status !== 'active'}
              onClick={() => provisionMutation.mutate()}
              type="button"
            >
              <KeyRound aria-hidden="true" size={18} />
              {employee.accountStatus === 'not_created' ? 'Create login' : 'Reset temporary password'}
            </button>
            <button
              className="secondary-button"
              disabled={loginEmailMutation.isPending || employee.status !== 'active'}
              onClick={() => loginEmailMutation.mutate()}
              type="button"
            >
              <Mail aria-hidden="true" size={18} />
              Email login instructions
            </button>
            {employee.account ? (
              <button
                className="secondary-button"
                disabled={accountStateMutation.isPending}
                onClick={() => accountStateMutation.mutate(employee.accountStatus !== 'disabled')}
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={18} />
                {employee.accountStatus === 'disabled' ? 'Enable login' : 'Disable login'}
              </button>
            ) : null}
            {employee.status !== 'active' ? <small>Only active employees can receive login accounts.</small> : null}
          </div>

          {lastCredential ? (
            <div className="temporary-password-card" role="status">
              <strong>Temporary password created</strong>
              <p>Copy or download it now. It will not be shown again.</p>
              <code>{lastCredential.temporaryPassword}</code>
              <button className="secondary-button" onClick={() => downloadCredentialCsv([lastCredential], `${lastCredential.username}-temporary-login.csv`)} type="button">
                <Download aria-hidden="true" size={18} /> Download one-user CSV
              </button>
            </div>
          ) : null}

          {loginEmailMessage ? <div className="form-feedback form-feedback--success" role="status">{loginEmailMessage}</div> : null}
          {provisionMutation.isError ? <div className="inline-alert" role="alert">{provisionMutation.error.message}</div> : null}
          {loginEmailMutation.isError ? <div className="inline-alert" role="alert">{loginEmailMutation.error.message}</div> : null}
          {accountStateMutation.isError ? <div className="inline-alert" role="alert">{accountStateMutation.error.message}</div> : null}

          <div className="account-control-card account-control-card--welcome">
            <div>
              <span className="account-control-kicker">Welcome email</span>
              <h4>Send the SygShift introduction</h4>
            </div>
            <p>
              Sends the branded welcome message only. It does not create a login, reset a
              password, or include temporary credentials.
            </p>
            <p>
              Recipient: <strong>{onFileEmail ?? 'No email on file'}</strong>
            </p>
            <button
              className="secondary-button"
              disabled={welcomeEmailMutation.isPending || employee.status !== 'active' || !onFileEmail}
              onClick={() => welcomeEmailMutation.mutate()}
              type="button"
            >
              <Mail aria-hidden="true" size={18} />
              {welcomeEmailMutation.isPending ? 'Sending welcome…' : 'Send welcome email'}
            </button>
            {employee.status !== 'active' ? <small>Only active employees can receive welcome emails.</small> : null}
            {!onFileEmail ? <small>Add a personal or company email before sending.</small> : null}
          </div>

          {welcomeEmailMessage ? <div className="form-feedback form-feedback--success" role="status">{welcomeEmailMessage}</div> : null}
          {welcomeEmailMutation.isError ? <div className="inline-alert" role="alert">{welcomeEmailMutation.error.message}</div> : null}
        </section>
      </div>
    </ModalDialog>
  )
}

export function UserAdminPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<'all' | AppRole>('all')
  const [status, setStatus] = useState<'all' | EmployeeStatus>('active')
  const [account, setAccount] = useState<'all' | 'not_created' | 'active' | 'disabled'>('all')
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [bulkCredentials, setBulkCredentials] = useState<ProvisioningCredential[]>([])
  const [bulkEmailMessage, setBulkEmailMessage] = useState<string | null>(null)

  const directoryQuery = useQuery({
    queryFn: getAdminUserDirectory,
    queryKey: ['admin-user-directory'],
  })

  const createMutation = useMutation({
    mutationFn: createEmployee,
    onSuccess: async () => {
      setCreating(false)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })

  const bulkProvisionMutation = useMutation({
    mutationFn: provisionMissingAccounts,
    onSuccess: async (result) => {
      setBulkCredentials(result.provisioned)
      if (result.provisioned.length > 0) {
        downloadCredentialCsv(result.provisioned, 'sygshift-new-temporary-logins.csv')
      }
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const bulkLoginEmailMutation = useMutation({
    mutationFn: sendAllEmployeeLoginEmails,
    onSuccess: async (result) => {
      const sentCount = result.sent?.length ?? 0
      const failureCount = result.failures?.length ?? 0
      setBulkEmailMessage(`${sentCount} new-login email${sentCount === 1 ? '' : 's'} sent${failureCount ? `; ${failureCount} need attention.` : '.'}`)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })

  const users = directoryQuery.data?.users ?? EMPTY_USERS
  const metrics = useMemo(() => ({
    active: users.filter((user) => user.status === 'active').length,
    admins: users.filter((user) => user.role === 'admin').length,
    missingLogins: users.filter((user) => user.status === 'active' && user.accountStatus === 'not_created').length,
    total: users.length,
  }), [users])

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return users.filter((user) => {
      const searchable = [
        user.displayName,
        user.username,
        user.employeeNumber,
        user.jobTitle,
        user.personalEmail,
        user.companyEmail,
        user.mobilePhone,
      ].filter(Boolean).join(' ').toLowerCase()
      return (role === 'all' || user.role === role)
        && (status === 'all' || user.status === status)
        && (account === 'all' || user.accountStatus === account)
        && (!term || searchable.includes(term))
    })
  }, [account, role, search, status, users])

  return (
    <div className="page page--user-admin">
      <section className="page-intro user-admin-intro">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Users & access</h1>
          <p className="page-summary">
            Manage employees, permanent usernames, roles, employment status, and login access
            from one controlled admin workspace.
          </p>
        </div>
        <div className="access-note">
          <ShieldCheck aria-hidden="true" size={19} />
          Admin + MFA required
        </div>
      </section>

      {directoryQuery.isPending ? (
        <DataStatePanel icon={UsersRound} title="Loading users">
          <p>Checking admin access and retrieving employee account records.</p>
        </DataStatePanel>
      ) : directoryQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Users unavailable" tone="error">
          <p>{directoryQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="user-admin-metrics" aria-label="User access totals">
            <article><span>Total people</span><strong>{metrics.total}</strong><small>Live employee records</small></article>
            <article><span>Active</span><strong>{metrics.active}</strong><small>Can receive login access</small></article>
            <article className={metrics.missingLogins ? 'import-metric--attention' : ''}><span>Need logins</span><strong>{metrics.missingLogins}</strong><small>Active employees without accounts</small></article>
            <article><span>Admins</span><strong>{metrics.admins}</strong><small>Highest access level</small></article>
          </section>

          <section className="user-admin-toolbar" aria-label="User filters and actions">
            <label className="search-field search-field--wide">
              <Search aria-hidden="true" size={20} />
              <span className="visually-hidden">Search users</span>
              <input onChange={(event) => setSearch(event.target.value)} placeholder="Search name, username, email, or phone" type="search" value={search} />
            </label>
            <label className="select-field"><span>Role</span><select onChange={(event) => setRole(event.target.value as typeof role)} value={role}><option value="all">All roles</option><option value="guard">Guards</option><option value="dispatcher">Dispatchers</option><option value="supervisor">Supervisors</option><option value="admin">Admins</option></select></label>
            <label className="select-field"><span>Status</span><select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}><option value="active">Active</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option><option value="all">All</option></select></label>
            <label className="select-field"><span>Login</span><select onChange={(event) => setAccount(event.target.value as typeof account)} value={account}><option value="all">All logins</option><option value="not_created">No login</option><option value="active">Active login</option><option value="disabled">Disabled</option></select></label>
            <button className="secondary-button" onClick={() => setCreating(true)} type="button"><Plus aria-hidden="true" size={18} /> Add employee</button>
            <button className="primary-action" disabled={bulkProvisionMutation.isPending || metrics.missingLogins === 0} onClick={() => bulkProvisionMutation.mutate()} type="button">
              <KeyRound aria-hidden="true" size={18} /> Create missing logins
            </button>
            <button className="secondary-button" disabled={bulkLoginEmailMutation.isPending || metrics.missingLogins === 0} onClick={() => bulkLoginEmailMutation.mutate()} type="button">
              <Mail aria-hidden="true" size={18} /> Email new logins
            </button>
          </section>

          {bulkProvisionMutation.isError ? <div className="inline-alert" role="alert">{bulkProvisionMutation.error.message}</div> : null}
          {bulkLoginEmailMutation.isError ? <div className="inline-alert" role="alert">{bulkLoginEmailMutation.error.message}</div> : null}
          {bulkEmailMessage ? <div className="user-admin-success" role="status"><BadgeCheck aria-hidden="true" size={18} /><span>{bulkEmailMessage}</span></div> : null}
          {bulkCredentials.length > 0 ? (
            <div className="user-admin-success" role="status">
              <BadgeCheck aria-hidden="true" size={18} />
              <span>{bulkCredentials.length} temporary login{bulkCredentials.length === 1 ? '' : 's'} created. The CSV downloaded automatically; store it securely.</span>
            </div>
          ) : null}

          <section className="user-admin-panel" aria-label="User account records">
            {filteredUsers.length === 0 ? (
              <DataStatePanel icon={UsersRound} title="No users match these filters">
                <p>Change the filters to see other employee records.</p>
              </DataStatePanel>
            ) : (
              <div className="user-admin-table" role="table" aria-label="Users and login access">
                <div className="user-admin-row user-admin-row--header" role="row">
                  <span role="columnheader">Employee</span>
                  <span role="columnheader">Role</span>
                  <span role="columnheader">Employment</span>
                  <span role="columnheader">Login</span>
                  <span role="columnheader">Action</span>
                </div>
                {filteredUsers.map((user) => (
                  <div className="user-admin-row" key={user.id} role="row">
                    <div role="cell">
                      <strong>{user.displayName}</strong>
                      <span>{user.employeeNumber ?? 'ID pending'} · @{user.username}</span>
                      {user.jobTitle ? <small>{user.jobTitle}</small> : null}
                      <small>{user.companyEmail || user.personalEmail || user.mobilePhone || 'No contact on file'}</small>
                    </div>
                    <div role="cell"><span className="plain-value">{roleLabels[user.role]}</span></div>
                    <div role="cell">
                      <span className="plain-value">{employmentLabels[user.employmentType]}</span>
                      <small>{statusLabels[user.status]}</small>
                    </div>
                    <div role="cell"><AccountStatusBadge user={user} /></div>
                    <div role="cell">
                      <button className="secondary-button secondary-button--small" onClick={() => setSelected(user)} type="button">
                        <UserCog aria-hidden="true" size={17} /> Manage
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {creating ? (
        <ModalDialog description="A permanent username will be assigned automatically from the employee name." onClose={() => setCreating(false)} title="Add employee">
          <EmployeeForm
            onCancel={() => setCreating(false)}
            onSubmit={(payload) => createMutation.mutate(payload)}
            pending={createMutation.isPending}
          />
          {createMutation.isError ? <div className="inline-alert" role="alert">{createMutation.error.message}</div> : null}
        </ModalDialog>
      ) : null}

      {selected ? <ManageUserModal employee={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}

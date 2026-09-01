import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  AlertTriangle,
  KeyRound,
  LockKeyhole,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCog,
  UsersRound,
  Mail,
  RotateCcw,
  Usb,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  createEmployee,
  credentialsToCsv,
  getEmployeeRemovalPreview,
  getEmployeeSecurityKeys,
  getAdminUserDirectory,
  getRecentlyDeletedEmployees,
  provisionMissingAccounts,
  resetEmployeeMfa,
  revokeEmployeeSecurityKey,
  revokeEmployeeTrustedDevices,
  removeSeparatedEmployee,
  sendAllEmployeeLoginEmails,
  sendEmployeeLoginEmail,
  sendEmployeePasswordReset,
  sendEmployeeWelcomeEmail,
  setEmployeeAccountState,
  updateEmployee,
  type AdminUser,
  type AdminUserDirectory,
  type AppRole,
  type EmployeeMutationInput,
  type EmployeeStatus,
  type EmploymentType,
  type EmployeeRemovalPreview,
  type ProvisioningCredential,
} from '../data/adminUsers'
import { continentalUsTimeZones } from '../lib/usTimeZones'
import type { SecurityKeySummary } from '../data/securityKeys'
import { getSessionContext } from '../data/auth'
import { preferredEmployeeDeliveryEmail } from '../lib/emailRecipients'
import { formatOperationalDateTime } from '../lib/time'
import { summarizeUserAccounts } from '../lib/userAccountMetrics'

const roleLabels: Record<AppRole, string> = {
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  guard: 'Guard',
  recruiting_licensing: 'Recruiting & Licensing',
  scheduler: 'Scheduler',
  supervisor: 'Supervisor',
}

const statusLabels: Record<EmployeeStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  leave: 'On leave',
  onboarding: 'Onboarding',
  separated: 'Separated',
}

const employmentLabels: Record<EmploymentType, string> = {
  flex: 'Flex',
  hourly: 'Hourly',
  salary: 'Salary',
}

const EMPTY_USERS: AdminUser[] = []

type AccountActivityFilter = 'all' | 'pending_setup' | 'activated' | 'signed_in' | 'never_signed_in'

function replaceDirectoryUser(directory: AdminUserDirectory | undefined, updatedUser: AdminUser): AdminUserDirectory | undefined {
  if (!directory) return directory

  const existingIndex = directory.users.findIndex((user) => user.id === updatedUser.id)
  const users = existingIndex === -1
    ? [...directory.users, updatedUser]
    : directory.users.map((user) => user.id === updatedUser.id ? updatedUser : user)

  return {
    ...directory,
    users,
  }
}

function downloadCredentialCsv(credentials: ProvisioningCredential[], filename = 'sygshift-temporary-logins.csv') {
  const blob = new Blob([credentialsToCsv(credentials)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function employeeFormPayload(
  form: HTMLFormElement,
  employeeId?: string,
  preservedPreferredName?: string | null,
): EmployeeMutationInput {
  const data = new FormData(form)
  const value = (key: string) => String(data.get(key) ?? '').trim()
  const optional = (key: string) => value(key) || null
  return {
    companyEmail: optional('companyEmail'),
    employeeId,
    employeeNumber: optional('employeeNumber'),
    employmentType: value('employmentType') as EmploymentType,
    timeZone: value('timeZone') as EmployeeMutationInput['timeZone'],
    firstName: value('firstName'),
    jobTitle: optional('jobTitle'),
    lastName: value('lastName'),
    middleName: optional('middleName'),
    mobilePhone: optional('mobilePhone'),
    personalEmail: optional('personalEmail'),
    preferredName: preservedPreferredName ?? null,
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

function formatAccountDateTime(value: string | null): string {
  if (!value) return 'Never'

  return formatOperationalDateTime(value)
}

function AccountActivityPanel({ user }: { user: AdminUser }) {
  if (!user.account) {
    return (
      <div className="account-activity-card">
        <strong>Account activity</strong>
        <dl>
          <div>
            <dt>Activation</dt>
            <dd>Not created</dd>
          </div>
          <div>
            <dt>Last login</dt>
            <dd>Never</dd>
          </div>
          <div>
            <dt>MFA</dt>
            <dd>Not enrolled</dd>
          </div>
        </dl>
      </div>
    )
  }

  return (
    <div className="account-activity-card">
      <strong>Account activity</strong>
      <dl>
        <div>
          <dt>Activation</dt>
          <dd>{user.account.activatedAt ? formatAccountDateTime(user.account.activatedAt) : 'Pending first setup'}</dd>
        </div>
        <div>
          <dt>Last login</dt>
          <dd>{formatAccountDateTime(user.account.lastSignInAt)}</dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>{user.account.mustChangePassword ? 'Temporary password pending' : `Changed ${formatAccountDateTime(user.account.passwordChangedAt)}`}</dd>
        </div>
        <div>
          <dt>MFA</dt>
          <dd>{user.account.mfaEnrolledAt ? `Enrolled ${formatAccountDateTime(user.account.mfaEnrolledAt)}` : 'Not enrolled'}</dd>
        </div>
        <div>
          <dt>Remembered devices</dt>
          <dd>{user.account.trustedDeviceCount ?? 0}</dd>
        </div>
      </dl>
    </div>
  )
}

function EmployeeForm({
  canEditAdminRole,
  canEditBasic,
  canSeparate,
  employee,
  formId,
  onDirty,
  onCancel,
  onSubmit,
  pending,
  showActions = true,
}: {
  canEditAdminRole: boolean
  canEditBasic: boolean
  canSeparate: boolean
  employee?: AdminUser
  formId?: string
  onDirty?: () => void
  onCancel: () => void
  onSubmit: (payload: EmployeeMutationInput) => void
  pending: boolean
  showActions?: boolean
}) {
  const canEditThisProfile = canEditBasic
    && (canEditAdminRole || employee?.role !== 'admin')
    && (canSeparate || employee?.status !== 'separated')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEditThisProfile) return
    onSubmit(employeeFormPayload(event.currentTarget, employee?.id, employee?.preferredName))
  }

  return (
    <form className="request-form user-admin-form" id={formId} onChange={onDirty} onSubmit={submit}>
      <div className="form-grid form-grid--three">
        <label><span>First name</span><input defaultValue={employee?.firstName} disabled={!canEditThisProfile} name="firstName" required /></label>
        <label><span>Middle name</span><input defaultValue={employee?.middleName ?? ''} disabled={!canEditThisProfile} name="middleName" /></label>
        <label><span>Last name</span><input defaultValue={employee?.lastName} disabled={!canEditThisProfile} name="lastName" required /></label>
      </div>
      <div className="form-grid form-grid--two">
        <label>
          <span>Employee ID</span>
          <input
            defaultValue={employee?.employeeNumber ?? ''}
            disabled={!canEditThisProfile}
            name="employeeNumber"
            placeholder="Assigned automatically"
            readOnly
          />
        </label>
        <label><span>Job title</span><input defaultValue={employee?.jobTitle ?? ''} disabled={!canEditThisProfile} maxLength={140} name="jobTitle" placeholder="Guard, Owner, IT and Business Development Engineer..." /></label>
      </div>
      <div className="form-grid form-grid--three">
        <label>
          <span>Role</span>
          <select defaultValue={employee?.role ?? 'guard'} disabled={!canEditThisProfile} name="role">
            <option value="guard">Guard</option>
            <option value="dispatcher">Dispatcher</option>
            <option value="scheduler">Scheduler</option>
            <option value="recruiting_licensing">Recruiting & Licensing</option>
            <option value="supervisor">Supervisor</option>
            <option disabled={!canEditAdminRole} value="admin">Admin</option>
          </select>
        </label>
        <label>
          <span>Employment</span>
          <select defaultValue={employee?.employmentType ?? 'hourly'} disabled={!canEditThisProfile} name="employmentType">
            <option value="hourly">Hourly</option>
            <option value="salary">Salary</option>
            <option value="flex">Flex</option>
          </select>
        </label>
        <label>
          <span>Status</span>
          <select defaultValue={employee?.status ?? 'active'} disabled={!canEditThisProfile} name="status">
            <option value="active">Active</option>
            <option value="onboarding">Onboarding</option>
            <option value="leave">On leave</option>
            <option value="inactive">Inactive</option>
            <option disabled={!canSeparate && employee?.status !== 'separated'} value="separated">Separated</option>
          </select>
        </label>
        <label>
          <span>Employee time zone</span>
          <select defaultValue={employee?.timeZone ?? 'America/Denver'} disabled={!canEditThisProfile} name="timeZone">
            {continentalUsTimeZones.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label><span>Mobile phone</span><input defaultValue={employee?.mobilePhone ?? ''} disabled={!canEditThisProfile} name="mobilePhone" /></label>
      </div>
      <div className="form-grid form-grid--two">
        <label><span>Personal email</span><input defaultValue={employee?.personalEmail ?? ''} disabled={!canEditThisProfile} name="personalEmail" type="email" /></label>
        <label><span>Company email</span><input defaultValue={employee?.companyEmail ?? ''} disabled={!canEditThisProfile} name="companyEmail" type="email" /></label>
      </div>
      {showActions ? (
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">Cancel</button>
          <button className="primary-action" disabled={pending || !canEditThisProfile} type="submit">
            {pending ? 'Saving…' : employee ? 'Save employee' : 'Create employee'}
          </button>
        </div>
      ) : null}
    </form>
  )
}

function ManageUserModal({
  canDeleteUsers,
  canEditAdminRole,
  canEditBasic,
  canManageLogin,
  canResetPassword,
  canSendNewUserInvites,
  canSeparate,
  employee,
  onClose,
}: {
  canDeleteUsers: boolean
  canEditAdminRole: boolean
  canEditBasic: boolean
  canManageLogin: boolean
  canResetPassword: boolean
  canSendNewUserInvites: boolean
  canSeparate: boolean
  employee: AdminUser
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'onboarding'>('profile')
  const [profileDirty, setProfileDirty] = useState(false)
  const [profileFormVersion, setProfileFormVersion] = useState(0)
  const [profileSaveMessage, setProfileSaveMessage] = useState<string | null>(null)
  const [loginEmailMessage, setLoginEmailMessage] = useState<string | null>(null)
  const [passwordResetMessage, setPasswordResetMessage] = useState<string | null>(null)
  const [welcomeEmailMessage, setWelcomeEmailMessage] = useState<string | null>(null)
  const [trustedDeviceMessage, setTrustedDeviceMessage] = useState<string | null>(null)
  const [mfaResetMessage, setMfaResetMessage] = useState<string | null>(null)
  const [securityKeyMessage, setSecurityKeyMessage] = useState<string | null>(null)
  const [confirmingMfaReset, setConfirmingMfaReset] = useState(false)
  const [removingEmployee, setRemovingEmployee] = useState(false)
  const deliveryEmail = preferredEmployeeDeliveryEmail(employee.personalEmail, employee.companyEmail)

  const securityKeysQuery = useQuery({
    enabled: activeTab === 'security' && canManageLogin && employee.accountStatus === 'active',
    queryFn: () => getEmployeeSecurityKeys(employee.id),
    queryKey: ['employee-security-keys', employee.id],
  })

  const updateMutation = useMutation({
    mutationFn: (payload: EmployeeMutationInput) => updateEmployee({ ...payload, employeeId: employee.id }),
    onSuccess: async (updatedEmployee) => {
      setProfileDirty(false)
      setProfileSaveMessage('Employee profile saved.')
      queryClient.setQueryData<AdminUserDirectory>(['admin-user-directory'], (current) =>
        replaceDirectoryUser(current, updatedEmployee),
      )
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' })
    },
  })
  const accountStateMutation = useMutation({
    mutationFn: (disabled: boolean) => setEmployeeAccountState(employee.id, disabled),
    onSuccess: async (updatedEmployee) => {
      queryClient.setQueryData<AdminUserDirectory>(['admin-user-directory'], (current) =>
        replaceDirectoryUser(current, updatedEmployee),
      )
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' })
    },
  })
  const revokeTrustedDevicesMutation = useMutation({
    mutationFn: () => revokeEmployeeTrustedDevices(employee.id),
    onSuccess: async (count) => {
      setTrustedDeviceMessage(`${count} remembered device${count === 1 ? '' : 's'} revoked for ${employee.displayName}.`)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const resetMfaMutation = useMutation({
    mutationFn: () => resetEmployeeMfa(employee.id),
    onSuccess: async (result) => {
      setConfirmingMfaReset(false)
      setMfaResetMessage(
        `MFA reset for ${employee.displayName}. ${result.factorsRemoved} authenticator factor${result.factorsRemoved === 1 ? '' : 's'}, ${result.trustedDevicesRevoked} remembered device${result.trustedDevicesRevoked === 1 ? '' : 's'}, and ${result.securityKeysRevoked} security key${result.securityKeysRevoked === 1 ? '' : 's'} revoked.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['employee-security-keys', employee.id], refetchType: 'active' })
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' })
    },
  })
  const revokeSecurityKeyMutation = useMutation({
    mutationFn: (key: SecurityKeySummary) => revokeEmployeeSecurityKey(employee.id, key.id),
    onSuccess: async (result, key) => {
      setSecurityKeyMessage(`${key.label} was revoked. ${result.securityKeySessionsRevoked} active security-key session${result.securityKeySessionsRevoked === 1 ? '' : 's'} ended.`)
      await queryClient.invalidateQueries({ queryKey: ['employee-security-keys', employee.id], refetchType: 'active' })
    },
  })
  const loginEmailMutation = useMutation({
    mutationFn: () => sendEmployeeLoginEmail(employee.id),
    onSuccess: async (result) => {
      setLoginEmailMessage(`Login instructions sent to ${result.email ?? deliveryEmail ?? 'the approved email address'}.`)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const passwordResetMutation = useMutation({
    mutationFn: () => sendEmployeePasswordReset(employee.id),
    onSuccess: async (result) => {
      setPasswordResetMessage(`Secure password reset sent to ${result.email}.`)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' })
    },
  })
  const welcomeEmailMutation = useMutation({
    mutationFn: () => sendEmployeeWelcomeEmail(employee.id),
    onSuccess: async (result) => {
      setWelcomeEmailMessage(
        `Welcome email accepted for ${result.email ?? deliveryEmail ?? 'the approved email address'}. Request ${result.requestId}.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
    },
  })
  const modalBusy = updateMutation.isPending
    || accountStateMutation.isPending
    || revokeTrustedDevicesMutation.isPending
    || resetMfaMutation.isPending
    || revokeSecurityKeyMutation.isPending
    || passwordResetMutation.isPending
    || loginEmailMutation.isPending
    || welcomeEmailMutation.isPending
  const employeeFormKey = [
    profileFormVersion,
    employee.id,
    employee.firstName,
    employee.middleName ?? '',
    employee.lastName,
    employee.employeeNumber ?? '',
    employee.jobTitle ?? '',
    employee.role,
    employee.employmentType,
    employee.timeZone,
    employee.status,
    employee.mobilePhone ?? '',
    employee.personalEmail ?? '',
    employee.companyEmail ?? '',
  ].join('|')
  const profileFormId = `employee-profile-${employee.id}`
  const canEditThisProfile = canEditBasic
    && (canEditAdminRole || employee.role !== 'admin')
    && (canSeparate || employee.status !== 'separated')

  function closeWorkspace() {
    if (profileDirty && !window.confirm('Discard the unsaved employee profile changes?')) return
    onClose()
  }

  function chooseTab(tab: typeof activeTab) {
    if (tab === activeTab) return
    if (profileDirty && !window.confirm('Discard the unsaved employee profile changes before changing sections?')) return
    if (profileDirty) {
      setProfileDirty(false)
      setProfileFormVersion((version) => version + 1)
    }
    setActiveTab(tab)
  }

  function discardProfileChanges() {
    setProfileDirty(false)
    setProfileSaveMessage(null)
    setProfileFormVersion((version) => version + 1)
  }

  return (
    <ModalDialog
      busy={modalBusy}
      busyLabel="Updating employee record..."
      className="modal-dialog--user-account"
      description={`${employee.employeeNumber ?? 'Employee ID pending'} · Permanent username: @${employee.username}${employee.jobTitle ? ` · ${employee.jobTitle}` : ''}`}
      onClose={closeWorkspace}
      title={`Employee account: ${employee.displayName}`}
    >
      <div className="user-account-workspace">
        <section className="user-account-snapshot" aria-label="Selected employee account summary">
          <div>
            <span>Employee</span>
            <strong>{employee.displayName}</strong>
          </div>
          <div>
            <span>Employee ID</span>
            <strong>{employee.employeeNumber ?? 'Pending'}</strong>
          </div>
          <div>
            <span>Username</span>
            <strong>@{employee.username}</strong>
          </div>
          <div>
            <span>Role</span>
            <strong>{roleLabels[employee.role]}</strong>
          </div>
          <div>
            <span>Account</span>
            <AccountStatusBadge user={employee} />
          </div>
        </section>

        <nav className="user-account-tabs" aria-label="Employee account sections">
          <button aria-current={activeTab === 'profile' ? 'page' : undefined} className={activeTab === 'profile' ? 'is-active' : ''} onClick={() => chooseTab('profile')} type="button">Profile</button>
          <button aria-current={activeTab === 'security' ? 'page' : undefined} className={activeTab === 'security' ? 'is-active' : ''} onClick={() => chooseTab('security')} type="button">Login &amp; Security</button>
          <button aria-current={activeTab === 'onboarding' ? 'page' : undefined} className={activeTab === 'onboarding' ? 'is-active' : ''} onClick={() => chooseTab('onboarding')} type="button">Onboarding</button>
        </nav>

        {activeTab === 'profile' ? (
          <section className="user-account-tab-panel user-account-profile" aria-labelledby="employee-profile-title">
            <div className="user-account-section-heading">
              <div>
                <span className="account-control-kicker">Employee record</span>
                <h3 id="employee-profile-title">Profile and employment</h3>
              </div>
              <p>Update legal identity, contact information, role, and employment status.</p>
            </div>
            <EmployeeForm
              canEditAdminRole={canEditAdminRole}
              canEditBasic={canEditBasic}
              canSeparate={canSeparate}
              employee={employee}
              formId={profileFormId}
              key={employeeFormKey}
              onCancel={discardProfileChanges}
              onDirty={() => {
                setProfileDirty(true)
                setProfileSaveMessage(null)
              }}
              onSubmit={(payload) => updateMutation.mutate(payload)}
              pending={updateMutation.isPending}
              showActions={false}
            />
            {profileSaveMessage ? <div className="form-feedback form-feedback--success" role="status">{profileSaveMessage}</div> : null}
            {updateMutation.isError ? <div className="inline-alert" role="alert">{updateMutation.error.message}</div> : null}
            <p className="form-note">
              {canEditBasic
                ? 'Credential updates are handled in Directory so schedulers can maintain qualification records without account-security access.'
                : 'This access level can review user records, but cannot edit employee profile details.'}
            </p>
            {canDeleteUsers ? (
              <details className="user-account-employment-admin">
                <summary>Employment and removal controls</summary>
                <div className="account-control-card account-control-card--danger">
                  <div>
                    <span className="account-control-kicker">Admin only</span>
                    <h4>Remove separated employee</h4>
                  </div>
                  <p>
                    Removes the employee from working lists and disables access. Payroll, schedule, and audit
                    history remains intact so past records are not damaged.
                  </p>
                  <button
                    className="secondary-button"
                    disabled={employee.status !== 'separated'}
                    onClick={() => setRemovingEmployee(true)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={18} />
                    Review removal
                  </button>
                  {employee.status !== 'separated' ? <small>Separate the employee before removal is available.</small> : null}
                </div>
              </details>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'security' ? (
          <section className="user-account-tab-panel" aria-labelledby="account-control-title">
            <div className="user-account-section-heading">
              <div>
                <span className="account-control-kicker">Authentication</span>
                <h3 id="account-control-title">Login &amp; Security</h3>
              </div>
              <p>Review account activity and use audited security actions without changing the employee profile.</p>
            </div>
            <AccountActivityPanel user={employee} />
            <div className="user-account-security-grid">
              <article className="user-account-security-card user-account-security-card--status">
                <AccountStatusBadge user={employee} />
                <strong>{employee.accountStatus === 'not_created' ? 'Login has not been created' : employee.accountStatus === 'disabled' ? 'Login is disabled' : 'Login is active'}</strong>
                <p>{employee.accountStatus === 'not_created'
                  ? 'Use Onboarding to create access and send approved login instructions.'
                  : employee.accountStatus === 'disabled'
                    ? 'The employee cannot sign in until login access is enabled.'
                    : employee.account?.activatedAt
                      ? 'The employee has completed initial account setup.'
                      : 'The login exists and is waiting for the employee to complete initial setup.'}</p>
              </article>
              {canManageLogin || canResetPassword ? (
                <article className="user-account-security-card user-account-security-card--actions">
                  <span className="account-control-kicker">Account actions</span>
                  <h4>Help the employee regain access</h4>
                  <p>Every action is immediate, permission-checked, and recorded in the audit history.</p>
                  <div className="user-account-security-button-stack">
                    {canSendNewUserInvites && employee.accountStatus === 'not_created' ? (
                      <button className="primary-action" disabled={employee.status !== 'active'} onClick={() => setActiveTab('onboarding')} type="button">
                        <KeyRound aria-hidden="true" size={18} /> Open onboarding
                      </button>
                    ) : null}
                    {canResetPassword && employee.accountStatus === 'active' && employee.account?.activatedAt ? (
                      <button className="primary-action" disabled={passwordResetMutation.isPending || employee.status !== 'active' || !deliveryEmail} onClick={() => { setPasswordResetMessage(null); passwordResetMutation.mutate() }} type="button">
                        <Mail aria-hidden="true" size={18} /> {passwordResetMutation.isPending ? 'Sending reset…' : 'Send password reset'}
                      </button>
                    ) : null}
                    {canSendNewUserInvites && employee.accountStatus === 'active' && !employee.account?.activatedAt ? (
                      <button className="primary-action" disabled={employee.status !== 'active'} onClick={() => setActiveTab('onboarding')} type="button">
                        <Mail aria-hidden="true" size={18} /> Open login instructions
                      </button>
                    ) : null}
                    {canManageLogin && employee.accountStatus === 'disabled' && employee.account ? (
                      <button className="primary-action" disabled={accountStateMutation.isPending} onClick={() => accountStateMutation.mutate(false)} type="button">
                        <LockKeyhole aria-hidden="true" size={18} /> {accountStateMutation.isPending ? 'Enabling…' : 'Enable login'}
                      </button>
                    ) : null}
                    {canManageLogin && employee.accountStatus === 'active' && employee.account && !confirmingMfaReset ? (
                      <button className="secondary-button" disabled={resetMfaMutation.isPending} onClick={() => { setMfaResetMessage(null); setConfirmingMfaReset(true) }} type="button">
                        <RotateCcw aria-hidden="true" size={18} /> Reset MFA setup
                      </button>
                    ) : null}
                    {canManageLogin && employee.accountStatus === 'active' && employee.account && (employee.account.trustedDeviceCount ?? 0) > 0 ? (
                      <button className="secondary-button" disabled={revokeTrustedDevicesMutation.isPending} onClick={() => revokeTrustedDevicesMutation.mutate()} type="button">
                        <ShieldAlert aria-hidden="true" size={18} /> Revoke remembered devices ({employee.account.trustedDeviceCount})
                      </button>
                    ) : null}
                  </div>
                  {confirmingMfaReset ? (
                    <div className="mfa-reset-confirmation" role="alert">
                      <strong>Reset MFA for {employee.displayName}?</strong>
                      <p>Their authenticator enrollment, recovery codes, remembered devices, and registered security keys will be removed. Their password, employee record, and history will not change.</p>
                      <div className="mfa-reset-confirmation__actions">
                        <button className="secondary-button" disabled={resetMfaMutation.isPending} onClick={() => setConfirmingMfaReset(false)} type="button">Cancel</button>
                        <button className="secondary-button danger-button" disabled={resetMfaMutation.isPending} onClick={() => resetMfaMutation.mutate()} type="button"><RotateCcw aria-hidden="true" size={18} /> {resetMfaMutation.isPending ? 'Resetting MFA…' : 'Confirm MFA reset'}</button>
                      </div>
                    </div>
                  ) : null}
                  {employee.status !== 'active' ? <small>Only active employees can receive login accounts.</small> : null}
                  {!deliveryEmail && employee.accountStatus === 'active' ? <small>Add an approved personal email before sending a password reset.</small> : null}
                </article>
              ) : null}
              {canManageLogin && employee.accountStatus === 'active' ? (
                <article className="user-account-security-card user-account-security-card--keys">
                  <span className="account-control-kicker">Physical security keys</span>
                  <h4>Registered FIDO2 keys</h4>
                  <p>Revoke a lost or unavailable key without resetting the employee's password or other MFA methods.</p>
                  {securityKeysQuery.isPending ? <p className="user-account-security-key-empty">Loading registered keys…</p> : null}
                  {securityKeysQuery.isError ? <div className="inline-alert" role="alert">{securityKeysQuery.error.message}</div> : null}
                  {securityKeysQuery.data?.length ? (
                    <div className="user-account-security-key-list">
                      {securityKeysQuery.data.map((key) => (
                        <div className="user-account-security-key-row" key={key.id}>
                          <Usb aria-hidden="true" size={19} />
                          <div>
                            <strong>{key.label}</strong>
                            <span>{key.lastUsedAt ? `Last used ${formatOperationalDateTime(key.lastUsedAt)}` : `Added ${formatOperationalDateTime(key.createdAt)}`}</span>
                          </div>
                          <button
                            className="secondary-button danger-button"
                            disabled={revokeSecurityKeyMutation.isPending}
                            onClick={() => {
                              setSecurityKeyMessage(null)
                              if (window.confirm(`Revoke ${key.label} for ${employee.displayName}? The key will stop working immediately.`)) revokeSecurityKeyMutation.mutate(key)
                            }}
                            type="button"
                          >
                            Revoke
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : !securityKeysQuery.isPending && !securityKeysQuery.isError ? <p className="user-account-security-key-empty">No physical security keys are registered.</p> : null}
                </article>
              ) : null}
              {!canManageLogin && !canResetPassword ? (
                <article className="user-account-security-card user-account-security-card--actions">
                  <span className="account-control-kicker">Read only</span>
                  <h4>Security actions unavailable</h4>
                  <p>This permission level can review account status but cannot change login access.</p>
                </article>
              ) : null}
              {canManageLogin && employee.accountStatus === 'active' && employee.account ? (
                <article className="user-account-security-card user-account-security-card--danger">
                  <span className="account-control-kicker">Danger zone</span>
                  <h4>Disable login access</h4>
                  <p>The employee will be signed out and cannot return until access is enabled.</p>
                  <button className="secondary-button danger-button" disabled={accountStateMutation.isPending} onClick={() => accountStateMutation.mutate(true)} type="button">
                    <LockKeyhole aria-hidden="true" size={18} /> {accountStateMutation.isPending ? 'Disabling…' : 'Disable login'}
                  </button>
                </article>
              ) : null}
            </div>
            {accountStateMutation.isError ? <div className="inline-alert" role="alert">{accountStateMutation.error.message}</div> : null}
            {passwordResetMessage ? <div className="form-feedback form-feedback--success" role="status">{passwordResetMessage}</div> : null}
            {trustedDeviceMessage ? <div className="form-feedback form-feedback--success" role="status">{trustedDeviceMessage}</div> : null}
            {mfaResetMessage ? <div className="form-feedback form-feedback--success" role="status">{mfaResetMessage}</div> : null}
            {securityKeyMessage ? <div className="form-feedback form-feedback--success" role="status">{securityKeyMessage}</div> : null}
            {passwordResetMutation.isError ? <div className="inline-alert" role="alert">{passwordResetMutation.error.message}</div> : null}
            {revokeTrustedDevicesMutation.isError ? <div className="inline-alert" role="alert">{revokeTrustedDevicesMutation.error.message}</div> : null}
            {resetMfaMutation.isError ? <div className="inline-alert" role="alert">{resetMfaMutation.error.message}</div> : null}
            {revokeSecurityKeyMutation.isError ? <div className="inline-alert" role="alert">{revokeSecurityKeyMutation.error.message}</div> : null}
          </section>
        ) : null}

        {activeTab === 'onboarding' ? (
          <section className="user-account-tab-panel" aria-labelledby="onboarding-title">
            <div className="user-account-section-heading">
              <div>
                <span className="account-control-kicker">New user invites</span>
                <h3 id="onboarding-title">Approved onboarding emails</h3>
              </div>
              <p>Welcome and login instructions remain separate, approved communications.</p>
            </div>
            <div className="user-account-onboarding-summary">
              <div><span>Delivery email</span><strong>{deliveryEmail ?? 'No approved email available'}</strong></div>
              <div><span>Employee status</span><strong>{statusLabels[employee.status]}</strong></div>
              <div><span>Login status</span><strong>{employee.accountStatus === 'not_created' ? 'Not created' : employee.accountStatus === 'disabled' ? 'Disabled' : 'Created'}</strong></div>
            </div>
            <div className="user-account-email-options">
              <article>
                <Mail aria-hidden="true" size={22} />
                <div><h4>Welcome email</h4><p>Introduces SygShift and the employee experience without including login credentials.</p></div>
                <button className="secondary-button" disabled={!canSendNewUserInvites || welcomeEmailMutation.isPending || employee.status !== 'active' || !deliveryEmail} onClick={() => welcomeEmailMutation.mutate()} type="button">{welcomeEmailMutation.isPending ? 'Sending welcome…' : 'Send welcome email'}</button>
              </article>
              <article>
                <KeyRound aria-hidden="true" size={22} />
                <div><h4>Login instructions</h4><p>Prepares access, delivers a one-time temporary password, and explains authenticator setup only when MFA is required.</p></div>
                <button className="secondary-button" disabled={!canSendNewUserInvites || loginEmailMutation.isPending || employee.status !== 'active' || !deliveryEmail} onClick={() => loginEmailMutation.mutate()} type="button">{loginEmailMutation.isPending ? 'Sending instructions…' : 'Email login instructions'}</button>
              </article>
            </div>
            {!canSendNewUserInvites ? <p className="form-note">New User Invites permission is required to send onboarding emails.</p> : null}
            {employee.status !== 'active' ? <p className="form-note">Only active employees can receive onboarding emails.</p> : null}
            {!deliveryEmail ? <p className="form-note">Add a personal email before sending. SygShift is not sending to @guardianshipsecurity.net while company delivery is blocked.</p> : null}
            {loginEmailMessage ? <div className="form-feedback form-feedback--success" role="status">{loginEmailMessage}</div> : null}
            {welcomeEmailMessage ? <div className="form-feedback form-feedback--success" role="status">{welcomeEmailMessage}</div> : null}
            {loginEmailMutation.isError ? <div className="inline-alert" role="alert">{loginEmailMutation.error.message}</div> : null}
            {welcomeEmailMutation.isError ? <div className="inline-alert" role="alert">{welcomeEmailMutation.error.message}</div> : null}
          </section>
        ) : null}

        {activeTab === 'profile' ? (
          <footer className="user-account-savebar">
            <span className={profileDirty ? 'is-dirty' : ''}>{profileDirty ? 'Unsaved profile changes' : profileSaveMessage ?? 'Profile is up to date'}</span>
            <div>
              <button className="secondary-button" disabled={!profileDirty || updateMutation.isPending} onClick={discardProfileChanges} type="button">Cancel</button>
              <button className="primary-action" disabled={!profileDirty || updateMutation.isPending || !canEditThisProfile} form={profileFormId} type="submit">{updateMutation.isPending ? 'Saving…' : 'Save employee'}</button>
            </div>
          </footer>
        ) : null}
      </div>
      {removingEmployee ? (
        <EmployeeRemovalModal
          employee={employee}
          onClose={() => setRemovingEmployee(false)}
          onRemoved={async () => {
            queryClient.setQueryData<AdminUserDirectory>(['admin-user-directory'], (current) => {
              if (!current) return current
              return { ...current, users: current.users.filter((user) => user.id !== employee.id) }
            })
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' }),
              queryClient.invalidateQueries({ queryKey: ['recently-deleted-employees'], refetchType: 'active' }),
              queryClient.invalidateQueries({ queryKey: ['licensing-center'], refetchType: 'active' }),
            ])
            setRemovingEmployee(false)
            onClose()
          }}
        />
      ) : null}
    </ModalDialog>
  )
}

function EmployeeRemovalModal({
  employee,
  onClose,
  onRemoved,
}: {
  employee: AdminUser
  onClose: () => void
  onRemoved: (result: Awaited<ReturnType<typeof removeSeparatedEmployee>>) => Promise<void>
}) {
  const [confirmation, setConfirmation] = useState('')
  const [reason, setReason] = useState('')
  const previewQuery = useQuery({
    queryFn: () => getEmployeeRemovalPreview(employee.id),
    queryKey: ['employee-removal-preview', employee.id],
  })
  const removalMutation = useMutation({
    mutationFn: () => removeSeparatedEmployee(employee.id, confirmation, reason),
    onSuccess: onRemoved,
  })
  const preview: EmployeeRemovalPreview | undefined = previewQuery.data
  const history = preview?.operationalHistory
  const linkedRecordCount = history
    ? Object.values(history).reduce((total, count) => total + count, 0)
    : 0
  const confirmed = confirmation.trim().toLowerCase() === employee.username.toLowerCase()
    && reason.trim().length >= 8

  return (
    <ModalDialog
      busy={removalMutation.isPending}
      busyLabel="Removing employee from the working system..."
      className="modal-dialog--employee-removal"
      description="This is a restricted administrative action. Historical payroll and audit records will be retained."
      onClose={onClose}
      title={`Remove ${employee.displayName}?`}
    >
      {previewQuery.isPending ? <div className="employee-removal-loading" role="status"><span aria-hidden="true" className="modal-dialog__spinner" /> Reviewing linked records...</div> : null}
      {previewQuery.isError ? <div className="inline-alert" role="alert">{previewQuery.error.message}</div> : null}
      {preview ? (
        <div className="employee-removal-workflow">
          <div className="employee-removal-warning">
            <AlertTriangle aria-hidden="true" size={22} />
            <div>
              <strong>This removes the employee from every working directory.</strong>
              <p>Login access and role permissions are disabled. {linkedRecordCount} linked operational record{linkedRecordCount === 1 ? '' : 's'} will remain available only where required for payroll, schedules, licensing, or audit history.</p>
            </div>
          </div>
          <dl className="employee-removal-counts">
            <div><dt>Shift assignments</dt><dd>{history?.shiftAssignments ?? 0}</dd></div>
            <div><dt>Time punches</dt><dd>{history?.timeEvents ?? 0}</dd></div>
            <div><dt>Requests</dt><dd>{(history?.shiftRequests ?? 0) + (history?.timeOffRequests ?? 0) + (history?.callOffReports ?? 0)}</dd></div>
            <div><dt>Credentials</dt><dd>{history?.credentials ?? 0}</dd></div>
          </dl>
          <label>
            <span>Removal reason</span>
            <textarea onChange={(event) => setReason(event.target.value)} placeholder="Example: Test account created during setup." rows={3} value={reason} />
            <small>Required. At least 8 characters.</small>
          </label>
          <label>
            <span>Type <strong>{employee.username}</strong> to confirm</span>
            <input autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
          </label>
          {removalMutation.isError ? <div className="inline-alert" role="alert">{removalMutation.error.message}</div> : null}
          <div className="modal-actions">
            <button className="secondary-button" disabled={removalMutation.isPending} onClick={onClose} type="button">Keep employee</button>
            <button className="danger-action" disabled={!confirmed || removalMutation.isPending} onClick={() => removalMutation.mutate()} type="button">
              <Trash2 aria-hidden="true" size={17} />
              Remove employee
            </button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  )
}

export function UserAdminPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<'all' | AppRole>('all')
  const [status, setStatus] = useState<'all' | EmployeeStatus>('active')
  const [account, setAccount] = useState<'all' | 'not_created' | 'active' | 'disabled'>('all')
  const [activity, setActivity] = useState<AccountActivityFilter>('all')
  const [creating, setCreating] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [bulkCredentials, setBulkCredentials] = useState<ProvisioningCredential[]>([])
  const [bulkEmailMessage, setBulkEmailMessage] = useState<string | null>(null)

  const sessionQuery = useQuery({
    queryFn: getSessionContext,
    queryKey: ['session-context', 'user-admin'],
  })
  const directoryQuery = useQuery({
    queryFn: getAdminUserDirectory,
    queryKey: ['admin-user-directory'],
  })
  const users = directoryQuery.data?.users ?? EMPTY_USERS

  const sessionContext = sessionQuery.data
  const hasPermission = (permission: string) => Boolean(sessionContext?.permissions.includes(permission))
  const canEditBasic = hasPermission('admin.users.basic') || hasPermission('admin.users.manage')
  const canManageLogin = hasPermission('admin.users.manage')
  const canResetPassword = canManageLogin || hasPermission('admin.users.password_reset')
  const canSendNewUserInvites = Boolean(sessionContext?.permissions.includes('admin.users.invite'))
  const canSeparate = hasPermission('admin.users.separate')
  const canDeleteUsers = hasPermission('admin.users.delete')
  const canEditAdminRole = hasPermission('admin.roles.manage')

  const recentlyDeletedQuery = useQuery({
    enabled: Boolean(canDeleteUsers),
    queryFn: getRecentlyDeletedEmployees,
    queryKey: ['recently-deleted-employees'],
  })

  const createMutation = useMutation({
    mutationFn: createEmployee,
    onSuccess: async (createdEmployee) => {
      queryClient.setQueryData<AdminUserDirectory>(['admin-user-directory'], (current) =>
        replaceDirectoryUser(current, createdEmployee),
      )
      setCreating(false)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' })
    },
  })

  const bulkProvisionMutation = useMutation({
    mutationFn: provisionMissingAccounts,
    onSuccess: async (result) => {
      const credentials = result.provisioned.map((credential) => ({
        ...credential,
        displayName: users.find((user) => user.username === credential.username)?.displayName ?? credential.displayName,
      }))
      setBulkCredentials(credentials)
      if (credentials.length > 0) {
        downloadCredentialCsv(credentials, 'sygshift-new-temporary-logins.csv')
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

  const metrics = useMemo(() => summarizeUserAccounts(users), [users])

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
        && (activity === 'all'
          || (activity === 'pending_setup' && user.accountStatus === 'active' && !user.account?.activatedAt)
          || (activity === 'activated' && Boolean(user.account?.activatedAt))
          || (activity === 'signed_in' && Boolean(user.account?.lastSignInAt))
          || (activity === 'never_signed_in' && user.accountStatus === 'active' && !user.account?.lastSignInAt))
        && (!term || searchable.includes(term))
    })
  }, [account, activity, role, search, status, users])
  const selectedUser = selectedUserId ? users.find((user) => user.id === selectedUserId) ?? null : null

  return (
    <div className="page page--user-admin">
      <section className="page-intro user-admin-intro">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>User Accounts</h1>
          <p className="page-summary">
            Manage employee account records, permanent usernames, login status, MFA, onboarding,
            and recovery. Role and permission design remains in Roles &amp; Permissions.
          </p>
        </div>
        <div className="user-admin-intro__actions">
          <div className="access-note">
            <ShieldCheck aria-hidden="true" size={19} />
            MFA policy active
          </div>
          {canEditBasic ? (
            <button className="primary-action" onClick={() => setCreating(true)} type="button"><Plus aria-hidden="true" size={18} /> Add employee</button>
          ) : null}
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
          <section className="user-admin-summary" aria-label="User account totals">
            <article><span>Total people</span><strong>{metrics.total}</strong><small>Employee records</small></article>
            <article><span>Active</span><strong>{metrics.active}</strong><small>Eligible for access</small></article>
            <article className={metrics.missingLogins ? 'is-attention' : ''}><span>Need accounts</span><strong>{metrics.missingLogins}</strong><small>Active without login</small></article>
            <article><span>Active admins</span><strong>{metrics.activeAdmins}</strong><small>Current primary Admin role</small></article>
          </section>

          <section className="user-admin-controls" aria-label="User account filters and actions">
            <div className="user-admin-toolbar">
              <label className="search-field search-field--wide">
                <Search aria-hidden="true" size={20} />
                <span className="visually-hidden">Search users</span>
                <input onChange={(event) => setSearch(event.target.value)} placeholder="Search name, username, email, or phone" type="search" value={search} />
              </label>
              <label className="select-field"><span>Role</span><select onChange={(event) => setRole(event.target.value as typeof role)} value={role}><option value="all">All roles</option><option value="guard">Guards</option><option value="dispatcher">Dispatchers</option><option value="scheduler">Schedulers</option><option value="recruiting_licensing">Recruiting & Licensing</option><option value="supervisor">Supervisors</option><option value="admin">Admins</option></select></label>
              <label className="select-field"><span>Employment</span><select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}><option value="active">Active</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option><option value="all">All statuses</option></select></label>
              <label className="select-field"><span>Login</span><select onChange={(event) => setAccount(event.target.value as typeof account)} value={account}><option value="all">All logins</option><option value="not_created">No login</option><option value="active">Active login</option><option value="disabled">Disabled</option></select></label>
              <label className="select-field"><span>Activity</span><select onChange={(event) => setActivity(event.target.value as AccountActivityFilter)} value={activity}><option value="all">All activity</option><option value="pending_setup">Pending setup</option><option value="activated">Activated</option><option value="signed_in">Has signed in</option><option value="never_signed_in">Never signed in</option></select></label>
            </div>
            <div className="user-admin-toolbar__actions" aria-label="Bulk account actions">
              <span>{filteredUsers.length} account{filteredUsers.length === 1 ? '' : 's'} shown</span>
              <div>
              {canManageLogin ? (
                <button className="primary-action" disabled={bulkProvisionMutation.isPending || metrics.missingLogins === 0} onClick={() => bulkProvisionMutation.mutate()} type="button">
                  <KeyRound aria-hidden="true" size={18} /> Create missing logins
                </button>
              ) : null}
              {canSendNewUserInvites ? (
                <button className="secondary-button" disabled={bulkLoginEmailMutation.isPending || metrics.missingLogins === 0} onClick={() => bulkLoginEmailMutation.mutate()} type="button">
                  <Mail aria-hidden="true" size={18} /> Send new user invites
                </button>
              ) : null}
              </div>
            </div>
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
              <div className="user-admin-table" role="table" aria-label="User accounts and login access">
                <div className="user-admin-row user-admin-row--header" role="row">
                  <span role="columnheader">Employee</span>
                  <span role="columnheader">Role &amp; Employment</span>
                  <span role="columnheader">Login</span>
                  <span role="columnheader">Last Activity</span>
                  <span role="columnheader">Manage</span>
                </div>
                {filteredUsers.map((user) => (
                  <div className="user-admin-row" key={user.id} role="row">
                    <div role="cell">
                      <strong>{user.displayName}</strong>
                      <span>{user.employeeNumber ?? 'ID pending'} · @{user.username}</span>
                      {user.jobTitle ? <small>{user.jobTitle}</small> : null}
                      <small>{user.companyEmail || user.personalEmail || user.mobilePhone || 'No contact on file'}</small>
                    </div>
                    <div role="cell" className="user-admin-role-employment" data-label="Role & Employment">
                      <span className="plain-value">{roleLabels[user.role]}</span>
                      <small>{employmentLabels[user.employmentType]} · {statusLabels[user.status]}</small>
                    </div>
                    <div role="cell" className="user-admin-login-state" data-label="Login">
                      <AccountStatusBadge user={user} />
                      <small>{user.account?.activatedAt ? 'Activated' : user.accountStatus === 'active' ? 'Setup pending' : user.accountStatus === 'disabled' ? 'Access disabled' : 'No account'}</small>
                    </div>
                    <div role="cell" className="user-admin-last-activity" data-label="Last Activity">
                      <strong>{user.account?.lastSignInAt ? formatAccountDateTime(user.account.lastSignInAt) : 'Never signed in'}</strong>
                      <small>{user.account?.trustedDeviceCount ? `${user.account.trustedDeviceCount} remembered device${user.account.trustedDeviceCount === 1 ? '' : 's'}` : 'No remembered devices'}</small>
                    </div>
                    <div role="cell" data-label="Manage">
                      <button className="secondary-button secondary-button--small" onClick={() => setSelectedUserId(user.id)} type="button">
                        <UserCog aria-hidden="true" size={17} /> {canEditBasic || canManageLogin || canResetPassword || canSendNewUserInvites || canSeparate || canDeleteUsers ? 'Manage' : 'View'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {canDeleteUsers ? (
            <section
              className={recentlyDeletedQuery.data?.length
                ? 'recently-deleted-panel recently-deleted-panel--users'
                : 'recently-deleted-panel recently-deleted-panel--users recently-deleted-panel--empty'}
              aria-labelledby="recently-deleted-users-title"
            >
              <div className="recently-deleted-panel__heading">
                <div>
                  <p className="eyebrow">Audit</p>
                  <h2 id="recently-deleted-users-title">Recently deleted users</h2>
                  <p>Deleted user metadata is retained for 14 days.</p>
                </div>
                <span className="status-pill">14-day retention</span>
              </div>
              {recentlyDeletedQuery.isPending ? (
                <p className="form-note">Loading deleted user metadata.</p>
              ) : recentlyDeletedQuery.isError ? (
                <div className="inline-alert" role="alert">{recentlyDeletedQuery.error.message}</div>
              ) : recentlyDeletedQuery.data?.length ? (
                <div className="recently-deleted-list">
                  {recentlyDeletedQuery.data.map((record) => (
                    <article key={record.id}>
                      <div>
                        <strong>{record.displayName}</strong>
                        <small>Deleted {new Date(record.deletedAt).toLocaleString()}</small>
                      </div>
                      <span>Retained until {new Date(record.expiresAt).toLocaleDateString()}</span>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="recently-deleted-empty">
                  <strong>No recently deleted users</strong>
                  <span>Deleted user metadata will appear here during the retention window.</span>
                </div>
              )}
            </section>
          ) : null}
        </>
      )}

      {creating && canEditBasic ? (
        <ModalDialog
          busy={createMutation.isPending}
          busyLabel="Creating employee..."
          description="A permanent username will be assigned automatically from the employee name."
          onClose={() => setCreating(false)}
          title="Add employee"
        >
          <EmployeeForm
            canEditAdminRole={canEditAdminRole}
            canEditBasic={canEditBasic}
            canSeparate={canSeparate}
            onCancel={() => setCreating(false)}
            onSubmit={(payload) => createMutation.mutate(payload)}
            pending={createMutation.isPending}
          />
          {createMutation.isError ? <div className="inline-alert" role="alert">{createMutation.error.message}</div> : null}
        </ModalDialog>
      ) : null}

      {selectedUserId && !selectedUser && directoryQuery.isFetching ? (
        <ModalDialog
          busy
          busyLabel="Refreshing employee record..."
          description="The employee record is being refreshed after the last change."
          onClose={() => setSelectedUserId(null)}
          title="Refreshing employee"
        >
          <p className="modal-warning">Loading the latest saved employee information.</p>
        </ModalDialog>
      ) : null}

      {selectedUser ? (
        <ManageUserModal
          canDeleteUsers={Boolean(canDeleteUsers)}
          canEditAdminRole={canEditAdminRole}
          canEditBasic={canEditBasic}
          canManageLogin={canManageLogin}
          canResetPassword={canResetPassword}
          canSendNewUserInvites={canSendNewUserInvites}
          canSeparate={canSeparate}
          employee={selectedUser}
          onClose={() => setSelectedUserId(null)}
        />
      ) : null}
    </div>
  )
}

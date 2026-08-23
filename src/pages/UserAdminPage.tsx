import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  AlertTriangle,
  Download,
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
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  createEmployee,
  credentialsToCsv,
  getEmployeeRemovalPreview,
  getAdminUserDirectory,
  getRecentlyDeletedEmployees,
  provisionEmployeeAccount,
  provisionMissingAccounts,
  resetEmployeeMfa,
  revokeEmployeeTrustedDevices,
  removeSeparatedEmployee,
  sendAllEmployeeLoginEmails,
  sendEmployeeLoginEmail,
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
import { getSessionContext } from '../data/auth'
import { preferredEmployeeDeliveryEmail } from '../lib/emailRecipients'
import { formatOperationalDateTime } from '../lib/time'

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

function formatAccountDateTime(value: string | null): string {
  if (!value) return 'Never'

  return formatOperationalDateTime(value)
}

function AccountActivitySummary({ user }: { user: AdminUser }) {
  if (!user.account) {
    return (
      <div className="account-activity">
        <AccountStatusBadge user={user} />
        <span className="account-activity__line">Activation: Not created</span>
        <span className="account-activity__line">Last login: Never</span>
      </div>
    )
  }

  return (
    <div className="account-activity">
      <AccountStatusBadge user={user} />
      <span className="account-activity__line">
        Activation: {user.account.activatedAt ? formatAccountDateTime(user.account.activatedAt) : 'Pending'}
      </span>
      <span className="account-activity__line">
        Last login: {formatAccountDateTime(user.account.lastSignInAt)}
      </span>
    </div>
  )
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
  onCancel,
  onSubmit,
  pending,
}: {
  canEditAdminRole: boolean
  canEditBasic: boolean
  canSeparate: boolean
  employee?: AdminUser
  onCancel: () => void
  onSubmit: (payload: EmployeeMutationInput) => void
  pending: boolean
}) {
  const canEditThisProfile = canEditBasic
    && (canEditAdminRole || employee?.role !== 'admin')
    && (canSeparate || employee?.status !== 'separated')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEditThisProfile) return
    onSubmit(employeeFormPayload(event.currentTarget, employee?.id))
  }

  return (
    <form className="request-form user-admin-form" onSubmit={submit}>
      <div className="form-grid form-grid--three">
        <label><span>First name</span><input defaultValue={employee?.firstName} disabled={!canEditThisProfile} name="firstName" required /></label>
        <label><span>Middle name</span><input defaultValue={employee?.middleName ?? ''} disabled={!canEditThisProfile} name="middleName" /></label>
        <label><span>Last name</span><input defaultValue={employee?.lastName} disabled={!canEditThisProfile} name="lastName" required /></label>
      </div>
      <div className="form-grid form-grid--three">
        <label><span>Preferred name</span><input defaultValue={employee?.preferredName ?? ''} disabled={!canEditThisProfile} name="preferredName" /></label>
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
        <label><span>Job title</span><input defaultValue={employee?.jobTitle ?? ''} disabled={!canEditThisProfile} maxLength={140} name="jobTitle" placeholder="Guard, Owner, CS&AO..." /></label>
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
        <label><span>Mobile phone</span><input defaultValue={employee?.mobilePhone ?? ''} disabled={!canEditThisProfile} name="mobilePhone" /></label>
      </div>
      <div className="form-grid form-grid--two">
        <label><span>Personal email</span><input defaultValue={employee?.personalEmail ?? ''} disabled={!canEditThisProfile} name="personalEmail" type="email" /></label>
        <label><span>Company email</span><input defaultValue={employee?.companyEmail ?? ''} disabled={!canEditThisProfile} name="companyEmail" type="email" /></label>
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onCancel} type="button">Cancel</button>
        <button className="primary-action" disabled={pending || !canEditThisProfile} type="submit">
          {pending ? 'Saving…' : employee ? 'Save employee' : 'Create employee'}
        </button>
      </div>
    </form>
  )
}

function ManageUserModal({
  canDeleteUsers,
  canEditAdminRole,
  canEditBasic,
  canManageLogin,
  canSendNewUserInvites,
  canSeparate,
  employee,
  onClose,
}: {
  canDeleteUsers: boolean
  canEditAdminRole: boolean
  canEditBasic: boolean
  canManageLogin: boolean
  canSendNewUserInvites: boolean
  canSeparate: boolean
  employee: AdminUser
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [lastCredential, setLastCredential] = useState<ProvisioningCredential | null>(null)
  const [loginEmailMessage, setLoginEmailMessage] = useState<string | null>(null)
  const [welcomeEmailMessage, setWelcomeEmailMessage] = useState<string | null>(null)
  const [trustedDeviceMessage, setTrustedDeviceMessage] = useState<string | null>(null)
  const [mfaResetMessage, setMfaResetMessage] = useState<string | null>(null)
  const [confirmingMfaReset, setConfirmingMfaReset] = useState(false)
  const [removingEmployee, setRemovingEmployee] = useState(false)
  const deliveryEmail = preferredEmployeeDeliveryEmail(employee.personalEmail, employee.companyEmail)

  const updateMutation = useMutation({
    mutationFn: (payload: EmployeeMutationInput) => updateEmployee({ ...payload, employeeId: employee.id }),
    onSuccess: async (updatedEmployee) => {
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
        `MFA reset for ${result.displayName}. ${result.factorsRemoved} authenticator factor${result.factorsRemoved === 1 ? '' : 's'} removed and ${result.trustedDevicesRevoked} remembered device${result.trustedDevicesRevoked === 1 ? '' : 's'} revoked.`,
      )
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'], refetchType: 'active' })
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
      setLoginEmailMessage(`Login instructions sent to ${result.email ?? deliveryEmail ?? 'the approved email address'}.`)
      await queryClient.invalidateQueries({ queryKey: ['admin-user-directory'] })
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
    || provisionMutation.isPending
    || loginEmailMutation.isPending
    || welcomeEmailMutation.isPending
  const employeeFormKey = [
    employee.id,
    employee.firstName,
    employee.middleName ?? '',
    employee.lastName,
    employee.preferredName ?? '',
    employee.employeeNumber ?? '',
    employee.jobTitle ?? '',
    employee.role,
    employee.employmentType,
    employee.status,
    employee.mobilePhone ?? '',
    employee.personalEmail ?? '',
    employee.companyEmail ?? '',
  ].join('|')

  return (
    <ModalDialog
      busy={modalBusy}
      busyLabel="Updating employee record..."
      description={`${employee.employeeNumber ?? 'Employee ID pending'} · Permanent username: @${employee.username}${employee.jobTitle ? ` · ${employee.jobTitle}` : ''}`}
      onClose={onClose}
      title={`Manage ${employee.displayName}`}
    >
      <div className="user-admin-modal-grid">
        <section aria-labelledby="employee-profile-title">
          <h3 id="employee-profile-title">Employee profile</h3>
          <EmployeeForm
            canEditAdminRole={canEditAdminRole}
            canEditBasic={canEditBasic}
            canSeparate={canSeparate}
            employee={employee}
            key={employeeFormKey}
            onCancel={onClose}
            onSubmit={(payload) => updateMutation.mutate(payload)}
            pending={updateMutation.isPending}
          />
          {updateMutation.isError ? <div className="inline-alert" role="alert">{updateMutation.error.message}</div> : null}
          <p className="form-note">
            {canEditBasic
              ? 'Credential updates are handled in Directory so schedulers can maintain qualification records without account-security access.'
              : 'This access level can review user records, but cannot edit employee profile details.'}
          </p>
        </section>

        <section className="account-control-panel" aria-labelledby="account-control-title">
          <h3 id="account-control-title">Login access</h3>
          {!canManageLogin ? (
            <div className="account-control-card">
              <AccountStatusBadge user={employee} />
              <AccountActivityPanel user={employee} />
              <p>This permission level can view account state, but cannot create, reset, or disable login access.</p>
            </div>
          ) : null}
          {canManageLogin ? (
          <div className="account-control-card">
            <AccountStatusBadge user={employee} />
            <AccountActivityPanel user={employee} />
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
                disabled={!canManageLogin}
                value={temporaryPassword}
              />
            </label>
            <button
              className="primary-action"
              disabled={!canManageLogin || provisionMutation.isPending || employee.status !== 'active'}
              onClick={() => provisionMutation.mutate()}
              type="button"
            >
              <KeyRound aria-hidden="true" size={18} />
              {employee.accountStatus === 'not_created' ? 'Create login' : 'Reset temporary password'}
            </button>
            {employee.account ? (
              <button
                className="secondary-button"
                disabled={!canManageLogin || accountStateMutation.isPending}
                onClick={() => accountStateMutation.mutate(employee.accountStatus !== 'disabled')}
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={18} />
                {employee.accountStatus === 'disabled' ? 'Enable login' : 'Disable login'}
              </button>
            ) : null}
            {employee.account && (employee.account.trustedDeviceCount ?? 0) > 0 ? (
              <button
                className="secondary-button"
                disabled={!canManageLogin || revokeTrustedDevicesMutation.isPending}
                onClick={() => revokeTrustedDevicesMutation.mutate()}
                type="button"
              >
                <ShieldAlert aria-hidden="true" size={18} />
                Revoke remembered devices ({employee.account.trustedDeviceCount})
              </button>
            ) : null}
            {employee.account ? (
              confirmingMfaReset ? (
                <div className="mfa-reset-confirmation" role="alert">
                  <strong>Reset MFA for {employee.displayName}?</strong>
                  <p>Their authenticator enrollment and remembered devices will be removed. Their password, employee record, and history will not change.</p>
                  <div className="mfa-reset-confirmation__actions">
                    <button className="secondary-button" disabled={resetMfaMutation.isPending} onClick={() => setConfirmingMfaReset(false)} type="button">Cancel</button>
                    <button className="secondary-button danger-button" disabled={resetMfaMutation.isPending} onClick={() => resetMfaMutation.mutate()} type="button">
                      <RotateCcw aria-hidden="true" size={18} /> {resetMfaMutation.isPending ? 'Resetting MFA…' : 'Confirm MFA reset'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="secondary-button"
                  disabled={!canManageLogin || resetMfaMutation.isPending}
                  onClick={() => {
                    setMfaResetMessage(null)
                    setConfirmingMfaReset(true)
                  }}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" size={18} /> Reset MFA setup
                </button>
              )
            ) : null}
            {employee.status !== 'active' ? <small>Only active employees can receive login accounts.</small> : null}
          </div>
          ) : null}

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
          {trustedDeviceMessage ? <div className="form-feedback form-feedback--success" role="status">{trustedDeviceMessage}</div> : null}
          {mfaResetMessage ? <div className="form-feedback form-feedback--success" role="status">{mfaResetMessage}</div> : null}
          {revokeTrustedDevicesMutation.isError ? <div className="inline-alert" role="alert">{revokeTrustedDevicesMutation.error.message}</div> : null}
          {resetMfaMutation.isError ? <div className="inline-alert" role="alert">{resetMfaMutation.error.message}</div> : null}

          {canSendNewUserInvites ? (
          <div className="account-control-card account-control-card--welcome">
            <div>
              <span className="account-control-kicker">New user invites</span>
              <h4>Send approved onboarding emails</h4>
            </div>
            <p>
              Welcome emails introduce SygShift. Login instructions prepare access and deliver a
              one-time temporary password through the approved branded template.
            </p>
            <p>
              Delivery email: <strong>{deliveryEmail ?? 'No approved email available'}</strong>
            </p>
            <button
              className="secondary-button"
              disabled={loginEmailMutation.isPending || employee.status !== 'active' || !deliveryEmail}
              onClick={() => loginEmailMutation.mutate()}
              type="button"
            >
              <Mail aria-hidden="true" size={18} />
              {loginEmailMutation.isPending ? 'Sending instructions…' : 'Email login instructions'}
            </button>
            <button
              className="secondary-button"
              disabled={welcomeEmailMutation.isPending || employee.status !== 'active' || !deliveryEmail}
              onClick={() => welcomeEmailMutation.mutate()}
              type="button"
            >
              <Mail aria-hidden="true" size={18} />
              {welcomeEmailMutation.isPending ? 'Sending welcome…' : 'Send welcome email'}
            </button>
            {employee.status !== 'active' ? <small>Only active employees can receive welcome emails.</small> : null}
            {!deliveryEmail ? (
              <small>
                Add a personal email before sending. SygShift is not sending to @guardianshipsecurity.net while company delivery is blocked.
              </small>
            ) : null}
          </div>
          ) : null}

          {welcomeEmailMessage ? <div className="form-feedback form-feedback--success" role="status">{welcomeEmailMessage}</div> : null}
          {welcomeEmailMutation.isError ? <div className="inline-alert" role="alert">{welcomeEmailMutation.error.message}</div> : null}

          {canDeleteUsers ? (
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
          ) : null}
        </section>
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

  const sessionContext = sessionQuery.data
  const hasPermission = (permission: string) => Boolean(sessionContext?.permissions.includes(permission))
  const canEditBasic = hasPermission('admin.users.basic') || hasPermission('admin.users.manage')
  const canManageLogin = hasPermission('admin.users.manage')
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
          <h1>Users & Access</h1>
          <p className="page-summary">
            Manage employees, permanent usernames, roles, employment status, and login access
            from one controlled admin workspace.
          </p>
        </div>
        <div className="access-note">
          <ShieldCheck aria-hidden="true" size={19} />
          MFA permission checked
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
            <label className="select-field"><span>Role</span><select onChange={(event) => setRole(event.target.value as typeof role)} value={role}><option value="all">All roles</option><option value="guard">Guards</option><option value="dispatcher">Dispatchers</option><option value="scheduler">Schedulers</option><option value="recruiting_licensing">Recruiting & Licensing</option><option value="supervisor">Supervisors</option><option value="admin">Admins</option></select></label>
            <label className="select-field"><span>Status</span><select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}><option value="active">Active</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option><option value="all">All</option></select></label>
            <label className="select-field"><span>Login</span><select onChange={(event) => setAccount(event.target.value as typeof account)} value={account}><option value="all">All logins</option><option value="not_created">No login</option><option value="active">Active login</option><option value="disabled">Disabled</option></select></label>
            <label className="select-field"><span>Activity</span><select onChange={(event) => setActivity(event.target.value as AccountActivityFilter)} value={activity}><option value="all">All activity</option><option value="pending_setup">Pending setup</option><option value="activated">Activated</option><option value="signed_in">Has signed in</option><option value="never_signed_in">Never signed in</option></select></label>
            <div className="user-admin-toolbar__actions">
              {canEditBasic ? (
                <button className="secondary-button" onClick={() => setCreating(true)} type="button"><Plus aria-hidden="true" size={18} /> Add employee</button>
              ) : null}
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
                  <span role="columnheader">Account activity</span>
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
                    <div role="cell"><AccountActivitySummary user={user} /></div>
                    <div role="cell">
                      <button className="secondary-button secondary-button--small" onClick={() => setSelectedUserId(user.id)} type="button">
                        <UserCog aria-hidden="true" size={17} /> {canEditBasic || canManageLogin || canSendNewUserInvites || canSeparate || canDeleteUsers ? 'Manage' : 'View'}
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
          canSendNewUserInvites={canSendNewUserInvites}
          canSeparate={canSeparate}
          employee={selectedUser}
          onClose={() => setSelectedUserId(null)}
        />
      ) : null}
    </div>
  )
}

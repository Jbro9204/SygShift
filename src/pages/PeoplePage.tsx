import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, DatabaseZap, Pencil, Search, ShieldAlert, UsersRound } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getCurrentAppRole, type AppRole } from '../data/session'
import {
  employeeDisplayName,
  getEmployeeDirectory,
  upsertDirectoryCredential,
  type CredentialKind,
  type CredentialStatus,
  type DirectoryEntry,
} from '../data/workforce'
import { isSupabaseConfigured } from '../lib/supabase'

const roleLabels: Record<DirectoryEntry['role'], string> = {
  dispatcher: 'Dispatcher',
  guard: 'Guard',
  scheduler: 'Scheduler',
  supervisor: 'Supervisor',
  admin: 'Admin',
}
const statusLabels: Record<DirectoryEntry['status'], string> = {
  active: 'Active',
  leave: 'On leave',
  inactive: 'Inactive',
  separated: 'Separated',
}
const credentialStatusLabels: Record<CredentialStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  pending: 'Pending',
  revoked: 'Revoked',
  suspended: 'Suspended',
}
const credentialOptions: Array<{ kind: CredentialKind; label: string; helper: string }> = [
  {
    helper: 'Required for normal guard scheduling records.',
    kind: 'guard_license',
    label: 'Guard License',
  },
  {
    helper: 'Controls whether this employee can be assigned to armed posts or events.',
    kind: 'armed_guard',
    label: 'Armed Guard Credential',
  },
  {
    helper: 'Track CPR or first aid readiness when a site requires it.',
    kind: 'first_aid_cpr',
    label: 'First Aid / CPR',
  },
  {
    helper: 'Use when a post requires driving, patrol vehicle use, or a valid license check.',
    kind: 'driver_license',
    label: 'Driver License',
  },
  {
    helper: 'Use for site-specific orientation, post orders, or required client training.',
    kind: 'site_training',
    label: 'Site Training',
  },
  {
    helper: 'Use only when the credential does not fit one of the standard categories.',
    kind: 'other',
    label: 'Other Credential',
  },
]

function canEditCredentials(role: AppRole | null | undefined): boolean {
  return role === 'scheduler' || role === 'supervisor' || role === 'admin'
}

function formatDateOnly(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00`))
}

function EmployeeIdentity({ employee }: { employee: DirectoryEntry }) {
  return (
    <div className="employee-identity">
      <span className={`employee-role-rail employee-role-rail--${employee.role}`} aria-hidden="true" />
      <div>
        <strong>{employeeDisplayName(employee)}</strong>
        <span>
          {employee.employee_number ?? 'ID pending'} · @{employee.username}
        </span>
        {employee.job_title ? <small>{employee.job_title}</small> : null}
      </div>
    </div>
  )
}

function CredentialSummary({ employee }: { employee: DirectoryEntry }) {
  const active = employee.credentials.filter((credential) => credential.status === 'active')
  const armed = active.some((credential) => credential.kind === 'armed_guard')

  return (
    <div className="credential-summary">
      <span className={armed ? 'qualification qualification--armed' : 'qualification'}>
        {armed ? 'Armed qualified' : 'Unarmed only'}
      </span>
      <small>{active.length} active credential{active.length === 1 ? '' : 's'}</small>
    </div>
  )
}

function ContactSummary({ employee }: { employee: DirectoryEntry }) {
  const email = employee.company_email || employee.personal_email
  return (
    <div className="contact-summary">
      <span>{email || 'No email on file'}</span>
      <small>{employee.mobile_phone || 'No phone on file'}</small>
    </div>
  )
}

function OperationalDetails({ employee }: { employee: DirectoryEntry }) {
  const profile = employee.operational_profile
  const hasProfileDetails = profile && [
    profile.locationText,
    profile.scheduleAvailability,
    profile.employeeDg,
    profile.expectedHoursText,
    profile.sourceNotes,
    profile.supervisorLabel,
  ].some(Boolean)
  if (!hasProfileDetails && employee.credentials.length === 0) return null

  return (
    <details className="operational-details">
      <summary>View licenses & operational details</summary>
      <dl>
        {profile?.locationText ? <div><dt>Location</dt><dd>{profile.locationText}</dd></div> : null}
        {profile?.scheduleAvailability ? <div><dt>Availability</dt><dd>{profile.scheduleAvailability}</dd></div> : null}
        {profile?.expectedHoursText ? <div><dt>Expected hours</dt><dd>{profile.expectedHoursText}</dd></div> : null}
        {profile?.employeeDg ? <div><dt>Employee details</dt><dd>{profile.employeeDg}</dd></div> : null}
        {profile?.supervisorLabel ? <div><dt>Supervisor source</dt><dd>{profile.supervisorLabel}</dd></div> : null}
        {profile?.sourceNotes ? <div><dt>Source notes</dt><dd>{profile.sourceNotes}</dd></div> : null}
        {employee.credentials.map((credential, index) => (
          <div key={`${credential.kind}-${index}`}>
            <dt>{credential.kind.replaceAll('_', ' ')}</dt>
            <dd>
              {credential.status}
              {credential.credential_number ? ` · ${credential.credential_number}` : ''}
              {credential.expires_on ? ` · expires ${formatDateOnly(credential.expires_on)}` : ''}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function DirectoryCredentialEditor({
  employee,
  kind,
  label,
  helper,
  onSubmit,
  pending,
}: {
  employee: DirectoryEntry
  kind: CredentialKind
  label: string
  helper: string
  onSubmit: (payload: {
    kind: CredentialKind
    status: CredentialStatus
    credentialNumber: string | null
    validFrom: string | null
    expiresOn: string | null
    notes: string | null
  }) => void
  pending: boolean
}) {
  const credential = employee.credentials.find((item) => item.kind === kind)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const value = (key: string) => String(data.get(key) ?? '').trim()
    const optional = (key: string) => value(key) || null
    onSubmit({
      credentialNumber: optional('credentialNumber'),
      expiresOn: optional('expiresOn'),
      kind,
      notes: optional('notes'),
      status: value('status') as CredentialStatus,
      validFrom: optional('validFrom'),
    })
  }

  return (
    <form className="credential-editor" onSubmit={submit}>
      <div className="credential-editor__heading">
        <div>
          <strong>{label}</strong>
          <small>{helper}</small>
        </div>
        <span>{credential ? credentialStatusLabels[credential.status] : 'Not on file'}</span>
      </div>
      <div className="form-grid form-grid--two">
        <label>
          <span>Status</span>
          <select defaultValue={credential?.status ?? 'pending'} name="status">
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="suspended">Suspended</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>
        <label>
          <span>Credential number</span>
          <input defaultValue={credential?.credential_number ?? ''} name="credentialNumber" />
        </label>
      </div>
      <div className="form-grid form-grid--two">
        <label>
          <span>Valid from</span>
          <input defaultValue={credential?.valid_from ?? ''} name="validFrom" type="date" />
        </label>
        <label>
          <span>Expires on</span>
          <input defaultValue={credential?.expires_on ?? ''} name="expiresOn" type="date" />
        </label>
      </div>
      <label className="field-stack">
        <span>Notes</span>
        <textarea defaultValue={credential?.notes ?? ''} maxLength={2000} name="notes" rows={2} />
      </label>
      <button className="secondary-button secondary-button--small" disabled={pending} type="submit">
        {pending ? 'Saving...' : `Save ${label}`}
      </button>
    </form>
  )
}

function CredentialManagementModal({
  employee,
  onClose,
}: {
  employee: DirectoryEntry
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [currentEmployee, setCurrentEmployee] = useState(employee)

  const credentialMutation = useMutation({
    mutationFn: (payload: {
      kind: CredentialKind
      status: CredentialStatus
      credentialNumber: string | null
      validFrom: string | null
      expiresOn: string | null
      notes: string | null
    }) => upsertDirectoryCredential({ ...payload, employeeId: currentEmployee.id }),
    onSuccess: async (updatedEmployee) => {
      setCurrentEmployee(updatedEmployee)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['employee-directory'] }),
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] }),
        queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] }),
      ])
    },
  })

  return (
    <ModalDialog
      description={`${currentEmployee.employee_number ?? 'ID pending'} · @${currentEmployee.username}`}
      onClose={onClose}
      title={`Credentials for ${employeeDisplayName(currentEmployee)}`}
    >
      <section className="credential-management-panel credential-management-panel--directory" aria-labelledby="directory-credential-title">
        <h3 id="directory-credential-title">Credentials & Qualifications</h3>
        <p className="form-note">
          Armed assignments are blocked unless the armed guard credential is active and valid for the shift date.
        </p>
        {credentialOptions.map((option) => (
          <DirectoryCredentialEditor
            employee={currentEmployee}
            helper={option.helper}
            key={option.kind}
            kind={option.kind}
            label={option.label}
            onSubmit={(payload) => credentialMutation.mutate(payload)}
            pending={credentialMutation.isPending}
          />
        ))}
        {credentialMutation.isError ? <div className="inline-alert" role="alert">{credentialMutation.error.message}</div> : null}
        {credentialMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Credential information saved.</div> : null}
      </section>
    </ModalDialog>
  )
}

export function PeoplePage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'leave'>('active')
  const [selectedEmployee, setSelectedEmployee] = useState<DirectoryEntry | null>(null)
  const directoryQuery = useQuery({
    queryKey: ['employee-directory'],
    queryFn: getEmployeeDirectory,
    enabled: isSupabaseConfigured,
  })
  const roleQuery = useQuery({
    queryKey: ['current-app-role'],
    queryFn: getCurrentAppRole,
    enabled: isSupabaseConfigured,
  })
  const canManageCredentials = canEditCredentials(roleQuery.data)

  const filteredEmployees = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (directoryQuery.data ?? []).filter((employee) => {
      const matchesStatus = status === 'all' || employee.status === status
      const searchable = [
        employeeDisplayName(employee),
        employee.username,
        employee.employee_number,
        employee.job_title,
        roleLabels[employee.role],
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
      return matchesStatus && (!term || searchable.includes(term))
    })
  }, [directoryQuery.data, search, status])

  return (
    <div className="page page--workforce">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>Directory</h1>
          <p className="page-summary">
            One dependable record for identity, login name, employment status, contact details,
            and job qualifications.
          </p>
        </div>
        <div className="access-note">
          <ShieldAlert aria-hidden="true" size={19} />
          Credential updates require Scheduler, Supervisor, or Admin access with MFA
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Directory ready for the secure connection" tone="setup">
          <p>
            Employee information stays hidden until Supabase authentication and the reviewed workbook
            import are connected. The application will not substitute sample people for real records.
          </p>
          <ul>
            <li>System-assigned, permanent usernames</li>
            <li>Armed and unarmed qualification controls</li>
            <li>Protected contact and employment information</li>
          </ul>
        </DataStatePanel>
      ) : directoryQuery.isPending ? (
        <DataStatePanel icon={UsersRound} title="Loading the protected directory">
          <p>Checking your role and retrieving the employee records you are permitted to see.</p>
        </DataStatePanel>
      ) : directoryQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Directory unavailable" tone="error">
          <p>{directoryQuery.error.message}</p>
          <p>Sign in with an authorized operations account using MFA.</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="workforce-toolbar" aria-label="Directory controls">
            <label className="search-field search-field--wide">
              <Search aria-hidden="true" size={20} />
              <span className="visually-hidden">Search employees</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, username, or employee number"
                type="search"
                value={search}
              />
            </label>
            <label className="select-field">
              <span>Status</span>
              <select
                onChange={(event) => setStatus(event.target.value as typeof status)}
                value={status}
              >
                <option value="active">Active</option>
                <option value="leave">On leave</option>
                <option value="all">Active + on leave</option>
              </select>
            </label>
          </section>

          {filteredEmployees.length === 0 ? (
            <DataStatePanel icon={UsersRound} title="No employees match these filters">
              <p>Change the search or status filter to see other active workforce records.</p>
            </DataStatePanel>
          ) : (
            <section className="directory-panel" aria-label="Employee directory results">
              <div className="directory-table" role="table" aria-label="Employees">
                <div className="directory-row directory-row--header" role="row">
                  <span role="columnheader">Employee</span>
                  <span role="columnheader">Role</span>
                  <span role="columnheader">Qualifications</span>
                  <span role="columnheader">Contact</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Action</span>
                </div>
                {filteredEmployees.map((employee) => (
                  <div className="directory-row" role="row" key={employee.id}>
                    <div role="cell"><EmployeeIdentity employee={employee} /></div>
                    <div role="cell"><span className="plain-value">{roleLabels[employee.role]}</span></div>
                    <div role="cell"><CredentialSummary employee={employee} /><OperationalDetails employee={employee} /></div>
                    <div role="cell"><ContactSummary employee={employee} /></div>
                    <div role="cell">
                      <span className={`status-badge status-badge--${employee.status}`}>
                        {statusLabels[employee.status]}
                      </span>
                    </div>
                    <div role="cell">
                      {canManageCredentials ? (
                        <button className="secondary-button secondary-button--small" onClick={() => setSelectedEmployee(employee)} type="button">
                          <Pencil aria-hidden="true" size={16} />
                          Edit Credentials
                        </button>
                      ) : <span className="plain-value">Read only</span>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="directory-cards">
                {filteredEmployees.map((employee) => (
                  <article className="employee-card" key={employee.id}>
                    <div className="employee-card__heading">
                      <EmployeeIdentity employee={employee} />
                      <span className={`status-badge status-badge--${employee.status}`}>
                        {statusLabels[employee.status]}
                      </span>
                    </div>
                    <dl>
                      <div><dt>Role</dt><dd>{roleLabels[employee.role]}</dd></div>
                      <div><dt>Qualifications</dt><dd><CredentialSummary employee={employee} /></dd></div>
                      <div><dt>Contact</dt><dd><ContactSummary employee={employee} /></dd></div>
                    </dl>
                    <OperationalDetails employee={employee} />
                    {canManageCredentials ? (
                      <button className="secondary-button secondary-button--small" onClick={() => setSelectedEmployee(employee)} type="button">
                        <Pencil aria-hidden="true" size={16} />
                        Edit Credentials
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          )}

          <p className="results-note">
            <BadgeCheck aria-hidden="true" size={18} />
            Showing {filteredEmployees.length} of {directoryQuery.data?.length ?? 0} active workforce records
          </p>
          {selectedEmployee ? (
            <CredentialManagementModal employee={selectedEmployee} onClose={() => setSelectedEmployee(null)} />
          ) : null}
        </>
      )}
    </div>
  )
}

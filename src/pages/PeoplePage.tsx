import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, format } from 'date-fns'
import { BadgeCheck, CalendarCheck2, DatabaseZap, Pencil, Search, ShieldAlert, Trash2, UsersRound } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  cancelAvailability,
  getAvailabilityWorkspace,
  submitAvailability,
  type AvailabilityRecord,
} from '../data/availability'
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
import { operationalToday } from '../lib/time'

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
const employmentLabels: Record<DirectoryEntry['employment_type'], string> = {
  flex: 'Flex',
  hourly: 'Hourly',
  salary: 'Salary',
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
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const dayNamesShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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

function formatAvailabilityTime(value: string | null): string {
  if (!value) return 'All day'
  const [hoursText, minutesText] = value.split(':')
  const hours = Number(hoursText)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${minutesText} ${suffix}`
}

function availabilityRange(record: Pick<AvailabilityRecord, 'startsOn' | 'endsOn'>): string {
  const start = formatDateOnly(record.startsOn)
  const end = formatDateOnly(record.endsOn)
  return start === end ? start : `${start} - ${end}`
}

function availabilitySummary(record: AvailabilityRecord): string {
  const type = record.availabilityStatus === 'available' ? 'Available' : 'Unavailable'
  const day = record.dayOfWeek === null ? '' : ` · ${dayNames[record.dayOfWeek]}`
  const time = record.startTime || record.endTime
    ? ` · ${formatAvailabilityTime(record.startTime)} - ${formatAvailabilityTime(record.endTime)}`
    : ' · All day'
  return `${type} · ${availabilityRange(record)}${day}${time}`
}

function activeAvailability(records: AvailabilityRecord[], employeeId: string): AvailabilityRecord[] {
  return records
    .filter((record) => record.employeeId === employeeId && ['approved', 'pending'].includes(record.approvalStatus))
    .sort((left, right) => left.startsOn.localeCompare(right.startsOn) || left.createdAt.localeCompare(right.createdAt))
}

function weeklyAvailability(records: AvailabilityRecord[], employeeId: string) {
  return dayNamesShort.map((label, dayOfWeek) => {
    const rules = activeAvailability(records, employeeId).filter((record) =>
      record.approvalStatus === 'approved'
      && record.availabilityStatus === 'unavailable'
      && (record.dayOfWeek === null || record.dayOfWeek === dayOfWeek),
    )
    return {
      dayOfWeek,
      label,
      rule: rules[0] ?? null,
    }
  })
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

function DirectoryAvailabilityManager({
  employee,
  records,
  pending,
}: {
  employee: DirectoryEntry
  records: AvailabilityRecord[]
  pending: boolean
}) {
  const queryClient = useQueryClient()
  const employeeRecords = activeAvailability(records, employee.id)
  const week = weeklyAvailability(records, employee.id)
  const todayKey = format(operationalToday(), 'yyyy-MM-dd')
  const [message, setMessage] = useState<string | null>(null)

  const submitMutation = useMutation({
    mutationFn: submitAvailability,
    onSuccess: async () => {
      setMessage('Availability saved for scheduling.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['availability-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] }),
      ])
    },
  })
  const cancelMutation = useMutation({
    mutationFn: (input: { id: string; note: string | null }) => cancelAvailability(input.id, input.note),
    onSuccess: async () => {
      setMessage('Availability rule removed.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['availability-workspace'] }),
        queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] }),
      ])
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    submitMutation.mutate({
      availabilityStatus: String(form.get('availabilityStatus')) === 'available' ? 'available' : 'unavailable',
      dayOfWeek: String(form.get('dayOfWeek') || '') === '' ? null : Number(form.get('dayOfWeek')),
      employeeId: employee.id,
      endTime: String(form.get('endTime') || '') || null,
      endsOn: String(form.get('endsOn')),
      note: String(form.get('note') || '').trim() || null,
      startTime: String(form.get('startTime') || '') || null,
      startsOn: String(form.get('startsOn')),
    }, {
      onSuccess: () => formElement.reset(),
    })
  }

  return (
    <section className="directory-availability-panel" aria-labelledby="directory-availability-title">
      <div className="directory-availability-panel__heading">
        <div>
          <h3 id="directory-availability-title">Scheduling availability</h3>
          <p>
            Mark normal unavailable windows here. Schedulers can still override a rule from the schedule,
            but the system will require a written reason.
          </p>
        </div>
        <CalendarCheck2 aria-hidden="true" size={24} />
      </div>

      <div className="availability-week-strip" aria-label="Weekly availability snapshot">
        {week.map((day) => (
          <div className={day.rule ? 'availability-day-chip availability-day-chip--blocked' : 'availability-day-chip'} key={day.dayOfWeek}>
            <span>{day.label}</span>
            <strong>{day.rule ? 'Unavailable' : 'Open'}</strong>
            {day.rule?.startTime || day.rule?.endTime ? (
              <small>{formatAvailabilityTime(day.rule.startTime)} - {formatAvailabilityTime(day.rule.endTime)}</small>
            ) : null}
          </div>
        ))}
      </div>

      <form className="request-form directory-availability-form" onSubmit={submit}>
        <div className="form-grid form-grid--three">
          <label>
            <span>Start date</span>
            <input min={todayKey} name="startsOn" required type="date" />
          </label>
          <label>
            <span>End date</span>
            <input min={todayKey} name="endsOn" required type="date" />
          </label>
          <label>
            <span>Type</span>
            <select name="availabilityStatus" required>
              <option value="unavailable">Unavailable</option>
              <option value="available">Available</option>
            </select>
          </label>
        </div>
        <div className="form-grid form-grid--three">
          <label>
            <span>Repeats on <small>Optional</small></span>
            <select name="dayOfWeek">
              <option value="">All selected dates</option>
              {dayNames.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
          </label>
          <label>
            <span>Start time <small>Optional</small></span>
            <input name="startTime" type="time" />
          </label>
          <label>
            <span>End time <small>Optional</small></span>
            <input name="endTime" type="time" />
          </label>
        </div>
        <label className="field-stack">
          <span>Note <small>Optional</small></span>
          <textarea maxLength={2000} name="note" placeholder="Example: Flex employee cannot work Thursdays." rows={2} />
        </label>
        <div className="directory-availability-form__actions">
          <button className="primary-action" disabled={pending || submitMutation.isPending} type="submit">
            {submitMutation.isPending ? 'Saving...' : 'Save availability'}
          </button>
        </div>
      </form>

      <div className="directory-availability-list" aria-label="Saved availability rules">
        {employeeRecords.length ? employeeRecords.map((record) => (
          <article className="directory-availability-rule" key={record.id}>
            <div>
              <span className={`status-badge status-badge--${record.approvalStatus}`}>{record.approvalStatus}</span>
              <strong>{availabilitySummary(record)}</strong>
              {record.note ? <small>{record.note}</small> : null}
            </div>
            <button
              aria-label={`Remove availability rule for ${employeeDisplayName(employee)}`}
              className="secondary-button secondary-button--small"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate({ id: record.id, note: 'Removed from Directory.' })}
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} />
              Remove
            </button>
          </article>
        )) : (
          <p className="empty-note">No active availability rules are on file for this employee.</p>
        )}
      </div>

      {message ? <div className="form-feedback form-feedback--success" role="status">{message}</div> : null}
      {submitMutation.isError ? <div className="inline-alert" role="alert">{submitMutation.error.message}</div> : null}
      {cancelMutation.isError ? <div className="inline-alert" role="alert">{cancelMutation.error.message}</div> : null}
    </section>
  )
}

function DirectoryProfileModal({
  employee,
  availabilityRecords,
  availabilityPending,
  onClose,
}: {
  employee: DirectoryEntry
  availabilityRecords: AvailabilityRecord[]
  availabilityPending: boolean
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
      title={`Directory profile for ${employeeDisplayName(currentEmployee)}`}
    >
      <p className="directory-profile-summary">
        Employment: {employmentLabels[currentEmployee.employment_type]} · Role: {roleLabels[currentEmployee.role]}
      </p>
      <DirectoryAvailabilityManager
        employee={currentEmployee}
        pending={availabilityPending}
        records={availabilityRecords}
      />
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
  const todayKey = format(operationalToday(), 'yyyy-MM-dd')
  const throughKey = format(addDays(operationalToday(), 42), 'yyyy-MM-dd')
  const availabilityQuery = useQuery({
    queryKey: ['availability-workspace', todayKey, throughKey],
    queryFn: () => getAvailabilityWorkspace(todayKey, throughKey),
    enabled: isSupabaseConfigured && canManageCredentials,
  })

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
                          Manage Profile
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
                        Manage Profile
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
            <DirectoryProfileModal
              availabilityPending={availabilityQuery.isPending}
              availabilityRecords={availabilityQuery.data?.availability ?? []}
              employee={selectedEmployee}
              onClose={() => setSelectedEmployee(null)}
            />
          ) : null}
        </>
      )}
    </div>
  )
}

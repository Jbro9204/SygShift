import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, DatabaseZap, Search, ShieldAlert, UsersRound } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  employeeDisplayName,
  getEmployeeDirectory,
  type DirectoryEntry,
} from '../data/workforce'
import { isSupabaseConfigured } from '../lib/supabase'

const roleLabels: Record<DirectoryEntry['role'], string> = {
  guard: 'Guard',
  supervisor: 'Supervisor',
  admin: 'Admin',
}
const statusLabels: Record<DirectoryEntry['status'], string> = {
  active: 'Active',
  leave: 'On leave',
  inactive: 'Inactive',
  separated: 'Separated',
}

function EmployeeIdentity({ employee }: { employee: DirectoryEntry }) {
  return (
    <div className="employee-identity">
      <span className={`employee-role-rail employee-role-rail--${employee.role}`} aria-hidden="true" />
      <div>
        <strong>{employeeDisplayName(employee)}</strong>
        <span>@{employee.username}</span>
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
              {credential.expires_on ? ` · expires ${credential.expires_on}` : ''}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

export function PeoplePage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | DirectoryEntry['status']>('active')
  const directoryQuery = useQuery({
    queryKey: ['employee-directory'],
    queryFn: getEmployeeDirectory,
    enabled: isSupabaseConfigured,
  })

  const filteredEmployees = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (directoryQuery.data ?? []).filter((employee) => {
      const matchesStatus = status === 'all' || employee.status === status
      const searchable = [
        employeeDisplayName(employee),
        employee.username,
        employee.employee_number,
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
          <h1>Employee directory</h1>
          <p className="page-summary">
            One dependable record for identity, login name, employment status, contact details,
            and job qualifications.
          </p>
        </div>
        <div className="access-note">
          <ShieldAlert aria-hidden="true" size={19} />
          Sensitive details require supervisor access and MFA
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
          <p>Sign in with an authorized supervisor or administrator account using MFA.</p>
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
                <option value="inactive">Inactive</option>
                <option value="separated">Separated</option>
                <option value="all">All employees</option>
              </select>
            </label>
          </section>

          {filteredEmployees.length === 0 ? (
            <DataStatePanel icon={UsersRound} title="No employees match these filters">
              <p>Change the search or status filter to see other directory records.</p>
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
                  </article>
                ))}
              </div>
            </section>
          )}

          <p className="results-note">
            <BadgeCheck aria-hidden="true" size={18} />
            Showing {filteredEmployees.length} of {directoryQuery.data?.length ?? 0} permitted records
          </p>
        </>
      )}
    </div>
  )
}

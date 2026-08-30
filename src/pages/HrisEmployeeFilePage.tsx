import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarCheck2,
  ClipboardCheck,
  KeyRound,
  Mail,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { canAccessRoute } from '../app/accessPolicy'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import { getHrisEmployeeFile } from '../data/hrisPeople'
import { formatOperationalDateTime } from '../lib/time'

const labels: Record<string, string> = {
  active: 'Active', disabled: 'Disabled', inactive: 'Inactive', leave: 'On leave', not_created: 'Not created', onboarding: 'Onboarding', pending: 'Activation pending', separated: 'Separated',
}

const readinessLabels: Record<string, string> = {
  employee_number_missing: 'Employee number needed',
  hire_date_missing: 'Verified hire date needed',
  separation_date_missing: 'Verified separation date needed',
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatDate(value: string | null): string {
  if (!value) return 'Not recorded'
  const [year, month, day] = value.split('-')
  return `${month}/${day}/${year}`
}

function display(value: string | null): string {
  return value?.trim() || 'Not recorded'
}

export function HrisEmployeeFilePage() {
  const { employeeId = '' } = useParams()
  const sessionQuery = useQuery({
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const recordQuery = useQuery({
    enabled: Boolean(employeeId),
    queryFn: () => getHrisEmployeeFile(employeeId),
    queryKey: ['hris-employee-file', employeeId],
  })
  const record = recordQuery.data
  const connectedWorkspaces = [
    { icon: BadgeCheck, label: 'Licensing Center', path: '/licensing' },
    { icon: CalendarCheck2, label: 'Availability', path: '/availability' },
    { icon: ClipboardCheck, label: 'Time-Off Requests', path: '/requests' },
    { icon: KeyRound, label: 'User Accounts', path: '/users' },
  ].filter((workspace) => canAccessRoute(workspace.path, sessionQuery.data))

  return (
    <main className="hr-file-page">
      <Link className="hr-file-back" to="/hr/people"><ArrowLeft aria-hidden="true" size={18} />Back to People</Link>

      {recordQuery.isPending ? <DataStatePanel icon={UserRound} title="Loading Employee File"><p>Checking the protected workforce record.</p></DataStatePanel> : null}
      {recordQuery.isError ? <DataStatePanel icon={AlertTriangle} tone="error" title="Employee File unavailable"><p>{recordQuery.error instanceof Error ? recordQuery.error.message : 'The protected employee record could not be loaded.'}</p></DataStatePanel> : null}

      {record ? (
        <>
          <header className="hr-file-hero">
            <div className="hr-file-avatar" aria-hidden="true">{record.firstName[0]}{record.lastName[0]}</div>
            <div><p className="eyebrow">Employee File</p><h1>{record.legalName}</h1><p>{record.employeeNumber || 'Employee number pending'} · @{record.username}</p></div>
            <div className="hr-file-hero__status"><span>{labels[record.status] ?? titleCase(record.status)}</span><small>{record.jobTitle || titleCase(record.primaryRole)}</small></div>
          </header>

          {record.readinessSignals.length > 0 ? <section className="hr-file-alert" aria-label="Record readiness"><AlertTriangle aria-hidden="true" /><div><strong>Employee record needs attention</strong><div>{record.readinessSignals.map((signal) => <span key={signal}>{readinessLabels[signal] ?? titleCase(signal)}</span>)}</div></div></section> : <section className="hr-file-ready"><ShieldCheck aria-hidden="true" /><strong>Core employee record is ready.</strong></section>}

          <section className="hr-file-grid">
            <article className="hr-file-card">
              <div className="hr-file-card__heading"><UserRound aria-hidden="true" /><div><p className="eyebrow">Identity</p><h2>Legal employee record</h2></div></div>
              <dl><div><dt>Legal first name</dt><dd>{record.firstName}</dd></div><div><dt>Legal middle name</dt><dd>{display(record.middleName)}</dd></div><div><dt>Legal last name</dt><dd>{record.lastName}</dd></div><div><dt>Employee number</dt><dd>{display(record.employeeNumber)}</dd></div></dl>
            </article>

            <article className="hr-file-card">
              <div className="hr-file-card__heading"><ClipboardCheck aria-hidden="true" /><div><p className="eyebrow">Employment</p><h2>Current relationship</h2></div></div>
              <dl><div><dt>Employment type</dt><dd>{titleCase(record.employmentType)}</dd></div><div><dt>Primary role</dt><dd>{titleCase(record.primaryRole)}</dd></div><div><dt>Job title</dt><dd>{display(record.jobTitle)}</dd></div><div><dt>Hire date</dt><dd>{formatDate(record.hiredOn)}</dd></div>{record.status === 'separated' ? <div><dt>Separation date</dt><dd>{formatDate(record.separatedOn)}</dd></div> : null}</dl>
            </article>

            <article className="hr-file-card">
              <div className="hr-file-card__heading"><KeyRound aria-hidden="true" /><div><p className="eyebrow">Account</p><h2>Sign-in readiness</h2></div></div>
              <dl><div><dt>Account status</dt><dd>{labels[record.account.status] ?? titleCase(record.account.status)}</dd></div><div><dt>Invited</dt><dd>{record.account.invitedAt ? formatOperationalDateTime(record.account.invitedAt) : 'Not recorded'}</dd></div><div><dt>Activated</dt><dd>{record.account.activatedAt ? formatOperationalDateTime(record.account.activatedAt) : 'Not recorded'}</dd></div><div><dt>Last sign-in</dt><dd>{record.account.lastSignInAt ? formatOperationalDateTime(record.account.lastSignInAt) : 'Never'}</dd></div></dl>
            </article>

            <article className="hr-file-card">
              <div className="hr-file-card__heading"><BadgeCheck aria-hidden="true" /><div><p className="eyebrow">Connected records</p><h2>Operational readiness</h2></div></div>
              <div className="hr-file-counts"><span><strong>{record.connectedRecords.activeCredentials}</strong>Active credentials</span><span><strong>{record.connectedRecords.expiredCredentials}</strong>Expired credentials</span><span><strong>{record.connectedRecords.upcomingAvailability}</strong>Availability records</span><span><strong>{record.connectedRecords.pendingTimeOff}</strong>Pending time-off</span></div>
            </article>
          </section>

          {record.canViewRestricted && record.contacts ? (
            <section className="hr-file-card hr-file-contacts">
              <div className="hr-file-card__heading"><Mail aria-hidden="true" /><div><p className="eyebrow">Restricted contact record</p><h2>Contact &amp; emergency details</h2></div></div>
              <dl><div><dt>Personal email</dt><dd>{display(record.contacts.personalEmail)}</dd></div><div><dt>Company email</dt><dd>{display(record.contacts.companyEmail)}</dd></div><div><dt>Mobile phone</dt><dd>{display(record.contacts.mobilePhone)}</dd></div><div><dt>Emergency contact</dt><dd>{display(record.contacts.emergencyContactName)}</dd></div><div><dt>Emergency phone</dt><dd>{display(record.contacts.emergencyContactPhone)}</dd></div><div><dt>Address</dt><dd>{[record.contacts.addressLine1, record.contacts.addressLine2, record.contacts.city, record.contacts.region, record.contacts.postalCode].filter(Boolean).join(', ') || 'Not recorded'}</dd></div></dl>
            </section>
          ) : <section className="hr-file-restricted"><ShieldCheck aria-hidden="true" /><div><strong>Restricted contact details are protected.</strong><p>This account does not have the separate HR restricted-data permission.</p></div></section>}

          <section className="hr-file-links">
            <div><p className="eyebrow">Connected workspaces</p><h2>Continue working this employee</h2><p>Use the existing specialized workspace for operational changes. Employee File remains a review surface.</p></div>
            <nav aria-label="Employee connected workspaces">
              {connectedWorkspaces.map((workspace) => {
                const Icon = workspace.icon
                return <Link key={workspace.path} to={workspace.path}><Icon aria-hidden="true" />{workspace.label}</Link>
              })}
            </nav>
          </section>
        </>
      ) : null}
    </main>
  )
}

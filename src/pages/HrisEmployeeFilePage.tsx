import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CalendarCheck2,
  ChevronDown,
  ClipboardCheck,
  FileStack,
  History,
  KeyRound,
  Mail,
  MoveUpRight,
  PencilLine,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { canAccessRoute } from '../app/accessPolicy'
import { DataStatePanel } from '../components/DataStatePanel'
import { EmploymentDateEditorDialog } from '../components/EmploymentDateEditorDialog'
import { getSessionContext } from '../data/auth'
import { getHrisEmployeeFile, getHrisEmploymentDateHistory, hrisEmploymentDateSourceLabels } from '../data/hrisPeople'
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

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function HrisEmployeeFilePage() {
  const { employeeId = '' } = useParams()
  const [employmentDateEditorOpen, setEmploymentDateEditorOpen] = useState(false)
  const [employmentDateSaved, setEmploymentDateSaved] = useState(false)
  const sessionQuery = useQuery({
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const recordQuery = useQuery({
    enabled: Boolean(employeeId),
    queryFn: () => getHrisEmployeeFile(employeeId),
    queryKey: ['hris-employee-file', employeeId],
  })
  const employmentDateHistoryQuery = useQuery({
    enabled: Boolean(employeeId),
    queryFn: () => getHrisEmploymentDateHistory(employeeId),
    queryKey: ['hris-employment-date-history', employeeId],
  })
  const record = recordQuery.data

  function openEmploymentDateEditor() {
    if (!record) return
    setEmploymentDateSaved(false)
    setEmploymentDateEditorOpen(true)
  }
  const connectedWorkspaces = [
    { icon: BadgeCheck, label: 'Licensing Center', path: '/licensing' },
    { icon: CalendarCheck2, label: 'Availability', path: '/availability' },
    { icon: ClipboardCheck, label: 'Time-Off Requests', path: '/requests' },
    { icon: KeyRound, label: 'User Accounts', path: '/users' },
  ].filter((workspace) => canAccessRoute(workspace.path, sessionQuery.data))
  const employeeFileGroups = record ? [
    {
      description: 'Required records and the work still needed to make this employee ready.',
      label: 'Record readiness',
      modules: [
        {
          detail: record.connectedRecords.documents ? `${countLabel(record.connectedRecords.documents.expiring, 'expiring document')} within 60 days` : '',
          label: 'Documents',
          path: '/hr/documents',
          status: record.connectedRecords.documents ? countLabel(record.connectedRecords.documents.total, 'current document') : '',
          visible: record.moduleAccess.documents,
        },
        {
          detail: record.connectedRecords.onboarding ? `${countLabel(record.connectedRecords.onboarding.openTasks, 'open task')} · ${countLabel(record.connectedRecords.onboarding.blockedTasks, 'blocked task')}` : '',
          label: 'Onboarding',
          path: '/hr/onboarding',
          status: record.connectedRecords.onboarding?.status ? titleCase(record.connectedRecords.onboarding.status) : 'No active case',
          visible: record.moduleAccess.onboarding,
        },
      ],
    },
    {
      description: 'Approved leave, benefit participation, and compensation-record readiness.',
      label: 'Employment programs',
      modules: [
        {
          detail: record.connectedRecords.leave ? countLabel(record.connectedRecords.leave.upcoming, 'upcoming leave') : '',
          label: 'Leave',
          path: '/hr/leave',
          status: record.connectedRecords.leave ? countLabel(record.connectedRecords.leave.open, 'open case') : '',
          visible: record.moduleAccess.leave,
        },
        {
          detail: record.connectedRecords.benefits ? countLabel(record.connectedRecords.benefits.pending, 'pending enrollment') : '',
          label: 'Benefits',
          path: '/hr/benefits',
          status: record.connectedRecords.benefits ? countLabel(record.connectedRecords.benefits.active, 'active enrollment') : '',
          visible: record.moduleAccess.benefits,
        },
        {
          detail: 'Pay values remain restricted to the compensation workspace.',
          label: 'Compensation',
          path: '/hr/compensation',
          status: record.connectedRecords.compensation ? countLabel(record.connectedRecords.compensation.activeRecords, 'active record') : '',
          visible: record.moduleAccess.compensation,
        },
      ],
    },
    {
      description: 'Development, training, employee relations, safety, and company property.',
      label: 'Growth & compliance',
      modules: [
        {
          detail: record.connectedRecords.talent ? `${countLabel(record.connectedRecords.talent.pendingReviews, 'pending review')} · ${countLabel(record.connectedRecords.talent.activePlans, 'active plan')}` : '',
          label: 'Talent',
          path: '/hr/talent-learning',
          status: record.connectedRecords.talent ? countLabel(record.connectedRecords.talent.openGoals, 'open goal') : '',
          visible: record.moduleAccess.talent,
        },
        {
          detail: record.connectedRecords.learning ? countLabel(record.connectedRecords.learning.overdue, 'overdue assignment') : '',
          label: 'Learning',
          path: '/hr/talent-learning',
          status: record.connectedRecords.learning ? countLabel(record.connectedRecords.learning.assigned, 'active assignment') : '',
          visible: record.moduleAccess.learning,
        },
        {
          detail: record.connectedRecords.employeeCases ? countLabel(record.connectedRecords.employeeCases.highPriority, 'high-priority case') : '',
          label: 'Employee relations',
          path: '/hr/cases-compliance',
          status: record.connectedRecords.employeeCases ? countLabel(record.connectedRecords.employeeCases.open, 'open case') : '',
          visible: record.moduleAccess.cases,
        },
        {
          detail: 'Incident details remain in the protected case workspace.',
          label: 'Safety',
          path: '/hr/cases-compliance',
          status: record.connectedRecords.safety ? countLabel(record.connectedRecords.safety.open, 'open case') : '',
          visible: record.moduleAccess.safety,
        },
        {
          detail: 'Issue, return, and transfer work stays in Assets.',
          label: 'Assigned assets',
          path: '/hr/cases-compliance',
          status: record.connectedRecords.assets ? countLabel(record.connectedRecords.assets.assigned, 'assigned item') : '',
          visible: record.moduleAccess.assets,
        },
      ],
    },
    {
      description: 'Lifecycle changes and employee-submitted HR service requests.',
      label: 'Lifecycle & service',
      modules: [
        {
          detail: 'Separation and lifecycle actions remain fully audited.',
          label: 'Offboarding',
          path: '/hr/offboarding',
          status: record.connectedRecords.lifecycle ? countLabel(record.connectedRecords.lifecycle.open, 'open case') : '',
          visible: record.moduleAccess.offboarding,
        },
        {
          detail: 'Requests remain owned by the Employee Service workspace.',
          label: 'Employee requests',
          path: '/hr/self-service',
          status: record.connectedRecords.selfService ? countLabel(record.connectedRecords.selfService.pending, 'pending request') : '',
          visible: record.moduleAccess.selfService,
        },
      ],
    },
  ].map((group) => ({
    ...group,
    modules: group.modules.filter((module) => module.visible && canAccessRoute(module.path, sessionQuery.data)),
  })).filter((group) => group.modules.length > 0) : []

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

            <article className="hr-file-card hr-file-employment-card">
              <div className="hr-file-card__heading"><ClipboardCheck aria-hidden="true" /><div><p className="eyebrow">Employment</p><h2>Current relationship</h2></div>{employmentDateHistoryQuery.data?.canManage ? <button className="hr-file-card__edit" onClick={openEmploymentDateEditor} type="button"><PencilLine aria-hidden="true" size={16} />Edit dates</button> : null}</div>
              <dl><div><dt>Employment type</dt><dd>{titleCase(record.employmentType)}</dd></div><div><dt>Primary role</dt><dd>{titleCase(record.primaryRole)}</dd></div><div><dt>Job title</dt><dd>{display(record.jobTitle)}</dd></div><div><dt>Start / hire date</dt><dd>{formatDate(record.hiredOn)}</dd></div><div><dt>Separation / termination date</dt><dd>{formatDate(record.separatedOn)}</dd></div></dl>
              {employmentDateSaved ? <div className="hr-file-employment-saved" role="status"><CalendarCheck2 aria-hidden="true" size={17} />Employment dates and audit history updated.</div> : null}
              {employmentDateHistoryQuery.data?.items.length ? (
                <details className="hr-file-employment-history">
                  <summary><History aria-hidden="true" size={16} />Date history <span>{employmentDateHistoryQuery.data.items.length}</span></summary>
                  <div>{employmentDateHistoryQuery.data.items.map((item) => <article key={item.id}><strong>{formatDate(item.hiredOn)} – {formatDate(item.separatedOn)}</strong><span>{hrisEmploymentDateSourceLabels[item.sourceType]} · {formatOperationalDateTime(item.authorizedAt)}</span><small>{item.reason}</small>{item.current ? <em>Current evidence</em> : null}</article>)}</div>
                </details>
              ) : null}
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

          {employeeFileGroups.length > 0 ? (
            <section className="hr-file-sections" aria-labelledby="employee-file-sections-heading">
              <div className="hr-file-sections__heading">
                <div><p className="eyebrow">Employee record</p><h2 id="employee-file-sections-heading">Connected HR file</h2></div>
                <p>Live summaries from each protected HR workspace. No information is copied or maintained twice.</p>
              </div>
              <div className="hr-file-section-list">
                {employeeFileGroups.map((group, index) => (
                  <details className="hr-file-section" key={group.label} open={index === 0}>
                    <summary>
                      <span className="hr-file-section__icon"><FileStack aria-hidden="true" /></span>
                      <span><strong>{group.label}</strong><small>{group.description}</small></span>
                      <span className="hr-file-section__count">{group.modules.length}</span>
                      <ChevronDown aria-hidden="true" className="hr-file-section__chevron" />
                    </summary>
                    <div className="hr-file-module-grid">
                      {group.modules.map((module) => (
                        <Link className="hr-file-module" key={`${group.label}-${module.label}`} to={module.path}>
                          <span><strong>{module.label}</strong><small>{module.detail}</small></span>
                          <span className="hr-file-module__status">{module.status}</span>
                          <MoveUpRight aria-hidden="true" />
                        </Link>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          <section className="hr-file-links">
            <div><p className="eyebrow">Connected workspaces</p><h2>Continue working this employee</h2><p>The Employee File is the authoritative index. Employment dates are maintained here; other changes open the specialized workspace that owns the record.</p></div>
            <nav aria-label="Employee connected workspaces">
              {connectedWorkspaces.map((workspace) => {
                const Icon = workspace.icon
                return <Link key={workspace.path} to={workspace.path}><Icon aria-hidden="true" />{workspace.label}</Link>
              })}
            </nav>
          </section>

          {employmentDateEditorOpen ? <EmploymentDateEditorDialog employee={record} onClose={() => setEmploymentDateEditorOpen(false)} onSaved={() => setEmploymentDateSaved(true)} /> : null}
        </>
      ) : null}
    </main>
  )
}

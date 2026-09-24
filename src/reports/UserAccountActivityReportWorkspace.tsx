import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Download, FileText, Search, ShieldCheck, UserRoundCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ModalDialog } from '../components/ModalDialog'
import {
  getUserAccountActivityReport,
  type UserAccountActivityFilters,
  type UserAccountActivityRow,
} from '../data/userAccountActivityReport'
import { downloadXlsxWorkbook } from '../lib/xlsxWorkbook'
import {
  accountStateLabels,
  formatAccountActivityDate,
  loginStateLabels,
  securityExceptionLabels,
  userAccountActivityPdf,
  userAccountActivityWorkbook,
} from './userAccountActivityReport'

const initialFilters: UserAccountActivityFilters = {
  search: '', employmentStatus: '', accountStatus: '', loginStatus: '', mfaStatus: '', role: '', source: '', staleDays: 30,
}

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function describeFilters(filters: UserAccountActivityFilters): string {
  return [
    `Search: ${filters.search || 'All'}`,
    `Employment: ${filters.employmentStatus || 'All'}`,
    `Account: ${filters.accountStatus || 'All'}`,
    `Login: ${filters.loginStatus || 'All'}`,
    `MFA: ${filters.mfaStatus || 'All'}`,
    `Role: ${filters.role || 'All'}`,
    `Source: ${filters.source || 'All'}`,
    `Inactive threshold: ${filters.staleDays} days`,
  ].join('; ')
}

function AccountActivityDetail({ onClose, row }: { onClose: () => void; row: UserAccountActivityRow }) {
  return <ModalDialog className="reports-detail-modal account-activity-detail-modal" description="Read-only account readiness and completed SygShift sign-in history. Security changes remain in User Accounts." onClose={onClose} title={row.employeeName}>
    <div className="reports-detail-grid account-activity-detail-grid">
      <div><span>Employee number</span><strong>{row.employeeNumber ?? 'Not assigned'}</strong></div>
      <div><span>Username</span><strong>@{row.username}</strong></div>
      <div><span>Employment</span><strong>{row.employmentStatus.replaceAll('_', ' ')}</strong></div>
      <div><span>Job title</span><strong>{row.jobTitle ?? 'Not recorded'}</strong></div>
      <div><span>Assigned roles</span><strong>{row.accessRoles.join(', ') || row.primaryRole}</strong></div>
      <div><span>Account</span><strong>{accountStateLabels[row.accountState]}</strong></div>
      <div><span>Invited</span><strong>{formatAccountActivityDate(row.invitedAt)}</strong></div>
      <div><span>Password completed</span><strong>{formatAccountActivityDate(row.passwordChangedAt)}</strong></div>
      <div><span>First completed sign-in</span><strong>{formatAccountActivityDate(row.firstCompletedSignInAt)}</strong></div>
      <div><span>Last completed sign-in</span><strong>{formatAccountActivityDate(row.lastCompletedSignInAt)}</strong></div>
      <div><span>Completed sign-ins</span><strong>{row.completedSignInCount}</strong></div>
      <div><span>Sign-in sources</span><strong>{row.completedSources.join(', ') || 'None'}</strong></div>
      <div><span>MFA</span><strong>{row.requiresMfa ? (row.mfaEnrolled ? 'Required and enrolled' : 'Required — not enrolled') : 'Not required'}</strong></div>
      <div><span>Active sessions</span><strong>{row.activeSessionCount}</strong></div>
      <div><span>Remembered devices</span><strong>{row.trustedDeviceCount}</strong></div>
      <div><span>Security exception</span><strong>{securityExceptionLabels[row.securityException]}</strong></div>
      <div className="account-activity-detail-grid__wide"><span>Recommended next action</span><strong>{row.nextAction}</strong></div>
    </div>
    <div className="modal-actions"><Link className="primary-action" to={`/hr/people/${row.employeeId}`}>Open Employee File</Link><Link className="secondary-button" to="/users">Open User Accounts</Link><button className="secondary-button" onClick={onClose} type="button">Close</button></div>
  </ModalDialog>
}

export function UserAccountActivityReportWorkspace({ canExport }: { canExport: boolean }) {
  const [filters, setFilters] = useState<UserAccountActivityFilters>(initialFilters)
  const [appliedSearch, setAppliedSearch] = useState('')
  const [pageSize, setPageSize] = useState<10 | 25 | 50>(25)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<UserAccountActivityRow | null>(null)

  useEffect(() => {
    const timeout = window.setTimeout(() => { setAppliedSearch(filters.search); setOffset(0) }, 300)
    return () => window.clearTimeout(timeout)
  }, [filters.search])

  const appliedFilters = { ...filters, search: appliedSearch }
  const query = useQuery({
    queryKey: ['user-account-activity-report', appliedFilters, pageSize, offset],
    queryFn: () => getUserAccountActivityReport({ ...appliedFilters, pageSize, offset }),
    placeholderData: (previous) => previous,
  })
  const exportMutation = useMutation({
    mutationFn: async (format: 'xlsx' | 'pdf') => {
      const report = await getUserAccountActivityReport({ ...appliedFilters, export: true, offset: 0, pageSize: 50 })
      const description = describeFilters(appliedFilters)
      const fileName = `SygShift_User_Account_Activity_${new Date().toISOString().slice(0, 10)}`
      if (format === 'xlsx') downloadXlsxWorkbook(userAccountActivityWorkbook(report, description), `${fileName}.xlsx`)
      else downloadBytes(await userAccountActivityPdf(report, description), `${fileName}.pdf`, 'application/pdf')
      return { count: report.rows.length, format }
    },
  })
  const total = query.data?.totalCount ?? 0
  const page = Math.floor(offset / pageSize) + 1
  const pages = Math.max(1, Math.ceil(total / pageSize))

  function updateFilter<K extends keyof UserAccountActivityFilters>(key: K, value: UserAccountActivityFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }))
    if (key !== 'search') setOffset(0)
    exportMutation.reset()
  }

  return <>
    <section className="operations-panel reports-workspace-heading account-activity-heading">
      <Link className="secondary-button reports-back" to="/reports">Back to report library</Link>
      <div><p className="eyebrow">Protected HR &amp; security reporting</p><h1>User Account &amp; Sign-In Activity</h1><p>Review who has an account, who has completed a SygShift sign-in, pending setup, MFA readiness, active sessions, and access roles from one controlled report.</p></div>
    </section>

    <section className="operations-panel reports-workspace-controls account-activity-controls" aria-label="User account activity report controls">
      <label className="reports-search"><span>Search employees</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => updateFilter('search', event.target.value)} placeholder="Name, employee number, username, email, title, or role" type="search" value={filters.search} /></span></label>
      <div className="reports-filter-row account-activity-filter-row">
        <label><span>Employment</span><select value={filters.employmentStatus} onChange={(event) => updateFilter('employmentStatus', event.target.value)}><option value="">All employees</option><option value="onboarding">Onboarding</option><option value="active">Active</option><option value="leave">Leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option></select></label>
        <label><span>Account</span><select value={filters.accountStatus} onChange={(event) => updateFilter('accountStatus', event.target.value)}><option value="">All account states</option><option value="not_created">No account</option><option value="setup_incomplete">Setup incomplete</option><option value="active">Active</option><option value="disabled">Disabled</option></select></label>
        <label><span>Sign-in activity</span><select value={filters.loginStatus} onChange={(event) => updateFilter('loginStatus', event.target.value)}><option value="">All sign-in states</option><option value="never_signed_in">Never signed in</option><option value="recent">Recently active</option><option value="stale">Inactive</option></select></label>
        <label><span>MFA</span><select value={filters.mfaStatus} onChange={(event) => updateFilter('mfaStatus', event.target.value)}><option value="">All MFA states</option><option value="required_missing">Required — missing</option><option value="enrolled">Enrolled</option><option value="not_required">Not required</option></select></label>
        <label><span>Role</span><select value={filters.role} onChange={(event) => updateFilter('role', event.target.value)}><option value="">All roles</option><option value="guard">Guard</option><option value="dispatcher">Dispatcher</option><option value="scheduler">Scheduler</option><option value="supervisor">Supervisor</option><option value="recruiting_licensing">Recruiting &amp; Licensing</option><option value="admin">Admin</option><option value="Human Resources Employee">Human Resources Employee</option><option value="Human Resources Manager">Human Resources Manager</option><option value="Operations Manager">Operations Manager</option></select></label>
        <label><span>Sign-in source</span><select value={filters.source} onChange={(event) => updateFilter('source', event.target.value)}><option value="">All sources</option><option value="native">SygShift</option><option value="platform">Sygilant</option><option value="sygsphere">SygSphere</option></select></label>
        <label><span>Inactive after</span><select value={filters.staleDays} onChange={(event) => updateFilter('staleDays', Number(event.target.value) as 7 | 30 | 60 | 90)}><option value={7}>7 days</option><option value={30}>30 days</option><option value={60}>60 days</option><option value={90}>90 days</option></select></label>
      </div>
      <div className="account-activity-rule"><ShieldCheck aria-hidden="true" size={20} /><div><strong>Completed sign-ins only</strong><span>A password attempt does not count. SygShift records activity only after password setup, required MFA, and account admission are complete.</span></div></div>
    </section>

    <section className="operations-metrics reports-metric-grid account-activity-metrics" aria-label="User account activity totals">
      <article><span>Matching employees</span><strong>{query.data?.summary.total ?? '—'}</strong><small>Current filters</small></article>
      <article><span>Active accounts</span><strong>{query.data?.summary.activeAccounts ?? '—'}</strong><small>Available for sign-in</small></article>
      <article className={query.data?.summary.neverSignedIn ? 'import-metric--attention' : ''}><span>Never signed in</span><strong>{query.data?.summary.neverSignedIn ?? '—'}</strong><small>Completed sign-ins</small></article>
      <article className={query.data?.summary.pendingSetup ? 'import-metric--attention' : ''}><span>Pending setup</span><strong>{query.data?.summary.pendingSetup ?? '—'}</strong><small>No account or password pending</small></article>
      <article className={query.data?.summary.mfaAttention ? 'import-metric--attention' : ''}><span>MFA attention</span><strong>{query.data?.summary.mfaAttention ?? '—'}</strong><small>Required but not enrolled</small></article>
      <article className={query.data?.summary.securityExceptions ? 'import-metric--attention' : ''}><span>Security exceptions</span><strong>{query.data?.summary.securityExceptions ?? '—'}</strong><small>Status mismatch or missing MFA</small></article>
    </section>

    <section className="operations-panel reports-results account-activity-results" aria-busy={query.isFetching}>
      <div className="reports-section-heading"><div><p className="eyebrow">Account readiness</p><h2>{query.data ? `${total} matching employees` : 'Loading employees'}</h2><p>Use the Employee File for employment records and User Accounts for login or security changes.</p></div><div className="account-activity-export-actions"><button className="primary-action" disabled={!canExport || exportMutation.isPending || query.isFetching} onClick={() => exportMutation.mutate('xlsx')} type="button"><Download aria-hidden="true" size={17} />{exportMutation.isPending ? 'Preparing…' : 'Export Excel'}</button><button className="secondary-button" disabled={!canExport || exportMutation.isPending || query.isFetching} onClick={() => exportMutation.mutate('pdf')} type="button"><FileText aria-hidden="true" size={17} />Export PDF</button></div></div>
      {!canExport ? <p className="reports-export-note">Account activity export permission is required to download protected records.</p> : null}
      {exportMutation.isSuccess ? <p className="form-feedback" role="status">{exportMutation.data.format.toUpperCase()} prepared with {exportMutation.data.count} employees.</p> : null}
      {exportMutation.isError ? <p className="inline-alert" role="alert">{exportMutation.error.message}</p> : null}
      {query.isPending ? <div className="report-empty">Loading protected account activity…</div> : null}
      {query.isError ? <div className="inline-alert" role="alert">{query.error.message}</div> : null}
      {query.isSuccess && !query.data.rows.length ? <div className="report-empty">No employees match these filters.</div> : null}
      {query.data?.rows.length ? <div className="reports-result-list account-activity-list">{query.data.rows.map((row) => <article className={`reports-result-card account-activity-row${row.securityException !== 'none' ? ' account-activity-row--attention' : ''}`} key={row.employeeId}><dl className="reports-result-summary account-activity-summary"><div><dt>Employee</dt><dd>{row.employeeName}<small>{row.employeeNumber ?? 'No employee number'} · @{row.username}</small></dd></div><div><dt>Account</dt><dd>{accountStateLabels[row.accountState]}<small>{row.employmentStatus.replaceAll('_', ' ')}</small></dd></div><div><dt>Sign-in activity</dt><dd>{loginStateLabels[row.loginState]}<small>{formatAccountActivityDate(row.lastCompletedSignInAt)}</small></dd></div><div><dt>MFA</dt><dd>{row.requiresMfa ? (row.mfaEnrolled ? 'Enrolled' : 'Required — missing') : 'Not required'}<small>{row.activeSessionCount} active session{row.activeSessionCount === 1 ? '' : 's'}</small></dd></div><div><dt>Next action</dt><dd>{row.nextAction}<small>{row.securityException === 'none' ? 'No security exception' : securityExceptionLabels[row.securityException]}</small></dd></div></dl><button className="secondary-button" onClick={() => setSelected(row)} type="button">View details</button></article>)}</div> : null}
      {total > 0 ? <nav className="reports-pagination account-activity-pagination" aria-label="User account report pages"><label>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) as 10 | 25 | 50); setOffset(0) }}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label><span>Page {page} of {pages}</span><button className="secondary-button" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, offset - pageSize))} type="button">Previous</button><button className="secondary-button" disabled={offset + pageSize >= total || query.isFetching} onClick={() => setOffset(offset + pageSize)} type="button">Next</button></nav> : null}
      {query.data?.summary.securityExceptions ? <div className="account-activity-caution"><AlertTriangle aria-hidden="true" size={19} /><span>Security exceptions need review in User Accounts. This report never changes an account automatically.</span></div> : <div className="account-activity-clear"><UserRoundCheck aria-hidden="true" size={19} /><span>No account-status security exceptions match the current filters.</span></div>}
    </section>
    {selected ? <AccountActivityDetail onClose={() => setSelected(null)} row={selected} /> : null}
  </>
}

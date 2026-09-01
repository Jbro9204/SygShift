import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, BadgeCheck, ChevronLeft, ChevronRight, Download, Search, ShieldAlert } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { authorizeLicensingStatusExport, getLicensingCenter, type LicensingEmployee } from '../data/licensing'
import { isSupabaseConfigured } from '../lib/supabase'
import {
  filterLicensingReportEmployees,
  formatLicensingDate,
  formatLicensingEmploymentStatus,
  formatWorkEligibility,
  guardLicenseCredential,
  guardLicenseStatus,
  guardLicenseStatusLabels,
  legalLicensingEmployeeName,
  summarizeLicensingReport,
  type GuardLicenseStatus,
  type LicensingEmployeeScope,
  type LicensingEmploymentScope,
  type LicensingReportFilters,
} from './licensingStatusReport'
import { downloadLicensingStatusWorkbook } from './licensingStatusWorkbook'

const pageSizes = [10, 25, 50] as const

function statusTone(status: GuardLicenseStatus): string {
  if (status === 'current') return 'green'
  if (status === 'expiring' || status === 'pending') return 'yellow'
  return 'red'
}

function LicensingEmployeeDetails({ employee, onClose }: { employee: LicensingEmployee; onClose: () => void }) {
  const guardCredential = guardLicenseCredential(employee)
  return <ModalDialog className="reports-detail-modal reports-licensing-modal" description="Read-only licensing report detail. Make record changes in Licensing Center." onClose={onClose} title={legalLicensingEmployeeName(employee)}>
    <div className="reports-detail-grid">
      <div><span>Employee ID</span><strong>{employee.employeeNumber ?? 'Not recorded'}</strong></div>
      <div><span>Employment</span><strong>{formatLicensingEmploymentStatus(employee.employmentStatus)}</strong></div>
      <div><span>Guard license status</span><strong>{guardLicenseStatusLabels[guardLicenseStatus(employee)]}</strong></div>
      <div><span>License number</span><strong>{guardCredential?.credentialNumber ?? 'Not recorded'}</strong></div>
      <div><span>Expiration</span><strong>{formatLicensingDate(guardCredential?.expirationDate)}</strong></div>
      <div><span>Work eligibility</span><strong>{formatWorkEligibility(employee.workEligibility)}</strong></div>
    </div>
    <section className="reports-licensing-credential-detail">
      <div><h3>Credential detail</h3><span>{employee.credentials.length} records and requirements</span></div>
      <div className="reports-licensing-credential-list">
        {employee.credentials.map((credential) => <article key={credential.credentialTypeId}>
          <div><strong>{credential.credentialName}</strong><span>{credential.credentialNumber ?? (credential.required ? 'Required — not on file' : 'Not on file')}</span></div>
          <span className={`reports-license-pill reports-license-pill--${credential.complianceColor}`}>{credential.statusLabel}</span>
          <dl><div><dt>Issued</dt><dd>{formatLicensingDate(credential.issueDate)}</dd></div><div><dt>Expires</dt><dd>{formatLicensingDate(credential.expirationDate)}</dd></div><div><dt>Documents</dt><dd>{credential.documentCount}</dd></div></dl>
        </article>)}
      </div>
    </section>
    <div className="modal-actions"><Link className="primary-action" to="/licensing">Open Licensing Center</Link><button className="secondary-button" onClick={onClose} type="button">Close</button></div>
  </ModalDialog>
}

export function LicensingStatusReportWorkspace({ canExport }: { canExport: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedEmployee, setSelectedEmployee] = useState<LicensingEmployee | null>(null)
  const rawPageSize = Number(searchParams.get('pageSize') ?? 10)
  const pageSize = pageSizes.includes(rawPageSize as 10 | 25 | 50) ? rawPageSize as 10 | 25 | 50 : 10
  const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)
  const employeeScope: LicensingEmployeeScope = searchParams.get('employeeScope') === 'all' ? 'all' : 'guards'
  const employmentValue = searchParams.get('employment')
  const employmentStatus: LicensingEmploymentScope = ['onboarding', 'active', 'leave', 'inactive', 'separated', 'all'].includes(employmentValue ?? '')
    ? employmentValue as LicensingEmploymentScope
    : 'active'
  const statusValue = searchParams.get('licenseStatus')
  const licenseStatus: GuardLicenseStatus | 'all' = ['current', 'expiring', 'expired', 'not_licensed', 'pending', 'restricted'].includes(statusValue ?? '')
    ? statusValue as GuardLicenseStatus
    : 'all'
  const credentialTypeId = searchParams.get('credential') ?? 'all'
  const search = searchParams.get('search') ?? ''
  const filters: LicensingReportFilters = { credentialTypeId, employeeScope, employmentStatus, licenseStatus, search }

  const centerQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getLicensingCenter,
    queryKey: ['licensing-center'],
  })

  const updateParameters = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '') next.delete(key)
      else next.set(key, String(value))
    }
    setSearchParams(next)
  }

  const baseEmployees = filterLicensingReportEmployees(centerQuery.data?.employees ?? [], {
    ...filters,
    licenseStatus: 'all',
  })
  const filteredEmployees = filterLicensingReportEmployees(centerQuery.data?.employees ?? [], filters)
  const summary = summarizeLicensingReport(baseEmployees)
  const totalPages = filteredEmployees.length === 0 ? 0 : Math.ceil(filteredEmployees.length / pageSize)
  const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages)
  const visibleEmployees = filteredEmployees.slice((safePage - 1) * pageSize, safePage * pageSize)

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!centerQuery.data) throw new Error('The licensing report is not ready yet.')
      const authorization = await authorizeLicensingStatusExport({
        credentialTypeId: filters.credentialTypeId === 'all' ? null : filters.credentialTypeId,
        employeeScope: filters.employeeScope,
        employmentStatus: filters.employmentStatus,
        licenseStatus: filters.licenseStatus,
        search: filters.search,
      })
      return downloadLicensingStatusWorkbook({
        credentialTypes: centerQuery.data.credentialTypes,
        employees: filteredEmployees,
        filters,
        generatedAt: authorization.authorizedAt,
      })
    },
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={ShieldAlert} title="Licensing report needs the secure connection" tone="setup"><p>The report becomes available after the protected data connection is restored.</p></DataStatePanel>
  if (centerQuery.isPending) return <DataStatePanel icon={BadgeCheck} title="Loading Licensing Status report"><p>Checking current guard-license, credential, and work-eligibility records.</p></DataStatePanel>
  if (centerQuery.isError) return <DataStatePanel icon={ShieldAlert} title="Licensing Status report unavailable" tone="error"><p>{centerQuery.error.message}</p><p>Licensing access and verified MFA are required.</p></DataStatePanel>

  const statusCards: Array<{ count: number; key: GuardLicenseStatus; label: string }> = [
    { count: summary.current, key: 'current', label: 'Current' },
    { count: summary.expiring, key: 'expiring', label: 'Expiring soon' },
    { count: summary.expired, key: 'expired', label: 'Expired' },
    { count: summary.notLicensed, key: 'not_licensed', label: 'Not licensed' },
    { count: summary.pending, key: 'pending', label: 'Pending review' },
    { count: summary.restricted, key: 'restricted', label: 'Restricted' },
  ]

  return <>
    <section className="operations-panel reports-workspace-heading reports-licensing-heading">
      <Link className="secondary-button reports-back" to="/reports"><ArrowLeft aria-hidden="true" size={18} />Back to report library</Link>
      <div><p className="eyebrow">Licensing report</p><h1>Guard Licensing Status</h1><p>See who is currently licensed, approaching expiration, expired, pending review, restricted, or missing a required guard license.</p></div>
      {canExport ? <button className="primary-action" disabled={exportMutation.isPending || filteredEmployees.length === 0} onClick={() => exportMutation.mutate()} type="button"><Download aria-hidden="true" size={18} />{exportMutation.isPending ? 'Preparing workbook...' : 'Download Excel report'}</button> : null}
    </section>

    <section className="reports-licensing-status-grid" aria-label="Guard license status summary">
      <button className={licenseStatus === 'all' ? 'is-active' : ''} onClick={() => updateParameters({ licenseStatus: null, page: 1 })} type="button"><span>Employees shown</span><strong>{summary.total}</strong><small>All license states</small></button>
      {statusCards.map((card) => <button className={[`reports-licensing-status--${statusTone(card.key)}`, licenseStatus === card.key ? 'is-active' : ''].filter(Boolean).join(' ')} key={card.key} onClick={() => updateParameters({ licenseStatus: licenseStatus === card.key ? null : card.key, page: 1 })} type="button"><span>{card.label}</span><strong>{card.count}</strong><small>Open filtered list</small></button>)}
    </section>

    <section className="operations-panel reports-workspace-controls reports-licensing-controls" aria-label="Licensing report filters">
      <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => updateParameters({ search: event.target.value, page: 1 })} placeholder="Legal name, employee ID, license number, or credential" type="search" value={search} /></span></label>
      <div className="reports-filter-row">
        <label><span>Employees</span><select onChange={(event) => updateParameters({ employeeScope: event.target.value === 'all' ? 'all' : null, page: 1 })} value={employeeScope}><option value="guards">Guards only</option><option value="all">All employees</option></select></label>
        <label><span>Employment</span><select onChange={(event) => updateParameters({ employment: event.target.value === 'active' ? null : event.target.value, page: 1 })} value={employmentStatus}><option value="active">Active</option><option value="onboarding">Onboarding</option><option value="leave">On leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option><option value="all">All statuses</option></select></label>
        <label><span>License status</span><select onChange={(event) => updateParameters({ licenseStatus: event.target.value === 'all' ? null : event.target.value, page: 1 })} value={licenseStatus}><option value="all">All license statuses</option>{statusCards.map((status) => <option key={status.key} value={status.key}>{status.label}</option>)}</select></label>
        <label><span>Credential type</span><select onChange={(event) => updateParameters({ credential: event.target.value === 'all' ? null : event.target.value, page: 1 })} value={credentialTypeId}><option value="all">All credential types</option>{centerQuery.data.credentialTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
        <label><span>Rows</span><select onChange={(event) => updateParameters({ pageSize: event.target.value, page: 1 })} value={pageSize}>{pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      </div>
      {!canExport ? <div className="reports-export-note"><ShieldAlert aria-hidden="true" size={18} /><span>You can view this report. Downloading requires the protected Report Export permission.</span></div> : null}
      {exportMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Downloaded {exportMutation.data.fileName} with {filteredEmployees.length} employee records.</div> : null}
      {exportMutation.isError ? <div className="inline-alert" role="alert">{exportMutation.error.message}</div> : null}
    </section>

    <section className="operations-panel reports-results" aria-live="polite">
      <div className="reports-section-heading"><div><p className="eyebrow">Results</p><h2>{filteredEmployees.length} employees</h2><p>Legal names only. Statuses come from the same protected rules used by Licensing Center.</p></div><Link className="secondary-button reports-canonical-link" to="/licensing">Open Licensing Center</Link></div>
      {visibleEmployees.length === 0 ? <div className="report-empty">No employees match these licensing filters.</div> : <div className="reports-result-list">{visibleEmployees.map((employee) => {
        const license = guardLicenseCredential(employee)
        const status = guardLicenseStatus(employee)
        return <article className={`reports-result-card reports-licensing-result reports-licensing-result--${statusTone(status)}`} key={employee.employeeId}>
          <dl className="reports-result-summary reports-licensing-summary">
            <div><dt>Employee</dt><dd>{legalLicensingEmployeeName(employee)}<small>{employee.employeeNumber ?? 'ID not recorded'} · {employee.jobTitle ?? 'Title not recorded'}</small></dd></div>
            <div><dt>Guard license</dt><dd><span className={`reports-license-pill reports-license-pill--${statusTone(status)}`}>{guardLicenseStatusLabels[status]}</span><small>{license?.statusLabel ?? 'Required license is not on file'}</small></dd></div>
            <div><dt>License number</dt><dd>{license?.credentialNumber ?? 'Not recorded'}</dd></div>
            <div><dt>Expiration</dt><dd>{formatLicensingDate(license?.expirationDate)}<small>{license?.daysRemaining === null || license?.daysRemaining === undefined ? 'Days remaining not available' : `${license.daysRemaining} days remaining`}</small></dd></div>
            <div><dt>Work eligibility</dt><dd>{formatWorkEligibility(employee.workEligibility)}<small>{employee.missingCredentialCount} required credential(s) missing</small></dd></div>
          </dl>
          <button className="secondary-button" onClick={() => setSelectedEmployee(employee)} type="button">View details</button>
        </article>
      })}</div>}
      {totalPages > 1 ? <div className="reports-pagination" aria-label="Licensing report pages"><button className="secondary-button" disabled={safePage <= 1} onClick={() => updateParameters({ page: safePage - 1 })} type="button"><ChevronLeft aria-hidden="true" size={18} />Previous</button><span>Page {safePage} of {totalPages}</span><button className="secondary-button" disabled={safePage >= totalPages} onClick={() => updateParameters({ page: safePage + 1 })} type="button">Next<ChevronRight aria-hidden="true" size={18} /></button></div> : null}
    </section>

    {selectedEmployee ? <LicensingEmployeeDetails employee={selectedEmployee} onClose={() => setSelectedEmployee(null)} /> : null}
  </>
}

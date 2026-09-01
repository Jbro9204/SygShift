import { type FormEvent, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, DatabaseBackup, FileCheck2, Search, ShieldCheck, UserRoundCheck } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { EmploymentDateEditorDialog } from '../components/EmploymentDateEditorDialog'
import { getHrisIdentityReadiness, type HrisIdentityReadinessItem } from '../data/hrisIdentityReadiness'
import { formatOperationalDateTime } from '../lib/time'

const mappingLabels: Record<HrisIdentityReadinessItem['mappingState'], string> = {
  already_mapped: 'Already mapped',
  blocked: 'Blocked',
  identity_ready: 'Identity ready',
  worker_ready: 'Worker record ready',
}

function formatDate(value: string | null): string {
  if (!value) return 'Not verified'
  const [year, month, day] = value.split('-')
  return `${month}/${day}/${year}`
}

function warningLabel(code: string): string {
  const labels: Record<string, string> = {
    employee_number_missing: 'Employee number missing',
    hire_date_missing: 'Hire date missing',
    separation_date_missing: 'Separation date missing',
  }
  return labels[code] ?? code.replaceAll('_', ' ')
}

function blockerLabel(code: string): string {
  return code.replaceAll('_', ' ')
}

export function HrisIdentityReadinessPage() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [selectedEmployee, setSelectedEmployee] = useState<HrisIdentityReadinessItem | null>(null)
  const [resultMessage, setResultMessage] = useState<string | null>(null)

  const workspaceQuery = useQuery({
    queryFn: () => getHrisIdentityReadiness({ page, pageSize, search, status }),
    queryKey: ['hris-identity-readiness', page, pageSize, search, status],
  })

  useEffect(() => {
    if (workspaceQuery.data && page > workspaceQuery.data.totalPages) setPage(workspaceQuery.data.totalPages)
  }, [page, workspaceQuery.data])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPage(1)
    setSearch(searchInput.trim())
  }

  const workspace = workspaceQuery.data
  const control = workspace?.control
  const summary = workspace?.summary
  const readiness = workspace?.canaryReadiness

  return (
    <main className="hris-readiness-page">
      <header className="hris-readiness-hero">
        <div>
          <p className="eyebrow">HR &amp; Finance</p>
          <h1>Employment Data Readiness</h1>
          <p>Verify the employment dates required for the protected HR identity foundation without changing access, schedules, time, or payroll.</p>
        </div>
        <div className="hris-readiness-hero__guardrail">
          <ShieldCheck aria-hidden="true" size={24} />
          <div><strong>Protected review</strong><span>MFA and HR employee-management permission required</span></div>
        </div>
      </header>

      {resultMessage ? <div className="success-message" role="status">{resultMessage}</div> : null}

      {workspaceQuery.isPending ? <DataStatePanel icon={DatabaseBackup} title="Loading employment readiness"><p>Checking protected HR records and preservation controls.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} tone="error" title="Employment readiness unavailable"><p>{workspaceQuery.error instanceof Error ? workspaceQuery.error.message : 'The protected readiness workspace could not be loaded.'}</p></DataStatePanel> : null}

      {workspace ? (
        <>
          <section className="hris-readiness-summary" aria-label="Employment readiness summary">
            <article><span>Employees</span><strong>{summary?.employeeCount ?? 0}</strong><small>Legal workforce records</small></article>
            <article className={(control?.missingHireDateCount ?? 0) > 0 ? 'attention' : ''}><span>Hire dates needed</span><strong>{control?.missingHireDateCount ?? 0}</strong><small>Must come from verified HR evidence</small></article>
            <article className={(control?.missingSeparationDateCount ?? 0) > 0 ? 'attention' : ''}><span>Separation dates needed</span><strong>{control?.missingSeparationDateCount ?? 0}</strong><small>Separated employees only</small></article>
            <article className={(summary?.blockedCount ?? 0) > 0 ? 'blocked' : ''}><span>Identity blockers</span><strong>{summary?.blockedCount ?? 0}</strong><small>Deterministic mapping conflicts</small></article>
          </section>

          <section className="hris-readiness-gates">
            <article>
              <DatabaseBackup aria-hidden="true" />
              <div><span>Backfill gate</span><strong>{readiness?.backfillGateEnabled ? 'Attention needed' : 'Closed'}</strong><small>No browser execution is available.</small></div>
            </article>
            <article>
              <FileCheck2 aria-hidden="true" />
              <div><span>Recovery evidence</span><strong>{readiness?.recoveryEvidenceCurrent ? 'Current' : 'Required'}</strong><small>{control?.currentRecoveryEvidenceExpiresAt ? `Expires ${formatOperationalDateTime(control.currentRecoveryEvidenceExpiresAt)}` : 'Isolated recovery evidence has not been verified.'}</small></div>
            </article>
            <article>
              {readiness?.prerequisitesSatisfied ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
              <div><span>Canary prerequisites</span><strong>{readiness?.prerequisitesSatisfied ? 'Satisfied' : 'Not ready'}</strong><small>{readiness?.eligibleEmployeeCount ?? 0} employees currently meet record-level requirements.</small></div>
            </article>
          </section>

          <section className="hris-readiness-workspace">
            <div className="hris-readiness-workspace__heading">
              <div><p className="eyebrow">Controlled reconciliation</p><h2>Maintain employment dates</h2><p>Search legal names or employee numbers. Date corrections update the same permanent, audited record used by the Employee File.</p></div>
              <span>{workspace.totalCount} matching</span>
            </div>

            <div className="hris-readiness-filters">
              <form onSubmit={handleSearch}>
                <label htmlFor="hris-readiness-search">Employee search</label>
                <div><Search aria-hidden="true" size={18} /><input id="hris-readiness-search" onChange={(event) => setSearchInput(event.target.value)} placeholder="Legal name or employee number" value={searchInput} /></div>
                <button className="secondary-button" type="submit">Search</button>
              </form>
              <label>Status<select onChange={(event) => { setStatus(event.target.value); setPage(1) }} value={status}><option value="all">All statuses</option><option value="onboarding">Onboarding</option><option value="active">Active</option><option value="leave">Leave</option><option value="inactive">Inactive</option><option value="separated">Separated</option></select></label>
              <label>Rows<select onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} value={pageSize}><option value={5}>5</option><option value={10}>10</option></select></label>
            </div>

            <div className="hris-readiness-list">
              {workspace.items.length === 0 ? <DataStatePanel icon={Search} title="No employees match these filters"><p>Clear the search or choose another employment status.</p></DataStatePanel> : workspace.items.map((employee) => (
                <article className="hris-readiness-row" key={employee.employeeId}>
                  <div className="hris-readiness-row__identity"><UserRoundCheck aria-hidden="true" /><div><strong>{employee.legalName}</strong><span>{employee.employeeNumber || 'Employee number missing'} · {employee.status}</span></div></div>
                  <dl>
                    <div><dt>Hire date</dt><dd>{formatDate(employee.effectiveHiredOn)}</dd></div>
                    <div><dt>Separation date</dt><dd>{formatDate(employee.effectiveSeparatedOn)}</dd></div>
                    <div><dt>Mapping</dt><dd>{mappingLabels[employee.mappingState]}</dd></div>
                  </dl>
                  <div className="hris-readiness-row__signals">
                    {employee.blockerCodes.map((code) => <span className="signal signal--blocked" key={code}>{blockerLabel(code)}</span>)}
                    {employee.warningCodes.map((code) => <span className="signal" key={code}>{warningLabel(code)}</span>)}
                    {employee.blockerCodes.length === 0 && employee.warningCodes.length === 0 ? <span className="signal signal--ready">Record ready</span> : null}
                  </div>
                  <button className="secondary-button" onClick={() => { setResultMessage(null); setSelectedEmployee(employee) }} type="button">Edit employment dates</button>
                </article>
              ))}
            </div>

            <div className="communications-pagination">
              <button className="secondary-button" disabled={workspace.page <= 1} onClick={() => setPage((current) => Math.max(current - 1, 1))} type="button">Previous</button>
              <span>Page {workspace.page} of {workspace.totalPages}</span>
              <button className="secondary-button" disabled={workspace.page >= workspace.totalPages} onClick={() => setPage((current) => Math.min(current + 1, workspace.totalPages))} type="button">Next</button>
            </div>
          </section>

          <details className="hris-readiness-preservation">
            <summary>Protected record preservation check</summary>
            <p>These counts are observed for release validation. This workspace cannot edit them.</p>
            <div>{Object.entries(workspace.preservation).map(([key, value]) => <span key={key}><strong>{value}</strong>{key.replace(/([A-Z])/g, ' $1')}</span>)}</div>
          </details>
        </>
      ) : null}

      {selectedEmployee ? (
        <EmploymentDateEditorDialog
          employee={{
            employeeId: selectedEmployee.employeeId,
            hiredOn: selectedEmployee.permanentHiredOn ?? selectedEmployee.effectiveHiredOn,
            legalName: selectedEmployee.legalName,
            separatedOn: selectedEmployee.permanentSeparatedOn ?? selectedEmployee.effectiveSeparatedOn,
            status: selectedEmployee.status,
          }}
          onClose={() => setSelectedEmployee(null)}
          onSaved={() => setResultMessage('Employment dates and audit history were updated successfully.')}
          sourceType="verified_hr_record"
        />
      ) : null}
    </main>
  )
}

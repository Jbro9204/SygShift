import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, CalendarDays, Download, Search, ShieldAlert, UsersRound } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  authorizeScheduledOvertimeForecastExport,
  getScheduledOvertimeForecast,
  type ScheduledOvertimeEmployee,
} from '../data/scheduledOvertimeForecast'
import { isSupabaseConfigured } from '../lib/supabase'
import { downloadScheduledOvertimeForecastWorkbook } from './scheduledOvertimeForecastWorkbook'

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function upcomingSunday(): string {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + (7 - date.getDay()))
  return isoDate(date)
}

function sundayFor(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  if (Number.isNaN(date.valueOf())) return upcomingSunday()
  date.setDate(date.getDate() - date.getDay())
  return isoDate(date)
}

function dateLabel(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(year, month - 1, day, 12))
}

function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(2)} hrs`
}

function shiftTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function EmployeeDetails({ employee, onClose }: { employee: ScheduledOvertimeEmployee; onClose: () => void }) {
  return <ModalDialog className="reports-detail-modal reports-overtime-modal" description="Read-only schedule detail. Adjust assignments in Schedule and preserve any required overtime approval note." onClose={onClose} title={employee.employeeName}>
    <div className="reports-detail-grid">
      <div><span>Employee ID</span><strong>{employee.employeeNumber ?? 'Not recorded'}</strong></div>
      <div><span>Scheduled</span><strong>{hours(employee.scheduledMinutes)}</strong></div>
      <div><span>Projected overtime</span><strong>{hours(employee.overtimeMinutes)}</strong></div>
      <div><span>Coverage</span><strong>{hours(employee.armedMinutes)} armed · {hours(employee.unarmedMinutes)} unarmed</strong></div>
      <div><span>Assignments</span><strong>{employee.shiftCount} standard shifts</strong></div>
      <div><span>Approval note</span><strong>{employee.approvalNotes ?? 'No scheduled-overtime approval note recorded'}</strong></div>
    </div>
    <section className="reports-overtime-shifts">
      <div><h3>Assignments creating the weekly total</h3><span>Dispatch phone duty is not included.</span></div>
      <div className="reports-overtime-shift-list">{employee.shifts.map((shift) => <article key={shift.shiftId}>
        <div><strong>{shift.sitePost}</strong><span>{shift.requiresArmed ? 'Armed coverage' : 'Unarmed coverage'}</span></div>
        <dl><div><dt>Starts</dt><dd>{shiftTime(shift.startsAt, shift.timeZone)}</dd></div><div><dt>Ends</dt><dd>{shiftTime(shift.endsAt, shift.timeZone)}</dd></div><div><dt>Hours</dt><dd>{hours(shift.scheduledMinutes)}</dd></div></dl>
        {shift.approvalNote ? <p><strong>Approval:</strong> {shift.approvalNote}</p> : null}
      </article>)}</div>
    </section>
    <div className="modal-actions"><Link className="primary-action" to="/schedule">Open Schedule</Link><button className="secondary-button" onClick={onClose} type="button">Close</button></div>
  </ModalDialog>
}

export function ScheduledOvertimeForecastWorkspace({ canExport }: { canExport: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedEmployee, setSelectedEmployee] = useState<ScheduledOvertimeEmployee | null>(null)
  const weekStartsOn = sundayFor(searchParams.get('week') ?? upcomingSunday())
  const search = searchParams.get('search') ?? ''
  const coverage = searchParams.get('coverage') === 'armed' ? 'armed' : 'all'

  const updateParameters = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (!value) next.delete(key)
      else next.set(key, value)
    }
    setSearchParams(next)
  }

  const forecastQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: () => getScheduledOvertimeForecast(weekStartsOn),
    queryKey: ['scheduled-overtime-forecast', weekStartsOn],
  })

  const visibleEmployees = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return (forecastQuery.data?.employees ?? []).filter((employee) => {
      if (coverage === 'armed' && employee.armedMinutes === 0) return false
      if (!needle) return true
      return [employee.employeeName, employee.employeeNumber, employee.jobTitle, employee.sites, employee.approvalNotes]
        .some((value) => value?.toLocaleLowerCase().includes(needle))
    })
  }, [coverage, forecastQuery.data?.employees, search])

  const exportMutation = useMutation({
    mutationFn: async () => {
      const forecast = forecastQuery.data
      if (!forecast?.schedule) throw new Error('A schedule revision is required before this report can be exported.')
      const authorization = await authorizeScheduledOvertimeForecastExport({
        employeeCount: forecast.employees.length,
        scheduleId: forecast.schedule.id,
        weekStartsOn: forecast.weekStartsOn,
      })
      return downloadScheduledOvertimeForecastWorkbook(forecast, authorization.authorizedAt)
    },
  })

  if (!isSupabaseConfigured) return <DataStatePanel icon={ShieldAlert} title="Scheduled overtime needs the secure connection" tone="setup"><p>The report becomes available after the protected data connection is restored.</p></DataStatePanel>
  if (forecastQuery.isPending) return <DataStatePanel icon={CalendarDays} title="Loading scheduled overtime"><p>Calculating the selected schedule week from current assignments.</p></DataStatePanel>
  if (forecastQuery.isError) return <DataStatePanel icon={ShieldAlert} title="Scheduled overtime report unavailable" tone="error"><p>{forecastQuery.error.message}</p><p>Time reporting access and verified MFA are required.</p></DataStatePanel>

  const forecast = forecastQuery.data
  const sourceLabel = forecast.schedule
    ? `${forecast.schedule.status[0].toUpperCase()}${forecast.schedule.status.slice(1)} schedule · Revision ${forecast.schedule.revision}`
    : 'No schedule revision found'

  return <>
    <section className="operations-panel reports-workspace-heading reports-overtime-heading">
      <div className="reports-overtime-heading__main">
        <Link className="reports-overtime-back-link" to="/reports"><ArrowLeft aria-hidden="true" size={17} />Back to report library</Link>
        <div className="reports-overtime-heading__copy"><p className="eyebrow">Workforce planning</p><h1>Scheduled Overtime Forecast</h1><p>See who is scheduled above 40 hours before the week begins, what assignments create the total, and where armed Flex capacity may exist.</p></div>
      </div>
      {canExport ? <button className="primary-action" disabled={exportMutation.isPending || !forecast.schedule} onClick={() => exportMutation.mutate()} type="button"><Download aria-hidden="true" size={18} />{exportMutation.isPending ? 'Preparing workbook...' : 'Download Excel report'}</button> : null}
    </section>

    <section className="operations-panel reports-workspace-controls reports-overtime-controls" aria-label="Scheduled overtime forecast controls">
      <div className="reports-overtime-filter-grid">
        <label className="reports-overtime-week"><span>Schedule week</span><input onChange={(event) => updateParameters({ week: sundayFor(event.target.value) })} type="date" value={weekStartsOn} /></label>
        <label className="reports-search"><span>Search</span><span className="reports-search-input"><Search aria-hidden="true" size={19} /><input onChange={(event) => updateParameters({ search: event.target.value || null })} placeholder="Employee, ID, title, site, or approval note" type="search" value={search} /></span></label>
        <label><span>Coverage</span><select onChange={(event) => updateParameters({ coverage: event.target.value === 'armed' ? 'armed' : null })} value={coverage}><option value="all">All projected overtime</option><option value="armed">Includes armed coverage</option></select></label>
      </div>
      <div className="reports-overtime-schedule-context" aria-label="Selected schedule revision"><CalendarDays aria-hidden="true" size={19} /><div><strong>{dateLabel(forecast.weekStartsOn)} through {dateLabel(forecast.weekEndsOn)}</strong><span>{sourceLabel}</span></div></div>
      <div className="reports-export-note"><ShieldAlert aria-hidden="true" size={18} /><span>Forecast uses assigned standard shifts. Supplemental Dispatch phone duty is excluded, and actual payroll overtime can change with worked time and corrections.</span></div>
      {!canExport ? <div className="reports-export-note"><ShieldAlert aria-hidden="true" size={18} /><span>You can view this report. Downloading requires the protected Report Export permission.</span></div> : null}
      {exportMutation.isSuccess ? <div className="form-feedback form-feedback--success" role="status">Downloaded {exportMutation.data.fileName}.</div> : null}
      {exportMutation.isError ? <div className="inline-alert" role="alert">{exportMutation.error.message}</div> : null}
    </section>

    <section className="operations-metrics reports-metric-grid reports-overtime-metrics" aria-label="Scheduled overtime summary">
      <article><span>Projected overtime</span><strong>{forecast.summary.overtimeEmployees}</strong><small>Employees above 40 scheduled hours</small></article>
      <article><span>Armed overtime</span><strong>{forecast.summary.armedOvertimeEmployees}</strong><small>Overtime employees with armed coverage</small></article>
      <article><span>Total projected OT</span><strong>{hours(forecast.summary.totalOvertimeMinutes)}</strong><small>Across the selected schedule revision</small></article>
      <article><span>Armed Flex capacity</span><strong>{forecast.armedFlexCandidates.length}</strong><small>Candidates requiring availability review</small></article>
    </section>

    <section className="operations-panel reports-results" aria-live="polite">
      <div className="reports-section-heading"><div><p className="eyebrow">Projected overtime</p><h2>{visibleEmployees.length} employees shown</h2><p>Ordered by the greatest projected overtime first.</p></div><Link className="secondary-button reports-canonical-link" to="/schedule">Open Schedule</Link></div>
      {!forecast.schedule ? <div className="report-empty">No draft or published schedule exists for this week.</div> : null}
      {forecast.schedule && visibleEmployees.length === 0 ? <div className="report-empty">No employees are projected above 40 scheduled hours with these filters.</div> : null}
      {visibleEmployees.length ? <div className="reports-result-list">{visibleEmployees.map((employee) => <article className="reports-result-card reports-overtime-result" key={employee.employeeId}>
        <dl className="reports-result-summary reports-overtime-summary">
          <div><dt>Employee</dt><dd>{employee.employeeName}<small>{employee.employeeNumber ?? 'ID not recorded'} · {employee.jobTitle ?? 'Title not recorded'}</small></dd></div>
          <div><dt>Scheduled</dt><dd>{hours(employee.scheduledMinutes)}<small>{employee.shiftCount} standard assignments</small></dd></div>
          <div><dt>Projected overtime</dt><dd className="reports-overtime-value">{hours(employee.overtimeMinutes)}<small>Above the 40-hour threshold</small></dd></div>
          <div><dt>Coverage</dt><dd>{hours(employee.armedMinutes)} armed<small>{hours(employee.unarmedMinutes)} unarmed</small></dd></div>
          <div><dt>Sites / Posts</dt><dd>{employee.sites}<small>{employee.approvalNotes ?? 'No overtime approval note recorded'}</small></dd></div>
        </dl>
        <button className="secondary-button" onClick={() => setSelectedEmployee(employee)} type="button">View shifts</button>
      </article>)}</div> : null}
    </section>

    <section className="operations-panel reports-overtime-candidates" aria-labelledby="armed-flex-candidates-title">
      <div className="reports-section-heading"><div><p className="eyebrow">Planning aid</p><h2 id="armed-flex-candidates-title">Armed Flex capacity candidates</h2><p>These active Flex employees have an armed credential valid through the week and remain under 40 scheduled hours. This does not confirm availability.</p></div><UsersRound aria-hidden="true" size={28} /></div>
      {forecast.armedFlexCandidates.length === 0 ? <div className="report-empty">No armed-qualified Flex employees currently have capacity below 40 scheduled hours.</div> : <div className="reports-overtime-candidate-grid">{forecast.armedFlexCandidates.map((candidate) => <article key={candidate.employeeId}><div><strong>{candidate.employeeName}</strong><span>{candidate.employeeNumber ?? 'ID not recorded'} · {candidate.jobTitle ?? 'Title not recorded'}</span></div><dl><div><dt>Scheduled</dt><dd>{hours(candidate.scheduledMinutes)}</dd></div><div><dt>Before overtime</dt><dd>{hours(candidate.remainingMinutesBeforeOvertime)}</dd></div></dl><p>Verify availability before assigning.</p></article>)}</div>}
    </section>

    {selectedEmployee ? <EmployeeDetails employee={selectedEmployee} onClose={() => setSelectedEmployee(null)} /> : null}
  </>
}

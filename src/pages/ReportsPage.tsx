import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DatabaseZap, FileBarChart, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getOperationsReport } from '../data/operations'
import { getTimekeepingOperationsReports, type TimeOperationsReports } from '../data/timeOperations'
import { isSupabaseConfigured } from '../lib/supabase'

function number(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function displayValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return number(value)
  if (Array.isArray(value)) return value.map(displayValue).join(', ') || '—'
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Denver',
    }).format(new Date(text))
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-')
    return `${month}/${day}/${year}`
  }
  return text.replaceAll('_', ' ')
}

type ReportKey = Exclude<keyof TimeOperationsReports, 'generatedAt' | 'fromDate' | 'throughDate'>

const reportDefinitions: Array<{ key: ReportKey; label: string; description: string }> = [
  { key: 'timekeepingExceptions', label: 'Timekeeping Exceptions', description: 'Missing punches, automatic clock-outs, status, and resolution.' },
  { key: 'automaticClockOuts', label: 'Automatic Clock-Outs', description: 'Scheduled endings, automatic punches, and employee correction status.' },
  { key: 'manualTimeEntryAudit', label: 'Manual Time Entry Audit', description: 'Before-and-after values, reasons, actors, and timestamps.' },
  { key: 'timeAdjustmentRequests', label: 'Time-Adjustment Requests', description: 'Requested changes, review decisions, and processing time.' },
  { key: 'attendanceCallOffs', label: 'Attendance & Call-Offs', description: 'Sick reports, call-offs, replacement needs, and locations.' },
  { key: 'scheduledVsActual', label: 'Scheduled vs. Actual', description: 'Scheduled hours, worked hours, variances, and payroll readiness.' },
  { key: 'coverageUnfilled', label: 'Coverage & Unfilled Shifts', description: 'Open coverage, call-offs, and time remaining before shift start.' },
  { key: 'overtimePayrollRisk', label: 'Overtime & Payroll Risk', description: 'Overtime exposure and unresolved payroll readiness issues.' },
]

const columnLabels: Record<string, string> = {
  employeeName: 'Employee', sitePost: 'Site / Post', workDate: 'Work Date', operationalDate: 'Work Date',
  scheduledStartAt: 'Scheduled Start', scheduledEndAt: 'Scheduled End', startsAt: 'Starts', endsAt: 'Ends',
  automaticClockOutAt: 'Automatic Clock-Out', exceptionCode: 'Exception', resolutionMethod: 'Resolution',
  resolutionNote: 'Resolution Note', resolvedBy: 'Resolved By', resolvedAt: 'Resolved At', detectedAt: 'Detected At',
  issueType: 'Issue', requestedClockInAt: 'Requested Clock-In', requestedClockOutAt: 'Requested Clock-Out',
  decisionNote: 'Decision Note', submittedAt: 'Submitted', reviewedAt: 'Reviewed', processingMinutes: 'Processing Minutes',
  callOffType: 'Call-Off Type', replacementNeeded: 'Replacement Needed', reportedAt: 'Reported', canceledAt: 'Canceled',
  headcountRequired: 'Needed', assignedCount: 'Assigned', openCount: 'Open', callOffCount: 'Call-Offs',
  timeOpenMinutes: 'Minutes Open', scheduledMinutes: 'Scheduled Minutes', workedMinutes: 'Worked Minutes',
  overtimeMinutes: 'Overtime Minutes', payrollReady: 'Payroll Ready', shiftNotes: 'Shift Notes', warningCodes: 'Warnings',
  approvalStatus: 'Approval', createdAt: 'Created', beforeValues: 'Previous Values', afterValues: 'Updated Values',
}

function readableColumn(key: string): string {
  return columnLabels[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())
}

function OperationalReportTable({ rows, title }: { rows: Array<Record<string, unknown>>; title: string }) {
  const columns = useMemo(() => {
    const ordered: string[] = []
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key !== 'id' && key !== 'employeeId' && key !== 'shiftId' && !ordered.includes(key)) ordered.push(key)
      }
    }
    return ordered
  }, [rows])

  if (rows.length === 0) return <div className="report-empty">No records matched this report and date range.</div>

  return (
    <div className="operational-report-table" role="region" aria-label={`${title} results`} tabIndex={0}>
      <table>
        <thead><tr>{columns.map((column) => <th key={column} scope="col">{readableColumn(column)}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={String(row.id ?? rowIndex)}>{columns.map((column) => <td key={column}>{displayValue(row[column])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export function ReportsPage() {
  const today = new Date()
  const initialFrom = new Date(today)
  initialFrom.setDate(today.getDate() - 13)
  const [fromDate, setFromDate] = useState(isoDate(initialFrom))
  const [throughDate, setThroughDate] = useState(isoDate(today))
  const [activeReport, setActiveReport] = useState<ReportKey>('timekeepingExceptions')
  const [reportFilter, setReportFilter] = useState('')
  const reportQuery = useQuery({ queryKey: ['operations-report'], queryFn: getOperationsReport, enabled: isSupabaseConfigured })
  const timeReportsQuery = useQuery({
    queryKey: ['timekeeping-operations-reports', fromDate, throughDate],
    queryFn: () => getTimekeepingOperationsReports(fromDate, throughDate),
    enabled: isSupabaseConfigured && Boolean(fromDate && throughDate && throughDate >= fromDate),
  })
  const activeDefinition = reportDefinitions.find((report) => report.key === activeReport) ?? reportDefinitions[0]
  const filteredRows = useMemo(() => {
    const rows = timeReportsQuery.data?.[activeReport] ?? []
    const needle = reportFilter.trim().toLocaleLowerCase()
    if (!needle) return rows
    return rows.filter((row) => Object.values(row).some((value) => displayValue(value).toLocaleLowerCase().includes(needle)))
  }, [activeReport, reportFilter, timeReportsQuery.data])

  return (
    <div className="page page--reports">
      <section className="page-intro"><div><p className="eyebrow">Operations</p><h1>Reports</h1><p className="page-summary">Schedule, workforce, timekeeping, attendance, coverage, and payroll-risk reporting in one controlled workspace.</p></div></section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Reports need the secure connection" tone="setup"><p>Operational reports appear after Supabase is connected.</p></DataStatePanel>
      ) : reportQuery.isPending ? (
        <DataStatePanel icon={FileBarChart} title="Loading reports"><p>Gathering schedule, request, notification, and payroll totals.</p></DataStatePanel>
      ) : reportQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Reports unavailable" tone="error"><p>{reportQuery.error.message}</p><p>Authorized report access is required.</p></DataStatePanel>
      ) : (
        <>
          <section className="operations-metrics" aria-label="Operational report totals">
            <article><span>Published weeks</span><strong>{number(reportQuery.data.schedule.weeks)}</strong><small>{number(reportQuery.data.schedule.shifts)} shifts</small></article>
            <article><span>Assigned slots</span><strong>{number(reportQuery.data.schedule.assignedSlots)}</strong><small>{number(reportQuery.data.schedule.openShifts)} open shifts</small></article>
            <article className={reportQuery.data.schedule.reviewNeeded ? 'import-metric--attention' : ''}><span>Review needed</span><strong>{number(reportQuery.data.schedule.reviewNeeded)}</strong><small>Schedule cleanup</small></article>
            <article><span>Active employees</span><strong>{number(reportQuery.data.people.active)}</strong><small>{number(reportQuery.data.people.hourly)} hourly · {number(reportQuery.data.people.salary)} salary</small></article>
          </section>

          <section className="operations-panel time-report-workspace" aria-labelledby="time-report-heading">
            <div className="time-report-workspace__heading">
              <div><p className="eyebrow">Timekeeping & Attendance</p><h2 id="time-report-heading">Operational reports</h2><p>Choose a report and date range. Access is enforced by the report permission on the server.</p></div>
              <div className="time-report-range"><label><span>From</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label><label><span>Through</span><input type="date" value={throughDate} onChange={(event) => setThroughDate(event.target.value)} /></label></div>
            </div>
            <div className="time-report-tabs" role="tablist" aria-label="Timekeeping reports">
              {reportDefinitions.map((report) => <button aria-selected={activeReport === report.key} className={activeReport === report.key ? 'time-report-tab time-report-tab--active' : 'time-report-tab'} key={report.key} onClick={() => { setActiveReport(report.key); setReportFilter('') }} role="tab" type="button">{report.label}</button>)}
            </div>
            <div className="time-report-result" role="tabpanel">
              <div className="time-report-result__heading"><div><h3>{activeDefinition.label}</h3><p>{activeDefinition.description}</p></div><label className="time-report-filter"><span>Filter this report</span><input onChange={(event) => setReportFilter(event.target.value)} placeholder="Employee, site, status, reviewer…" type="search" value={reportFilter} /></label></div>
              {timeReportsQuery.isPending ? <div className="report-empty">Loading report…</div> : timeReportsQuery.isError ? <div className="shell-alert" role="alert">{timeReportsQuery.error.message}</div> : <OperationalReportTable rows={filteredRows} title={activeDefinition.label} />}
            </div>
          </section>

          <section className="operations-grid">
            <article className="operations-panel"><p className="eyebrow">Workforce</p><h2>Employee mix</h2><dl className="report-list"><div><dt>Guards</dt><dd>{number(reportQuery.data.people.guards)}</dd></div><div><dt>Supervisors</dt><dd>{number(reportQuery.data.people.supervisors)}</dd></div><div><dt>Admins</dt><dd>{number(reportQuery.data.people.admins)}</dd></div></dl></article>
            <article className="operations-panel"><p className="eyebrow">Coverage</p><h2>Sites and posts</h2><dl className="report-list"><div><dt>Active sites</dt><dd>{number(reportQuery.data.sites.activeSites)}</dd></div><div><dt>Active posts</dt><dd>{number(reportQuery.data.posts.activePosts)}</dd></div><div><dt>Armed open shifts</dt><dd>{number(reportQuery.data.schedule.armedOpenShifts)}</dd></div></dl></article>
            <article className="operations-panel"><p className="eyebrow">Requests</p><h2>Action queue</h2><dl className="report-list"><div><dt>Time off pending</dt><dd>{number(reportQuery.data.requests.timeOffPending)}</dd></div><div><dt>Shift requests pending</dt><dd>{number(reportQuery.data.requests.shiftPending)}</dd></div><div><dt>Open call-offs</dt><dd>{number(reportQuery.data.requests.callOffsOpen)}</dd></div></dl></article>
            <article className="operations-panel"><p className="eyebrow">Timekeeping</p><h2>Payroll posture</h2><dl className="report-list"><div><dt>Time events</dt><dd>{number(reportQuery.data.timekeeping.timeEvents)}</dd></div><div><dt>Pending corrections</dt><dd>{number(reportQuery.data.timekeeping.pendingCorrections)}</dd></div><div><dt>Locked payroll batches</dt><dd>{number(reportQuery.data.timekeeping.lockedPayrollBatches)}</dd></div></dl></article>
          </section>
        </>
      )}
    </div>
  )
}

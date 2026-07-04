import { useQuery } from '@tanstack/react-query'
import { DatabaseZap, FileBarChart, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getOperationsReport } from '../data/operations'
import { isSupabaseConfigured } from '../lib/supabase'

function number(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function ReportsPage() {
  const reportQuery = useQuery({
    queryKey: ['operations-report'],
    queryFn: getOperationsReport,
    enabled: isSupabaseConfigured,
  })

  return (
    <div className="page page--reports">
      <section className="page-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Reports</h1>
          <p className="page-summary">
            A plain-language command view of schedule coverage, workforce records, requests,
            notifications, timekeeping, and payroll export readiness.
          </p>
        </div>
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Reports need the secure connection" tone="setup">
          <p>Operational reports appear after Supabase is connected.</p>
        </DataStatePanel>
      ) : reportQuery.isPending ? (
        <DataStatePanel icon={FileBarChart} title="Loading reports">
          <p>Gathering schedule, request, notification, and payroll totals.</p>
        </DataStatePanel>
      ) : reportQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Reports unavailable" tone="error">
          <p>{reportQuery.error.message}</p>
          <p>Supervisor or Admin access is required.</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="operations-metrics" aria-label="Operational report totals">
            <article><span>Published weeks</span><strong>{number(reportQuery.data.schedule.weeks)}</strong><small>{number(reportQuery.data.schedule.shifts)} shifts</small></article>
            <article><span>Assigned slots</span><strong>{number(reportQuery.data.schedule.assignedSlots)}</strong><small>{number(reportQuery.data.schedule.openShifts)} open shifts</small></article>
            <article className={reportQuery.data.schedule.reviewNeeded ? 'import-metric--attention' : ''}><span>Review needed</span><strong>{number(reportQuery.data.schedule.reviewNeeded)}</strong><small>Imported schedule cleanup</small></article>
            <article><span>Employees</span><strong>{number(reportQuery.data.people.total)}</strong><small>{number(reportQuery.data.people.active)} active</small></article>
          </section>

          <section className="operations-grid">
            <article className="operations-panel">
              <p className="eyebrow">Workforce</p>
              <h2>Employee mix</h2>
              <dl className="report-list">
                <div><dt>Guards</dt><dd>{number(reportQuery.data.people.guards)}</dd></div>
                <div><dt>Supervisors</dt><dd>{number(reportQuery.data.people.supervisors)}</dd></div>
                <div><dt>Admins</dt><dd>{number(reportQuery.data.people.admins)}</dd></div>
                <div><dt>Hourly</dt><dd>{number(reportQuery.data.people.hourly)}</dd></div>
                <div><dt>Salary</dt><dd>{number(reportQuery.data.people.salary)}</dd></div>
              </dl>
              <p className="report-note">
                Salary employees are identified separately. SygShift does not silently add 40 hours to payroll;
                salary time is shown through actual punches/schedule records unless a dedicated salary rule is approved.
              </p>
            </article>

            <article className="operations-panel">
              <p className="eyebrow">Coverage</p>
              <h2>Sites and posts</h2>
              <dl className="report-list">
                <div><dt>Active sites</dt><dd>{number(reportQuery.data.sites.activeSites)}</dd></div>
                <div><dt>Total sites</dt><dd>{number(reportQuery.data.sites.totalSites)}</dd></div>
                <div><dt>Active posts</dt><dd>{number(reportQuery.data.posts.activePosts)}</dd></div>
                <div><dt>Armed open shifts</dt><dd>{number(reportQuery.data.schedule.armedOpenShifts)}</dd></div>
              </dl>
            </article>

            <article className="operations-panel">
              <p className="eyebrow">Requests</p>
              <h2>Action queue</h2>
              <dl className="report-list">
                <div><dt>Time off pending</dt><dd>{number(reportQuery.data.requests.timeOffPending)}</dd></div>
                <div><dt>Shift requests pending</dt><dd>{number(reportQuery.data.requests.shiftPending)}</dd></div>
                <div><dt>Open call-offs</dt><dd>{number(reportQuery.data.requests.callOffsOpen)}</dd></div>
              </dl>
            </article>

            <article className="operations-panel">
              <p className="eyebrow">Timekeeping</p>
              <h2>Payroll posture</h2>
              <dl className="report-list">
                <div><dt>Time events</dt><dd>{number(reportQuery.data.timekeeping.timeEvents)}</dd></div>
                <div><dt>Pending corrections</dt><dd>{number(reportQuery.data.timekeeping.pendingCorrections)}</dd></div>
                <div><dt>Locked payroll batches</dt><dd>{number(reportQuery.data.timekeeping.lockedPayrollBatches)}</dd></div>
              </dl>
            </article>
          </section>

          <section className="operations-panel" aria-labelledby="published-week-report-title">
            <p className="eyebrow">Master schedule</p>
            <h2 id="published-week-report-title">Published schedule weeks</h2>
            <div className="report-table" role="table" aria-label="Published schedule weeks">
              <div role="row">
                <span role="columnheader">Week</span>
                <span role="columnheader">Revision</span>
                <span role="columnheader">Shifts</span>
                <span role="columnheader">Assigned</span>
                <span role="columnheader">Open</span>
              </div>
              {reportQuery.data.publishedWeeks.map((week) => (
                <div role="row" key={week.weekStartsOn}>
                  <span role="cell">{week.weekStartsOn}</span>
                  <span role="cell">{week.revision}</span>
                  <span role="cell">{number(week.shifts)}</span>
                  <span role="cell">{number(week.assignedSlots)}</span>
                  <span role="cell">{number(week.openShifts)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock3, Coffee, MapPin, RefreshCw, Search, ShieldAlert, Timer, UsersRound } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import { getLiveTimeRoster } from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import { canViewTeamTime } from './timePermissions'
import { TimeButton, TimeMetricCard, TimePageHeader, TimeSectionHeader, TimeStatusBadge } from './TimeKit'

type LiveRosterFilter = 'all' | 'working' | 'on_break'

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours === 0) return `${remainingMinutes} min`
  return `${hours} hr ${remainingMinutes} min`
}

export function TimeOnDutyPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<LiveRosterFilter>('all')
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const allowed = canViewTeamTime(sessionQuery.data)
  const rosterQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && allowed,
    queryFn: getLiveTimeRoster,
    queryKey: ['live-time-roster'],
    refetchInterval: 15_000,
  })
  const filteredRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (rosterQuery.data?.rows ?? []).filter((row) => {
      if (status !== 'all' && row.status !== status) return false
      if (!term) return true
      return [row.employeeName, row.username, row.locationName, row.siteName, row.siteCode, row.postName]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(term))
    })
  }, [rosterQuery.data?.rows, search, status])
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visibleRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize)

  useEffect(() => setPage(1), [pageSize, search, status])

  if (!isSupabaseConfigured) {
    return <main className="page page--sygshift-time"><TimePageHeader eyebrow="Live Time" summary="The secure database connection is required before the live roster can load." title="Currently Clocked In" /><DataStatePanel icon={ShieldAlert} tone="setup" title="Secure time data is not connected"><p>Connect Supabase before current clock status can be displayed.</p></DataStatePanel></main>
  }

  if (sessionQuery.isPending) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={Timer} title="Loading current roster"><p>Verifying access to current clock status.</p></DataStatePanel></main>
  }

  if (sessionQuery.isError || !allowed) {
    return <main className="page page--sygshift-time"><TimePageHeader eyebrow="Live Time" summary="Current clock status is controlled by Time permissions." title="Currently Clocked In" /><DataStatePanel icon={ShieldAlert} tone="error" title="Current roster is not available"><p>Your account needs team Time access with MFA.</p></DataStatePanel></main>
  }

  const roster = rosterQuery.data
  return (
    <main className="page page--sygshift-time">
      <TimePageHeader
        actions={<TimeButton icon={RefreshCw} loading={rosterQuery.isFetching} onClick={() => void rosterQuery.refetch()} variant="secondary">Refresh</TimeButton>}
        eyebrow="Live Time"
        summary="A focused, automatically refreshed roster of employees who have an open clock session right now."
        title="Currently Clocked In"
      />

      <section className="time-command-grid time-command-grid--live" aria-label="Current clock status summary">
        <TimeMetricCard detail="All employees with an open clock session." icon={UsersRound} label="On Clock" tone={roster?.totalCount ? 'good' : 'neutral'} value={roster?.totalCount ?? 0} />
        <TimeMetricCard detail="Employees actively working." icon={Timer} label="Working" tone={roster?.workingCount ? 'good' : 'neutral'} value={roster?.workingCount ?? 0} />
        <TimeMetricCard detail="Employees whose open session is on break." icon={Coffee} label="On Break" tone={roster?.breakCount ? 'warning' : 'neutral'} value={roster?.breakCount ?? 0} />
        <TimeMetricCard detail="The roster refreshes automatically every 15 seconds." icon={Clock3} label="Updated" value={roster ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(roster.serverTimestamp)) : '—'} />
      </section>

      <section className="time-card time-live-roster" aria-labelledby="live-roster-title">
        <TimeSectionHeader eyebrow="Current status only" summary="Historical punches, review queues, and payroll tools are intentionally kept out of this view." title="Employees on the clock" />
        <div className="time-live-roster__controls">
          <label className="time-team-search"><span>Find employee</span><span className="time-team-search__field"><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Name, username, or location" type="search" value={search} /></span></label>
          <label><span>Status</span><select onChange={(event) => setStatus(event.target.value as LiveRosterFilter)} value={status}><option value="all">Everyone on clock</option><option value="working">Working</option><option value="on_break">On break</option></select></label>
          <label><span>Rows</span><select onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}><option value={5}>5 per page</option><option value={10}>10 per page</option><option value={20}>20 per page</option></select></label>
        </div>

        {rosterQuery.isPending ? <DataStatePanel icon={Timer} title="Loading current clock status"><p>Checking the latest verified punch for each employee.</p></DataStatePanel> : null}
        {rosterQuery.isError ? <DataStatePanel icon={ShieldAlert} tone="error" title="Current roster unavailable"><p>{rosterQuery.error.message}</p></DataStatePanel> : null}
        {!rosterQuery.isPending && !rosterQuery.isError && filteredRows.length === 0 ? <DataStatePanel icon={Clock3} title="No employees match this live view"><p>{roster?.totalCount ? 'Change the search or status filter.' : 'No employees are currently clocked in.'}</p></DataStatePanel> : null}

        {visibleRows.length > 0 ? (
          <div className="time-live-list">
            {visibleRows.map((row) => (
              <article className="time-live-row" key={row.employeeId}>
                <div className="time-live-row__identity"><strong>{row.employeeName}</strong><span>@{row.username} · {row.role} · {row.employmentType}</span></div>
                <TimeStatusBadge tone={row.status === 'working' ? 'good' : 'warning'}>{row.status === 'working' ? 'Working' : 'On break'}</TimeStatusBadge>
                <div className="time-live-row__location"><MapPin aria-hidden="true" size={17} /><span><strong>{row.locationName}</strong><small>{row.assignedSupervisor ? `Supervisor: ${row.assignedSupervisor.name}` : 'Supervisor unassigned'}</small></span></div>
                <div className="time-live-row__time"><strong>{durationLabel(row.elapsedMinutes)}</strong><span>Clocked in {formatOperationalDateTime(row.clockedInAt, { includeTimeZoneName: true, timeZone: row.timeZone })}</span>{row.status === 'on_break' ? <small>Break started {formatOperationalDateTime(row.statusSince, { includeTimeZoneName: true, timeZone: row.timeZone })}</small> : null}</div>
              </article>
            ))}
          </div>
        ) : null}

        {filteredRows.length > pageSize ? <div className="directory-pagination"><span>Showing {(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, filteredRows.length)} of {filteredRows.length}</span><span>Page {safePage} of {pageCount}</span><div><TimeButton disabled={safePage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} variant="secondary">Previous</TimeButton><TimeButton disabled={safePage === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} variant="secondary">Next</TimeButton></div></div> : null}
      </section>
    </main>
  )
}

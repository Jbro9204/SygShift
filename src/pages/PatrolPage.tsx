import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DatabaseZap, MapPinned, Search, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getPatrolRoutes, patrolAssignmentLabel, patrolShiftTime } from '../data/patrol'
import { isSupabaseConfigured } from '../lib/supabase'

export function PatrolPage() {
  const [search, setSearch] = useState('')
  const patrolQuery = useQuery({
    queryKey: ['patrol-routes'],
    queryFn: getPatrolRoutes,
    enabled: isSupabaseConfigured,
  })
  const visibleRoutes = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return (patrolQuery.data ?? []).filter((route) => {
      const searchable = [
        route.name,
        route.code,
        ...route.upcomingShifts.map((shift) => `${shift.post?.name ?? ''} ${patrolAssignmentLabel(shift)}`),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
      return !term || searchable.includes(term)
    })
  }, [patrolQuery.data, search])
  const upcomingShiftCount = visibleRoutes.reduce((total, route) => total + route.upcomingShifts.length, 0)
  const openShiftCount = visibleRoutes.reduce(
    (total, route) => total + route.upcomingShifts.filter((shift) => shift.is_open).length,
    0,
  )

  return (
    <div className="page page--patrol">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Workforce</p>
          <h1>Patrol</h1>
          <p className="page-summary">
            Patrol coverage pulled from the published Bible schedule, focused on current and upcoming
            patrol-related shifts only.
          </p>
        </div>
        {patrolQuery.data ? (
          <div className="access-note">
            <MapPinned aria-hidden="true" size={19} />
            {upcomingShiftCount} upcoming patrol shift{upcomingShiftCount === 1 ? '' : 's'}
          </div>
        ) : null}
      </section>

      {!isSupabaseConfigured ? (
        <DataStatePanel icon={DatabaseZap} title="Patrol needs the secure schedule connection" tone="setup">
          <p>Published patrol coverage appears after Supabase authentication is connected.</p>
        </DataStatePanel>
      ) : patrolQuery.isPending ? (
        <DataStatePanel icon={MapPinned} title="Loading patrol coverage">
          <p>Checking the published schedule for patrol-related sites and posts.</p>
        </DataStatePanel>
      ) : patrolQuery.isError ? (
        <DataStatePanel icon={ShieldAlert} title="Patrol unavailable" tone="error">
          <p>{patrolQuery.error.message}</p>
        </DataStatePanel>
      ) : (
        <>
          <section className="operations-metrics" aria-label="Patrol totals">
            <article><span>Patrol routes</span><strong>{visibleRoutes.length}</strong><small>From published schedule</small></article>
            <article><span>Upcoming shifts</span><strong>{upcomingShiftCount}</strong><small>Current/future only</small></article>
            <article className={openShiftCount ? 'import-metric--attention' : ''}><span>Open patrol shifts</span><strong>{openShiftCount}</strong><small>Need coverage</small></article>
            <article><span>Armed routes</span><strong>{visibleRoutes.filter((route) => route.requiresArmed).length}</strong><small>Credential controlled</small></article>
          </section>

          <section className="workforce-toolbar workforce-toolbar--single" aria-label="Patrol controls">
            <label className="search-field search-field--wide">
              <Search aria-hidden="true" size={20} />
              <span className="visually-hidden">Search patrol</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search patrol route, site, guard, or post"
                type="search"
                value={search}
              />
            </label>
          </section>

          {visibleRoutes.length === 0 ? (
            <DataStatePanel icon={MapPinned} title="No patrol coverage matches this search">
              <p>Clear the search to see all upcoming patrol-related schedule records.</p>
            </DataStatePanel>
          ) : (
            <section className="patrol-grid" aria-label="Patrol route coverage">
              {visibleRoutes.map((route) => (
                <article className="patrol-card" key={route.id}>
                  <header>
                    <div>
                      <p className="eyebrow">{route.code || 'Patrol route'}</p>
                      <h2>{route.name}</h2>
                    </div>
                    {route.requiresArmed ? <span className="qualification qualification--armed">Armed</span> : <span className="qualification">Unarmed</span>}
                  </header>
                  <div className="patrol-shift-list">
                    {route.upcomingShifts.slice(0, 8).map((shift) => (
                      <div className="patrol-shift" key={shift.id}>
                        <div>
                          <strong>{patrolShiftTime(shift)}</strong>
                          <span>{shift.post?.name ?? 'Patrol coverage'} · {patrolAssignmentLabel(shift)}</span>
                        </div>
                        {shift.is_open ? <span className="shift-tag shift-tag--open">Open</span> : <span className="shift-tag shift-tag--covered">Covered</span>}
                      </div>
                    ))}
                  </div>
                  {route.upcomingShifts.length > 8 ? (
                    <p className="patrol-more">Showing next 8 of {route.upcomingShifts.length} upcoming patrol shifts.</p>
                  ) : null}
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}

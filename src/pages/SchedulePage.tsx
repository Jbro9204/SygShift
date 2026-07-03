import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { addDays, addWeeks, format, startOfWeek } from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight, DatabaseZap, MoveHorizontal, Search, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  assignmentName,
  getWeeklySchedule,
  scheduleRows,
  shiftOperationalDate,
  shiftTimeRange,
  type ScheduleShift,
} from '../data/schedule'
import { isSupabaseConfigured } from '../lib/supabase'
import { operationalToday } from '../lib/time'

function ShiftCard({ shift }: { shift: ScheduleShift }) {
  const title = shift.post?.name ?? shift.event?.name ?? 'Shift'
  const openSlots = Math.max(shift.headcount_required - shift.assignments.length, 0)

  return (
    <article className="shift-card">
      <div className="shift-card__heading">
        <strong>{shiftTimeRange(shift)}</strong>
        {shift.is_overtime ? <span className="shift-tag shift-tag--overtime">OT</span> : null}
      </div>
      <span className="shift-card__title">{title}</span>
      <div className="shift-card__people">
        {shift.assignments.length > 0
          ? shift.assignments.map((assignment) => (
              <span key={assignment.id}>{assignmentName(assignment)}</span>
            ))
          : <span className="shift-card__unassigned">No one assigned</span>}
      </div>
      <div className="shift-card__footer">
        {shift.requires_armed ? <span className="shift-tag shift-tag--armed">Armed</span> : null}
        {shift.is_open || openSlots > 0 ? (
          <span className="shift-tag shift-tag--open">
            {openSlots > 0 ? `${openSlots} open` : 'Open'}
          </span>
        ) : (
          <span className="shift-tag shift-tag--covered">Covered</span>
        )}
      </div>
    </article>
  )
}

export function SchedulePage() {
  const today = useMemo(() => operationalToday(), [])
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, { weekStartsOn: 0 }))
  const [search, setSearch] = useState('')
  const [siteFilter, setSiteFilter] = useState('all')
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart])
  const weekEnd = days[6]
  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const scheduleQuery = useQuery({
    queryKey: ['weekly-schedule', weekKey],
    queryFn: () => getWeeklySchedule(weekKey),
    enabled: isSupabaseConfigured,
  })
  const rows = useMemo(() => scheduleQuery.data ? scheduleRows(scheduleQuery.data) : [], [scheduleQuery.data])
  const visibleRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return rows
      .filter((row) => siteFilter === 'all' || row.id === siteFilter)
      .map((row) => ({
        ...row,
        shifts: row.shifts.filter((shift) => {
          if (!term) return true
          const searchable = [
            row.name,
            row.code,
            shift.post?.name,
            shift.event?.name,
            ...shift.assignments.map(assignmentName),
          ]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
          return searchable.includes(term)
        }),
      }))
      .filter((row) => row.shifts.length > 0)
  }, [rows, search, siteFilter])

  return (
    <div className="page page--schedule">
      <section className="page-intro schedule-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Master schedule</h1>
          <p className="page-summary">
            A readable weekly view for permanent sites, one-time events, patrol, and dispatch coverage.
          </p>
        </div>
      </section>

      <section className="schedule-toolbar" aria-label="Schedule controls">
        <div className="week-controls">
          <button
            aria-label="Previous week"
            className="icon-button"
            onClick={() => setWeekStart((current) => addWeeks(current, -1))}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={22} />
          </button>
          <button
            className="secondary-button"
            onClick={() => setWeekStart(startOfWeek(today, { weekStartsOn: 0 }))}
            type="button"
          >
            Today
          </button>
          <button
            aria-label="Next week"
            className="icon-button"
            onClick={() => setWeekStart((current) => addWeeks(current, 1))}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={22} />
          </button>
          <h2>
            {format(weekStart, 'MMM d')} – {format(weekEnd, 'MMM d, yyyy')}
          </h2>
        </div>

        <div className="schedule-filters">
          <label className="search-field">
            <Search aria-hidden="true" size={20} />
            <span className="visually-hidden">Search schedule</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search sites or people"
              type="search"
              value={search}
            />
          </label>
          <label>
            <span className="visually-hidden">Filter by site</span>
            <select
              aria-label="Filter by site"
              onChange={(event) => setSiteFilter(event.target.value)}
              value={siteFilter}
            >
              <option value="all">All sites</option>
              {rows.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}
            </select>
          </label>
        </div>
      </section>

      <p className="schedule-scroll-hint" id="schedule-scroll-instructions">
        <MoveHorizontal aria-hidden="true" size={19} />
        Scroll horizontally to see all seven days
      </p>

      <section
        aria-describedby="schedule-scroll-instructions"
        aria-labelledby="schedule-board-heading"
        className="schedule-board"
        tabIndex={0}
      >
        <h2 className="visually-hidden" id="schedule-board-heading">
          Weekly coverage
        </h2>
        <div className="schedule-grid" role="table" aria-label="Weekly master schedule">
          <div className="schedule-row schedule-row--header" role="row">
            <div className="schedule-site-column" role="columnheader">
              Site / post
            </div>
            {days.map((day) => (
              <div className="schedule-day-column" key={day.toISOString()} role="columnheader">
                <span>{format(day, 'EEE')}</span>
                <strong>{format(day, 'd')}</strong>
              </div>
            ))}
          </div>
          {!isSupabaseConfigured ? (
            <div className="schedule-empty" role="row">
              <div role="cell">
                <DatabaseZap aria-hidden="true" size={34} />
                <strong>Schedule ready for the secure connection.</strong>
                <p>
                  Coverage remains empty until the workbook import matches the protected source exactly.
                </p>
              </div>
            </div>
          ) : scheduleQuery.isPending ? (
            <div className="schedule-state" role="row">
              <div role="cell">
                <DataStatePanel icon={CalendarDays} title="Loading weekly coverage">
                  <p>Retrieving the latest schedule revision your account is permitted to view.</p>
                </DataStatePanel>
              </div>
            </div>
          ) : scheduleQuery.isError ? (
            <div className="schedule-state" role="row">
              <div role="cell">
                <DataStatePanel icon={ShieldAlert} title="Schedule unavailable" tone="error">
                  <p>{scheduleQuery.error.message}</p>
                </DataStatePanel>
              </div>
            </div>
          ) : !scheduleQuery.data ? (
            <div className="schedule-empty" role="row">
              <div role="cell">
                <CalendarDays aria-hidden="true" size={34} />
                <strong>No schedule exists for this week.</strong>
                <p>A supervisor can prepare a reviewed revision before publishing coverage.</p>
              </div>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="schedule-empty" role="row">
              <div role="cell">
                <Search aria-hidden="true" size={34} />
                <strong>No shifts match these filters.</strong>
                <p>Clear the search or select all sites to see the rest of the week.</p>
              </div>
            </div>
          ) : visibleRows.map((row) => (
            <div className="schedule-row schedule-row--coverage" role="row" key={row.id}>
              <div className="schedule-location" role="rowheader">
                <span>{row.code || (row.type === 'event' ? 'Event' : 'Site')}</span>
                <strong>{row.name}</strong>
              </div>
              {days.map((day) => {
                const dayKey = format(day, 'yyyy-MM-dd')
                const shifts = row.shifts.filter((shift) => shiftOperationalDate(shift) === dayKey)
                return (
                  <div className="schedule-day-cell" role="cell" key={dayKey}>
                    {shifts.map((shift) => <ShiftCard shift={shift} key={shift.id} />)}
                    {shifts.length === 0 ? <span className="schedule-day-empty">—</span> : null}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

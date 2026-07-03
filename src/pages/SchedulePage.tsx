import { useMemo, useState } from 'react'
import { addDays, addWeeks, format, startOfWeek } from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { operationalToday } from '../lib/time'

export function SchedulePage() {
  const today = useMemo(() => operationalToday(), [])
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, { weekStartsOn: 0 }))
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart])
  const weekEnd = days[6]

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
            <input placeholder="Search sites or people" type="search" />
          </label>
          <label>
            <span className="visually-hidden">Filter by site</span>
            <select aria-label="Filter by site" defaultValue="all">
              <option value="all">All sites</option>
            </select>
          </label>
        </div>
      </section>

      <section className="schedule-board" aria-labelledby="schedule-board-heading">
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
          <div className="schedule-empty" role="row">
            <div role="cell">
              <CalendarDays aria-hidden="true" size={34} />
              <strong>No coverage loaded for this week.</strong>
              <p>
                The schedule will remain empty until the workbook import matches the protected source exactly.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

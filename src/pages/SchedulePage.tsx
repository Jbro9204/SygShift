import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, addWeeks, format, startOfWeek } from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight, DatabaseZap, MoveHorizontal, Plus, Search, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { getCurrentAppRole } from '../data/session'
import {
  assignmentName,
  createSupervisorOpenShift,
  getScheduleBuilderOptions,
  getWeeklySchedule,
  scheduleRows,
  shiftOperationalDate,
  shiftTimeRange,
  type ScheduleShift,
} from '../data/schedule'
import { isSupabaseConfigured } from '../lib/supabase'
import { operationalToday } from '../lib/time'

interface OpenShiftFormState {
  mode: 'post' | 'event'
  postId: string
  eventName: string
  eventLocationName: string
  eventSiteId: string
  eventTimeZone: string
  eventRequiresArmed: boolean
  shiftDate: string
  startTime: string
  endTime: string
  headcount: string
  isOvertime: boolean
  notes: string
  publishAnnouncement: boolean
}

function defaultOpenShiftForm(weekKey: string): OpenShiftFormState {
  return {
    mode: 'post',
    postId: '',
    eventName: '',
    eventLocationName: '',
    eventSiteId: '',
    eventTimeZone: 'America/Denver',
    eventRequiresArmed: false,
    shiftDate: weekKey,
    startTime: '08:00',
    endTime: '16:00',
    headcount: '1',
    isOvertime: false,
    notes: '',
    publishAnnouncement: true,
  }
}

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
  const queryClient = useQueryClient()
  const today = useMemo(() => operationalToday(), [])
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, { weekStartsOn: 0 }))
  const [search, setSearch] = useState('')
  const [siteFilter, setSiteFilter] = useState('all')
  const [builderOpen, setBuilderOpen] = useState(false)
  const [builderMessage, setBuilderMessage] = useState<string | null>(null)
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart])
  const weekEnd = days[6]
  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const [openShiftForm, setOpenShiftForm] = useState<OpenShiftFormState>(() => defaultOpenShiftForm(weekKey))
  const scheduleQuery = useQuery({
    queryKey: ['weekly-schedule', weekKey],
    queryFn: () => getWeeklySchedule(weekKey),
    enabled: isSupabaseConfigured,
  })
  const roleQuery = useQuery({
    queryKey: ['current-app-role'],
    queryFn: getCurrentAppRole,
    enabled: isSupabaseConfigured,
  })
  const canBuildSchedule = roleQuery.data === 'supervisor' || roleQuery.data === 'admin'
  const builderOptionsQuery = useQuery({
    queryKey: ['schedule-builder-options'],
    queryFn: getScheduleBuilderOptions,
    enabled: isSupabaseConfigured && canBuildSchedule,
  })
  const availableSites = useMemo(() => {
    const sites = new Map<string, { id: string, name: string, time_zone: string }>()
    for (const post of builderOptionsQuery.data?.posts ?? []) {
      sites.set(post.site.id, {
        id: post.site.id,
        name: post.site.name,
        time_zone: post.site.time_zone,
      })
    }
    return [...sites.values()].sort((left, right) => left.name.localeCompare(right.name))
  }, [builderOptionsQuery.data?.posts])
  const selectedPost = builderOptionsQuery.data?.posts.find((post) => post.id === openShiftForm.postId)
  const createOpenShiftMutation = useMutation({
    mutationFn: () => createSupervisorOpenShift({
      weekStartsOn: weekKey,
      mode: openShiftForm.mode,
      postId: openShiftForm.postId || null,
      eventName: openShiftForm.eventName,
      eventLocationName: openShiftForm.eventLocationName,
      eventSiteId: openShiftForm.eventSiteId || null,
      eventTimeZone: openShiftForm.eventTimeZone,
      eventRequiresArmed: openShiftForm.eventRequiresArmed,
      shiftDate: openShiftForm.shiftDate,
      startTime: openShiftForm.startTime,
      endTime: openShiftForm.endTime,
      headcount: Number.parseInt(openShiftForm.headcount, 10),
      isOvertime: openShiftForm.isOvertime,
      notes: openShiftForm.notes,
      publishAnnouncement: openShiftForm.publishAnnouncement,
    }),
    onSuccess: async (result) => {
      setBuilderMessage(`Open shift published on revision ${result.schedule_revision}. Guards can see it now.`)
      setOpenShiftForm(defaultOpenShiftForm(weekKey))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule', weekKey] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['request-center'] }),
      ])
    },
    onError: (error) => {
      setBuilderMessage(error instanceof Error ? error.message : 'The open shift could not be created.')
    },
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

  function updateOpenShiftForm(update: Partial<OpenShiftFormState>) {
    setBuilderMessage(null)
    setOpenShiftForm((current) => ({ ...current, ...update }))
  }

  function handleCreateOpenShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBuilderMessage(null)
    createOpenShiftMutation.mutate()
  }

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
        {canBuildSchedule ? (
          <button
            className="primary-action"
            onClick={() => {
              setBuilderOpen((current) => !current)
              setOpenShiftForm(defaultOpenShiftForm(weekKey))
              setBuilderMessage(null)
            }}
            type="button"
          >
            <Plus aria-hidden="true" size={20} />
            Add open shift
          </button>
        ) : null}
      </section>

      {canBuildSchedule && builderOpen ? (
        <section className="panel schedule-builder" aria-labelledby="schedule-builder-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Supervisor action</p>
              <h2 id="schedule-builder-heading">Add an open shift or event</h2>
            </div>
            <span className="status-pill">Creates a reviewed schedule revision</span>
          </div>

          <form className="request-form schedule-builder__form" onSubmit={handleCreateOpenShift}>
            <div className="form-grid">
              <label>
                Shift type
                <select
                  onChange={(event) => updateOpenShiftForm({ mode: event.target.value as OpenShiftFormState['mode'] })}
                  value={openShiftForm.mode}
                >
                  <option value="post">Permanent site/post</option>
                  <option value="event">One-time event</option>
                </select>
              </label>

              {openShiftForm.mode === 'post' ? (
                <label>
                  Site and post
                  <select
                    disabled={builderOptionsQuery.isPending}
                    onChange={(event) => updateOpenShiftForm({ postId: event.target.value })}
                    required
                    value={openShiftForm.postId}
                  >
                    <option value="">Choose a site/post</option>
                    {builderOptionsQuery.data?.posts.map((post) => (
                      <option key={post.id} value={post.id}>
                        {post.site.code ? `${post.site.code} - ` : ''}{post.site.name} / {post.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  Event name
                  <input
                    onChange={(event) => updateOpenShiftForm({ eventName: event.target.value })}
                    placeholder="Example: Concert coverage"
                    required
                    value={openShiftForm.eventName}
                  />
                </label>
              )}

              {openShiftForm.mode === 'event' ? (
                <>
                  <label>
                    Event location
                    <input
                      onChange={(event) => updateOpenShiftForm({ eventLocationName: event.target.value })}
                      placeholder="Venue, building, or address"
                      required={!openShiftForm.eventSiteId}
                      value={openShiftForm.eventLocationName}
                    />
                  </label>
                  <label>
                    Link to site, if applicable
                    <select
                      onChange={(event) => {
                        const site = availableSites.find((item) => item.id === event.target.value)
                        updateOpenShiftForm({
                          eventSiteId: event.target.value,
                          eventTimeZone: site?.time_zone ?? 'America/Denver',
                        })
                      }}
                      value={openShiftForm.eventSiteId}
                    >
                      <option value="">Standalone event</option>
                      {availableSites.map((site) => (
                        <option key={site.id} value={site.id}>{site.name}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}

              <label>
                Date
                <input
                  onChange={(event) => updateOpenShiftForm({ shiftDate: event.target.value })}
                  required
                  type="date"
                  value={openShiftForm.shiftDate}
                />
              </label>
              <label>
                Start time
                <input
                  onChange={(event) => updateOpenShiftForm({ startTime: event.target.value })}
                  required
                  type="time"
                  value={openShiftForm.startTime}
                />
              </label>
              <label>
                End time
                <input
                  onChange={(event) => updateOpenShiftForm({ endTime: event.target.value })}
                  required
                  type="time"
                  value={openShiftForm.endTime}
                />
              </label>
              <label>
                Guards needed
                <input
                  min="1"
                  max="50"
                  onChange={(event) => updateOpenShiftForm({ headcount: event.target.value })}
                  required
                  type="number"
                  value={openShiftForm.headcount}
                />
              </label>
            </div>

            <label className="field-stack">
              Notes for supervisors
              <textarea
                onChange={(event) => updateOpenShiftForm({ notes: event.target.value })}
                placeholder="Anything important about coverage, parking, uniform, or arrival instructions."
                value={openShiftForm.notes}
              />
            </label>

            <div className="schedule-builder__checks">
              <label className="check-field">
                <input
                  checked={openShiftForm.isOvertime}
                  onChange={(event) => updateOpenShiftForm({ isOvertime: event.target.checked })}
                  type="checkbox"
                />
                Mark this as overtime
              </label>
              {openShiftForm.mode === 'event' ? (
                <label className="check-field">
                  <input
                    checked={openShiftForm.eventRequiresArmed}
                    onChange={(event) => updateOpenShiftForm({ eventRequiresArmed: event.target.checked })}
                    type="checkbox"
                  />
                  Requires armed guard credentials
                </label>
              ) : null}
              <label className="check-field">
                <input
                  checked={openShiftForm.publishAnnouncement}
                  onChange={(event) => updateOpenShiftForm({ publishAnnouncement: event.target.checked })}
                  type="checkbox"
                />
                Publish announcement for guards
              </label>
            </div>

            <p className="form-note">
              {openShiftForm.mode === 'post' && selectedPost
                ? `${selectedPost.site.name} uses ${selectedPost.site.time_zone}. Armed requirements come from the selected post.`
                : 'Times are saved in the site or event time zone so payroll and the schedule stay consistent.'}
            </p>

            {builderMessage ? (
              <p className={createOpenShiftMutation.isError ? 'form-feedback form-feedback--error' : 'form-feedback form-feedback--success'} role="status">
                {builderMessage}
              </p>
            ) : null}

            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setBuilderOpen(false)} type="button">
                Close
              </button>
              <button
                className="primary-action"
                disabled={createOpenShiftMutation.isPending || builderOptionsQuery.isPending}
                type="submit"
              >
                {createOpenShiftMutation.isPending ? 'Publishing...' : 'Publish open shift'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

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

import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, addWeeks, format, startOfWeek } from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight, DatabaseZap, MoveHorizontal, Plus, Search, ShieldAlert } from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getCurrentAppRole } from '../data/session'
import {
  assignmentName,
  bibleScheduleRows,
  createSupervisorOpenShift,
  getBibleSchedulePreview,
  getScheduleBuilderOptions,
  getWeeklySchedule,
  resolveScheduleReviewShift,
  scheduleRows,
  shiftOperationalDate,
  shiftTimeRange,
  type BibleScheduleShift,
  type ScheduleBuilderEmployee,
  type ScheduleShift,
} from '../data/schedule'
import { parseBibleSourceNote, sourceReferenceLabel } from '../data/sourceNotes'
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

function builderEmployeeName(employee: ScheduleBuilderEmployee): string {
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`
}

function ShiftCard({
  shift,
  canResolve,
  onResolve,
}: {
  shift: ScheduleShift
  canResolve: boolean
  onResolve: (shift: ScheduleShift) => void
}) {
  const title = shift.post?.name ?? shift.event?.name ?? 'Shift'
  const openSlots = Math.max(shift.headcount_required - shift.assignments.length, 0)
  const source = parseBibleSourceNote(shift.notes)
  const sourceReference = sourceReferenceLabel(source)
  const showSourceReview = source.reviewNeeded || (shift.is_open && source.assignee)

  return (
    <article className={source.reviewNeeded ? 'shift-card shift-card--review-needed' : 'shift-card'}>
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
        {source.reviewNeeded ? <span className="shift-tag shift-tag--review">Review needed</span> : null}
        {shift.requires_armed ? <span className="shift-tag shift-tag--armed">Armed</span> : null}
        {shift.is_open || openSlots > 0 ? (
          <span className="shift-tag shift-tag--open">
            {openSlots > 0 ? `${openSlots} open` : 'Open'}
          </span>
        ) : (
          <span className="shift-tag shift-tag--covered">Covered</span>
        )}
      </div>
      {showSourceReview ? (
        <div className="shift-card__source-note" aria-label="Bible source assignment review">
          {source.assignee ? <span><strong>Bible assignee:</strong> {source.assignee}</span> : null}
          {source.context ? <span><strong>Source row:</strong> {source.context}</span> : null}
          {source.qualification ? <span><strong>Qualification:</strong> {source.qualification}</span> : null}
          {sourceReference ? <small>{sourceReference}</small> : null}
          {source.reviewNeeded && canResolve ? (
            <button className="text-button shift-card__resolve" onClick={() => onResolve(shift)} type="button">
              Resolve assignment
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function ReviewResolutionDialog({
  shift,
  employees,
  mutation,
  onClose,
}: {
  shift: ScheduleShift
  employees: ScheduleBuilderEmployee[]
  mutation: ReturnType<typeof useMutation<unknown, Error, { shiftId: string, employeeId: string, note: string | null }>>
  onClose: () => void
}) {
  const source = parseBibleSourceNote(shift.notes)
  const eligibleEmployees = employees.filter((employee) => !shift.requires_armed || employee.has_armed_guard_credential)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      shiftId: shift.id,
      employeeId: String(form.get('employeeId')),
      note: String(form.get('note')).trim() || null,
    }, { onSuccess: onClose })
  }

  return (
    <ModalDialog
      description="Resolving creates a new schedule revision. The database will reject overlaps, missing armed credentials, or full shifts."
      onClose={onClose}
      title="Resolve Bible schedule assignment"
    >
      <div className="confirmation-summary">
        <strong>{shift.post?.name ?? shift.event?.name ?? 'Shift'}</strong>
        <span>{shiftTimeRange(shift)}</span>
        {source.assignee ? <span>Bible assignee: {source.assignee}</span> : null}
        {source.context ? <span>Source row: {source.context}</span> : null}
      </div>
      <form className="request-form" onSubmit={submit}>
        <label className="field-stack">
          <span>Assign employee</span>
          <select autoFocus name="employeeId" required>
            <option value="">Choose employee</option>
            {eligibleEmployees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {builderEmployeeName(employee)}
                {employee.has_armed_guard_credential ? ' · armed credential' : ''}
                {employee.employment_type === 'salary' ? ' · salary' : ''}
              </option>
            ))}
          </select>
        </label>
        {eligibleEmployees.length === 0 ? (
          <p className="form-feedback form-feedback--error">
            No active employee in the current options can satisfy this shift&apos;s armed requirement.
          </p>
        ) : null}
        <label className="field-stack">
          <span>Resolution note <small>Optional</small></span>
          <textarea maxLength={2000} name="note" rows={3} />
        </label>
        {mutation.isError ? (
          <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p>
        ) : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={mutation.isPending || eligibleEmployees.length === 0} type="submit">
            {mutation.isPending ? 'Resolving…' : 'Resolve & publish revision'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}

function sourceQualificationLabel(value: string | null): string {
  if (value === 'armed') return 'Armed'
  if (value === 'unarmed') return 'Unarmed'
  return 'Needs review'
}

function BibleShiftCard({ shift }: { shift: BibleScheduleShift }) {
  const assignee = shift.openCandidate
    ? 'Open shift'
    : shift.assigneeLabel && !['na', 'n/a', 'none'].includes(shift.assigneeLabel.trim().toLocaleLowerCase())
      ? shift.assigneeLabel
      : 'No named guard'

  return (
    <article className="shift-card shift-card--source">
      <div className="shift-card__heading">
        <strong>{shift.startTime} - {shift.endTime}</strong>
        {shift.crossesMidnight ? <span className="shift-tag">Overnight</span> : null}
      </div>
      <span className="shift-card__title">{assignee}</span>
      <div className="shift-card__people">
        <span>{shift.contextLabel ?? 'Unlabeled source row'}</span>
      </div>
      <div className="shift-card__footer">
        <span className={shift.qualificationCandidate === 'unknown' ? 'shift-tag shift-tag--review' : 'shift-tag'}>
          {sourceQualificationLabel(shift.qualificationCandidate)}
        </span>
        <span className="shift-tag">Bible source</span>
      </div>
      <small className="source-cell-reference">
        Cell {shift.sourceTimeAddress ?? shift.candidateKey}
      </small>
    </article>
  )
}

export function SchedulePage() {
  const queryClient = useQueryClient()
  const today = useMemo(() => operationalToday(), [])
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, { weekStartsOn: 0 }))
  const [search, setSearch] = useState('')
  const [siteFilter, setSiteFilter] = useState('all')
  const [reviewOnly, setReviewOnly] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [resolvingShift, setResolvingShift] = useState<ScheduleShift | null>(null)
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
  const biblePreviewQuery = useQuery({
    queryKey: ['bible-schedule-preview', weekKey],
    queryFn: () => getBibleSchedulePreview(weekKey),
    enabled: isSupabaseConfigured && !scheduleQuery.isPending && !scheduleQuery.data,
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
  const resolveReviewMutation = useMutation({
    mutationFn: (input: { shiftId: string, employeeId: string, note: string | null }) => resolveScheduleReviewShift(input),
    onSuccess: async (result) => {
      setBuilderMessage(`Review item resolved on revision ${result.schedule_revision}.`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['request-center'] }),
        queryClient.invalidateQueries({ queryKey: ['overview-metrics'] }),
      ])
    },
  })
  const rows = useMemo(() => scheduleQuery.data ? scheduleRows(scheduleQuery.data) : [], [scheduleQuery.data])
  const bibleRows = useMemo(
    () => biblePreviewQuery.data ? bibleScheduleRows(biblePreviewQuery.data) : [],
    [biblePreviewQuery.data],
  )
  const visibleRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return rows
      .filter((row) => siteFilter === 'all' || row.id === siteFilter)
      .map((row) => ({
        ...row,
        shifts: row.shifts.filter((shift) => {
          const source = parseBibleSourceNote(shift.notes)
          if (reviewOnly && !source.reviewNeeded) return false
          if (!term) return true
          const searchable = [
            row.name,
            row.code,
            shift.post?.name,
            shift.event?.name,
            source.assignee,
            source.context,
            source.sheet,
            source.timeCell,
            ...shift.assignments.map(assignmentName),
          ]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
          return searchable.includes(term)
        }),
      }))
      .filter((row) => row.shifts.length > 0)
  }, [rows, reviewOnly, search, siteFilter])
  const reviewNeededCount = useMemo(
    () => rows.reduce((total, row) => total + row.shifts.filter((shift) => parseBibleSourceNote(shift.notes).reviewNeeded).length, 0),
    [rows],
  )
  const visibleBibleRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return bibleRows
      .filter((row) => siteFilter === 'all' || row.id === siteFilter)
      .map((row) => ({
        ...row,
        shifts: row.shifts.filter((shift) => {
          if (!term) return true
          const searchable = [
            row.name,
            shift.contextLabel,
            shift.assigneeLabel,
            shift.startTime,
            shift.endTime,
            shift.qualificationCandidate,
          ]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
          return searchable.includes(term)
        }),
      }))
      .filter((row) => row.shifts.length > 0)
  }, [bibleRows, search, siteFilter])

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

      {resolvingShift ? (
        <ReviewResolutionDialog
          employees={builderOptionsQuery.data?.employees ?? []}
          mutation={resolveReviewMutation}
          onClose={() => setResolvingShift(null)}
          shift={resolvingShift}
        />
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
              {(rows.length > 0 ? rows : bibleRows).map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}
            </select>
          </label>
          {reviewNeededCount > 0 ? (
            <label className="check-field schedule-review-filter">
              <input
                checked={reviewOnly}
                onChange={(event) => setReviewOnly(event.target.checked)}
                type="checkbox"
              />
              <span>Show review needed only ({reviewNeededCount})</span>
            </label>
          ) : null}
        </div>
      </section>

      {!scheduleQuery.data && biblePreviewQuery.data ? (
        <section className="source-schedule-banner" aria-label="Bible source schedule status">
          <div>
            <p className="eyebrow">Bible source schedule</p>
            <strong>{biblePreviewQuery.data.sourceSheetName ?? 'Source workbook week'}</strong>
            <span>
              This is the workbook schedule staged for review. It is visible for operations planning, but not yet payroll-ready.
            </span>
          </div>
          <div className="source-schedule-banner__counts">
            <span>{biblePreviewQuery.data.shifts.length} source shifts</span>
            <span>{biblePreviewQuery.data.blockingIssueCount} blockers</span>
            <span>{biblePreviewQuery.data.warningIssueCount} warnings</span>
          </div>
        </section>
      ) : null}

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
          ) : !scheduleQuery.data && biblePreviewQuery.isPending ? (
            <div className="schedule-state" role="row">
              <div role="cell">
                <DataStatePanel icon={CalendarDays} title="Loading Bible source schedule">
                  <p>Retrieving the reviewed source workbook schedule for this week.</p>
                </DataStatePanel>
              </div>
            </div>
          ) : !scheduleQuery.data && biblePreviewQuery.data && visibleBibleRows.length > 0 ? (
            visibleBibleRows.map((row) => (
              <div className="schedule-row schedule-row--coverage schedule-row--source" role="row" key={row.id}>
                <div className="schedule-location" role="rowheader">
                  <span>{sourceQualificationLabel(row.qualification)}</span>
                  <strong>{row.name}</strong>
                </div>
                {days.map((day) => {
                  const dayKey = format(day, 'yyyy-MM-dd')
                  const shifts = row.shifts.filter((shift) => shift.localDate === dayKey)
                  return (
                    <div className="schedule-day-cell" role="cell" key={dayKey}>
                      {shifts.map((shift) => <BibleShiftCard shift={shift} key={shift.id} />)}
                      {shifts.length === 0 ? <span className="schedule-day-empty">—</span> : null}
                    </div>
                  )
                })}
              </div>
            ))
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
                    {shifts.map((shift) => (
                      <ShiftCard
                        canResolve={canBuildSchedule}
                        key={shift.id}
                        onResolve={(targetShift) => {
                          setBuilderOpen(false)
                          setBuilderMessage(null)
                          setResolvingShift(targetShift)
                        }}
                        shift={shift}
                      />
                    ))}
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

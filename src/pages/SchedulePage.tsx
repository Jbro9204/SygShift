import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addDays, addWeeks, format, startOfWeek } from 'date-fns'
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, DatabaseZap, Edit3, MapPin, MoveHorizontal, Plus, Search, ShieldAlert, Sparkles, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { getCurrentAppRole } from '../data/session'
import {
  assignmentName,
  cancelScheduleDraft,
  ensureScheduleDraft,
  importedScheduleRows,
  employeeScheduleRows,
  createSupervisorOpenShift,
  getImportedSchedulePreview,
  getScheduleBuilderOptions,
  getScheduleStaffingSuggestions,
  getWeeklySchedule,
  publishScheduleDraft,
  resolveScheduleReviewShift,
  scheduleRows,
  shiftOperationalDate,
  shiftTimeRange,
  updateScheduleDraftShift,
  type ImportedScheduleShift,
  type ScheduleBuilderEmployee,
  type ScheduleShift,
  type StaffingSuggestion,
} from '../data/schedule'
import { parseImportedScheduleNote, sourceReferenceLabel } from '../data/sourceNotes'
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
  employeeId: string
  isOvertime: boolean
  notes: string
  publishAnnouncement: boolean
}

interface SchedulerCoverageLane {
  id: string
  name: string
  label: string
  shifts: ScheduleShift[]
}

interface SchedulerCoverageGroup {
  id: string
  code: string | null
  name: string
  openSlots: number
  reviewCount: number
  shiftCount: number
  status: 'covered' | 'has-open' | 'needs-review' | 'empty'
  lanes: SchedulerCoverageLane[]
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
    employeeId: '',
    isOvertime: false,
    notes: '',
    publishAnnouncement: true,
  }
}

function builderEmployeeName(employee: ScheduleBuilderEmployee): string {
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`
}

function shiftLocalTimeValue(shift: ScheduleShift, instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: shift.time_zone,
  }).formatToParts(new Date(instant))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${value('hour')}:${value('minute')}`
}

function draftShiftMutationInput(shift: ScheduleShift, employeeId: string | null) {
  return {
    shiftId: shift.id,
    shiftDate: shiftOperationalDate(shift),
    startTime: shiftLocalTimeValue(shift, shift.starts_at),
    endTime: shiftLocalTimeValue(shift, shift.ends_at),
    headcount: shift.headcount_required,
    isOpen: employeeId ? shift.headcount_required > 1 : shift.is_open,
    isOvertime: shift.is_overtime,
    notes: shift.notes ?? '',
    employeeId,
  }
}

function findMatchingDraftShift(draft: { shifts: ScheduleShift[] }, sourceShift: ScheduleShift): ScheduleShift | undefined {
  return draft.shifts.find((candidate) =>
    candidate.starts_at === sourceShift.starts_at
    && candidate.ends_at === sourceShift.ends_at
    && (candidate.post?.id ?? null) === (sourceShift.post?.id ?? null)
    && (candidate.event?.id ?? null) === (sourceShift.event?.id ?? null)
  )
}

function ShiftCard({
  shift,
  canEdit,
  canResolve,
  onEdit,
  onResolve,
  compact = false,
  selected = false,
}: {
  shift: ScheduleShift
  canEdit: boolean
  canResolve: boolean
  onEdit: (shift: ScheduleShift) => void
  onResolve: (shift: ScheduleShift) => void
  compact?: boolean
  selected?: boolean
}) {
  const title = shift.post?.name ?? shift.event?.name ?? 'Shift'
  const location = shift.post?.site.name ?? shift.event?.location_name ?? shift.event?.site?.name ?? null
  const openSlots = Math.max(shift.headcount_required - shift.assignments.length, 0)
  const source = parseImportedScheduleNote(shift.notes)
  const sourceReference = sourceReferenceLabel(source)
  const showSourceReview = source.reviewNeeded || (shift.is_open && source.assignee)

  return (
    <article
      className={[
        source.reviewNeeded ? 'shift-card shift-card--review-needed' : 'shift-card',
        canEdit ? 'shift-card--editable' : '',
        selected ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => {
        if (canEdit) onEdit(shift)
      }}
      onKeyDown={(event) => {
        if (!canEdit) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit(shift)
        }
      }}
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      title={canEdit ? 'Edit this schedule block' : undefined}
    >
      <div className="shift-card__heading">
        <strong>{shiftTimeRange(shift)}</strong>
        {shift.is_overtime ? <span className="shift-tag shift-tag--overtime">OT</span> : null}
      </div>
      <span className="shift-card__title">{title}</span>
      {compact && location ? <small className="shift-card__location">{location}</small> : null}
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
        <div className="shift-card__source-note" aria-label="Schedule assignment review">
          {source.assignee ? <span><strong>Original assignee:</strong> {source.assignee}</span> : null}
          {source.context ? <span><strong>Schedule context:</strong> {source.context}</span> : null}
          {source.qualification ? <span><strong>Qualification:</strong> {source.qualification}</span> : null}
          {sourceReference ? <small>{sourceReference}</small> : null}
          {source.reviewNeeded && canResolve ? (
            <button className="text-button shift-card__resolve" onClick={(event) => {
              event.stopPropagation()
              onResolve(shift)
            }} type="button">
              Resolve assignment
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function EditShiftDialog({
  employees,
  focusEmployeeId,
  shift,
  suggestions,
  mutation,
  onClose,
}: {
  employees: ScheduleBuilderEmployee[]
  focusEmployeeId?: string | null
  shift: ScheduleShift
  suggestions: StaffingSuggestion | undefined
  mutation: ReturnType<typeof useMutation<unknown, Error, {
    shiftId: string
    shiftDate: string
    startTime: string
    endTime: string
    headcount: number
    isOpen: boolean
    isOvertime: boolean
    notes?: string
    employeeId?: string | null
  }>>
  onClose: () => void
}) {
  const focusedAssignment = focusEmployeeId
    ? shift.assignments.find((assignment) => assignment.employee.id === focusEmployeeId)
    : null
  const assignedEmployeeId = focusedAssignment?.employee.id ?? shift.assignments[0]?.employee.id ?? ''
  const eligibleEmployees = employees.filter((employee) => !shift.requires_armed || employee.has_armed_guard_credential)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      shiftId: shift.id,
      shiftDate: String(form.get('shiftDate')),
      startTime: String(form.get('startTime')),
      endTime: String(form.get('endTime')),
      headcount: Number.parseInt(String(form.get('headcount')), 10),
      isOpen: form.get('isOpen') === 'on',
      isOvertime: form.get('isOvertime') === 'on',
      notes: String(form.get('notes') ?? ''),
      employeeId: String(form.get('employeeId') ?? '') || null,
    }, { onSuccess: onClose })
  }

  return (
    <ModalDialog
      description="Edits are saved to the working draft. Publish the draft when the schedule is ready to go live."
      onClose={onClose}
      title={`Edit ${shift.post?.site.name ?? shift.event?.name ?? 'shift'}`}
    >
      <form className="request-form schedule-edit-form" onSubmit={submit}>
        <div className="form-grid form-grid--three">
          <label><span>Date</span><input defaultValue={shiftOperationalDate(shift)} name="shiftDate" required type="date" /></label>
          <label><span>Start</span><input defaultValue={shiftLocalTimeValue(shift, shift.starts_at)} name="startTime" required type="time" /></label>
          <label><span>End</span><input defaultValue={shiftLocalTimeValue(shift, shift.ends_at)} name="endTime" required type="time" /></label>
        </div>
        <div className="form-grid form-grid--two">
          <label><span>Headcount</span><input defaultValue={shift.headcount_required} min={1} name="headcount" required type="number" /></label>
          <label>
            <span>Switch / assign employee</span>
            <select defaultValue={assignedEmployeeId} name="employeeId">
              <option value="">Leave open / unassigned</option>
              {eligibleEmployees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {builderEmployeeName(employee)}
                  {employee.has_armed_guard_credential ? ' · armed' : ''}
                  {employee.employment_type === 'salary' ? ' · salary' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field-stack">
          <span>Notes</span>
          <textarea defaultValue={shift.notes ?? ''} name="notes" rows={4} />
        </label>
        <div className="schedule-builder__checks">
          <label className="check-field"><input defaultChecked={shift.is_open} name="isOpen" type="checkbox" /> Show as open if coverage is still needed</label>
          <label className="check-field"><input defaultChecked={shift.is_overtime} name="isOvertime" type="checkbox" /> Mark as overtime</label>
        </div>
        {shift.requires_armed ? <p className="form-note">This shift requires an active armed credential. The system blocks unqualified assignments.</p> : null}
        {suggestions?.suggestions.length ? (
          <div className="staffing-suggestion-card">
            <Sparkles aria-hidden="true" size={18} />
            <div>
              <strong>Suggested staffing</strong>
              <p>{suggestions.suggestions.slice(0, 3).map((candidate) => `${candidate.name} (${candidate.reason})`).join('; ')}</p>
            </div>
          </div>
        ) : null}
        {mutation.isError ? <p className="form-feedback form-feedback--error" role="alert">{mutation.error.message}</p> : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={mutation.isPending} type="submit">
            {mutation.isPending ? 'Saving...' : 'Save draft shift'}
          </button>
        </div>
      </form>
    </ModalDialog>
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
  const source = parseImportedScheduleNote(shift.notes)
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
      title="Resolve schedule assignment"
    >
      <div className="confirmation-summary">
        <strong>{shift.post?.name ?? shift.event?.name ?? 'Shift'}</strong>
        <span>{shiftTimeRange(shift)}</span>
        {source.assignee ? <span>Original assignee: {source.assignee}</span> : null}
        {source.context ? <span>Schedule context: {source.context}</span> : null}
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

function SchedulerShiftPanel({
  employees,
  isDraft,
  isSaving,
  onAssignEmployee,
  onClose,
  onEdit,
  onResolve,
  shift,
  suggestion,
}: {
  employees: ScheduleBuilderEmployee[]
  isDraft: boolean
  isSaving: boolean
  onAssignEmployee: (employeeId: string | null) => void
  onClose: () => void
  onEdit: () => void
  onResolve: () => void
  shift: ScheduleShift
  suggestion: StaffingSuggestion | undefined
}) {
  const source = parseImportedScheduleNote(shift.notes)
  const openSlots = Math.max(shift.headcount_required - shift.assignments.length, 0)
  const eligibleEmployees = employees.filter((employee) => !shift.requires_armed || employee.has_armed_guard_credential)
  const title = shift.post?.name ?? shift.event?.name ?? 'Shift'
  const location = shift.post?.site.name ?? shift.event?.location_name ?? shift.event?.site?.name ?? 'Unassigned location'
  const sourceReference = sourceReferenceLabel(source)

  function submitAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const employeeId = String(form.get('employeeId') ?? '')
    onAssignEmployee(employeeId || null)
    event.currentTarget.reset()
  }

  return (
    <aside className="scheduler-shift-panel" aria-label="Selected shift actions">
      <header>
        <div>
          <p className="eyebrow">Selected shift</p>
          <h3>{title}</h3>
          <span>{location}</span>
        </div>
        <button aria-label="Close selected shift" className="icon-button" onClick={onClose} type="button">
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <div className="scheduler-shift-panel__body">
        <section className="scheduler-shift-panel__section">
          <span className="scheduler-shift-panel__label">Details</span>
          <dl className="scheduler-shift-details">
            <div><dt>Date</dt><dd>{format(new Date(`${shiftOperationalDate(shift)}T12:00:00`), 'EEEE, MM/dd/yyyy')}</dd></div>
            <div><dt>Time</dt><dd>{shiftTimeRange(shift)}</dd></div>
            <div><dt>Needed</dt><dd>{shift.headcount_required}</dd></div>
            <div><dt>Open</dt><dd>{openSlots}</dd></div>
            <div><dt>Requirement</dt><dd>{shift.requires_armed ? 'Armed credential' : 'Unarmed'}</dd></div>
          </dl>
        </section>

        <section className="scheduler-shift-panel__section">
          <span className="scheduler-shift-panel__label">Assigned</span>
          {shift.assignments.length ? (
            <div className="scheduler-assigned-list">
              {shift.assignments.map((assignment) => (
                <span key={assignment.id}>{assignmentName(assignment)}</span>
              ))}
            </div>
          ) : (
            <p className="scheduler-muted">No employee assigned yet.</p>
          )}
        </section>

        {source.reviewNeeded || source.assignee || source.context ? (
          <section className="scheduler-shift-panel__section scheduler-shift-panel__warning">
            <AlertCircle aria-hidden="true" size={17} />
            <div>
              <strong>{source.reviewNeeded ? 'Review needed' : 'Schedule note'}</strong>
              {source.assignee ? <span>Original assignee: {source.assignee}</span> : null}
              {source.context ? <span>Schedule context: {source.context}</span> : null}
              {sourceReference ? <small>{sourceReference}</small> : null}
            </div>
          </section>
        ) : null}

        <section className="scheduler-shift-panel__section">
          <span className="scheduler-shift-panel__label">Suggested staffing</span>
          {suggestion?.suggestions.length ? (
            <div className="scheduler-panel-suggestions">
              {suggestion.suggestions.slice(0, 5).map((candidate) => (
                <article key={candidate.employeeId}>
                  <div>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.reason}</span>
                  </div>
                  <button
                    className="secondary-button secondary-button--small"
                    disabled={!isDraft || isSaving}
                    onClick={() => onAssignEmployee(candidate.employeeId)}
                    type="button"
                  >
                    Assign
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="scheduler-muted">
              {isDraft ? 'No automatic suggestion is available. Choose an eligible employee below.' : 'Open a draft to see and apply staffing suggestions.'}
            </p>
          )}
        </section>

        <form className="scheduler-panel-assign" onSubmit={submitAssignment}>
          <label>
            Switch / assign manually
            <select disabled={isSaving || eligibleEmployees.length === 0} name="employeeId">
              <option value="">Leave open / unassigned</option>
              {eligibleEmployees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {builderEmployeeName(employee)}
                  {employee.has_armed_guard_credential ? ' · armed' : ''}
                  {employee.employment_type === 'salary' ? ' · salary' : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-action" disabled={isSaving || eligibleEmployees.length === 0} type="submit">
            {isSaving ? 'Saving...' : isDraft ? 'Save assignment' : 'Open draft & save assignment'}
          </button>
          <p className="form-note">
            Use this for call-offs and coverage changes. Saving replaces the current active assignment for this shift and keeps the draft unpublished until you approve it.
          </p>
        </form>

        {!isDraft ? (
          <p className="form-note">This will open a working draft first, then apply the change so the live schedule is not changed until you publish.</p>
        ) : null}

        <div className="scheduler-shift-panel__actions">
          <button className="secondary-button" onClick={onEdit} type="button">Edit full block</button>
          {source.reviewNeeded ? (
            <button className="primary-action" onClick={onResolve} type="button">Resolve review</button>
          ) : null}
        </div>
      </div>
    </aside>
  )
}

function sourceQualificationLabel(value: string | null): string {
  if (value === 'armed') return 'Armed'
  if (value === 'unarmed') return 'Unarmed'
  return 'Needs review'
}

function mobileScheduleRowLabel(row: { id: string, name: string, code?: string | null, type?: string }, view: 'site' | 'employee'): string {
  if (view === 'employee') return 'Employee'
  if (row.code) return row.code
  if (row.type === 'event') return 'Event'
  return 'Site'
}

function ImportedShiftCard({ shift }: { shift: ImportedScheduleShift }) {
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
        <span>{shift.contextLabel ?? 'Unlabeled schedule row'}</span>
      </div>
      <div className="shift-card__footer">
        <span className={shift.qualificationCandidate === 'unknown' ? 'shift-tag shift-tag--review' : 'shift-tag'}>
          {sourceQualificationLabel(shift.qualificationCandidate)}
        </span>
        <span className="shift-tag">Historical schedule</span>
      </div>
      <small className="source-cell-reference">
        Cell {shift.sourceTimeAddress ?? shift.candidateKey}
      </small>
    </article>
  )
}

export function SchedulePage({ mode = 'master' }: { mode?: 'master' | 'scheduler' } = {}) {
  const queryClient = useQueryClient()
  const boardScrollRef = useRef<HTMLElement | null>(null)
  const topScrollRef = useRef<HTMLDivElement | null>(null)
  const isSchedulerHome = mode === 'scheduler'
  const today = useMemo(() => operationalToday(), [])
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, { weekStartsOn: 0 }))
  const [search, setSearch] = useState('')
  const [siteFilter, setSiteFilter] = useState('all')
  const [scheduleView, setScheduleView] = useState<'site' | 'employee'>('site')
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [reviewOnly, setReviewOnly] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [resolvingShift, setResolvingShift] = useState<ScheduleShift | null>(null)
  const [editingShift, setEditingShift] = useState<ScheduleShift | null>(null)
  const [selectedPlannerShiftId, setSelectedPlannerShiftId] = useState<string | null>(null)
  const [cancelDraftConfirmOpen, setCancelDraftConfirmOpen] = useState(false)
  const [builderMessage, setBuilderMessage] = useState<string | null>(null)
  const [boardScrollWidth, setBoardScrollWidth] = useState(0)
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart])
  const weekEnd = days[6]
  const weekKey = format(weekStart, 'yyyy-MM-dd')
  const currentOperationalDateKey = format(today, 'yyyy-MM-dd')
  const schedulerWorkDays = useMemo(
    () => days.filter((day) => format(day, 'yyyy-MM-dd') >= currentOperationalDateKey),
    [currentOperationalDateKey, days],
  )
  const planningWeeks = useMemo(() => {
    const currentWeek = startOfWeek(today, { weekStartsOn: 0 })
    return Array.from({ length: 6 }, (_, index) => {
      const startsOn = addWeeks(currentWeek, index)
      return {
        key: format(startsOn, 'yyyy-MM-dd'),
        label: index === 0 ? 'This week' : `Week ${index + 1}`,
        range: `${format(startsOn, 'MM/dd/yyyy')} - ${format(addDays(startsOn, 6), 'MM/dd/yyyy')}`,
        startsOn,
      }
    })
  }, [today])
  const [openShiftForm, setOpenShiftForm] = useState<OpenShiftFormState>(() => defaultOpenShiftForm(weekKey))
  const scheduleQuery = useQuery({
    queryKey: ['weekly-schedule', weekKey],
    queryFn: () => getWeeklySchedule(weekKey),
    enabled: isSupabaseConfigured,
  })
  const importedPreviewQuery = useQuery({
    queryKey: ['imported-schedule-preview', weekKey],
    queryFn: () => getImportedSchedulePreview(weekKey),
    enabled: false,
  })
  const roleQuery = useQuery({
    queryKey: ['current-app-role'],
    queryFn: getCurrentAppRole,
    enabled: isSupabaseConfigured,
  })
  const canBuildSchedule = roleQuery.data === 'dispatcher'
    || roleQuery.data === 'scheduler'
    || roleQuery.data === 'supervisor'
    || roleQuery.data === 'admin'
  const canUseScheduler = canBuildSchedule && isSchedulerHome
  const builderOptionsQuery = useQuery({
    queryKey: ['schedule-builder-options'],
    queryFn: getScheduleBuilderOptions,
    enabled: isSupabaseConfigured && canBuildSchedule && (canUseScheduler || scheduleView === 'employee'),
  })
  const staffingSuggestionsQuery = useQuery({
    queryKey: ['schedule-staffing-suggestions', scheduleQuery.data?.id],
    queryFn: () => getScheduleStaffingSuggestions(scheduleQuery.data!.id),
    enabled: isSupabaseConfigured && canUseScheduler && scheduleQuery.data?.status === 'draft',
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
  const suggestionsByShift = useMemo(() => {
    const map = new Map<string, StaffingSuggestion>()
    for (const suggestion of staffingSuggestionsQuery.data ?? []) map.set(suggestion.shiftId, suggestion)
    return map
  }, [staffingSuggestionsQuery.data])
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
      employeeId: openShiftForm.employeeId || null,
      isOvertime: openShiftForm.isOvertime,
      notes: openShiftForm.notes,
      publishAnnouncement: !openShiftForm.employeeId && openShiftForm.publishAnnouncement,
    }),
    onSuccess: async (result) => {
      setBuilderMessage(
        result.assignment_id
          ? `Assigned shift published on revision ${result.schedule_revision}.`
          : `Open shift published on revision ${result.schedule_revision}. Guards can see it now.`,
      )
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
  const ensureDraftMutation = useMutation({
    mutationFn: (shiftToEdit?: ScheduleShift) => ensureScheduleDraft(weekKey).then((draft) => ({ draft, shiftToEdit })),
    onSuccess: async ({ draft, shiftToEdit }) => {
      if (draft) {
        queryClient.setQueryData(['weekly-schedule', weekKey], draft)
        setBuilderMessage(`Working draft opened for revision ${draft.revision}. Publish when ready.`)
        if (shiftToEdit) {
          const copiedShift = findMatchingDraftShift(draft, shiftToEdit)
          if (copiedShift) setEditingShift(copiedShift)
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] })
    },
    onError: (error) => {
      setBuilderMessage(error instanceof Error ? error.message : 'The schedule draft could not be opened.')
    },
  })
  const updateDraftShiftMutation = useMutation({
    mutationFn: updateScheduleDraftShift,
    onSuccess: async (updatedSchedule) => {
      queryClient.setQueryData(['weekly-schedule', weekKey], updatedSchedule)
      setBuilderMessage('Draft shift saved. Publish the draft when the week is ready.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions', updatedSchedule.id] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
      ])
    },
  })
  const publishDraftMutation = useMutation({
    mutationFn: () => publishScheduleDraft(scheduleQuery.data!.id),
    onSuccess: async (publishedSchedule) => {
      queryClient.setQueryData(['weekly-schedule', weekKey], publishedSchedule)
      setBuilderMessage(`Revision ${publishedSchedule.revision} is now live.`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule', weekKey] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['overview-metrics'] }),
      ])
    },
    onError: (error) => {
      setBuilderMessage(error instanceof Error ? error.message : 'The schedule draft could not be published.')
    },
  })
  const cancelDraftMutation = useMutation({
    mutationFn: () => cancelScheduleDraft(scheduleQuery.data!.id),
    onSuccess: async (publishedSchedule) => {
      setCancelDraftConfirmOpen(false)
      setEditingShift(null)
      setBuilderOpen(false)
      queryClient.setQueryData(['weekly-schedule', weekKey], publishedSchedule)
      setBuilderMessage(
        publishedSchedule
          ? `Draft canceled. Showing live revision ${publishedSchedule.revision}.`
          : 'Draft canceled. No published schedule exists for this week yet.',
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule', weekKey] }),
        queryClient.invalidateQueries({ queryKey: ['schedule-staffing-suggestions'] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['overview-metrics'] }),
      ])
    },
    onError: (error) => {
      setBuilderMessage(error instanceof Error ? error.message : 'The schedule draft could not be canceled.')
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
  const employeeRows = useMemo(() => scheduleQuery.data ? employeeScheduleRows(scheduleQuery.data) : [], [scheduleQuery.data])
  const employeeFilterOptions = useMemo(() => {
    const options = new Map<string, { id: string, name: string }>()

    for (const employee of builderOptionsQuery.data?.employees ?? []) {
      options.set(employee.id, {
        id: employee.id,
        name: builderEmployeeName(employee),
      })
    }

    for (const row of employeeRows) {
      if (!options.has(row.id)) options.set(row.id, { id: row.id, name: row.name })
    }

    return [...options.values()].sort((left, right) => left.name.localeCompare(right.name))
  }, [builderOptionsQuery.data?.employees, employeeRows])
  const importedRows = useMemo(
    () => importedPreviewQuery.data ? importedScheduleRows(importedPreviewQuery.data) : [],
    [importedPreviewQuery.data],
  )
  const visibleRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return rows
      .filter((row) => siteFilter === 'all' || row.id === siteFilter)
      .map((row) => ({
        ...row,
        shifts: row.shifts.filter((shift) => {
          const source = parseImportedScheduleNote(shift.notes)
          if (reviewOnly && (!source.reviewNeeded || shiftOperationalDate(shift) < currentOperationalDateKey)) return false
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
  }, [currentOperationalDateKey, rows, reviewOnly, search, siteFilter])
  const visibleEmployeeRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    const selectedEmployee = employeeFilter === 'all'
      ? null
      : employeeFilterOptions.find((employee) => employee.id === employeeFilter) ?? null
    const sourceRows = selectedEmployee && !employeeRows.some((row) => row.id === selectedEmployee.id)
      ? [...employeeRows, { id: selectedEmployee.id, name: selectedEmployee.name, shifts: [] }]
      : employeeRows

    return sourceRows
      .filter((row) => employeeFilter === 'all' || row.id === employeeFilter)
      .map((row) => ({
        ...row,
        shifts: row.shifts.filter((shift) => {
          const source = parseImportedScheduleNote(shift.notes)
          if (reviewOnly && (!source.reviewNeeded || shiftOperationalDate(shift) < currentOperationalDateKey)) return false
          if (!term) return true
          const searchable = [
            row.name,
            shift.post?.name,
            shift.post?.site.name,
            shift.event?.name,
            shift.event?.location_name,
            source.context,
            source.sheet,
          ]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase()
          return searchable.includes(term)
        }),
      }))
      .filter((row) => employeeFilter !== 'all' || row.shifts.length > 0)
  }, [currentOperationalDateKey, employeeFilter, employeeFilterOptions, employeeRows, reviewOnly, search])
  const focusedEmployeeId = scheduleView === 'employee' && employeeFilter !== 'all' ? employeeFilter : null
  const scheduleSummary = useMemo(() => {
    const shifts = rows.flatMap((row) => row.shifts)
    const assigned = shifts.reduce((total, shift) => total + shift.assignments.length, 0)
    const open = shifts.reduce((total, shift) => total + Math.max(shift.headcount_required - shift.assignments.length, 0), 0)
    return {
      assigned,
      employees: employeeRows.length,
      open,
      review: shifts.filter((shift) => parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey).length,
      shifts: shifts.length,
      sites: rows.length,
    }
  }, [currentOperationalDateKey, employeeRows.length, rows])
  const visibleScheduleSummary = useMemo(() => {
    const activeRows = focusedEmployeeId ? visibleEmployeeRows : visibleRows
    const shifts = activeRows.flatMap((row) => row.shifts)
    return {
      open: shifts.reduce((total, shift) => total + Math.max(shift.headcount_required - shift.assignments.length, 0), 0),
      review: shifts.filter((shift) => parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey).length,
      shifts: shifts.length,
    }
  }, [currentOperationalDateKey, focusedEmployeeId, visibleEmployeeRows, visibleRows])
  const staffingWorkItems = useMemo(() => {
    if (scheduleQuery.data?.status !== 'draft') return []
    return scheduleQuery.data.shifts
      .map((shift) => {
        const suggestion = suggestionsByShift.get(shift.id)
        const openSlots = Math.max(shift.headcount_required - shift.assignments.length, 0)
        return {
          openSlots,
          shift,
          suggestion,
          title: shift.post?.site.name
            ? `${shift.post.site.name} / ${shift.post?.name ?? 'Shift'}`
            : shift.event?.name ?? shift.event?.location_name ?? 'Shift',
        }
      })
      .filter((item) => item.openSlots > 0)
      .sort((left, right) => left.shift.starts_at.localeCompare(right.shift.starts_at))
  }, [scheduleQuery.data, suggestionsByShift])
  const reviewNeededCount = useMemo(
    () => rows.reduce((total, row) => total + row.shifts.filter((shift) =>
      parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey,
    ).length, 0),
    [currentOperationalDateKey, rows],
  )
  const reviewItems = useMemo(() => rows.flatMap((row) =>
    row.shifts
      .filter((shift) => parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey)
      .map((shift) => ({
        row,
        shift,
        source: parseImportedScheduleNote(shift.notes),
        sourceReference: sourceReferenceLabel(parseImportedScheduleNote(shift.notes)),
      })),
  ).sort((left, right) => left.shift.starts_at.localeCompare(right.shift.starts_at)), [currentOperationalDateKey, rows])
  const armedReviewCount = useMemo(
    () => reviewItems.filter((item) => item.shift.requires_armed).length,
    [reviewItems],
  )
  const schedulerDayBuckets = useMemo(() => schedulerWorkDays.map((day) => {
    const dayKey = format(day, 'yyyy-MM-dd')
    const schedulerRows = focusedEmployeeId ? visibleEmployeeRows : visibleRows
    const shifts = schedulerRows
      .flatMap((row) => row.shifts)
      .filter((shift) => shiftOperationalDate(shift) === dayKey)
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
    const openSlots = shifts.reduce((total, shift) => total + Math.max(shift.headcount_required - shift.assignments.length, 0), 0)
    const reviewCount = shifts.filter((shift) =>
      parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey,
    ).length
    return { day, dayKey, openSlots, reviewCount, shifts }
  }), [currentOperationalDateKey, focusedEmployeeId, schedulerWorkDays, visibleEmployeeRows, visibleRows])
  const schedulerCoverageGroups = useMemo<SchedulerCoverageGroup[]>(() => visibleRows.map((row) => {
    const lanes = new Map<string, SchedulerCoverageLane>()

    const futureShifts = row.shifts.filter((shift) => shiftOperationalDate(shift) >= currentOperationalDateKey)

    for (const shift of futureShifts) {
      const id = shift.post?.id ?? shift.event?.id ?? shift.id
      const lane = lanes.get(id) ?? {
        id,
        label: shift.post ? 'Post' : 'Event',
        name: shift.post?.name ?? shift.event?.name ?? shift.event?.location_name ?? 'Shift',
        shifts: [],
      }
      lane.shifts.push(shift)
      lanes.set(id, lane)
    }

    const shifts = futureShifts
    const openSlots = shifts.reduce((total, shift) => total + Math.max(shift.headcount_required - shift.assignments.length, 0), 0)
    const reviewCount = shifts.filter((shift) =>
      parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey,
    ).length
    const status: SchedulerCoverageGroup['status'] = shifts.length === 0
      ? 'empty'
      : openSlots > 0
        ? 'has-open'
        : reviewCount > 0
          ? 'needs-review'
          : 'covered'

    return {
      code: row.code,
      id: row.id,
      lanes: [...lanes.values()]
        .map((lane) => ({
          ...lane,
          shifts: [...lane.shifts].sort((left, right) => left.starts_at.localeCompare(right.starts_at)),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      name: row.name,
      openSlots,
      reviewCount,
      shiftCount: shifts.length,
      status,
    }
  }).filter((group) => group.shiftCount > 0), [currentOperationalDateKey, visibleRows])
  const schedulerLocationSummaries = useMemo(() => rows.map((row) => {
    const openSlots = row.shifts.reduce((total, shift) => total + Math.max(shift.headcount_required - shift.assignments.length, 0), 0)
    const reviewCount = row.shifts.filter((shift) =>
      parseImportedScheduleNote(shift.notes).reviewNeeded && shiftOperationalDate(shift) >= currentOperationalDateKey,
    ).length
    const status: SchedulerCoverageGroup['status'] = row.shifts.length === 0
      ? 'empty'
      : openSlots > 0
        ? 'has-open'
        : reviewCount > 0
          ? 'needs-review'
          : 'covered'
    return {
      code: row.code,
      id: row.id,
      name: row.name,
      openSlots,
      reviewCount,
      shiftCount: row.shifts.length,
      status,
    }
  }), [currentOperationalDateKey, rows])
  const selectedPlannerShift = useMemo(() => {
    if (!selectedPlannerShiftId) return null
    return scheduleQuery.data?.shifts.find((shift) => shift.id === selectedPlannerShiftId) ?? null
  }, [scheduleQuery.data?.shifts, selectedPlannerShiftId])
  const visibleImportedRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return importedRows
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
  }, [importedRows, search, siteFilter])
  useEffect(() => {
    const board = boardScrollRef.current
    if (!board) return

    const updateScrollWidth = () => {
      setBoardScrollWidth(board.scrollWidth)
      if (topScrollRef.current) topScrollRef.current.scrollLeft = board.scrollLeft
    }

    updateScrollWidth()
    const observer = new ResizeObserver(updateScrollWidth)
    observer.observe(board)
    const grid = board.querySelector('.schedule-grid')
    if (grid) observer.observe(grid)

    return () => observer.disconnect()
  }, [
    scheduleQuery.data,
    importedPreviewQuery.data,
    scheduleView,
    visibleRows,
    visibleEmployeeRows,
    visibleImportedRows,
  ])

  useEffect(() => {
    if (!selectedPlannerShiftId) return
    if (!scheduleQuery.data?.shifts.some((shift) => shift.id === selectedPlannerShiftId)) {
      setSelectedPlannerShiftId(null)
    }
  }, [scheduleQuery.data?.shifts, selectedPlannerShiftId])

  function updateOpenShiftForm(update: Partial<OpenShiftFormState>) {
    setBuilderMessage(null)
    setOpenShiftForm((current) => ({ ...current, ...update }))
  }

  function openShiftFormForCurrentFocus(): OpenShiftFormState {
    const base = defaultOpenShiftForm(weekKey)
    if (!focusedEmployeeId) return base
    return {
      ...base,
      employeeId: focusedEmployeeId,
      publishAnnouncement: false,
    }
  }

  function jumpToWeek(nextWeekStart: Date) {
    const nextWeekKey = format(nextWeekStart, 'yyyy-MM-dd')
    setWeekStart(nextWeekStart)
    setOpenShiftForm(defaultOpenShiftForm(nextWeekKey))
    setBuilderMessage(null)
    setBuilderOpen(false)
  }

  function handleCreateOpenShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBuilderMessage(null)
    createOpenShiftMutation.mutate()
  }

  function editShift(shift: ScheduleShift) {
    if (!canUseScheduler) return
    setBuilderOpen(false)
    setBuilderMessage(null)
    if (scheduleQuery.data?.status === 'draft') {
      setEditingShift(shift)
      return
    }
    ensureDraftMutation.mutate(shift)
  }

  function applySuggestedEmployee(shift: ScheduleShift, employeeId: string) {
    setBuilderMessage(null)
    updateDraftShiftMutation.mutate(draftShiftMutationInput(shift, employeeId))
  }

  function assignPlannerEmployee(shift: ScheduleShift, employeeId: string | null) {
    setBuilderMessage(null)
    if (scheduleQuery.data?.status === 'draft') {
      updateDraftShiftMutation.mutate(draftShiftMutationInput(shift, employeeId))
      return
    }

    setBuilderMessage('Opening a working draft before saving this assignment...')
    ensureDraftMutation.mutate(shift, {
      onSuccess: ({ draft }) => {
        if (!draft) return
        const copiedShift = findMatchingDraftShift(draft, shift)
        if (!copiedShift) {
          setBuilderMessage('Draft opened, but the selected shift could not be matched. Select the shift again and retry.')
          return
        }
        updateDraftShiftMutation.mutate(draftShiftMutationInput(copiedShift, employeeId))
      },
    })
  }

  function syncBoardScrollFromTop() {
    if (!boardScrollRef.current || !topScrollRef.current) return
    boardScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft
  }

  function syncTopScrollFromBoard() {
    if (!boardScrollRef.current || !topScrollRef.current) return
    topScrollRef.current.scrollLeft = boardScrollRef.current.scrollLeft
  }

  return (
    <div className={isSchedulerHome ? 'page page--schedule page--scheduler' : 'page page--schedule'}>
      <section className="page-intro schedule-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>{isSchedulerHome ? 'Scheduler' : 'Schedule'}</h1>
          <p className="page-summary">
            {isSchedulerHome
              ? 'Build the week from a focused planning board, make changes safely, and publish only when coverage is ready.'
              : 'A readable weekly view for permanent sites, one-time events, patrol, and dispatch coverage.'}
          </p>
        </div>
        {canBuildSchedule && !isSchedulerHome ? (
          <div className="schedule-intro__actions">
            <Link className="primary-action" to="/scheduler">
              <Edit3 aria-hidden="true" size={19} />
              Open Scheduler
            </Link>
          </div>
        ) : null}
      </section>

      {builderMessage ? (
        <p className={builderMessage.toLowerCase().includes('could not') ? 'form-feedback form-feedback--error' : 'form-feedback form-feedback--success'} role="status">
          {builderMessage}
        </p>
      ) : null}

      {canUseScheduler && cancelDraftConfirmOpen && scheduleQuery.data?.status === 'draft' ? (
        <ModalDialog
          description={`This will discard draft revision ${scheduleQuery.data.revision} for ${format(weekStart, 'MM/dd/yyyy')} - ${format(weekEnd, 'MM/dd/yyyy')}.`}
          onClose={() => setCancelDraftConfirmOpen(false)}
          title="Cancel this schedule draft?"
        >
          <div className="confirmation-summary">
            <strong>This does not delete the live schedule.</strong>
            <span>The draft will be archived and the week will return to the latest published revision.</span>
            <span>Any unpublished draft edits, assignments, one-time events, or open-shift changes in this draft will not go live.</span>
          </div>
          {cancelDraftMutation.isError ? (
            <p className="form-feedback form-feedback--error" role="alert">{cancelDraftMutation.error.message}</p>
          ) : null}
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setCancelDraftConfirmOpen(false)} type="button">
              Keep working
            </button>
            <button
              className="primary-action danger-primary"
              disabled={cancelDraftMutation.isPending}
              onClick={() => cancelDraftMutation.mutate()}
              type="button"
            >
              {cancelDraftMutation.isPending ? 'Canceling draft...' : 'Discard draft'}
            </button>
          </div>
        </ModalDialog>
      ) : null}

      {canUseScheduler ? (
        <section className={scheduleQuery.data?.status === 'draft' ? 'scheduler-workspace scheduler-workspace--draft' : 'scheduler-workspace'} aria-label="Scheduler workspace">
          <div className="scheduler-workspace__hero">
            <div>
              <p className="eyebrow">Planning command center</p>
              <h2>
                {scheduleQuery.data?.status === 'draft'
                  ? `Draft revision ${scheduleQuery.data.revision} is open`
                  : 'Plan the next six weeks'}
              </h2>
              <p>
                {scheduleQuery.data?.status === 'draft'
                  ? 'Make changes one week at a time. Nothing goes live until you publish.'
                  : 'Choose a week, let SygShift surface the coverage needs, then add or adjust shifts before publishing.'}
              </p>
            </div>
            <div className="scheduler-workspace__actions">
              {scheduleQuery.data?.status === 'draft' ? (
                <>
                  <button className="primary-action" disabled={publishDraftMutation.isPending} onClick={() => publishDraftMutation.mutate()} type="button">
                    {publishDraftMutation.isPending ? 'Publishing...' : 'Confirm & publish draft'}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={cancelDraftMutation.isPending}
                    onClick={() => setCancelDraftConfirmOpen(true)}
                    type="button"
                  >
                    {cancelDraftMutation.isPending ? 'Canceling...' : 'Cancel draft'}
                  </button>
                </>
              ) : (
                <button
                  className="primary-action"
                  disabled={ensureDraftMutation.isPending}
                  onClick={() => ensureDraftMutation.mutate(undefined)}
                  type="button"
                >
                  {ensureDraftMutation.isPending ? 'Opening draft...' : 'Start schedule work'}
                </button>
              )}
              <button
                className="secondary-button"
                onClick={() => {
                  setBuilderOpen(true)
                  setOpenShiftForm(openShiftFormForCurrentFocus())
                  setBuilderMessage(null)
                }}
                type="button"
              >
                <Plus aria-hidden="true" size={18} />
                Add shift or event
              </button>
            </div>
          </div>

          <div className="scheduler-week-strip" aria-label="Six-week planning shortcuts">
            {planningWeeks.map((week) => (
              <button
                className={week.key === weekKey ? 'scheduler-week-tile is-active' : 'scheduler-week-tile'}
                key={week.key}
                onClick={() => jumpToWeek(week.startsOn)}
                type="button"
              >
                <span>{week.label}</span>
                <strong>{week.range}</strong>
              </button>
            ))}
          </div>

          {scheduleQuery.data?.status === 'draft' ? (
            <div className="draft-guidance-grid">
              <article>
                <span>1</span>
                <strong>Pick the week</strong>
                <p>Use the six-week strip to choose the week you want to build or clean up.</p>
              </article>
              <article>
                <span>2</span>
                <strong>Fix what matters</strong>
                <p>Open slots and review items are called out first so supervisors are not hunting through clutter.</p>
              </article>
              <article>
                <span>3</span>
                <strong>Publish once</strong>
                <p>Review the week, make manual changes if needed, then publish the clean schedule.</p>
              </article>
            </div>
          ) : null}
        </section>
      ) : null}

      {scheduleQuery.data?.status === 'draft' && canUseScheduler ? (
        <section className="panel scheduler-suggestions" aria-labelledby="scheduler-suggestions-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Suggested staffing</p>
              <h2 id="scheduler-suggestions-title">Open draft slots SygShift can help fill</h2>
            </div>
            <span className={staffingWorkItems.length ? 'status-pill status-pill--attention' : 'status-pill'}>
              {staffingWorkItems.length ? `${staffingWorkItems.length} need attention` : 'Covered'}
            </span>
          </div>
          {staffingSuggestionsQuery.isPending ? (
            <div className="scheduler-suggestion-empty">
              <Sparkles aria-hidden="true" size={24} />
              <p>Checking active employees, credentials, and conflicts for this draft.</p>
            </div>
          ) : staffingWorkItems.length === 0 ? (
            <div className="scheduler-suggestion-empty">
              <Sparkles aria-hidden="true" size={24} />
              <p>No open draft slots need suggested staffing right now.</p>
            </div>
          ) : (
            <div className="scheduler-suggestion-list">
              {staffingWorkItems.slice(0, 6).map((item) => (
                <article className="scheduler-suggestion-item" key={item.shift.id}>
                  <div>
                    <div className="schedule-review-item__meta">
                      <span>{shiftOperationalDate(item.shift)}</span>
                      <span>{shiftTimeRange(item.shift)}</span>
                      {item.shift.requires_armed ? <span>Armed</span> : <span>Unarmed</span>}
                      <span>{item.openSlots} open</span>
                    </div>
                    <h3>{item.title}</h3>
                    {item.suggestion?.suggestions.length ? (
                      <p>
                        Best matches: {item.suggestion.suggestions.slice(0, 3).map((candidate) => `${candidate.name} (${candidate.reason})`).join('; ')}
                      </p>
                    ) : (
                      <p>No safe active employee suggestion was found for this slot. Add it manually or leave it open.</p>
                    )}
                  </div>
                  <div className="scheduler-suggestion-actions">
                    {item.suggestion?.suggestions[0] ? (
                      <button
                        className="primary-action"
                        disabled={updateDraftShiftMutation.isPending}
                        onClick={() => applySuggestedEmployee(item.shift, item.suggestion!.suggestions[0].employeeId)}
                        type="button"
                      >
                        Assign best match
                      </button>
                    ) : null}
                    <button className="secondary-button" onClick={() => setEditingShift(item.shift)} type="button">
                      Edit manually
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {canUseScheduler && builderOpen ? (
        <section className="panel schedule-builder" aria-labelledby="schedule-builder-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Supervisor action</p>
              <h2 id="schedule-builder-heading">Add a shift or event</h2>
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
                  max={format(weekEnd, 'yyyy-MM-dd')}
                  min={weekKey}
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
              <label>
                Assign now <small>Optional</small>
                <select
                  disabled={builderOptionsQuery.isPending}
                  onChange={(event) => updateOpenShiftForm({
                    employeeId: event.target.value,
                    publishAnnouncement: event.target.value ? false : openShiftForm.publishAnnouncement,
                  })}
                  value={openShiftForm.employeeId}
                >
                  <option value="">Leave open for requests</option>
                  {builderOptionsQuery.data?.employees
                    .filter((employee) => openShiftForm.mode === 'event' && openShiftForm.eventRequiresArmed ? employee.has_armed_guard_credential : true)
                    .filter((employee) => selectedPost?.requires_armed ? employee.has_armed_guard_credential : true)
                    .map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {builderEmployeeName(employee)}
                        {employee.has_armed_guard_credential ? ' · armed' : ''}
                        {employee.employment_type === 'salary' ? ' · salary' : ''}
                      </option>
                    ))}
                </select>
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
                  checked={!openShiftForm.employeeId && openShiftForm.publishAnnouncement}
                  disabled={Boolean(openShiftForm.employeeId)}
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
                {createOpenShiftMutation.isPending
                  ? 'Publishing...'
                  : openShiftForm.employeeId
                    ? 'Publish assigned shift'
                    : 'Publish open shift'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {canUseScheduler && resolvingShift ? (
        <ReviewResolutionDialog
          employees={builderOptionsQuery.data?.employees ?? []}
          mutation={resolveReviewMutation}
          onClose={() => setResolvingShift(null)}
          shift={resolvingShift}
        />
      ) : null}

      {canUseScheduler && editingShift ? (
        <EditShiftDialog
          employees={builderOptionsQuery.data?.employees ?? []}
          focusEmployeeId={focusedEmployeeId}
          mutation={updateDraftShiftMutation}
          onClose={() => setEditingShift(null)}
          shift={editingShift}
          suggestions={staffingSuggestionsQuery.data?.find((item) => item.shiftId === editingShift.id)}
        />
      ) : null}

      {canUseScheduler && reviewItems.length > 0 ? (
        <section className="panel schedule-review-workbench" aria-labelledby="schedule-review-workbench-title">
          <div className="schedule-review-workbench__heading">
            <div>
              <p className="eyebrow">Supervisor cleanup</p>
              <h2 id="schedule-review-workbench-title">Review needed workbench</h2>
              <p>
                These shifts need an operations decision before the schedule can be trusted. Resolve each one
                after confirming the correct employee.
              </p>
            </div>
            <div className="schedule-review-workbench__metrics" aria-label="Review needed totals">
              <article>
                <span>Total</span>
                <strong>{reviewItems.length}</strong>
              </article>
              <article>
                <span>Armed</span>
                <strong>{armedReviewCount}</strong>
              </article>
              <article>
                <span>Unarmed</span>
                <strong>{reviewItems.length - armedReviewCount}</strong>
              </article>
            </div>
          </div>
          <div className="schedule-review-list" aria-label="Current week review-needed shifts">
            {reviewItems.slice(0, 12).map((item) => (
              <article className="schedule-review-item" key={item.shift.id}>
                <div>
                  <div className="schedule-review-item__meta">
                    <span>{shiftOperationalDate(item.shift)}</span>
                    <span>{shiftTimeRange(item.shift)}</span>
                    {item.shift.requires_armed ? <span>Armed</span> : <span>Unarmed</span>}
                  </div>
                  <h3>{item.row.name}</h3>
                  <p>
                    {item.source.assignee ? `Original assignee: ${item.source.assignee}` : 'Original assignee not named'}
                    {item.source.context ? ` · Schedule context: ${item.source.context}` : ''}
                  </p>
                  {item.sourceReference ? <small>{item.sourceReference}</small> : null}
                </div>
                <button
                  className="primary-action"
                  onClick={() => {
                    setReviewOnly(true)
                    setBuilderOpen(false)
                    setBuilderMessage(null)
                    setResolvingShift(item.shift)
                  }}
                  type="button"
                >
                  Resolve
                </button>
              </article>
            ))}
          </div>
          {reviewItems.length > 12 ? (
            <p className="schedule-review-workbench__more">
              Showing the next 12 review items for this week. Use “Show review needed only” below to work through the full board.
            </p>
          ) : null}
        </section>
      ) : null}

      {scheduleQuery.data ? (
        <section className="schedule-admin-summary" aria-label="Published schedule summary">
          <article><span>{scheduleQuery.data.status === 'draft' ? 'Draft shifts' : 'Published shifts'}</span><strong>{scheduleSummary.shifts}</strong><small>Revision {scheduleQuery.data.revision}</small></article>
          <article><span>Assigned slots</span><strong>{scheduleSummary.assigned}</strong><small>{scheduleSummary.employees} employees on schedule</small></article>
          <article className={scheduleSummary.open ? 'import-metric--attention' : ''}><span>Open slots</span><strong>{scheduleSummary.open}</strong><small>Visible in openings/request workflows</small></article>
          <article className={scheduleSummary.review ? 'import-metric--attention' : ''}><span>Review needed</span><strong>{scheduleSummary.review}</strong><small>Schedule items needing supervisor cleanup</small></article>
        </section>
      ) : null}

      {isSchedulerHome ? (
        <section className="scheduler-planner" aria-labelledby="scheduler-planner-title">
          <div className="scheduler-planner__heading">
            <div>
              <p className="eyebrow">Week planner</p>
              <h2 id="scheduler-planner-title">
                {format(weekStart, 'MM/dd/yyyy')} – {format(weekEnd, 'MM/dd/yyyy')}
              </h2>
              <p>Work coverage by site and post, select a shift for details, then assign, edit, or resolve review items from one focused panel.</p>
              <div className="scheduler-planner__week-nav" aria-label="Planner week controls">
                <button
                  aria-label="Previous week"
                  className="secondary-button secondary-button--small"
                  onClick={() => jumpToWeek(addWeeks(weekStart, -1))}
                  type="button"
                >
                  <ChevronLeft aria-hidden="true" size={17} />
                  Previous
                </button>
                <button
                  className="secondary-button secondary-button--small"
                  onClick={() => jumpToWeek(startOfWeek(today, { weekStartsOn: 0 }))}
                  type="button"
                >
                  This week
                </button>
                <button
                  aria-label="Next week"
                  className="secondary-button secondary-button--small"
                  onClick={() => jumpToWeek(addWeeks(weekStart, 1))}
                  type="button"
                >
                  Next
                  <ChevronRight aria-hidden="true" size={17} />
                </button>
              </div>
              {scheduleQuery.data ? (
                <div className="scheduler-focus-controls" aria-label="Scheduler focus controls">
                  <div className="segmented-control" aria-label="Work schedule by">
                    <button
                      className={scheduleView === 'site' ? 'is-active' : ''}
                      onClick={() => setScheduleView('site')}
                      type="button"
                    >
                      Site coverage
                    </button>
                    <button
                      className={scheduleView === 'employee' ? 'is-active' : ''}
                      onClick={() => setScheduleView('employee')}
                      type="button"
                    >
                      Employee schedule
                    </button>
                  </div>
                  {scheduleView === 'employee' ? (
                    <label className="scheduler-employee-filter">
                      <span>Employee</span>
                      <select
                        aria-label="Work on employee schedule"
                        onChange={(event) => setEmployeeFilter(event.target.value)}
                        value={employeeFilter}
                      >
                        <option value="all">All employees</option>
                        {employeeFilterOptions.map((employee) => (
                          <option key={employee.id} value={employee.id}>{employee.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="scheduler-planner__totals" aria-label="Planner totals">
              <article><span>{scheduleView === 'employee' && employeeFilter !== 'all' ? 'Person shifts' : 'Visible shifts'}</span><strong>{visibleScheduleSummary.shifts}</strong></article>
              <article><span>Open</span><strong>{visibleScheduleSummary.open}</strong></article>
              <article><span>Review</span><strong>{visibleScheduleSummary.review}</strong></article>
            </div>
          </div>

          {!isSupabaseConfigured ? (
            <DataStatePanel icon={DatabaseZap} title="Scheduler ready for the secure connection">
              <p>Scheduling tools activate after the protected database connection is configured.</p>
            </DataStatePanel>
          ) : scheduleQuery.isPending ? (
            <DataStatePanel icon={CalendarDays} title="Loading planner">
              <p>Retrieving the schedule revision for this planning week.</p>
            </DataStatePanel>
          ) : scheduleQuery.isError ? (
            <DataStatePanel icon={ShieldAlert} title="Scheduler unavailable" tone="error">
              <p>{scheduleQuery.error.message}</p>
            </DataStatePanel>
          ) : !scheduleQuery.data ? (
            <DataStatePanel icon={CalendarDays} title="No schedule exists for this week">
              <p>Open a working draft or add a shift/event to start building this week.</p>
            </DataStatePanel>
          ) : scheduleView === 'site' ? (
            <div className="scheduler-board-shell">
              <aside className="scheduler-location-rail" aria-label="Scheduler site filter">
                <header>
                  <strong>Sites</strong>
                  <span>{schedulerLocationSummaries.length} active this week</span>
                </header>
                <button
                  className={siteFilter === 'all' ? 'scheduler-location-button is-active' : 'scheduler-location-button'}
                  onClick={() => setSiteFilter('all')}
                  type="button"
                >
                  <span>All sites</span>
                  <small>{scheduleSummary.shifts} shifts</small>
                </button>
                <div className="scheduler-location-list">
                  {schedulerLocationSummaries.map((site) => (
                    <button
                      className={siteFilter === site.id ? 'scheduler-location-button is-active' : 'scheduler-location-button'}
                      key={site.id}
                      onClick={() => setSiteFilter(site.id)}
                      type="button"
                    >
                      <span>
                        <i className={`scheduler-status-dot scheduler-status-dot--${site.status}`} aria-hidden="true" />
                        {site.name}
                      </span>
                      <small>{site.openSlots ? `${site.openSlots} open` : site.reviewCount ? `${site.reviewCount} review` : `${site.shiftCount} shifts`}</small>
                    </button>
                  ))}
                </div>
              </aside>

              <div className="scheduler-coverage-board" aria-label="Weekly site coverage planner">
                <div className="scheduler-coverage-board__scroller">
                  {schedulerCoverageGroups.length ? schedulerCoverageGroups.map((group) => (
                    <article className="scheduler-coverage-location" key={group.id}>
                      <header>
                        <div>
                          <MapPin aria-hidden="true" size={18} />
                          <div>
                            <span>{group.code ?? (group.lanes.some((lane) => lane.label === 'Event') ? 'Event' : 'Site')}</span>
                            <strong>{group.name}</strong>
                          </div>
                        </div>
                        <div className="scheduler-location-badges">
                          {group.openSlots ? <span className="status-pill status-pill--attention">{group.openSlots} open</span> : null}
                          {group.reviewCount ? <span className="status-pill status-pill--warning">{group.reviewCount} review</span> : null}
                          {!group.openSlots && !group.reviewCount ? <span className="status-pill">Covered</span> : null}
                        </div>
                      </header>

                      <div className="scheduler-coverage-grid" role="table" aria-label={`${group.name} weekly coverage`}>
                        <div className="scheduler-coverage-row scheduler-coverage-row--header" role="row">
                          <div role="columnheader">Post</div>
                          {schedulerWorkDays.map((day) => (
                            <div key={day.toISOString()} role="columnheader">
                              <span>{format(day, 'EEE')}</span>
                              <strong>{format(day, 'MM/dd/yyyy')}</strong>
                            </div>
                          ))}
                        </div>
                        {group.lanes.map((lane) => (
                          <div className="scheduler-coverage-row" key={lane.id} role="row">
                            <div className="scheduler-coverage-post" role="rowheader">
                              <span>{lane.label}</span>
                              <strong>{lane.name}</strong>
                            </div>
                            {schedulerWorkDays.map((day) => {
                              const dayKey = format(day, 'yyyy-MM-dd')
                              const shifts = lane.shifts.filter((shift) => shiftOperationalDate(shift) === dayKey)
                              return (
                                <div className="scheduler-coverage-cell" key={dayKey} role="cell">
                                  {shifts.map((shift) => (
                                    <ShiftCard
                                      canEdit
                                      canResolve={canUseScheduler}
                                      compact
                                      key={shift.id}
                                      onEdit={(targetShift) => setSelectedPlannerShiftId(targetShift.id)}
                                      onResolve={(targetShift) => {
                                        setBuilderOpen(false)
                                        setBuilderMessage(null)
                                        setResolvingShift(targetShift)
                                      }}
                                      selected={selectedPlannerShiftId === shift.id}
                                      shift={shift}
                                    />
                                  ))}
                                  {shifts.length === 0 ? <span className="scheduler-coverage-empty">—</span> : null}
                                </div>
                              )
                            })}
                          </div>
                        ))}
                      </div>
                    </article>
                  )) : (
                    <div className="scheduler-board-empty">
                      <Search aria-hidden="true" size={28} />
                      <strong>No site coverage matches these filters.</strong>
                      <span>Clear the search or choose all sites to continue working this schedule.</span>
                    </div>
                  )}
                </div>
              </div>

              {selectedPlannerShift ? (
                <SchedulerShiftPanel
                  employees={builderOptionsQuery.data?.employees ?? []}
                  isDraft={scheduleQuery.data.status === 'draft'}
                  isSaving={updateDraftShiftMutation.isPending}
                  onAssignEmployee={(employeeId) => assignPlannerEmployee(selectedPlannerShift, employeeId)}
                  onClose={() => setSelectedPlannerShiftId(null)}
                  onEdit={() => editShift(selectedPlannerShift)}
                  onResolve={() => {
                    setBuilderOpen(false)
                    setBuilderMessage(null)
                    setResolvingShift(selectedPlannerShift)
                  }}
                  shift={selectedPlannerShift}
                  suggestion={staffingSuggestionsQuery.data?.find((item) => item.shiftId === selectedPlannerShift.id)}
                />
              ) : (
                <aside className="scheduler-shift-panel scheduler-shift-panel--empty" aria-label="No selected shift">
                  <Sparkles aria-hidden="true" size={24} />
                  <strong>Select a shift</strong>
                  <span>Click any schedule block to inspect details, assign suggested staff, or open the full editor.</span>
                </aside>
              )}
            </div>
          ) : (
            <div className="scheduler-day-board">
              {schedulerDayBuckets.map((bucket) => (
                <article className="scheduler-day-column" key={bucket.dayKey}>
                  <header>
                    <div>
                      <span>{format(bucket.day, 'EEE')}</span>
                      <strong>{format(bucket.day, 'MM/dd/yyyy')}</strong>
                    </div>
                    <small>
                      {bucket.shifts.length} shift{bucket.shifts.length === 1 ? '' : 's'}
                      {bucket.openSlots ? ` · ${bucket.openSlots} open` : ''}
                    </small>
                  </header>
                  {bucket.reviewCount ? (
                    <p className="scheduler-day-column__alert">{bucket.reviewCount} review item{bucket.reviewCount === 1 ? '' : 's'}</p>
                  ) : null}
                  <div className="scheduler-day-column__cards">
                    {bucket.shifts.length ? bucket.shifts.map((shift) => (
                      <ShiftCard
                        canEdit={canUseScheduler}
                        canResolve={canUseScheduler}
                        compact
                        key={shift.id}
                        onEdit={editShift}
                        onResolve={(targetShift) => {
                          setBuilderOpen(false)
                          setBuilderMessage(null)
                          setResolvingShift(targetShift)
                        }}
                        shift={shift}
                      />
                    )) : (
                      <div className="scheduler-day-empty">
                        <strong>{scheduleView === 'employee' && employeeFilter !== 'all' ? 'No shifts for this employee' : 'No coverage yet'}</strong>
                        <span>{scheduleView === 'employee' && employeeFilter !== 'all' ? 'Use Add shift or event to assign this person if needed.' : 'Add a shift/event if this day needs staffing.'}</span>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {!isSchedulerHome ? (
      <section className="schedule-toolbar" aria-label="Schedule controls">
        <div className="week-controls">
          <button
            aria-label="Previous week"
            className="icon-button"
            onClick={() => jumpToWeek(addWeeks(weekStart, -1))}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={22} />
          </button>
          <button
            className="secondary-button"
            onClick={() => jumpToWeek(startOfWeek(today, { weekStartsOn: 0 }))}
            type="button"
          >
            Today
          </button>
          <button
            aria-label="Next week"
            className="icon-button"
            onClick={() => jumpToWeek(addWeeks(weekStart, 1))}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={22} />
          </button>
          <h2>
            {format(weekStart, 'MM/dd/yyyy')} – {format(weekEnd, 'MM/dd/yyyy')}
          </h2>
        </div>

        <div className="schedule-filters">
          {scheduleQuery.data ? (
            <div className="segmented-control" aria-label="Schedule view">
              <button
                className={scheduleView === 'site' ? 'is-active' : ''}
                onClick={() => setScheduleView('site')}
                type="button"
              >
                Site coverage
              </button>
              <button
                className={scheduleView === 'employee' ? 'is-active' : ''}
                onClick={() => setScheduleView('employee')}
                type="button"
              >
                Employee view
              </button>
            </div>
          ) : null}
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
          {scheduleView === 'employee' && scheduleQuery.data ? (
            <label>
              <span className="visually-hidden">Filter by employee</span>
              <select
                aria-label="Filter by employee"
                onChange={(event) => setEmployeeFilter(event.target.value)}
                value={employeeFilter}
              >
                <option value="all">All employees</option>
                {employeeFilterOptions.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}
              </select>
            </label>
          ) : (
          <label>
            <span className="visually-hidden">Filter by site</span>
            <select
              aria-label="Filter by site"
              onChange={(event) => setSiteFilter(event.target.value)}
              value={siteFilter}
            >
              <option value="all">All sites</option>
              {(rows.length > 0 ? rows : importedRows).map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}
            </select>
          </label>
          )}
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
      ) : null}

      {!scheduleQuery.data && importedPreviewQuery.data ? (
        <section className="source-schedule-banner" aria-label="Schedule status">
          <div>
            <p className="eyebrow">Historical schedule preview</p>
            <strong>{importedPreviewQuery.data.sourceSheetName ?? 'Schedule week'}</strong>
            <span>
              No published operational revision exists for this selected week yet. Create a reviewed revision before relying on this week.
            </span>
          </div>
          <div className="source-schedule-banner__counts">
            <span>{importedPreviewQuery.data.shifts.length} schedule shifts</span>
            <span>{importedPreviewQuery.data.blockingIssueCount} blockers</span>
            <span>{importedPreviewQuery.data.warningIssueCount} warnings</span>
          </div>
        </section>
      ) : null}

      {!isSchedulerHome ? (
        <p className="schedule-scroll-hint" id="schedule-scroll-instructions">
          <MoveHorizontal aria-hidden="true" size={19} />
          Scroll horizontally to see all seven days
        </p>
      ) : null}

      {!isSchedulerHome ? (
        <div
        aria-label="Horizontal schedule scroll"
        className="schedule-scrollbar"
        onScroll={syncBoardScrollFromTop}
        ref={topScrollRef}
        role="region"
        tabIndex={0}
      >
        <div style={{ width: `${Math.max(boardScrollWidth, 1)}px` }} />
        </div>
      ) : null}

      {!isSchedulerHome ? (
        <section className="schedule-mobile-list" aria-label="Mobile schedule view">
          {scheduleQuery.data ? days.map((day) => {
            const dayKey = format(day, 'yyyy-MM-dd')
            const activeRows = scheduleView === 'employee' ? visibleEmployeeRows : visibleRows
            const rowsForDay = activeRows
              .map((row) => ({ ...row, shifts: row.shifts.filter((shift) => shiftOperationalDate(shift) === dayKey) }))
              .filter((row) => row.shifts.length > 0)
            return (
              <article className="mobile-schedule-day" key={dayKey}>
                <header>
                  <span>{format(day, 'EEEE')}</span>
                  <strong>{format(day, 'MM/dd/yyyy')}</strong>
                </header>
                {rowsForDay.length ? rowsForDay.map((row) => (
                  <div className="mobile-schedule-location" key={row.id}>
                    <div className="mobile-schedule-location__title">
                      <span>{mobileScheduleRowLabel(row, scheduleView)}</span>
                      <strong>{row.name}</strong>
                    </div>
                    {row.shifts.map((shift) => (
                      <ShiftCard
                        canEdit={canUseScheduler}
                        canResolve={canUseScheduler}
                        compact
                        key={shift.id}
                        onEdit={editShift}
                        onResolve={(targetShift) => {
                          setBuilderOpen(false)
                          setBuilderMessage(null)
                          setResolvingShift(targetShift)
                        }}
                        shift={shift}
                      />
                    ))}
                  </div>
                )) : (
                  <p className="mobile-schedule-empty">No shifts scheduled.</p>
                )}
              </article>
            )
          }) : !scheduleQuery.data && importedPreviewQuery.data && visibleImportedRows.length > 0 ? days.map((day) => {
            const dayKey = format(day, 'yyyy-MM-dd')
            const rowsForDay = visibleImportedRows
              .map((row) => ({ ...row, shifts: row.shifts.filter((shift) => shift.localDate === dayKey) }))
              .filter((row) => row.shifts.length > 0)
            return (
              <article className="mobile-schedule-day" key={dayKey}>
                <header>
                  <span>{format(day, 'EEEE')}</span>
                  <strong>{format(day, 'MM/dd/yyyy')}</strong>
                </header>
                {rowsForDay.length ? rowsForDay.map((row) => (
                  <div className="mobile-schedule-location" key={row.id}>
                    <div className="mobile-schedule-location__title">
                      <span>{sourceQualificationLabel(row.qualification)}</span>
                      <strong>{row.name}</strong>
                    </div>
                    {row.shifts.map((shift) => <ImportedShiftCard shift={shift} key={shift.id} />)}
                  </div>
                )) : (
                  <p className="mobile-schedule-empty">No shifts scheduled.</p>
                )}
              </article>
            )
          }) : (
            <DataStatePanel icon={CalendarDays} title="No schedule to show">
              <p>Select a week with published coverage or create a reviewed schedule revision.</p>
            </DataStatePanel>
          )}
        </section>
      ) : null}

      {!isSchedulerHome ? (
        <section
        aria-describedby="schedule-scroll-instructions"
        aria-labelledby="schedule-board-heading"
        className="schedule-board"
        onScroll={syncTopScrollFromBoard}
        ref={boardScrollRef}
        tabIndex={0}
      >
        <h2 className="visually-hidden" id="schedule-board-heading">
          Weekly coverage
        </h2>
        <div className="schedule-grid" role="table" aria-label="Weekly schedule">
          <div className="schedule-row schedule-row--header" role="row">
            <div className="schedule-site-column" role="columnheader">
              Site / post
            </div>
            {days.map((day) => (
              <div className="schedule-day-column" key={day.toISOString()} role="columnheader">
                <span>{format(day, 'EEE')}</span>
                <strong>{format(day, 'MM/dd/yyyy')}</strong>
              </div>
            ))}
          </div>
          {!isSupabaseConfigured ? (
            <div className="schedule-empty" role="row">
              <div role="cell">
                <DatabaseZap aria-hidden="true" size={34} />
                <strong>Schedule ready for the secure connection.</strong>
                <p>
                  Coverage remains empty until the secure schedule is published.
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
          ) : !scheduleQuery.data && importedPreviewQuery.isPending ? (
            <div className="schedule-state" role="row">
              <div role="cell">
                <DataStatePanel icon={CalendarDays} title="Checking schedule data">
                  <p>Looking for a published operational week.</p>
                </DataStatePanel>
              </div>
            </div>
          ) : !scheduleQuery.data && importedPreviewQuery.data && visibleImportedRows.length > 0 ? (
            visibleImportedRows.map((row) => (
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
                      {shifts.map((shift) => <ImportedShiftCard shift={shift} key={shift.id} />)}
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
                <strong>No published schedule exists for this selected week.</strong>
                <p>Create a reviewed schedule revision for this week, then publish it when coverage is ready.</p>
              </div>
            </div>
          ) : scheduleView === 'employee' && visibleEmployeeRows.length === 0 ? (
            <div className="schedule-empty" role="row">
              <div role="cell">
                <Search aria-hidden="true" size={34} />
                <strong>No employee schedules match these filters.</strong>
                <p>Clear the search or select all employees to see assigned coverage for this week.</p>
              </div>
            </div>
          ) : scheduleView === 'employee' ? visibleEmployeeRows.map((row) => (
            <div className="schedule-row schedule-row--coverage" role="row" key={row.id}>
              <div className="schedule-location" role="rowheader">
                <span>Employee</span>
                <strong>{row.name}</strong>
              </div>
              {days.map((day) => {
                const dayKey = format(day, 'yyyy-MM-dd')
                const shifts = row.shifts.filter((shift) => shiftOperationalDate(shift) === dayKey)
                return (
                  <div className="schedule-day-cell" role="cell" key={dayKey}>
                    {shifts.map((shift) => (
                      <ShiftCard
                        canEdit={canUseScheduler}
                        canResolve={canUseScheduler}
                        compact
                        key={shift.id}
                        onEdit={editShift}
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
          )) : visibleRows.length === 0 ? (
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
                        canEdit={canUseScheduler}
                        canResolve={canUseScheduler}
                        key={shift.id}
                        onEdit={editShift}
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
      ) : null}
    </div>
  )
}

export function SchedulerPage() {
  return <SchedulePage mode="scheduler" />
}

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  History,
  Search,
  ShieldAlert,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  getSalariedShiftWorkspace,
  recordSalariedShiftOutcome,
  salariedShiftWorkspaceQueryKey,
  type SalariedShiftAssignment,
  type SalariedShiftPresenceStatus,
} from '../data/salariedShiftTracking'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatDualTimeRange } from '../lib/time'
import { continentalUsTimeZoneLabel } from '../lib/usTimeZones'
import {
  TimeAlertCard,
  TimeButton,
  TimeEmptyState,
  TimeMetricCard,
  TimePageHeader,
  TimeStatusBadge,
} from '../time/TimeKit'

type PresenceFilter = 'all' | 'ready' | 'scheduled' | 'worked'

function formatDateKey(value: string): string {
  const [year, month, day] = value.split('-')
  return year && month && day ? `${month}/${day}/${year}` : value
}

function formatTimestamp(value: string, timeZone: string): string {
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

function assignmentTitle(assignment: SalariedShiftAssignment): string {
  return assignment.postName ?? assignment.eventName ?? assignment.location
}

function matchesSearch(assignment: SalariedShiftAssignment, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return true
  return [
    assignment.employee.displayName,
    assignment.employee.employeeNumber,
    assignment.siteCode,
    assignment.siteName,
    assignment.postName,
    assignment.eventName,
    assignment.location,
  ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)
}

function inclusiveRangeDays(startsOn: string, endsOn: string): number {
  const starts = Date.parse(`${startsOn}T00:00:00Z`)
  const ends = Date.parse(`${endsOn}T00:00:00Z`)
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return 0
  return Math.floor((ends - starts) / 86_400_000) + 1
}

function lastHistoryAction(assignment: SalariedShiftAssignment): 'worked' | 'voided' | null {
  return assignment.history.at(-1)?.action ?? null
}

function ShiftPresenceCard({
  assignment,
  onMarkWorked,
  onVoid,
  viewerTimeZone,
}: {
  assignment: SalariedShiftAssignment
  onMarkWorked: (assignment: SalariedShiftAssignment) => void
  onVoid: (assignment: SalariedShiftAssignment) => void
  viewerTimeZone: string
}) {
  const isScheduled = assignment.presenceStatus === 'unconfirmed' && assignment.blockingReason === 'shift_not_ended'
  const statusLabel = assignment.presenceStatus === 'worked' ? 'Worked' : isScheduled ? 'Scheduled' : 'Ready to mark'
  return (
    <article className={`salary-shift-record salary-shift-record--${assignment.presenceStatus}`}>
      <div className="salary-shift-record__identity">
        <div>
          <span className="salary-shift-record__employee">{assignment.employee.displayName}{assignment.employee.employeeNumber ? ` · ${assignment.employee.employeeNumber}` : ''}</span>
          <h3>{assignmentTitle(assignment)}</h3>
          <p>{assignment.location}</p>
        </div>
        <TimeStatusBadge tone={assignment.presenceStatus === 'worked' ? 'good' : isScheduled ? 'neutral' : 'warning'}>
          {statusLabel}
        </TimeStatusBadge>
      </div>

      <div className="salary-shift-record__schedule" aria-label="Scheduled shift reference">
        <CalendarDays aria-hidden="true" size={19} />
        <div>
          <strong>{formatDateKey(assignment.workday)}</strong>
          <span>Scheduled: {formatDualTimeRange(assignment.startsAt, assignment.endsAt, assignment.shiftTimeZone)} · {continentalUsTimeZoneLabel(assignment.shiftTimeZone)}</span>
          <small>The schedule identifies the shift. This record does not store arrival, departure, duration, or hours.</small>
        </div>
      </div>

      {assignment.presenceStatus === 'worked' ? (
        <div className="salary-shift-record__evidence">
          <span>Marked Worked by {assignment.recordedBy?.displayName ?? 'Authorized manager'}{assignment.workedAt ? ` · ${formatTimestamp(assignment.workedAt, viewerTimeZone)}` : ''}</span>
          {assignment.recordedNote ? <p>{assignment.recordedNote}</p> : null}
        </div>
      ) : assignment.blockingReason === 'shift_not_ended' ? (
        <p className="salary-shift-record__reason">This shift can be marked after its scheduled end.</p>
      ) : null}

      <div className="salary-shift-record__actions">
        {assignment.canMarkWorked ? (
          <TimeButton onClick={() => onMarkWorked(assignment)} variant="primary">Mark Worked</TimeButton>
        ) : null}
        {assignment.canVoid ? (
          <TimeButton onClick={() => onVoid(assignment)} variant="danger">Remove Worked marker</TimeButton>
        ) : null}
      </div>

      {assignment.history.length > 0 ? (
        <details className="salary-shift-record__history">
          <summary><History aria-hidden="true" size={17} />Audit history ({assignment.history.length})</summary>
          <ol>
            {assignment.history.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.action === 'worked' ? 'Marked Worked' : 'Worked marker removed'}</strong>
                <span>{entry.actor.displayName} · {formatTimestamp(entry.recordedAt, viewerTimeZone)}</span>
                {entry.note ? <p>{entry.note}</p> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  )
}

function ShiftPresenceSection({
  assignments,
  empty,
  eyebrow,
  onMarkWorked,
  onVoid,
  title,
  viewerTimeZone,
}: {
  assignments: SalariedShiftAssignment[]
  empty: string
  eyebrow: string
  onMarkWorked: (assignment: SalariedShiftAssignment) => void
  onVoid: (assignment: SalariedShiftAssignment) => void
  title: string
  viewerTimeZone: string
}) {
  return (
    <section className="salary-shift-section">
      <header><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><strong aria-label={`${assignments.length} shifts`}>{assignments.length}</strong></header>
      {assignments.length > 0 ? (
        <div className="salary-shift-list">{assignments.map((assignment) => <ShiftPresenceCard assignment={assignment} key={assignment.assignmentId} onMarkWorked={onMarkWorked} onVoid={onVoid} viewerTimeZone={viewerTimeZone} />)}</div>
      ) : <p className="salary-shift-section__empty">{empty}</p>}
    </section>
  )
}

function ShiftPresenceDialog({
  assignment,
  error,
  onClose,
  onSubmit,
  pending,
  status,
}: {
  assignment: SalariedShiftAssignment
  error: string | null
  onClose: () => void
  onSubmit: (note: string | null) => void
  pending: boolean
  status: SalariedShiftPresenceStatus
}) {
  const [note, setNote] = useState('')
  const correction = status === 'unconfirmed' || lastHistoryAction(assignment) === 'voided'
  const noteRequired = correction
  const markingWorked = status === 'worked'
  return (
    <ModalDialog
      busy={pending}
      busyLabel={markingWorked ? 'Marking shift Worked...' : 'Removing Worked marker...'}
      description={markingWorked
        ? 'Confirm that this salaried employee worked this scheduled shift. No worked time or hours will be created.'
        : 'This removes the Worked marker but preserves the original entry and this correction in the audit history.'}
      onClose={onClose}
      title={markingWorked ? 'Mark salaried shift Worked?' : 'Remove Worked marker?'}
    >
      <div className="salary-shift-confirmation-summary">
        <span>Employee</span><strong>{assignment.employee.displayName}</strong>
        <span>Scheduled shift</span><strong>{formatDateKey(assignment.workday)} · {assignmentTitle(assignment)}</strong>
        <span>New status</span><strong>{markingWorked ? 'Worked' : 'Not marked'}</strong>
      </div>
      <label className="salary-shift-note-field">
        <span>{noteRequired ? 'Correction reason' : 'Note (optional)'}</span>
        <textarea
          autoFocus={noteRequired}
          maxLength={2000}
          onChange={(event) => setNote(event.target.value)}
          placeholder={markingWorked ? (noteRequired ? 'Explain why the shift is being marked Worked again.' : 'Optional note about this shift confirmation.') : 'Explain why the Worked marker is being removed.'}
          required={noteRequired}
          rows={4}
          value={note}
        />
        <small>{note.trim().length}/2000{noteRequired ? ' · At least 8 characters required' : ''}</small>
      </label>
      {error ? <p className="form-feedback form-feedback--error" role="alert">{error}</p> : null}
      <div className="modal-actions">
        <TimeButton disabled={pending} onClick={onClose}>Cancel</TimeButton>
        <TimeButton disabled={pending || (noteRequired && note.trim().length < 8)} loading={pending} onClick={() => onSubmit(note.trim() || null)} variant={markingWorked ? 'primary' : 'danger'}>
          {markingWorked ? 'Confirm Worked' : 'Remove marker'}
        </TimeButton>
      </div>
    </ModalDialog>
  )
}

export function SalariedShiftConfirmationsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [presenceFilter, setPresenceFilter] = useState<PresenceFilter>('all')
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [rangeDraft, setRangeDraft] = useState({ startsOn: '', endsOn: '' })
  const [appliedRange, setAppliedRange] = useState<{ startsOn?: string; endsOn?: string }>({})
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<{ assignment: SalariedShiftAssignment; requestId: string; status: SalariedShiftPresenceStatus } | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const workspaceQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryKey: salariedShiftWorkspaceQueryKey(appliedRange),
    queryFn: () => getSalariedShiftWorkspace(appliedRange),
    retry: false,
  })

  useEffect(() => {
    if (!workspaceQuery.data || rangeDraft.startsOn || rangeDraft.endsOn) return
    setRangeDraft(workspaceQuery.data.range)
  }, [rangeDraft.endsOn, rangeDraft.startsOn, workspaceQuery.data])

  const mutation = useMutation({
    mutationFn: ({ assignmentId, note, requestId, status }: { assignmentId: string; note: string | null; requestId: string; status: SalariedShiftPresenceStatus }) => recordSalariedShiftOutcome({ assignmentId, note, presenceStatus: status, requestId }),
    onMutate: () => setSuccessMessage(null),
    onSuccess: async (result) => {
      setPendingAction(null)
      setSuccessMessage(result.presenceStatus === 'worked' ? 'The shift is marked Worked.' : 'The Worked marker was removed and the correction remains in audit history.')
      await queryClient.invalidateQueries({ queryKey: ['salaried-shift-workspace'] })
    },
  })

  const visibleAssignments = useMemo(() => {
    const assignments = workspaceQuery.data?.assignments ?? []
    return assignments
      .filter((assignment) => employeeFilter === 'all' || assignment.employee.id === employeeFilter)
      .filter((assignment) => {
        if (presenceFilter === 'all') return true
        if (presenceFilter === 'worked') return assignment.presenceStatus === 'worked'
        if (presenceFilter === 'scheduled') return assignment.presenceStatus === 'unconfirmed' && assignment.blockingReason === 'shift_not_ended'
        return assignment.presenceStatus === 'unconfirmed' && assignment.canMarkWorked
      })
      .filter((assignment) => matchesSearch(assignment, search))
      .sort((left, right) => right.startsAt.localeCompare(left.startsAt))
  }, [employeeFilter, presenceFilter, search, workspaceQuery.data?.assignments])
  const worked = visibleAssignments.filter((assignment) => assignment.presenceStatus === 'worked')
  const ready = visibleAssignments.filter((assignment) => assignment.presenceStatus === 'unconfirmed' && assignment.canMarkWorked)
  const upcoming = visibleAssignments.filter((assignment) => assignment.presenceStatus === 'unconfirmed' && !assignment.canMarkWorked)

  function applyRange() {
    const days = inclusiveRangeDays(rangeDraft.startsOn, rangeDraft.endsOn)
    if (!rangeDraft.startsOn || !rangeDraft.endsOn) return setRangeError('Choose both a beginning and ending date.')
    if (days < 1) return setRangeError('The ending date must be the same as or after the beginning date.')
    if (days > 93) return setRangeError('Choose a date range of 93 days or fewer.')
    setRangeError(null)
    setAppliedRange(rangeDraft)
  }

  function openAction(assignment: SalariedShiftAssignment, status: SalariedShiftPresenceStatus) {
    mutation.reset()
    setPendingAction({ assignment, requestId: globalThis.crypto.randomUUID(), status })
  }

  if (!isSupabaseConfigured) return <main className="page page--salary-shifts"><TimePageHeader eyebrow="Schedule" summary="Shift confirmation requires the secure schedule connection." title="Salaried Shift Confirmation" /><TimeEmptyState icon={ShieldAlert} title="Secure schedule data is not connected"><p>Connect Supabase before salaried shifts can be reviewed.</p></TimeEmptyState></main>
  if (workspaceQuery.isPending) return <main className="page page--salary-shifts"><DataStatePanel icon={CalendarCheck2} title="Loading shift confirmations"><p>Loading salaried scheduled shifts and their Worked markers.</p></DataStatePanel></main>
  if (workspaceQuery.isError || !workspaceQuery.data) return <main className="page page--salary-shifts"><TimePageHeader actions={<Link className="time-button time-button--secondary" to="/"><ChevronLeft aria-hidden="true" size={18} />Back to Home</Link>} eyebrow="Schedule" summary="Track salaried scheduled shifts without recording worked time." title="Salaried Shift Confirmation" /><DataStatePanel icon={ShieldAlert} title="Shift confirmations could not be loaded" tone="error"><p>{workspaceQuery.error?.message ?? 'Refresh the page and try again.'}</p><TimeButton onClick={() => void workspaceQuery.refetch()}>Retry</TimeButton></DataStatePanel></main>

  const workspace = workspaceQuery.data
  if (!workspace.viewer.canManage) return <main className="page page--salary-shifts"><TimePageHeader actions={<Link className="time-button time-button--secondary" to="/"><ChevronLeft aria-hidden="true" size={18} />Back to Home</Link>} eyebrow="Schedule" summary="Track salaried scheduled shifts without recording worked time." title="Salaried Shift Confirmation" /><TimeEmptyState icon={ShieldAlert} title="Shift Confirmation is not enabled for your account"><p>An effective Shift Confirmation management permission is required.</p></TimeEmptyState></main>

  return (
    <main className="page page--salary-shifts">
      <TimePageHeader actions={<Link className="time-button time-button--secondary" to="/"><ChevronLeft aria-hidden="true" size={18} />Back to Home</Link>} eyebrow="Schedule" summary="Mark that a salaried employee worked a scheduled shift. This workspace counts shifts only." title="Salaried Shift Confirmation" />

      <TimeAlertCard icon={CalendarCheck2} title="Whole-shift marker, not timekeeping"><p>Scheduled dates and times identify each assignment. A Worked marker does not create clock punches, worked minutes, breaks, overtime, or payroll hours.</p></TimeAlertCard>
      {successMessage ? <TimeAlertCard icon={CheckCircle2} title="Shift confirmation saved" tone="good"><p>{successMessage} The shift counts and audit history have been refreshed.</p></TimeAlertCard> : null}

      <section className="salary-shift-filter-card" aria-label="Shift confirmation filters">
        <div className="salary-shift-filter-grid">
          <label><span>Beginning date</span><input onChange={(event) => setRangeDraft((current) => ({ ...current, startsOn: event.target.value }))} type="date" value={rangeDraft.startsOn} /></label>
          <label><span>Ending date</span><input onChange={(event) => setRangeDraft((current) => ({ ...current, endsOn: event.target.value }))} type="date" value={rangeDraft.endsOn} /></label>
          <label><span>Employee</span><select onChange={(event) => setEmployeeFilter(event.target.value)} value={employeeFilter}><option value="all">All salaried employees</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select></label>
          <label><span>Status</span><select onChange={(event) => setPresenceFilter(event.target.value as PresenceFilter)} value={presenceFilter}><option value="all">All statuses</option><option value="ready">Ready to mark</option><option value="worked">Worked</option><option value="scheduled">Scheduled</option></select></label>
          <label className="salary-shift-search"><span>Search shifts</span><span><Search aria-hidden="true" size={18} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Employee, site, or post" type="search" value={search} /></span></label>
          <TimeButton loading={workspaceQuery.isFetching} onClick={applyRange} variant="primary">Apply dates</TimeButton>
        </div>
        {rangeError ? <p className="form-feedback form-feedback--error" role="alert">{rangeError}</p> : null}
        <p className="salary-shift-filter-card__range">Showing scheduled shifts from {formatDateKey(workspace.range.startsOn)} through {formatDateKey(workspace.range.endsOn)}.</p>
      </section>

      <section aria-label="Salaried shift counts" className="salary-shift-summary-grid">
        <TimeMetricCard detail="Salaried scheduled shifts matching these filters." icon={CalendarDays} label="Total Shifts" value={visibleAssignments.length} />
        <TimeMetricCard detail="Ended shifts that are ready for a Worked marker." icon={AlertTriangle} label="Ready to Mark" tone={ready.length > 0 ? 'warning' : 'neutral'} value={ready.length} />
        <TimeMetricCard detail="Whole scheduled shifts marked Worked." icon={CheckCircle2} label="Worked" tone="good" value={worked.length} />
      </section>

      <div className="salary-shift-sections">
        <ShiftPresenceSection assignments={ready} empty="No ended salaried shifts are waiting to be marked Worked." eyebrow="Ready" onMarkWorked={(assignment) => openAction(assignment, 'worked')} onVoid={(assignment) => openAction(assignment, 'unconfirmed')} title="Ready to mark" viewerTimeZone={workspace.viewer.timeZone} />
        <ShiftPresenceSection assignments={upcoming} empty="No upcoming salaried shifts match these filters." eyebrow="Scheduled" onMarkWorked={(assignment) => openAction(assignment, 'worked')} onVoid={(assignment) => openAction(assignment, 'unconfirmed')} title="Upcoming shifts" viewerTimeZone={workspace.viewer.timeZone} />
        <ShiftPresenceSection assignments={worked} empty="No Worked shifts match these filters." eyebrow="History" onMarkWorked={(assignment) => openAction(assignment, 'worked')} onVoid={(assignment) => openAction(assignment, 'unconfirmed')} title="Worked shifts" viewerTimeZone={workspace.viewer.timeZone} />
      </div>

      {pendingAction ? <ShiftPresenceDialog assignment={pendingAction.assignment} error={mutation.isError ? mutation.error.message : null} onClose={() => { if (!mutation.isPending) { mutation.reset(); setPendingAction(null) } }} onSubmit={(note) => mutation.mutate({ assignmentId: pendingAction.assignment.assignmentId, note, requestId: pendingAction.requestId, status: pendingAction.status })} pending={mutation.isPending} status={pendingAction.status} /> : null}
    </main>
  )
}

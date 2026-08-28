import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileWarning,
  History,
  Plus,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  createAccountabilityOccurrence,
  getAccountabilityWorkspace,
  reviewAccountabilityOccurrence,
  type AccountabilityDecision,
  type AccountabilityEvent,
  type AccountabilityEventType,
  type AccountabilityWorkspace,
} from '../data/accountability'
import { getSessionContext } from '../data/auth'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'
import {
  accountabilityDisplayState,
  accountabilityTypeLabels,
  buildEmployeeAccountabilitySummaries,
  summarizeAccountability,
  type AccountabilityDisplayState,
} from './accountability'
import { canViewAccountability } from './timePermissions'
import { addDays, dateKey, formatUsDateKey, minutesToHours } from './timeRules'
import {
  TimeAlertCard,
  TimeButton,
  TimeEmptyState,
  TimeMetricCard,
  TimePageHeader,
  TimeSectionHeader,
  TimeStatusBadge,
} from './TimeKit'

const allStates = ['all', 'open', 'confirmed', 'protected', 'corrected', 'dismissed', 'voided'] as const
type StateFilter = typeof allStates[number]

function defaultRange() {
  const today = new Date()
  return { fromDate: dateKey(addDays(today, -30)), throughDate: dateKey(today) }
}

export function AccountabilityPage() {
  const queryClient = useQueryClient()
  const initialRange = useMemo(defaultRange, [])
  const [fromDate, setFromDate] = useState(initialRange.fromDate)
  const [throughDate, setThroughDate] = useState(initialRange.throughDate)
  const [employeeId, setEmployeeId] = useState('all')
  const [eventType, setEventType] = useState<'all' | AccountabilityEventType>('all')
  const [state, setState] = useState<StateFilter>('open')
  const [view, setView] = useState<'occurrences' | 'team'>('occurrences')
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)

  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const allowed = canViewAccountability(sessionQuery.data)
  const workspaceQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && allowed,
    queryFn: () => getAccountabilityWorkspace({ fromDate, throughDate }),
    queryKey: ['accountability-workspace', fromDate, throughDate],
  })

  const workspace = workspaceQuery.data
  const selectedEvent = workspace?.events.find((event) => event.id === selectedEventId) ?? null
  const summary = summarizeAccountability(workspace?.events ?? [])
  const employeeSummaries = buildEmployeeAccountabilitySummaries(workspace?.employees ?? [], workspace?.events ?? [])
  const filteredEvents = (workspace?.events ?? []).filter((event) => {
    if (employeeId !== 'all' && event.employeeId !== employeeId) return false
    if (eventType !== 'all' && event.eventType !== eventType) return false
    if (state !== 'all' && accountabilityDisplayState(event) !== state) return false
    return true
  })

  async function refreshWorkspace() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['accountability-workspace'] }),
      queryClient.invalidateQueries({ queryKey: ['time-payroll-accountability'] }),
      queryClient.invalidateQueries({ queryKey: ['time-command-review'] }),
      queryClient.invalidateQueries({ queryKey: ['time-command-attendance-summary'] }),
    ])
  }

  if (!isSupabaseConfigured) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={ShieldCheck} title="Secure accountability data is not connected"><p>Connect the production database before using the Accountability Tracker.</p></DataStatePanel></main>
  }

  if (sessionQuery.isPending || (allowed && workspaceQuery.isPending)) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={ClipboardCheck} title="Loading Accountability Tracker"><p>Building the operational record from schedules, punches, time off, and documented occurrences.</p></DataStatePanel></main>
  }

  if (sessionQuery.isError || !allowed) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={ShieldCheck} title="Accountability Tracker is not enabled" tone="error"><p>Your account needs the accountability.view or accountability.manage permission with MFA.</p></DataStatePanel></main>
  }

  if (workspaceQuery.isError || !workspace) {
    return <main className="page page--sygshift-time"><DataStatePanel icon={FileWarning} title="Accountability Tracker unavailable" tone="error"><p>{workspaceQuery.error?.message ?? 'The accountability workspace did not load.'}</p></DataStatePanel></main>
  }

  return (
    <main className="page page--sygshift-time page--accountability">
      <TimePageHeader
        actions={workspace.capabilities.canCreate ? <TimeButton icon={Plus} onClick={() => setCreateOpen(true)} variant="primary">Record occurrence</TimeButton> : undefined}
        eyebrow="Operations record"
        summary="Review attendance occurrences with context, preserve original punches, and document authorized decisions without weakening payroll controls."
        title="Accountability Tracker"
      />

      <TimeAlertCard icon={ShieldCheck} title="Document facts, not discipline scores" tone="neutral">
        <p>Approved sick time, vacation, protected leave, dismissed records, and unreviewed reports do not count as confirmed reliability occurrences. Hard payroll blockers remain in Time Exceptions.</p>
      </TimeAlertCard>

      <section className="accountability-range time-card" aria-label="Accountability date range">
        <div>
          <p className="eyebrow">Review range</p>
          <strong>{formatUsDateKey(fromDate)} – {formatUsDateKey(throughDate)}</strong>
        </div>
        <label><span>From</span><input max={throughDate} onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
        <label><span>Through</span><input min={fromDate} onChange={(event) => setThroughDate(event.target.value)} type="date" value={throughDate} /></label>
      </section>

      <section className="time-command-grid accountability-metrics" aria-label="Accountability summary">
        <TimeMetricCard detail="Reports waiting for human review." icon={AlertTriangle} label="Open Review" tone={summary.open > 0 ? 'warning' : 'good'} value={summary.open} />
        <TimeMetricCard detail="Reviewed and confirmed attendance occurrences." icon={CheckCircle2} label="Confirmed" tone="neutral" value={summary.confirmed} />
        <TimeMetricCard detail="Excused or protected records excluded from reliability totals." icon={ShieldCheck} label="Protected / Excused" tone="good" value={summary.protected} />
        <TimeMetricCard detail={`${workspace.exceptionSummaries.reduce((total, item) => total + item.blockingCount, 0)} blocking exception(s) remain in Review Queue.`} icon={FileWarning} label="Hard Time Controls" tone={workspace.exceptionSummaries.length > 0 ? 'danger' : 'good'} to="/time/review" value={workspace.exceptionSummaries.reduce((total, item) => total + item.unresolvedCount, 0)} />
      </section>

      <section className="accountability-workspace time-card">
        <TimeSectionHeader
          action={<div className="accountability-view-switch" role="group" aria-label="Accountability view"><TimeButton onClick={() => setView('occurrences')} variant={view === 'occurrences' ? 'primary' : 'secondary'}>Occurrences</TimeButton><TimeButton onClick={() => setView('team')} variant={view === 'team' ? 'primary' : 'secondary'}>Team Overview</TimeButton></div>}
          eyebrow="Review workspace"
          summary="Use the filters to find one occurrence or open an employee summary."
          title={view === 'occurrences' ? 'Occurrences' : 'Employee overview'}
        />

        {view === 'occurrences' ? (
          <>
            <div className="accountability-filters">
              <label><span>Employee</span><select onChange={(event) => setEmployeeId(event.target.value)} value={employeeId}><option value="all">All active employees</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
              <label><span>Type</span><select onChange={(event) => setEventType(event.target.value as typeof eventType)} value={eventType}><option value="all">All occurrence types</option>{Object.entries(accountabilityTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>Review state</span><select onChange={(event) => setState(event.target.value as StateFilter)} value={state}>{allStates.map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}</select></label>
            </div>
            <OccurrenceList events={filteredEvents} onOpen={setSelectedEventId} />
          </>
        ) : (
          <EmployeeOverview rows={employeeSummaries} onOpen={(id) => { setEmployeeId(id); setState('all'); setView('occurrences') }} />
        )}
      </section>

      {workspace.exceptionSummaries.length > 0 ? <HardControlSummary rows={workspace.exceptionSummaries} /> : null}

      {createOpen ? <CreateOccurrenceDialog onClose={() => setCreateOpen(false)} onSaved={refreshWorkspace} workspace={workspace} /> : null}
      {selectedEvent ? <OccurrenceReviewDialog event={selectedEvent} onClose={() => setSelectedEventId(null)} onSaved={refreshWorkspace} workspace={workspace} /> : null}
    </main>
  )
}

function OccurrenceList({ events, onOpen }: { events: AccountabilityEvent[]; onOpen: (id: string) => void }) {
  if (events.length === 0) return <TimeEmptyState icon={ClipboardCheck} title="No occurrences match these filters"><p>Change the filters or date range to review a different set of records.</p></TimeEmptyState>
  return <div className="accountability-list">{events.map((event) => {
    const state = accountabilityDisplayState(event)
    return <article className="accountability-row" key={`${event.sourceTable}-${event.id}`}>
      <div className="accountability-row__date"><span>{formatUsDateKey(event.operationalDate)}</span><small>{event.startsAt ? formatOperationalDateTime(event.startsAt, { timeZone: event.timeZone }) : 'Date-only record'}</small></div>
      <div className="accountability-row__person"><strong>{event.employeeName}</strong><span>{accountabilityTypeLabels[event.eventType]}</span><small>{event.locationName}</small></div>
      <div className="accountability-row__note"><span>{event.note}</span><small>{sourceLabel(event.sourceTable)}</small></div>
      <TimeStatusBadge tone={stateTone(state)}>{stateLabel(state)}</TimeStatusBadge>
      <TimeButton onClick={() => onOpen(event.id)} variant="secondary">{event.reviewable ? 'Review' : 'View details'}</TimeButton>
    </article>
  })}</div>
}

function EmployeeOverview({ rows, onOpen }: { rows: ReturnType<typeof buildEmployeeAccountabilitySummaries>; onOpen: (employeeId: string) => void }) {
  if (rows.length === 0) return <TimeEmptyState icon={UserRoundCheck} title="No employee occurrences in this range"><p>The employee overview will populate when documented events fall inside the selected dates.</p></TimeEmptyState>
  return <div className="accountability-team-grid">{rows.map((row) => <article className="time-card accountability-person-card" key={row.employeeId}><div><strong>{row.employeeName}</strong><span>{row.total} documented occurrence{row.total === 1 ? '' : 's'}</span></div><dl><div><dt>Open</dt><dd>{row.open}</dd></div><div><dt>Confirmed</dt><dd>{row.confirmed}</dd></div><div><dt>Protected</dt><dd>{row.protected}</dd></div><div><dt>Reliability</dt><dd>{row.confirmedReliabilityOccurrences}</dd></div></dl><TimeButton onClick={() => onOpen(row.employeeId)} variant="secondary">View occurrences</TimeButton></article>)}</div>
}

function HardControlSummary({ rows }: { rows: AccountabilityWorkspace['exceptionSummaries'] }) {
  return <section className="accountability-hard-controls time-card"><TimeSectionHeader eyebrow="Payroll integrity" summary="These are impossible or incomplete time records. They cannot be overridden from Accountability Tracker." title="Hard time controls" /><div className="accountability-hard-controls__list">{rows.slice(0, 6).map((row) => <div key={row.employeeId}><strong>{row.employeeName}</strong><span>{row.unresolvedCount} unresolved · {row.blockingCount} blocking</span><small>{row.codes.map(readableCode).join(', ')}</small></div>)}</div><Link className="time-button time-button--secondary" to="/time/review"><FileWarning aria-hidden="true" size={18} /><span>Open Review Queue</span></Link></section>
}

function CreateOccurrenceDialog({ onClose, onSaved, workspace }: { onClose: () => void; onSaved: () => Promise<void>; workspace: AccountabilityWorkspace }) {
  const [employeeId, setEmployeeId] = useState('')
  const [eventType, setEventType] = useState<AccountabilityEventType>('late_arrival')
  const [shiftId, setShiftId] = useState('')
  const [operationalDate, setOperationalDate] = useState(dateKey(new Date()))
  const shifts = workspace.shiftOptions.filter((shift) => shift.employeeId === employeeId)
  const requiresShift = eventType !== 'other'
  const mutation = useMutation({ mutationFn: createAccountabilityOccurrence, onSuccess: async () => { await onSaved(); onClose() } })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      employeeId,
      eventType,
      note: String(data.get('note') ?? ''),
      operationalDate: shiftId ? null : operationalDate,
      shiftId: shiftId || null,
    })
  }

  return <ModalDialog busy={mutation.isPending} busyLabel="Recording occurrence..." className="modal-dialog--time-workflow modal-dialog--accountability" description="Use Time Operations for sick and call-off reports. This form records factual attendance occurrences and never changes punches." onClose={onClose} title="Record accountability occurrence"><form className="time-workflow-form accountability-form" onSubmit={submit}><div className="time-workflow-form__two"><label><span>Employee</span><select onChange={(event) => { setEmployeeId(event.target.value); setShiftId('') }} required value={employeeId}><option value="">Choose employee</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label><span>Occurrence type</span><select onChange={(event) => { setEventType(event.target.value as AccountabilityEventType); setShiftId('') }} value={eventType}><option value="late_arrival">Late arrival</option><option value="early_departure">Early departure</option><option value="no_call_no_show">No-call / no-show</option><option value="other">Other documented occurrence</option></select></label></div>{requiresShift ? <label><span>Scheduled shift</span><select onChange={(event) => setShiftId(event.target.value)} required value={shiftId}><option value="">Choose an assigned shift</option>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{formatUsDateKey(shift.operationalDate)} · {formatOperationalDateTime(shift.startsAt, { timeZone: shift.timeZone })} · {shift.locationName}</option>)}</select></label> : <><label><span>Related scheduled shift (optional)</span><select onChange={(event) => setShiftId(event.target.value)} value={shiftId}><option value="">No related shift</option>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{formatUsDateKey(shift.operationalDate)} · {shift.locationName}</option>)}</select></label>{!shiftId ? <label><span>Operational date</span><input onChange={(event) => setOperationalDate(event.target.value)} required type="date" value={operationalDate} /></label> : null}</>}<label><span>Factual note</span><textarea maxLength={2000} minLength={4} name="note" placeholder="Describe what occurred using clear, objective language." required rows={5} /></label>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}<div className="time-workflow-form__actions"><TimeButton onClick={onClose} variant="secondary">Cancel</TimeButton><TimeButton icon={Plus} loading={mutation.isPending} type="submit" variant="primary">Record occurrence</TimeButton></div></form></ModalDialog>
}

function OccurrenceReviewDialog({ event, onClose, onSaved, workspace }: { event: AccountabilityEvent; onClose: () => void; onSaved: () => Promise<void>; workspace: AccountabilityWorkspace }) {
  const [action, setAction] = useState<AccountabilityDecision>(event.status === 'resolved' || event.status === 'voided' ? 'reopened' : 'confirmed')
  const mutation = useMutation({ mutationFn: reviewAccountabilityOccurrence, onSuccess: async () => { await onSaved(); onClose() } })
  const state = accountabilityDisplayState(event)
  const actualEmployee = event.reconciliation?.actualEmployees.find((employee) => employee.employeeId === event.employeeId)

  function submit(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault()
    const data = new FormData(submitEvent.currentTarget)
    mutation.mutate({ action, eventId: event.id, reason: String(data.get('reason') ?? '') })
  }

  return <ModalDialog busy={mutation.isPending} busyLabel="Saving documented decision..." className="modal-dialog--time-workflow modal-dialog--accountability" description={`${event.employeeName} · ${formatUsDateKey(event.operationalDate)} · ${event.locationName}`} onClose={onClose} title="Review accountability occurrence"><div className="accountability-review"><section className="accountability-review__summary"><div><span>Occurrence</span><strong>{accountabilityTypeLabels[event.eventType]}</strong></div><div><span>Review state</span><TimeStatusBadge tone={stateTone(state)}>{stateLabel(state)}</TimeStatusBadge></div><div><span>Source</span><strong>{sourceLabel(event.sourceTable)}</strong></div><div><span>Employee</span><strong>{event.employeeName}</strong></div></section><section className="accountability-review__note"><p className="eyebrow">Original factual note</p><p>{event.note}</p></section>{event.reconciliation ? <ReconciliationContext event={event} actualEmployee={actualEmployee} /> : <TimeAlertCard icon={CalendarClock} title="No scheduled shift context" tone="neutral"><p>This is a date-only record or an approved request that is not tied to a single shift.</p></TimeAlertCard>}{event.actionHistory.length > 0 ? <section className="accountability-history"><p className="eyebrow">Decision history</p>{event.actionHistory.map((item) => <div key={item.id}><History aria-hidden="true" size={17} /><div><strong>{stateLabel(item.action)}</strong><span>{item.reason}</span><small>{item.actorName} · {formatOperationalDateTime(item.actionAt)}</small></div></div>)}</section> : null}{event.reviewable && workspace.capabilities.canManage ? <form className="time-workflow-form accountability-decision" onSubmit={submit}><label><span>Review action</span><select onChange={(selectEvent) => setAction(selectEvent.target.value as AccountabilityDecision)} value={action}>{event.status === 'resolved' || event.status === 'voided' ? <option value="reopened">Reopen for review</option> : <><option value="confirmed">Confirm occurrence</option><option value="excused_protected">Mark excused / protected</option><option value="corrected">Mark corrected</option><option value="dismissed">Dismiss incorrect occurrence</option><option value="voided">Void record</option></>}</select></label><label><span>Required decision reason</span><textarea maxLength={2000} minLength={8} name="reason" placeholder="Document what was reviewed and why this decision is appropriate." required rows={4} /></label>{mutation.isError ? <div className="inline-alert" role="alert">{mutation.error.message}</div> : null}<div className="time-workflow-form__actions"><TimeButton onClick={onClose} variant="secondary">Leave unresolved</TimeButton><TimeButton icon={CheckCircle2} loading={mutation.isPending} type="submit" variant="primary">Save decision</TimeButton></div></form> : <div className="time-workflow-form__actions"><TimeButton onClick={onClose} variant="secondary">Close</TimeButton>{event.sourceTable === 'call_off_reports' ? <Link className="time-button time-button--primary" to="/time/operations">Open Time Operations</Link> : event.sourceTable === 'time_off_requests' ? <Link className="time-button time-button--primary" to="/requests">Open Time-Off Requests</Link> : null}</div>}</div></ModalDialog>
}

function ReconciliationContext({ event, actualEmployee }: { event: AccountabilityEvent; actualEmployee: NonNullable<AccountabilityEvent['reconciliation']>['actualEmployees'][number] | undefined }) {
  const reconciliation = event.reconciliation
  if (!reconciliation) return null
  return <><section className="accountability-context-grid"><article><span>Scheduled shift</span><strong>{formatOperationalDateTime(reconciliation.startsAt, { timeZone: event.timeZone })}</strong><small>through {formatOperationalDateTime(reconciliation.endsAt, { timeZone: event.timeZone })}</small></article><article><span>Actual worked</span><strong>{minutesToHours(actualEmployee?.paidMinutes ?? 0)} hr</strong><small>{actualEmployee?.segmentCount ?? 0} worked segment(s)</small></article><article><span>Unpaid gaps</span><strong>{minutesToHours(actualEmployee?.unpaidGapMinutes ?? 0)} hr</strong><small>Gaps are not counted as worked time.</small></article><article><span>Schedule variance</span><strong>{minutesToHours(Math.abs(reconciliation.actualPaidMinutes - reconciliation.scheduledCoverageMinutes))} hr</strong><small>Difference from scheduled coverage.</small></article></section>{actualEmployee?.workedSegments.length ? <section className="accountability-segments"><p className="eyebrow">Calculated work segments</p>{actualEmployee.workedSegments.map((segment) => <div key={segment.segmentNumber}><strong>Segment {segment.segmentNumber}</strong><span>{formatOperationalDateTime(segment.startsAt, { timeZone: event.timeZone })} – {segment.endsAt ? formatOperationalDateTime(segment.endsAt, { timeZone: event.timeZone }) : 'Open'}</span><small>{minutesToHours(segment.paidMinutes)} paid hr · {segment.breakMinutes} break min</small></div>)}</section> : null}{actualEmployee?.unpaidGaps.length ? <section className="accountability-gaps"><p className="eyebrow">Unpaid gaps</p>{actualEmployee.unpaidGaps.map((gap) => <div key={`${gap.startsAt}-${gap.endsAt}`}><span>{formatOperationalDateTime(gap.startsAt, { timeZone: event.timeZone })} – {formatOperationalDateTime(gap.endsAt, { timeZone: event.timeZone })}</span><strong>{gap.minutes} min unpaid</strong></div>)}</section> : null}{reconciliation.discrepancyCodes.length ? <section className="accountability-rules"><p className="eyebrow">Rules requiring review</p>{reconciliation.discrepancyCodes.map((code) => <span key={code}>{readableCode(code)}</span>)}</section> : null}</>
}

function stateTone(state: AccountabilityDisplayState): 'neutral' | 'good' | 'warning' | 'danger' {
  if (state === 'open') return 'warning'
  if (state === 'protected' || state === 'corrected' || state === 'dismissed') return 'good'
  if (state === 'confirmed') return 'danger'
  return 'neutral'
}

function stateLabel(state: string): string {
  if (state === 'all') return 'All review states'
  if (state === 'created') return 'Occurrence recorded'
  if (state === 'excused_protected' || state === 'protected') return 'Excused / protected'
  if (state === 'reopened') return 'Reopened for review'
  if (state === 'voided') return 'Voided'
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}`
}

function sourceLabel(source: AccountabilityEvent['sourceTable']): string {
  if (source === 'call_off_reports') return 'Time Operations call-off'
  if (source === 'time_off_requests') return 'Approved time-off request'
  return 'Accountability record'
}

function readableCode(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

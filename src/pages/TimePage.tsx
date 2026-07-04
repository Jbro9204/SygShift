import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Coffee,
  FileClock,
  History,
  ShieldAlert,
  Timer,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import {
  activeTimeState,
  getTimekeepingDashboard,
  nextTimeEventKinds,
  recordTimeEvent,
  verifiedTimekeepingBaseline,
  type TimeEventKind,
  type TimekeepingDashboard,
  type TimekeepingEvent,
  type TimekeepingShift,
  type TimekeepingState,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { OPERATIONAL_TIME_ZONE, operationalToday } from '../lib/time'

const actionLabels: Record<TimeEventKind, string> = {
  clock_in: 'Clock in',
  break_start: 'Start break',
  break_end: 'End break',
  clock_out: 'Clock out',
}

const eventLabels: Record<TimeEventKind, string> = {
  clock_in: 'Clocked in',
  break_start: 'Break started',
  break_end: 'Break ended',
  clock_out: 'Clocked out',
}

const stateCopy: Record<TimekeepingState, { title: string; body: string }> = {
  off_clock: {
    title: 'You are currently off the clock.',
    body: 'Choose the correct assigned shift when one is available. If no shift is listed, the punch is recorded as unscheduled time for supervisor review.',
  },
  working: {
    title: 'You are clocked in.',
    body: 'You can start a break or clock out. The official time is recorded by the secure server.',
  },
  on_break: {
    title: 'You are on break.',
    body: 'End the break before clocking out so payroll can calculate the paid and unpaid time correctly.',
  },
}

function formatDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
  }).format(date)
}

function formatTime(value: string, timeZone = OPERATIONAL_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(value))
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: OPERATIONAL_TIME_ZONE,
    weekday: 'short',
  }).format(new Date(value))
}

function shiftTitle(shift: TimekeepingShift): string {
  return shift.postName ?? shift.eventName ?? shift.locationName ?? 'Assigned shift'
}

function shiftLocation(shift: TimekeepingShift): string {
  return [shift.siteCode, shift.siteName ?? shift.locationName].filter(Boolean).join(' · ') || 'Location pending'
}

function activeShift(dashboard: TimekeepingDashboard): TimekeepingShift | null {
  const activeShiftId = dashboard.lastEvent?.shiftId
  if (!activeShiftId) return null
  return dashboard.eligibleShifts.find((shift) => shift.shiftId === activeShiftId) ?? null
}

function VerifiedTimekeepingSetup() {
  return (
    <>
      <section className="time-hero-card" aria-labelledby="timekeeping-foundation-title">
        <div className="time-hero-card__icon"><Timer aria-hidden="true" size={31} /></div>
        <div>
          <p className="eyebrow">Timekeeping foundation</p>
          <h2 id="timekeeping-foundation-title">Clock-in rules are ready for the secure database.</h2>
          <p>
            SygShift is built around schedule-linked punches, server-recorded official time, audit-only
            device timestamps, break tracking, and correction records that cannot quietly overwrite history.
          </p>
        </div>
        <span className="import-state-pill"><CheckCircle2 aria-hidden="true" size={17} /> Controlled</span>
      </section>

      <section className="time-rule-grid" aria-label="Timekeeping safeguards">
        {verifiedTimekeepingBaseline.guarantees.map((guarantee) => (
          <article key={guarantee}>
            <BadgeCheck aria-hidden="true" size={22} />
            <span>{guarantee}</span>
          </article>
        ))}
      </section>

      <section className="time-layout">
        <article className="time-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Punch window</p>
              <h2>Easy for guards, strict for payroll</h2>
            </div>
          </div>
          <p className="time-panel__lead">{verifiedTimekeepingBaseline.punchWindow}</p>
          <div className="time-action-row">
            <button className="primary-action" disabled type="button">Clock in</button>
            <button className="secondary-button" disabled type="button">Start break</button>
            <button className="secondary-button" disabled type="button">Clock out</button>
          </div>
        </article>

        <DataStatePanel icon={FileClock} title="Connect Supabase to record live punches" tone="setup">
          <p>
            The page is ready, but live time punches stay disabled until a signed-in employee account is connected.
            Direct table writes remain closed; employees punch only through the controlled workflow.
          </p>
        </DataStatePanel>
      </section>
    </>
  )
}

function ShiftPicker({
  selectedShiftId,
  shifts,
  onSelect,
}: {
  selectedShiftId: string | null
  shifts: TimekeepingShift[]
  onSelect: (shiftId: string | null) => void
}) {
  if (shifts.length === 0) {
    return (
      <div className="time-shift-empty">
        <CalendarClock aria-hidden="true" size={25} />
        <div>
          <strong>No assigned shift is available for today.</strong>
          <p>An unscheduled clock-in can still be recorded for supervisor review.</p>
        </div>
      </div>
    )
  }

  return (
    <fieldset className="time-shift-list">
      <legend>Choose the shift you are clocking into</legend>
      {shifts.map((shift) => (
        <label className={selectedShiftId === shift.shiftId ? 'time-shift-option time-shift-option--selected' : 'time-shift-option'} key={shift.shiftId}>
          <input
            checked={selectedShiftId === shift.shiftId}
            name="time-shift"
            onChange={() => onSelect(shift.shiftId)}
            type="radio"
          />
          <span>
            <strong>{shiftTitle(shift)}</strong>
            <small>{shiftLocation(shift)}</small>
            <em>{formatTime(shift.startsAt, shift.timeZone)} - {formatTime(shift.endsAt, shift.timeZone)}</em>
          </span>
          {shift.requiresArmed ? <b>Armed</b> : null}
          {shift.isOvertime ? <b>OT</b> : null}
        </label>
      ))}
      <label className={selectedShiftId === null ? 'time-shift-option time-shift-option--selected' : 'time-shift-option'}>
        <input checked={selectedShiftId === null} name="time-shift" onChange={() => onSelect(null)} type="radio" />
        <span>
          <strong>Unscheduled time</strong>
          <small>Use only when a supervisor expects you to work outside a listed shift.</small>
        </span>
      </label>
    </fieldset>
  )
}

function PunchControls({
  dashboard,
  pending,
  onPunch,
}: {
  dashboard: TimekeepingDashboard
  pending: boolean
  onPunch: (kind: TimeEventKind, shiftId?: string | null) => void
}) {
  const state = activeTimeState(dashboard.lastEvent)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(
    dashboard.eligibleShifts.length === 1 ? dashboard.eligibleShifts[0]?.shiftId ?? null : null,
  )
  const copy = stateCopy[state]
  const currentShift = activeShift(dashboard)
  const actions = nextTimeEventKinds(state)

  return (
    <section className={`time-clock-card time-clock-card--${state}`} aria-labelledby="time-clock-title">
      <div className="time-clock-card__header">
        <div>
          <p className="eyebrow">Current status</p>
          <h2 id="time-clock-title">{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
        <div className="time-server-box">
          <span>Official server time</span>
          <strong>{formatTime(dashboard.serverTimestamp)}</strong>
        </div>
      </div>

      {state === 'off_clock' ? (
        <ShiftPicker onSelect={setSelectedShiftId} selectedShiftId={selectedShiftId} shifts={dashboard.eligibleShifts} />
      ) : currentShift ? (
        <div className="active-shift-card">
          <Clock3 aria-hidden="true" size={23} />
          <div>
            <strong>{shiftTitle(currentShift)}</strong>
            <span>{shiftLocation(currentShift)} · {formatTime(currentShift.startsAt, currentShift.timeZone)} - {formatTime(currentShift.endsAt, currentShift.timeZone)}</span>
          </div>
        </div>
      ) : (
        <div className="active-shift-card">
          <Clock3 aria-hidden="true" size={23} />
          <div>
            <strong>Unscheduled active time</strong>
            <span>This session will stay visible for supervisor payroll review.</span>
          </div>
        </div>
      )}

      <div className="time-action-row">
        {actions.map((kind) => (
          <button
            className={kind === 'clock_in' || kind === 'clock_out' ? 'primary-action' : 'secondary-button'}
            disabled={pending}
            key={kind}
            onClick={() => onPunch(kind, kind === 'clock_in' ? selectedShiftId : undefined)}
            type="button"
          >
            {kind === 'break_start' || kind === 'break_end' ? <Coffee aria-hidden="true" size={18} /> : <Timer aria-hidden="true" size={18} />}
            {pending ? 'Recording...' : actionLabels[kind]}
          </button>
        ))}
      </div>
    </section>
  )
}

function RecentEvents({ events }: { events: TimekeepingEvent[] }) {
  if (events.length === 0) {
    return (
      <DataStatePanel icon={History} title="No punches recorded today">
        <p>Your clock-in, break, and clock-out events will appear here as soon as they are recorded.</p>
      </DataStatePanel>
    )
  }

  return (
    <section className="time-panel" aria-labelledby="recent-time-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Today</p>
          <h2 id="recent-time-title">Recorded time events</h2>
        </div>
      </div>
      <ol className="time-event-list">
        {events.map((event) => (
          <li className={event.voided ? 'time-event time-event--voided' : 'time-event'} key={event.id}>
            <span><Clock3 aria-hidden="true" size={18} /></span>
            <div>
              <strong>{eventLabels[event.kind]}</strong>
              <small>{formatDate(event.recordedAt)} · {formatTime(event.recordedAt)} · {event.source.replaceAll('_', ' ')}</small>
            </div>
            {event.voided ? <em>Voided</em> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

function LiveTimekeeping() {
  const queryClient = useQueryClient()
  const operationalDate = useMemo(() => formatDateKey(operationalToday()), [])
  const dashboardQuery = useQuery({
    queryKey: ['timekeeping-dashboard', operationalDate],
    queryFn: () => getTimekeepingDashboard(operationalDate),
  })
  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['timekeeping-dashboard'] })
    },
  })

  if (dashboardQuery.isPending) {
    return <DataStatePanel icon={Timer} title="Loading timekeeping"><p>Retrieving your assigned shifts, current status, and today&apos;s recorded punches.</p></DataStatePanel>
  }

  if (dashboardQuery.isError) {
    return <DataStatePanel icon={ShieldAlert} title="Timekeeping unavailable" tone="error"><p>{dashboardQuery.error.message}</p></DataStatePanel>
  }

  const dashboard = dashboardQuery.data

  return (
    <>
      <section className="time-hero-card" aria-labelledby="live-time-title">
        <div className="time-hero-card__icon"><FileClock aria-hidden="true" size={31} /></div>
        <div>
          <p className="eyebrow">Time & attendance</p>
          <h2 id="live-time-title">{dashboard.employee.displayName}</h2>
          <p>
            @{dashboard.employee.username} · {dashboard.employee.role} · {dashboard.employee.employmentType}
            {' '}employee · Official day {dashboard.operationalDate}
          </p>
        </div>
        <span className={dashboard.pendingCorrectionCount ? 'import-state-pill import-state-pill--attention' : 'import-state-pill'}>
          {dashboard.pendingCorrectionCount ? <CircleAlert aria-hidden="true" size={17} /> : <CheckCircle2 aria-hidden="true" size={17} />}
          {dashboard.pendingCorrectionCount ? `${dashboard.pendingCorrectionCount} correction pending` : 'No pending corrections'}
        </span>
      </section>

      {punchMutation.isError ? <div className="inline-alert" role="alert">{punchMutation.error.message}</div> : null}

      <div className="time-layout">
        <PunchControls
          dashboard={dashboard}
          onPunch={(kind, shiftId) => punchMutation.mutate({ kind, shiftId })}
          pending={punchMutation.isPending}
        />

        <section className="time-panel time-panel--guardrails" aria-labelledby="time-rules-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payroll guardrails</p>
              <h2 id="time-rules-title">What SygShift protects</h2>
            </div>
          </div>
          <ul>
            <li>Server time is the official payroll time.</li>
            <li>Device time is stored only for audit comparison.</li>
            <li>Breaks must be closed before clock-out.</li>
            <li>Corrections never overwrite the original punch.</li>
          </ul>
        </section>
      </div>

      <RecentEvents events={dashboard.recentEvents} />
    </>
  )
}

export function TimePage() {
  return (
    <div className="page page--timekeeping">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Time & attendance</h1>
          <p className="page-summary">
            Clock into scheduled shifts, record breaks, preserve original punch history, and prepare clean
            payroll evidence without making employees fight the system.
          </p>
        </div>
        <div className="access-note"><ShieldAlert aria-hidden="true" size={19} /> Server time is official</div>
      </section>
      {isSupabaseConfigured ? <LiveTimekeeping /> : <VerifiedTimekeepingSetup />}
    </div>
  )
}

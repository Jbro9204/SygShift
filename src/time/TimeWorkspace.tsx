import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  AlertTriangle,
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Coffee,
  Gauge,
  ListChecks,
  ShieldAlert,
  Timer,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { getSessionContext } from '../data/auth'
import {
  activeTimeState,
  getClockableShiftChoices,
  getTimekeepingDashboard,
  nextTimeEventKinds,
  recordTimeEvent,
  type TimeEventKind,
  type TimekeepingShift,
} from '../data/timekeeping'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatDualTimeRange } from '../lib/time'
import { applyTimeEventToCachedDashboards, refreshTimekeepingQueriesAfterPunch } from './timeQuerySync'
import {
  canManageTime,
  canUseOwnTimeClock,
  canViewAccountability,
  canViewAttendanceReview,
  canViewOwnTime,
  canViewTeamTime,
} from './timePermissions'
import { TimeButton, TimeStatusBadge } from './TimeKit'

const actionLabels: Record<TimeEventKind, string> = {
  break_end: 'End break',
  break_start: 'Start break',
  clock_in: 'Clock in',
  clock_out: 'Clock out',
}

function shiftLabel(shift: TimekeepingShift): string {
  return [shift.siteName, shift.postName ?? shift.eventName].filter(Boolean).join(' · ') || 'Assigned shift'
}

function activeShift(dashboard: Awaited<ReturnType<typeof getTimekeepingDashboard>>): TimekeepingShift | null {
  const shiftId = dashboard.lastEvent?.shiftId
  return shiftId ? dashboard.eligibleShifts.find((shift) => shift.shiftId === shiftId) ?? null : null
}

export function TimeWorkspace() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const punchLock = useRef(false)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null)
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })
  const session = sessionQuery.data
  const ownTimeAllowed = canViewOwnTime(session)
  const punchAllowed = canUseOwnTimeClock(session)
  const teamAllowed = canViewTeamTime(session)
  const reviewAllowed = canViewAttendanceReview(session)
  const operationsAllowed = teamAllowed || canManageTime(session)
  const accountabilityAllowed = canViewAccountability(session)
  const dashboardQuery = useQuery({
    enabled: isSupabaseConfigured && sessionQuery.isSuccess && ownTimeAllowed,
    queryFn: () => getTimekeepingDashboard(),
    queryKey: ['my-time-dashboard'],
    refetchInterval: 15_000,
  })
  const dashboard = dashboardQuery.data
  const state = activeTimeState(dashboard?.lastEvent ?? null)
  const choices = useMemo(
    () => dashboard ? getClockableShiftChoices(dashboard.eligibleShifts, dashboard.serverTimestamp) : null,
    [dashboard],
  )
  const currentShift = dashboard ? activeShift(dashboard) : null
  const nextKinds = nextTimeEventKinds(state)
  const defaultShiftId = selectedShiftId ?? choices?.shifts[0]?.shiftId ?? null

  useEffect(() => {
    if (!choices || state !== 'off_clock') return
    if (choices.shifts.some((shift) => shift.shiftId === selectedShiftId)) return
    setSelectedShiftId(choices.shifts[0]?.shiftId ?? null)
  }, [choices, selectedShiftId, state])

  const punchMutation = useMutation({
    mutationFn: (input: { kind: TimeEventKind; shiftId?: string | null }) => recordTimeEvent(input),
    onSuccess: (event) => {
      applyTimeEventToCachedDashboards(queryClient, event)
      setSelectedShiftId(null)
    },
    onSettled: async () => {
      punchLock.current = false
      await refreshTimekeepingQueriesAfterPunch(queryClient)
    },
  })

  const tabs = [
    { icon: Gauge, label: 'Overview', path: '/time', visible: true, end: true },
    { icon: UserRound, label: 'My Time', path: '/time/my-time', visible: ownTimeAllowed },
    { icon: UsersRound, label: 'Team', path: '/time/team', visible: teamAllowed },
    { icon: ListChecks, label: 'Review Queue', path: '/time/review', visible: reviewAllowed },
    { icon: BriefcaseBusiness, label: 'Operations', path: '/time/operations', visible: operationsAllowed },
    { icon: ClipboardCheck, label: 'Accountability', path: '/time/accountability', visible: accountabilityAllowed },
  ].filter((tab) => tab.visible)

  function record(kind: TimeEventKind) {
    if (!punchAllowed || punchLock.current || punchMutation.isPending) return
    punchLock.current = true
    punchMutation.mutate({ kind, shiftId: kind === 'clock_in' ? defaultShiftId : undefined })
  }

  return (
    <section className="time-workspace-shell">
      <header className="time-workspace-header">
        <div>
          <p className="eyebrow">SygShift Time</p>
          <h1>Time &amp; Attendance</h1>
          <p>Clock, review, correct, and reconcile time from one organized workspace.</p>
        </div>
        {ownTimeAllowed ? (
          <section aria-label="Current time clock" className={`time-workspace-clock time-workspace-clock--${state}`}>
            <div className="time-workspace-clock__status">
              {state === 'working' ? <Timer aria-hidden="true" size={22} /> : state === 'on_break' ? <Coffee aria-hidden="true" size={22} /> : <Clock3 aria-hidden="true" size={22} />}
              <div>
                <span>Clock status</span>
                <strong>{state === 'working' ? 'Clocked in' : state === 'on_break' ? 'On break' : 'Off clock'}</strong>
              </div>
              <TimeStatusBadge tone={state === 'working' ? 'good' : state === 'on_break' ? 'warning' : 'neutral'}>
                {state === 'working' ? 'Working' : state === 'on_break' ? 'Break' : 'Ready'}
              </TimeStatusBadge>
            </div>
            {state === 'off_clock' && choices && choices.shifts.length > 0 ? (
              <label className="time-workspace-clock__shift">
                <span>Clock into</span>
                <select
                  aria-label="Shift for clock in"
                  disabled={punchMutation.isPending}
                  onChange={(event) => setSelectedShiftId(event.target.value || null)}
                  value={defaultShiftId ?? ''}
                >
                  {choices.shifts.map((shift) => (
                    <option key={shift.assignmentId} value={shift.shiftId}>
                      {shiftLabel(shift)} · {formatDualTimeRange(shift.startsAt, shift.endsAt, shift.timeZone)}
                    </option>
                  ))}
                </select>
              </label>
            ) : currentShift ? (
              <span className="time-workspace-clock__current">{shiftLabel(currentShift)}</span>
            ) : null}
            <div className="time-workspace-clock__actions">
              {nextKinds.map((kind) => (
                <TimeButton
                  disabled={!punchAllowed}
                  key={kind}
                  loading={punchMutation.isPending}
                  onClick={() => record(kind)}
                  variant={kind === 'clock_out' ? 'danger' : 'primary'}
                >
                  {actionLabels[kind]}
                </TimeButton>
              ))}
            </div>
          </section>
        ) : null}
      </header>

      {punchMutation.isError ? (
        <div className="time-workspace-clock-error" role="alert">
          <ShieldAlert aria-hidden="true" size={20} />
          <span>{punchMutation.error.message}</span>
        </div>
      ) : punchMutation.isSuccess ? (
        <div className="sr-only" aria-live="polite"><CheckCircle2 aria-hidden="true" /> Time clock updated.</div>
      ) : dashboardQuery.isError ? (
        <div className="time-workspace-clock-error" role="alert">
          <AlertTriangle aria-hidden="true" size={20} />
          <span>Your clock status could not be loaded. Other authorized time tools remain available.</span>
        </div>
      ) : null}

      <nav aria-label="Time and Attendance sections" className="time-workspace-tabs">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <NavLink
              className={({ isActive }) => isActive ? 'time-workspace-tab time-workspace-tab--active' : 'time-workspace-tab'}
              end={tab.end}
              key={tab.path}
              state={{ from: location.pathname }}
              to={tab.path}
            >
              <Icon aria-hidden="true" size={18} />
              <span>{tab.label}</span>
            </NavLink>
          )
        })}
      </nav>

      <div className="time-workspace-content">
        <Outlet />
      </div>
    </section>
  )
}

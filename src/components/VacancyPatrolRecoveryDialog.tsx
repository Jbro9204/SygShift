import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, BadgeCheck, Plus, Route, Trash2 } from 'lucide-react'
import {
  createVacancyPatrolRecovery,
  getVacancyPatrolRecoveryBootstrap,
  type VacancyPatrolHitWindow,
  type VacancyPatrolRecoveryBootstrap,
  type VacancyPatrolRecoveryReceipt,
} from '../data/vacancyPatrolRecovery'
import { formatDualTime } from '../lib/time'
import { continentalUsTimeZoneLabel } from '../lib/usTimeZones'
import { scheduleWallClockToInstant } from '../schedule/timeBasis'
import { ModalDialog } from './ModalDialog'

interface EditableHitWindow {
  key: string
  plannedHits: string
  windowEnd: string
  windowStart: string
}

interface VacancyPatrolRecoveryDialogProps {
  onClose: () => void
  onCreated?: (receipt: VacancyPatrolRecoveryReceipt) => void
  shiftId: string
}

function zonedDateTimeInput(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', timeZone, year: 'numeric',
  }).formatToParts(new Date(value))
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`
}

function localInputToInstant(value: string, timeZone: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
  if (!match) throw new Error('Enter a complete date and time for every visit window.')
  return scheduleWallClockToInstant(match[1], match[2], timeZone)
}

function editableWindow(window: VacancyPatrolHitWindow, timeZone: string): EditableHitWindow {
  return {
    key: crypto.randomUUID(),
    plannedHits: String(window.plannedHits),
    windowEnd: zonedDateTimeInput(window.windowEndAt, timeZone),
    windowStart: zonedDateTimeInput(window.windowStartAt, timeZone),
  }
}

function plannedHitCount(windows: EditableHitWindow[]): number {
  return windows.reduce((total, window) => total + (Number.parseInt(window.plannedHits, 10) || 0), 0)
}

function formatShiftDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit', month: '2-digit', timeZone, weekday: 'long', year: 'numeric',
  }).format(new Date(value))
}

function formatRequestStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function RecoverySuccess({ onClose, receipt }: { onClose: () => void, receipt: VacancyPatrolRecoveryReceipt }) {
  return (
    <section className="scheduler-workflow-modal" aria-live="polite">
      <div className="schedule-workflow-note schedule-workflow-note--send" role="status">
        <BadgeCheck aria-hidden="true" size={21} />
        <p>
          <strong>{receipt.requestNumber} was sent to Patrol for review.</strong><br />
          The published shift remains an open vacancy. Patrol must separately accept the route and visit plan before work is assigned.
        </p>
      </div>
      <div className="modal-actions">
        <button autoFocus className="primary-action" data-dialog-autofocus onClick={onClose} type="button">Done</button>
      </div>
    </section>
  )
}

function ExistingRecovery({ bootstrap, onClose }: { bootstrap: VacancyPatrolRecoveryBootstrap, onClose: () => void }) {
  const request = bootstrap.existingRequest!
  const route = bootstrap.routeChoices.find((choice) => choice.routeId === request.requestedRouteId)
  const totalHits = request.hitWindows.reduce((total, window) => total + window.plannedHits, 0)
  return (
    <section className="scheduler-workflow-modal">
      <div className="schedule-workflow-note" role="status">
        <Route aria-hidden="true" size={21} />
        <p><strong>{request.requestNumber} already covers this vacancy.</strong><br />Its workflow status is {formatRequestStatus(request.status)}.</p>
      </div>
      <div className="scheduler-workflow-summary">
        <article><span>Requested route</span><strong>{route?.name ?? 'Route retained in Patrol'}</strong><small>{route?.code ?? request.requestedRouteId}</small></article>
        <article><span>Requested visits</span><strong>{totalHits}</strong><small>Across {request.hitWindows.length} visit window{request.hitWindows.length === 1 ? '' : 's'}</small></article>
      </div>
      <div className="scheduler-workflow-options">
        <strong>Operational / billing note</strong>
        <p className="form-note">{request.reason}</p>
      </div>
      <div className="modal-actions">
        <button autoFocus className="primary-action" data-dialog-autofocus onClick={onClose} type="button">Close</button>
      </div>
    </section>
  )
}

function RecoveryForm({
  bootstrap,
  error,
  isSaving,
  onCancel,
  onSubmit,
  resetError,
}: {
  bootstrap: VacancyPatrolRecoveryBootstrap
  error: Error | null
  isSaving: boolean
  onCancel: () => void
  onSubmit: (input: { hitWindows: VacancyPatrolHitWindow[], reason: string, requestedRouteId: string }) => void
  resetError: () => void
}) {
  const { defaults, routeChoices, shift } = bootstrap
  const [requestedRouteId, setRequestedRouteId] = useState(routeChoices[0]?.routeId ?? '')
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [windows, setWindows] = useState<EditableHitWindow[]>(() => defaults.hitWindows.map((window) => editableWindow(window, shift.timeZone)))
  const [validationError, setValidationError] = useState<string | null>(null)
  const totalHits = plannedHitCount(windows)

  function updateWindow(key: string, update: Partial<EditableHitWindow>) {
    resetError()
    setValidationError(null)
    setWindows((current) => current.map((window) => window.key === key ? { ...window, ...update } : window))
  }

  function addWindow() {
    resetError()
    setValidationError(null)
    const last = windows[windows.length - 1]
    setWindows((current) => [...current, {
      key: crypto.randomUUID(),
      plannedHits: '1',
      windowEnd: last?.windowEnd ?? zonedDateTimeInput(shift.endsAt, shift.timeZone),
      windowStart: last?.windowEnd ?? zonedDateTimeInput(shift.startsAt, shift.timeZone),
    }])
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setValidationError(null)
    try {
      if (!requestedRouteId) throw new Error('Choose the Patrol route you want Patrol management to review.')
      if (reason.trim().length < defaults.reasonMinLength) {
        throw new Error(`Enter at least ${defaults.reasonMinLength} characters explaining the operational need and billing treatment.`)
      }
      if (!acknowledged) throw new Error('Acknowledge the Patrol review and attendance boundary before sending this request.')
      if (!windows.length) throw new Error('Add at least one visit window.')
      const shiftStartsAt = new Date(shift.startsAt).getTime()
      const shiftEndsAt = new Date(shift.endsAt).getTime()
      const hitWindows = windows.map((window, index) => {
        const plannedHits = Number.parseInt(window.plannedHits, 10)
        if (!Number.isInteger(plannedHits) || plannedHits < 1) throw new Error(`Visit window ${index + 1} needs at least one planned hit.`)
        if (plannedHits > 25) throw new Error(`Visit window ${index + 1} cannot contain more than 25 planned hits.`)
        const windowStartAt = localInputToInstant(window.windowStart, shift.timeZone)
        const windowEndAt = localInputToInstant(window.windowEnd, shift.timeZone)
        const startsAt = new Date(windowStartAt).getTime()
        const endsAt = new Date(windowEndAt).getTime()
        if (endsAt <= startsAt) throw new Error(`Visit window ${index + 1} must end after it starts.`)
        if (startsAt < shiftStartsAt || endsAt > shiftEndsAt) {
          throw new Error(`Visit window ${index + 1} must stay inside the published shift window.`)
        }
        return { plannedHits, windowEndAt, windowStartAt }
      }).sort((left, right) => left.windowStartAt.localeCompare(right.windowStartAt))
      for (let index = 1; index < hitWindows.length; index += 1) {
        if (new Date(hitWindows[index].windowStartAt).getTime() < new Date(hitWindows[index - 1].windowEndAt).getTime()) {
          throw new Error('Visit windows cannot overlap. Adjust the plan so each window has a distinct time range.')
        }
      }
      if (hitWindows.reduce((total, window) => total + window.plannedHits, 0) > 50) {
        throw new Error('A vacancy-recovery request cannot contain more than 50 planned hits.')
      }
      onSubmit({ hitWindows, reason: reason.trim(), requestedRouteId })
    } catch (submissionError) {
      setValidationError(submissionError instanceof Error ? submissionError.message : 'Review the visit plan and try again.')
    }
  }

  return (
    <form className="scheduler-workflow-modal" onSubmit={submit}>
      <div className="scheduler-workflow-summary" aria-label="Published vacancy context">
        <article><span>Date</span><strong>{formatShiftDate(shift.startsAt, shift.timeZone)}</strong><small>{continentalUsTimeZoneLabel(shift.timeZone)}</small></article>
        <article><span>Shift window</span><strong>{formatDualTime(shift.startsAt, { timeZone: shift.timeZone })}–{formatDualTime(shift.endsAt, { timeZone: shift.timeZone })}</strong><small>Published schedule · open / unassigned</small></article>
        <article><span>Location</span><strong>{shift.siteName ?? 'Site not named'}</strong><small>{shift.postName ?? shift.scheduleName ?? 'Post not named'}</small></article>
        <article><span>Requested visits</span><strong>{totalHits}</strong><small>Across {windows.length} visit window{windows.length === 1 ? '' : 's'}</small></article>
      </div>

      <div className="schedule-workflow-note">
        <AlertCircle aria-hidden="true" size={20} />
        <p>This requests a Patrol recovery plan for a regular published vacancy. It does not create a call-off, attendance event, time entry, patrol assignment, or final billing decision.</p>
      </div>

      <label className="field-stack">
        Requested Patrol route
        <select
          aria-label="Requested Patrol route"
          autoFocus
          data-dialog-autofocus
          disabled={isSaving || routeChoices.length === 0}
          onChange={(event) => { resetError(); setRequestedRouteId(event.target.value) }}
          required
          value={requestedRouteId}
        >
          <option value="">Choose an active route</option>
          {routeChoices.map((routeChoice) => (
            <option key={routeChoice.routeId} value={routeChoice.routeId}>
              {routeChoice.name} · {routeChoice.code} · {routeChoice.requiresArmed ? 'Armed' : 'Unarmed'}
            </option>
          ))}
        </select>
        <small>Patrol management will review this route preference and remains responsible for accepting the operational plan.</small>
      </label>

      <section className="scheduler-workflow-options" aria-labelledby="vacancy-patrol-window-title">
        <div className="panel-heading">
          <div><strong id="vacancy-patrol-window-title">Visit-window plan</strong><p className="form-note">Set the time range and requested number of documented hits for each window.</p></div>
          <button className="secondary-button secondary-button--small" disabled={isSaving || windows.length >= defaults.maxHitWindows} onClick={addWindow} type="button">
            <Plus aria-hidden="true" size={17} />Add window
          </button>
        </div>
        {windows.map((window, index) => (
          <div className="scheduler-workflow-options" key={window.key}>
            <div className="panel-heading">
              <strong>Window {index + 1}</strong>
              {windows.length > 1 ? (
                <button
                  aria-label={`Remove visit window ${index + 1}`}
                  className="secondary-button secondary-button--small danger-button"
                  disabled={isSaving}
                  onClick={() => { resetError(); setValidationError(null); setWindows((current) => current.filter((item) => item.key !== window.key)) }}
                  type="button"
                ><Trash2 aria-hidden="true" size={16} />Remove</button>
              ) : null}
            </div>
            <div className="form-grid form-grid--three">
              <label>Window starts<input disabled={isSaving} onChange={(event) => updateWindow(window.key, { windowStart: event.target.value })} required type="datetime-local" value={window.windowStart} /></label>
              <label>Window ends<input disabled={isSaving} onChange={(event) => updateWindow(window.key, { windowEnd: event.target.value })} required type="datetime-local" value={window.windowEnd} /></label>
              <label>Planned hits<input disabled={isSaving} inputMode="numeric" max={25} min={1} onChange={(event) => updateWindow(window.key, { plannedHits: event.target.value })} required type="number" value={window.plannedHits} /></label>
            </div>
          </div>
        ))}
      </section>

      <label className="field-stack">
        Operational / billing note
        <textarea
          aria-label="Operational / billing note"
          disabled={isSaving}
          maxLength={1000}
          minLength={defaults.reasonMinLength}
          onChange={(event) => { resetError(); setValidationError(null); setReason(event.target.value) }}
          placeholder="Explain why Patrol visits are the requested recovery, what the visits should cover, and how operations should treat the client/billing handoff."
          required
          rows={4}
          value={reason}
        />
        <small>Required · minimum {defaults.reasonMinLength} characters. Do not enter private employee attendance or medical information.</small>
      </label>

      <label className="schedule-workflow-confirmation">
        <input checked={acknowledged} disabled={isSaving} onChange={(event) => { resetError(); setValidationError(null); setAcknowledged(event.target.checked) }} required type="checkbox" />
        <span>I understand this sends a vacancy-recovery request for Patrol review. It does not assign a Patrol officer, report a call-off, change attendance, or approve billing.</span>
      </label>

      {routeChoices.length === 0 ? <p className="form-feedback form-feedback--error" role="alert">No active Patrol route currently includes this vacant post or site with a requirement for the service day. Patrol management must add the location to an eligible route before this request can be sent.</p> : null}
      {validationError ? <p className="form-feedback form-feedback--error" role="alert">{validationError}</p> : null}
      {error ? <p className="form-feedback form-feedback--error" role="alert">{error.message}</p> : null}

      <div className="modal-actions">
        <button className="secondary-button" disabled={isSaving} onClick={onCancel} type="button">Cancel</button>
        <button className="primary-action" disabled={isSaving || routeChoices.length === 0 || !requestedRouteId || reason.trim().length < defaults.reasonMinLength || !acknowledged || totalHits < 1} type="submit">
          {isSaving ? 'Sending to Patrol...' : 'Send to Patrol'}
        </button>
      </div>
    </form>
  )
}

export function VacancyPatrolRecoveryDialog({ onClose, onCreated, shiftId }: VacancyPatrolRecoveryDialogProps) {
  const queryClient = useQueryClient()
  const idempotencyKey = useRef(crypto.randomUUID())
  const bootstrapQuery = useQuery({
    queryFn: () => getVacancyPatrolRecoveryBootstrap(shiftId),
    queryKey: ['vacancy-patrol-recovery-bootstrap', shiftId],
    retry: false,
  })
  const createMutation = useMutation({
    mutationFn: (input: { hitWindows: VacancyPatrolHitWindow[], reason: string, requestedRouteId: string }) => createVacancyPatrolRecovery({
      ...input,
      idempotencyKey: idempotencyKey.current,
      shiftId,
    }),
    onSuccess: async (receipt) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-bootstrap', shiftId] }),
        queryClient.invalidateQueries({ queryKey: ['vacancy-patrol-recovery-map'] }),
        queryClient.invalidateQueries({ queryKey: ['weekly-schedule'] }),
        queryClient.invalidateQueries({ queryKey: ['open-opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['patrol-workspace'] }),
      ])
      onCreated?.(receipt)
    },
  })

  const bootstrap = bootstrapQuery.data
  const description = bootstrap
    ? `${bootstrap.shift.siteName ?? 'Published vacancy'} · ${formatShiftDate(bootstrap.shift.startsAt, bootstrap.shift.timeZone)}`
    : 'Review the published vacancy and request an auditable Patrol visit plan.'

  return (
    <ModalDialog
      busy={createMutation.isPending}
      busyLabel="Sending vacancy recovery to Patrol..."
      className="modal-dialog--scheduler-workflow"
      description={description}
      eyebrow="Published open shift"
      headingIcon={<Route size={23} />}
      onClose={onClose}
      title="Resolve vacancy with Patrol"
    >
      {bootstrapQuery.isPending ? <section className="scheduler-workflow-modal" data-dialog-autofocus role="status" tabIndex={-1}><p className="form-note">Loading eligible routes and the recommended visit window…</p></section> : null}
      {bootstrapQuery.isError ? (
        <section className="scheduler-workflow-modal">
          <p className="form-feedback form-feedback--error" role="alert">{bootstrapQuery.error.message}</p>
          <div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close</button><button autoFocus className="primary-action" data-dialog-autofocus disabled={bootstrapQuery.isFetching} onClick={() => void bootstrapQuery.refetch()} type="button">{bootstrapQuery.isFetching ? 'Retrying...' : 'Try again'}</button></div>
        </section>
      ) : null}
      {bootstrap && createMutation.data ? <RecoverySuccess onClose={onClose} receipt={createMutation.data} /> : null}
      {bootstrap && !createMutation.data && bootstrap.existingRequest ? <ExistingRecovery bootstrap={bootstrap} onClose={onClose} /> : null}
      {bootstrap && !createMutation.data && !bootstrap.existingRequest && (!bootstrap.permissions.canInitiate || !bootstrap.shift.isPublished || !bootstrap.shift.isUnassigned) ? (
        <section className="scheduler-workflow-modal">
          <p className="form-feedback form-feedback--error" role="alert">
            {!bootstrap.permissions.canInitiate
              ? 'Your current access does not allow vacancy recovery requests. Ask an authorized Patrol manager or administrator for help.'
              : 'This shift is no longer an eligible published, unassigned vacancy. Refresh Schedule and review its current coverage.'}
          </p>
          <div className="modal-actions"><button autoFocus className="primary-action" data-dialog-autofocus onClick={onClose} type="button">Close</button></div>
        </section>
      ) : null}
      {bootstrap && !createMutation.data && !bootstrap.existingRequest && bootstrap.permissions.canInitiate && bootstrap.shift.isPublished && bootstrap.shift.isUnassigned ? (
        <RecoveryForm
          bootstrap={bootstrap}
          error={createMutation.error instanceof Error ? createMutation.error : null}
          isSaving={createMutation.isPending}
          onCancel={onClose}
          onSubmit={(input) => createMutation.mutate(input)}
          resetError={() => createMutation.reset()}
        />
      ) : null}
    </ModalDialog>
  )
}
